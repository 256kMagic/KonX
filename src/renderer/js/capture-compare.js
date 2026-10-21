import { h, icon, api, DataTable, toast, errMsg, modal } from './ui.js';
import { readCapture } from './capture/pcapfile.mjs';
import { compareCaptures, COMPARE_LIMITS } from './capture/capture-compare.mjs';
import { createComparisonDemo } from './capture/sample-compare.mjs';

const PAGE = 60;
const sides = ['before', 'after'];
const labels = { before: 'Before / working', after: 'After / failing' };
const statuses = { changed: 'Changed', same: 'Same observation', unknown: 'Unknown', unmatched: 'Unmatched' };
const shown = value => value == null ? 'Not observed / unavailable' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const compact = value => value == null ? 'Unavailable' : Array.isArray(value) ? value.length ? value.map(item => compact(item)).join('; ') : 'None observed' :
  typeof value === 'object' ? Object.entries(value).map(([key, item]) => `${key}: ${item == null ? 'unknown' : typeof item === 'object' ? JSON.stringify(item) : item}`).join(' · ') : String(value);
const identity = value => value ? `${value.transport} · ${value.clientIp} → ${value.serverIp}:${value.serverPort}` : 'Unresolved service';

/** The retained packets belong to this comparison, independent of its source tab. */
export class CaptureComparisonTab {
  constructor(app) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'capture-compare'; this.title = 'Capture Comparison'; this.icon = 'columns';
    this.id = 'capture-compare-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.busy = false; this.disposed = false; this.seq = 0;
    this.sources = { before: null, after: null }; this.sourceControls = {}; this.pairs = []; this.report = null; this.page = 0; this.selectedChange = null;
    this.status = h('div.compare-status', { role: 'status', 'aria-live': 'polite' }, 'Choose two offline captures or load the synthetic working / failing demo.');
    this.demoButton = h('button.btn', { onclick: () => this.loadDemo() }, icon('play'), 'Load demo comparison');
    this.compareButton = h('button.btn.primary', { disabled: true, onclick: () => this.compare() }, icon('columns'), 'Compare captures');
    this.exportButton = h('button.btn', { disabled: true, onclick: () => this.export() }, icon('download'), 'Export comparison JSON');
    this.summary = h('div.compare-summary'); this.coverage = h('div.compare-coverage'); this.pairHost = h('div.compare-pairs');
    this.pairBefore = h('select.input', { 'aria-label': 'Before service to map' }); this.pairAfter = h('select.input', { 'aria-label': 'After service to map' });
    this.pairButton = h('button.btn.sm', { onclick: () => this.addPair() }, 'Add explicit pair');
    this.pairDetails = h('details.compare-pairing', h('summary', 'Service identity and explicit mappings'),
      h('p.hint', 'Automatic matching uses transport, client IP, server IP and server port; ephemeral client ports are ignored. Map changed addresses only when you have evidence these are the same service. Remaining services keep automatic matching.'),
      h('div.compare-actions', this.pairBefore, this.pairAfter, this.pairButton), this.pairHost);
    this.service = h('select.input', { 'aria-label': 'Service filter', onchange: () => { this.page = 0; this.renderRows(); } }, h('option', { value: '' }, 'All services'));
    this.category = h('select.input', { 'aria-label': 'Metric category', onchange: () => { this.page = 0; this.renderRows(); } }, h('option', { value: '' }, 'All categories'), ...['dns', 'tcp', 'http'].map(value => h('option', { value }, value.toUpperCase())));
    this.changeStatus = h('select.input', { 'aria-label': 'Metric status', onchange: () => { this.page = 0; this.renderRows(); } }, h('option', { value: '' }, 'All observations'), ...Object.entries(statuses).map(([value, label]) => h('option', { value }, label)));
    this.search = h('input.input', { placeholder: 'Find a metric or service', 'aria-label': 'Find comparison observations', oninput: () => { this.page = 0; this.renderRows(); } });
    this.table = new DataTable({ columns: [
      { key: 'serviceLabel', label: 'Service' }, { key: 'category', label: 'Category', render: row => row.category.toUpperCase() },
      { key: 'metric', label: 'Observation' }, { key: 'status', label: 'Result', render: row => statuses[row.status] || row.status },
      { key: 'before', label: 'Before', render: row => h('span.compare-value', { title: shown(row.before) }, compact(row.before)) },
      { key: 'after', label: 'After', render: row => h('span.compare-value', { title: shown(row.after) }, compact(row.after)) },
    ], rowKey: row => row.id, multi: false, emptyText: 'No observations match. Empty results do not establish that traffic is healthy or unchanged.' });
    this.table.onSelect = ([row]) => { this.showChange(row); if (row) this.detail.scrollIntoView({ block: 'nearest' }); };
    this.count = h('span.hint'); this.prev = h('button.btn.sm', { onclick: () => { this.page--; this.renderRows(); } }, 'Previous');
    this.next = h('button.btn.sm', { onclick: () => { this.page++; this.renderRows(); } }, 'Next');
    this.detail = h('div.compare-detail', 'Select an observation to inspect values and original source frames.');
    this.content = h('div.compare-content', this.summary, this.coverage, this.pairDetails,
      h('div.compare-actions', this.service, this.category, this.changeStatus, this.search), this.table.el,
      h('div.compare-actions', this.count, this.prev, this.next), this.detail);
    this.sourceSummary = h('summary', 'Capture sources');
    this.sourcePanel = h('details.compare-source-panel', { open: true }, this.sourceSummary, h('div.compare-source-grid', sides.map(side => this.sourceChoice(side))));
    this.el = h('div.view.compare-view', h('div.tool-head',
      h('div.tool-title', icon('columns'), h('h2', 'Capture Comparison'), h('span.sub', 'Compare observed DNS, TCP and plaintext HTTP/1 behavior')),
      h('div.compare-actions', this.demoButton, this.compareButton, this.exportButton),
      this.sourcePanel, this.status), this.content);
    this.ready = Promise.resolve(); this.renderRows(); this.renderPairing(); this.updateButtons();
  }
  sourceChoice(side) {
    const title = h('strong', labels[side]), description = h('span.hint', 'No capture selected');
    const file = h('button.btn.sm', { onclick: () => this.openFile(side) }, icon('folder-open'), 'Open file');
    const existing = h('button.btn.sm', { onclick: () => this.chooseExisting(side) }, icon('capture'), 'Use open capture');
    const open = h('button.btn.sm', { disabled: true, onclick: () => this.openSource(side) }, 'Open retained source');
    this.sourceControls[side] = { description, file, existing, open };
    return h('div.compare-source', title, description, h('div.compare-actions', file, existing, open));
  }
  updateButtons() {
    this.demoButton.disabled = this.busy; this.compareButton.disabled = this.busy || sides.some(side => !this.sources[side]);
    this.exportButton.disabled = this.busy || !this.report;
    for (const side of sides) {
      const controls = this.sourceControls[side]; controls.file.disabled = controls.existing.disabled = this.busy;
      controls.open.disabled = this.busy || !this.sources[side];
    }
    this.pairBefore.disabled = this.pairAfter.disabled = this.pairButton.disabled = this.busy || !this.report;
    for (const button of this.pairHost.querySelectorAll('button')) button.disabled = this.busy;
  }
  clearReport() {
    this.report = null; this.aiContext = null; this.pairs = []; this.page = 0; this.selectedChange = null; this.table.selected.clear();
    this.summary.replaceChildren(); this.coverage.replaceChildren(); this.service.replaceChildren(h('option', { value: '' }, 'All services'));
    this.detail.replaceChildren(h('p.hint', 'Select an observation to inspect values and original source frames.'));
    this.renderRows(); this.renderPairing(); this.updateButtons(); this.app.updateStatus(this);
  }
  sourceFromPackets(packets, name, coverage = null, { alreadyOwned = false } = {}) {
    const retained = []; let bytes = 0; const frames = new Map();
    for (const source of packets) {
      if (!(source.data instanceof Uint8Array)) throw new Error('A source packet has no retained bytes.');
      if (retained.length >= COMPARE_LIMITS.maxPackets || bytes + source.data.length > COMPARE_LIMITS.maxBytes) break;
      const no = source.no ?? retained.length + 1;
      if (!Number.isSafeInteger(no) || no < 1 || frames.has(no)) throw new Error('Source frame numbers must be unique positive integers.');
      frames.set(no, retained.length); bytes += source.data.length;
      retained.push({ no, ts: source.ts, timestampKnown: source.timestampKnown !== false && Number.isFinite(source.ts),
        caplen: source.caplen ?? source.data.length, len: source.len ?? source.data.length, linktype: source.linktype ?? source.lt ?? 1,
        data: alreadyOwned ? source.data : new Uint8Array(source.data) });
    }
    const omitted = packets.length - retained.length;
    const retainedCoverage = coverage ? structuredClone(coverage) : { examinedAllRecords: null, warnings: ['Original file record coverage is unavailable for this tab snapshot.'] };
    if (omitted) { retainedCoverage.examinedAllRecords = false; retainedCoverage.limited = true; (retainedCoverage.warnings ||= []).push(`${omitted.toLocaleString()} source packets omitted by comparison bounds.`); }
    return { name: String(name || 'capture').slice(0, 256), packets: retained, coverage: retainedCoverage, frames, bytes, omitted };
  }
  sourceFromBytes(bytes, name) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.byteLength > COMPARE_LIMITS.maxBytes) throw new Error('Choose a capture file no larger than 64 MiB.');
    const read = readCapture(bytes, { maxPackets: COMPARE_LIMITS.maxPackets, maxBytes: COMPARE_LIMITS.maxBytes });
    return this.sourceFromPackets(read.packets, name, read.coverage, { alreadyOwned: true });
  }
  acceptSource(side, source) {
    if (!sides.includes(side)) throw new Error('Choose the before or after source.');
    this.sources[side] = source; this.clearReport(); this.renderSource(side);
  }
  renderSource(side) {
    const source = this.sources[side]; this.sourceControls[side].description.textContent = source ?
      `${source.name} · ${source.packets.length.toLocaleString()} retained packets${source.omitted ? ` · ${source.omitted.toLocaleString()} omitted` : ''}${source.coverage.limited || source.coverage.truncated || source.coverage.examinedAllRecords !== true ? ' · coverage incomplete or unknown' : ''}` : 'No capture selected';
    this.sourceSummary.textContent = `Capture sources · ${this.sources.before?.name || 'Choose before'} → ${this.sources.after?.name || 'Choose after'}`;
  }
  async openFile(side) {
    if (this.busy || this.disposed) return;
    const seq = ++this.seq; this.busy = true; this.updateButtons();
    try {
      const result = await api.invoke('tools:comparisonOpen'); if (!result || this.disposed || seq !== this.seq) return;
      this.acceptSource(side, this.sourceFromBytes(result.bytes, result.name)); this.status.textContent = 'Source retained locally. Compare when both captures are selected.';
    } catch (error) { if (!this.disposed && seq === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); } }
  }
  async chooseExisting(side) {
    if (this.busy || this.disposed) return;
    const captures = this.app.tabs.filter(tab => tab.kind === 'capture' && !tab.disposed && tab.packets?.length && !['running', 'starting', 'stopping'].includes(tab.state));
    if (!captures.length) return toast('Open a capture file, or stop an existing capture first.');
    const select = h('select.input', { 'aria-label': 'Open capture to retain' }, h('option', { value: '' }, 'Choose a stopped capture'), captures.map(tab => h('option', { value: tab.id }, `${tab.title} · ${tab.packets.length} packets`)));
    const accepted = await modal({ title: 'Choose ' + labels[side].toLowerCase() + ' capture', body: h('div', h('p', 'A bounded copy is retained. Later changes to the original tab do not alter this comparison.'), select),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Retain this capture', value: true, primary: true }],
      onSubmit: value => { if (value && !select.value) { toast('Choose an existing capture first.'); return false; } },
      onReady: control => { this.sourceDialog = control; },
    });
    this.sourceDialog = null;
    const selected = accepted && captures.find(item => item.id === select.value);
    if (!selected || this.disposed || this.busy) return;
    if (this.app.byId.get(selected.id) !== selected || ['running', 'starting', 'stopping'].includes(selected.state)) return toast('The source capture changed. Stop it and choose it again.', 'err');
    try { this.acceptSource(side, this.sourceFromPackets(selected.packets, selected.fileName || selected.title, selected.captureCoverage)); this.status.textContent = 'A bounded snapshot of the open capture is retained locally.'; }
    catch (error) { this.status.textContent = errMsg(error); }
  }
  async loadDemo() {
    if (this.busy || this.disposed) return;
    try {
      const demo = createComparisonDemo();
      for (const side of sides) this.acceptSource(side, this.sourceFromBytes(demo[side].bytes, demo[side].name));
      await this.compare();
    } catch (error) { if (!this.disposed) this.status.textContent = errMsg(error); }
  }
  async compare() {
    if (this.busy || this.disposed || sides.some(side => !this.sources[side])) return;
    const seq = ++this.seq; this.busy = true; this.updateButtons(); this.status.textContent = 'Comparing bounded offline observations…';
    try {
      await new Promise(resolve => setTimeout(resolve, 0)); if (this.disposed || seq !== this.seq) return;
      const report = await compareCaptures(this.sources.before.packets, this.sources.after.packets, {
        labels: Object.fromEntries(sides.map(side => [side, this.sources[side].name])), identityMappings: this.pairs,
        coverage: Object.fromEntries(sides.map(side => [side, this.sources[side].coverage])),
      });
      if (this.disposed || seq !== this.seq) return;
      this.report = report; this.aiContext = { kind: 'capture-comparison', summary: report.summary, coverage: { before: report.before.coverage, after: report.after.coverage }, warnings: report.warnings, limitations: report.limitations };
      this.page = 0; this.table.selected.clear(); this.selectedChange = null; this.renderReport();
      this.sourcePanel.open = false;
      this.status.textContent = 'Comparison complete. Review coverage and unknowns before drawing conclusions.';
    } catch (error) { if (!this.disposed && seq === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); this.app.updateStatus(this); } }
  }
  renderReport() {
    const report = this.report;
    this.summary.replaceChildren(h('h3', `${report.summary.changed} changed · ${report.summary.unknown} unknown · ${report.summary.same} same observations`),
      h('p.hint', `${report.summary.matchedServices} matched services · ${report.summary.unmatchedBefore} before-only · ${report.summary.unmatchedAfter} after-only`));
    this.service.replaceChildren(h('option', { value: '' }, 'All services'), report.services.map(service => h('option', { value: service.id }, `${identity(service.identity)} · ${service.status}`)));
    const coverage = side => {
      const snapshot = report[side], c = snapshot.coverage;
      return h('div.compare-coverage-source', h('strong', labels[side]), h('p', snapshot.label),
        h('p', `${c.examinedPackets.toLocaleString()} packets / ${c.examinedBytes.toLocaleString()} bytes examined · ${c.flowCount} flows`),
        h('p', `File records: ${c.sourceRecordsComplete === true ? 'all records read' : c.sourceRecordsComplete === false ? 'incomplete' : 'unknown'} · analysis limits: ${c.limited ? 'reached' : 'not reached'}`),
        h('p', `${c.truncatedPackets} truncated · ${c.malformedPackets} malformed · ${c.fragmentedPackets} fragmented · ${c.missingTimestamps} unknown timestamps · ${c.unclassifiedPackets} unclassified packets`),
        ...snapshot.warnings.map(warning => h('p.notice', warning)),
        snapshot.unidentified.length ? h('details', h('summary', `${snapshot.unidentified.length} unidentified conversations`), snapshot.unidentified.map(row => h('div.compare-unidentified', h('p', row.reason), this.evidenceButtons(side, row.sources, row.sourceCount)))) : null);
    };
    this.coverage.replaceChildren(h('details', h('summary', 'Coverage, limitations and unmatched observations'),
      h('div.compare-source-grid', sides.map(coverage)), ...report.warnings.map(warning => h('p.notice', warning)),
      h('ul', report.limitations.map(value => h('li', value))),
      ...report.services.filter(service => service.status !== 'matched' || service.warnings.length).map(service => h('p.hint', `${identity(service.identity)} · ${service.status}${service.warnings.length ? ' · ' + service.warnings.join(' · ') : ''}`))));
    this.renderPairing(); this.renderRows(); this.showChange(null);
  }
  renderPairing() {
    for (const side of sides) {
      const select = side === 'before' ? this.pairBefore : this.pairAfter;
      select.replaceChildren(h('option', { value: '' }, `Choose ${side} service`), ...(this.report?.[side].services || []).map(service => h('option', { value: service.id }, identity(service.identity))));
    }
    this.pairHost.replaceChildren(...this.pairs.map((pair, index) => h('div.compare-pair-row',
      h('span', `${identity(this.report?.before.services.find(service => service.id === pair.beforeServiceId)?.identity)} → ${identity(this.report?.after.services.find(service => service.id === pair.afterServiceId)?.identity)}`),
      h('button.btn.sm', { onclick: () => { this.pairs.splice(index, 1); this.compare(); } }, 'Remove pair'))));
  }
  async addPair() {
    if (this.busy || !this.report) return;
    const beforeServiceId = this.pairBefore.value, afterServiceId = this.pairAfter.value;
    if (!beforeServiceId || !afterServiceId) return toast('Choose both service identities.');
    if (this.pairs.some(pair => pair.beforeServiceId === beforeServiceId || pair.afterServiceId === afterServiceId)) return toast('Each service can belong to only one explicit pair.', 'err');
    this.pairs.push({ beforeServiceId, afterServiceId }); await this.compare();
  }
  renderRows() {
    const services = new Map((this.report?.services || []).map(service => [service.id, service])); const query = this.search.value.toLowerCase();
    const rows = (this.report?.changes || []).map(row => ({ ...row, serviceLabel: identity(services.get(row.serviceId)?.identity) })).filter(row =>
      (!this.service.value || row.serviceId === this.service.value) && (!this.category.value || row.category === this.category.value) &&
      (!this.changeStatus.value || row.status === this.changeStatus.value) && (!query || `${row.serviceLabel} ${row.metric}`.toLowerCase().includes(query)));
    this.page = Math.max(0, Math.min(this.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1)));
    this.table.setRows(rows.slice(this.page * PAGE, (this.page + 1) * PAGE));
    this.count.textContent = `${rows.length} observations · page ${this.page + 1} of ${Math.max(1, Math.ceil(rows.length / PAGE))}`;
    this.prev.disabled = this.page === 0; this.next.disabled = (this.page + 1) * PAGE >= rows.length;
  }
  evidenceButtons(side, sources = [], count = sources.length) {
    return h('div.compare-source-frames', sources.map(source => h('button.btn.sm', { onclick: () => this.openSource(side, source.frame), title: `${labels[side]} original frame ${source.frame}` }, 'Frame ' + source.frame)),
      count > sources.length ? h('span.hint', `${sources.length} of ${count} source frames listed; evidence link budget reached.`) : !sources.length ? h('span.hint', 'No source frame recorded for this observation.') : null);
  }
  showChange(row) {
    this.selectedChange = row;
    if (!row) { this.detail.replaceChildren(h('p.hint', 'Select an observation to inspect before and after values and source packets.')); return; }
    this.detail.replaceChildren(h('h3', row.metric), h('p', statuses[row.status] || row.status), row.reason ? h('p.notice', row.reason) : null,
      h('div.compare-source-grid', sides.map(side => h('section.compare-evidence', h('h4', labels[side]),
        h('p.hint', identity(this.report.services.find(service => service.id === row.serviceId)?.[side + 'Identity'])),
        h('pre', shown(row[side])), this.evidenceButtons(side, row[side + 'Sources'], row[side + 'SourceCount'])))));
  }
  async openSource(side, frame = null) {
    if (this.busy || this.disposed || !this.sources[side]) return;
    const source = this.sources[side]; const index = frame == null ? null : source.frames.get(frame);
    if (frame != null && index == null) return toast('That source frame was not retained.', 'err');
    const seq = ++this.seq; this.busy = true; this.updateButtons();
    try {
      const tab = this.app.openTool('capture');
      await tab.loadPacketSnapshot(source.packets, `${side}: ${source.name}`, source.coverage);
      if (this.disposed || seq !== this.seq || tab.disposed) return;
      if (index != null) {
        tab.setAutoScroll(false); tab.setFilter(''); tab.select(index); tab.list.ensureVisible(index);
        if (frame !== index + 1) toast(`Original frame ${frame} is packet ${index + 1} in this retained capture.`);
      }
    } catch (error) { if (!this.disposed) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); } }
  }
  async export() {
    if (this.busy || this.disposed || !this.report) return;
    const seq = ++this.seq; this.busy = true; this.updateButtons();
    try { const file = await api.invoke('dialog:saveText', 'konx-capture-comparison.json', JSON.stringify(this.report, null, 2)); if (file && !this.disposed) toast('Comparison report saved'); }
    catch (error) { if (!this.disposed) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); } }
  }
  updateBlockers() { return this.busy ? ['Wait for the capture comparison operation.'] : []; }
  async requestClose() { if (this.busy) { toast('Wait for the capture comparison operation to finish.'); return false; } return true; }
  show() { this.active = true; } hide() { this.active = false; } focus() { this.demoButton.focus(); }
  statusSegments() { return [{ icon: 'columns', text: 'Capture Comparison' }, { text: this.busy ? 'Working…' : this.report ? `${this.report.summary.changed} changed observations` : 'Offline' }]; }
  dispose() { this.disposed = true; this.seq++; this.sourceDialog?.close(null); this.sources = { before: null, after: null }; this.report = null; }
}
