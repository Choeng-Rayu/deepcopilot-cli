#!/usr/bin/env node
/**
 * start-proxy.js
 * ==============
 * Boot the deepcopilot router proxy.
 *
 *   node start-proxy.js [default-backend] [port]
 *
 * Reads provider keys/models from the environment (the launcher sources
 * proxy/.env first; when run standalone we also load proxy/.env here).
 * Prints the actual listen port to stdout, and a ready banner to stderr.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { startProxy } from './router-proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no deps). Does not override already-set vars.
function loadEnv(file) {
    if (!existsSync(file)) return;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!(k in process.env)) process.env[k] = v;
    }
}
loadEnv(join(__dirname, '.env'));

// Curated default model lists (used when <PROVIDER>_MODELS is not set in
// .env). Keeps .env clean while still exposing many models in the picker.
const NVIDIA_DEFAULT_MODELS = [
    'openai/gpt-oss-120b',
    'deepseek-ai/deepseek-v4-flash',
    'qwen/qwen3-coder-480b-a35b-instruct',
    'deepseek-ai/deepseek-v4-pro',
    'moonshotai/kimi-k2.6',
    'stepfun-ai/step-3.7-flash',
    'z-ai/glm-5.1',
    'minimaxai/minimax-m2.7',
    'qwen/qwen3.5-397b-a17b',
    'nvidia/nemotron-3-super-120b-a12b',
    'mistralai/mistral-large-3-675b-instruct-2512',
];

// Backend definitions: env var names + defaults. `native` marks the
// Anthropic-native (translated) path. `modelsEnv` is an optional
// comma-separated list to override the built-in `modelsDefault` list.
const DEFS = {
    nvidia:   { urlDefault: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY',   modelEnv: 'NVIDIA_MODEL',   modelsEnv: 'NVIDIA_MODELS',   modelDefault: 'moonshotai/kimi-k2.6', modelsDefault: NVIDIA_DEFAULT_MODELS, native: false },
    deepseek: { urlDefault: 'https://api.deepseek.com/v1',         keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', modelsEnv: 'DEEPSEEK_MODELS', modelDefault: 'deepseek-v4-pro',      modelsDefault: ['deepseek-v4-pro', 'deepseek-v4-flash'], native: false },
    kimi:     { urlDefault: 'https://api.kimi.com/coding',         keyEnv: 'KIMI_API_KEY',     modelEnv: 'KIMI_MODEL',     modelsEnv: 'KIMI_MODELS',     modelDefault: 'kimi-for-coding',      modelsDefault: ['kimi-for-coding'], native: true  },
};

function isPlaceholder(v) {
    return !v || /your-?\w*-?key|your_api_key/i.test(v);
}

// Build the model list for a backend. Precedence:
//   <PROVIDER>_MODEL (single) + <PROVIDER>_MODELS (csv)  →  if any set, use those
//   otherwise the built-in modelsDefault list.
// Each entry may be "id" or "id:contextTokens" (provider ids use '/' but
// never ':', so ':' safely delimits the optional context window, e.g.
// "stepfun-ai/step-3.7-flash:262144"). Returns { list:[ids], ctx:{ id: tokens } }.
function modelsFor(def) {
    const list = [];
    const ctx = {};
    const add = (v) => v && v.split(',').forEach(s => {
        let t = s.trim();
        if (!t) return;
        const i = t.indexOf(':');
        if (i > 0) {
            const n = parseInt(t.slice(i + 1), 10);
            t = t.slice(0, i).trim();
            if (Number.isFinite(n) && n > 0) ctx[t.toLowerCase()] = n;
        }
        if (t && !list.includes(t)) list.push(t);
    });
    add(process.env[def.modelEnv]);
    add(process.env[def.modelsEnv]);
    if (list.length === 0) (def.modelsDefault || [def.modelDefault]).forEach(m => add(m));
    return { list, ctx };
}

const backends = {};
const contexts = {};
for (const [name, def] of Object.entries(DEFS)) {
    const key = process.env[def.keyEnv];
    if (isPlaceholder(key)) continue; // only expose configured backends
    const { list: models, ctx } = modelsFor(def);
    Object.assign(contexts, ctx);
    backends[name] = {
        url:   def.urlDefault,
        key,
        model: models[0],   // primary (used for backend-name alias + 'auto')
        models,             // full list exposed in the picker
        native: def.native,
    };
}

if (Object.keys(backends).length === 0) {
    console.error('[deepcopilot] no provider keys configured. Edit proxy/.env (NVIDIA_API_KEY / DEEPSEEK_API_KEY / KIMI_API_KEY).');
    process.exit(1);
}

const [backendArg, portArg] = process.argv.slice(2);
let defaultBackend = (backendArg || process.env.API_PROVIDER || Object.keys(backends)[0]).toLowerCase();
if (!backends[defaultBackend]) {
    console.error(`[deepcopilot] default backend "${defaultBackend}" has no key; falling back to ${Object.keys(backends)[0]}`);
    defaultBackend = Object.keys(backends)[0];
}
const port = parseInt(portArg || process.env.DEEPCOPILOT_PORT || '11434', 10);

try {
    const { port: actualPort } = await startProxy({ port, backends, contexts, defaultBackend });
    process.stdout.write(String(actualPort) + '\n');
    console.error(`[deepcopilot] proxy ready on http://127.0.0.1:${actualPort}/v1`);
    console.error(`[deepcopilot] default backend=${defaultBackend}  configured=${Object.keys(backends).join(', ')}`);
} catch (e) {
    if (e && e.code === 'EADDRINUSE') {
        console.error(`[deepcopilot] port ${port} is in use (real Ollama?). Stop it, or set DEEPCOPILOT_PORT to another port`);
        console.error(`[deepcopilot] and set "github.copilot.chat.byok.ollamaEndpoint" to that port (run: deepcopilot --vscode-setup).`);
    } else {
        console.error('[deepcopilot] failed to start: ' + (e.stack || e.message));
    }
    process.exit(1);
}
