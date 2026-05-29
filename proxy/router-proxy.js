/**
 * router-proxy.js
 * ===============
 * Local OpenAI-compatible router for GitHub Copilot BYOK.
 *
 * Copilot (VS Code "Ollama" provider or Copilot CLI) sends OpenAI Chat
 * Completions requests here. We route each request to a backend based
 * on the requested `model`:
 *
 *   nvidia / deepseek  → OpenAI-compatible upstream (transparent passthrough)
 *   kimi               → Anthropic-native upstream (translated both ways)
 *
 * A backend may expose multiple models; the exact selected model id is
 * forwarded upstream. Switching the model in Copilot's picker switches
 * the backend live — no restart.
 *
 * Binds to 127.0.0.1 only. The proxy holds your provider API keys and
 * has no authentication, so it must never be exposed beyond localhost.
 */

import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    openAIToAnthropic,
    anthropicMessageToOpenAI,
    AnthropicToOpenAIStream,
} from './openai-anthropic.js';

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CTX = 131072;

/**
 * startProxy(opts)
 *   opts.port          listen port
 *   opts.backends      { name: { url, key, model, models:[...], native } }
 *   opts.contexts      { modelId(lowercased): contextTokens }  (for /api/show)
 *   opts.defaultBackend  name used for the "auto"/"copilot" model alias
 */
export async function startProxy(opts) {
    const port = opts.port || 11434;
    const debug = opts.debug || process.env.DEEPCOPILOT_DEBUG === '1';
    const logFile = opts.logFile || join(dirname(fileURLToPath(import.meta.url)), '.cache', 'requests.log');
    try { mkdirSync(dirname(logFile), { recursive: true }); } catch {}
    const backends = opts.backends || {};
    const contexts = opts.contexts || {};
    let defaultBackend = opts.defaultBackend || Object.keys(backends)[0];

    // Copilot's Ollama provider builds a qualified id "ollama/Ollama/<model>"
    // and parses it back by '/'. Model ids that contain '/' (e.g.
    // "stepfun-ai/step-3.7-flash") break that parse → "provider not
    // registered" and only slash-free models appear. So we expose a
    // slash-free ALIAS to Copilot and map it back to the real upstream id.
    const aliasOf = (id) => String(id).replace(/\//g, '__'); // '/' is the only unsafe char

    // alias(lowercased) → { backend, modelId(real), alias }.  Also accept the
    // real id and the backend NAME (→ primary model) as lookups.
    const modelOwner = new Map();
    const register = (backend, realId) => {
        const a = aliasOf(realId);
        const entry = { backend, modelId: realId, alias: a };
        modelOwner.set(a.toLowerCase(), entry);
        modelOwner.set(String(realId).toLowerCase(), entry); // tolerate real id too
        return entry;
    };
    for (const [name, def] of Object.entries(backends)) {
        const prim = register(name, def.model);          // backend-name alias → primary
        modelOwner.set(name.toLowerCase(), prim);
        for (const m of (def.models || [])) register(name, m);
    }

    const stats = { requests: 0, byBackend: {}, errors: 0, lastModel: null };
    const log = (...a) => { if (debug) console.error('[deepcopilot]', ...a); };

    // Resolve a requested model (alias OR real id OR backend name) → backend +
    // real upstream id. Unknown / 'auto' / 'copilot' / absent → default primary.
    const resolve = (model) => {
        if (model) {
            const hit = modelOwner.get(String(model).toLowerCase());
            if (hit) return hit;
        }
        return { backend: defaultBackend, modelId: backends[defaultBackend]?.model };
    };

    // Context lookup accepts alias or real id.
    const ctxFor = (model) => {
        const hit = modelOwner.get(String(model || '').toLowerCase());
        const real = hit ? hit.modelId : model;
        return contexts[String(real || '').toLowerCase()] || DEFAULT_CTX;
    };

    const handler = async (req, res) => {
        const path = (req.url || '').split('?')[0];
        // Log every incoming request (method, path, client) to stderr and a
        // rolling file, so VS Code's discovery calls are visible for diagnosis.
        const recv = `${new Date().toISOString()} ${req.method} ${path} from ${req.socket.remoteAddress}`;
        if (debug) console.error('[deepcopilot] <<', recv);
        try { appendFileSync(logFile, recv + '\n'); } catch {}

        if (req.method === 'GET' && path === '/health') {
            return json(res, 200, { status: 'ok' });
        }
        // ── Ollama emulation: lets Copilot's stable "Ollama" BYOK provider
        // discover our backends (the native Custom Endpoint provider is
        // gated to non-stable VS Code builds, so we impersonate Ollama).
        if (req.method === 'GET' && path === '/api/version') {
            return json(res, 200, { version: '0.6.4' });
        }
        if (req.method === 'GET' && path === '/api/tags') {
            return json(res, 200, { models: ollamaTags(backends, aliasOf) });
        }
        if (req.method === 'POST' && path === '/api/show') {
            const body = await readBody(req);
            let model = null;
            try { model = JSON.parse(body.toString('utf8')).model; } catch {}
            return json(res, 200, ollamaShow(model, ctxFor(model)));
        }
        if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
            return json(res, 200, listModels(backends, aliasOf));
        }
        if (req.method === 'GET' && path === '/_proxy/status') {
            return json(res, 200, {
                deepcopilot: true,
                pid: process.pid,
                defaultBackend,
                backends: Object.fromEntries(
                    Object.entries(backends).map(([n, d]) => [n, { url: d.url, model: d.model, models: d.models || [d.model], native: !!d.native }])),
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
    };

    const server = createServer(handler);

    async function handleChat(req, res) {
        stats.requests++;
        let body;
        try {
            body = JSON.parse((await readBody(req)).toString('utf8'));
        } catch {
            return json(res, 400, { error: { message: 'invalid JSON body' } });
        }
        const { backend: backendName, modelId } = resolve(body.model);
        const backend = backends[backendName];
        stats.byBackend[backendName] = (stats.byBackend[backendName] || 0) + 1;
        stats.lastModel = body.model || null;
        if (!backend) {
            stats.errors++;
            return json(res, 503, { error: { message: `backend "${backendName}" not configured` } });
        }
        const upstreamModel = modelId || backend.model;
        log(`model=${body.model || '(none)'} → ${backendName} (${upstreamModel})`);
        const wantsStream = body.stream !== false;

        try {
            if (backend.native) {
                await forwardKimi(res, body, backend, upstreamModel, wantsStream, stats, log);
            } else {
                await forwardOpenAI(res, body, backend, upstreamModel, stats, log);
            }
        } catch (e) {
            stats.errors++;
            log('error:', e.message);
            if (!res.headersSent) json(res, 502, { error: { message: String(e.message || e) } });
            else res.end();
        }
    }

    const v6 = createServer(handler);
    // Ignore client socket aborts (Copilot/undici may close early) so a reset
    // never surfaces as a server error.
    server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });
    v6.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        // VS Code / Electron use Node's fetch, which resolves "localhost" and
        // often connects to IPv6 [::1] first. Bind BOTH loopback addresses so
        // http://localhost:PORT works regardless of IPv4/IPv6 resolution,
        // while staying localhost-only. We wait for the IPv6 listener to be
        // ready (or fail) before resolving, so callers never see a half-bound
        // state. Each address has its own real http server using the same
        // handler (no cross-socket emit, which can corrupt the keep-alive
        // lifecycle and cause "terminated"/socket-close errors).
        server.listen(port, '127.0.0.1', () => {
            const actualPort = server.address().port;
            const done = () => resolve({
                port: actualPort,
                stop: () => Promise.all([
                    new Promise(r => server.close(() => r())),
                    new Promise(r => v6.close(() => r())),
                ]).then(() => {}),
            });
            v6.once('error', done);              // ::1 unavailable → IPv4-only
            v6.listen(actualPort, '::1', done);  // ::1 ready → dual-stack
        });
    });
}


