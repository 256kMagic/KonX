'use strict';

// SSE framing and terminal-message validation. Raw text never leaves this owner.
// Protocol references: developers.openai.com/api/docs/guides/streaming-responses
// and /api/reference/resources/chat/subresources/completions/streaming-events.
const { TextDecoder } = require('node:util');
const FRAME_LIMIT = 512 * 1024;
function streamParser(provider) {
  const responses = provider === 'openai', decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', lines = [], frameBytes = 0, events = 0, terminal = false, output = null, answer = '', finishReason = null, usage = null, model = '';
  const fail = () => { throw new Error('The AI provider returned an invalid or incomplete event stream'); };
  function dispatch() {
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim(); lines = []; frameBytes = 0;
    if (!data) return;
    if (++events > 10000 || terminal) fail();
    if (data === '[DONE]') { if (responses || !finishReason) fail(); terminal = true; output = { model, choices: [{ message: { content: answer }, finish_reason: finishReason }], usage }; return; }
    let value; try { value = JSON.parse(data); } catch { fail(); }
    if (!value || typeof value !== 'object' || value.error) fail();
    if (responses) {
      if (typeof value.type !== 'string' || event && event !== value.type) fail();
      if (['error', 'response.failed'].includes(value.type)) fail();
      if (['response.completed', 'response.incomplete'].includes(value.type)) { if (!value.response || typeof value.response !== 'object' || value.response.status !== value.type.slice(9)) fail(); output = value.response; terminal = true; }
      else if (value.type === 'response.output_text.delta' && typeof value.delta !== 'string') fail();
    } else {
      if (!Array.isArray(value.choices)) fail();
      if (value.model !== undefined) { if (typeof value.model !== 'string' || value.model.length > 240) fail(); model = value.model; }
      if (value.usage != null) { if (typeof value.usage !== 'object' || Array.isArray(value.usage)) fail(); usage = value.usage; }
      for (const choice of value.choices) {
        if (choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object') fail();
        if (choice.delta.refusal) fail();
        if (choice.delta.content != null) {
          if (typeof choice.delta.content !== 'string' || finishReason) fail();
          answer += choice.delta.content; if (answer.length > 2 * 1024 * 1024) fail();
        }
        if (choice.finish_reason != null) { if (finishReason || typeof choice.finish_reason !== 'string') fail(); finishReason = choice.finish_reason; }
      }
    }
  }
  function read(final) {
    for (;;) {
      const match = /[\r\n]/.exec(buffer); if (!match) break;
      const index = match.index; if (!final && buffer[index] === '\r' && index === buffer.length - 1) break;
      const line = buffer.slice(0, index), width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1; buffer = buffer.slice(index + width);
      frameBytes += Buffer.byteLength(line) + width; if (frameBytes > FRAME_LIMIT) fail();
      if (!line) dispatch(); else if (!line.startsWith(':')) lines.push(line);
    }
    if (Buffer.byteLength(buffer) + frameBytes > FRAME_LIMIT) fail();
  }
  return {
    push(bytes) { buffer += decoder.decode(bytes, { stream: true }); read(false); },
    finish() { buffer += decoder.decode(); read(true); if (buffer.trim() || lines.length || !terminal || !output) fail(); return output; },
  };
}
module.exports = { streamParser, FRAME_LIMIT };
