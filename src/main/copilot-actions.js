'use strict';
const crypto = require('node:crypto');
const { ACTION_LIMITS, digest, fail, object, text, id, hash, integer, editorTarget, normalizeParams, parseActionCandidates } = require('./copilot-action-schema');
const clone = value => structuredClone(value);
const turnDigest = turn => digest(JSON.stringify({ id: turn.id, answer: turn.answer, question: turn.question, requestDigest: turn.request.digest, references: turn.request.references }));
function onStop(signal, callback) {
  const previous = signal.onStop, listener = () => { try { previous?.(); } finally { callback(); } }; signal.onStop = listener;
  if (signal.stopped) callback(); return () => { if (signal.onStop === listener) signal.onStop = previous; };
}
function safeObservation(value) {
  let count = 0;
  function visit(item, depth) {
    if (++count > 2000 || depth > 8) throw new Error('Observation bounds');
    if (item === undefined) return null;
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.length <= 16000) return item;
    if (Array.isArray(item) && item.length <= 1000) return item.map(v => visit(v, depth + 1));
    if (!item || typeof item !== 'object' || Array.isArray(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Observation type');
    const out = {};
    for (const [key, v] of Object.entries(item)) { if (key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Observation key'); out[key] = visit(v, depth + 1); }
    return out;
  }
  return visit(value, 0);
}

class CopilotActions {
  constructor({ store, knowledge, diagnostics, requestEditor, now = () => Date.now(), editorTimeoutMs = ACTION_LIMITS.editorMs }) {
    if (!store || typeof store.beginAction !== 'function' || !knowledge || typeof knowledge.save !== 'function' || typeof knowledge.prepareArticle !== 'function' || !diagnostics || typeof requestEditor !== 'function') throw new TypeError('Reviewed actions require their store, knowledge, diagnostic and editor owners');
    this.store = store; this.knowledge = knowledge; this.diagnostics = diagnostics; this.requestEditor = requestEditor; this.now = now; this.editorTimeoutMs = editorTimeoutMs;
    this.prepared = new Map(); this.editors = new Map(); this.operations = new Set(); this.preparing = new Set(); this.finalizations = new Map(); this.closing = null;
  }
  get hasOwnership() { return this.operations.size > 0 || this.preparing.size > 0 || this.editors.size > 0 || this.finalizations.size > 0; }
  get hasPendingCleanup() { return this.finalizations.size > 0; }
  ready() { if (this.closing) fail('Reviewed actions are closing; wait before starting another', 'COPILOT_ACTION_CLOSING'); }
  async source(input) {
    id(input.conversationId); integer(input.revision, 1, Number.MAX_SAFE_INTEGER); id(input.turnId);
    const conversation = await this.store.get(input.conversationId), turn = conversation.turns.find(t => t.id === input.turnId);
    if (conversation.revision !== input.revision || !turn || turn.status !== 'complete' || conversation.turns.some(t => t.status === 'pending') || conversation.actions.some(a => a.status === 'pending')) fail('Conversation or source answer changed; review the completed answer again', 'COPILOT_ACTION_STALE');
    return { conversation, turn };
  }
  async candidates(input) { this.ready(); object(input, ['conversationId', 'revision', 'turnId']); const { turn } = await this.source(input); return parseActionCandidates(turn.answer); }
  async prepare(input) {
    this.ready(); for (const [key, value] of this.prepared) if (value.expires <= this.now()) this.prepared.delete(key);
    if (this.preparing.size + this.prepared.size >= ACTION_LIMITS.preparations) fail('Close an unused action review before preparing another');
    let settled; const operation = { done: new Promise(resolve => { settled = resolve; }) }; this.preparing.add(operation);
    try { return await this._prepare(input); } finally { this.preparing.delete(operation); settled(); }
  }
  async _prepare(input) {
    this.ready(); object(input, ['conversationId', 'revision', 'turnId', 'kind', 'params', 'target']);
    for (const [key, value] of this.prepared) if (value.expires <= this.now()) this.prepared.delete(key);
    if (this.prepared.size >= ACTION_LIMITS.preparations) fail('Close an unused action review before preparing another');
    const { conversation, turn } = await this.source(input); this.ready();
    const params = normalizeParams(input.kind, input.params), source = { turnId: turn.id, turnDigest: turnDigest(turn), requestDigest: turn.request.digest, citations: clone(turn.request.references) };
    let target = null, effect = null, savedParams = clone(params), savedTarget = null, preview, limitations = ['This is a user-reviewed action, not authority granted by the AI answer.'];
    if (input.kind.startsWith('diagnostic.')) {
      if (input.target != null) fail('Diagnostics cannot target an arbitrary app object');
      preview = { title: `Run ${input.kind.slice(11)}`, effect: 'Send the displayed bounded diagnostic traffic from this KonX computer.', params };
      limitations.push('A hostname is resolved at execution and may resolve differently later. Actual observed addresses are retained.', 'Diagnostic completion is not proof of health. Missing observations remain unknown.', 'Execution is limited to two minutes; cancelled or limited runs retain partial observations.');
    } else if (input.kind === 'editor.replaceSelection') {
      target = editorTarget(input.target); if (params.replacement === target.beforeText) fail('The replacement is identical to the selection');
      savedParams = { replacementDigest: digest(params.replacement), replacementChars: params.replacement.length };
      const { beforeText, readOnly, savePending, ...descriptor } = target; savedTarget = { ...descriptor, beforeChars: beforeText.length };
      preview = { title: 'Replace the selected editor text', effect: 'Apply one undoable local editor edit. No file save or remote upload.', before: beforeText, replacement: params.replacement, target: savedTarget };
      limitations.push('The live model, version, selection and editability are rechecked immediately before the edit.', 'Text is compared using LF line breaks; the editor retains its document line-ending format.', 'The outcome is renderer-reported. A lost acknowledgment leaves the outcome unknown; it is never retried automatically.');
    } else {
      if (input.target != null) fail('A new local note cannot overwrite an existing target');
      const start = params.start ?? 0, end = params.end ?? turn.answer.length;
      if (start >= end || end > turn.answer.length || /[\uDC00-\uDFFF]/.test(turn.answer[start] || '') || /[\uDC00-\uDFFF]/.test(turn.answer[end] || '')) fail('Choose a nonempty complete-character excerpt from this answer');
      const footer = `\n\n---\nSaved from KonX-AI conversation ${conversation.id}, answer ${turn.id}.\nAI-generated interpretation; verify it against the cited source evidence.\n`;
      const content = turn.answer.slice(start, end) + footer; if (content.length > 32000) fail('This note exceeds 32,000 characters; choose a shorter answer excerpt');
      effect = await this.knowledge.prepareArticle({ title: params.title, content, vendor: 'KonX', sourceUrl: '', tags: ['konx-ai', 'reviewed-answer'] });
      savedParams = { title: effect.title, start, end, contentDigest: digest(effect.content), contentChars: effect.content.length };
      preview = { title: 'Save this answer as a new local note', effect: 'Create one new Knowledge library article; no existing article is replaced.', article: effect };
      limitations.push('This saves AI interpretation with provenance, not independently verified documentation.', 'If the save acknowledgment is lost, check the library before saving another copy.');
    }
    this.ready(); const preparationId = crypto.randomUUID(), expires = this.now() + ACTION_LIMITS.preparationMs;
    const body = { conversationId: conversation.id, conversationRevision: conversation.revision, source, kind: input.kind, params, target, effect };
    const prepared = { ...body, preparationId, digest: digest(JSON.stringify(body)), expires, savedParams, savedTarget, preview, limitations };
    this.prepared.set(preparationId, prepared);
    return clone({ preparationId, digest: prepared.digest, expiresAt: new Date(expires).toISOString(), conversationId: conversation.id, conversationRevision: conversation.revision, turnId: turn.id, kind: input.kind, params, target, preview, limitations });
  }
  discard(preparationId) { id(preparationId); return { discarded: this.prepared.delete(preparationId) }; }
  acknowledgeEditor(input) {
    object(input, ['operationId', 'nonce', 'status', 'afterVersion', 'afterDigest', 'message']); id(input.operationId); id(input.nonce);
    const owner = this.editors.get(input.operationId); if (!owner || owner.nonce !== input.nonce) return { accepted: false };
    if (input.status === 'rejected') { owner.finish({ status: 'failed', result: { provenance: 'renderer-reported', applied: false }, error: 'The editor rejected this stale, unavailable or noneditable target. Prepare a fresh selection.' }); return { accepted: true }; }
    if (input.status !== 'applied' || !Number.isSafeInteger(input.afterVersion) || input.afterVersion <= owner.version || input.afterDigest !== owner.expectedDigest) {
      owner.finish({ status: 'unknown', result: { provenance: 'renderer-reported', applied: null }, error: 'The editor acknowledgment did not establish the expected result. Check the document; the action was not repeated.' }); return { accepted: true };
    }
    owner.finish({ status: 'succeeded', result: { provenance: 'renderer-reported', applied: true, afterVersion: input.afterVersion, afterDigest: input.afterDigest, saved: false, uploaded: false }, error: '' }); return { accepted: true };
  }
  editor(prepared, actionId, signal) {
    return new Promise(resolve => {
      const operationId = crypto.randomUUID(), nonce = crypto.randomUUID(); let settled = false, dispatched = false, timer; let detach = () => {};
      const finish = outcome => { if (settled) return; settled = true; clearTimeout(timer); detach(); this.editors.delete(operationId); resolve(outcome); };
      const unknown = () => finish({ status: dispatched ? 'unknown' : 'cancelled', result: { provenance: 'renderer-reported', applied: dispatched ? null : false }, error: dispatched ? 'The editor acknowledgment was lost or cancelled. The edit may have applied; it was not repeated.' : 'Cancelled before editor dispatch.' });
      this.editors.set(operationId, { nonce, finish, version: prepared.target.versionId, expectedDigest: digest(prepared.params.replacement) });
      detach = onStop(signal, unknown); if (settled) { detach(); return; }
      timer = setTimeout(unknown, this.editorTimeoutMs);
      const request = { operationId, nonce, actionId, digest: prepared.digest, expiresAt: new Date(this.now() + this.editorTimeoutMs).toISOString(), target: clone(prepared.target), replacement: prepared.params.replacement };
      try { dispatched = true; const result = this.requestEditor(request); if (result === false) { dispatched = false; finish({ status: 'failed', result: null, error: 'The editor window was unavailable; nothing was dispatched.' }); }
        else if (result?.then) Promise.resolve(result).catch(unknown); }
      catch { unknown(); }
    });
  }
  async diagnostic(prepared, signal, emit) {
    const kind = prepared.kind.slice(11), runner = this.diagnostics[kind]; if (typeof runner !== 'function') fail('This diagnostic is unavailable');
    const controller = new AbortController(); let timedOut = false, observed = 0, omitted = 0, bytes = 0;
    const observations = [], detach = onStop(signal, () => controller.abort()), timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
    const retain = (type, data) => {
      observed++;
      try { const item = { type: text(type, 64), data: safeObservation(data) }, size = Buffer.byteLength(JSON.stringify(item));
        if (observations.length >= 256 || bytes + size > 80 * 1024) { omitted++; return; } bytes += size; observations.push(item);
      } catch { omitted++; }
    };
    let failure = false;
    try { if (controller.signal.aborted) throw new Error('Cancelled'); await runner(clone(prepared.params), retain, controller.signal); }
    catch { failure = true; }
    finally { clearTimeout(timer); detach(); }
    const stopped = signal.stopped || timedOut, complete = !stopped && !failure && omitted === 0;
    const result = { kind, params: clone(prepared.params), observations, coverage: { observed, retained: observations.length, complete }, limitations: [
      'These are observations from the KonX computer, not a health verdict.', ...(omitted ? [`${omitted} oversized or excess observations were omitted in full.`] : []), ...(!complete ? ['Collection is partial; missing observations remain unknown.'] : [])] };
    return { status: stopped ? 'cancelled' : failure ? 'failed' : 'succeeded', result, error: timedOut ? 'The two-minute diagnostic limit was reached; partial observations were retained.' : signal.stopped ? 'The diagnostic was cancelled; partial observations were retained.' : failure ? 'The diagnostic could not finish; retained observations may be partial.' : '' };
  }
  async finish(key, emit) {
    const entry = this.finalizations.get(key); let conversation;
    try { conversation = await this.store.finishAction(entry.conversationId, entry.actionId, entry.outcome); }
    catch { fail('The action finished but its outcome could not be saved. Cleanup retains the result; do not repeat the action.', 'COPILOT_ACTION_CLEANUP'); }
    this.finalizations.delete(key); const report = { conversationId: conversation.id, conversationRevision: conversation.revision, action: conversation.actions.find(a => a.id === entry.actionId) };
    emit?.('report', clone(report)); return report;
  }
  async run(input, emit, signal = {}) {
    this.ready(); object(input, ['preparationId', 'digest']); id(input.preparationId); hash(input.digest);
    const prepared = this.prepared.get(input.preparationId); this.prepared.delete(input.preparationId);
    if (!prepared || prepared.digest !== input.digest || prepared.expires <= this.now()) fail('Action review expired, changed or was already used', 'COPILOT_ACTION_STALE');
    if (signal.stopped) fail('Action cancelled before admission');
    let settled; const operation = { signal, done: new Promise(resolve => { settled = resolve; }) }; this.operations.add(operation);
    try {
      const { turn } = await this.source({ conversationId: prepared.conversationId, revision: prepared.conversationRevision, turnId: prepared.source.turnId });
      if (turnDigest(turn) !== prepared.source.turnDigest) fail('The source answer changed; review it again', 'COPILOT_ACTION_STALE');
      this.ready(); if (signal.stopped) fail('Action cancelled before admission');
      const action = { id: crypto.randomUUID(), kind: prepared.kind, status: 'pending', createdAt: new Date(this.now()).toISOString(), completedAt: null, source: clone(prepared.source),
        review: { digest: prepared.digest, params: clone(prepared.savedParams), target: clone(prepared.savedTarget), limitations: clone(prepared.limitations) }, result: null, error: '' };
      await this.store.beginAction(prepared.conversationId, prepared.conversationRevision, action);
      let outcome, dispatched = false;
      try {
      if (signal.stopped) outcome = { status: 'cancelled', result: null, error: 'Cancelled before the action was dispatched.' };
      else {
        emit('progress', { phase: 'executing', message: 'Executing only the reviewed action…' });
        dispatched = true;
        if (prepared.kind.startsWith('diagnostic.')) outcome = await this.diagnostic(prepared, signal, emit);
        else if (prepared.kind === 'editor.replaceSelection') outcome = await this.editor(prepared, action.id, signal);
        else {
          try { const article = await this.knowledge.save(clone(prepared.effect));
            const matches = Object.keys(prepared.effect).every(key => JSON.stringify(article[key]) === JSON.stringify(prepared.effect[key]));
            outcome = { status: matches ? 'succeeded' : 'unknown', result: { provenance: 'knowledge-store', articleId: text(article.id, 128), title: text(article.title, 160), contentDigest: digest(text(article.content, 32000)), created: true }, error: matches ? '' : 'The saved article differs from the reviewed text. Inspect it in the library; the action was not repeated.' }; }
          catch { outcome = { status: 'unknown', result: { provenance: 'knowledge-store', created: null }, error: 'The note save did not return a confirmed outcome. Check the library before creating another copy.' }; }
        }
      }
      } catch { outcome = { status: dispatched ? 'unknown' : 'failed', result: null, error: dispatched ? 'The action did not return a confirmed outcome. Check the target before repeating it.' : 'The action could not be dispatched; no effect was requested.' }; }
      const retained = { conversationId: prepared.conversationId, actionId: action.id, outcome }; this.finalizations.set(action.id, retained); return await this.finish(action.id, emit);
    } finally { this.operations.delete(operation); settled(); }
  }
  close() {
    if (this.closing) return this.closing; this.prepared.clear();
    for (const { signal } of this.operations) { signal.stopped = true; signal.onStop?.(); }
    this.closing = Promise.resolve().then(async () => { await Promise.all([...this.operations, ...this.preparing].map(op => op.done)); for (const key of this.finalizations.keys()) await this.finish(key); }).finally(() => { this.closing = null; }); return this.closing;
  }
}
module.exports = { CopilotActions, turnDigest };
