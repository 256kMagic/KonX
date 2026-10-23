import { h, api, errMsg, toast } from './ui.js';
import { captureEditorActionTarget } from './copilot-editor-actions.mjs';

const labels = { 'diagnostic.ping': 'Ping', 'diagnostic.dns': 'DNS lookup', 'diagnostic.traceroute': 'Traceroute', 'editor.replaceSelection': 'Replace editor selection', 'note.saveAnswer': 'Save answer as local note' };
const defaults = kind => kind === 'diagnostic.ping' ? { host: '', count: 4, interval: 1000, timeout: 1000, size: 32 }
  : kind === 'diagnostic.dns' ? { name: '', type: 'A', server: '' } : kind === 'diagnostic.traceroute' ? { host: '', maxHops: 15, timeout: 1000 }
  : kind === 'editor.replaceSelection' ? { replacement: '' } : { title: 'KonX-AI answer' };
const actionButton = (action, label, onclick, primary = false) => h(`button.btn${primary ? '.primary' : '.sm'}`, { 'data-action': action, onclick }, label);
const field = (label, input) => h('label.field', h('span', label), input);
const excerpt = value => typeof value === 'string' ? value : '';

/** One action owner attached to the app-owned KonX-AI controller, never a model tool bridge. */
export class CopilotReviewedActions {
  constructor(controller) {
    this.controller = controller; this.app = controller.app; this.id = 'copilot-reviewed-actions'; this.title = 'Reviewed KonX-AI action';
    this.draft = null; this.preview = null; this.candidates = []; this.issues = []; this.message = ''; this.generation = 0;
    this.discards = new Set(); this.cleanupError = ''; this.busy = false; this.jobId = null; this.sequence = 0; this.turnButtons = new Map(); this.disposed = false;
    this.kind = h('select.input', { 'aria-label': 'Reviewed action kind', onchange: () => this.setKind(this.kind.value) }, ...Object.entries(labels).map(([value, label]) => h('option', { value }, label)));
    this.host = h('input.input', { 'aria-label': 'Action target', placeholder: 'One IP address or DNS name', oninput: () => this.setParam(this.draft.kind === 'diagnostic.dns' ? 'name' : 'host', this.host.value) });
    this.count = this.number('Ping count', 'count', 1, 10); this.interval = this.number('Ping interval milliseconds', 'interval', 250, 5000);
    this.timeout = this.number('Action timeout milliseconds', 'timeout', 250, 5000); this.size = this.number('Ping payload bytes', 'size', 0, 1400); this.hops = this.number('Maximum hops', 'maxHops', 1, 30);
    this.dnsType = h('select.input', { 'aria-label': 'Action DNS record type', onchange: () => this.setParam('type', this.dnsType.value) }, ...['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'PTR'].map(value => h('option', { value }, value)));
    this.server = h('input.input', { 'aria-label': 'Action DNS server', placeholder: 'Configured resolver', oninput: () => this.setParam('server', this.server.value) });
    this.noteTitle = h('input.input', { 'aria-label': 'Answer note title', maxlength: 160, oninput: () => this.setParam('title', this.noteTitle.value) });
    this.noteStart = this.number('Answer excerpt start', 'start', 0, 50000, true); this.noteEnd = this.number('Answer excerpt end', 'end', 0, 50000, true);
    this.answerSelectionButton = actionButton('use-selected-answer-text', 'Use selected answer text', () => this.captureAnswerSelection());
    // Keep the browser selection while the pointer activates this button.
    // Keyboard activation still uses the normal focusable button.
    this.answerSelectionButton.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
    this.wholeAnswerButton = actionButton('use-whole-answer', 'Use whole answer', () => {
      if (!this.draft || this.draft.kind !== 'note.saveAnswer' || this.blocked) return;
      delete this.draft.params.start; delete this.draft.params.end; this.edited();
    });
    this.answerSelectionStatus = h('p.hint', { 'aria-live': 'polite' });
    this.editorSelect = h('select.input', { 'aria-label': 'Action editor document', onchange: () => { if (this.draft) { this.draft.editorId = this.editorSelect.value; this.draft.target = null; this.edited(); } } });
    this.captureButton = actionButton('capture-editor-selection', 'Use selected editor text', () => this.captureEditor());
    this.editorStatus = h('p.hint'); this.replacement = h('textarea.input', { rows: 6, maxlength: 49152, 'aria-label': 'Editor replacement text', oninput: () => this.setParam('replacement', this.replacement.value) });
    this.suggestions = h('div.copilot-actions'); this.candidateIssues = h('div');
    this.diagnosticFields = h('div', field('Target', this.host), this.pingFields = h('div', field('Count', this.count), field('Interval (ms)', this.interval), field('Payload bytes', this.size)),
      this.traceFields = h('div', field('Maximum hops', this.hops)), this.timeoutField = field('Timeout (ms)', this.timeout),
      this.dnsFields = h('div', field('Record type', this.dnsType), field('DNS server (optional IP)', this.server)));
    this.editorFields = h('div', field('Open editor document', this.editorSelect), this.captureButton, this.editorStatus, field('Replacement text', this.replacement), h('p.hint', 'Select the exact text in the editor, then capture it here. Applying creates one undoable edit. Files are not saved or uploaded.'));
    this.noteFields = h('div', field('New note title', this.noteTitle), h('div.copilot-actions', this.answerSelectionButton, this.wholeAnswerButton), this.answerSelectionStatus,
      h('p.hint', 'Select text in this completed answer, then use it here. The exact note and provenance appear in the review before saving.'),
      h('details', h('summary', 'Choose excerpt by character position'), field('Answer excerpt start (optional character offset)', this.noteStart), field('Answer excerpt end (optional character offset)', this.noteEnd), h('p.hint', 'Leave both offsets empty for the whole answer. Long answers require an explicit shorter excerpt.')));
    this.prepareButton = actionButton('prepare-reviewed-action', 'Prepare action review', () => this.prepare(), true);
    this.clearButton = actionButton('discard-action-draft', 'Discard action draft', () => this.clear());
    this.status = h('p.copilot-status', { role: 'status', 'aria-live': 'polite' });
    this.retryButton = actionButton('retry-action-cleanup', 'Retry action review cleanup', () => this.flushDiscard());
    this.previewSummary = h('div.copilot-action-summary');
    this.previewText = h('pre.copilot-request', { tabindex: 0, 'aria-label': 'Exact reviewed action' });
    this.technicalDetails = h('details.copilot-action-technical', h('summary', 'Technical details'), this.previewText);
    this.executeButton = actionButton('execute-reviewed-action', 'Execute reviewed action', () => this.execute(), true);
    this.discardButton = actionButton('discard-action-review', 'Discard action review', () => { this.invalidate('Review discarded. Edit or prepare the action again.'); this.changed(); });
    this.stopButton = actionButton('stop-reviewed-action', 'Cancel action', () => this.stop());
    this.reviewEl = h('section.copilot-review', { 'aria-label': 'Review action before execution' }, h('h3', 'Review action before execution'),
      this.previewSummary, this.technicalDetails, h('div.copilot-actions', this.executeButton, this.discardButton));
    this.heading = h('h3');
    this.formEl = h('div',
      h('p.hint', 'Choose a suggestion or fill in one bounded action. Opening this form and preparing a review do not run it. Terminal commands are not supported.'),
      this.suggestions, this.candidateIssues, field('Action', this.kind), this.diagnosticFields, this.editorFields, this.noteFields,
      h('div.copilot-actions', this.prepareButton, this.clearButton));
    this.el = h('section.copilot-reviewed-actions.hidden', { 'aria-label': 'Reviewed KonX-AI actions' }, this.heading, this.formEl, this.stopButton, this.status, this.retryButton, this.reviewEl);
  }
  number(label, name, min, max, optional = false) {
    let input; input = h('input.input', { type: 'number', min, max, 'aria-label': label, oninput: () => this.setParam(name, optional && input.value === '' ? undefined : Number(input.value)) }); return input;
  }
  get locked() { return this.busy || !!this.jobId; }
  get panel() { return this.controller.panel; }
  get blocked() { return this.locked || this.controller.busy || this.controller.prompting || !!this.controller.jobId || this.disposed; }
  hasDraft() { return !!this.draft || !!this.preview; }
  updateBlockers() { return [...(this.jobId ? ['Wait for the reviewed action to finish or cancel it.'] : []), ...(this.busy ? ['Wait for the action review operation to finish.'] : []), ...(this.hasDraft() ? ['Execute or discard the reviewed action draft.'] : []), ...(this.discards.size ? ['Retry discarding unused action reviews.'] : [])]; }
  changed() { if (!this.disposed) this.controller.changed(); }
  invalidate(message) { this.generation++; if (this.preview) { this.discards.add(this.preview.preparationId); this.preview = null; void this.flushDiscard(); } if (message) this.message = message; }
  async flushDiscard() {
    if (this.discardPromise) return this.discardPromise;
    this.discardPromise = (async () => { while (this.discards.size) { const id = this.discards.values().next().value; try { await api.invoke('tools:copilotActionDiscard', id); this.discards.delete(id); } catch (error) { this.cleanupError = errMsg(error); return false; } } this.cleanupError = ''; return true; })();
    try { return await this.discardPromise; } finally { this.discardPromise = null; this.changed(); }
  }
  conversationChanged(conversation) {
    if (this.draft && (this.draft.conversationId !== conversation?.id || !conversation.turns.some(turn => turn.id === this.draft.turnId && turn.status === 'complete'))) { this.invalidate(); this.draft = null; }
    else if (this.preview && this.preview.conversationRevision !== conversation?.revision) this.invalidate('The conversation changed. Prepare a new action review.');
  }
  async operation(action) {
    if (this.blocked) return null; this.busy = true; this.changed();
    try { return await action(); } catch (error) { this.message = errMsg(error); toast(this.message, 'err'); return null; }
    finally { this.busy = false; this.changed(); }
  }
  turnControl(turn) {
    if (turn.status !== 'complete') return h('span');
    const button = actionButton('review-turn-actions', 'Review actions', () => this.selectTurn(turn)); button.setAttribute('data-turn-id', turn.id); this.turnButtons.set(turn.id, button);
    const results = h('div.copilot-action-outcomes', { 'data-turn-id': turn.id }); return h('section', button, results);
  }
  async selectTurn(turn) {
    if (this.blocked || turn.status !== 'complete') return;
    if (this.hasDraft()) { const discard = await this.controller.dialog({ title: 'Action draft', body: h('p', 'Discard the current action draft and review another action?'), buttons: [{ label: 'Keep draft', value: null }, { label: 'Discard draft', value: true, danger: true }] }); if (!discard || this.disposed) return; }
    await this.operation(async () => {
      this.invalidate(); if (!await this.flushDiscard()) throw new Error('Retry action review cleanup first.');
      const conversation = this.controller.conversation; if (!conversation?.turns.some(item => item.id === turn.id && item.status === 'complete')) throw new Error('Reopen this completed answer first.');
      const value = await api.invoke('tools:copilotActionCandidates', { conversationId: conversation.id, revision: conversation.revision, turnId: turn.id });
      if (this.disposed) return; this.candidates = value.candidates || []; this.issues = value.issues || [];
      this.draft = { conversationId: conversation.id, turnId: turn.id, kind: 'diagnostic.ping', params: defaults('diagnostic.ping'), target: null, editorId: '' };
      this.message = 'Choose a suggestion or enter a manual action. Nothing has run.'; this.refreshSuggestions(); this.changed(); this.el.scrollIntoView({ block: 'nearest' });
    });
  }
  refreshSuggestions() {
    this.suggestions.replaceChildren(...this.candidates.map((candidate, index) => actionButton('use-action-suggestion', `Use suggestion ${index + 1}: ${labels[candidate.kind]}`, () => { if (this.blocked) return; this.setKind(candidate.kind, structuredClone(candidate.params)); })));
    this.candidateIssues.replaceChildren(...this.issues.map(issue => h('p.hint', issue)));
  }
  edited() { this.invalidate('Action changed. Prepare a new review before executing.'); this.changed(); }
  setKind(kind, params = defaults(kind)) { if (!this.draft || this.blocked || !labels[kind]) return; this.draft.kind = kind; this.draft.params = params; this.draft.target = null; this.edited(); }
  setParam(key, value) { if (!this.draft || this.blocked) return; if (value === undefined) delete this.draft.params[key]; else this.draft.params[key] = value; this.edited(); }
  captureAnswerSelection() {
    if (!this.draft || this.draft.kind !== 'note.saveAnswer' || this.blocked) return;
    try {
      const conversation = this.controller.conversation;
      const turn = conversation?.id === this.draft.conversationId && conversation.turns.find(item => item.id === this.draft.turnId && item.status === 'complete');
      const answer = this.turnButtons.get(this.draft.turnId)?.closest('.copilot-turn')?.querySelector('.copilot-answer');
      if (!turn || typeof turn.answer !== 'string' || !answer?.isConnected || answer.textContent !== turn.answer) throw new Error('Reopen the completed answer before selecting an excerpt. Its displayed text must match the saved answer.');
      const selection = answer.ownerDocument.defaultView.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) throw new Error('Select a nonempty excerpt within this completed answer first.');
      const range = selection.getRangeAt(0);
      if (!answer.contains(range.startContainer) || !answer.contains(range.endContainer)) throw new Error('Select text only within this completed answer. Text from another answer or outside it cannot be used.');
      const prefix = answer.ownerDocument.createRange(); prefix.selectNodeContents(answer); prefix.setEnd(range.startContainer, range.startOffset); const start = prefix.toString().length;
      prefix.setEnd(range.endContainer, range.endOffset); const end = prefix.toString().length;
      if (start >= end || range.toString() !== turn.answer.slice(start, end) || /[\uDC00-\uDFFF]/.test(turn.answer[start] || '') || /[\uDC00-\uDFFF]/.test(turn.answer[end] || '')) throw new Error('Select complete characters from the displayed answer, then try again.');
      this.draft.params = { ...this.draft.params, start, end }; this.invalidate();
      this.message = 'Selected answer excerpt captured locally. Prepare a review to inspect the exact note before saving.';
    } catch (error) { this.message = errMsg(error); }
    this.changed();
  }
  async captureEditor() {
    if (!this.draft || this.draft.kind !== 'editor.replaceSelection') return;
    await this.operation(async () => { const tab = this.app.byId?.get(this.editorSelect.value); if (!tab || tab.disposed || !tab.editor || !tab.current) throw new Error('Choose an open editor document with selected text.');
      this.invalidate(); const target = await captureEditorActionTarget(tab); if (!this.draft || this.disposed) return; this.draft.editorId = tab.id; this.draft.target = target;
      this.draft.editorLabel = `${tab.title}: ${tab.current.title || tab.current.name || tab.current.id}`; this.message = 'Exact editor selection captured locally. Review the before and replacement text before applying.'; });
  }
  async prepare() {
    if (!this.draft) return; await this.operation(async () => {
      this.invalidate(); if (!await this.flushDiscard()) throw new Error('Retry action review cleanup first.');
      const generation = this.generation, draft = this.draft, conversation = this.controller.conversation;
      if (draft.conversationId !== conversation?.id) throw new Error('Reopen the source conversation.');
      const value = await api.invoke('tools:copilotActionPrepare', { conversationId: conversation.id, revision: conversation.revision, turnId: draft.turnId, kind: draft.kind, params: structuredClone(draft.params), ...(draft.target ? { target: structuredClone(draft.target) } : {}) });
      if (this.disposed || generation !== this.generation || draft !== this.draft) { this.discards.add(value.preparationId); await this.flushDiscard(); return; }
      this.preview = value; this.previewLabel = draft.editorLabel || 'Selected editor document'; this.technicalDetails.open = false;
      this.message = 'Review the complete action below. No effect has been requested.'; this.changed(); this.reviewEl.scrollIntoView({ block: 'nearest' });
    });
  }
  async execute() {
    if (!this.preview || this.blocked) return;
    const preview = this.preview;
    if (preview.conversationId !== this.controller.conversation?.id || preview.conversationRevision !== this.controller.conversation?.revision || Date.parse(preview.expiresAt) <= Date.now()) { this.invalidate('This review expired or its conversation changed. Prepare it again.'); this.changed(); return; }
    if (!await this.flushDiscard()) return;
    if (this.preview !== preview || this.blocked) return;
    const id = this.id + ':' + ++this.sequence; this.jobId = id; this.cancelRequested = false; this.preview = null; this.draft = null; this.generation++;
    this.controller.state = 'running'; this.controller.panel.state = 'running'; this.app.registerJob(id, this);
    this.controller.invalidate('A reviewed action is running. Any provider request must be prepared again after it finishes.'); this.message = 'Executing the reviewed action…'; this.changed(); this.app.tabStateChanged?.(this.controller.panel);
    try { await api.invoke('tools:start', 'copilot-action', { preparationId: preview.preparationId, digest: preview.digest }, id); }
    catch (error) { if (this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }
  async stop() { if (!this.jobId || this.cancelRequested) return; const id = this.jobId; this.cancelRequested = true; this.message = 'Cancelling. An already applied editor edit or note may remain.'; this.changed(); try { await api.invoke('tools:stop', id); } catch (error) { if (this.jobId === id) { this.cancelRequested = false; this.message = errMsg(error); this.changed(); } } }
  onJobEvent(type, data = {}) {
    if (!this.jobId || this.disposed) return;
    if (type === 'progress') this.message = excerpt(data.message) || 'Executing reviewed action…';
    if (type === 'report' && data.action && this.controller.conversation?.id === data.conversationId) {
      const value = this.controller.conversation; this.controller.conversation = { ...value, revision: data.conversationRevision, actions: [...(value.actions || []).filter(item => item.id !== data.action.id), data.action] };
      this.message = `Action ${data.action.status}. ${excerpt(data.action.error) || 'Its observations and provenance were saved.'}`; this.receivedReport = true;
    }
    if (type === 'done' || type === 'error') {
      this.controller.state = 'idle'; this.controller.panel.state = 'idle'; this.app.unregisterJob(this.jobId); this.jobId = null; this.app.tabStateChanged?.(this.controller.panel);
      if (!this.receivedReport) this.message = excerpt(data.message) || 'The action ended without a confirmed report. Reopen the conversation to inspect its retained outcome; it will not run again automatically.';
      this.receivedReport = false; void this.controller.refreshList().catch(error => { this.message = errMsg(error); this.changed(); });
    }
    this.changed();
  }
  clear() { if (this.blocked) return; this.invalidate(); this.draft = null; this.message = ''; this.changed(); }
  closeView() { this.invalidate(); this.draft = null; if (this.jobId) void this.stop(); this.changed(); }
  renderPreview(preview) {
    if (this.renderedPreview === preview) return; this.renderedPreview = preview;
    this.previewSummary.replaceChildren(); if (!preview) return;
    const params = preview.params, rows = [];
    const row = (label, value) => rows.push(h('dt', label), h('dd', String(value)));
    if (preview.kind === 'diagnostic.ping') { row('Target', params.host); row('Echo requests', params.count); row('Interval', `${params.interval} ms`); row('Reply timeout', `${params.timeout} ms`); row('Payload', `${params.size} bytes`); }
    else if (preview.kind === 'diagnostic.traceroute') { row('Target', params.host); row('Maximum hops', params.maxHops); row('Hop timeout', `${params.timeout} ms`); row('Reverse name lookup', 'Off'); }
    else if (preview.kind === 'diagnostic.dns') { row('Name or address', params.name); row('Record type', params.type); row('Resolver', params.server || 'Configured system DNS resolver'); row('Query timeout', '4,000 ms; one attempt'); }
    else if (preview.kind === 'editor.replaceSelection') { const range = preview.target.selection; row('Document', this.previewLabel); row('Selection', `Line ${range.startLineNumber}, column ${range.startColumn} through line ${range.endLineNumber}, column ${range.endColumn}`); row('Document version', preview.target.versionId); row('Saving / uploading', 'Neither; use Undo to revert the edit'); }
    else { row('New note title', preview.preview.article.title); row('Destination', 'Local Knowledge library'); row('Answer excerpt', `Characters ${preview.preview.article.content.length.toLocaleString()} including source provenance`); }
    this.previewSummary.append(h('h4', labels[preview.kind]), h('p', preview.preview.effect), h('dl.copilot-action-params', ...rows));
    if (preview.kind === 'editor.replaceSelection') this.previewSummary.append(h('h4', 'Before'), h('pre', { tabindex: 0, 'aria-label': 'Reviewed editor before text' }, preview.preview.before),
      h('h4', preview.preview.replacement.length ? 'Replacement' : 'Replacement — delete the selection'), h('pre', { tabindex: 0, 'aria-label': 'Reviewed editor replacement text' }, preview.preview.replacement));
    if (preview.kind === 'note.saveAnswer') this.previewSummary.append(h('h4', 'Complete note content'), h('pre', { tabindex: 0, 'aria-label': 'Reviewed answer note content' }, preview.preview.article.content));
    this.previewSummary.append(h('p.hint', `Review expires ${new Date(preview.expiresAt).toLocaleString()}. Nothing runs until you select Execute reviewed action.`), h('ul.copilot-limitations', ...preview.limitations.map(value => h('li', value))));
  }
  render() {
    const parent = this.controller, draft = this.draft, locked = this.blocked;
    this.el.classList.toggle('hidden', !draft && !this.jobId && !this.message && !this.cleanupError); this.heading.textContent = draft ? `Action for: ${parent.conversation?.turns.find(turn => turn.id === draft.turnId)?.question || 'Completed answer'}` : 'Reviewed action outcome';
    this.formEl.classList.toggle('hidden', !draft);
    for (const button of this.turnButtons.values()) button.disabled = locked;
    for (const input of this.el.querySelectorAll('input,select,textarea')) input.disabled = locked || !draft;
    for (const button of this.suggestions.querySelectorAll('button')) button.disabled = locked || !draft;
    this.kind.value = draft?.kind || 'diagnostic.ping'; const kind = draft?.kind, params = draft?.params || {};
    const values = [[this.host, params.host ?? params.name ?? ''], [this.count, params.count ?? 4], [this.interval, params.interval ?? 1000], [this.timeout, params.timeout ?? 1000], [this.size, params.size ?? 32], [this.hops, params.maxHops ?? 15], [this.dnsType, params.type ?? 'A'], [this.server, params.server ?? ''], [this.noteTitle, params.title ?? ''], [this.noteStart, params.start ?? ''], [this.noteEnd, params.end ?? ''], [this.replacement, params.replacement ?? '']];
    for (const [input, value] of values) if (input.value !== String(value)) input.value = String(value);
    this.diagnosticFields.classList.toggle('hidden', !kind?.startsWith('diagnostic.')); this.pingFields.classList.toggle('hidden', kind !== 'diagnostic.ping'); this.traceFields.classList.toggle('hidden', kind !== 'diagnostic.traceroute'); this.timeoutField.classList.toggle('hidden', kind === 'diagnostic.dns'); this.timeout.max = kind === 'diagnostic.traceroute' ? '3000' : '5000'; this.dnsFields.classList.toggle('hidden', kind !== 'diagnostic.dns');
    this.editorFields.classList.toggle('hidden', kind !== 'editor.replaceSelection'); this.noteFields.classList.toggle('hidden', kind !== 'note.saveAnswer');
    const editors = (this.app.tabs || []).filter(tab => !tab.disposed && tab.editor && tab.current?.model);
    this.editorSelect.replaceChildren(h('option', { value: '' }, 'Choose an open editor'), ...editors.map(tab => h('option', { value: tab.id }, `${tab.title}: ${tab.current.title || tab.current.name || tab.current.id}`))); this.editorSelect.value = draft?.editorId || '';
    this.editorStatus.textContent = draft?.target ? `Captured document ${draft.target.documentId}, model version ${draft.target.versionId}, ${draft.target.beforeText.length} characters. The live selection must still match at execution.` : 'No editor selection captured.';
    this.captureButton.disabled = locked || !this.editorSelect.value; this.prepareButton.disabled = locked || !draft; this.clearButton.disabled = locked || !draft;
    this.answerSelectionButton.disabled = locked || kind !== 'note.saveAnswer'; this.wholeAnswerButton.disabled = locked || kind !== 'note.saveAnswer';
    this.answerSelectionStatus.textContent = params.start === undefined && params.end === undefined ? 'Whole answer selected.' : `Answer excerpt: character positions ${params.start ?? 0} to ${params.end ?? 'the end'}.`;
    this.reviewEl.classList.toggle('hidden', !this.preview); this.previewText.textContent = this.preview ? JSON.stringify(this.preview, null, 2) : '';
    this.renderPreview(this.preview);
    this.executeButton.disabled = locked || !this.preview; this.discardButton.disabled = locked || !this.preview;
    this.stopButton.classList.toggle('hidden', !this.jobId); this.stopButton.disabled = !!this.cancelRequested; this.status.textContent = this.message;
    this.retryButton.classList.toggle('hidden', !this.cleanupError); this.retryButton.disabled = !!this.discardPromise; this.retryButton.title = this.cleanupError;
    if (this.renderedActions !== parent.conversation?.actions || this.renderedTurnElements !== parent.panel.savedTurns) {
      this.renderedActions = parent.conversation?.actions; this.renderedTurnElements = parent.panel.savedTurns;
      for (const section of parent.panel.savedTurns.querySelectorAll('.copilot-action-outcomes')) {
        const actions = (parent.conversation?.actions || []).filter(item => item.source.turnId === section.getAttribute('data-turn-id'));
        section.replaceChildren(...actions.map(action => { const body = h('pre.copilot-request', { tabindex: 0 }); const detail = h('details', h('summary', `${labels[action.kind] || action.kind}: ${action.status}`), h('p.hint', action.error || 'Saved observations are not a health verdict.'), body); detail.addEventListener('toggle', () => { body.textContent = detail.open ? JSON.stringify(action, null, 2) : ''; }); return detail; }));
      }
    }
  }
}
