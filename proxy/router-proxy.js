/**
 * router-proxy.js
 * ===============
 * Local OpenAI-compatible router for GitHub Copilot BYOK.
 *
 * Copilot (VS Code Custom Endpoint or Copilot CLI) sends OpenAI Chat
 * Completions requests here. We route each request to a backend based
 * on the requested `model`:
 *
 *   nvidia / deepseek  → OpenAI-compatible upstream (transparent passthrough)
 *   kimi               → Anthropic-native upstream (translated both ways)
 *
 * Switching the model in Copilot's picker (VS Code) or via COPILOT_MODEL
 * (CLI) switches the backend live — no restart. The CLI can also switch
 * the `auto` alias's target at runtime via POST /_proxy/mode.
 *
 * Binds to 127.0.0.1 only. The proxy holds your provider API keys and
 * has no authentication, so it must never be exposed beyond localhost.
 */

import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import {
    openAIToAnthropic,
    anthropicMessageToOpenAI,
    AnthropicToOpenAIStream,
} from './openai-anthropic.js';

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const ANTHROPIC_NATIVE = new Set(['kimi']);

/**
 * startProxy(opts)
 *   opts.port      listen port
 *   opts.backends  { name: { url, key, model, native } }
 *   opts.defaultBackend  name used for the "auto"/"copilot" model alias
 */
export async function startProxy(opts) {
    const port = opts.port || 11434;
    const bindAddr = '127.0.0.1';
    const debug = opts.debug || process.env.DEEPCOPILOT_DEBUG === '1';
    const backends = opts.backends || {};
    let defaultBackend = opts.defaultBackend || Object.keys(backends)[0];

    // model id (lowercased) → backend name. Includes each backend's
    // configured model plus the backend name itself as an alias.
    const modelToBackend = new Map();
    for (const [name, def] of Object.entries(backends)) {
        modelToBackend.set(name.toLowerCase(), name);
        if (def.model) modelToBackend.set(def.model.toLowerCase(), name);
    }

    const stats = { requests: 0, byBackend: {}, errors: 0, lastModel: null };
    const log = (...a) => { if (debug) console.error('[deepcopilot]', ...a); };

    const resolveBackend = (model) => {
        if (model) {
            const hit = modelToBackend.get(String(model).toLowerCase());
            if (hit) return hit;
        }
        return defaultBackend; // covers 'auto', 'copilot', unknown, or absent
    };

    const server = createServer(async (req, res) => {
        const path = (req.url || '').split('?')[0];

        if (req.method === 'GET' && path === '/health') {
            return json(res, 200, { status: 'ok' });
        }
        // ── Ollama emulation: lets Copilot's stable "Ollama" BYOK provider
        // discover our backends. (The native Custom Endpoint provider is
        // gated to non-stable VS Code builds, so we impersonate Ollama.)
        if (req.method === 'GET' && path === '/api/version') {
            return json(res, 200, { version: '0.6.4' });
        }
        if (req.method === 'GET' && path === '/api/tags') {
            return json(res, 200, { models: ollamaTags(backends) });
        }
        if (req.method === 'POST' && path === '/api/show') {
            const body = await readBody(req);
            let model = null;
            try { model = JSON.parse(body.toString('utf8')).model; } catch {}
            return json(res, 200, ollamaShow(model, backends));
        }
        if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
            return json(res, 200, listModels(backends));
        }
        if (req.method === 'GET' && path === '/_proxy/status') {
            return json(res, 200, {
                defaultBackend,
                backends: Object.fromEntries(
                    Object.entries(backends).map(([n, d]) => [n, { url: d.url, model: d.model, native: !!d.native }])),
                stats,
            });
        }
        if (req.method === 'POST' && path === '/_proxy/mode') {
            const body = await readBody(req);
            const want = parseMode(body);
            if (want && backends[want]) {
                defaultBackend = want;
                return json(res, 200, { ok: true, defaultBackend });
            }
            return json(res, 400, { error: `unknown backend; have: ${Object.keys(backends).join(', ')}` });
        }
        if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
            return handleChat(req, res);
        }
        json(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
    });

    async function handleChat(req, res) {
        stats.requests++;
        let body;
        try {
            body = JSON.parse((await readBody(req)).toString('utf8'));
        } catch {
            return json(res, 400, { error: { message: 'invalid JSON body' } });
        }
        const backendName = resolveBackend(body.model);
        const backend = backends[backendName];
        stats.byBackend[backendName] = (stats.byBackend[backendName] || 0) + 1;
        stats.lastModel = body.model || null;
        if (!backend) {
            stats.errors++;
            return json(res, 503, { error: { message: `backend "${backendName}" not configured` } });
        }
        log(`model=${body.model || '(none)'} → ${backendName} (${backend.model})`);
        const wantsStream = body.stream !== false;

        try {
            if (backend.native) {
                await forwardKimi(res, body, backend, wantsStream, stats, log);
            } else {
                await forwardOpenAI(res, body, backend, stats, log);
            }
        } catch (e) {
            stats.errors++;
            log('error:', e.message);
            if (!res.headersSent) json(res, 502, { error: { message: String(e.message || e) } });
            else res.end();
        }
    }

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, bindAddr, () => {
            resolve({ port: server.address().port, stop: () => new Promise(r => server.close(() => r())) });
        });
    });
}


