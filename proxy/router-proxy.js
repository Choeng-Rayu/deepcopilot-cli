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
import { Transform } from 'stream';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    openAIToAnthropic,
    anthropicMessageToOpenAI,
    AnthropicToOpenAIStream,
} from './openai-anthropic.js';
import { solvePowChallenge } from './deepseek-pow.js';

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
            const key = String(model).toLowerCase();
            const hit = modelOwner.get(key);
            if (hit) return hit;
            // Only these explicit aliases fall back to the default backend.
            // ANY other unknown model is an error (don't silently mask it as
            // the default model — that hid mis-selections as gpt-oss).
            if (key !== 'auto' && key !== 'copilot' && key !== 'default') {
                return null;
            }
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
        const resolved = resolve(body.model);
        if (!resolved) {
            // Unknown model — surface it instead of silently using the default.
            stats.errors++;
            const valid = listModels(backends, aliasOf).data.map(m => m.id);
            log(`unknown model "${body.model}" → 400 (valid: ${valid.join(', ')})`);
            return json(res, 400, { error: {
                message: `Unknown model "${body.model}". Valid models: ${valid.join(', ')}. (Use 'auto' for the default backend.)`,
                code: 'model_not_found', type: 'invalid_request_error', param: 'model',
            }});
        }
        const { backend: backendName, modelId } = resolved;
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
            if (backend.web) {
                await forwardDeepSeekWeb(res, body, backend, upstreamModel, wantsStream, stats, log);
            } else if (backend.native) {
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
    }, { passthrough: true, wantsStream: body.stream !== false, stats, log });
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


// ── chat.deepseek.com web session (browser auth + WASM PoW) ──────
// TEXT ONLY (no tool calling). Flattens the OpenAI conversation to one
// prompt, solves the per-turn sha3 PoW, then re-emits the site's
// JSON-patch SSE as OpenAI chat.completion.chunk SSE (content ->
// delta.content, thinking_content -> delta.reasoning_content).
const DS_WEB_HOST = 'chat.deepseek.com';
const DS_WEB_BASE = '/api/v0';

function dsWebHeaders(backend, extra = {}) {
    return {
        'accept': '*/*',
        'authorization': `Bearer ${backend.key}`,
        'content-type': 'application/json',
        'origin': 'https://chat.deepseek.com',
        'referer': 'https://chat.deepseek.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'x-app-version': '20241129.1',
        'x-client-locale': 'en_US',
        'x-client-platform': 'web',
        'x-client-version': '1.0.0-always',
        ...(backend.cookie ? { cookie: backend.cookie } : {}),
        ...extra,
    };
}

