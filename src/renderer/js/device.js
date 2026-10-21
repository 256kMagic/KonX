import { h, icon, api, DataTable, toast, errMsg, promptText } from './ui.js';

const shown = (value) => value == null || value === '' ? 'Unknown' : Array.isArray(value) ? value.join(', ') : String(value);
const PAGE_SIZE = 100;
const FACTS = {
  interfaces: ['Interfaces', [['name', 'Interface'], ['description', 'Description'], ['status', 'State'], ['protocol', 'Protocol'], ['vlan', 'VLAN'], ['duplex', 'Duplex'], ['speed', 'Speed'], ['inputErrors', 'Input errors'], ['crc', 'CRC'], ['outputErrors', 'Output errors']]],
  vlans: ['VLANs', [['id', 'VLAN'], ['name', 'Name'], ['status', 'State'], ['ports', 'Ports']]],
  mac: ['MAC table', [['mac', 'MAC'], ['vlan', 'VLAN'], ['type', 'Type'], ['interface', 'Interface']]],
  arp: ['ARP', [['ip', 'IP address'], ['mac', 'MAC'], ['age', 'Age'], ['interface', 'Interface']]],
  neighbors: ['Neighbors', [['protocol', 'Protocol'], ['deviceId', 'Neighbor'], ['managementAddress', 'Management address'], ['localInterface', 'Local interface'], ['remoteInterface', 'Remote interface'], ['capabilities', 'Capabilities']]],
  poe: ['PoE', [['interface', 'Interface'], ['admin', 'Admin'], ['oper', 'State'], ['powerWatts', 'Watts'], ['device', 'Device'], ['class', 'Class'], ['maxWatts', 'Maximum watts']]],
  routes: ['Routes', [['prefix', 'Prefix'], ['protocol', 'Protocol'], ['nextHop', 'Next hop'], ['interface', 'Interface'], ['distance', 'Distance'], ['metric', 'Metric']]],
};
const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown time';

