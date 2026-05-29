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

// Backend definitions: env var names + defaults. `native` marks the
// Anthropic-native (translated) path.
const DEFS = {
    nvidia:   { urlDefault: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY',   modelEnv: 'NVIDIA_MODEL',   modelDefault: 'moonshotai/kimi-k2.6', native: false },
    deepseek: { urlDefault: 'https://api.deepseek.com/v1',         keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', modelDefault: 'deepseek-v4-pro',      native: false },
    kimi:     { urlDefault: 'https://api.kimi.com/coding',         keyEnv: 'KIMI_API_KEY',     modelEnv: 'KIMI_MODEL',     modelDefault: 'kimi-for-coding',      native: true  },
};

function isPlaceholder(v) {
    return !v || /your-?\w*-?key|your_api_key/i.test(v);
}

const backends = {};
for (const [name, def] of Object.entries(DEFS)) {
    const key = process.env[def.keyEnv];
    if (isPlaceholder(key)) continue; // only expose configured backends
    backends[name] = {
        url:   def.urlDefault,
        key,
        model: process.env[def.modelEnv] || def.modelDefault,
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
    const { port: actualPort } = await startProxy({ port, backends, defaultBackend });
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
