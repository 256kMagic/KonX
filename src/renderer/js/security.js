import { installTrafficContext, trafficCopilotButton } from './copilot-traffic-ui.js';
import { h, icon, api, DataTable, toast, errMsg } from './ui.js';
import { validateReport, summary, compareReports, exportReport } from './security-report.mjs';

const AUDITS = [
  ['windows', 'Windows — this PC', 'Read-only local protection and configuration checks. Restricted or unavailable checks remain Unknown.'],
  ['windows-remote', 'Windows — remote service exposure', 'Check common Windows service ports on one host from this PC. This does not inspect remote settings or log in.'],
  ['tls', 'TLS & certificate auditor', 'Validate a certificate and inspect the negotiated connection. Use the DNS hostname for SNI and hostname checks.'],
  ['ssh', 'SSH security auditor', 'Inspect a pre-authentication handshake and host key without credentials or opening a shell.'],
  ['web', 'Web security headers', 'Inspect an HTTP/HTTPS URL, response headers, redirects, and cookie attributes.'],
  ['exposure', 'Service exposure review', 'Check a bounded set of management service ports on one host, from this PC.'],
  ['config', 'Device configuration auditor', 'Review Cisco IOS/IOS-XE/NX-OS-style text locally. Reports retain rule names and line numbers, not secret values.'],
  ['capture', 'Saved capture security findings', 'Inspect a saved PCAP/PCAPNG for supported security observations with packet references.'],
];
const BASELINE_KEY = 'konx.security.baselines.v1';