/** Device facts and endpoint paths retain their command evidence in the same report. */
export class DeviceTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'device'; this.title = 'Device Inspector'; this.icon = 'server';
    this.id = 'device-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.seq = 0; this.jobId = null;
    this.report = null; this.disposed = false; this.requestSeq = 0; this.traceSeq = 0; this.connectionSeq = 0;
    this.connections = []; this.selectedConnections = new Set(); this.page = 0;
    this.status = h('div.device-status', { role: 'status', 'aria-live': 'polite' }, 'Connect an SSH terminal, then collect its Cisco IOS/IOS-XE observations. Load demo to explore without a device.');
    this.collectButton = h('button.btn.primary', { onclick: () => this.jobId ? this.stop() : this.start() }, icon('refresh'), 'Collect selected');
    this.refreshButton = h('button.btn.sm', { onclick: () => this.refreshConnections() }, icon('refresh'), 'Refresh connections');
    this.importButton = h('button.btn', { onclick: () => this.load('tools:deviceImport') }, icon('folder-open'), 'Load report');
    this.demoButton = h('button.btn', { onclick: () => this.load('tools:deviceDemo') }, icon('play'), 'Load demo');
    this.exportButton = h('button.btn', { disabled: true, onclick: () => this.export() }, icon('download'), 'Export JSON');
    this.snapshotButton = h('button.btn', { disabled: true, onclick: () => this.saveSnapshot() }, icon('download'), 'Save snapshot');
    this.historyButton = h('button.btn', { onclick: () => this.app.openTool('snapshots') }, icon('columns'), 'Snapshot history');
    this.includeConfig = h('input', { type: 'checkbox', checked: params.profile === 'snapshot', 'aria-label': 'Include configuration and routes' });
    this.connectionList = h('div.device-connections');
    this.connectionSummary = h('summary', 'Connected SSH devices');
    this.connectionDetails = h('details.device-connection-picker', { open: true }, this.connectionSummary,
      h('div.device-actions', this.refreshButton), this.connectionList);
    this.heading = h('div.device-heading', 'No device observations loaded');
    this.deviceSelect = h('select.input', { 'aria-label': 'Inspected device', onchange: () => this.renderDevice() });
    this.terminalButton = h('button.btn', { disabled: true, onclick: () => this.openTerminal(this.currentDevice()) }, icon('terminal'), 'Open terminal');
    this.overview = h('div.device-overview');
    this.warnings = h('div.device-warnings');
    this.factSelect = h('select.input', { 'aria-label': 'Device observation table', onchange: () => { this.page = 0; this.createTable(); } },
      Object.entries(FACTS).map(([key, [label]]) => h('option', { value: key }, label)));
    this.search = h('input.input', { placeholder: 'Filter observations', 'aria-label': 'Filter device observations', oninput: () => { this.page = 0; this.renderRows(); } });
    this.tableHost = h('div.device-table-host');
    this.count = h('span.hint');
    this.previousButton = h('button.btn.sm', { onclick: () => { this.page--; this.renderRows(); } }, 'Previous');
    this.nextButton = h('button.btn.sm', { onclick: () => { this.page++; this.renderRows(); } }, 'Next');
    this.commandSelect = h('select.input', { 'aria-label': 'Device source command', onchange: () => this.renderEvidence() });
    this.evidenceHeading = h('div.device-evidence-heading');
    this.raw = h('pre.device-raw', { tabIndex: 0, 'aria-label': 'Captured command output' });
    this.evidence = h('details.device-evidence', h('summary', 'Command evidence'), this.commandSelect, this.evidenceHeading, this.raw);
    this.query = h('input.input', { placeholder: 'IP or MAC address', value: params.query || '', 'aria-label': 'Find endpoint IP or MAC', onkeydown: (event) => { if (event.key === 'Enter') this.find(); } });
    this.findButton = h('button.btn.primary', { disabled: true, onclick: () => this.find() }, icon('search'), 'Find device');
    this.traceStatus = h('p.hint', { role: 'status', 'aria-live': 'polite' }, 'Search across all devices in this report.');
    this.traceResults = h('div.device-trace-results');
    this.limitations = h('div.device-limitations');
    this.content = h('div.device-content', this.heading,
      h('div.device-actions', this.deviceSelect, this.terminalButton), this.overview, this.warnings,
      h('div.device-actions', this.factSelect, this.search), this.tableHost,
      h('div.device-actions', this.count, this.previousButton, this.nextButton), this.evidence,
      h('section.device-trace', h('h3', 'Find this IP or MAC'),
        h('div.device-actions', this.query, this.findButton), this.traceStatus, this.traceResults), this.limitations);
    this.el = h('div.view.device-view', h('div.tool-head',
      h('div.tool-title', icon('server'), h('h2', 'Device Inspector'), h('span.sub', 'Cisco interfaces, VLANs, neighbors and endpoint paths')),
      h('p.notice', 'Collection uses separate SSH channels for read-only show commands. Incomplete output and uncertain endpoint paths remain visible.'),
      h('div.device-actions', this.collectButton, this.importButton, this.demoButton, this.exportButton, this.snapshotButton, this.historyButton),
      h('label.device-connection', this.includeConfig, 'Include configuration and routes'),
      h('p.hint', 'Running configuration can contain credentials. Snapshot files and exports retain the captured configuration locally.'),
      this.status, this.connectionDetails), this.content);
    this.createTable(); this.updateButtons(); this.ready = this.refreshConnections();
  }

  async refreshConnections() {
    if (this.disposed || this.jobId || this.loading) return;
    const request = ++this.connectionSeq;
    this.refreshButton.disabled = true;
    try {
      const rows = await api.invoke('tools:deviceConnections');
      if (this.disposed || request !== this.connectionSeq) return;
      this.connections = rows;
      const existing = new Set(rows.map((row) => row.id));
      this.selectedConnections = new Set([...this.selectedConnections].filter((id) => existing.has(id)));
      this.renderConnections();
    } catch (error) { if (!this.disposed && request === this.connectionSeq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.connectionSeq) { this.refreshButton.disabled = false; this.updateButtons(); } }
  }

  renderConnections() {
    this.connectionList.replaceChildren(...this.connections.map((connection) => {
      const input = h('input', { type: 'checkbox', checked: this.selectedConnections.has(connection.id),
        'aria-label': 'Collect ' + (connection.label || connection.host), onchange: () => {
          input.checked ? this.selectedConnections.add(connection.id) : this.selectedConnections.delete(connection.id); this.updateButtons();
        } });
      return h('label.device-connection', input, h('span', connection.label || connection.host), h('span.hint', connection.host));
    }));
    if (!this.connections.length) this.connectionList.append(h('p.hint', 'No connected SSH terminals. Open one from Sessions or Quick Connect, then refresh.'));
    this.updateButtons();
  }

  updateButtons() {
    const busy = !!this.jobId || !!this.loading;
    this.collectButton.disabled = !!this.loading || (!this.jobId && !this.selectedConnections.size);
    this.importButton.disabled = busy; this.demoButton.disabled = busy; this.refreshButton.disabled = busy;
    this.exportButton.disabled = busy || !this.report;
    this.snapshotButton.disabled = busy || !this.report; this.includeConfig.disabled = busy;
    this.findButton.disabled = !this.report || busy || !!this.tracing;
    this.connectionSummary.textContent = `Connected SSH devices · ${this.selectedConnections.size} selected`;
    for (const input of this.connectionList.querySelectorAll('input')) input.disabled = busy;
  }

  setRunning(on) {
    this.state = on ? 'running' : 'idle';
    this.collectButton.replaceChildren(icon(on ? 'stop' : 'refresh'), on ? 'Cancel collection' : 'Collect selected');
    this.collectButton.classList.toggle('danger', on); this.updateButtons(); this.app.tabStateChanged(this);
  }

  async start() {
    if (this.disposed || this.jobId || this.loading || !this.selectedConnections.size) return;
    const id = this.id + ':' + ++this.seq;
    this.cancelRequested = false; this.reportReceived = false; this.reportError = null; this.jobId = id;
    ++this.requestSeq; ++this.traceSeq; this.tracing = false;
    this.app.registerJob(id, this); this.setRunning(true); this.status.textContent = 'Collecting selected device observations…';
    try { await api.invoke('tools:start', 'device', { connectionIds: [...this.selectedConnections], profile: this.includeConfig.checked ? 'snapshot' : 'inventory', includeRunningConfig: this.includeConfig.checked }, id); }
    catch (error) { if (!this.disposed && this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }

  async stop() {
    if (!this.jobId) return;
    const id = this.jobId; this.cancelRequested = true;
    this.status.textContent = 'Cancelling collection…';
    try { await api.invoke('tools:stop', id); }
    catch (error) { if (!this.disposed && this.jobId === id) toast(errMsg(error), 'err'); }
  }

  onJobEvent(type, data = {}) {
    if (this.disposed) return;
    if (type === 'progress' && !this.cancelRequested) this.status.textContent = data.phase || 'Collecting observations…';
    if (type === 'report' && !this.cancelRequested) {
      try { this.acceptReport(data); this.reportReceived = true; }
      catch (error) { this.reportError = errMsg(error); }
    }
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId); this.jobId = null; this.setRunning(false);
      this.status.textContent = this.cancelRequested || data.stopped ? 'Collection cancelled. The previous report remains available.'
        : type === 'error' ? data.message : this.reportError || (this.reportReceived ? 'Collection finished. Review command coverage and warnings below.' : 'No report was produced.');
    }
  }

  async load(channel) {
    if (this.disposed || this.jobId || this.loading) return;
    const request = ++this.requestSeq; this.loading = true; this.updateButtons();
    try {
      const report = await api.invoke(channel);
      if (this.disposed || request !== this.requestSeq || !report) return;
      this.acceptReport(report); this.status.textContent = channel === 'tools:deviceDemo' ? 'Synthetic demo loaded. No network connection was made.' : 'Saved report loaded; observations reflect the recorded collection time.';
    } catch (error) { if (!this.disposed && request === this.requestSeq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.requestSeq) { this.loading = false; this.updateButtons(); } }
  }

  acceptReport(report) {
    if (report?.kind !== 'device' || report.schemaVersion !== 1 || !Array.isArray(report.devices) || !Array.isArray(report.limitations)) throw new Error('Invalid device report.');
    for (const device of report.devices) if (!device.facts || !Array.isArray(device.commands) || !Array.isArray(device.warnings)) throw new Error('Invalid device observations.');
    this.report = report; this.trace = null; ++this.traceSeq; this.tracing = false;
    this.traceResults.replaceChildren(); this.traceStatus.textContent = 'Search across all devices in this report.';
    this.deviceSelect.replaceChildren(...report.devices.map((device) => h('option', { value: device.id }, `${device.label || device.host || device.id} · ${device.host || 'Unknown address'}`)));
    this.heading.textContent = `${report.devices.length} device(s) · report collected ${date(report.collectedAt)}`;
    this.limitations.replaceChildren(h('h3', 'Coverage'), h('ul', report.limitations.map((line) => h('li', line))));
    this.renderDevice(); this.updateButtons(); this.app.updateStatus(this);
  }

  currentDevice() { return this.report?.devices.find((device) => device.id === this.deviceSelect.value); }

  renderDevice() {
    const device = this.currentDevice(); this.page = 0;
    this.terminalButton.disabled = !this.terminalFor(device);
    const fields = device ? [['Collected', date(device.collectedAt)], ...[['hostname', 'Hostname'], ['version', 'Software version'], ['model', 'Model'], ['uptime', 'Uptime'], ['image', 'System image']].map(([key, label]) => [label, device.facts.version?.[key]])] : [];
    this.overview.replaceChildren(h('dl.device-facts', fields.map(([key, value]) => [h('dt', key), h('dd', shown(value))])));
    this.warnings.replaceChildren(...(device?.warnings || []).map((warning) => h('p.notice', typeof warning === 'string' ? warning : JSON.stringify(warning))));
    this.commandSelect.replaceChildren(...(device?.commands || []).map((command) => h('option', { value: command.id }, `${command.command} · ${command.status}`)));
    this.table?.selected.clear(); this.renderEvidence(); this.renderRows();
  }

  createTable() {
    const [, columns] = FACTS[this.factSelect.value];
    this.table = new DataTable({ columns: columns.map(([key, label]) => ({ key, label, render: (row) => shown(row[key]) })),
      rowKey: (row) => row._index, multi: false, emptyText: 'No matching parsed observations. Check command evidence for missing or unsupported output.' });
    this.table.onSelect = ([row]) => row && this.showSource(this.currentDevice(), row.source);
    this.tableHost.replaceChildren(this.table.el); this.renderRows();
  }

  renderRows() {
    if (!this.table) return;
    const query = this.search.value.trim().toLocaleLowerCase();
    const rows = (this.currentDevice()?.facts[this.factSelect.value] || []).map((row, index) => ({ ...row, _index: index }))
      .filter((row) => !query || Object.entries(row).some(([key, value]) => key !== 'source' && shown(value).toLocaleLowerCase().includes(query)));
    this.page = Math.max(0, Math.min(this.page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1)));
    const start = this.page * PAGE_SIZE; this.table.setRows(rows.slice(start, start + PAGE_SIZE));
    this.count.textContent = rows.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} matching observations` : '0 matching observations';
    this.previousButton.disabled = this.page === 0; this.nextButton.disabled = start + PAGE_SIZE >= rows.length;
  }

  showSource(device, source) {
    if (!device || !source) return;
    if (this.deviceSelect.value !== device.id) { this.deviceSelect.value = device.id; this.renderDevice(); }
    this.commandSelect.value = source.commandId; this.evidence.open = true; this.renderEvidence(source.line);
    this.evidence.scrollIntoView({ block: 'nearest' });
  }

  renderEvidence(line) {
    const command = this.currentDevice()?.commands.find((entry) => entry.id === this.commandSelect.value);
    if (!command) { this.evidenceHeading.textContent = 'No captured command output.'; this.raw.textContent = ''; return; }
    const lines = String(command.output || '').split(/\r?\n/);
    const start = Number.isInteger(line) && line > 0 ? Math.max(0, line - 6) : 0;
    const selected = lines.slice(start, start + 200);
    this.evidenceHeading.textContent = `${command.command} · ${command.status}${command.error ? ' · ' + command.error : ''} · lines ${start + 1}–${start + selected.length} of ${lines.length}. Export JSON retains the full captured output.`;
    this.raw.replaceChildren(...selected.map((text, index) => h('span', { class: start + index + 1 === line ? 'device-source-line' : '' }, `${start + index + 1}  ${text}\n`)));
  }

  terminalFor(device) {
    const tab = device?.connectionId && this.app.byId.get(device.connectionId);
    return tab?.kind === 'terminal' && tab.protocol === 'ssh' && tab.state === 'connected' ? tab : null;
  }

  openTerminal(device) {
    const tab = this.terminalFor(device);
    if (tab) this.app.activate(tab); else toast('The original SSH terminal is no longer connected. Reconnect it through Sessions.', 'err');
  }

  async find() {
    if (!this.report || this.disposed || this.jobId || this.loading || this.tracing) return;
    const report = this.report, request = ++this.traceSeq; this.tracing = true; this.updateButtons();
    this.traceStatus.textContent = 'Matching captured ARP, MAC and neighbor observations…';
    try {
      const result = await api.invoke('tools:deviceTrace', report.devices, this.query.value.trim());
      if (this.disposed || request !== this.traceSeq || report !== this.report) return;
      this.trace = result; this.renderTrace(result);
    } catch (error) { if (!this.disposed && request === this.traceSeq) { this.trace = null; this.traceResults.replaceChildren(); this.traceStatus.textContent = errMsg(error); } }
    finally { if (!this.disposed && request === this.traceSeq) { this.tracing = false; this.updateButtons(); } }
  }

  renderTrace(result) {
    this.traceStatus.textContent = `${result.matches.length} matching observation(s) for ${result.query}. Candidate edge ports are not proof of a directly attached endpoint.`;
    this.traceResults.replaceChildren(...result.warnings.map((warning) => h('p.notice', warning)),
      ...result.matches.map((match) => {
        const device = this.report.devices.find((item) => item.id === match.deviceId);
        return h('article.device-match', h('strong', `${match.deviceLabel || match.host} · ${match.interface}`),
          h('p', `${match.mac} · VLAN ${shown(match.vlan)} · ${match.classification} · port ${shown(match.portStatus)}`),
          h('div.device-actions', h('button.btn.sm', { onclick: () => this.showSource(device, match.source) }, 'View evidence'),
            h('button.btn.sm', { disabled: !this.terminalFor(device), onclick: () => this.openTerminal(device) }, 'Open terminal')),
          (match.warnings || []).map((warning) => h('p.hint', warning)));
      }),
      ...result.paths.map((path) => h('article.device-path', h('strong', `${path.mac} · VLAN ${shown(path.vlan)} · ${path.status}`),
        h('ol', path.steps.map((step) => h('li', `${step.deviceLabel || step.host} / ${step.interface}${step.remoteDeviceId ? ' → ' + step.remoteDeviceId + ' / ' + shown(step.remoteInterface) : ''}`))), h('p.hint', path.reason))));
    if (!result.matches.length) this.traceResults.append(h('p.hint', 'No matching observation was captured. This does not establish that the device is absent.'));
  }

  async export() {
    if (!this.report || this.jobId || this.loading) return;
    try { const file = await api.invoke('tools:deviceExport', this.report); if (file && !this.disposed) toast('Saved ' + file, 'ok'); }
    catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
  }

  async saveSnapshot() {
    if (!this.report || this.disposed || this.jobId || this.loading) return;
    const report = this.report, request = ++this.requestSeq;
    this.loading = true; this.updateButtons();
    try {
      const label = await promptText('Save device snapshot', 'Snapshot name', 'Before maintenance', 'Save snapshot');
      if (!label || this.disposed || request !== this.requestSeq) return;
      const saved = await api.invoke('tools:snapshotSave', { label, report });
      if (!this.disposed && request === this.requestSeq) this.status.textContent = `Saved snapshot “${saved.label}”. Open Snapshot history to compare observations.`;
    } catch (error) { if (!this.disposed && request === this.requestSeq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.requestSeq) { this.loading = false; this.updateButtons(); } }
  }

  show() { this.active = true; this.terminalButton.disabled = !this.terminalFor(this.currentDevice()); }
  hide() { this.active = false; }
  focus() { this.demoButton.focus(); }
  statusSegments() { return [{ icon: 'server', text: 'Device Inspector' }, { text: this.state === 'running' ? 'Collecting…' : `${this.report?.devices.length || 0} devices` }]; }
  dispose() { this.disposed = true; ++this.requestSeq; ++this.traceSeq; ++this.connectionSeq; if (this.jobId) { this.stop(); this.app.unregisterJob(this.jobId); this.jobId = null; } }
}
