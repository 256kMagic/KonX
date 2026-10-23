'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { ACTION_LIMITS, validateAction } = require('./copilot-action-schema');
const { publishNewFile } = require('./atomic-replacement');

const LIMITS = Object.freeze({ conversations: 100, turns: 100, attachments: 32, selectedAttachments: 8, historyTurns: 12,
  questionChars: 8000, answerChars: 50000, snapshotBytes: 64 * 1024, requestBytes: 256 * 1024,
  recordBytes: 4 * 1024 * 1024, libraryBytes: 32 * 1024 * 1024, completionReserve: 512 * 1024, preparations: 8, preparationMs: 300000 });
const KINDS = Object.freeze(['ping', 'sweep', 'portscan', 'traceroute', 'dns', 'whois', 'subnet', 'wol', 'netinfo', 'terminal', 'connection', 'sftp', 'notepad', "capture-packet", "capture-stream", "sip-call", "rtp-stream", "capture-compare", "remote-capture", "security", "wifi", "mist", 'device', 'snapshots', 'topology', 'events', 'sites', 'incidents', 'runbook', 'change-validation']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const clone = value => structuredClone(value);
function fail(message, code = 'COPILOT_INVALID') { throw Object.assign(new Error(message), { code }); }
function object(value, fields, label = 'Copilot value') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${label} contains an unsupported field`);
  return value;
}
function text(value, max, label = 'Text', empty = true) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || !empty && !value.trim()) fail(`${label} must be ${empty ? '' : 'nonempty '}text of at most ${max} characters`);
  return value;
}
function uuid(value) { if (!UUID.test(value) || typeof value !== 'string') fail('Invalid Copilot identifier'); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail('Reopen the conversation; its current revision is required', 'COPILOT_CONFLICT'); return value; }
function timestamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Invalid Copilot timestamp'); return value; }
function array(value, max, label) { if (!Array.isArray(value) || value.length > max) fail(`${label} exceeds its ${max}-entry limit`, 'COPILOT_LIMIT'); return value; }
function ids(value, max, label) { const out = array(value, max, label).map(uuid); if (new Set(out).size !== out.length) fail(`Duplicate ${label}`); return out; }
function json(value, max = LIMITS.recordBytes) { const data = JSON.stringify(value); if (Buffer.byteLength(data) > max) fail('Copilot data exceeds its byte limit', 'COPILOT_LIMIT'); return data; }
function boundedData(value, sanitize = value => value) {
  let nodes = 0;
  function visit(item, depth, field) {
    if (++nodes > 5000 || depth > 12) fail('Evidence is too deeply nested or has too many facts', 'COPILOT_LIMIT');
    item = sanitize(item, field);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('Evidence numbers must be finite'); return item; }
    if (typeof item === 'string') return text(item, LIMITS.snapshotBytes, 'Evidence text');
    if (Array.isArray(item)) return array(item, 2000, 'Evidence facts').map(x => visit(x, depth + 1, field));
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('Evidence must contain JSON values');
    const out = {};
    for (const [key, entry] of Object.entries(item)) {
      text(key, 128, 'Evidence field', false);
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Invalid evidence field');
      const safeKey = sanitize(key);
      text(safeKey, 128, 'Evidence field', false);
      if (Object.hasOwn(out, safeKey)) fail('Evidence redaction would create duplicate fields; select a smaller source');
      out[safeKey] = visit(entry, depth + 1, key);
    }
    return out;
  }
  return visit(value, 0);
}
function normalizeSnapshot(input, sanitize = value => value) {
  object(input, ['schemaVersion', 'kind', 'title', 'capturedAt', 'source', 'state', 'scope', 'selection', 'facts', 'coverage', 'omissions'], 'Evidence snapshot');
  // Bound the complete input before redaction, without dropping an inner field.
  json(boundedData(input), LIMITS.snapshotBytes);
  if (input.schemaVersion !== 1 || !KINDS.includes(input.kind)) fail('This tool does not yet support typed Copilot evidence');
  object(input.source, ['tabId', 'runId', 'revision'], 'Evidence source');
  object(input.selection, ['mode', 'ids'], 'Evidence selection');
  object(input.coverage, ['observed', 'total', 'complete'], 'Evidence coverage');
  if (!['idle', 'running', 'complete', 'stopped', 'error', 'unknown'].includes(input.state)) fail('Invalid evidence state');
  if (!['all', 'selected'].includes(input.selection.mode)) fail('Invalid evidence selection mode');
  const source = { tabId: text(input.source.tabId, 128, 'Source tab', false), runId: input.source.runId === null ? null : text(input.source.runId, 128, 'Source run', false), revision: input.source.revision };
  if (source.revision !== null && !(typeof source.revision === 'string' && source.revision.length <= 128) && !Number.isSafeInteger(source.revision)) fail('Invalid source revision');
  for (const field of ['observed', 'total']) if (input.coverage[field] !== null && (!Number.isSafeInteger(input.coverage[field]) || input.coverage[field] < 0)) fail('Invalid evidence coverage');
  if (typeof input.coverage.complete !== 'boolean' || input.coverage.total !== null && input.coverage.observed !== null && input.coverage.observed > input.coverage.total) fail('Invalid evidence coverage');
  if (!input.scope || typeof input.scope !== 'object' || Array.isArray(input.scope) || !input.facts || typeof input.facts !== 'object') fail('Evidence scope and facts must be structured');
  const out = { schemaVersion: 1, kind: input.kind, title: sanitize(text(input.title, 256, 'Evidence title', false)), capturedAt: timestamp(input.capturedAt), source,
    state: input.state, scope: boundedData(input.scope, sanitize), selection: { mode: input.selection.mode, ids: array(input.selection.ids, 2000, 'Selected facts').map(v => text(v, 128, 'Fact identifier', false)) },
    facts: boundedData(input.facts, sanitize), coverage: { ...input.coverage }, omissions: array(input.omissions, 32, 'Evidence omissions').map(v => sanitize(text(v, 2000, 'Omission'))) };
  json(out, LIMITS.snapshotBytes); return out;
}
function validateTurn(turn) {
  object(turn, ['id', 'status', 'createdAt', 'completedAt', 'question', 'attachmentIds', 'historyTurnIds', 'request', 'answer', 'usage', 'limitations', 'error'], 'Conversation turn');
  uuid(turn.id); timestamp(turn.createdAt); if (turn.completedAt !== null) timestamp(turn.completedAt);
  if (!['pending', 'complete', 'cancelled', 'failed', 'interrupted'].includes(turn.status)) fail('Invalid turn state');
  text(turn.question, LIMITS.questionChars, 'Question', false); text(turn.answer, LIMITS.answerChars, 'Answer');
  ids(turn.attachmentIds, LIMITS.selectedAttachments, 'attachment selection'); ids(turn.historyTurnIds, LIMITS.historyTurns, 'history selection');
  object(turn.request, ['digest', 'provider', 'model', 'providerRevision', 'body', 'endpoint', 'references', 'evidence'], 'Reviewed request');
  if (!/^[a-f0-9]{64}$/.test(turn.request.digest)) fail('Invalid reviewed request digest');
  for (const key of ['provider', 'model', 'providerRevision']) text(turn.request[key], 256, key, false);
  text(turn.request.body, LIMITS.requestBytes, 'Reviewed body', false); if (Buffer.byteLength(turn.request.body) > LIMITS.requestBytes) fail('Reviewed request exceeds its byte limit');
  text(turn.request.endpoint, 2048, 'Provider endpoint', false);
  array(turn.request.references, 5, 'Knowledge references'); array(turn.request.evidence, LIMITS.selectedAttachments, 'Turn evidence');
  boundedData(turn.request.references); for (const entry of turn.request.evidence) { object(entry, ['id', 'revision', 'createdAt', 'snapshot']); uuid(entry.id); revision(entry.revision); timestamp(entry.createdAt); normalizeSnapshot(entry.snapshot); }
  object(turn.usage, ['inputTokens', 'outputTokens', 'totalTokens', 'source'], 'Usage');
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) if (turn.usage[key] !== null && (!Number.isSafeInteger(turn.usage[key]) || turn.usage[key] < 0)) fail('Invalid provider usage');
  if (turn.usage.source !== 'provider') fail('Invalid usage source');
  array(turn.limitations, 8, 'Turn limitations').forEach(v => text(v, 2000, 'Limitation')); text(turn.error, 2000, 'Turn error');
  return turn;
}
function validateRecord(value, id = value?.id) {
  object(value, ['schemaVersion', 'kind', 'id', 'revision', 'name', 'createdAt', 'updatedAt', 'attachments', 'turns', 'actions'], 'Conversation');
  if (value.schemaVersion !== 1 || value.kind !== 'konx-copilot-conversation' || value.id !== uuid(id)) fail('Invalid conversation identity');
  revision(value.revision); text(value.name, 256, 'Conversation name', false); timestamp(value.createdAt); timestamp(value.updatedAt);
  const attachments = array(value.attachments, LIMITS.attachments, 'Attachments');
  for (const entry of attachments) { object(entry, ['id', 'revision', 'createdAt', 'snapshot']); uuid(entry.id); if (entry.revision !== 1) fail('Invalid attachment revision'); timestamp(entry.createdAt); normalizeSnapshot(entry.snapshot); }
  const turns = array(value.turns, LIMITS.turns, 'Conversation turns'); turns.forEach(validateTurn);
  if (new Set(attachments.map(v => v.id)).size !== attachments.length || new Set(turns.map(v => v.id)).size !== turns.length || turns.filter(v => v.status === 'pending').length > 1) fail('Invalid duplicate conversation entries');
  const actions = value.actions === undefined ? [] : array(value.actions, ACTION_LIMITS.actions, 'Reviewed actions'); actions.forEach(validateAction);
  if (new Set(actions.map(a => a.id)).size !== actions.length || actions.some(a => !turns.some(t => t.id === a.source.turnId && t.status === 'complete')) || actions.filter(a => a.status === 'pending').length + turns.filter(t => t.status === 'pending').length > 1) fail('Invalid reviewed action identity or source');
  // Check the existing v1 serialized record before supplying its optional field.
  // Old records remain readable, including those at the old exact byte limit.
  json(value); value.actions = actions; return value;
}
const emptyUsage = () => ({ inputTokens: null, outputTokens: null, totalTokens: null, source: 'provider' });

class CopilotStore {
  constructor(profile, { fs: io = fs, now = () => Date.now(), publishNew = publishNewFile } = {}) {
    if (typeof profile !== 'string' || !path.isAbsolute(profile)) fail('Copilot requires an absolute profile directory');
    this.directory = path.join(profile, 'copilot-conversations'); this.io = io; this.now = now; this.publishNew = publishNew;
    this.queue = Promise.resolve(); this.pendingOperations = 0; this.cleanup = new Map(); this.handles = new Set(); this.activeTurns = new Set(); this.activeActions = new Set(); this.reservations = new Map(); this.closing = null;
  }
  get hasOwnership() { return this.pendingOperations > 0 || this.cleanup.size > 0 || this.handles.size > 0 || this.activeTurns.size > 0 || this.activeActions.size > 0; }
  get hasPendingCleanup() { return this.cleanup.size > 0 || this.handles.size > 0; }
  serialize(fn) {
    if (this.closing) fail('Copilot storage is closing', 'COPILOT_CLOSING');
    this.pendingOperations++; const result = this.queue.then(fn).finally(() => this.pendingOperations--); this.queue = result.catch(() => {}); return result;
  }
  time() { return new Date(this.now()).toISOString(); }
  file(id) { return path.join(this.directory, uuid(id) + '.json'); }
  async ready() {
    await this.io.mkdir(this.directory, { recursive: true }); const stat = await this.io.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Copilot storage must be a real directory');
    this.directory = await this.io.realpath(this.directory); await this.retryCleanup();
  }
  async retryCleanup() {
    for (const handle of this.handles) { try { await handle.close(); this.handles.delete(handle); } catch {} }
    for (const [file, owned] of this.cleanup) {
      try {
        if (owned.handle) { owned.stat ||= await owned.handle.stat(); await owned.handle.close(); owned.handle = null; }
        const stat = await this.io.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.ino || stat.dev !== owned.stat.dev || stat.ino !== owned.stat.ino) continue;
        await this.io.unlink(file); this.cleanup.delete(file);
      } catch (error) { if (error.code === 'ENOENT') this.cleanup.delete(file); }
    }
  }
  async closeHandle(handle) { await handle.close(); this.handles.delete(handle); }
  async entries() {
    if (this.cleanup.size + this.handles.size > LIMITS.conversations) fail('Copilot cleanup must finish before opening more files', 'COPILOT_CLEANUP');
    const handle = await this.io.opendir(this.directory, { bufferSize: 32 }); this.handles.add(handle); const names = [];
    try { for (;;) { const item = await handle.read(); if (!item) break; names.push(item.name); if (names.length > LIMITS.conversations * 2) fail('Copilot directory entry limit reached', 'COPILOT_LIMIT'); } }
    finally { await this.closeHandle(handle); }
    return names.sort();
  }
  async regular(file) { const stat = await this.io.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.recordBytes) fail('Conversation must be a bounded regular file'); return stat; }
  async read(id) {
    const file = this.file(id), stat = await this.regular(file), handle = await this.io.open(file, 'r'); this.handles.add(handle);
    try {
      const opened = await handle.stat(); if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail('Conversation changed while opening', 'COPILOT_CONFLICT');
      const buffer = Buffer.alloc(stat.size + 1); let count = 0;
      while (count < buffer.length) { const part = await handle.read(buffer, count, buffer.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
      const after = await handle.stat(); if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== opened.mtimeMs) fail('Conversation changed while reading', 'COPILOT_CONFLICT');
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))); } catch { fail('Conversation JSON could not be read'); }
      return validateRecord(value, id);
    } finally { await this.closeHandle(handle); }
  }
  async capacity(id, bytes, reserve = 0) {
    const names = await this.entries(); let total = bytes + reserve, count = 0;
    for (const file of names) {
      if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) continue;
      count++; const other = file.slice(0, -5); if (other === id) continue;
      total += (await this.regular(this.file(other))).size + (this.reservations.get(other) || 0);
      if (total > LIMITS.libraryBytes) fail('Copilot library reached its 32 MiB limit; remove an old conversation', 'COPILOT_LIMIT');
    }
    if (!names.includes(id + '.json') && count >= LIMITS.conversations || total > LIMITS.libraryBytes || bytes + reserve > LIMITS.recordBytes) fail('Copilot storage capacity reached; start or remove a conversation', 'COPILOT_LIMIT');
  }
  async publish(value, initial = false, reserve = 0) {
    validateRecord(value); const data = json(value); await this.capacity(value.id, Buffer.byteLength(data), reserve);
    const target = this.file(value.id), temp = path.join(this.directory, '.copilot-' + crypto.randomUUID() + '.tmp');
    const owned = { handle: null, stat: null }; let created = false;
    try {
      owned.handle = await this.io.open(temp, 'wx', 0o600); created = true; this.cleanup.set(temp, owned); owned.stat = await owned.handle.stat();
      await owned.handle.writeFile(data, 'utf8'); await owned.handle.sync(); const sourceVersion = await owned.handle.stat({ bigint: true }); await owned.handle.close(); owned.handle = null;
      if (initial) { if (await this.publishNew(this.io, temp, target, sourceVersion)) { created = false; this.cleanup.delete(temp); } }
      else { await this.replaceOwned(temp, target, owned.stat); created = false; this.cleanup.delete(temp); }
    } finally {
      if (owned.handle) { try { owned.stat ||= await owned.handle.stat(); await owned.handle.close(); owned.handle = null; } catch {} }
      if (created && !owned.handle) { try { const stat = await this.io.lstat(temp); if (stat.dev === owned.stat.dev && stat.ino === owned.stat.ino && stat.isFile() && !stat.isSymbolicLink()) { await this.io.unlink(temp); this.cleanup.delete(temp); } } catch {} }
    }
    return clone(value);
  }
  async replaceOwned(temp, target, owned) {
    const previous = await this.regular(target);
    for (let attempt = 0; ; attempt++) {
      const current = await this.regular(target), candidate = await this.regular(temp);
      if (!owned.ino || candidate.dev !== owned.dev || candidate.ino !== owned.ino || !previous.ino || current.dev !== previous.dev || current.ino !== previous.ino || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) fail('Conversation changed during atomic replacement; reopen it before retrying', 'COPILOT_CONFLICT');
      try { await this.io.rename(temp, target); return; }
      catch (error) {
        // Real Electron tests observe transient Windows sharing errors even
        // after our handles close. Retry only the same verified two files.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  }
  async recover(value) {
    const interrupted = value.turns.filter(t => t.status === 'pending' && !this.activeTurns.has(t.id));
    const unknown = value.actions.filter(a => a.status === 'pending' && !this.activeActions.has(a.id));
    if (interrupted.length || unknown.length) {
      for (const turn of interrupted) { turn.status = 'interrupted'; turn.completedAt = this.time(); turn.error = 'KonX closed before this request finished. It was not sent again.'; }
      for (const action of unknown) { action.status = 'unknown'; action.completedAt = this.time(); action.error = 'KonX closed before this action outcome was saved. The effect may have occurred. It was not repeated.'; }
      value.revision++; value.updatedAt = this.time(); return this.publish(value);
    }
    return value;
  }
  list() { return this.serialize(async () => {
    await this.ready(); const conversations = [], issues = []; let bytes = 0;
    for (const name of await this.entries()) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) { if (!name.startsWith('.copilot-')) issues.push({ code: 'COPILOT_UNKNOWN_ENTRY', message: 'An unrecognized entry was not loaded.' }); continue; }
      const id = name.slice(0, -5);
      try {
        bytes += (await this.regular(this.file(id))).size; if (bytes > LIMITS.libraryBytes || conversations.length >= LIMITS.conversations) fail('Conversation listing limit reached', 'COPILOT_LIMIT');
        const value = await this.recover(await this.read(id)); conversations.push({ id, name: value.name, revision: value.revision, updatedAt: value.updatedAt, turnCount: value.turns.length, attachmentCount: value.attachments.length });
      } catch (error) { issues.push({ id, code: error.code?.startsWith('COPILOT_') ? error.code : 'COPILOT_READ', message: error.code?.startsWith('COPILOT_') ? error.message : 'Conversation could not be read.' }); }
    }
    conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return { conversations, issues, limits: { ...LIMITS } };
  }); }
  get(id) { uuid(id); return this.serialize(async () => { await this.ready(); return clone(await this.recover(await this.read(id))); }); }
  create(input) {
    object(input, ['name']); const name = text(input.name, 256, 'Conversation name', false).trim();
    return this.serialize(async () => { await this.ready(); const now = this.time(); return this.publish({ schemaVersion: 1, kind: 'konx-copilot-conversation', id: crypto.randomUUID(), revision: 1, name, createdAt: now, updatedAt: now, attachments: [], turns: [], actions: [] }, true); });
  }
  mutate(id, expected, fn, { pending = false, reserve = 0 } = {}) {
    uuid(id); revision(expected);
    return this.serialize(async () => { await this.ready(); const value = await this.recover(await this.read(id));
      if (value.revision !== expected) fail('Conversation changed; reopen it and review again', 'COPILOT_CONFLICT');
      if (!pending && (value.turns.some(t => t.status === 'pending') || value.actions.some(a => a.status === 'pending'))) fail('Wait for this conversation’s request or reviewed action to finish', 'COPILOT_BUSY');
      if (value.revision >= Number.MAX_SAFE_INTEGER) fail('Conversation revision limit reached', 'COPILOT_LIMIT');
      fn(value); value.revision++; value.updatedAt = this.time(); return this.publish(value, false, reserve);
    });
  }
  rename(id, expected, name) { text(name, 256, 'Conversation name', false); return this.mutate(id, expected, value => { value.name = name.trim(); }); }
  attach(id, expected, snapshot) { const safe = normalizeSnapshot(snapshot); return this.mutate(id, expected, value => { if (value.attachments.length >= LIMITS.attachments) fail('Remove an attachment before adding another', 'COPILOT_LIMIT'); value.attachments.push({ id: crypto.randomUUID(), revision: 1, createdAt: this.time(), snapshot: safe }); }); }
  detach(id, expected, attachmentId) { uuid(attachmentId); return this.mutate(id, expected, value => { if (!value.attachments.some(a => a.id === attachmentId)) fail('Attachment was not found'); value.attachments = value.attachments.filter(a => a.id !== attachmentId); }); }
  remove(id, expected) { uuid(id); revision(expected); return this.serialize(async () => {
    await this.ready(); const value = await this.recover(await this.read(id)); if (value.revision !== expected) fail('Conversation changed; reopen it before removing', 'COPILOT_CONFLICT');
    if (value.turns.some(t => t.status === 'pending') || value.actions.some(a => a.status === 'pending')) fail('Stop the request or reviewed action before removing this conversation', 'COPILOT_BUSY');
    await this.regular(this.file(id)); await this.io.unlink(this.file(id)); return { removed: id };
  }); }
  beginTurn(id, expected, input) {
    validateTurn(input); if (input.status !== 'pending') fail('New turn must be pending');
    return this.mutate(id, expected, value => { if (value.turns.length >= LIMITS.turns) fail('Start a new conversation; this one reached its turn limit', 'COPILOT_LIMIT'); value.turns.push(clone(input)); }, { reserve: LIMITS.completionReserve }).then(value => {
      this.activeTurns.add(input.id); this.reservations.set(id, LIMITS.completionReserve); return value;
    });
  }
  finishTurn(id, turnId, outcome) {
    uuid(id); uuid(turnId); object(outcome, ['status', 'answer', 'usage', 'limitations', 'error']);
    return this.serialize(async () => {
      await this.ready(); const value = await this.read(id), turn = value.turns.find(t => t.id === turnId);
      if (!turn || turn.status !== 'pending' || !this.activeTurns.has(turnId)) fail('Pending conversation turn was not found', 'COPILOT_CONFLICT');
      if (!['complete', 'cancelled', 'failed'].includes(outcome.status)) fail('Invalid final turn state');
      Object.assign(turn, clone(outcome), { completedAt: this.time() }); validateTurn(turn); value.revision++; value.updatedAt = this.time();
      const result = await this.publish(value); this.activeTurns.delete(turnId); this.reservations.delete(id); return result;
    });
  }
  beginAction(id, expected, input) {
    validateAction(input); if (input.status !== 'pending') fail('A new reviewed action must be pending');
    return this.mutate(id, expected, value => {
      if (value.actions.length >= ACTION_LIMITS.actions) fail('Start a new conversation; this one reached its reviewed-action limit', 'COPILOT_LIMIT');
      value.actions.push(clone(input));
    }, { reserve: ACTION_LIMITS.outcomeReserve }).then(value => { this.activeActions.add(input.id); this.reservations.set(id, ACTION_LIMITS.outcomeReserve); return value; });
  }
  finishAction(id, actionId, outcome) {
    uuid(id); uuid(actionId); object(outcome, ['status', 'result', 'error']);
    return this.serialize(async () => {
      await this.ready(); const value = await this.read(id), action = value.actions.find(a => a.id === actionId);
      if (!action || action.status !== 'pending' || !this.activeActions.has(actionId)) fail('Pending reviewed action was not found', 'COPILOT_CONFLICT');
      if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(outcome.status)) fail('Invalid final action state');
      Object.assign(action, clone(outcome), { completedAt: this.time() }); validateAction(action); value.revision++; value.updatedAt = this.time();
      const result = await this.publish(value); this.activeActions.delete(actionId); this.reservations.delete(id); return result;
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.queue.then(async () => { await this.retryCleanup(); if (this.hasOwnership) fail('Copilot cleanup or a request outcome is still pending; retry closing', 'COPILOT_CLEANUP'); }).finally(() => { this.closing = null; }); return this.closing;
  }
}

module.exports = { CopilotStore, LIMITS, KINDS, normalizeSnapshot, validateRecord, emptyUsage, object, text, uuid, revision, ids, json, boundedData, fail };