export class SecurityTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'security'; this.icon = 'shield';
    this.id = 'security-' + Math.random().toString(36).slice(2); this.title = 'Security Suite';
    this.state = 'idle'; this.jobId = null; this.seq = 0; this.disposed = false;
    this.report = null; this.filePath = null; this.comparison = null;
    installTrafficContext(this);
    this.audit = h('select.input', { 'aria-label': 'Security assessment' }, AUDITS.map(([value, label]) => h('option', { value }, label)));
    this.audit.value = AUDITS.some(([kind]) => kind === params.audit) ? params.audit : params.host ? 'exposure' : 'windows';
    this.host = h('input.input', { value: params.host || '', placeholder: 'Hostname or IP', spellcheck: false, 'aria-label': 'Assessment host or configuration label' });
    this.port = h('input.input', { type: 'number', min: 1, max: 65535, 'aria-label': 'Assessment port' });
    this.url = h('input.input', { value: params.url || '', placeholder: 'https://device.example/', spellcheck: false, 'aria-label': 'Assessment URL' });
    this.config = h('textarea.input', { placeholder: 'Paste a supported device configuration, or choose a local file.', spellcheck: false, 'aria-label': 'Device configuration' });
    this.fileLabel = h('span.hint', 'No file selected');
    this.pickButton = h('button.btn', { onclick: () => this.pickFile() }, icon('folder'), 'Choose file');
    this.runButton = h('button.btn.primary', { onclick: () => this.jobId ? this.stop() : this.start() }, icon('play'), 'Run assessment');
    this.description = h('p.notice');
    this.status = h('div.security-progress', { role: 'status', 'aria-live': 'polite' }, 'Choose an assessment and run it when ready.');
    this.hostField = h('label.field', h('span', 'Host'), this.host);
    this.portField = h('label.field', h('span', 'Port'), this.port);
    this.urlField = h('label.field', h('span', 'URL'), this.url);
    this.fileField = h('div.security-file', this.pickButton, this.fileLabel);
    this.inputs = h('div.security-inputs', this.hostField, this.portField, this.urlField, this.fileField);
    this.filter = h('select.input', { 'aria-label': 'Filter assessment results', onchange: () => this.renderFindings() },
      [['all', 'All results'], ['fail', 'Failed checks'], ['warning', 'Warnings'], ['unknown', 'Unknown'], ['pass', 'Passed checks'], ['info', 'Information']].map(([value, label]) => h('option', { value }, label)));
    this.baselineButton = h('button.btn.sm', { onclick: () => this.saveBaseline(), disabled: true }, 'Set baseline');
    this.compareButton = h('button.btn.sm', { onclick: () => this.compareBaseline(), disabled: true }, 'Compare baseline');
    this.jsonButton = h('button.btn.sm', { onclick: () => this.export('json'), disabled: true }, 'Export JSON');
    this.htmlButton = h('button.btn.sm', { onclick: () => this.export('html'), disabled: true }, 'Export HTML');
    this.reportHeading = h('div.security-report-heading');
    this.counts = h('div.security-counts');
    this.baselineStatus = h('p.hint', 'Baselines are saved only when you choose Set baseline, in this Windows profile.');
    this.table = new DataTable({
      columns: [
        { key: 'status', label: 'Result', width: 100, render: (check) => h('span.security-badge', { 'data-status': check.status }, check.status) },
        { key: 'severity', label: 'Severity', width: 90 },
        { key: 'title', label: 'Check' },
        { key: 'confidence', label: 'Confidence', width: 95 },
        { key: 'change', label: 'Baseline', width: 100 },
      ], rowKey: (check) => check.id, multi: false, emptyText: 'No assessment results yet.',
    });
    this.table.onSelect = (checks) => this.renderDetail(checks[0]);
    this.detail = h('div.security-detail', 'Select a result to inspect its evidence and recommendation.');
    this.limitations = h('div.security-limitations');
    this.el = h('div.view.security-view',
      h('div.tool-head', h('div.tool-title', icon('shield'), h('h2', 'KonX Security'), h('span.sub', 'Windows, service and configuration assessments')),
        h('div.tool-form', h('label.field', h('span', 'Assessment'), this.audit), this.runButton), this.description,
        this.inputs, this.config, this.status),
      h('div.security-results', this.reportHeading, this.counts,
        h('div.security-actions', trafficCopilotButton(this), this.filter, this.baselineButton, this.compareButton, this.jsonButton, this.htmlButton),
        this.baselineStatus, h('div.security-split', this.table.el, this.detail), this.limitations));
    this.audit.addEventListener('change', () => { this.filePath = null; this.fileLabel.textContent = 'No file selected'; this.updateInputs(); });
    this.config.addEventListener('input', () => { if (this.config.value) { this.filePath = null; this.fileLabel.textContent = 'Using pasted configuration'; } });
    this.updateInputs();
  }

  updateInputs() {
    const kind = this.audit.value;
    this.description.textContent = AUDITS.find(([value]) => value === kind)[2];
    this.hostField.classList.toggle('hidden', !['windows-remote', 'tls', 'ssh', 'exposure', 'config'].includes(kind));
    this.hostField.firstChild.textContent = kind === 'config' ? 'Configuration label (optional)' : 'Host';
    this.host.placeholder = kind === 'config' ? 'Configuration label for reports/baselines' : 'Hostname or IP';
    this.portField.classList.toggle('hidden', !['tls', 'ssh'].includes(kind));
    this.port.value = kind === 'ssh' ? '22' : '443';
    this.urlField.classList.toggle('hidden', kind !== 'web');
    this.fileField.classList.toggle('hidden', !['config', 'capture'].includes(kind));
    this.config.classList.toggle('hidden', kind !== 'config');
    this.inputs.classList.toggle('hidden', kind === 'windows');
  }

  async pickFile() {
    const audit = this.audit.value;
    try {
      const path = await api.invoke('dialog:openFile', { title: audit === 'capture' ? 'Open capture for security review' : 'Open device configuration',
        filters: audit === 'capture' ? [{ name: 'Packet captures', extensions: ['pcapng', 'pcap', 'cap', 'dmp'] }] : [{ name: 'Configuration files', extensions: ['txt', 'cfg', 'conf', 'log'] }, { name: 'All files', extensions: ['*'] }] });
      if (!path || this.disposed || this.jobId || this.audit.value !== audit) return;
      this.filePath = path; this.config.value = '';
      this.fileLabel.textContent = path.split(/[\\/]/).pop();
    } catch (error) { toast(errMsg(error), 'err'); }
  }

  params() {
    const audit = this.audit.value;
    const result = { audit };
    if (['windows-remote', 'tls', 'ssh', 'exposure'].includes(audit)) {
      result.host = this.host.value.trim();
      if (!result.host) throw new Error('Enter a hostname or IP address');
    }
    if (['tls', 'ssh'].includes(audit)) {
      result.port = Number(this.port.value);
      if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('Enter a port from 1 to 65535');
    }
    if (audit === 'web') { result.url = this.url.value.trim(); if (!result.url) throw new Error('Enter an HTTP or HTTPS URL'); }
    if (audit === 'config') {
      result.label = this.host.value.trim();
      if (this.filePath) result.filePath = this.filePath;
      else { result.text = this.config.value; if (!result.text.trim()) throw new Error('Paste or choose a supported configuration'); }
    }
    if (audit === 'capture') { if (!this.filePath) throw new Error('Choose a packet capture'); result.filePath = this.filePath; }
    return result;
  }

  setRunning(on) {
    this.state = on ? 'running' : 'idle';
    for (const control of [this.audit, this.host, this.port, this.url, this.config, this.pickButton]) control.disabled = on;
    this.runButton.replaceChildren(icon(on ? 'stop' : 'play'), on ? 'Cancel assessment' : 'Run assessment');
    this.app.tabStateChanged(this);
  }

  async start() {
    if (this.disposed || this.jobId) return;
    let params;
    try { params = this.params(); } catch (error) { return toast(errMsg(error), 'err'); }
    const id = this.id + ':' + ++this.seq;
    this.report = null; this.comparison = null; this.cancelRequested = false;
    this.renderReport(); this.jobId = id; this.app.registerJob(id, this); this.setRunning(true);
    this.status.textContent = 'Starting assessment…';
    try { await api.invoke('tools:start', 'security', params, id); }
    catch (error) { if (!this.disposed && this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }

  async stop() {
    if (!this.jobId) return;
    this.cancelRequested = true; this.status.textContent = 'Cancelling assessment…';
    try { await api.invoke('tools:stop', this.jobId); }
    catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
  }

  onJobEvent(type, data) {
    if (this.disposed) return;
    if (type === 'progress') this.status.textContent = data.phase;
    if (type === 'report' && !this.cancelRequested) {
      try { this.report = validateReport(data); this.renderReport(); }
      catch (error) { this.status.textContent = errMsg(error); toast(errMsg(error), 'err'); }
    }
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId); this.jobId = null; this.setRunning(false);
      this.status.textContent = this.cancelRequested || data.stopped ? 'Assessment cancelled.' : type === 'error' ? data.message : this.report ? 'Assessment complete.' : 'No report was produced.';
      if (type === 'error' && !this.cancelRequested) toast(data.message, 'err');
    }
  }

  renderReport() {
    this.copilot.acceptReport(this.report);
    for (const button of [this.baselineButton, this.compareButton, this.jsonButton, this.htmlButton]) button.disabled = !this.report;
    for (const button of [this.baselineButton, this.compareButton]) button.disabled = !this.report?.scopeId;
    this.reportHeading.textContent = this.report ? `${this.report.title} · ${this.report.target} · ${new Date(this.report.scannedAt).toLocaleString()}` : 'Assessment results';
    this.counts.replaceChildren(...(this.report ? Object.entries(summary(this.report)).map(([status, count]) => h('span.security-badge', { 'data-status': status }, `${count} ${status}`)) : []));
    this.limitations.replaceChildren(...(this.report ? [h('h3', 'Scope and limitations'), h('ul', this.report.limitations.map((item) => h('li', item)))] : []));
    this.baselineStatus.textContent = this.report && !this.report.scopeId ? 'To use baselines for pasted configuration, add a distinct configuration label and run the assessment again.' : 'Set baseline saves this report in the current Windows profile. Unknown checks are not passes.';
    this.renderFindings(); this.renderDetail();
  }

  renderFindings() {
    const changes = new Map(this.comparison?.changes.map((change) => [change.id, change]) || []);
    this.table.setRows((this.report?.checks || []).filter((check) => this.filter.value === 'all' || check.status === this.filter.value).map((check) => ({ ...check, change: changes.get(check.id)?.change || '' })));
  }

  renderDetail(check) {
    if (!check) return this.detail.replaceChildren(h('p.hint', 'Select a result to inspect its evidence and recommendation.'));
    this.detail.replaceChildren(h('h3', check.title), h('p', `${check.status} · ${check.severity} severity · ${check.confidence} confidence`),
      h('h4', 'Evidence'), h('p.security-evidence', check.evidence || 'No evidence available.'),
      h('h4', 'Recommendation'), h('p', check.remediation || 'Review the observation in the context of your environment.'),
      /^https:\/\//i.test(check.reference) ? h('button.btn.sm', { onclick: () => api.invoke('app:openExternal', check.reference) }, 'Reference documentation') : null);
  }

  baselines() {
    const saved = localStorage.getItem(BASELINE_KEY) || '{}';
    if (saved.length > 2000000) throw new Error('Stored baseline collection is too large');
    const values = JSON.parse(saved);
    if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Stored baselines are invalid');
    return values;
  }

  saveBaseline() {
    if (!this.report?.scopeId) return;
    try {
      const saved = this.baselines();
      saved[this.report.scopeId] = this.report;
      const entries = Object.entries(saved).sort((a, b) => b[1].scannedAt.localeCompare(a[1].scannedAt)).slice(0, 10);
      const data = JSON.stringify(Object.fromEntries(entries));
      if (data.length > 2000000) throw new Error('Baseline storage limit reached; export this report instead');
      localStorage.setItem(BASELINE_KEY, data);
      this.baselineStatus.textContent = 'Baseline saved for ' + this.report.target + '.';
    } catch (error) { toast(errMsg(error), 'err'); }
  }

  compareBaseline() {
    if (!this.report?.scopeId) return;
    try {
      const baseline = this.baselines()[this.report.scopeId];
      if (!baseline) throw new Error('No baseline saved for this assessment target');
      this.comparison = compareReports(this.report, baseline);
      const counts = { new: 0, changed: 0, unchanged: 0 };
      for (const change of this.comparison.changes) counts[change.change]++;
      this.baselineStatus.textContent = `${counts.new} new · ${counts.changed} changed · ${counts.unchanged} unchanged · ${this.comparison.removed.length} no longer reported. Baseline: ${new Date(this.comparison.scannedAt).toLocaleString()}.`;
      this.renderFindings();
    } catch (error) { toast(errMsg(error), 'err'); }
  }

  async export(format) {
    if (!this.report) return;
    try {
      const report = this.report;
      const text = exportReport(report, format);
      const file = await api.invoke('dialog:saveText', `konx-security-${report.kind}-${report.scannedAt.slice(0, 10)}.${format}`, text);
      if (file && !this.disposed) toast('Saved ' + file, 'ok');
    } catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
  }

  show() { this.active = true; }
  hide() { this.active = false; }
  focus() { this.audit.focus(); }
  statusSegments() { return [{ icon: 'shield', text: 'Security Suite' }, { text: this.state === 'running' ? 'Assessing…' : 'Ready' }]; }
  dispose() { this.disposed = true; if (this.jobId) { this.stop(); this.app.unregisterJob(this.jobId); this.jobId = null; } }
}

export function createSecurityTool(app, params) { return new SecurityTab(app, params); }
