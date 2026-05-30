/**
 * deepseek-pow.js — solves the sha3 proof-of-work that chat.deepseek.com
 * requires before every /chat/completion, using the site's own WASM.
 * Returns the base64 string for the `x-ds-pow-response` header.
 * No npm deps — uses Node's built-in WebAssembly.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, 'wasm', 'sha3_wasm_bg.7b9ca65ddd.wasm');

let _exports = null;
async function loadWasm() {
    if (_exports) return _exports;
    const mod = await WebAssembly.compile(readFileSync(WASM_PATH));
    const inst = await WebAssembly.instantiate(mod, {});
    _exports = inst.exports;
    return _exports;
}

function writeString(ex, text) {
    const bytes = Buffer.from(text, 'utf8');
    const ptr = ex.__wbindgen_export_0(bytes.length, 1);     // malloc
    new Uint8Array(ex.memory.buffer).set(bytes, ptr);        // re-acquire view (heap may grow)
    return [ptr, bytes.length];
}

function calculateHash(ex, challenge, salt, difficulty, expireAt) {
    const prefix = `${salt}_${expireAt}_`;
    const retptr = ex.__wbindgen_add_to_stack_pointer(-16);
    try {
        const [cPtr, cLen] = writeString(ex, challenge);
        const [pPtr, pLen] = writeString(ex, prefix);
        ex.wasm_solve(retptr, cPtr, cLen, pPtr, pLen, Number(difficulty));
        const view = new DataView(ex.memory.buffer);
        const status = view.getInt32(retptr, true);
        if (status === 0) return null;                       // no solution
        return Math.floor(view.getFloat64(retptr + 8, true));// the answer
    } finally {
        ex.__wbindgen_add_to_stack_pointer(16);
    }
}

export async function solvePowChallenge(c) {
    const ex = await loadWasm();
    const answer = calculateHash(ex, c.challenge, c.salt, c.difficulty, c.expire_at);
    if (answer === null) throw new Error('PoW solve failed (wasm returned null)');
    const result = {
        algorithm: c.algorithm, challenge: c.challenge, salt: c.salt,
        answer, signature: c.signature, target_path: c.target_path,
    };
    return Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
}
