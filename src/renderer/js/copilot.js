import { h, icon, api, modal, toast, errMsg } from './ui.js';
import { captureCopilotContext, copilotContextSupport } from './copilot-context.mjs';
import { CopilotReviewedActions } from './copilot-actions.js';

const text = value => typeof value === 'string' ? value : '';
const when = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time'; };
const usageText = usage => {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'Unknown';
  return `Input tokens: ${count(usage?.inputTokens)} · Output tokens: ${count(usage?.outputTokens)} · Total: ${count(usage?.totalTokens)}`;
};
const selected = (values, ids) => values.filter(value => ids.has(value.id)).map(value => value.id);

/** One app-owned conversation/request owner; moving or hiding its view is passive. */
export class CopilotController {
  constructor(app) {
    this.app = app; this.id = 'copilot-controller'; this.title = 'KonX-AI'; this.icon = 'insight'; this.toolKind = 'copilot';
    this.conversations = []; this.conversation = null; this.provider = null; this.issues = []; this.limits = {};
    this.question = ''; this.includeKnowledge = false; this.stream = true;
    this.attachmentIds = new Set(); this.historyTurnIds = new Set(); this.draftBaseline = '';
    this.prepared = null; this.discardIds = new Set(); this.cleanupError = ''; this.generation = 0;
    this.changedSources = new Set();
    this.busy = false; this.prompting = false; this.jobId = null; this.jobSequence = 0; this.state = 'idle';
    this.message = 'Choose a conversation or start a new one. Nothing is sent automatically.';
    this.liveAnswer = ''; this.liveUsage = null; this.disposed = false; this.viewClosed = true;
    this.actions = new CopilotReviewedActions(this); this.panel = new CopilotPanel(this); this.draftBaseline = this.draftSignature();
  }

