import { installInvestigationContext, investigationChanged } from './copilot-investigations.mjs';
import { h, icon, api, toast, errMsg, confirmDialog } from './ui.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const RECORDS = 1000, HISTORY_BYTES = 1024 * 1024, EVIDENCE_BYTES = 256 * 1024, PAGE = 100;
const severities = ['Emergency', 'Alert', 'Critical', 'Error', 'Warning', 'Notice', 'Informational', 'Debug'];
const field = (label, input) => h('label.field', h('span', label), input);
const displayTime = value => value || 'Unknown';
const option = (value, text) => h('option', { value }, text);

export class EventsTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'events'; this.title = 'Live Events'; this.icon = 'activity';
    this.id = 'events-' + crypto.randomUUID(); this.listenerId = params.listenerId || this.id;
    this.state = 'idle'; this.disposed = false; this.records = []; this.selected = new Set(); this.detailSequence = null;
    this.jobId = null; this.seq = 0; this.page = 0; this.busy = false; this.refreshSeq = 0; this.summary = null; this.sessions = [];
    this.protocol = h('select.input', { 'aria-label': 'Event listener protocol', onchange: () => { this.port.value = this.protocol.value === 'syslog' ? 5514 : 5162; } }, option('syslog', 'Syslog'), option('snmp', 'SNMP traps'));
    this.address = h('input.input', { 'aria-label': 'Local event bind address', value: '127.0.0.1', maxLength: 45, spellcheck: false });
    this.port = h('input.input', { 'aria-label': 'Event UDP port', type: 'number', min: 1, max: 65535, value: 5514 });
    this.startButton = this.button('start', 'Start listening', () => this.start(), 'play');
    this.stopButton = this.button('stop', 'Stop', () => this.stop(), 'stop');
    this.refreshButton = this.button('refresh', 'Refresh history', () => this.refresh(), 'refresh');
    this.historySelect = h('select.input', { 'aria-label': 'Retained event listener history' }, option('', 'Choose stopped history'));
    this.loadButton = this.button('load-history', 'Load stopped history', () => this.loadHistory());
    this.removeButton = this.button('remove-history', 'Remove stopped history', () => this.removeHistory(), 'trash');
    this.clearButton = this.button('clear', 'Clear history', () => this.clear(), 'trash');
    this.exportJsonButton = this.button('export-json', 'Export filtered JSON', () => this.export('json'), 'download');
    this.exportTextButton = this.button('export-text', 'Export filtered text', () => this.export('text'), 'download');
    this.incidentButton = this.button('incident', 'Add selected to incident', () => this.addToIncident(), 'file');
    this.aiButton = this.button('ai', 'Explain summary', () => this.explain(), 'insight');
    this.status = h('div.events-status', { role: 'status', 'aria-live': 'polite' }, 'Choose a listener and press Start. Opening this panel does not receive traffic.');
    this.counts = h('div.events-counts');
    this.search = h('input.input', { type: 'search', maxLength: 256, placeholder: 'Find message, hostname or OID', 'aria-label': 'Filter event text', oninput: () => this.filterChanged() });
    this.sourceFilter = h('input.input', { type: 'search', maxLength: 45, placeholder: 'Exact source IP', 'aria-label': 'Filter event source IP', oninput: () => this.filterChanged() });
    this.protocolFilter = h('select.input', { 'aria-label': 'Filter event protocol', onchange: () => this.filterChanged() }, option('', 'All protocols'), option('syslog', 'Syslog'), option('snmp', 'SNMP'));
    this.severityFilter = h('select.input', { 'aria-label': 'Filter syslog severity', onchange: () => this.filterChanged() }, option('', 'All severities'), ...severities.map((name, index) => option(index, name)), option('unknown', 'Unknown / SNMP'));
    this.rows = h('tbody'); this.table = h('table.events-table', h('thead', h('tr', ['Select', 'Received', 'Source IP', 'Protocol', 'Severity', 'Message'].map(title => h('th', title)))), this.rows);
    this.pageStatus = h('span'); this.previous = this.button('previous', 'Previous', () => { this.page--; this.renderRows(); }); this.next = this.button('next', 'Next', () => { this.page++; this.renderRows(); });
    this.details = h('pre.events-details', { tabindex: 0, 'aria-label': 'Readable event details' }, 'Click an event to inspect its fields.');
    this.linkStatus = h('div.hint', 'Select an event to look for an exact saved-session host match.');
    this.terminalButton = this.button('terminal', 'Open existing terminal', () => this.openTerminal(), 'terminal');
    this.prepareButton = this.button('prepare', 'Prepare saved session', () => this.prepareSession(), 'edit');
    this.el = h('div.view.events-view', h('div.tool-head', h('div.tool-title', icon('activity'), h('h2', 'Live Events'), h('span.sub', 'Local syslog and SNMP trap console')),
      h('div.events-fields', field('Protocol', this.protocol), field('Local bind address', this.address), field('UDP port', this.port), this.startButton, this.stopButton),
      h('p.hint', 'Start explicitly. Loopback receives local traffic; use a local network address for device traffic. SNMPv1/v2c traps only; v3 and informs are unsupported. No responses are sent.'), this.status, this.counts),
      h('div.events-actions', this.historySelect, this.loadButton, this.removeButton, this.refreshButton, this.clearButton, this.exportJsonButton, this.exportTextButton, this.incidentButton, this.aiButton),
      h('div.events-filters', this.search, this.sourceFilter, this.protocolFilter, this.severityFilter),
      h('div.events-body', h('div.events-list', h('div.events-table-scroll', this.table), h('div.events-pages', this.previous, this.pageStatus, this.next)),
        h('section.events-inspector', h('h3', 'Event details'), this.linkStatus, h('div.events-actions', this.terminalButton, this.prepareButton), this.details)));
    installInvestigationContext(this); this.render(); this.ready = this.refresh();
  }
  button(action, title, handler, glyph) { return h('button.btn', { 'data-events-action': action, onclick: handler }, glyph ? icon(glyph) : null, title); }
  message(text, failed = false) { this.status.textContent = text; this.status.setAttribute('role', failed ? 'alert' : 'status'); }
  controls() {
    const owned = !!this.summary?.hasOwnership || !!this.jobId || !!this.starting;
    for (const control of [this.protocol, this.address, this.port, this.startButton]) control.disabled = this.busy || owned;
    this.stopButton.disabled = this.busy || !owned; this.refreshButton.disabled = this.busy;
    this.historySelect.disabled = this.loadButton.disabled = this.busy || owned;
    this.removeButton.disabled = this.busy || owned || !this.summary;
    this.clearButton.disabled = this.busy || !this.summary;
    this.exportJsonButton.disabled = this.exportTextButton.disabled = this.busy || !this.records.length;
    this.incidentButton.disabled = this.busy || !this.selected.size;
    this.aiButton.disabled = this.busy || !this.summary;
    this.renderLink();
  }
  adoptSummary(summary) {
    if (!summary || summary.listenerId !== this.listenerId) return;
    // A removed history can be recreated under the same listener ID by another
    // view. Its sequence starts again at zero; prior records are not its evidence.
    if (summary.state === 'starting' && summary.lastSequence === 0 && summary.retainedRecords === 0) this.replaceRecords([]);
    this.summary = summary; investigationChanged(this); this.state = summary.hasOwnership ? 'running' : 'idle';
    if (!this.busy) this.message(summary.message, ['error', 'cleanup-pending'].includes(summary.state));
    this.app.tabStateChanged?.(this); this.app.updateStatus?.(this);
  }
  replaceRecords(records) {
    const map = new Map(); let total = 0;
    for (const record of records.slice(-RECORDS)) {
      if (record.listenerId !== this.listenerId || !Number.isSafeInteger(record.sequence)) continue;
      const size = bytes(record); if (size > 64 * 1024) continue;
      map.set(record.sequence, { record, size });
    }
    const items = [...map.values()].sort((a, b) => a.record.sequence - b.record.sequence);
    for (const item of items) total += item.size;
    while (total > HISTORY_BYTES) total -= items.shift().size;
    this.records = items.map(item => item.record); investigationChanged(this);
    const retained = new Set(this.records.map(record => record.sequence));
    this.selected = new Set([...this.selected].filter(sequence => retained.has(sequence)));
    if (!retained.has(this.detailSequence)) this.detailSequence = null;
  }
  async refresh() {
    if (this.disposed || this.busy) return;
    const revision = ++this.refreshSeq;
    try {
      const [listing, saved] = await Promise.all([api.invoke('tools:eventsList'), api.invoke('sessions:list')]);
      if (this.disposed || revision !== this.refreshSeq) return;
      this.sessions = Array.isArray(saved?.sessions) ? saved.sessions : [];
      const chosen = this.historySelect.value;
      this.historySelect.replaceChildren(option('', 'Choose stopped history'), ...listing.listeners.filter(item => !item.hasOwnership).map(item => option(item.listenerId, `${item.settings.protocol} ${item.settings.bindAddress}:${item.settings.port} · ${item.retainedRecords} events`)));
      this.historySelect.value = chosen;
      const summary = listing.listeners.find(item => item.listenerId === this.listenerId);
      if (summary) {
        const snapshot = await api.invoke('tools:eventsSnapshot', this.listenerId, { limit: RECORDS });
        if (this.disposed || revision !== this.refreshSeq) return;
        this.adoptSummary(snapshot); this.replaceRecords(snapshot.records);
        if (!this.jobId) { this.protocol.value = snapshot.settings.protocol; this.address.value = snapshot.settings.bindAddress; this.port.value = snapshot.settings.port; }
      } else {
        this.summary = null; this.replaceRecords([]); this.state = this.jobId || this.starting ? 'running' : 'idle';
        this.message('No retained history for this listener. Press Start to create a new receiver.');
        this.app.tabStateChanged?.(this); this.app.updateStatus?.(this);
      }
      this.render();
    } catch (error) { if (!this.disposed && revision === this.refreshSeq) this.message(errMsg(error), true); }
  }
  async loadHistory() {
    if (this.busy || this.jobId || this.starting || this.summary?.hasOwnership || !this.historySelect.value) return;
    this.listenerId = this.historySelect.value; this.summary = null; this.replaceRecords([]); this.render(); await this.refresh();
  }
  async removeHistory() {
    if (this.busy || this.jobId || this.starting || this.summary?.hasOwnership || !this.summary) return;
    this.busy = true; this.controls();
    try {
      await api.invoke('tools:eventsRemove', this.listenerId);
      if (this.disposed) return;
      this.listenerId = 'events-' + crypto.randomUUID(); this.summary = null; this.replaceRecords([]); this.message('Stopped history removed. Start creates a new listener.'); this.render();
    } catch (error) { if (!this.disposed) this.message(errMsg(error), true); }
    finally { this.busy = false; if (!this.disposed) { this.controls(); await this.refresh(); } }
  }
  async start() {
    if (this.disposed || this.busy || this.jobId || this.summary?.hasOwnership || this.starting) return;
    const port = Number(this.port.value);
    if (!this.address.value.trim() || !Number.isInteger(port) || port < 1 || port > 65535) { this.message('Choose a literal local IP address and UDP port 1–65535.', true); return; }
    const id = this.id + ':' + ++this.seq; this.jobId = id; this.state = 'running'; this.refreshSeq++;
    this.app.registerJob(id, this); this.message('Starting UDP listener…'); this.controls();
    this.starting = (async () => {
      try { await api.invoke('tools:start', 'events', { listenerId: this.listenerId, protocol: this.protocol.value, bindAddress: this.address.value.trim(), port }, id); }
      catch (error) { if (this.jobId === id) { this.releaseJob(); if (!this.disposed) this.message(errMsg(error), true); } }
      finally { this.starting = null; if (!this.disposed) this.controls(); }
    })();
    return this.starting;
  }
  releaseJob() { if (this.jobId) this.app.unregisterJob(this.jobId); this.jobId = null; this.state = 'idle'; this.app.tabStateChanged?.(this); }
  async stop() {
    if (this.disposed || this.busy) return false;
    this.busy = true; this.message('Stopping UDP listener; waiting for socket cleanup…'); this.controls();
    try {
      if (this.starting) await this.starting;
      const listing = await api.invoke('tools:eventsList'), summary = listing.listeners.find(item => item.listenerId === this.listenerId);
      if (summary) {
        const stopped = await api.invoke('tools:eventsStop', this.listenerId);
        if (stopped.hasOwnership) throw new Error('Socket cleanup remains pending. Retry Stop before closing.');
        if (!this.disposed) { this.adoptSummary(stopped); this.message(stopped.message, stopped.state === 'error'); }
      }
      this.releaseJob(); return true;
    } catch (error) { if (!this.disposed) this.message(errMsg(error), true); return false; }
    finally { this.busy = false; if (!this.disposed) this.controls(); }
  }
  onJobEvent(type, data = {}) {
    if (this.disposed || !this.jobId) return;
    this.refreshSeq++;
    if (type === 'status') this.adoptSummary(data);
    if (type === 'events') {
      this.adoptSummary(data.status);
      this.replaceRecords([...this.records.filter(record => !data.status.firstSequence || record.sequence >= data.status.firstSequence), ...(data.records || [])]);
    }
    if (type === 'cleared') { this.adoptSummary(data); this.replaceRecords(this.records.filter(record => record.sequence > data.lastSequence)); }
    if (type === 'done' || type === 'error') {
      if (!this.summary?.hasOwnership) this.releaseJob();
      if (type === 'error') this.message(data.message || 'Event listener failed.', true);
    }
    if (type === 'status' && !data.hasOwnership) this.releaseJob();
    this.render();
  }
  filterChanged() { this.page = 0; this.renderRows(); }
  filtered() {
    const text = this.search.value.toLowerCase(), source = this.sourceFilter.value.trim(), protocol = this.protocolFilter.value, severity = this.severityFilter.value;
    return this.records.filter(record => (!source || record.source.address === source) && (!protocol || record.protocol === protocol) &&
      (!severity || (severity === 'unknown' ? record.severity == null : record.severity === Number(severity))) &&
      (!text || JSON.stringify(record).toLowerCase().includes(text)));
  }
  renderRows() {
    const records = this.filtered(); this.page = Math.min(this.page, Math.max(0, Math.ceil(records.length / PAGE) - 1));
    this.rows.replaceChildren(...records.slice(this.page * PAGE, (this.page + 1) * PAGE).map(record => {
      const checked = h('input', { type: 'checkbox', checked: this.selected.has(record.sequence), 'aria-label': 'Select event ' + record.sequence,
        onclick: event => event.stopPropagation(), onchange: event => this.select(record, event.target.checked) });
      return h('tr', { tabindex: 0, 'data-event-sequence': record.sequence, class: this.detailSequence === record.sequence ? 'selected' : '',
        onclick: () => { this.detailSequence = record.sequence; this.renderDetails(); this.renderRows(); },
        onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.detailSequence = record.sequence; this.renderDetails(); } } },
      h('td', checked), h('td', record.receivedAt), h('td', record.source.address), h('td', record.protocol), h('td', record.severity == null ? 'Unknown' : severities[record.severity]), h('td.events-message', record.message));
    }));
    this.pageStatus.textContent = `${records.length} matching · ${this.records.length} loaded · page ${this.page + 1} of ${Math.max(1, Math.ceil(records.length / PAGE))}`;
    this.previous.disabled = this.page === 0; this.next.disabled = (this.page + 1) * PAGE >= records.length;
  }
  selectionReport(selected = this.selected) { return { schemaVersion: 1, kind: 'live-events-selection', collectedAt: new Date().toISOString(),
    listenerId: this.listenerId, counters: this.summary?.counters || {}, selectedRecords: this.records.filter(record => selected.has(record.sequence)),
    limitations: ['Only explicitly selected retained events are included. UDP delivery and completeness are not guaranteed.', 'Source time remains unknown when the sender supplies no date/timezone. Receive time is separate.'] }; }
  select(record, enabled) {
    const selected = new Set(this.selected); if (enabled) selected.add(record.sequence); else selected.delete(record.sequence);
    if (new TextEncoder().encode(JSON.stringify(this.selectionReport(selected), null, 2)).length > EVIDENCE_BYTES) this.message('Selected evidence exceeds 256 KiB. Select fewer events or export the filtered history.', true);
    else { this.selected = selected; this.detailSequence = record.sequence; }
    this.render();
  }
  renderDetails() {
    const record = this.records.find(item => item.sequence === this.detailSequence);
    this.details.textContent = record ? `Received: ${record.receivedAt}\nReported time: ${displayTime(record.timestamp)}${record.timestampText && !record.timestamp ? ' (' + record.timestampText + '; year/timezone unknown)' : ''}\nSource: ${record.source.address}:${record.source.port}\nParse: ${record.parseStatus}\n\n` + JSON.stringify(record, null, 2) : 'Click an event to inspect its fields.';
    this.renderLink();
  }
  matches() {
    const record = this.records.find(item => item.sequence === this.detailSequence), address = record?.source.address;
    const sessions = address ? this.sessions.filter(session => session.host === address) : [];
    const session = sessions.length === 1 ? sessions[0] : null;
    const terminals = session ? this.app.tabs.filter(tab => tab.kind === 'terminal' && tab.spec?.sessionId === session.id && tab.meta?.host === address && tab.state === 'connected') : [];
    return { address, sessions, session, terminal: terminals.length === 1 ? terminals[0] : null, terminals };
  }
  renderLink() {
    const match = this.matches();
    this.linkStatus.textContent = !match.address ? 'Select an event to look for an exact saved-session host match.' : !match.sessions.length ? 'No exact saved-session host match. Hostname lookup is not performed.' : match.sessions.length > 1 ? 'Multiple saved sessions have this host; choose one through Sessions.' : 'Exact source IP match: ' + (match.session.name || match.session.host) + '. This does not authenticate the sender.';
    this.terminalButton.disabled = this.busy || !match.terminal; this.prepareButton.disabled = this.busy || !match.session;
  }
  openTerminal() { const match = this.matches(); if (match.terminal) this.app.activate(match.terminal); }
  async prepareSession() {
    if (this.busy || this.disposed) return;
    const sequence = this.detailSequence; this.busy = true; this.controls();
    try { const saved = await api.invoke('sessions:list'); if (this.disposed || this.detailSequence !== sequence) return; this.sessions = saved.sessions || []; this.renderLink(); const match = this.matches(); if (match.session) await this.app.editSession(match.session); }
    catch (error) { if (!this.disposed) this.message(errMsg(error), true); }
    finally { this.busy = false; if (!this.disposed) this.controls(); }
  }
  render() {
    this.report = this.selectionReport();
    this.aiContext = { kind: 'live-events-summary', protocol: this.summary?.settings.protocol || this.protocol.value, state: this.summary?.state || 'idle',
      counters: this.summary?.counters || {}, retainedRecords: this.summary?.retainedRecords || 0, selectedCount: this.selected.size,
      unknownSourceTimeCount: this.records.filter(record => !record.timestamp).length,
      limitations: ['Counts only; no event messages, addresses, hostnames, varbinds or community strings.', 'UDP and OS drops before receipt cannot be counted.'] };
    const counts = this.summary?.counters;
    this.counts.textContent = counts ? `${counts.received} received · ${counts.accepted} accepted · ${counts.parseErrors} invalid · ${counts.unsupported} unsupported · ${counts.oversized + counts.rateDropped + counts.recordDropped} dropped · ${counts.historyEvicted} evicted · ${counts.deliveryDropped} display omissions (Refresh history) · ${this.selected.size} selected` : 'No listener started.';
    this.renderRows(); this.renderDetails(); this.controls();
  }
  async clear() {
    if (this.busy || !this.summary || this.disposed) return;
    this.busy = true; this.refreshSeq++; this.controls();
    try { const summary = await api.invoke('tools:eventsClear', this.listenerId); if (!this.disposed) { this.adoptSummary(summary); this.replaceRecords(this.records.filter(record => record.sequence > summary.lastSequence)); this.message('History cleared. Listener state and cumulative counters are unchanged.'); this.render(); } }
    catch (error) { if (!this.disposed) this.message(errMsg(error), true); }
    finally { this.busy = false; if (!this.disposed) this.controls(); }
  }
  async export(format) {
    if (this.busy || this.disposed || !this.records.length) return;
    this.busy = true; this.controls();
    const records = structuredClone(this.filtered());
    try {
      const approved = await confirmDialog(`Export ${records.length} filtered events?`, { title: 'Review event export', okLabel: 'Choose export file', detail: 'Messages, source addresses, hostnames and decoded SNMP values will be included. Review this data before sharing. SNMP community bytes are omitted; other fields may contain private data.' });
      if (!approved || this.disposed) return;
      const text = format === 'json' ? JSON.stringify({ schemaVersion: 1, kind: 'konx-live-events-export', exportedAt: new Date().toISOString(), records }, null, 2) : records.map(record => `[received ${record.receivedAt}] [reported ${record.timestamp || record.timestampText || 'unknown'}] ${record.source.address}:${record.source.port} ${record.protocol} ${record.message}\n${JSON.stringify(record, null, 2)}`).join('\n\n');
      const file = await api.invoke('dialog:saveText', 'konx-events.' + (format === 'json' ? 'json' : 'txt'), text); if (file && !this.disposed) this.message('Filtered event history exported.');
    } catch (error) { if (!this.disposed) this.message(errMsg(error), true); }
    finally { this.busy = false; if (!this.disposed) this.controls(); }
  }
  addToIncident() {
    if (this.busy || this.disposed || !this.selected.size) return;
    const report = this.selectionReport(), text = JSON.stringify(report, null, 2);
    if (new TextEncoder().encode(text).length > EVIDENCE_BYTES) { this.message('Select fewer events; incident text is limited to 256 KiB.', true); return; }
    this.app.openTool('incidents', { evidence: { kind: 'tool', text, label: 'Selected live events', observedAt: null } });
  }
  async explain() {
    if (this.busy || this.disposed || !this.summary) return;
    try { const preview = await api.invoke('tools:aiPreview', { context: JSON.stringify(this.aiContext, null, 2) }); if (!this.disposed) this.app.openTool('ai', { label: 'Live event counts', context: preview.context, question: 'Explain these event receiver counts and limitations. No event contents are included.' }); }
    catch (error) { if (!this.disposed) this.message(errMsg(error), true); }
  }
  updateBlockers() { return this.busy ? ['Wait for the event console operation.'] : this.jobId || this.summary?.hasOwnership || this.starting ? ['Stop the event listener and wait for socket cleanup.'] : []; }
  async requestClose() {
    if (this.busy) { toast('Wait for the event console operation.', 'err'); return false; }
    if (this.jobId || this.summary?.hasOwnership || this.starting) return this.stop();
    return true;
  }
  show() { this.active = true; this.refresh(); }
  hide() { this.active = false; }
  focus() { this.search.focus(); }
  statusSegments() { return [{ icon: 'activity', text: 'Live Events' }, { text: this.summary?.state || 'Ready' }, { text: `${this.summary?.retainedRecords || 0} retained` }]; }
  dispose() {
    this.disposed = true; this.refreshSeq++;
    // Normal tab closure awaits requestClose(). A forced teardown still asks the
    // main owner to stop; failed cleanup remains owned by main for shutdown.
    const pending = this.starting;
    if (this.jobId || this.summary?.hasOwnership || pending) Promise.resolve(pending).then(() => api.invoke('tools:eventsStop', this.listenerId)).catch(() => {});
    this.releaseJob();
  }
}
