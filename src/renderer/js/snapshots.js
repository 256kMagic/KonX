import { h, icon, api, DataTable, toast, errMsg, confirmDialog } from './ui.js';

const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown time';
const shown = (value) => value == null ? 'Not observed' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const PAGE_SIZE = 100;
const categories = { interfaces: 'Interfaces', vlans: 'VLANs', neighbors: 'Neighbors', routes: 'Routes', configuration: 'Configuration' };
const statuses = { added: 'Added', removed: 'Removed', changed: 'Changed', unknown: 'Unverified' };

/** Explicitly selected immutable snapshots, compared without applying device changes. */
export class SnapshotTab {
  constructor(app) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'snapshots'; this.title = 'Device Snapshots'; this.icon = 'columns';
    this.id = 'snapshots-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.disposed = false;
    this.seq = 0; this.busy = false; this.page = 0; this.snapshots = []; this.report = null; this.records = null;
    this.status = h('div.snapshot-status', { role: 'status', 'aria-live': 'polite' }, 'Save a Device Inspector report, then choose snapshots to compare.');
    this.refreshButton = h('button.btn', { onclick: () => this.refresh() }, icon('refresh'), 'Refresh history');
    this.inspectorButton = h('button.btn', { onclick: () => this.app.openTool('device') }, icon('server'), 'Open Device Inspector');
    this.demoButton = h('button.btn', { onclick: () => this.loadDemo() }, icon('play'), 'Load demo comparison');
    this.exportButton = h('button.btn', { disabled: true, onclick: () => this.export() }, icon('download'), 'Export comparison JSON');
    this.before = h('select.input', { 'aria-label': 'Before snapshot', onchange: () => this.selectSnapshots() });
    this.after = h('select.input', { 'aria-label': 'After snapshot', onchange: () => this.selectSnapshots() });
    this.openBefore = h('button.btn.sm', { onclick: () => this.open(this.before.value) }, 'Open report');
    this.openAfter = h('button.btn.sm', { onclick: () => this.open(this.after.value) }, 'Open report');
    this.removeBefore = h('button.btn.sm', { onclick: () => this.remove(this.before.value) }, icon('trash'), 'Delete');
    this.removeAfter = h('button.btn.sm', { onclick: () => this.remove(this.after.value) }, icon('trash'), 'Delete');
    this.compareButton = h('button.btn.primary', { disabled: true, onclick: () => this.compare() }, icon('columns'), 'Compare snapshots');
    this.pairHost = h('div.snapshot-pairs');
    this.pairDetails = h('details.snapshot-pairing', h('summary', 'Device pairing'),
      h('p.hint', 'Automatic pairing requires a unique matching device identity. Choose explicit pairs when identities are ambiguous; unmatched devices remain unverified.'), this.pairHost);
    this.issues = h('div.snapshot-issues');
    this.heading = h('div.snapshot-heading', 'No comparison selected');
    this.summary = h('div.snapshot-summary');
    this.category = h('select.input', { 'aria-label': 'Comparison category', onchange: () => { this.page = 0; this.renderRows(); } },
      h('option', { value: '' }, 'All categories'), Object.entries(categories).map(([value, label]) => h('option', { value }, label)));
    this.changeStatus = h('select.input', { 'aria-label': 'Comparison change status', onchange: () => { this.page = 0; this.renderRows(); } },
      h('option', { value: '' }, 'All changes'), Object.entries(statuses).map(([value, label]) => h('option', { value }, label)));
    this.search = h('input.input', { 'aria-label': 'Filter snapshot changes', placeholder: 'Filter device or observation', oninput: () => { this.page = 0; this.renderRows(); } });
    this.table = new DataTable({ columns: [
      { key: 'deviceLabel', label: 'Device' }, { key: 'category', label: 'Category', render: (row) => categories[row.category] || row.category },
      { key: 'status', label: 'Change', render: (row) => statuses[row.status] || row.status },
      { key: 'identity', label: 'Observation', render: (row) => shown(row.identity) },
    ], rowKey: (row) => row._index, multi: false, emptyText: 'No changes match this view. Review coverage before treating an empty comparison as unchanged.' });
    this.table.onSelect = ([row]) => this.renderChange(row);
    this.count = h('span.hint');
    this.previousButton = h('button.btn.sm', { onclick: () => { this.page--; this.renderRows(); } }, 'Previous');
    this.nextButton = h('button.btn.sm', { onclick: () => { this.page++; this.renderRows(); } }, 'Next');
    this.detail = h('div.snapshot-change-detail', 'Select a change to inspect its before and after observations.');
    this.coverage = h('div.snapshot-coverage');
    this.content = h('div.snapshot-content', this.issues, this.pairDetails, this.heading, this.summary,
      h('div.snapshot-actions', this.category, this.changeStatus, this.search), this.table.el,
      h('div.snapshot-actions', this.count, this.previousButton, this.nextButton), this.detail, this.coverage);
    this.el = h('div.view.snapshot-view', h('div.tool-head',
      h('div.tool-title', icon('columns'), h('h2', 'Device Snapshots'), h('span.sub', 'Compare configuration and operational observations before and after maintenance')),
      h('div.snapshot-actions', this.refreshButton, this.inspectorButton, this.demoButton, this.exportButton),
      h('div.snapshot-selectors', this.selector('Before', this.before, this.openBefore, this.removeBefore), this.selector('After', this.after, this.openAfter, this.removeAfter)),
      h('div.snapshot-actions', this.compareButton), this.status), this.content);
    this.renderRows(); this.ready = this.refresh();
  }

  selector(label, select, open, remove) { return h('div.snapshot-choice', h('label.field', h('span', label), select), h('div.snapshot-actions', open,
    h('button.btn.sm', { onclick: () => this.open(select.value, 'topology') }, icon('link'), 'View topology'), remove)); }

  updateButtons() {
    this.refreshButton.disabled = this.demoButton.disabled = this.busy; this.before.disabled = this.busy; this.after.disabled = this.busy;
    this.compareButton.disabled = this.busy || !this.records || !this.before.value || !this.after.value || this.before.value === this.after.value;
    this.openBefore.disabled = this.removeBefore.disabled = this.busy || !this.before.value;
    this.openAfter.disabled = this.removeAfter.disabled = this.busy || !this.after.value;
    this.exportButton.disabled = this.busy || !this.report;
    for (const select of this.pairHost.querySelectorAll('select')) select.disabled = this.busy;
  }

  clearComparison() {
    this.report = null; this.aiContext = null; this.page = 0; this.table.selected.clear();
    this.heading.textContent = 'No comparison selected'; this.summary.replaceChildren(); this.coverage.replaceChildren();
    this.detail.replaceChildren(h('p.hint', 'Select a change to inspect its before and after observations.')); this.renderRows(); this.updateButtons();
    this.app.updateStatus(this);
  }

  async refresh(selection = {}) {
    if (this.disposed || this.busy) return;
    const request = ++this.seq; this.busy = true; this.updateButtons();
    const previousBefore = selection.beforeId || this.before.value, previousAfter = selection.afterId || this.after.value;
    let refreshed = false;
    try {
      const result = await api.invoke('tools:snapshotList');
      if (this.disposed || request !== this.seq) return;
      this.snapshots = result.snapshots;
      const options = () => [h('option', { value: '' }, 'Choose a snapshot'), ...this.snapshots.map((item) => h('option', { value: item.id }, `${item.label} · ${date(item.savedAt)}`))];
      this.before.replaceChildren(...options()); this.after.replaceChildren(...options());
      this.before.value = this.snapshots.some((item) => item.id === previousBefore) ? previousBefore : this.snapshots[1]?.id || '';
      this.after.value = this.snapshots.some((item) => item.id === previousAfter) ? previousAfter : this.snapshots[0]?.id || '';
      this.issues.replaceChildren(...(result.issues || []).map((issue) => h('p.notice', typeof issue === 'string' ? issue : shown(issue))));
      this.status.textContent = `${this.snapshots.length} saved snapshot(s). Select a before and after report.`;
      refreshed = true;
    } catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally {
      if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); if (refreshed) await this.selectSnapshots(); }
    }
  }

  async loadDemo() {
    if (this.disposed || this.busy) return;
    const request = ++this.seq; this.busy = true; this.updateButtons();
    let selection;
    try {
      selection = await api.invoke('tools:snapshotDemo');
      if (this.disposed || request !== this.seq) return;
      this.status.textContent = 'Two synthetic snapshots were saved locally. No network collection was performed.';
    } catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); } }
    if (!this.disposed && request === this.seq && selection) { await this.refresh(selection); await this.compare(); }
  }

  async selectSnapshots() {
    if (this.disposed || this.busy) return;
    const request = ++this.seq; this.records = null; this.pairHost.replaceChildren(); this.clearComparison();
    if (!this.before.value || !this.after.value || this.before.value === this.after.value) return;
    const beforeId = this.before.value, afterId = this.after.value;
    this.busy = true; this.updateButtons();
    try {
      const [before, after] = await Promise.all([api.invoke('tools:snapshotGet', beforeId), api.invoke('tools:snapshotGet', afterId)]);
      if (this.disposed || request !== this.seq) return;
      if (!before || !after) throw new Error('A selected snapshot is no longer available. Refresh history.');
      this.records = { before, after };
      this.pairHost.replaceChildren(...before.report.devices.map((device) => {
        const select = h('select.input', { 'aria-label': 'Pair ' + device.label, 'data-before-id': device.id,
          onchange: () => this.clearComparison() }, h('option', { value: '' }, 'Automatic pairing'),
          after.report.devices.map((candidate) => h('option', { value: candidate.id }, `${candidate.label || candidate.host} · ${candidate.host} · ${candidate.port == null ? 'Unknown SSH port' : 'SSH port ' + candidate.port}`)));
        return h('label.snapshot-pair-row', h('span', `${device.label || device.host} · ${device.host} · ${device.port == null ? 'Unknown SSH port' : 'SSH port ' + device.port}`), select);
      }));
      this.status.textContent = `Ready to compare “${before.label}” with “${after.label}”.`;
    } catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); } }
  }

  async compare() {
    if (this.disposed || this.busy || !this.records || this.before.value === this.after.value) return;
    const request = ++this.seq;
    const devicePairs = [...this.pairHost.querySelectorAll('select')].filter((select) => select.value).map((select) => ({ beforeDeviceId: select.dataset.beforeId, afterDeviceId: select.value }));
    this.busy = true; this.updateButtons(); this.status.textContent = 'Comparing stored observations…';
    try {
      const result = await api.invoke('tools:snapshotCompare', { beforeId: this.before.value, afterId: this.after.value, ...(devicePairs.length ? { devicePairs } : {}) });
      if (this.disposed || request !== this.seq) return;
      this.report = result; this.page = 0; this.table.selected.clear(); this.renderComparison();
      this.status.textContent = 'Comparison ready. Missing or incomplete categories are marked Unverified.';
    } catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); this.app.updateStatus(this); } }
  }

  renderComparison() {
    const report = this.report;
    this.heading.textContent = `${report.before.label} → ${report.after.label}`;
    this.summary.replaceChildren(...Object.entries(report.summary).map(([key, value]) => h('span.snapshot-badge', `${statuses[key] || (key === 'comparedDevices' ? 'Devices compared' : key)}: ${value}`)));
    this.aiContext = { kind: 'device-snapshot-comparison-summary', before: report.before, after: report.after, summary: report.summary,
      devices: report.devices.map(({ deviceLabel, status, pairing }) => ({ deviceLabel, status, pairing })), unmatchedCount: report.unmatched.length, warningCount: report.warnings.length,
      limitation: 'Only comparison counts and coverage are shared. Configuration text, raw commands and changed values remain excluded.' };
    this.coverage.replaceChildren(h('h3', 'Coverage and device pairing'),
      h('p.hint', `Before saved ${date(report.before.savedAt)}; after saved ${date(report.after.savedAt)}. Collection times are retained in the original reports.`),
      ...(report.devices || []).map((device) => h('article.snapshot-coverage-item', h('strong', device.deviceLabel), ` · ${device.status} · ${device.pairing} pairing`,
        (device.warnings || []).map((warning) => h('p.hint', warning)))),
      ...(report.unmatched || []).map((device) => h('p.notice', `${device.side}: ${device.deviceLabel} · ${device.reason}`)),
      ...(report.warnings || []).map((warning) => h('p.notice', warning)),
      report.sensitive ? h('p.notice', 'This comparison contains captured configuration. Its local evidence and JSON export can contain credentials. AI context includes only counts and coverage.') : null);
    this.renderRows(); this.renderChange();
  }

  renderRows() {
    const query = this.search.value.trim().toLocaleLowerCase();
    const rows = (this.report?.changes || []).map((change, index) => ({ ...change, _index: index })).filter((change) =>
      (!this.category.value || change.category === this.category.value) && (!this.changeStatus.value || change.status === this.changeStatus.value) &&
      (!query || [change.deviceLabel, change.identity, change.category, change.status].some((value) => shown(value).toLocaleLowerCase().includes(query))));
    this.page = Math.max(0, Math.min(this.page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1)));
    const start = this.page * PAGE_SIZE; this.table.setRows(rows.slice(start, start + PAGE_SIZE));
    this.count.textContent = rows.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} changes` : '0 matching changes';
    this.previousButton.disabled = this.page === 0; this.nextButton.disabled = start + PAGE_SIZE >= rows.length;
  }

  renderChange(change) {
    if (!change) { this.detail.replaceChildren(h('p.hint', 'Select a change to inspect its before and after observations.')); return; }
    this.detail.replaceChildren(h('h3', `${change.deviceLabel} · ${shown(change.identity)} · ${statuses[change.status] || change.status}`),
      change.reason ? h('p.notice', change.reason) : null,
      ...Object.entries(change.counterDeltas || {}).map(([name, value]) => h('p.hint', `${name}: ${value.delta == null ? 'Unknown delta' : '+' + value.delta} · ${value.reason}`)),
      h('div.snapshot-evidence-columns', ...['before', 'after'].map((side) => {
        const value = change[side], text = Array.isArray(value?.lines) ? value.lines.join('\n') : shown(value), source = change[side + 'Source'];
        const evidence = h('div.snapshot-source');
        const button = h('button.btn.sm', { disabled: !source, onclick: () => this.renderSource(evidence, side, source) }, 'View source command');
        return h('section.snapshot-side', h('h4', side === 'before' ? 'Before' : 'After'), button,
          h('pre', text.slice(0, 65536) + (text.length > 65536 ? '\n[Preview limited. Export the comparison for all retained values.]' : '')), evidence);
      })));
  }

  renderSource(container, side, source) {
    const device = this.records?.[side].report.devices.find((entry) => entry.id === source.deviceId);
    const command = device?.commands.find((entry) => entry.id === source.commandId);
    if (!command) { container.replaceChildren(h('p.hint', 'Source command is unavailable in this snapshot.')); return; }
    const lines = command.output.split(/\r?\n/), start = Number.isInteger(source.line) ? Math.max(0, source.line - 6) : 0;
    container.replaceChildren(h('p.hint', `${command.command} · ${command.status} · lines ${start + 1}–${Math.min(start + 120, lines.length)} of ${lines.length}`),
      h('pre', lines.slice(start, start + 120).map((line, index) => h('span', { class: start + index + 1 === source.line ? 'snapshot-source-line' : '' }, `${start + index + 1}  ${line}\n`))));
  }

  async open(id, kind = 'device') {
    if (!id || this.busy || this.disposed) return;
    const request = ++this.seq; this.busy = true; this.updateButtons();
    try {
      const record = await api.invoke('tools:snapshotGet', id);
      if (this.disposed || request !== this.seq) return;
      if (!record) throw new Error('Snapshot no longer available. Refresh history.');
      if (kind === 'topology') { this.app.openTool('topology', { report: record.report }); return; }
      const tab = this.app.openTool('device'); tab.acceptReport(record.report);
      tab.status.textContent = `Saved snapshot “${record.label}” · ${date(record.savedAt)}. Collection times remain recorded per device.`;
    } catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); } }
  }

  async remove(id) {
    if (!id || this.busy || this.disposed) return;
    const record = this.snapshots.find((entry) => entry.id === id); if (!record) return;
    const request = ++this.seq; this.busy = true; this.updateButtons();
    let removed = false;
    try {
      const accepted = await confirmDialog(`Delete snapshot “${record.label}”?`, { title: 'Delete device snapshot', okLabel: 'Delete snapshot', danger: true, detail: 'This removes the saved local report. Export a copy first if it is still needed.' });
      if (!accepted || this.disposed || request !== this.seq) return;
      await api.invoke('tools:snapshotRemove', id); removed = true;
    } catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); if (removed) await this.refresh(); } }
  }

  async export() {
    if (!this.report || this.busy || this.disposed) return;
    const report = this.report;
    try { const file = await api.invoke('dialog:saveText', 'konx-snapshot-comparison.json', JSON.stringify(report, null, 2)); if (file && !this.disposed) toast('Saved ' + file, 'ok'); }
    catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
  }

  show() { this.active = true; }
  hide() { this.active = false; }
  focus() { this.refreshButton.focus(); }
  statusSegments() { return [{ icon: 'columns', text: 'Device Snapshots' }, { text: this.report ? `${this.report.changes.length} changes` : `${this.snapshots.length} snapshots` }]; }
  dispose() { this.disposed = true; ++this.seq; }
}
