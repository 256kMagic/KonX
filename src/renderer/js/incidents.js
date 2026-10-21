import { h, icon, api, DataTable, modal, confirmDialog, toast, errMsg, fmtBytes } from './ui.js';

const PAGE = 75, LIST_PAGE = 20;
const kinds = { note: 'Note', capture: 'Packet capture', terminal: 'Terminal transcript', tool: 'Tool report / JSON', syslog: 'Syslog text', other: 'Other file' };
const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown observation time';
const metadata = (items) => h('dl.incident-metadata', items.map(([key, value]) => [h('dt', key), h('dd', value == null || value === '' ? 'Unknown' : String(value))]));
const message = (issue) => typeof issue === 'string' ? issue : JSON.stringify(issue);

/** Local evidence library. Opening a tab never saves pending source material. */
export class IncidentTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'incidents'; this.icon = 'file'; this.title = 'Incident Workspace';
    this.id = 'incidents-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.disposed = false;
    this.seq = 0; this.busy = false; this.incidents = []; this.report = null; this.selectedEvidence = null;
    this.pending = params.evidence || null; this.listPage = 0; this.page = 0; this.mode = 'timeline';
    this.status = h('div.incident-status', { role: 'status', 'aria-live': 'polite' }, 'Create an incident to collect local evidence and observations.');
    this.createButton = h('button.btn.primary', { onclick: () => this.create() }, icon('plus'), 'New incident');
    this.refreshButton = h('button.btn', { onclick: () => this.refresh() }, icon('refresh'), 'Refresh');
    this.deleteButton = h('button.btn', { disabled: true, onclick: () => this.remove() }, icon('trash'), 'Delete incident');
    this.jsonButton = h('button.btn', { disabled: true, onclick: () => this.export('json') }, 'Export JSON');
    this.htmlButton = h('button.btn', { disabled: true, onclick: () => this.export('html') }, 'Export HTML');
    this.listSearch = h('input.input', { type: 'search', placeholder: 'Find an incident', 'aria-label': 'Search incident library', oninput: () => { this.listPage = 0; this.renderList(); } });
    this.list = h('div.incident-list', { 'aria-label': 'Saved incidents' }); this.listPager = h('div.incident-pager');
    this.issues = h('div.incident-issues'); this.heading = h('div.incident-heading');
    this.pendingButton = h('button.btn.primary', { onclick: () => this.addPending() }, 'Add pending evidence');
    this.pendingHost = h('div.incident-pending');
    this.importKind = h('select.input', { 'aria-label': 'Imported evidence type' }, Object.entries(kinds).filter(([key]) => key !== 'note').map(([value, label]) => h('option', { value }, label)));
    this.importLabel = h('input.input', { placeholder: 'Label (optional)', maxLength: 256, 'aria-label': 'Imported evidence label' });
    this.importTime = this.timeInput('Imported observation time');
    this.importButton = h('button.btn', { onclick: () => this.importFile() }, icon('folder-open'), 'Import file');
    this.noteKind = h('select.input', { 'aria-label': 'Pasted evidence type' }, ['note', 'terminal', 'tool', 'syslog'].map((value) => h('option', { value }, kinds[value])));
    this.noteLabel = h('input.input', { placeholder: 'Label (optional)', maxLength: 256, 'aria-label': 'Note or pasted evidence label' });
    this.noteTime = this.timeInput('Note observation time');
    this.noteText = h('textarea.input', { rows: 5, maxLength: 262144, placeholder: 'Write an observation or paste source text…', 'aria-label': 'Note or pasted evidence text', oninput: () => this.updateButtons() });
    this.noteButton = h('button.btn', { onclick: () => this.addText() }, 'Save note / pasted evidence');
    this.addPanel = h('details.incident-add', h('summary', 'Add evidence or observations'),
      h('div.incident-actions', this.importKind, this.importLabel, this.importButton), this.importTime,
      h('p.hint', 'Files are copied into this incident. Original files remain unchanged. Exported reports can include retained text and local source paths.'),
      h('div.incident-actions', this.noteKind, this.noteLabel), this.noteTime, this.noteText,
      h('div.incident-actions', this.noteButton),
      h('div.hint', 'Observation time is optional. Use an ISO timestamp with UTC offset, such as 2026-10-21T15:30:00-04:00. Missing time stays unknown.'));
    this.timelineButton = h('button.btn.sm', { onclick: () => this.setMode('timeline') }, 'Timeline');
    this.evidenceButton = h('button.btn.sm', { onclick: () => this.setMode('evidence') }, 'Evidence');
    this.search = h('input.input', { type: 'search', placeholder: 'Filter observations or source labels', 'aria-label': 'Filter incident evidence', oninput: () => { this.page = 0; this.renderRows(); } });
    this.kindFilter = h('select.input', { 'aria-label': 'Filter evidence type', onchange: () => { this.page = 0; this.renderRows(); } },
      h('option', { value: '' }, 'All evidence types'), Object.entries(kinds).map(([value, label]) => h('option', { value }, label)));
    this.tableHost = h('div.incident-table-host'); this.rowsPager = h('div.incident-pager');
    this.detail = h('div.incident-evidence-detail', h('p.hint', 'Select evidence or a timeline event to inspect its retained source.'));
    this.content = h('div.incident-content', this.issues, this.heading, this.pendingHost, this.addPanel,
      h('div.incident-actions', this.timelineButton, this.evidenceButton, this.kindFilter, this.search), this.tableHost, this.rowsPager, this.detail);
    this.el = h('div.view.incident-view', h('div.tool-head', h('div.tool-title', icon('file'), h('h2', 'Incident Workspace'), h('span.sub', 'Local evidence, notes and an observation timeline')),
      h('div.incident-actions', this.createButton, this.refreshButton, this.jsonButton, this.htmlButton, this.deleteButton), this.status),
      h('div.incident-columns', h('aside.incident-library', this.listSearch, this.list, this.listPager), this.content));
    this.setMode('timeline'); this.updateButtons(); this.renderPending();
    this.ready = this.refresh(params.incidentId);
  }
  timeInput(label) { return h('input.input.incident-time', { placeholder: 'Observation time with UTC offset (optional)', maxLength: 128, 'aria-label': label, spellcheck: false }); }
  updateButtons() {
    this.createButton.disabled = this.refreshButton.disabled = this.busy;
    for (const button of [this.deleteButton, this.jsonButton, this.htmlButton, this.importButton]) button.disabled = this.busy || !this.report;
    this.noteButton.disabled = this.busy || !this.report || !this.noteText.value.trim();
    this.pendingButton.disabled = this.busy || !this.report || !this.pending;
    for (const control of [this.importKind, this.importLabel, this.importTime, this.noteKind, this.noteLabel, this.noteTime, this.noteText]) control.disabled = this.busy || !this.report;
    for (const button of this.list.querySelectorAll('button')) button.disabled = this.busy;
    this.timelineButton.classList.toggle('primary', this.mode === 'timeline'); this.evidenceButton.classList.toggle('primary', this.mode === 'evidence');
  }
  async request(action, apply, label) {
    if (this.busy || this.disposed) return null;
    const seq = ++this.seq; this.busy = true; this.updateButtons(); if (label) this.status.textContent = label;
    try {
      const result = await action(); if (this.disposed || seq !== this.seq) return null;
      if (apply) await apply(result); return result;
    } catch (error) { if (!this.disposed && seq === this.seq) this.status.textContent = errMsg(error); return null; }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); this.app.updateStatus(this); } }
  }
  async refresh(id = this.report?.id) {
    let open = null;
    await this.request(() => api.invoke('tools:incidentList'), (result) => {
      this.incidents = result.incidents; this.listPage = 0;
      this.issues.replaceChildren(...(result.issues || []).map((issue) => h('p.notice', message(issue))));
      open = this.incidents.some((item) => item.id === id) ? id : null;
      if (!open) this.clearIncident();
      this.renderList(); this.status.textContent = `${this.incidents.length} saved incident(s). Choose one or create a new incident.`;
    }, 'Loading incident library…');
    if (open && !this.disposed) await this.openIncident(open);
  }
  async openIncident(id) {
    await this.request(() => api.invoke('tools:incidentGet', id), (report) => this.acceptIncident(report), 'Opening retained evidence…');
  }
  acceptIncident(report) {
    if (this.disposed || !report) return;
    this.report = report; this.selectedEvidence = null; this.page = 0;
    const summary = { id: report.id, title: report.title, description: report.description, updatedAt: report.updatedAt,
      evidenceCount: report.evidence.length, totalBytes: report.totalBytes, timelineEvents: report.timeline.length };
    const found = this.incidents.findIndex((item) => item.id === report.id);
    if (found < 0) this.incidents.unshift(summary); else this.incidents[found] = summary;
    this.aiContext = { kind: 'incident-summary', title: report.title, evidenceCount: report.evidence.length, timelineEvents: report.timeline.length,
      unknownTimeEvents: report.timeline.filter((event) => event.timestampStatus !== 'explicit').length, timelineLimited: report.timelineLimited,
      limitation: 'Only incident counts and coverage are shared. Source text, evidence paths and notes are excluded.' };
    this.heading.replaceChildren(h('h3', report.title), report.description ? h('p', report.description) : null,
      h('p.hint', `${report.evidence.length} evidence item(s) · ${fmtBytes(report.totalBytes)} · updated ${date(report.updatedAt)}`),
      report.timelineLimited ? h('p.notice', 'The retained timeline reached a limit. Inspect evidence coverage before treating missing events as absent.') : null,
      h('p.hint', 'Timeline order uses explicit observation times. Entries without a complete timestamp remain unknown; import time is shown separately.'));
    this.detail.replaceChildren(h('p.hint', 'Select evidence or a timeline event to inspect its retained source.'));
    this.renderList(); this.renderRows(); this.renderPending(); this.updateButtons();
    this.status.textContent = `Opened “${report.title}”. Evidence stays in this local profile.`; this.app.updateStatus(this);
  }
  clearIncident() {
    this.report = null; this.aiContext = null; this.selectedEvidence = null; this.page = 0;
    this.heading.replaceChildren(h('h3', 'No incident selected')); this.detail.replaceChildren(); this.renderRows(); this.renderPending(); this.updateButtons();
  }
  renderList() {
    const query = this.listSearch.value.trim().toLocaleLowerCase();
    const list = this.incidents.filter((item) => !query || [item.title, item.description].join('\n').toLocaleLowerCase().includes(query));
    this.listPage = Math.min(this.listPage, Math.max(0, Math.ceil(list.length / LIST_PAGE) - 1));
    this.list.replaceChildren(...list.slice(this.listPage * LIST_PAGE, (this.listPage + 1) * LIST_PAGE).map((item) => h('button.incident-card',
      { class: this.report?.id === item.id ? 'active' : '', disabled: this.busy, onclick: () => this.openIncident(item.id), 'data-incident-id': item.id },
      h('strong', item.title), h('span', `${item.evidenceCount} evidence item(s) · ${fmtBytes(item.totalBytes)}`), h('span.hint', date(item.updatedAt)))));
    if (!list.length) this.list.append(h('p.hint', this.incidents.length ? 'No incidents match this search.' : 'No saved incidents yet.'));
    this.listPager.replaceChildren(...this.pager(this.listPage, list.length, LIST_PAGE, (page) => { this.listPage = page; this.renderList(); }));
  }
  pager(page, total, size, change) { return [
    h('button.btn.sm', { disabled: page === 0, onclick: () => change(page - 1) }, 'Previous'),
    h('span.hint', total ? `${page * size + 1}–${Math.min(total, (page + 1) * size)} of ${total}` : '0 entries'),
    h('button.btn.sm', { disabled: (page + 1) * size >= total, onclick: () => change(page + 1) }, 'Next')]; }
  renderPending() {
    this.pendingHost.replaceChildren(); if (!this.pending) return;
    this.pendingHost.append(h('strong', 'Unsaved evidence from another tab'), h('div', `${kinds[this.pending.kind] || this.pending.kind} · ${this.pending.label || 'Untitled evidence'}`),
      h('p.hint', 'Select or create an incident, then add this copy explicitly.'),
      this.pending.kind === 'capture' ? h('p.hint', fmtBytes(this.pending.bytes?.byteLength || 0) + ' captured bytes') :
        h('details', h('summary', 'Preview pending text'), h('pre.incident-source', String(this.pending.text || '').slice(0, 4000)),
          String(this.pending.text || '').length > 4000 ? h('p.hint', 'Showing the first 4,000 characters of this pending copy.') : null), this.pendingButton);
  }
  async create() {
    if (this.busy || this.disposed || this.createDraft) return;
    const title = h('input.input', { 'aria-label': 'New incident title', placeholder: 'Incident title', maxLength: 256 });
    const description = h('textarea.input', { 'aria-label': 'New incident description', placeholder: 'Scope or symptom (optional)', rows: 3, maxLength: 4000 });
    this.createDraft = { title, description };
    const result = await modal({ title: 'New incident', icon: 'file', width: 520, body: h('div.incident-new', title, description),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create incident', value: true, primary: true }],
      onReady: ({ close }) => { this.closeCreate = close; },
      onSubmit: () => { if (!title.value.trim()) { title.focus(); return false; } } });
    this.createDraft = null; this.closeCreate = null;
    if (!result || this.disposed) return;
    const created = await this.request(() => api.invoke('tools:incidentCreate', { title: title.value.trim(), description: description.value }), null, 'Creating local incident…');
    if (created && !this.disposed) await this.openIncident(created.id);
  }
  async importFile() {
    const id = this.report?.id; if (!id) return;
    await this.request(() => api.invoke('tools:incidentImport', id, { kind: this.importKind.value, label: this.importLabel.value || undefined, observedAt: this.importTime.value || undefined }),
      (report) => { if (report) this.acceptIncident(report); }, 'Choose a file to copy into this incident…');
  }
  async addText() {
    const id = this.report?.id; if (!id || !this.noteText.value.trim()) return;
    await this.request(() => api.invoke('tools:incidentAddText', id, { kind: this.noteKind.value, text: this.noteText.value, label: this.noteLabel.value || undefined, observedAt: this.noteTime.value || undefined }),
      (report) => { this.noteText.value = ''; this.noteLabel.value = ''; this.noteTime.value = ''; this.acceptIncident(report); }, 'Saving evidence copy…');
  }
  async addPending() {
    const id = this.report?.id, pending = this.pending; if (!id || !pending) return;
    await this.request(() => pending.kind === 'capture' ? api.invoke('tools:incidentAddCapture', id, pending) : api.invoke('tools:incidentAddText', id, pending),
      (report) => { this.pending = null; this.acceptIncident(report); }, 'Saving evidence from the source tab…');
  }
  setMode(mode) {
    this.mode = mode; this.page = 0;
    const columns = mode === 'timeline' ? [
      { key: 'observedAt', label: 'Observation time', render: (row) => row.timestampStatus === 'explicit' ? date(row.observedAt) : 'Unknown · ' + (row.timeText || 'not recorded') },
      { key: 'label', label: 'Source' }, { key: 'message', label: 'Observation' }, { key: 'line', label: 'Line', render: (row) => row.line ?? '—' },
    ] : [
      { key: 'label', label: 'Evidence' }, { key: 'kind', label: 'Type', render: (row) => kinds[row.kind] || row.kind },
      { key: 'bytes', label: 'Size', render: (row) => fmtBytes(row.bytes) }, { key: 'integrity', label: 'Integrity' },
      { key: 'addedAt', label: 'Imported', render: (row) => date(row.addedAt) },
    ];
    this.table = new DataTable({ columns, rowKey: (row) => row.id, multi: false, emptyText: mode === 'timeline' ? 'No retained events match this view.' : 'No evidence matches this view.' });
    this.table.onSelect = ([row]) => { if (row) this.showEvidence(mode === 'timeline' ? row.evidenceId : row.id, mode === 'timeline' ? row.line : null); };
    this.tableHost.replaceChildren(this.table.el); this.renderRows(); this.updateButtons();
  }
  renderRows() {
    if (!this.table) return;
    const query = this.search.value.trim().toLocaleLowerCase(), kind = this.kindFilter.value;
    const evidence = new Map((this.report?.evidence || []).map((item) => [item.id, item]));
    const all = this.mode === 'timeline' ? (this.report?.timeline || []).map((event) => ({ ...event, label: evidence.get(event.evidenceId)?.label || 'Unknown source', kind: evidence.get(event.evidenceId)?.kind })) : this.report?.evidence || [];
    const rows = all.filter((row) => (!kind || row.kind === kind) && (!query || [row.label, row.message, row.sourceName, row.timeText].join('\n').toLocaleLowerCase().includes(query)));
    this.page = Math.min(this.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1)); this.table.setRows(rows.slice(this.page * PAGE, (this.page + 1) * PAGE));
    this.rowsPager.replaceChildren(...this.pager(this.page, rows.length, PAGE, (page) => { this.page = page; this.renderRows(); }));
  }
  showEvidence(id, sourceLine = null) {
    const item = this.report?.evidence.find((entry) => entry.id === id); if (!item) return;
    this.selectedEvidence = item;
    const lines = (item.textPreview || '').split(/\r\n|\r|\n/), start = Math.max(0, Math.min(lines.length - 1, (sourceLine || 1) - 1) - 30), end = Math.min(lines.length, start + 200);
    const raw = h('pre.incident-source', lines.slice(start, end).map((line, index) => h('span', { class: index + start + 1 === sourceLine ? 'incident-source-line' : '' }, `${index + start + 1}  ${line}\n`)));
    this.detail.replaceChildren(h('h3', item.label), metadata([['Type', kinds[item.kind] || item.kind], ['Original source', item.sourceName], ['Original path', item.originalPath],
      ['Observation time', date(item.observedAt)], ['Imported', date(item.addedAt)], ['Source modified', item.sourceModifiedAt ? date(item.sourceModifiedAt) : 'Unknown'],
      ['Size', fmtBytes(item.bytes)], ['Integrity', item.integrity], ['SHA-256', item.sha256]]),
      item.integrity === 'error' ? h('p.notice', 'Retained evidence failed integrity verification. Opening this capture is unavailable.') : null,
      item.kind === 'capture' ? h('button.btn', { disabled: item.integrity === 'error' || this.busy, 'data-action': 'open-capture', onclick: () => this.openCapture(item.id) }, item.integrity === 'verified' ? 'Open verified capture' : 'Verify and open capture') : null,
      item.previewError ? h('p.notice', item.previewError) : null, item.analysisError ? h('p.notice', item.analysisError) : null,
      item.previewOmitted ? h('p.notice', item.previewOmitted) : null,
      item.timelineCoverage ? h('details', h('summary', 'Timeline coverage'), h('pre.incident-source', JSON.stringify(item.timelineCoverage, null, 2))) : null,
      item.textPreview != null ? raw : h('p.hint', 'No text preview for this evidence.'),
      item.textPreviewTruncated || end < lines.length ? h('p.hint', 'Source preview is limited. The incident retains the copied evidence; exports can have separate text limits.') : null,
      sourceLine > lines.length ? h('p.notice', `Source line ${sourceLine} is outside this bounded preview.`) : null);
  }
  async openCapture(evidenceId) {
    const id = this.report?.id; if (!id) return;
    await this.request(() => api.invoke('tools:incidentCapture', id, evidenceId), async (result) => {
      const item = this.report?.id === id && this.report.evidence.find((entry) => entry.id === evidenceId); if (item) item.integrity = 'verified';
      const tab = this.app.openTool('capture'); await tab.loadBytes(result.bytes, result.name);
    }, 'Verifying and opening the retained capture…');
  }
  async export(format) {
    const id = this.report?.id; if (!id) return;
    await this.request(() => api.invoke('tools:incidentExport', id, format), (file) => { if (file) { this.status.textContent = 'Saved ' + file; toast('Incident report saved'); } }, 'Choose where to save this incident report…');
  }
  async remove() {
    const report = this.report; if (!report || this.busy || this.disposed) return;
    const approved = await confirmDialog(`Delete “${report.title}” and all of its retained evidence copies?`, { title: 'Delete incident', okLabel: 'Delete incident', danger: true, detail: 'Original source files remain in their original locations.' });
    if (!approved || this.disposed || this.report?.id !== report.id) return;
    const removed = await this.request(() => api.invoke('tools:incidentRemove', report.id), () => this.clearIncident(), 'Deleting local incident…');
    if (removed && !this.disposed) await this.refresh();
  }
  updateBlockers() {
    const reasons = [];
    if (this.busy) reasons.push('Incident evidence is being read or saved.');
    if (this.pending) reasons.push('Incident Workspace has unsaved evidence from another tab.');
    if ([this.noteText.value, this.noteLabel.value, this.noteTime.value, this.createDraft?.title.value, this.createDraft?.description.value].some((value) => value?.trim())) reasons.push('Incident Workspace has an unsaved note or incident draft.');
    return reasons;
  }
  async requestClose() {
    if (this.busy) { toast('Wait for the current incident operation to finish before closing.', 'err'); return false; }
    if (!this.updateBlockers().length) return true;
    const close = await confirmDialog('Discard unsaved incident notes and pending evidence in this tab?', { title: 'Unsaved incident evidence', okLabel: 'Discard and close', danger: true });
    if (close) this.closeCreate?.(null);
    return close;
  }
  show() { this.active = true; }
  hide() { this.active = false; }
  focus() { this.listSearch.focus(); }
  statusSegments() { return [{ icon: 'file', text: 'Incident Workspace' }, { text: this.report ? `${this.report.evidence.length} evidence item(s)` : `${this.incidents.length} incidents` }]; }
  dispose() { this.disposed = true; this.seq++; this.pending = null; this.closeCreate?.(null); }
}