  draftSignature() { return JSON.stringify([this.question, [...this.attachmentIds], [...this.historyTurnIds], this.includeKnowledge, this.stream]); }
  hasUnsavedInput() { return this.draftSignature() !== this.draftBaseline || !!this.prepared || this.actions.hasDraft(); }
  updateBlockers() {
    return [...(this.jobId ? ['Wait for KonX-AI to finish or cancel its request.'] : []),
      ...(this.busy || this.prompting ? ['Wait for the KonX-AI operation to finish.'] : []),
      ...(this.hasUnsavedInput() ? ['Send or discard the unsent KonX-AI draft.'] : []),
      ...(this.discardIds.size ? ['Retry discarding the unused KonX-AI request review.'] : []), ...this.actions.updateBlockers()];
  }
  changed() {
    if (this.disposed) return;
    this.actions.conversationChanged(this.conversation);
    this.panel.render();
    if (this.app.active === this.panel) this.app.updateStatus?.(this.panel);
    this.app.workspaceLayout?.updateContext();
  }
  async operation(message, action) {
    if (this.disposed || this.busy || this.prompting || this.jobId || this.actions.locked) return null;
    this.busy = true; this.message = message; this.changed();
    try { return await action(); }
    catch (error) { if (!this.disposed) { this.message = errMsg(error); toast(this.message, 'err'); } return null; }
    finally { this.busy = false; this.changed(); }
  }
  async dialog(options) {
    if (this.disposed || this.prompting) return null;
    this.prompting = true; this.changed();
    try { return await modal({ ...options, onReady: control => { this.dialogControl = control; } }); }
    finally { this.dialogControl = null; this.prompting = false; this.changed(); }
  }
  async confirmDraft(message = 'Discard the unsent draft before changing conversations?') {
    if (!this.hasUnsavedInput()) return true;
    return await this.dialog({ title: 'Unsent KonX-AI draft', body: h('p', message),
      buttons: [{ label: 'Keep draft', value: null }, { label: 'Discard draft', value: true, danger: true }] }) === true && !this.disposed;
  }
  invalidate(message) {
    this.generation++;
    if (this.prepared) { this.discardIds.add(this.prepared.preparationId); this.prepared = null; void this.flushDiscard(); }
    if (message) this.message = message;
  }
  async flushDiscard() {
    if (this.discardPromise) return this.discardPromise;
    this.discardPromise = (async () => {
      while (this.discardIds.size) {
        const id = this.discardIds.values().next().value;
        try { await api.invoke('tools:copilotDiscardPrepared', id); this.discardIds.delete(id); }
        catch (error) { this.cleanupError = errMsg(error); this.changed(); return false; }
      }
      this.cleanupError = ''; this.changed(); return true;
    })();
    try { return await this.discardPromise; } finally { this.discardPromise = null; this.changed(); }
  }
  editQuestion(value) { this.question = value; this.invalidate('Draft changed. Prepare a new request to review it.'); this.changed(); }
  selectAttachment(id, checked) { checked ? this.attachmentIds.add(id) : this.attachmentIds.delete(id); this.invalidate('Evidence selection changed. Prepare a new request.'); this.changed(); }
  selectHistory(id, checked) { checked ? this.historyTurnIds.add(id) : this.historyTurnIds.delete(id); this.invalidate('Conversation selection changed. Prepare a new request.'); this.changed(); }
  selectKnowledge(checked) { this.includeKnowledge = checked; this.invalidate('Reference selection changed. Prepare a new request.'); this.changed(); }
  selectStream(enabled) { this.stream = enabled; this.invalidate('Response transport changed. Prepare a new request.'); this.changed(); }
  async refreshStatus() {
    const value = await api.invoke('tools:copilotStatus');
    if (this.disposed) return;
    if (this.prepared && value.config?.revision !== this.prepared.providerRevision) this.invalidate('AI connection changed. Prepare a new request before sending.');
    this.provider = value; this.changed();
  }
  async refreshList() {
    const value = await api.invoke('tools:copilotList');
    if (this.disposed) return;
    this.conversations = value.conversations || []; this.issues = value.issues || []; this.limits = value.limits || {}; this.changed();
  }
  async open({ sourceTab, snapshot, question } = {}) {
    if (this.disposed) throw new Error('KonX-AI has been disposed.');
    this.viewClosed = false; this.panel.disposed = false;
    if (sourceTab) this.focusedTabChanged(sourceTab);
    if ((this.busy || this.jobId || this.prompting || this.actions.locked) && (snapshot || typeof question === 'string')) {
      this.message = 'Finish or cancel the current operation before adding new evidence or replacing the question.'; this.changed(); return this.panel;
    }
    if (!this.busy && !this.jobId) await this.operation('Reading local conversations…', async () => { await this.refreshStatus(); await this.refreshList(); await this.flushDiscard(); });
    if (snapshot) await this.attach(snapshot);
    if (typeof question === 'string' && question !== this.question && (!this.question || await this.confirmDraft('Replace the current question with this new question?'))) this.editQuestion(question);
    this.changed(); return this.panel;
  }
  focusedTabChanged(tab) { if (tab && tab !== this.panel) this.focusedTab = tab; this.changed(); }
  sourceChanged(tab) {
    if (!tab) return;
    let changed = false;
    for (const item of this.conversation?.attachments || []) {
      const source = item.snapshot?.source;
      if (!this.changedSources.has(item.id) && source?.tabId === tab.id && (source.revision !== tab.copilot?.revision || source.runId !== tab.copilot?.runId)) {
        this.changedSources.add(item.id); changed = true;
      }
    }
    if (changed) this.changed();
  }
  applyConversation(value, { retainDraft = false } = {}) {
    this.conversation = value;
    if (!retainDraft) {
      this.question = ''; this.includeKnowledge = false;
      this.attachmentIds = new Set((value?.attachments || []).slice(-8).map(item => item.id));
      this.historyTurnIds = new Set((value?.turns || []).filter(item => item.status === 'complete').slice(-12).map(item => item.id));
      this.draftBaseline = this.draftSignature();
    } else {
      this.attachmentIds = new Set([...this.attachmentIds].filter(id => value?.attachments.some(item => item.id === id)));
      this.historyTurnIds = new Set([...this.historyTurnIds].filter(id => value?.turns.some(item => item.id === id && item.status === 'complete')));
    }
    this.changed();
  }
  async selectConversation(id) {
    if (this.busy || this.jobId || this.prompting || this.actions.locked || id === this.conversation?.id) return;
    if (!await this.confirmDraft()) { this.changed(); return; }
    this.invalidate();
    await this.operation('Opening conversation…', async () => {
      const value = id ? await api.invoke('tools:copilotGet', id) : null;
      this.applyConversation(value); this.message = 'Saved conversation opened locally. Review selections before preparing a request.';
    });
  }
  async nameDialog(title, initial) {
    const input = h('input.input', { value: initial, maxlength: 160, 'aria-label': 'Conversation name' });
    const result = await this.dialog({ title, body: h('label.field', h('span', 'Name'), input),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save name', value: true, primary: true }],
      onSubmit: value => value !== true || !!input.value.trim() });
    return result === true ? input.value.trim() : null;
  }
  async createConversation() {
    if (this.busy || this.jobId || this.prompting || this.actions.locked || !await this.confirmDraft()) return;
    const name = await this.nameDialog('New conversation', 'New conversation'); if (!name || this.disposed) return;
    this.invalidate();
    await this.operation('Creating conversation…', async () => {
      this.applyConversation(await api.invoke('tools:copilotCreate', { name })); await this.refreshList(); this.message = 'Conversation saved locally. Add a question or attach evidence.';
    });
  }
  async renameConversation() {
    if (!this.conversation || this.busy || this.jobId || this.prompting || this.actions.locked) return;
    const before = this.conversation, name = await this.nameDialog('Rename conversation', before.name); if (!name || this.disposed) return;
    this.invalidate();
    await this.operation('Renaming conversation…', async () => {
      this.applyConversation(await api.invoke('tools:copilotRename', before.id, before.revision, name), { retainDraft: true }); await this.refreshList(); this.message = 'Conversation renamed.';
    });
  }
  async removeConversation() {
    if (!this.conversation || this.busy || this.jobId || this.prompting || this.actions.locked) return;
    const before = this.conversation;
    const answer = await this.dialog({ title: 'Delete conversation', body: h('p', `Delete “${before.name}”, its saved replies and evidence? Any unsent draft in this conversation will also be discarded.`),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Delete conversation', value: true, danger: true }] });
    if (answer !== true || this.disposed) return;
    this.invalidate();
    await this.operation('Deleting conversation…', async () => {
      await api.invoke('tools:copilotRemove', before.id, before.revision); this.applyConversation(null); await this.refreshList(); this.message = 'Conversation deleted.';
    });
  }
  async attach(snapshot) {
    if (this.busy || this.jobId || this.prompting || this.actions.locked || this.disposed) return null;
    this.invalidate();
    return this.operation('Saving evidence snapshot…', async () => {
      if (!this.conversation) this.applyConversation(await api.invoke('tools:copilotCreate', { name: text(snapshot.title) || 'Evidence discussion' }));
      const previous = new Set(this.conversation.attachments.map(item => item.id));
      const value = await api.invoke('tools:copilotAttach', this.conversation.id, this.conversation.revision, snapshot);
      this.applyConversation(value, { retainDraft: true });
      for (const item of value.attachments) if (!previous.has(item.id) && this.attachmentIds.size < 8) this.attachmentIds.add(item.id);
      await this.refreshList(); this.message = 'Evidence saved locally. Select it below and prepare a request when ready.'; this.changed(); return value;
    });
  }
  async attachCurrentView(source = this.focusedTab) {
    if (this.busy || this.jobId || this.prompting || this.actions.locked || this.disposed || !source || source.disposed) return;
    try {
      const support = copilotContextSupport(source);
      if (!support.supported) throw new Error(support.reason);
      let options;
      if (source.copilotContextChoices) {
        const choices = source.copilotContextChoices();
        const available = choices.filter(item => !item.disabled);
        if (!available.length) throw new Error('Select evidence in the source view first.');
        const select = h('select.input', { 'aria-label': 'Evidence to attach' }, ...choices.map(item => h('option', { value: item.choice, disabled: !!item.disabled }, item.label)));
        select.value = available[0].choice;
        const confirmed = await this.dialog({ title: `Attach from ${source.title}`, body: h('label.field', h('span', 'Choose evidence from this view'), select),
          buttons: [{ label: 'Cancel', value: null }, { label: 'Attach evidence', value: true, primary: true }] });
        if (!confirmed || this.disposed || source.disposed) return;
        options = { choice: select.value };
      }
      await this.attach(captureCopilotContext(source, options));
    } catch (error) { this.message = errMsg(error); toast(this.message, 'err'); this.changed(); }
  }
  async detach(id) {
    if (!this.conversation || this.busy || this.jobId || this.prompting || this.actions.locked || this.disposed) return; this.invalidate();
    await this.operation('Removing attachment…', async () => {
      this.applyConversation(await api.invoke('tools:copilotDetach', this.conversation.id, this.conversation.revision, id), { retainDraft: true }); await this.refreshList(); this.message = 'Attachment removed. Past replies retain their original evidence.';
    });
  }
  async prepare(test = false) {
    if (this.busy || this.jobId || this.prompting || this.actions.locked) return;
    if (!test && (!this.conversation || !this.question.trim())) return;
    this.invalidate(); const generation = this.generation;
    await this.operation(test ? 'Preparing connection test for review…' : 'Preparing the exact request for review…', async () => {
      if (!await this.flushDiscard()) throw new Error('The previous request review could not be discarded. Retry cleanup first.');
      await this.refreshStatus();
      const value = await api.invoke(test ? 'tools:copilotPrepareTest' : 'tools:copilotPrepare', test ? { providerRevision: this.provider.config.revision, stream: this.stream } : {
        conversationId: this.conversation.id, revision: this.conversation.revision, question: this.question,
        attachmentIds: selected(this.conversation.attachments, this.attachmentIds), historyTurnIds: selected(this.conversation.turns, this.historyTurnIds),
        includeKnowledge: this.includeKnowledge, stream: this.stream,
      });
      if (this.disposed || generation !== this.generation) { this.discardIds.add(value.preparationId); await this.flushDiscard(); return; }
      this.prepared = value; this.message = 'Review the exact request below. It has not been sent.';
      this.changed(); this.panel.review.scrollIntoView({ block: 'nearest' });
    });
  }
  async send() {
    if (!this.prepared || this.busy || this.jobId || this.prompting || this.actions.locked || this.disposed) return;
    const prepared = this.prepared, generation = this.generation;
    await this.operation('Checking the reviewed request…', async () => {
      await this.refreshStatus();
      if (this.prepared !== prepared || generation !== this.generation) return;
      if (new Date(prepared.expiresAt).getTime() <= Date.now()) { this.invalidate('This review expired. Prepare a new request.'); return; }
      const id = this.panel.id + ':' + ++this.jobSequence;
      this.jobId = id; this.state = 'running'; this.cancelRequested = false; this.liveAnswer = ''; this.liveUsage = null;
      this.pendingQuestion = this.question; this.pendingConversationId = prepared.conversationId; this.completedTurn = null;
      this.prepared = null; this.app.registerJob(id, this); this.message = 'Request sent. Waiting for the provider; text appears after complete redaction.'; this.changed();
      this.app.tabStateChanged?.(this.panel);
      try { await api.invoke('tools:start', 'copilot', { preparationId: prepared.preparationId, digest: prepared.digest }, id); }
      catch (error) { if (this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
    });
  }
  async stop() {
    if (!this.jobId || this.cancelRequested) return;
    const id = this.jobId; this.cancelRequested = true; this.message = 'Cancelling the request…'; this.changed();
    try { await api.invoke('tools:stop', id); }
    catch (error) { if (this.jobId === id) { this.cancelRequested = false; this.message = errMsg(error); this.changed(); } }
  }
  onJobEvent(type, data = {}) {
    if (!this.jobId || this.disposed) return;
    if (type === 'progress') this.message = text(data.message) || text(data.phase) || 'Waiting for the provider…';
    if (type === 'delta' && !this.cancelRequested) this.liveAnswer += text(data.text);
    if (type === 'usage') this.liveUsage = data;
    if (type === 'report') {
      if (data.providerTest && this.provider) this.provider.lastTest = data.providerTest;
      if (data.turn && data.conversationId === this.conversation?.id) {
        this.completedTurn = data.turn;
        const turns = this.conversation.turns.filter(turn => turn.id !== data.turn.id);
        this.conversation = { ...this.conversation, revision: data.conversationRevision, turns: [...turns, data.turn] };
        this.liveAnswer = ''; this.liveUsage = null;
      }
    }
    if (type === 'done' || type === 'error') {
      if (this.completedTurn?.status === 'complete' && !this.cancelRequested && !this.viewClosed) {
        if (this.question === this.pendingQuestion) this.question = '';
        this.historyTurnIds.add(this.completedTurn.id);
        while (this.historyTurnIds.size > 12) this.historyTurnIds.delete(this.historyTurnIds.values().next().value);
        this.draftBaseline = this.draftSignature();
      }
      this.app.unregisterJob(this.jobId); this.jobId = null; this.state = 'idle';
      this.panel.state = 'idle'; this.app.tabStateChanged?.(this.panel);
      this.message = this.cancelRequested || data.stopped ? 'Request cancelled. The outcome is saved; no retry will run automatically.' : type === 'error' ? text(data.message) || 'Request failed. Your unsent question is retained.' : 'Reply saved. Review the evidence before acting on suggestions.';
      this.pendingQuestion = null; this.pendingConversationId = null;
      void this.refreshList().catch(error => { this.message = errMsg(error); this.changed(); });
    }
    this.changed();
  }
  async requestClose() {
    if (this.busy || this.prompting || this.actions.busy) { toast('Wait for the KonX-AI operation to finish.', 'err'); return false; }
    if (this.actions.jobId) return await this.dialog({ title: 'Close KonX-AI', body: h('p', 'Cancel the reviewed action and close? Any effect already applied remains; its outcome will be retained without automatic retry.'),
      buttons: [{ label: 'Keep open', value: null }, { label: 'Cancel action and close', value: true, danger: true }] }) === true;
    if (this.jobId) return await this.dialog({ title: 'Close KonX-AI', body: h('p', 'Cancel this request and discard the unsent draft? Saved conversations and evidence remain available.'),
      buttons: [{ label: 'Keep open', value: null }, { label: 'Cancel request and close', value: true, danger: true }] }) === true;
    if (!await this.confirmDraft('Discard this unsent draft and close KonX-AI? Saved conversations and evidence remain available.')) return false;
    this.invalidate(); this.actions.invalidate(); return await this.flushDiscard() && await this.actions.flushDiscard();
  }
  closeView() {
    this.actions.closeView();
    this.viewClosed = true; this.invalidate(); this.question = ''; this.draftBaseline = this.draftSignature(); this.dialogControl?.close(null);
    if (this.jobId) void this.stop(); this.changed();
  }
  focusSource(attachment) {
    const snapshot = attachment.snapshot, source = this.app.byId?.get(snapshot?.source?.tabId);
    if (!source || source.disposed) { this.message = 'The source view is no longer open. The saved snapshot is still available.'; this.changed(); return; }
    this.app.activate(source);
    const rows = snapshot?.facts?.rows, locator = Array.isArray(rows) && rows.length === 1 ? rows[0]?.locator : null;
    if (snapshot.source.revision !== source.copilot?.revision || snapshot.source.runId !== source.copilot?.runId) {
      this.changedSources.add(attachment.id);
      this.message = 'Opened the source view. Its observations have changed; the saved snapshot is unchanged and its old selection was not applied.';
    } else if (locator && typeof source.navigateCopilotSource === 'function') {
      this.message = source.navigateCopilotSource(locator) ? 'Opened the selected evidence in its source view.' : 'Opened the source view. This saved selection cannot be located; the snapshot remains available.';
    } else this.message = 'Opened the source view. The saved snapshot remains unchanged.';
    this.changed();
  }
  async dispose() {
    this.closeView(); await this.flushDiscard(); await this.actions.flushDiscard();
    // Root owns app shutdown and waits for registered jobs before destroying the
    // controller. Do not drop the final cancellation/report subscription early.
    if (this.jobId || this.busy || this.prompting || this.discardIds.size || this.actions.locked || this.actions.discards.size) return false;
    this.actions.disposed = true;
    this.disposed = true; this.panel.disposed = true; return true;
  }
}

/** Canonical tab-shaped view. It owns no provider subscriptions or duplicate jobs. */
export class CopilotPanel {
  constructor(controller) {
    this.controller = controller; this.app = controller.app; this.kind = 'tool'; this.toolKind = 'copilot'; this.id = 'copilot-panel';
    this.title = 'KonX-AI'; this.icon = 'insight'; this.state = 'idle'; this.disposed = false;
    this.conversationSelect = h('select.input', { 'aria-label': 'KonX-AI conversation', onchange: () => controller.selectConversation(this.conversationSelect.value) });
    this.newButton = h('button.btn.sm', { title: 'New conversation', onclick: () => controller.createConversation() }, icon('plus'), 'New');
    this.renameButton = h('button.btn.sm', { title: 'Rename conversation', onclick: () => controller.renameConversation() }, icon('edit'));
    this.deleteButton = h('button.btn.sm', { title: 'Delete conversation', onclick: () => controller.removeConversation() }, icon('trash'));
    this.settingsButton = h('button.btn.sm', { onclick: () => this.app.openTool('ai') }, icon('settings'), 'KonX-AI Settings & Library');
    this.providerStatus = h('div.copilot-provider', { role: 'status' });
    this.transportSelect = h('select.input', { 'aria-label': 'KonX-AI response transport', onchange: () => controller.selectStream(this.transportSelect.value === 'stream') },
      h('option', { value: 'stream' }, 'Stream when supported'), h('option', { value: 'buffered' }, 'Buffered response'));
    this.transportHint = h('p.hint');
    this.testButton = h('button.btn.sm', { onclick: () => controller.prepare(true) }, 'Review a connection test');
    this.connectionDetails = h('details', h('summary', 'Connection options'), h('label.field', h('span', 'Response transport'), this.transportSelect), this.transportHint, this.testButton);
    this.focusStatus = h('p.hint.copilot-focus'); this.issues = h('div.copilot-issues', { role: 'status' });
    this.attachButton = h('button.btn.sm', { onclick: () => controller.attachCurrentView() }, icon('plus'), 'Attach from current view');
    this.evidence = h('div.copilot-evidence');
    this.evidenceDetails = h('details', h('summary', 'Attached evidence'), h('p.hint', 'Saved snapshots only. Select what to include in the next request.'), this.evidence);
    this.savedTurns = h('div.copilot-saved-turns'); this.pendingTurn = h('article.copilot-turn.copilot-pending.hidden');
    this.turns = h('div.copilot-turns', { 'aria-label': 'Conversation replies' }, this.savedTurns, this.pendingTurn);
    this.history = h('div.copilot-history');
    this.historyDetails = h('details', h('summary', 'Previous replies included'), this.history);
    this.question = h('textarea.input', { rows: 4, placeholder: 'Ask about the selected evidence…', 'aria-label': 'KonX-AI question', oninput: () => controller.editQuestion(this.question.value) });
    this.knowledge = h('input', { type: 'checkbox', 'aria-label': 'Include local knowledge references', onchange: () => controller.selectKnowledge(this.knowledge.checked) });
    this.prepareButton = h('button.btn.primary', { onclick: () => controller.prepare() }, icon('eye'), 'Prepare request');
    this.cancelButton = h('button.btn.sm', { onclick: () => controller.stop() }, icon('stop'), 'Cancel request');
    this.status = h('div.copilot-status', { role: 'status', 'aria-live': 'polite' });
    this.cleanupButton = h('button.btn.sm', { onclick: () => controller.flushDiscard() }, 'Retry cleanup');
    this.reviewMeta = h('div.copilot-review-meta'); this.reviewLimitations = h('ul.copilot-limitations');
    this.requestBody = h('pre.copilot-request', { tabindex: 0, 'aria-label': 'Exact provider request body' });
    this.sendButton = h('button.btn.primary', { onclick: () => controller.send() }, icon('send'), 'Send reviewed request');
    this.discardButton = h('button.btn.sm', { onclick: () => { controller.invalidate('Review discarded. The question and selections are retained.'); controller.changed(); } }, 'Discard review');
    this.review = h('section.copilot-review.hidden', { 'aria-label': 'Review before sending' }, h('h3', 'Review before sending'), this.reviewMeta,
      h('p.hint', 'This is the complete request body, including system instructions, selected history, evidence and any library excerpts. Authentication headers are excluded.'),
      this.reviewLimitations, this.requestBody, h('div.copilot-actions', this.sendButton, this.discardButton));
    this.el = h('div.view.copilot-view', h('div.copilot-header', h('div.copilot-heading', icon('insight'), h('h2', 'KonX-AI')), this.settingsButton),
      h('div.copilot-scroll', h('div.copilot-conversations', this.conversationSelect, this.newButton, this.renameButton, this.deleteButton),
        this.providerStatus, this.connectionDetails, this.focusStatus, this.attachButton, this.issues, this.evidenceDetails, this.historyDetails,
        h('section.copilot-compose', h('label.field', h('span', 'Your question'), this.question), h('label.copilot-check', this.knowledge, 'Include local knowledge references'),
          h('p.hint', 'Review first, then send. Answers never execute themselves. Separate reviewed actions offer bounded diagnostics, local editor edits and answer notes.'), h('div.copilot-actions', this.prepareButton, this.cancelButton), this.status, this.cleanupButton), this.review, this.turns, controller.actions.el));
  }
  render() {
    const c = this.controller, locked = c.busy || c.prompting || !!c.jobId || c.actions.locked, conversation = c.conversation;
    this.state = c.state;
    if (this.question.value !== c.question) this.question.value = c.question;
    this.question.disabled = locked; this.knowledge.disabled = locked || !conversation; this.knowledge.checked = c.includeKnowledge;
    const options = [h('option', { value: '' }, 'Choose a conversation'), ...c.conversations.map(item => h('option', { value: item.id }, item.name))];
    if (conversation && !c.conversations.some(item => item.id === conversation.id)) options.push(h('option', { value: conversation.id }, conversation.name));
    this.conversationSelect.replaceChildren(...options); this.conversationSelect.value = conversation?.id || '';
    this.conversationSelect.disabled = locked; this.newButton.disabled = locked;
    this.renameButton.disabled = this.deleteButton.disabled = locked || !conversation;
    const config = c.provider?.config, capable = c.provider?.capabilities;
    this.transportSelect.value = c.stream ? 'stream' : 'buffered'; this.transportSelect.disabled = locked;
    this.transportHint.textContent = `${capable?.streaming ? 'Choose Buffered response if your API gateway does not support streaming.' : 'This provider uses buffered responses.'} The complete answer is checked for secrets before text appears.`;
    this.providerStatus.textContent = config ? `${config.providers?.find(item => item.id === config.provider)?.label || config.provider} · ${config.model || 'No model selected'} · ${config.hasKey ? 'Configured' : 'API key required'}` : 'Reading AI connection…';
    if (c.provider?.lastTest) this.providerStatus.textContent += ` · Last test: ${c.provider.lastTest.ok ? 'succeeded' : 'failed'} (${when(c.provider.lastTest.checkedAt)})${c.provider.lastTest.providerRevision !== config?.revision ? ' — previous settings' : ''}`;
    this.testButton.disabled = locked || !config?.hasKey; this.prepareButton.disabled = locked || !config?.hasKey || !conversation || !c.question.trim();
    this.settingsButton.disabled = c.prompting;
    this.attachButton.disabled = locked || !c.focusedTab || c.focusedTab.disposed || !copilotContextSupport(c.focusedTab).supported;
    this.focusStatus.textContent = `Workspace view: ${c.focusedTab?.title || 'None'}. Evidence is selected separately. KonX-AI does not target a terminal.`;
    this.issues.replaceChildren(...c.issues.map(issue => h('p.hint', text(issue.message))));
    this.renderEvidence(locked); this.renderHistory(locked); this.renderTurns();
    this.cancelButton.classList.toggle('hidden', !c.jobId); this.cancelButton.disabled = !!c.cancelRequested;
    this.status.textContent = c.message;
    this.cleanupButton.classList.toggle('hidden', !c.cleanupError); this.cleanupButton.disabled = !!c.discardPromise;
    this.cleanupButton.title = c.cleanupError;
    const preview = c.prepared; this.review.classList.toggle('hidden', !preview);
    if (preview) {
      this.reviewMeta.replaceChildren(h('strong', `${preview.provider} · ${preview.model}`), h('p', preview.endpoint),
        h('p.hint', `${preview.bytes?.toLocaleString?.() ?? 'Unknown'} bytes · Expires ${when(preview.expiresAt)} · ${preview.mode === 'stream' ? 'Streaming transport' : 'Buffered transport'}`),
        h('p.hint', capable?.outputPolicy === 'redacted-complete-answer' ? 'The complete answer is checked for secrets before text appears.' : 'Output behavior is described in the request limitations.'));
      this.requestBody.textContent = text(preview.body);
      this.reviewLimitations.replaceChildren(...(preview.limitations || []).map(item => h('li', text(item))));
    } else this.requestBody.textContent = '';
    this.sendButton.disabled = locked || !preview; this.discardButton.disabled = locked || !preview;
    c.actions.render();
  }
  renderEvidence(locked) {
    const c = this.controller, attachments = c.conversation?.attachments || [];
    if (!this.attachmentControls || this.renderedAttachments !== c.conversation?.attachments) {
      this.renderedAttachments = c.conversation?.attachments; this.attachmentControls = new Map();
      this.evidence.replaceChildren(...attachments.map(item => {
      const snapshot = item.snapshot, checked = c.attachmentIds.has(item.id);
      const checkbox = h('input', { type: 'checkbox', checked, disabled: locked || !checked && c.attachmentIds.size >= 8,
        'aria-label': `Include evidence: ${snapshot.title}`, onchange: event => c.selectAttachment(item.id, event.target.checked) });
      const body = h('details.copilot-snapshot', h('summary', 'Inspect saved snapshot'), h('pre', { tabindex: 0 }, JSON.stringify(snapshot, null, 2)));
      const source = h('button.btn.sm', { onclick: () => c.focusSource(item) }, 'Open source view');
      const remove = h('button.btn.sm', { disabled: locked, 'aria-label': `Remove evidence: ${snapshot.title}`, onclick: () => c.detach(item.id) }, icon('x'));
      const stale = h('p.hint.copilot-source-stale'); this.attachmentControls.set(item.id, { checkbox, remove, stale });
      return h('article.copilot-attachment', h('div.copilot-attachment-title', h('label.copilot-check', checkbox, h('strong', snapshot.title)), remove),
        h('p.hint', `${snapshot.kind} · ${when(snapshot.capturedAt)} · ${snapshot.coverage?.complete ? 'Complete observed scope' : 'Partial or unknown coverage'}`),
        ...(snapshot.omissions || []).map(item => h('p.hint', item)), stale, source, body);
      }));
      if (!attachments.length) this.evidence.append(h('p.hint', 'No evidence attached. Use “Ask KonX-AI” in a tool or “Attach from current view” to choose evidence.'));
    }
    for (const [id, controls] of this.attachmentControls || []) {
      const checked = c.attachmentIds.has(id); controls.checkbox.checked = checked;
      controls.checkbox.disabled = locked || !checked && c.attachmentIds.size >= 8; controls.remove.disabled = locked;
      controls.stale.textContent = c.changedSources.has(id) ? 'The source view has changed. This saved snapshot and any reviewed request remain unchanged; attach again to use newer observations.' : '';
      controls.stale.classList.toggle('hidden', !c.changedSources.has(id));
    }
    this.evidenceDetails.querySelector('summary').textContent = `Attached evidence (${c.attachmentIds.size} selected of ${attachments.length})`;
  }
  renderHistory(locked) {
    const c = this.controller, turns = (c.conversation?.turns || []).filter(item => item.status === 'complete');
    if (!this.historyControls || this.renderedHistory !== c.conversation?.turns) {
      this.renderedHistory = c.conversation?.turns; this.historyControls = new Map();
      this.history.replaceChildren(...turns.map(turn => {
      const checked = c.historyTurnIds.has(turn.id);
      const checkbox = h('input', { type: 'checkbox', checked, disabled: locked || !checked && c.historyTurnIds.size >= 12,
        'aria-label': `Include previous reply: ${turn.question}`, onchange: event => c.selectHistory(turn.id, event.target.checked) });
      this.historyControls.set(turn.id, checkbox); return h('label.copilot-check', checkbox, turn.question);
      }));
      if (!turns.length) this.history.append(h('p.hint', 'Only completed replies can be included. Failed or cancelled requests are excluded.'));
    }
    for (const [id, control] of this.historyControls || []) {
      const checked = c.historyTurnIds.has(id); control.checked = checked; control.disabled = locked || !checked && c.historyTurnIds.size >= 12;
    }
    this.historyDetails.querySelector('summary').textContent = `Previous replies included (${c.historyTurnIds.size})`;
  }
  renderTurns() {
    const c = this.controller;
    if (this.renderedTurns !== c.conversation?.turns) {
      this.renderedTurns = c.conversation?.turns;
      c.actions.turnButtons.clear(); c.actions.renderedActions = null;
      this.savedTurns.replaceChildren(...(c.conversation?.turns || []).map(turn => h('article.copilot-turn',
      h('p.copilot-turn-meta', `${turn.status} · ${when(turn.createdAt)}`), h('h3', turn.question), h('div.copilot-answer', text(turn.answer) || text(turn.error) || 'No answer was saved.'),
      h('p.hint', usageText(turn.usage)), ...(turn.limitations || []).map(item => h('p.hint', text(item))),
      h('details', h('summary', 'Original request and sources'), h('p.hint', `${turn.request?.provider || 'Unknown provider'} · ${turn.request?.model || 'Unknown model'}`),
        h('pre.copilot-request', { tabindex: 0 }, text(turn.request?.body))), c.actions.turnControl(turn))));
    }
    this.pendingTurn.classList.toggle('hidden', !c.jobId);
    if (c.jobId) this.pendingTurn.replaceChildren(h('p.copilot-turn-meta', 'Request in progress'),
      h('div.copilot-answer', c.liveAnswer || 'Waiting for the complete, redacted answer…'), h('p.hint', usageText(c.liveUsage)));
  }
  show() { this.active = true; this.controller.viewClosed = false; if (!this.controller.busy && !this.controller.jobId) void this.controller.refreshStatus().catch(error => { this.controller.message = errMsg(error); this.controller.changed(); }); }
  hide() { this.active = false; }
  focus() { this.question.focus(); }
  refit() {}
  onHostWindowChanged() { this.refit(); }
  updateBlockers() { return this.controller.updateBlockers(); }
  requestClose() { return this.controller.requestClose(); }
  statusSegments() { return [{ icon: 'insight', text: 'KonX-AI' }, { text: this.controller.jobId ? 'Request in progress' : 'Local conversation' }]; }
  dispose() { this.disposed = true; this.controller.closeView(); }
}
