import { installTrafficContext, trafficCopilotButton } from './copilot-traffic-ui.js';
import { h, icon, api, DataTable, toast, errMsg } from './ui.js';

const shown = (value, suffix = '') => value == null || value === '' ? 'Unknown' : String(value) + suffix;
const networkName = (row) => row.ssid || (row.hidden ? '(hidden SSID)' : '(SSID unavailable)');

export class WifiTab {
  constructor(app) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'wifi'; this.icon = 'wifi'; this.title = 'Wi-Fi Tools';
    this.id = 'wifi-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.jobId = null; this.seq = 0;
    this.disposed = false; this.report = null;
    installTrafficContext(this);
    this.runButton = h('button.btn.primary', { onclick: () => this.jobId ? this.stop() : this.start() }, icon('refresh'), 'Refresh Wi-Fi snapshot');
    this.jsonButton = h('button.btn', { disabled: true, onclick: () => this.export() }, icon('download'), 'Export JSON');
    this.status = h('div.wireless-status', { role: 'status', 'aria-live': 'polite' }, 'Ready. Refresh to read this PC’s wireless adapters and nearby network cache.');
    this.search = h('input.input', { placeholder: 'Filter SSID or BSSID', 'aria-label': 'Filter Wi-Fi networks', oninput: () => this.renderNetworks() });
    this.band = h('select.input', { 'aria-label': 'Wi-Fi band', onchange: () => this.renderNetworks() },
      ['All bands', '2.4 GHz', '5 GHz', '6 GHz', 'Unknown'].map((band) => h('option', { value: band }, band)));
    this.adapters = new DataTable({ columns: [
      { key: 'name', label: 'Adapter' }, { key: 'state', label: 'State', width: 120 },
      { key: 'ssid', label: 'Connected SSID', render: (row) => row.connection ? networkName(row.connection) : '—' },
      { key: 'signalPercent', label: 'Signal', width: 90, render: (row) => shown(row.connection?.signalPercent, '%') },
      { key: 'rxMbps', label: 'Rx Mbps', width: 85, render: (row) => shown(row.connection?.rxMbps) },
      { key: 'txMbps', label: 'Tx Mbps', width: 85, render: (row) => shown(row.connection?.txMbps) },
    ], rowKey: (row) => row.id, multi: false, emptyText: 'No adapter snapshot yet.' });
    this.adapters.onSelect = (rows) => this.renderAdapter(rows[0]);
    this.networks = new DataTable({ columns: [
      { key: 'ssid', label: 'SSID', render: networkName }, { key: 'bssid', label: 'BSSID', width: 155, mono: true },
      { key: 'band', label: 'Band', width: 85 }, { key: 'channel', label: 'Channel', width: 75, render: (row) => shown(row.channel) },
      { key: 'signalPercent', label: 'Signal', width: 75, render: (row) => shown(row.signalPercent, '%') },
      { key: 'authentication', label: 'Authentication', width: 140, render: (row) => shown(row.authentication) },
      { key: 'connected', label: 'Connected', width: 90, render: (row) => row.connected ? 'Yes' : '—' },
    ], rowKey: (row) => [row.adapterId, row.bssid, row.ssid].join('|'), multi: false, emptyText: 'No nearby BSSID observations to display.' });
    this.networks.onSelect = (rows) => this.renderDetail(rows[0]);
    this.detail = h('div.wireless-detail', 'Select a BSSID to view signal, security, and observation details.');
    this.channelRows = h('div.wifi-channels');
    this.findings = h('div.wireless-findings');
    this.limitations = h('div.wireless-limitations');
    this.heading = h('div.wireless-heading', 'Wi-Fi survey');
    this.el = h('div.view.wireless-view.wifi-view',
      h('div.tool-head', h('div.tool-title', icon('wifi'), h('h2', 'Wi-Fi Tools'), h('span.sub', 'Adapters, nearby BSSIDs, channel counts and security observations')),
        h('p.notice', 'Windows cached radio observations. Refresh reads the current cache; it does not force a radio scan. Windows location permission may be required.'),
        h('div.wireless-actions', trafficCopilotButton(this), this.runButton, this.jsonButton), this.status),
      h('div.wireless-content', this.heading, h('h3', 'Wireless adapters'), this.adapters.el,
        h('div.wireless-actions', h('h3', 'Nearby networks'), this.search, this.band), this.networks.el, this.detail,
        h('h3', 'Observed BSSIDs per channel'), h('p.hint', 'Counts describe visible access-point radios, not measured airtime utilization or interference. Overlapping channels can still compete.'), this.channelRows,
        h('h3', 'Security and connection observations'), this.findings, this.limitations));
  }

  setRunning(on) {
    this.state = on ? 'running' : 'idle';
    this.runButton.replaceChildren(icon(on ? 'stop' : 'refresh'), on ? 'Cancel refresh' : 'Refresh Wi-Fi snapshot');
    this.app.tabStateChanged(this);
  }

  async start() {
    if (this.disposed || this.jobId) return;
    const id = this.id + ':' + ++this.seq;
    this.cancelRequested = false; this.reportReceived = false; this.reportError = null; this.jobId = id; this.app.registerJob(id, this); this.setRunning(true);
    this.status.textContent = 'Reading the Windows wireless cache…';
    try { await api.invoke('tools:start', 'wifi', { action: 'survey' }, id); }
    catch (error) { if (!this.disposed && this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }

  async stop() {
    if (!this.jobId) return;
    const id = this.jobId; this.cancelRequested = true; this.status.textContent = 'Cancelling Wi-Fi refresh…';
    try { await api.invoke('tools:stop', id); }
    catch (error) { if (!this.disposed && this.jobId === id) toast(errMsg(error), 'err'); }
  }

  onJobEvent(type, data = {}) {
    if (this.disposed) return;
    if (type === 'progress' && !this.cancelRequested) this.status.textContent = data.phase || 'Reading wireless observations…';
    if (type === 'report' && !this.cancelRequested) {
      if (data.schemaVersion !== 1 || data.kind !== 'wifi' || !['adapters', 'networks', 'channels', 'findings', 'limitations'].every((key) => Array.isArray(data[key]))) {
        this.reportError = 'The Wi-Fi provider returned an invalid report.';
      } else { this.report = data; this.reportReceived = true; this.reportError = null; this.renderReport(); }
    }
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId); this.jobId = null; this.setRunning(false);
      this.status.textContent = this.cancelRequested || data.stopped ? 'Wi-Fi refresh cancelled. Previous observations remain visible.' : type === 'error' ? data.message : this.reportError || (this.reportReceived ? 'Wi-Fi snapshot refreshed.' : 'No new Wi-Fi report was produced. Previous observations remain visible.');
      if (type === 'error' && !this.cancelRequested) toast(data.message, 'err');
    }
  }

  renderReport() {
    this.copilot.acceptReport(this.report);
    const report = this.report;
    this.jsonButton.disabled = !report;
    this.heading.textContent = report ? `Cache retrieved ${new Date(report.collectedAt).toLocaleString()} · ${report.adapters.length} adapters · ${report.networks.length} BSSID observations` : 'Wi-Fi survey';
    this.adapters.setRows(report?.adapters || []); this.renderNetworks(); this.renderDetail();
    const channels = report?.channels || [];
    const max = Math.max(1, ...channels.map((row) => Number(row.bssidCount) || 0));
    this.channelRows.replaceChildren(...channels.map((row) => h('div.wifi-channel', h('span', `${row.band} · ch ${shown(row.channel)}`),
      h('div.wifi-channel-track', h('div.wifi-channel-bar', { style: { width: `${Math.max(0, Math.min(100, (Number(row.bssidCount) || 0) / max * 100))}%` } })),
      h('span', `${row.bssidCount} BSSIDs · strongest ${shown(row.strongestRssiDbm, ' dBm')}`))));
    if (!channels.length) this.channelRows.append(h('p.hint', 'No channel observations available.'));
    this.findings.replaceChildren(...(report?.findings || []).map((check) => h('article.wireless-observation',
      h('h4', h('span.wireless-badge', { 'data-status': check.status }, check.status), ' ', check.title),
      h('p', check.evidence), check.remediation ? h('p.hint', check.remediation) : null)));
    if (!report?.findings.length) this.findings.append(h('p.hint', 'No security observations are available. This is not a vulnerability assessment of the access points.'));
    this.limitations.replaceChildren(...(report ? [h('h3', 'Coverage and limitations'), h('ul', report.limitations.map((line) => h('li', line)))] : []));
  }

  renderNetworks() {
    const query = this.search.value.trim().toLocaleLowerCase();
    this.networks.setRows((this.report?.networks || []).filter((row) => (this.band.value === 'All bands' || row.band === this.band.value) &&
      (!query || [row.ssid, row.bssid].some((value) => String(value || '').toLocaleLowerCase().includes(query)))));
  }

  renderDetail(row) {
    if (!row) return this.detail.replaceChildren(h('p.hint', 'Select a BSSID to view signal, security, and observation details.'));
    this.detail.replaceChildren(h('h3', networkName(row)), h('dl.wireless-facts',
      [['BSSID', row.bssid], ['Adapter', this.report?.adapters.find((adapter) => adapter.id === row.adapterId)?.name || row.adapterId],
        ['Frequency', shown(row.frequencyMHz, ' MHz')], ['RSSI', shown(row.rssiDbm, ' dBm')], ['Signal quality', shown(row.signalPercent, '%')],
        ['Authentication', shown(row.authentication)], ['Pairwise encryption', shown(row.encryption)], ['Group encryption', shown(row.groupEncryption)],
        ['Security enabled', row.securityEnabled == null ? 'Unknown' : row.securityEnabled ? 'Yes' : 'No'],
        ['Radio observation timestamp', row.observedAt || row.hostTimestamp ? new Date(row.observedAt || row.hostTimestamp).toLocaleString() : 'Unavailable; snapshot may be cached']]
        .map(([label, value]) => [h('dt', label), h('dd', value)])));
  }

  renderAdapter(row) {
    if (!row) return this.renderDetail();
    const connection = row.connection;
    this.detail.replaceChildren(h('h3', row.name), h('dl.wireless-facts',
      [['State', row.state], ['Connected SSID', connection ? networkName(connection) : 'Not connected or unavailable'],
        ['Connected BSSID', connection?.bssid || 'Unknown'], ['Authentication', connection?.authentication || 'Unknown'], ['Encryption', connection?.encryption || 'Unknown']]
        .map(([label, value]) => [h('dt', label), h('dd', value)])),
      row.issues?.length ? h('ul', row.issues.map((issue) => h('li', issue))) : null);
  }

  async export() {
    if (!this.report) return;
    const report = this.report; const text = JSON.stringify(report, null, 2);
    try {
      const file = await api.invoke('dialog:saveText', `konx-wifi-${String(report.collectedAt).slice(0, 10)}.json`, text);
      if (file && !this.disposed) toast('Saved ' + file, 'ok');
    } catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
  }

  show() { this.active = true; }
  hide() { this.active = false; }
  focus() { this.runButton.focus(); }
  statusSegments() { return [{ icon: 'wifi', text: 'Wi-Fi Tools' }, { text: this.state === 'running' ? 'Reading cache…' : 'Ready' }]; }
  dispose() { this.disposed = true; if (this.jobId) { this.stop(); this.app.unregisterJob(this.jobId); this.jobId = null; } }
}

export function createWifiTool(app, params) { return new WifiTab(app, params); }
