'use strict';

const crypto = require('node:crypto');
const { LIMITS, normalizeSnapshot, emptyUsage, object, text, uuid, revision, ids, boundedData, fail } = require('./copilot-store');
const { checkCancelled } = require('./security/common');
const clone = value => structuredClone(value);

class CopilotService {
  constructor({ store, ai, now = () => Date.now() }) {
    if (!store || !ai || typeof ai.prepareConversation !== 'function') throw new TypeError('KonX-AI requires its store and AI transport owner');
    this.store = store; this.ai = ai; this.now = now; this.preparations = new Map(); this.preparing = new Set(); this.running = new Set(); this.finalizations = new Map(); this.lastTest = null; this.closing = null;
  }
  get hasOwnership() { return this.preparing.size > 0 || this.running.size > 0 || this.finalizations.size > 0 || this.store.hasOwnership; }
  get hasPendingCleanup() { return this.finalizations.size > 0 || this.store.hasPendingCleanup; }
  ready() { if (this.closing) fail('KonX-AI is closing; wait before starting another operation', 'COPILOT_CLOSING'); }
  status() { return { config: this.ai.getConfig(), capabilities: this.ai.copilotCapabilities(), lastTest: clone(this.lastTest) }; }
  list() { this.ready(); return this.store.list(); }
  get(id) { this.ready(); return this.store.get(id); }
  create(input) { this.ready(); object(input, ['name']); return this.store.create({ name: this.ai.redactor()(text(input.name, 256, 'Conversation name', false)) }); }
  rename(id, expected, name) { this.ready(); return this.store.rename(id, expected, this.ai.redactor()(text(name, 256, 'Conversation name', false))); }
  remove(id, expected) { this.ready(); return this.store.remove(id, expected); }
  attach(id, expected, snapshot) {
    this.ready(); normalizeSnapshot(snapshot); const safe = normalizeSnapshot(boundedData(snapshot, this.ai.redactor()));
    return this.store.attach(id, expected, safe);
  }
  detach(id, expected, attachmentId) { this.ready(); return this.store.detach(id, expected, attachmentId); }
  discardPrepared(id) { uuid(id); return { discarded: this.preparations.delete(id) }; }
  purge() { for (const [id, entry] of this.preparations) if (entry.expires <= this.now()) this.preparations.delete(id); }
  async preparingOperation(fn) {
    this.ready(); this.purge();
    if (this.preparations.size + this.preparing.size >= LIMITS.preparations) fail('Close an unused request preview before preparing another', 'COPILOT_LIMIT');
    const signal = { stopped: false, onStop: null }; let settled;
    const operation = { signal, done: new Promise(resolve => { settled = resolve; }) }; this.preparing.add(operation);
    try { return await fn(signal); } finally { this.preparing.delete(operation); settled(); }
  }
  retain(prepared, details) {
    this.ready(); const preparationId = crypto.randomUUID(), expires = this.now() + LIMITS.preparationMs;
    const digest = crypto.createHash('sha256').update(JSON.stringify({ endpoint: prepared.endpoint, providerRevision: prepared.providerRevision, conversationId: details.conversationId, conversationRevision: details.conversationRevision })).update('\n').update(prepared.body, 'utf8').digest('hex');
    const preview = { preparationId, digest, expiresAt: new Date(expires).toISOString(), ...details, providerRevision: prepared.providerRevision,
      provider: prepared.provider, model: prepared.model, mode: prepared.mode, endpoint: prepared.endpoint, body: prepared.body, question: prepared.question,
      references: clone(prepared.references), evidence: clone(prepared.evidence), limitations: clone(prepared.limitations), bytes: Buffer.byteLength(prepared.body) };
    this.preparations.set(preparationId, { prepared, preview, expires }); return clone(preview);
  }
  prepare(input) {
    object(input, ['conversationId', 'revision', 'question', 'attachmentIds', 'historyTurnIds', 'includeKnowledge', 'stream']);
    uuid(input.conversationId); revision(input.revision); text(input.question, LIMITS.questionChars, 'Question', false);
    const attachmentIds = ids(input.attachmentIds, LIMITS.selectedAttachments, 'attachment selection'), historyTurnIds = ids(input.historyTurnIds, LIMITS.historyTurns, 'history selection');
    for (const key of ['includeKnowledge', 'stream']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('Invalid request option');
    return this.preparingOperation(async signal => {
      const value = await this.store.get(input.conversationId);
      if (value.revision !== input.revision || value.turns.some(t => t.status === 'pending')) fail('Conversation changed or has an active request; review it again', 'COPILOT_CONFLICT');
      const evidence = attachmentIds.map(id => { const item = value.attachments.find(a => a.id === id); if (!item) fail('A selected attachment is no longer available'); return item; });
      const history = historyTurnIds.map(id => { const turn = value.turns.find(t => t.id === id); if (!turn || turn.status !== 'complete') fail('Only completed turns can be selected as conversation history');
        return { id: turn.id, question: turn.question, answer: turn.answer, citations: turn.request.references.map(({ id: sourceId, citation, title, sourceUrl }) => ({ id: sourceId, citation, title, sourceUrl })) };
      });
      const prepared = await this.ai.prepareConversation({ revision: this.ai.getConfig().revision, question: input.question, history, evidence, includeKnowledge: input.includeKnowledge === true, stream: input.stream !== false }, signal);
      checkCancelled(signal);
      const current = await this.store.get(input.conversationId); if (current.revision !== value.revision) fail('Conversation changed while preparing; review it again', 'COPILOT_CONFLICT');
      return this.retain(prepared, { conversationId: value.id, conversationRevision: value.revision, attachmentIds, historyTurnIds });
    });
  }
  prepareTest(input = {}) {
    object(input, ['providerRevision', 'stream']); if (typeof input.providerRevision !== 'string' || input.providerRevision !== this.ai.getConfig().revision) fail('Provider settings changed; review them before testing', 'COPILOT_CONFLICT');
    if (input.stream !== undefined && typeof input.stream !== 'boolean') fail('Invalid test mode');
    return this.preparingOperation(async signal => {
      const prepared = await this.ai.prepareConversation({ revision: input.providerRevision, question: 'Reply with OK.', test: true, includeKnowledge: false, stream: input.stream !== false }, signal);
      checkCancelled(signal); return this.retain(prepared, { conversationId: null, conversationRevision: null, attachmentIds: [], historyTurnIds: [] });
    });
  }
  async finalize(key, emit) {
    const pending = this.finalizations.get(key); if (!pending) return null;
    let value;
    try { value = await this.store.finishTurn(pending.conversationId, pending.turnId, pending.outcome); }
    catch { fail('The request finished, but its outcome could not be saved. KonX-AI retains it for cleanup retry; do not repeat the request.', 'COPILOT_CLEANUP'); }
    this.finalizations.delete(key); const report = { conversationId: value.id, conversationRevision: value.revision, turn: value.turns.find(t => t.id === pending.turnId) };
    emit?.('report', clone(report)); return report;
  }
  async run(params, emit, signal = {}) {
    this.ready(); object(params, ['preparationId', 'digest']); uuid(params.preparationId); text(params.digest, 64, 'Reviewed digest', false);
    const entry = this.preparations.get(params.preparationId); this.preparations.delete(params.preparationId);
    if (!entry || entry.expires <= this.now() || params.digest !== entry.preview.digest) fail('This request preview expired, changed or was already used. Prepare it again.', 'COPILOT_CONFLICT');
    if (entry.preview.providerRevision !== this.ai.getConfig().revision) fail('Provider settings changed; prepare the request again', 'COPILOT_CONFLICT');
    const { prepared, preview } = entry; checkCancelled(signal);
    let settled; const run = { signal, done: new Promise(resolve => { settled = resolve; }) }; this.running.add(run); let pending = null;
    try {
      if (preview.conversationId) {
        const turn = { id: crypto.randomUUID(), status: 'pending', createdAt: new Date(this.now()).toISOString(), completedAt: null, question: prepared.question,
          attachmentIds: preview.attachmentIds, historyTurnIds: preview.historyTurnIds,
          request: { digest: preview.digest, provider: prepared.provider, model: prepared.model, providerRevision: prepared.providerRevision, body: prepared.body, endpoint: prepared.endpoint, references: clone(prepared.references), evidence: clone(prepared.evidence) },
          answer: '', usage: emptyUsage(), limitations: [], error: '' };
        await this.store.beginTurn(preview.conversationId, preview.conversationRevision, turn);
        pending = { conversationId: preview.conversationId, turnId: turn.id, outcome: null };
      }
      let result, failure;
      try { checkCancelled(signal); result = await this.ai.executePrepared(prepared, emit, signal); }
      catch (error) { failure = error; }
      if (!pending) {
        this.lastTest = { ok: !failure, provider: prepared.provider, model: prepared.model, providerRevision: prepared.providerRevision, checkedAt: new Date(this.now()).toISOString(), usage: result?.usage || emptyUsage(), error: failure ? signal.stopped ? 'Provider test cancelled.' : 'Provider test did not complete. Review settings or choose buffered mode.' : '' };
        emit('report', { conversationId: null, conversationRevision: null, turn: null, providerTest: clone(this.lastTest) }); if (failure) throw failure;
        return { providerTest: clone(this.lastTest) };
      }
      pending.outcome = result ? { status: 'complete', answer: result.answer, usage: result.usage, limitations: result.limitations, error: '' } :
        { status: signal.stopped ? 'cancelled' : 'failed', answer: '', usage: emptyUsage(), limitations: [], error: signal.stopped ? 'The request was cancelled. It was not retried.' : 'The provider request did not complete. Review the cause before preparing another request.' };
      this.finalizations.set(pending.turnId, pending); const report = await this.finalize(pending.turnId, emit);
      if (failure) throw failure; return report;
    } finally { this.running.delete(run); settled(); }
  }
  close() {
    if (this.closing) return this.closing;
    this.preparations.clear();
    for (const { signal } of this.preparing) { signal.stopped = true; signal.onStop?.(); }
    for (const { signal } of this.running) { signal.stopped = true; signal.onStop?.(); }
    this.closing = Promise.resolve().then(async () => {
      await Promise.all([...this.preparing, ...this.running].map(operation => operation.done));
      for (const key of this.finalizations.keys()) await this.finalize(key);
      await this.store.close();
    }).finally(() => { this.closing = null; }); return this.closing;
  }
}
module.exports = { CopilotService };
