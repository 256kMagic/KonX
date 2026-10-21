import { h, icon, api, DataTable, modal, confirmDialog, toast, errMsg } from './ui.js';

const kinds = { dns: 'DNS lookup', ping: 'ICMP echo', tcp: 'TCP connection', device: 'Cisco inventory', checklist: 'Manual checklist', capture: 'Manual capture review' };
const value = (item) => item == null ? 'Not specified' : typeof item === 'object' ? 'Input: ' + item.input : String(item);
const date = (item) => item && Number.isFinite(Date.parse(item)) ? new Date(item).toLocaleString() : 'Not started / unknown';
const starter = { schemaVersion: 1, name: 'New procedure', description: '', inputs: [], steps: [{ id: 'review', title: 'Review the incident scope', kind: 'checklist', instructions: 'Record the affected service, symptom and observation time.' }] };

export class RunbookTab {
  constructor(app) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'runbook'; this.title = 'Troubleshooting Runbooks'; this.icon = 'route';
    this.id = 'runbook-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.disposed = false;
    this.seq = 0; this.jobSeq = 0; this.busy = false; this.jobId = null; this.templates = []; this.saved = []; this.connections = [];
    this.customId = null; this.selectedKey = ''; this.baseline = ''; this.reviewedText = ''; this.definition = null; this.report = null; this.steps = [];
    this.selector = h('select.input', { 'aria-label': 'Runbook template or saved procedure', onchange: () => this.select(this.selector.value) });
    this.refreshButton = h('button.btn', { onclick: () => this.refresh() }, icon('refresh'), 'Refresh library / SSH sessions');
    this.newButton = h('button.btn', { onclick: () => this.newDefinition() }, icon('plus'), 'New procedure');
    this.importButton = h('button.btn', { onclick: () => this.importDefinition() }, icon('folder-open'), 'Import JSON');
    this.saveButton = h('button.btn', { onclick: () => this.save() }, icon('save'), 'Save custom procedure');
    this.removeButton = h('button.btn', { onclick: () => this.remove() }, icon('trash'), 'Delete saved procedure');
    this.exportButton = h('button.btn', { onclick: () => this.exportDefinition() }, 'Export saved definition');
    this.runButton = h('button.btn.primary', { onclick: () => this.start() }, icon('play'), 'Run procedure');
    this.stopButton = h('button.btn', { disabled: true, onclick: () => this.stop() }, icon('stop'), 'Stop');
    this.reportButton = h('button.btn', { disabled: true, onclick: () => this.exportReport() }, 'Export result JSON');
    this.status = h('div.runbook-status', { role: 'status', 'aria-live': 'polite' }, 'Choose a procedure, review its steps and enter explicit targets.');
    this.description = h('p.runbook-description'); this.inputHost = h('div.runbook-inputs'); this.inputs = new Map();
    this.reviewHost = h('div.runbook-review'); this.reviewError = h('p.runbook-review-error');
    this.editor = h('textarea.input.runbook-json', { rows: 13, spellcheck: false, maxLength: 65536, 'aria-label': 'Runbook definition JSON', oninput: () => { this.reviewError.textContent = this.editor.value === this.reviewedText ? '' : 'Review the edited steps before running this definition.'; this.updateButtons(); } });
    this.reviewButton = h('button.btn', { onclick: () => this.review() }, 'Review edited steps');
    this.editorPanel = h('details.runbook-editor', h('summary', 'Edit procedure JSON'), this.editor, h('div.runbook-actions', this.reviewButton, this.saveButton), this.reviewError,
      h('p.hint', 'Definitions contain bounded DNS, ICMP, TCP, inventory and manual steps. Scripts and arbitrary commands are rejected. Saving and running validate the full definition.'));
    this.table = new DataTable({ columns: [{ key: 'title', label: 'Step' }, { key: 'kind', label: 'Check', render: (row) => kinds[row.kind] || row.kind },
      { key: 'status', label: 'Result', render: (row) => row.status === 'unknown' ? 'Unknown / manual' : row.status }, { key: 'summary', label: 'Observation' }],
      rowKey: (row) => row.id, multi: false, emptyText: 'Run the procedure to collect observations. Manual checks remain unknown.' });
    this.table.onSelect = ([row]) => { this.showStep(row); if (row) this.detail.scrollIntoView({ block: 'nearest' }); };
    this.resultSummary = h('div.runbook-result-summary'); this.detail = h('div.runbook-detail');
    this.content = h('div.runbook-content', this.description, this.inputHost, this.editorPanel, this.reviewHost, this.resultSummary, this.table.el, this.detail);
    this.el = h('div.view.runbook-view', h('div.tool-head', h('div.tool-title', icon('route'), h('h2', 'Troubleshooting Runbooks'), h('span.sub', 'Reviewable procedures with explicit targets and retained observations')),
      h('div.runbook-actions', this.runButton, this.stopButton, this.reportButton, this.exportButton, this.removeButton),
      h('div.runbook-actions', this.selector, this.refreshButton, this.newButton, this.importButton), this.status), this.content);
    this.ready = this.refresh(true);
  }
  isDirty() { return this.editor.value !== this.baseline; }
  updateButtons() {
    const locked = this.busy || Boolean(this.jobId);
    for (const button of [this.refreshButton, this.newButton, this.importButton, this.selector, this.editor, this.reviewButton]) button.disabled = locked;
    this.saveButton.disabled = locked || !this.editor.value.trim(); this.removeButton.disabled = locked || !this.customId;
    this.exportButton.disabled = locked || !this.customId || this.isDirty();
    this.runButton.disabled = locked || !this.definition || this.reviewedText !== this.editor.value;
    this.stopButton.disabled = !this.jobId || this.cancelRequested; this.reportButton.disabled = locked || !this.report;
    for (const { element } of this.inputs.values()) element.disabled = locked;
    this.saveButton.textContent = this.customId ? 'Save changes to procedure' : 'Save custom procedure';
  }
  async request(action, apply) {
    if (this.disposed || this.busy || this.jobId) return null;
    const seq = ++this.seq; this.busy = true; this.updateButtons();
    try { const result = await action(); if (this.disposed || seq !== this.seq) return null; if (apply) await apply(result); return result; }
    catch (error) { if (!this.disposed && seq === this.seq) this.status.textContent = errMsg(error); return null; }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); } }
  }
  async refresh(initial = false) {
    await this.request(() => Promise.all([api.invoke('tools:runbookTemplates'), api.invoke('tools:runbookList'), api.invoke('tools:deviceConnections')]), ([templates, library, connections]) => {
      this.templates = templates; this.saved = library.runbooks; this.connections = connections;
      this.renderSelector(); if (initial && templates.length) { this.selectedKey = 'template:' + templates[0].id; this.setDefinition(templates[0].definition); this.selector.value = this.selectedKey; }
      else if (this.definition) this.renderInputs(true);
      this.status.textContent = library.issues.length ? library.issues.map((issue) => typeof issue === 'string' ? issue : JSON.stringify(issue)).join('\n') : 'Review the steps and target inputs. No checks run until you press Run procedure.';
    });
  }
  renderSelector() {
    this.selector.replaceChildren(h('option', { value: '' }, 'Choose a procedure'), h('optgroup', { label: 'Built-in templates' }, this.templates.map((item) => h('option', { value: 'template:' + item.id }, item.definition.name))),
      h('optgroup', { label: 'Saved custom procedures' }, this.saved.map((item) => h('option', { value: 'saved:' + item.id }, item.name)))); this.selector.value = this.selectedKey;
  }
  async discardChanges() {
    return !this.isDirty() || await confirmDialog('Discard the unsaved procedure definition?', { title: 'Unsaved runbook', okLabel: 'Discard changes', danger: true });
  }
  async select(key) {
    if (this.busy || this.jobId || this.disposed) return;
    this.selector.value = this.selectedKey;
    if (!(await this.discardChanges()) || this.disposed) return;
    if (key.startsWith('template:')) {
      const template = this.templates.find((item) => 'template:' + item.id === key); if (!template) return;
      this.selectedKey = key; this.customId = null; this.setDefinition(template.definition); this.selector.value = key;
    } else if (key.startsWith('saved:')) await this.request(() => api.invoke('tools:runbookGet', key.slice(6)), (record) => {
      this.customId = record.id; this.selectedKey = key; this.setDefinition(record.definition); this.selector.value = key;
    });
  }
  setDefinition(definition, unsaved = false, preserveInputs = false) {
    this.editor.value = JSON.stringify(definition, null, 2); this.baseline = unsaved ? '' : this.editor.value;
    this.review(preserveInputs); this.clearResult(); this.updateButtons();
  }
  review(preserveInputs = true) {
    try {
      if (new TextEncoder().encode(this.editor.value).length > 65536) throw new Error('Definition exceeds the 64 KiB limit.');
      const parsed = JSON.parse(this.editor.value);
      if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.name !== 'string' || !Array.isArray(parsed.steps) || !parsed.steps.length || parsed.steps.length > 24 ||
        !Array.isArray(parsed.inputs || []) || (parsed.inputs || []).length > 12 || parsed.steps.some((step) => !step || !Object.hasOwn(kinds, step.kind))) throw new Error('Expected a named schema version 1 runbook with up to 24 supported steps and 12 inputs.');
      this.definition = parsed; this.reviewedText = this.editor.value; this.reviewError.textContent = '';
      this.description.textContent = parsed.description || '';
      this.renderInputs(preserveInputs);
      this.reviewHost.replaceChildren(h('h3', 'Steps to review'), h('p.hint', 'Network probes originate from this KonX computer. A successful check is an observation, not a root-cause diagnosis. Manual steps remain unknown.'),
        h('p.hint', `Overall deadline: ${parsed.timeoutMs ?? 120000} ms. Hostname probes use the first returned address; they do not test every endpoint.`),
        h('ol.runbook-steps', parsed.steps.map((step) => h('li', h('strong', step.title || step.id || 'Untitled step'), h('span.runbook-kind', kinds[step.kind]),
          h('div.hint', ['dns', 'ping', 'tcp'].includes(step.kind) ? `Target ${value(step.target)}${step.kind === 'tcp' ? ' · port ' + value(step.port) : ''}${step.kind === 'dns' ? ' · ' + (step.recordType || 'A') : ''}${step.server ? ' · DNS server ' + step.server : ''}` :
            step.kind === 'device' ? 'Connected session ' + value(step.connectionId) : step.instructions || 'Manual evidence required'),
          h('div.hint', `Step deadline ${step.timeoutMs ?? (step.kind === 'device' ? 120000 : 5000)} ms`)))));
    } catch (error) { this.definition = null; this.reviewedText = ''; this.reviewError.textContent = errMsg(error); this.reviewHost.replaceChildren(); this.inputHost.replaceChildren(); this.inputs.clear(); }
    this.updateButtons();
  }
  renderInputs(preserve = false) {
    const previous = this.inputs; this.inputs = new Map();
    this.inputHost.replaceChildren(...(this.definition.inputs || []).map((input) => {
      if (!input || typeof input.id !== 'string' || !['host', 'port', 'connection'].includes(input.kind)) throw new Error('Input definitions need an id and host, port or connection kind.');
      const element = input.kind === 'connection' ? h('select.input', h('option', { value: '' }, input.required === false ? 'Not provided (step remains unknown)' : 'Choose connected SSH session'),
        this.connections.map((entry) => h('option', { value: entry.id }, `${entry.label || entry.host} · ${entry.host}`))) :
        h('input.input', { type: input.kind === 'port' ? 'number' : 'text', ...(input.kind === 'port' ? { min: 1, max: 65535 } : { maxLength: 253 }), placeholder: input.kind === 'host' ? 'One IP address or DNS hostname' : 'TCP port' });
      element.setAttribute('aria-label', input.label || input.id); element.dataset.inputId = input.id;
      if (preserve && previous.get(input.id)?.kind === input.kind) element.value = previous.get(input.id).element.value;
      this.inputs.set(input.id, { kind: input.kind, element, required: input.required !== false, label: input.label || input.id });
      return h('label.field', h('span', (input.label || input.id) + (input.required === false ? ' · optional' : ' *')), element);
    }));
  }
  async newDefinition() { if (this.disposed || this.busy || this.jobId || !(await this.discardChanges()) || this.disposed) return; this.customId = null; this.selectedKey = ''; this.selector.value = ''; this.setDefinition(starter, true); this.editorPanel.open = true; }
  async importDefinition() {
    if (this.disposed || this.busy || this.jobId || !(await this.discardChanges()) || this.disposed) return;
    await this.request(() => api.invoke('tools:runbookImport'), (definition) => { if (definition) { this.customId = null; this.selectedKey = ''; this.selector.value = ''; this.setDefinition(definition, true); this.editorPanel.open = true; this.status.textContent = 'Imported definition is unsaved. Review the steps before saving or running.'; } });
  }
  async save() {
    if (this.disposed || this.busy || this.jobId) return;
    this.review(); if (!this.definition) return;
    const saved = await this.request(() => api.invoke('tools:runbookSave', { definition: this.definition, ...(this.customId ? { id: this.customId } : {}) }), (record) => {
      this.customId = record.id; this.selectedKey = 'saved:' + record.id; this.setDefinition(record.definition, false, true); this.status.textContent = 'Custom procedure saved locally.';
    });
    if (saved && !this.disposed) await this.refresh();
  }
  async remove() {
    const id = this.customId; if (!id || this.busy || this.jobId || this.disposed) return;
    const accepted = await confirmDialog('Delete this saved custom procedure?' + (this.isDirty() ? ' Unsaved edits in this editor will also be discarded.' : ''), { title: 'Delete runbook', okLabel: 'Delete procedure', danger: true });
    if (!accepted || this.disposed || this.customId !== id) return;
    const result = await this.request(() => api.invoke('tools:runbookRemove', id), () => { this.customId = null; this.selectedKey = this.templates[0] ? 'template:' + this.templates[0].id : ''; this.setDefinition(this.templates[0]?.definition || starter); });
    if (result && !this.disposed) await this.refresh();
  }
  async exportDefinition() { if (!this.customId || this.isDirty()) return; await this.request(() => api.invoke('tools:runbookExport', this.customId), (file) => { if (file) toast('Saved procedure exported'); }); }
  clearResult() { this.report = null; this.steps = []; this.table.setRows([]); this.resultSummary.replaceChildren(); this.detail.replaceChildren(); this.app.updateStatus(this); }
  async start() {
    if (this.disposed || this.busy || this.jobId || !this.definition || this.reviewedText !== this.editor.value) return;
    const inputs = {};
    for (const [id, input] of this.inputs) {
      const raw = input.element.value.trim();
      if (!raw) { if (input.required) { this.status.textContent = 'Enter ' + input.label; input.element.focus(); return; } continue; }
      const parsed = input.kind === 'port' ? Number(raw) : raw;
      if (input.kind === 'port' && (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)) { this.status.textContent = 'Enter a TCP port from 1 to 65535.'; input.element.focus(); return; }
      inputs[id] = parsed;
    }
    const id = this.id + ':' + ++this.jobSeq; this.jobId = id; this.state = 'running'; this.cancelRequested = false; this.receivedReport = false;
    this.clearResult(); this.app.registerJob(id, this); this.app.tabStateChanged(this); this.updateButtons(); this.status.textContent = 'Starting reviewed procedure…';
    try { await api.invoke('tools:start', 'runbook', { definition: this.definition, inputs }, id); }
    catch (error) { if (!this.disposed && this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }
  async stop() {
    if (!this.jobId || this.cancelRequested) return;
    const id = this.jobId; this.cancelRequested = true; this.updateButtons(); this.status.textContent = 'Stopping and waiting for owned probe cleanup…';
    try { await api.invoke('tools:stop', id); }
    catch (error) { if (!this.disposed && this.jobId === id) { this.status.textContent = errMsg(error); this.cancelRequested = false; this.updateButtons(); } }
  }
  onJobEvent(type, data = {}) {
    if (this.disposed || !this.jobId) return;
    if (type === 'progress' && !this.cancelRequested) this.status.textContent = `${data.phase || 'Running'} · step ${(data.index ?? 0) + 1} of ${data.total ?? '?'}`;
    if (type === 'step') { const index = this.steps.findIndex((step) => step.id === data.id); if (index < 0) this.steps.push(data); else this.steps[index] = data; this.table.setRows(this.steps); }
    if (type === 'report' && data.kind === 'runbook' && data.schemaVersion === 1 && Array.isArray(data.steps)) { this.report = data; this.steps = data.steps; this.receivedReport = true; this.table.setRows(this.steps); this.renderResult(); }
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId); this.jobId = null; this.state = 'idle'; this.app.tabStateChanged(this); this.updateButtons();
      this.status.textContent = type === 'error' ? data.message || 'Procedure failed.' : this.receivedReport ? this.report.complete ? 'Procedure finished. Review failed, unknown and manual observations.' : 'Procedure stopped or incomplete. Retained observations are shown.' : 'No final procedure report was returned.';
      this.app.updateStatus(this);
    }
  }
  renderResult() {
    const report = this.report;
    this.resultSummary.replaceChildren(h('h3', 'Procedure observations'), h('p', `${this.steps.filter((step) => step.status === 'pass').length} passed · ${this.steps.filter((step) => step.status === 'fail').length} failed · ${this.steps.filter((step) => step.status === 'unknown').length} unknown / manual`),
      h('p.hint', `${date(report.startedAt)} → ${date(report.finishedAt)}. Finished execution does not mean all checks passed.`), ...report.warnings.map((warning) => h('p.notice', warning)));
    this.resultSummary.scrollIntoView({ block: 'nearest' });
  }
  showStep(step) {
    if (!step) return;
    const evidence = JSON.stringify(step.evidence, null, 2) || 'No retained evidence';
    this.detail.replaceChildren(h('h3', step.title), h('p', step.summary), h('p.hint', `${step.status} · ${date(step.startedAt)} → ${date(step.finishedAt)} · ${step.durationMs ?? 'Unknown'} ms`),
      step.action?.type === 'capture' ? h('button.btn', { onclick: () => this.openManualCapture(step.action.view) }, 'Open existing capture · ' + step.action.view.toUpperCase()) : null,
      h('pre.runbook-evidence', evidence.slice(0, 65536)), evidence.length > 65536 ? h('p.hint', 'Evidence preview limited to 64 Ki characters; export the result for all retained evidence.') : null);
  }
  async openManualCapture(view) {
    if (!['sip', 'rtp'].includes(view) || this.disposed) return;
    const captures = this.app.tabs.filter((tab) => tab.kind === 'capture' && !tab.disposed && tab.packets?.length).map((tab) => ({ tab, packets: tab.packets }));
    if (!captures.length) { toast('Open a capture file in Packet Capture, then return to this manual step.', 'err'); return; }
    const select = h('select.input', { 'aria-label': 'Existing capture for manual runbook step' }, h('option', { value: '' }, 'Choose an open capture'), captures.map(({ tab, packets }) => h('option', { value: tab.id }, `${tab.title} · ${packets.length} packets`)));
    const accepted = await modal({ title: 'Inspect existing capture', body: h('div', select, h('p.hint', 'This opens the selected capture analysis. The manual runbook result remains unknown until you record your own observations.')),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Open ' + view.toUpperCase(), value: true, primary: true }], onSubmit: () => Boolean(select.value),
      onReady: control => { this.manualDialog = control; } });
    this.manualDialog = null;
    if (!accepted || this.disposed) return;
    const entry = captures.find(({ tab }) => tab.id === select.value);
    if (!entry || this.app.byId.get(entry.tab.id) !== entry.tab || entry.tab.disposed || entry.tab.packets !== entry.packets) { toast('That capture changed or closed. Select the current capture again.', 'err'); return; }
    this.app.activate(entry.tab); if (view === 'sip') await entry.tab.openSipCalls(); else await entry.tab.openRtpMedia();
  }
  async exportReport() { if (!this.report) return; const report = this.report; await this.request(() => api.invoke('dialog:saveText', 'konx-runbook-result.json', JSON.stringify(report, null, 2)), (file) => { if (file) toast('Runbook observations exported'); }); }
  updateBlockers() { return [...(this.jobId ? ['Stop the runbook and wait for probe cleanup.'] : []), ...(this.busy ? ['Wait for the runbook file operation.'] : []), ...(this.isDirty() ? ['Save or discard the unsaved runbook definition.'] : [])]; }
  async requestClose() { if (this.jobId) { await this.stop(); toast('Stopping runbook. Close this tab after cleanup finishes.'); return false; } if (this.busy) { toast('Wait for the runbook operation to finish.', 'err'); return false; } return this.discardChanges(); }
  show() { this.active = true; }
  hide() { this.active = false; }
  focus() { this.selector.focus(); }
  statusSegments() { return [{ icon: 'route', text: 'Troubleshooting Runbooks' }, { text: this.jobId ? 'Running / stopping…' : this.report ? `${this.report.steps.length} observations` : 'Ready' }]; }
  dispose() { this.disposed = true; this.seq++; this.manualDialog?.close(null); if (this.jobId) { this.stop(); this.app.unregisterJob(this.jobId); this.jobId = null; } }
}
