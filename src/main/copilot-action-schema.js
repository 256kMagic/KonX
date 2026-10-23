'use strict';
const crypto = require('node:crypto');
const net = require('node:net');
const { domainToASCII } = require('node:url');
const ACTION_LIMITS = Object.freeze({ actions: 64, preparations: 8, preparationMs: 300000, patchChars: 48 * 1024, resultBytes: 96 * 1024, outcomeReserve: 192 * 1024, editorMs: 10000 });
const ACTION_KINDS = Object.freeze(['diagnostic.ping', 'diagnostic.dns', 'diagnostic.traceroute', 'editor.replaceSelection', 'note.saveAnswer']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function fail(message, code = 'COPILOT_ACTION_INVALID') { throw Object.assign(new Error(message), { code }); }
function object(value, fields) { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(k => !fields.includes(k))) fail('Action contains unsupported fields'); return value; }
function text(value, max, label = 'Action text', empty = false) { if (typeof value !== 'string' || value.length > max || value.includes('\0') || !empty && !value.trim()) fail(`${label} must be ${empty ? '' : 'nonempty '}text of at most ${max} characters`); return value; }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('Invalid action identifier'); return value; }
function hash(value) { if (typeof value !== 'string' || !HASH.test(value)) fail('Invalid action digest'); return value; }
function integer(value, min, max, fallback) { if (value === undefined) value = fallback; if (!Number.isSafeInteger(value) || value < min || value > max) fail('Action numeric parameter is outside its allowed range'); return value; }
function host(value, { service = false } = {}) {
  text(value, 253, 'Single host');
  if (net.isIP(value)) return value;
  if (value !== value.trim() || /[\s/:@%\\;,|&$`<>"'()[\]{}]/.test(value)) fail('Enter one IP address or DNS name, without URL, port, range or command syntax');
  const ascii = domainToASCII(value); if (!ascii || ascii.length > 253) fail('Invalid host name');
  const labels = ascii.replace(/\.$/, '').split('.'), re = service ? /^_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (labels.some(part => !re.test(part)) || /^\d+(?:\.\d+){3}$/.test(ascii)) fail('Invalid host name or IP address');
  return ascii.toLowerCase();
}
function range(value) {
  object(value, ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn']); const out = {};
  for (const key of ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn']) out[key] = integer(value[key], 1, 10000000);
  if (out.endLineNumber < out.startLineNumber || out.endLineNumber === out.startLineNumber && out.endColumn <= out.startColumn) fail('Select nonempty text to replace');
  return out;
}
function editorTarget(value) {
  object(value, ['tabId', 'documentId', 'modelId', 'versionId', 'selection', 'beforeText', 'beforeDigest', 'readOnly', 'savePending', 'textFormat']);
  const beforeText = text(value.beforeText, ACTION_LIMITS.patchChars, 'Selected editor text', true); if (!beforeText.length) fail('Select nonempty editor text');
  if (value.textFormat !== 'lf' || beforeText.includes('\r')) fail('Editor selection must use the owner’s LF text snapshot');
  if (typeof value.readOnly !== 'boolean' || typeof value.savePending !== 'boolean') fail('Editor permission state is required');
  if (value.readOnly || value.savePending) fail('The selected editor is read-only or saving; wait or choose an editable document', 'COPILOT_ACTION_PERMISSION');
  if (hash(value.beforeDigest) !== digest(beforeText)) fail('Editor selection changed or its digest is invalid', 'COPILOT_ACTION_STALE');
  return { tabId: text(value.tabId, 128), documentId: text(value.documentId, 128), modelId: id(value.modelId), versionId: integer(value.versionId, 1, Number.MAX_SAFE_INTEGER), selection: range(value.selection), beforeText, beforeDigest: value.beforeDigest, readOnly: false, savePending: false, textFormat: 'lf' };
}
function normalizeParams(kind, input) {
  if (!ACTION_KINDS.includes(kind)) fail('This action is not supported');
  if (kind === 'diagnostic.ping') { object(input, ['host', 'count', 'interval', 'timeout', 'size']); return { host: host(input.host), count: integer(input.count, 1, 10, 4), interval: integer(input.interval, 250, 5000, 1000), timeout: integer(input.timeout, 250, 5000, 1000), size: integer(input.size, 0, 1400, 32) }; }
  if (kind === 'diagnostic.traceroute') { object(input, ['host', 'maxHops', 'timeout']); return { host: host(input.host), maxHops: integer(input.maxHops, 1, 30, 15), timeout: integer(input.timeout, 250, 3000, 1000) }; }
  if (kind === 'diagnostic.dns') {
    object(input, ['name', 'type', 'server']); const type = input.type ?? 'A', server = input.server ?? '';
    if (!['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'PTR'].includes(type)) fail('Choose one supported DNS record type');
    if (typeof server !== 'string' || server && !net.isIP(server)) fail('DNS server must be one IP address or empty for the configured resolver');
    const name = host(input.name, { service: type === 'SRV' || type === 'TXT' });
    if (type === 'PTR' && !net.isIP(name)) fail('Reverse DNS requires an IP address');
    if (net.isIP(name) && type !== 'PTR') fail('Choose PTR for a reverse DNS lookup of an IP address');
    return { name, type, server };
  }
  if (kind === 'editor.replaceSelection') { object(input, ['replacement']); return { replacement: text(input.replacement, ACTION_LIMITS.patchChars, 'Replacement text', true).replace(/\r\n|\r/g, '\n') }; }
  object(input, ['title', 'start', 'end']); const out = { title: text(input.title, 160, 'Note title').trim() };
  if (input.start !== undefined) out.start = integer(input.start, 0, 50000); if (input.end !== undefined) out.end = integer(input.end, 0, 50000); return out;
}
function parseActionCandidates(answer) {
  text(answer, 50000, 'Completed answer', true); const candidates = [], issues = [];
  for (const match of answer.matchAll(/^```konx-action[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)) {
    if (candidates.length + issues.length >= 4) { issues.push('Additional candidate blocks were not examined.'); break; }
    try {
      if (Buffer.byteLength(match[1]) > 64 * 1024) fail('Candidate is too large');
      const value = object(JSON.parse(match[1]), ['kind', 'params']); candidates.push({ kind: value.kind, params: normalizeParams(value.kind, value.params) });
    } catch { issues.push('An invalid or unsupported action suggestion was ignored.'); }
  }
  return { candidates, issues };
}
function validateAction(value) {
  object(value, ['id', 'kind', 'status', 'createdAt', 'completedAt', 'source', 'review', 'result', 'error']); id(value.id);
  if (!ACTION_KINDS.includes(value.kind) || !['pending', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(value.status)) fail('Invalid saved action state');
  for (const field of ['createdAt', 'completedAt']) if (value[field] !== null && (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field])) || new Date(value[field]).toISOString() !== value[field])) fail('Invalid action timestamp');
  if (value.createdAt === null || (value.status === 'pending') !== (value.completedAt === null)) fail('Invalid action completion timestamp');
  object(value.source, ['turnId', 'turnDigest', 'requestDigest', 'citations']); id(value.source.turnId); hash(value.source.turnDigest); hash(value.source.requestDigest);
  if (!Array.isArray(value.source.citations) || value.source.citations.length > 5 || Buffer.byteLength(JSON.stringify(value.source.citations)) > 48 * 1024) fail('Invalid action source citations');
  object(value.review, ['digest', 'params', 'target', 'limitations']); hash(value.review.digest);
  if (!Array.isArray(value.review.limitations) || value.review.limitations.length > 8) fail('Invalid action limitations'); value.review.limitations.forEach(item => text(item, 2000));
  if (value.kind.startsWith('diagnostic.')) { normalizeParams(value.kind, value.review.params); if (value.review.target !== null) fail('Unexpected diagnostic object target'); }
  else if (value.kind === 'editor.replaceSelection') {
    object(value.review.params, ['replacementDigest', 'replacementChars']); hash(value.review.params.replacementDigest); integer(value.review.params.replacementChars, 0, ACTION_LIMITS.patchChars);
    object(value.review.target, ['tabId', 'documentId', 'modelId', 'versionId', 'selection', 'beforeDigest', 'beforeChars', 'textFormat']);
    text(value.review.target.tabId, 128); text(value.review.target.documentId, 128); id(value.review.target.modelId); integer(value.review.target.versionId, 1, Number.MAX_SAFE_INTEGER); range(value.review.target.selection); hash(value.review.target.beforeDigest); integer(value.review.target.beforeChars, 1, ACTION_LIMITS.patchChars); if (value.review.target.textFormat !== 'lf') fail('Invalid saved editor format');
  } else { object(value.review.params, ['title', 'start', 'end', 'contentDigest', 'contentChars']); text(value.review.params.title, 160); integer(value.review.params.start, 0, 50000); integer(value.review.params.end, 0, 50000); hash(value.review.params.contentDigest); integer(value.review.params.contentChars, 1, 32000); if (value.review.target !== null) fail('Unexpected note target'); }
  text(value.error, 2000, 'Action outcome', true);
  if (value.result !== null && (typeof value.result !== 'object' || Array.isArray(value.result) || Buffer.byteLength(JSON.stringify(value.result)) > ACTION_LIMITS.resultBytes)) fail('Saved action result exceeds its bound');
  return value;
}
module.exports = { ACTION_LIMITS, ACTION_KINDS, digest, fail, object, text, id, hash, integer, editorTarget, normalizeParams, parseActionCandidates, validateAction };
