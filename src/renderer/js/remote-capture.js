import { h, icon, api, toast, errMsg, fmtBytes, confirmDialog } from './ui.js';

const time = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown';
const metadata = (items) => h('dl.remote-capture-metadata', items.map(([key, value]) => [h('dt', key), h('dd', value == null || value === '' ? 'Unknown' : String(value))]));

/** A bounded capture over an explicitly selected, already connected SSH session. */
export class RemoteCaptureTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'remote-capture'; this.title = 'Remote Capture'; this.icon = 'capture';
    this.id = 'remote-capture-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.disposed = false;
    this.jobId = null; this.seq = 0; this.requestSeq = 0; this.connectionSeq = 0; this.busy = false; this.report = null; this.connections = [];
    this.connection = h('select.input', { 'aria-label': 'Connected SSH capture session', onchange: () => this.updateButtons() }, h('option', { value: '' }, 'Choose a connected SSH session'));
    this.refreshButton = h('button.btn', { onclick: () => this.refreshConnections() }, icon('refresh'), 'Refresh sessions');
    this.terminalButton = h('button.btn', { disabled: true, onclick: () => this.openTerminal() }, icon('terminal'), 'Open terminal');
    this.interface = h('input.input', { value: params.interface || 'any', maxLength: 64, 'aria-label': 'Remote capture interface', placeholder: 'any or eth0' });
    this.duration = h('input.input', { type: 'number', min: 1, max: 300, value: params.duration ?? 30, 'aria-label': 'Capture duration in seconds' });
    this.packetLimit = h('input.input', { type: 'number', min: 1, max: 100000, value: params.packetLimit ?? 1000, 'aria-label': 'Maximum packets' });
    this.filter = h('input.input', { value: params.filter || '', maxLength: 2048, placeholder: 'Optional BPF, e.g. udp port 5060 or portrange 10000-20000', 'aria-label': 'Remote BPF capture filter', spellcheck: false });
    this.startButton = h('button.btn.primary', { disabled: true, onclick: () => this.start() }, icon('play'), 'Start remote capture');
    this.stopButton = h('button.btn', { disabled: true, onclick: () => this.stop() }, icon('stop'), 'Stop');
    this.openButton = h('button.btn', { disabled: true, onclick: () => this.openCapture() }, icon('capture'), 'Open retained capture');
    this.deleteButton = h('button.btn', { disabled: true, onclick: () => this.removeCapture() }, icon('trash'), 'Delete retained capture');
    this.exportButton = h('button.btn', { disabled: true, onclick: () => this.exportReport() }, icon('download'), 'Export report JSON');
    this.status = h('div.remote-capture-status', { role: 'status', 'aria-live': 'polite' }, 'Choose an existing SSH session connected to a Linux capture host.');
    this.progress = h('div.remote-capture-progress');
    this.summary = h('div.remote-capture-summary', h('p.hint', 'No remote capture has been collected in this tab.'));
    this.content = h('div.remote-capture-content', this.progress, this.summary);
    this.el = h('div.view.remote-capture-view', h('div.tool-head', h('div.tool-title', icon('capture'), h('h2', 'Remote Capture'), h('span.sub', 'Capture Linux traffic over an existing SSH connection')),
      h('div.remote-capture-actions', this.connection, this.refreshButton, this.terminalButton),
      h('div.remote-capture-fields', this.field('Interface', this.interface), this.field('Duration · seconds (1–300)', this.duration), this.field('Packet limit (1–100,000)', this.packetLimit)),
      this.field('BPF capture filter', this.filter),
      h('details.remote-capture-requirements', h('summary', 'Remote requirements and collection scope'), h('p', 'The selected Linux host needs tcpdump, GNU timeout and existing capture permission for the connected account. Starting runs a bounded capture command; KonX does not install tools or request sudo.'),
        h('p', 'Traffic is streamed through SSH into a local capture, up to 64 MiB. Stop signals the capture channel. The existing SSH terminal remains available.'),
        h('p', 'Use a duration and packet limit appropriate for the traffic you are authorized to collect. Capture results describe this observation point, not all network traffic.')),
      h('div.remote-capture-actions', this.startButton, this.stopButton, this.openButton, this.exportButton, this.deleteButton), this.status), this.content);
    this.ready = this.refreshConnections(params.connectionId);
  }
  field(label, input) { return h('label.field', h('span', label), input); }
  terminal() { const tab = this.app.byId.get(this.connection.value); return tab?.kind === 'terminal' && tab.protocol === 'ssh' && tab.state === 'connected' ? tab : null; }
  updateButtons() {
    const running = Boolean(this.jobId), available = Boolean(this.report?.captureId && !this.report.captureUnavailable);
    this.connection.disabled = this.refreshButton.disabled = this.busy || running;
    for (const field of [this.interface, this.duration, this.packetLimit, this.filter]) field.disabled = this.busy || running;
    this.startButton.disabled = this.busy || running || !this.connections.some((entry) => entry.id === this.connection.value);
    this.stopButton.disabled = !running || this.cancelRequested;
    this.openButton.disabled = this.deleteButton.disabled = this.busy || running || !available;
    this.exportButton.disabled = this.busy || running || !this.report;
    this.terminalButton.disabled = !this.terminal();
  }
  async refreshConnections(preferred = this.connection.value) {
    if (this.disposed || this.busy || this.jobId) return;
    const seq = ++this.connectionSeq; this.busy = true; this.updateButtons();
    try {
      const connections = await api.invoke('tools:deviceConnections'); if (this.disposed || seq !== this.connectionSeq) return;
      this.connections = connections;
      this.connection.replaceChildren(h('option', { value: '' }, 'Choose a connected SSH session'),
        ...connections.map((entry) => h('option', { value: entry.id }, `${entry.label || entry.host} · ${entry.host}`)));
      this.connection.value = connections.some((entry) => entry.id === preferred) ? preferred : '';
      this.status.textContent = connections.length ? 'Select a Linux SSH session and start a bounded capture.' : 'No connected SSH sessions. Connect through Sessions, then refresh this list.';
    } catch (error) { if (!this.disposed && seq === this.connectionSeq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && seq === this.connectionSeq) { this.busy = false; this.updateButtons(); } }
  }
  openTerminal() { const terminal = this.terminal(); if (terminal) this.app.activate(terminal); else toast('The selected SSH terminal is no longer connected.', 'err'); }
  async start() {
    if (this.disposed || this.jobId || this.busy) return;
    const connectionId = this.connection.value, duration = Number(this.duration.value), packetLimit = Number(this.packetLimit.value);
    if (!this.connections.some((entry) => entry.id === connectionId)) { this.status.textContent = 'Choose a connected SSH session first.'; return; }
    if (!this.interface.value.trim() || !Number.isInteger(duration) || duration < 1 || duration > 300 || !Number.isInteger(packetLimit) || packetLimit < 1 || packetLimit > 100000) {
      this.status.textContent = 'Enter an interface, a duration of 1–300 seconds, and a packet limit of 1–100,000.'; return;
    }
    const id = this.id + ':' + ++this.seq; this.jobId = id; this.cancelRequested = false; this.receivedReport = false; this.reportError = null;
    this.state = 'running'; this.progress.replaceChildren(); this.app.registerJob(id, this); this.app.tabStateChanged(this); this.updateButtons();
    this.status.textContent = this.report ? 'Starting remote capture. The previous retained result stays visible below.' : 'Starting remote capture…';
    try { await api.invoke('tools:start', 'remote-capture', { connectionId, interface: this.interface.value.trim(), duration, packetLimit, filter: this.filter.value }, id); }
    catch (error) { if (!this.disposed && this.jobId === id) this.onJobEvent('error', { message: errMsg(error) }); }
  }
  async stop() {
    if (!this.jobId || this.cancelRequested) return;
    const id = this.jobId; this.cancelRequested = true; this.updateButtons(); this.status.textContent = 'Stopping the capture channel; waiting for retained file cleanup…';
    try { await api.invoke('tools:stop', id); }
    catch (error) { if (!this.disposed && this.jobId === id) { this.status.textContent = errMsg(error); this.cancelRequested = false; this.updateButtons(); } }
  }
  onJobEvent(type, data = {}) {
    if (this.disposed || !this.jobId) return;
    if (type === 'progress') {
      this.progress.replaceChildren(h('strong', data.phase || 'Collecting'), h('span', `${data.packets ?? 0} packets · ${fmtBytes(data.bytes || 0)}`));
      if (!this.cancelRequested) this.status.textContent = 'Remote capture is running. Stop retains any complete packet prefix.';
    }
    if (type === 'report') {
      if (data.kind !== 'remote-capture' || data.schemaVersion !== 1 || !Array.isArray(data.warnings)) this.reportError = 'The remote collector returned an invalid report.';
      else { this.report = data; this.receivedReport = true; this.renderReport(); }
    }
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId); this.jobId = null; this.state = 'idle'; this.app.tabStateChanged(this); this.updateButtons();
      this.progress.replaceChildren();
      this.status.textContent = type === 'error' ? data.message || 'Remote capture failed.' : this.reportError || (this.receivedReport ?
        this.report.stopped ? 'Capture stopped. Review retained packets and remote termination status.' : this.report.complete ? 'Bounded capture completed. Open the retained file to inspect traffic.' : 'Partial capture retained. Review warnings and remote exit status.' :
        this.cancelRequested || data.stopped ? 'Capture stopped before a usable file was retained.' : 'No usable remote capture was returned.');
      this.app.updateStatus(this);
    }
  }
  renderReport() {
    const report = this.report; if (!report) return;
    this.summary.replaceChildren(h('h3', 'Last retained capture'),
      metadata([['Host', report.host], ['Interface', report.interface], ['Capture filter', report.filter || 'All packets visible on the selected interface'],
        ['Started', time(report.startedAt)], ['Finished', time(report.finishedAt)], ['Retained packets', report.packets], ['Retained size', fmtBytes(report.bytes || 0)],
        ['File', report.fileName], ['Collection result', report.stopped ? 'Stopped' : report.complete ? 'Bounded capture completed' : 'Partial / incomplete'],
        ['Remote exit confirmed', report.remoteExitConfirmed === true ? 'Yes' : 'Unknown'], ['Exit code', report.exitCode], ['Exit signal', report.exitSignal],
        ['Local availability', report.captureUnavailable ? 'Deleted from this tab’s retained library' : report.captureId ? 'Available in this app session' : 'No usable capture retained']]),
      h('p.hint', 'Completion means the bounded operation delivered a valid file. It does not establish that every network packet was observed.'),
      ...report.warnings.map((warning) => h('p.notice', warning)),
      report.stderr ? h('details', { open: true }, h('summary', 'Remote capture diagnostics'), h('pre.remote-capture-diagnostics', report.stderr)) : null,
      h('p.hint', 'Open the capture to inspect packets, SIP calls or RTP media, save a copy, or add it to an incident. Retained file controls work during this app session; profile files remain after restart.'));
    this.updateButtons();
  }
  async openCapture() {
    if (this.disposed || this.busy || this.jobId || !this.report?.captureId || this.report.captureUnavailable) return;
    const seq = ++this.requestSeq, report = this.report; this.busy = true; this.updateButtons();
    try {
      const result = await api.invoke('tools:remoteCaptureRead', report.captureId); if (this.disposed || seq !== this.requestSeq || report !== this.report) return;
      const tab = this.app.openTool('capture'); await tab.loadBytes(result.bytes, result.name);
    } catch (error) { if (!this.disposed && seq === this.requestSeq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && seq === this.requestSeq) { this.busy = false; this.updateButtons(); } }
  }
  async removeCapture() {
    if (this.disposed || this.busy || this.jobId || !this.report?.captureId || this.report.captureUnavailable) return;
    const report = this.report, approved = await confirmDialog('Delete this retained remote capture file?', { title: 'Delete retained capture', okLabel: 'Delete capture', danger: true,
      detail: 'The capture report stays visible. Copies already saved or added to an incident remain available.' });
    if (!approved || this.disposed || this.busy || this.jobId || this.report !== report) return;
    const seq = ++this.requestSeq; this.busy = true; this.updateButtons();
    try {
      await api.invoke('tools:remoteCaptureRemove', report.captureId); if (this.disposed || seq !== this.requestSeq) return;
      report.captureUnavailable = true; this.renderReport(); this.status.textContent = 'Retained capture deleted. The collection report remains visible.';
    } catch (error) { if (!this.disposed && seq === this.requestSeq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && seq === this.requestSeq) { this.busy = false; this.updateButtons(); } }
  }
  async exportReport() {
    if (!this.report || this.busy || this.jobId || this.disposed) return;
    const seq = ++this.requestSeq; this.busy = true; this.updateButtons();
    try { const file = await api.invoke('dialog:saveText', 'konx-remote-capture.json', JSON.stringify(this.report, null, 2)); if (file && !this.disposed) toast('Collection report saved'); }
    catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
    finally { if (!this.disposed && seq === this.requestSeq) { this.busy = false; this.updateButtons(); } }
  }
  updateBlockers() { return this.jobId ? ['Stop the remote capture and wait for cleanup.'] : this.busy ? ['Wait for the remote capture file operation.'] : []; }
  async requestClose() {
    if (this.busy) { toast('Wait for the retained capture operation to finish.', 'err'); return false; }
    if (!this.jobId) return true;
    await this.stop(); toast('Stopping remote capture. Close this tab after cleanup finishes.'); return false;
  }
  show() { this.active = true; this.updateButtons(); }
  hide() { this.active = false; }
  focus() { this.connection.focus(); }
  statusSegments() { return [{ icon: 'capture', text: 'Remote Capture' }, { text: this.jobId ? 'Collecting / stopping…' : this.report ? `${this.report.packets} retained packets` : 'Ready' }]; }
  dispose() { this.disposed = true; this.connectionSeq++; this.requestSeq++; if (this.jobId) { this.stop(); this.app.unregisterJob(this.jobId); this.jobId = null; } }
}