function dsWebPostJson(backend, path, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = httpsRequest({
            host: DS_WEB_HOST, port: 443, method: 'POST', path: DS_WEB_BASE + path,
            headers: dsWebHeaders(backend, { 'content-length': Buffer.byteLength(body) }),
            timeout: REQUEST_TIMEOUT_MS, family: 4,
        }, (r) => {
            let buf = '';
            r.on('data', c => buf += c);
            r.on('end', () => {
                if (r.statusCode !== 200) return reject(new Error(`${path} → HTTP ${r.statusCode}: ${buf.slice(0, 300)}`));
                try { resolve(JSON.parse(buf)); } catch { reject(new Error(`${path} → invalid JSON: ${buf.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(`${path} timed out`)));
        req.write(body); req.end();
    });
}

// Collapse the OpenAI conversation (incl. tool blocks) into one prompt.
// When `tools` are provided, prepend an instruction preamble so the
// (text-only) model can emit tool calls as <tool_call>{json}</tool_call>
// markers, which we parse back into OpenAI tool_calls (emulated/prompted
// tool calling — the standard technique for models without native tools).
function flattenMessagesToPrompt(messages, tools) {
    const lines = [];
    if (tools && tools.length) lines.push(buildToolPreamble(tools));
    for (const m of (messages || [])) {
        if (m.role === 'system') { if (m.content) lines.push(contentText(m.content)); continue; }
        if (m.role === 'tool') { lines.push(`[tool result for ${m.tool_call_id || ''}]: ${contentText(m.content)}`); continue; }
        const role = m.role === 'assistant' ? 'Assistant' : 'User';
        let text = contentText(m.content);
        for (const tc of (m.tool_calls || [])) {
            text += `\n<tool_call>${JSON.stringify({ name: tc.function?.name, arguments: safeParse(tc.function?.arguments) })}</tool_call>`;
        }
        if (text.trim()) lines.push(`${role}: ${text}`);
    }
    return lines.join('\n\n');
}
function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => typeof p === 'string' ? p : (p.text || '')).join('');
    return '';
}
function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

function buildToolPreamble(tools) {
    const defs = tools.filter(t => t.type === 'function' && t.function).map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} },
    }));
    return [
        'You are an AI agent that can call tools. The following tools are available (JSON Schema):',
        '```json',
        JSON.stringify(defs, null, 2),
        '```',
        'When you need to call a tool, output ONE OR MORE markers, each on its own line, with NOTHING else around them:',
        '<tool_call>{"name":"<tool_name>","arguments":{<args matching the schema>}}</tool_call>',
        'Rules:',
        '- Emit a <tool_call> marker only when you actually want to call a tool; the arguments MUST be valid JSON.',
        '- You may emit multiple <tool_call> markers to call several tools at once.',
        '- Do NOT wrap tool calls in code fences. Do NOT explain the call. After tool results come back, continue.',
        '- If you do not need a tool, just answer normally in plain text.',
    ].join('\n');
}

// Parse tool calls out of model text. Tolerates <tool_call> markers,
// unterminated markers, and ```json fenced/bare tool objects. Returns
// { calls:[OpenAI tool_call], text:<markers removed>, notes:[diagnostics] }.
function parseToolCalls(text) {
    const calls = [];
    const notes = [];      // diagnostics for the tool-debug log
    let i = 0;
    const add = (obj, via) => {
        if (!obj || typeof obj !== 'object' || !obj.name) return false;
        const args = obj.arguments ?? obj.parameters ?? obj.args ?? {};
        calls.push({ id: `call_${Date.now()}_${i++}`, type: 'function',
            function: { name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
        if (via !== 'marker') notes.push(`recovered via ${via}: ${obj.name}`);
        return true;
    };

    let cleaned = text;

    // 1. Canonical <tool_call>...</tool_call> markers (tolerate ``` fences inside).
    cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (full, inner) => {
        const body = inner.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        try { if (add(JSON.parse(body), 'marker')) return ''; } catch {}
        notes.push(`marker failed to parse: ${body.slice(0, 120)}`);
        return '';
    });

    // 2. Unterminated <tool_call> (model forgot the closing tag).
    if (calls.length === 0 && /<tool_call>/.test(cleaned)) {
        const m = /<tool_call>\s*([\s\S]*)$/.exec(cleaned);
        if (m) {
            const body = m[1].replace(/<\/tool_call>/g, '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
            try { if (add(JSON.parse(body), 'unterminated-marker')) cleaned = cleaned.replace(m[0], ''); }
            catch { notes.push(`unterminated marker unparseable: ${body.slice(0, 120)}`); }
        }
    }

    // 3. Fallback: a ```json fence or bare top-level object that looks like a
    //    tool call ({"name":...,"arguments":...}) — some models ignore the tag.
    if (calls.length === 0) {
        const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
        let f;
        while ((f = fence.exec(cleaned)) !== null) {
            try { const o = JSON.parse(f[1]); if (o && o.name && (o.arguments || o.parameters || o.args)) { if (add(o, 'code-fence')) cleaned = cleaned.replace(f[0], ''); } } catch {}
        }
    }

    return { calls, text: cleaned.replace(/<\/?tool_call>/g, '').trim(), notes };
}

// Dedicated tool-debug log so we can diagnose tool-call format issues on the
// DeepSeek web backend. Appends to proxy/.cache/deepseek-tools.log.
const DS_TOOL_LOG = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'deepseek-tools.log');
function dsToolLog(msg) {
    try { appendFileSync(DS_TOOL_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
    if (process.env.DEEPCOPILOT_DEBUG === '1') console.error('[deepcopilot][dstools]', msg);
}

async function forwardDeepSeekWeb(res, body, backend, upstreamModel, wantsStream, stats, log) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasTools = tools.length > 0;
    const prompt = flattenMessagesToPrompt(body.messages, tools);
    const thinking = true; // thinking mode ON (deepseek-v4-pro reasoning)
    const id = `chatcmpl-${Date.now()}`, created = Math.floor(Date.now() / 1000);
    const model = upstreamModel || backend.model;
    if (hasTools) dsToolLog(`REQUEST id=${id} tools=[${tools.map(t => t.function?.name).join(', ')}] stream=${wantsStream}`);

    // 1. session  2. PoW challenge → solve
    const sess = await dsWebPostJson(backend, '/chat_session/create', { character_id: null });
    const sid = sess?.data?.biz_data?.id;
    if (!sid) throw new Error('no session id in chat_session/create response');
    const chResp = await dsWebPostJson(backend, '/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' });
    const challenge = chResp?.data?.biz_data?.challenge;
    if (!challenge) throw new Error('no challenge in create_pow_challenge response');
    const pow = await solvePowChallenge(challenge);
    log(`deepseek web: session=${sid.slice(0, 8)} prompt=${prompt.length}b thinking=${thinking}`);

    // 3. completion (always stream from upstream; we adapt to client)
    const reqBody = JSON.stringify({
        chat_session_id: sid, parent_message_id: null, prompt,
        ref_file_ids: [], thinking_enabled: thinking, search_enabled: false,
    });
    const headers = dsWebHeaders(backend, {
        accept: 'text/event-stream', 'x-ds-pow-response': pow,
        'content-length': Buffer.byteLength(reqBody),
    });

    await new Promise((resolve, reject) => {
        const upstream = httpsRequest({
            host: DS_WEB_HOST, port: 443, method: 'POST', path: DS_WEB_BASE + '/chat/completion',
            headers, timeout: REQUEST_TIMEOUT_MS, family: 4,
        }, (upRes) => {
            if (upRes.statusCode !== 200) {
                const chunks = [];
                upRes.on('data', c => chunks.push(c));
                upRes.on('end', () => {
                    if (!res.headersSent) res.writeHead(upRes.statusCode, { 'content-type': 'application/json' });
                    res.end(Buffer.concat(chunks)); resolve();
                });
                return;
            }
            log('deepseek web replied: 200 OK');

            // Streaming path → OpenAI chat.completion.chunk SSE.
            const emit = (delta, finish = null) => {
                const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            };
            // When tools are in play we must buffer the whole answer so we can
            // detect <tool_call> markers (they span chunks) and convert them to
            // OpenAI tool_calls. Without tools we stream content live.
            const streamLive = wantsStream && !hasTools;
            let fullContent = '', nonStreamText = '';
            if (streamLive) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                emit({ role: 'assistant', content: '' });
            }

            let buf = '', curPath = null, finished = false;
            const finish = () => {
                if (finished) return; finished = true;
                if (hasTools) {
                    // Parse markers out of the buffered answer.
                    const { calls, text, notes } = parseToolCalls(fullContent);
                    // Tool-debug log: raw output + parse outcome for diagnosis.
                    dsToolLog(`RAW id=${id} (${fullContent.length}b): ${JSON.stringify(fullContent.slice(0, 1200))}`);
                    (notes || []).forEach(n => dsToolLog(`NOTE id=${id}: ${n}`));
                    if (calls.length) dsToolLog(`PARSED id=${id} ${calls.length} call(s): ${calls.map(c => `${c.function.name}(${c.function.arguments})`).join(' | ')}`);
                    else if (hasTools) dsToolLog(`NO-CALL id=${id}: model returned text only (${text.length}b)`);
                    const finishReason = calls.length ? 'tool_calls' : 'stop';
                    if (wantsStream) {
                        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                        emit({ role: 'assistant', content: text || '' });
                        calls.forEach((c, i) => emit({ tool_calls: [{ index: i, id: c.id, type: 'function', function: c.function }] }));
                        emit({}, finishReason);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        const message = { role: 'assistant', content: calls.length ? null : (text || '') };
                        if (calls.length) message.tool_calls = calls;
                        json(res, 200, { id, object: 'chat.completion', created, model,
                            choices: [{ index: 0, message, finish_reason: finishReason }],
                            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
                    }
                } else if (streamLive) {
                    emit({}, 'stop');
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    json(res, 200, { id, object: 'chat.completion', created, model,
                        choices: [{ index: 0, message: { role: 'assistant', content: nonStreamText }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
                }
                stats && (stats.byBackend.__lastModel = model);
                resolve();
            };
            const onData = (s) => {
                if (finished) return;
                let d; try { d = JSON.parse(s); } catch { return; }
                if (typeof d.p === 'string') curPath = d.p;   // sticky path cursor
                const v = d.v;
                if (curPath === 'response/content' && typeof v === 'string') {
                    if (streamLive) emit({ content: v });
                    else if (hasTools) fullContent += v;
                    else nonStreamText += v;
                } else if (curPath === 'response/thinking_content' && typeof v === 'string') {
                    if (streamLive) emit({ reasoning_content: v });   // hidden while buffering for tools
                } else if (curPath === 'response/status' && v === 'FINISHED') {
                    finish();
                }
            };
            upRes.on('data', (c) => {
                buf += c.toString();
                let idx;
                while ((idx = buf.indexOf('\n\n')) !== -1) {
                    const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
                    for (const line of block.split('\n')) {
                        if (line.startsWith('data:')) onData(line.slice(5).replace(/^ /, ''));
                    }
                }
            });
            upRes.on('end', finish);
            upRes.on('error', reject);
        });
        upstream.on('error', reject);
        upstream.on('timeout', () => upstream.destroy(new Error(`deepseek web timeout`)));
        upstream.write(reqBody); upstream.end();
    });
}


// Strip non-standard fields from OpenAI-passthrough SSE so the Copilot CLI
// renders text instead of dumping raw JSON. Rebuilds each chunk with ONLY
// standard OpenAI fields. NVIDIA reasoning models add non-standard fields at
// the chunk level (prompt_token_ids) and choice level (token_ids, stop_reason)
// and stream the visible answer in delta.reasoning_content/reasoning while
// content is empty — we surface that reasoning text as `content` so the CLI
// shows it instead of nothing.
class OpenAISanitizeStream extends Transform {
    constructor() { super(); this._buf = ''; this._sawContent = false; }
    _transform(chunk, _enc, cb) {
        this._buf += chunk.toString();
        const parts = this._buf.split('\n');
        this._buf = parts.pop();
        for (const line of parts) this.push(this._fixLine(line) + '\n');
        cb();
    }
    _flush(cb) { if (this._buf) this.push(this._fixLine(this._buf)); cb(); }
    _fixLine(line) {
        const s = line.trimStart();
        if (!s.startsWith('data:')) return line;          // event:/blank/comment lines pass through
        const payload = s.slice(5).trim();
        if (payload === '' || payload === '[DONE]') return line;
        let j; try { j = JSON.parse(payload); } catch { return line; }
        if (!j || !Array.isArray(j.choices)) return line;
        // Rebuild chunk with only standard top-level fields (drops
        // prompt_token_ids and any other non-standard chunk fields).
        const clean = {
            id: j.id, object: j.object || 'chat.completion.chunk',
            created: j.created, model: j.model,
        };
        if (j.usage) clean.usage = j.usage;
        clean.choices = j.choices.map(c => {
            const out = { index: c.index ?? 0, finish_reason: c.finish_reason ?? null };
            if (c.delta) {
                const d = {}, src = c.delta;
                if (src.role !== undefined) d.role = src.role;
                // Visible text: prefer real content; else surface reasoning so
                // the answer isn't blank for reasoning models.
                let textPiece = (src.content !== undefined && src.content !== null) ? src.content : '';
                if (textPiece) this._sawContent = true;
                if (!textPiece && !this._sawContent) {
                    const r = src.reasoning_content ?? src.reasoning;
                    if (typeof r === 'string') textPiece = r;
                }
                if (textPiece) d.content = textPiece;
                if (src.tool_calls !== undefined) d.tool_calls = src.tool_calls;
                if (src.refusal !== undefined && src.refusal !== null) d.refusal = src.refusal;
                out.delta = d;
            }
            if (c.message) {            // non-stream safety (rare on this path)
                const src = c.message;
                out.message = {
                    role: src.role || 'assistant',
                    content: (src.content ?? src.reasoning_content ?? src.reasoning ?? '') || '',
                    ...(src.tool_calls ? { tool_calls: src.tool_calls } : {}),
                };
            }
            return out;
        });
        return 'data: ' + JSON.stringify(clean);
    }
}


// ── Shared upstream plumbing ─────────────────────────────────────
function pipeUpstream(res, url, payload, headers, mode) {
    return new Promise((resolve, reject) => {
        const reqLib = url.protocol === 'https:' ? httpsRequest : httpRequest;
        headers['content-length'] = String(payload.length);

        // For streaming requests, commit 200 SSE headers IMMEDIATELY — before
        // the upstream's first byte. Node fetch/undici (VS Code) aborts with
        // UND_ERR_HEADERS_TIMEOUT (~10s) if headers are late on a slow model,
        // surfacing as a confusing "terminated". Native providers send headers
        // up front and keep the connection alive; we match that. Once headers
        // are sent we can't change status, so upstream errors become SSE chunks.
        const earlyStream = !!mode.wantsStream;
        if (earlyStream && !res.headersSent) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
            res.flushHeaders();                  // push headers now so undici's headers-timeout never trips
        }
        const failStream = (msg) => {     // emit an OpenAI-style error as SSE, then close
            try { res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\ndata: [DONE]\n\n`); } catch {}
            try { res.end(); } catch {}
            resolve();
        };

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
                    const bodyStr = Buffer.concat(chunks).toString('utf8');
                    if (res.headersSent) { failStream(`upstream ${up.statusCode}: ${bodyStr.slice(0, 500)}`); return; }
                    res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'] || 'application/json' });
                    res.end(bodyStr);
                    resolve();
                });
                up.on('error', () => res.headersSent ? failStream(`upstream ${up.statusCode}`) : reject(new Error(`upstream ${up.statusCode}`)));
                return;
            }

            // OpenAI passthrough. For SSE we sanitize each chunk to STANDARD
            // OpenAI fields — some providers (NVIDIA nemotron) add non-standard
            // delta fields (reasoning, reasoning_content, token_ids, stop_reason)
            // that the Copilot CLI can't render and dumps as raw JSON. Non-SSE
            // bodies pass through unchanged.
            if (mode.passthrough) {
                const ct = up.headers['content-type'] || 'application/json';
                if (/event-stream/i.test(ct) || earlyStream) {
                    if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                    const tx = new OpenAISanitizeStream();
                    up.pipe(tx).pipe(res);
                    tx.on('end', resolve);
                    tx.on('error', reject);
                    up.on('error', e => failStream(String(e.message || e)));
                } else {
                    res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
                    up.pipe(res);
                    up.on('end', resolve);
                    up.on('error', reject);
                }
                return;
            }

            // Kimi translate path.
            if (mode.wantsStream) {
                if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                const tx = new AnthropicToOpenAIStream(mode.model);
                up.pipe(tx).pipe(res);
                tx.on('end', resolve);
                tx.on('error', reject);
                up.on('error', e => failStream(String(e.message || e)));
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
            if (!res.headersSent) { json(res, 502, { error: { message: e.message } }); resolve(); }
            else failStream(String(e.message || e));
        });
        upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
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