// ── OpenAI-compatible passthrough (nvidia, deepseek) ─────────────
function forwardOpenAI(res, body, backend, upstreamModel, stats, log) {
    // Forward the exact selected model upstream (a backend may expose many).
    const outBody = { ...body, model: upstreamModel || body.model };
    const payload = Buffer.from(JSON.stringify(outBody));
    const url = new URL(joinUrl(backend.url, '/chat/completions'));

    return pipeUpstream(res, url, payload, {
        'content-type': 'application/json',
        'authorization': `Bearer ${backend.key}`,
        'accept': body.stream !== false ? 'text/event-stream' : 'application/json',
    }, { passthrough: true, stats, log });
}


// ── Kimi-for-coding (Anthropic-native, translated) ───────────────
function forwardKimi(res, body, backend, upstreamModel, wantsStream, stats, log) {
    const anthBody = openAIToAnthropic(body, upstreamModel || backend.model);
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
function listModels(backends, aliasOf) {
    const data = [];
    for (const [name, def] of Object.entries(backends)) {
        for (const m of (def.models || [def.model])) data.push({ id: aliasOf(m), object: 'model', owned_by: name });
        data.push({ id: name, object: 'model', owned_by: name }); // backend-name alias
    }
    data.push({ id: 'auto', object: 'model', owned_by: 'deepcopilot' });
    return { object: 'list', data };
}


// ── Ollama emulation helpers ─────────────────────────────────────
// Copilot's Ollama provider reads `.models[].model` from /api/tags, then
// POSTs /api/show per model and reads `.capabilities[]` (tools/vision) and
// `.model_info["<arch>.context_length"]` (it sets maxInputTokens from this).
// The id it sends to /v1/chat/completions is exactly the tag's `model`, and
// it also embeds it in a "vendor/group/model" string it splits by '/'. So we
// expose a SLASH-FREE alias here; the router maps it back to the real id.
function ollamaTags(backends, aliasOf) {
    const tags = [];
    for (const def of Object.values(backends)) {
        for (const m of (def.models || [def.model])) {
            const id = aliasOf(m);
            tags.push({
                name: id,
                model: id,
                modified_at: new Date().toISOString(),
                size: 0,
                digest: '',
                details: { family: 'llama', parameter_size: '', quantization_level: '' },
            });
        }
    }
    return tags;
}

function ollamaShow(model, ctx) {
    return {
        // tool_calls is required for Copilot agent mode; advertise it.
        capabilities: ['completion', 'tools'],
        details: { family: 'llama', families: ['llama'] },
        model_info: {
            'general.architecture': 'llama',
            'general.basename': model || 'deepcopilot',
            'llama.context_length': ctx || DEFAULT_CTX,
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