// ── OpenAI-compatible passthrough (nvidia, deepseek) ─────────────
function forwardOpenAI(res, body, backend, stats, log) {
    // Rewrite the model to the backend's configured model id so Copilot's
    // alias (e.g. "auto") or display name maps to a real upstream model.
    const outBody = { ...body, model: backend.model || body.model };
    const payload = Buffer.from(JSON.stringify(outBody));
    const url = new URL(joinUrl(backend.url, '/chat/completions'));

    return pipeUpstream(res, url, payload, {
        'content-type': 'application/json',
        'authorization': `Bearer ${backend.key}`,
        'accept': body.stream !== false ? 'text/event-stream' : 'application/json',
    }, { passthrough: true, stats, log });
}


// ── Kimi-for-coding (Anthropic-native, translated) ───────────────
function forwardKimi(res, body, backend, wantsStream, stats, log) {
    const anthBody = openAIToAnthropic(body, backend.model);
    anthBody.stream = wantsStream;
    const payload = Buffer.from(JSON.stringify(anthBody));
    const url = new URL(joinUrl(backend.url, '/v1/messages'));

    return pipeUpstream(res, url, payload, {
        'content-type': 'application/json',
        'accept': wantsStream ? 'text/event-stream' : 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': backend.key,
        'authorization': `Bearer ${backend.key}`,
    }, { translate: true, wantsStream, model: body.model, stats, log });
}


// ── Shared upstream plumbing ─────────────────────────────────────
function pipeUpstream(res, url, payload, headers, mode) {
    return new Promise((resolve, reject) => {
        const reqLib = url.protocol === 'https:' ? httpsRequest : httpRequest;
        headers['content-length'] = String(payload.length);

        const upstream = reqLib({
            host: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            method: 'POST',
            path: url.pathname,
            headers,
            timeout: REQUEST_TIMEOUT_MS,
        }, (up) => {
            mode.log && mode.log(`upstream ${up.statusCode} ${up.statusMessage}`);

            if (up.statusCode !== 200) {
                // Surface upstream error to Copilot as-is.
                const chunks = [];
                up.on('data', c => chunks.push(c));
                up.on('end', () => {
                    if (!res.headersSent) {
                        res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'] || 'application/json' });
                    }
                    res.end(Buffer.concat(chunks));
                    resolve();
                });
                return;
            }

            // OpenAI passthrough: stream bytes straight through.
            if (mode.passthrough) {
                res.writeHead(200, {
                    'content-type': up.headers['content-type'] || 'application/json',
                    'cache-control': 'no-cache',
                });
                up.pipe(res);
                up.on('end', resolve);
                up.on('error', reject);
                return;
            }

            // Kimi translate path.
            if (mode.wantsStream) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                const tx = new AnthropicToOpenAIStream(mode.model);
                up.pipe(tx).pipe(res);
                tx.on('end', resolve);
                tx.on('error', reject);
                up.on('error', reject);
            } else {
                const chunks = [];
                up.on('data', c => chunks.push(c));
                up.on('end', () => {
                    let outJson;
                    try {
                        outJson = anthropicMessageToOpenAI(JSON.parse(Buffer.concat(chunks).toString('utf8')), mode.model);
                    } catch (e) {
                        outJson = { error: { message: 'translation failed: ' + e.message } };
                    }
                    json(res, 200, outJson);
                    resolve();
                });
                up.on('error', reject);
            }
        });

        upstream.on('error', (e) => {
            if (!res.headersSent) json(res, 502, { error: { message: e.message } });
            else res.end();
            resolve();
        });
        upstream.write(payload);
        upstream.end();
    });
}


// ── /v1/models synthesis ─────────────────────────────────────────
function listModels(backends) {
    const data = [];
    for (const [name, def] of Object.entries(backends)) {
        if (def.model) data.push({ id: def.model, object: 'model', owned_by: name });
        data.push({ id: name, object: 'model', owned_by: name }); // backend-name alias
    }
    data.push({ id: 'auto', object: 'model', owned_by: 'deepcopilot' });
    return { object: 'list', data };
}


// ── Ollama emulation helpers ─────────────────────────────────────
// Copilot's Ollama provider reads `.models[].model` from /api/tags, then
// POSTs /api/show per model and reads `.capabilities[]` (tools/vision)
// and `.model_info["<arch>.context_length"]`. The model id it then sends
// to /v1/chat/completions is exactly the tag's `model` value — so we use
// the backend's configured model id, which the router already routes.
function ollamaTags(backends) {
    return Object.values(backends).map(def => ({
        name: def.model,
        model: def.model,
        modified_at: new Date().toISOString(),
        size: 0,
        digest: '',
        details: { family: 'llama', parameter_size: '', quantization_level: '' },
    }));
}

function ollamaShow(model, backends) {
    const ctx = 131072;
    return {
        // tool_calls is required for Copilot agent mode; advertise it.
        capabilities: ['completion', 'tools'],
        details: { family: 'llama', families: ['llama'] },
        model_info: {
            'general.architecture': 'llama',
            'general.basename': model || 'deepcopilot',
            'llama.context_length': ctx,
        },
    };
}


// ── Helpers ──────────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function parseMode(buf) {
    const s = buf.toString('utf8').trim();
    try { const j = JSON.parse(s); return (j.backend || j.mode || '').toLowerCase(); } catch {}
    const m = /(?:backend|mode)=([\w-]+)/.exec(s); // form-encoded
    return m ? m[1].toLowerCase() : s.toLowerCase();
}

function joinUrl(base, suffix) {
    return base.replace(/\/+$/, '') + (suffix.startsWith('/') ? suffix : '/' + suffix);
}

function json(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': String(b.length) });
    res.end(b);
}
