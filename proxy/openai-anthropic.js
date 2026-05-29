/**
 * openai-anthropic.js
 * ===================
 * Translator for the Kimi-for-coding path.
 *
 * Copilot speaks the OpenAI Chat Completions API. Kimi-for-coding
 * (api.kimi.com/coding) speaks the Anthropic Messages API. This module
 * converts:
 *
 *   OpenAI request        →  Anthropic request          (outbound)
 *   Anthropic SSE stream   →  OpenAI SSE stream          (inbound, streaming)
 *   Anthropic message JSON →  OpenAI response JSON       (inbound, non-stream)
 *
 * Nvidia and DeepSeek already speak OpenAI, so they bypass this module.
 */

import { Transform } from 'stream';

// ─────────────────────────────────────────────────────────────────
// REQUEST: OpenAI → Anthropic
// ─────────────────────────────────────────────────────────────────

export function openAIToAnthropic(body, targetModel) {
    const messages = [];
    let system = '';

    // Push content blocks for `role`, merging into the previous message
    // if it has the same role (Anthropic requires alternating turns).
    const push = (role, blocks) => {
        if (!blocks.length) return;
        const last = messages[messages.length - 1];
        if (last && last.role === role) last.content.push(...blocks);
        else messages.push({ role, content: blocks });
    };

    for (const msg of (body.messages || [])) {
        if (msg.role === 'system') {
            const text = contentToText(msg.content);
            if (text) system += (system ? '\n' : '') + text;
        } else if (msg.role === 'user') {
            push('user', userContentToBlocks(msg.content));
        } else if (msg.role === 'tool') {
            // OpenAI tool result → Anthropic tool_result block in a user turn
            push('user', [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: contentToText(msg.content),
            }]);
        } else if (msg.role === 'assistant') {
            const blocks = [];
            const text = contentToText(msg.content);
            if (text) blocks.push({ type: 'text', text });
            for (const tc of (msg.tool_calls || [])) {
                let input = {};
                try { input = JSON.parse(tc.function.arguments || '{}'); }
                catch { input = {}; }
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
            }
            push('assistant', blocks);
        }
    }

    const out = {
        model: targetModel || body.model,
        messages,
        max_tokens: body.max_tokens || 8192,
        stream: body.stream !== false,
    };
    if (system) out.system = system;
    if (body.temperature !== undefined) out.temperature = body.temperature;
    if (body.top_p !== undefined) out.top_p = body.top_p;
    if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

    if (body.tools && body.tools.length) {
        out.tools = body.tools
            .filter(t => t.type === 'function' && t.function)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                input_schema: t.function.parameters || { type: 'object', properties: {} },
            }));
        const tc = body.tool_choice;
        if (tc === 'required') out.tool_choice = { type: 'any' };
        else if (tc && tc.type === 'function') out.tool_choice = { type: 'tool', name: tc.function.name };
        else if (tc && tc !== 'none') out.tool_choice = { type: 'auto' };
    }

    return out;
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p.type === 'text' || typeof p === 'string')
            .map(p => (typeof p === 'string' ? p : p.text))
            .join('');
    }
    return '';
}

function userContentToBlocks(content) {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) return [];
    const blocks = [];
    for (const part of content) {
        if (typeof part === 'string') {
            blocks.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            const m = /^data:(.+?);base64,(.*)$/s.exec(url);
            if (m) {
                blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
            } else if (url) {
                blocks.push({ type: 'image', source: { type: 'url', url } });
            }
        }
    }
    return blocks;
}


// ─────────────────────────────────────────────────────────────────
// RESPONSE (non-streaming): Anthropic message → OpenAI response
// ─────────────────────────────────────────────────────────────────

export function anthropicMessageToOpenAI(msg, model) {
    let text = '';
    const toolCalls = [];
    for (const block of (msg.content || [])) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
        }
    }
    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;

    return {
        id: msg.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || msg.model,
        choices: [{ index: 0, message, finish_reason: mapStop(msg.stop_reason) }],
        usage: {
            prompt_tokens: msg.usage?.input_tokens || 0,
            completion_tokens: msg.usage?.output_tokens || 0,
            total_tokens: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0),
        },
    };
}


// ─────────────────────────────────────────────────────────────────
// STREAMING: Anthropic SSE → OpenAI SSE
// ─────────────────────────────────────────────────────────────────

export class AnthropicToOpenAIStream extends Transform {
    constructor(model) {
        super();
        this._buf = '';
        this._id = `chatcmpl-${Date.now()}`;
        this._model = model;
        this._created = Math.floor(Date.now() / 1000);
        this._toolIndex = -1;        // OpenAI tool_calls index (tool blocks only)
        this._blockIsTool = false;
        this._roleSent = false;
        this._finish = 'stop';
        this._usage = null;
    }

    _transform(chunk, _enc, cb) {
        this._buf += chunk.toString();
        const parts = this._buf.split('\n');
        this._buf = parts.pop();
        for (const line of parts) this._processLine(line.trim());
        cb();
    }

    _flush(cb) {
        if (this._buf.trim()) this._processLine(this._buf.trim());
        // Final chunk carrying finish_reason (+ usage if available).
        const final = this._chunk({}, this._finish);
        if (this._usage) final.usage = this._usage;
        this.push(`data: ${JSON.stringify(final)}\n\n`);
        this.push('data: [DONE]\n\n');
        cb();
    }

    _processLine(line) {
        if (!line.startsWith('data:')) return;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { return; }

        switch (ev.type) {
            case 'message_start':
                this._emitRole();
                if (ev.message?.usage) this._usage = mapUsage(ev.message.usage);
                break;
            case 'content_block_start':
                if (ev.content_block?.type === 'tool_use') {
                    this._blockIsTool = true;
                    this._toolIndex++;
                    this._emit({ tool_calls: [{
                        index: this._toolIndex,
                        id: ev.content_block.id,
                        type: 'function',
                        function: { name: ev.content_block.name, arguments: '' },
                    }] });
                } else {
                    this._blockIsTool = false;
                }
                break;
            case 'content_block_delta':
                if (ev.delta?.type === 'text_delta') {
                    this._emitRole();
                    this._emit({ content: ev.delta.text });
                } else if (ev.delta?.type === 'input_json_delta') {
                    this._emit({ tool_calls: [{
                        index: this._toolIndex,
                        function: { arguments: ev.delta.partial_json || '' },
                    }] });
                }
                break;
            case 'message_delta':
                if (ev.delta?.stop_reason) this._finish = mapStop(ev.delta.stop_reason);
                if (ev.usage) this._usage = mapUsage(ev.usage);
                break;
            // content_block_stop / message_stop need no output
        }
    }

    _emitRole() {
        if (this._roleSent) return;
        this._roleSent = true;
        this._emit({ role: 'assistant', content: '' });
    }

    _emit(delta) {
        this.push(`data: ${JSON.stringify(this._chunk(delta, null))}\n\n`);
    }

    _chunk(delta, finish) {
        return {
            id: this._id,
            object: 'chat.completion.chunk',
            created: this._created,
            model: this._model,
            choices: [{ index: 0, delta, finish_reason: finish }],
        };
    }
}


// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function mapStop(reason) {
    if (reason === 'tool_use') return 'tool_calls';
    if (reason === 'max_tokens') return 'length';
    return 'stop'; // end_turn, stop_sequence, null
}

function mapUsage(u) {
    const inT = u.input_tokens || 0;
    const outT = u.output_tokens || 0;
    return { prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT };
}
