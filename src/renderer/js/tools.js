// Network tool tabs: ping monitor, sweep, port scanner, traceroute, DNS, whois,
// subnet calculator, Wake-on-LAN and interface / ARP info.
import { h, icon, api, DataTable, contextMenu, toast, errMsg, fmtMs, csv, buildFields } from './ui.js';
import { CaptureTab } from './capture.js';
import { createSecurityTool } from './security.js';
import { createWifiTool } from './wifi.js';
import { createMistTool } from './mist.js';
import { AITab } from './ai.js';
import { DeviceTab } from './device.js';
import { SnapshotTab } from './snapshots.js';
import { IncidentTab } from './incidents.js';

export const TOOLS = [
  { kind: 'incidents', label: 'Incident Workspace', icon: 'file', desc: 'Collect local evidence and notes, inspect observation timelines and export incident reports' },
  { kind: 'snapshots', label: 'Device Snapshots', icon: 'columns', desc: 'Save device observations and compare configuration, interfaces, VLANs, neighbors and routes before and after changes' },
  { kind: 'device', label: 'Device Inspector', icon: 'server', desc: 'Inspect Cisco interfaces, VLANs and neighbors, and find observed IP/MAC switch ports' },
  { kind: 'ai', label: 'AI & Knowledge', icon: 'insight', desc: 'Ask an AI to explain results and browse the offline tool and vendor reference library' },
  { kind: 'wifi', label: 'Wi-Fi Tools', icon: 'wifi', desc: 'Wireless adapters, visible access points, signal, channel crowding and security observations' },
  { kind: 'mist', label: 'Mist & Marvis', icon: 'cloud', desc: 'Connect to Juniper Mist for AP/client monitoring and Marvis troubleshooting' },
  { kind: 'security', label: 'Security Suite', icon: 'shield', desc: 'Windows assessment, TLS/SSH auditing, service exposure, web headers, configuration and capture review' },
  { kind: 'capture', label: 'Packet Capture', icon: 'capture', desc: 'Capture and decode traffic with plain-English insights, or open .pcap files' },
  { kind: 'ping', label: 'Ping Monitor', icon: 'activity', desc: 'Continuous ping of one or many hosts with loss, jitter and history' },
  { kind: 'sweep', label: 'Network Sweep', icon: 'radar', desc: 'Find live hosts on a subnet or range, with names and MACs' },
  { kind: 'portscan', label: 'Port Scanner', icon: 'target', desc: 'TCP connect scan with service names and banner grabbing' },
  { kind: 'traceroute', label: 'Traceroute', icon: 'route', desc: 'Trace the path and per-hop latency to a host' },
  { kind: 'dns', label: 'DNS Lookup', icon: 'globe', desc: 'Query any record type against any DNS server' },
  { kind: 'whois', label: 'Whois', icon: 'search', desc: 'Domain, IP and ASN registration lookup' },
  { kind: 'subnet', label: 'Subnet Calculator', icon: 'calc', desc: 'IPv4 / IPv6 network, range, mask and subnet splitting' },
  { kind: 'wol', label: 'Wake-on-LAN', icon: 'power', desc: 'Send a magic packet to wake a machine' },
  { kind: 'netinfo', label: 'Interfaces & ARP', icon: 'network', desc: 'Local adapters, addresses and the ARP cache' },
];

const AUTH_NOTE = 'Only scan hosts and networks you own or are authorized to test.';

// ---------------------------------------------------------------- IPv4 helpers

export function ipToInt(ip) {
  const p = String(ip).trim().split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    n = n * 256 + Number(x);
  }
  return n;
}
export const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const ipSort = (ip) => ipToInt(ip) ?? Number.MAX_SAFE_INTEGER;

/** Shared right-click actions for a host found by any tool. */
export function hostMenuItems(app, host, port) {
  const items = [
    { label: `SSH to ${host}`, icon: 'terminal', action: () => app.quickConnect({ protocol: 'ssh', host, port: port && port !== 23 ? port : 22 }) },
    { label: `Telnet to ${host}`, icon: 'terminal', action: () => app.quickConnect({ protocol: 'telnet', host, port: port === 23 || !port ? 23 : port }) },
    { label: 'SFTP', icon: 'file-transfer', action: () => app.quickSftp({ host, port: port === 22 || !port ? 22 : port }) },
  ];
  if (port && ![22, 23].includes(port)) items.push({ label: `Raw TCP to port ${port}`, icon: 'plug', action: () => app.quickConnect({ protocol: 'raw', host, port }) });
  const web = port && [80, 81, 3000, 5000, 8000, 8008, 8080, 8081, 8088, 8888, 9000, 9090].includes(port) ? 'http' : port && [443, 4443, 8443, 9443, 10443].includes(port) ? 'https' : null;
  if (web || !port) {
    items.push({ label: `Open ${web || 'http'}://${host}${port && ![80, 443].includes(port) ? ':' + port : ''}`, icon: 'globe', action: () => api.invoke('app:openExternal', `${web || 'http'}://${host}${port && ![80, 443].includes(port) ? ':' + port : ''}/`) });
  }
  items.push(
    '-',
    { label: 'Ping', icon: 'activity', action: () => app.openTool('ping', { hosts: host }) },
    { label: 'Port scan', icon: 'target', action: () => app.openTool('portscan', { targets: host }) },
    { label: 'Security review', icon: 'shield', action: () => app.openTool('security', { host }) },
    { label: 'Traceroute', icon: 'route', action: () => app.openTool('traceroute', { host }) },
    { label: 'DNS lookup', icon: 'globe', action: () => app.openTool('dns', { name: host }) },
    { label: 'Capture traffic', icon: 'capture', action: () => app.openTool('capture', { filter: `host ${host}`, captureFilter: `host ${host}` }) },
    '-',
    { label: 'Copy', icon: 'copy', action: () => api.invoke('clipboard:write', host) }
  );
  return items;
}

// ---------------------------------------------------------------- base

class ToolView {
  constructor(app, def, params = {}) {
    this.app = app;
    this.def = def;
    this.params = params;
    this.kind = 'tool';
    this.toolKind = def.kind;
    this.id = `x-${def.kind}-${Math.random().toString(36).slice(2, 8)}`;
    this.title = def.label;
    this.icon = def.icon;
    this.state = 'idle';
    this.jobId = null;
    this.jobSeq = 0;
    this.disposed = false;
    this.el = h('div.view');
  }

  header(form, opts = {}) {
    return h(
      'div.tool-head',
      h('div.tool-title', icon(this.def.icon), h('h2', this.def.label), h('span.sub', this.def.desc)),
      h('div.tool-form', form),
      opts.note ? h('p.notice', opts.note) : null
    );
  }

  runButton(label = 'Start') {
    this.btn = h('button.btn.primary', { onclick: () => (this.jobId ? this.stop() : this.start()) }, icon('play'), label);
    this.btnLabel = label;
    return this.btn;
  }

  setRunning(on) {
    this.state = on ? 'running' : 'idle';
    if (this.btn) this.btn.replaceChildren(icon(on ? 'stop' : 'play'), on ? 'Stop' : this.btnLabel);
    this.btn && this.btn.classList.toggle('danger', on);
    this.btn && this.btn.classList.toggle('primary', !on);
    this.app.tabStateChanged(this);
  }

  async runJob(kind, params) {
    if (this.disposed || this.jobId) return;
    // Subscribe before starting: validation errors and short jobs can finish
    // before the tools:start IPC reply reaches this window.
    const id = `${this.id}:${++this.jobSeq}`;
    this.jobId = id;
    this.app.registerJob(id, this);
    this.started = Date.now();
    this.setRunning(true);
    try {
      await api.invoke('tools:start', kind, params, id);
    } catch (e) {
      if (this.disposed || this.jobId !== id) return;
      this.app.unregisterJob(id);
      this.jobId = null;
      this.setRunning(false);
      toast(errMsg(e), 'err');
    }
  }

  async stop() {
    if (this.jobId) await api.invoke('tools:stop', this.jobId);
  }

  onJobEvent(type, data) {
    if (this.disposed) return;
    if (type === 'done' || type === 'error') {
      this.app.unregisterJob(this.jobId);
      this.jobId = null;
      this.setRunning(false);
      if (type === 'error') toast(data.message, 'err');
    }
    this.onEvent(type, data);
  }

  onEvent() {}

  show() {
    this.active = true;
  }

  hide() {
    this.active = false;
  }

  focus() {
    const i = this.el.querySelector('input');
    if (i) i.focus();
  }

  statusSegments() {
    return [{ icon: this.def.icon, text: this.def.label }, this.state === 'running' ? { text: 'Running', cls: 'warn' } : { text: 'Idle' }];
  }

  async exportCsv(name, header, rows) {
    const p = await api.invoke('dialog:saveText', name, csv([header, ...rows]));
    if (p) toast('Saved ' + p, 'ok');
  }

  dispose() {
    this.disposed = true;
    this.stop().catch(() => {});
    if (this.jobId) this.app.unregisterJob(this.jobId);
    this.jobId = null;
  }
}

function field(label, input, cls = '') {
  return h('label.field', { class: cls }, h('span', label), input);
}
function num(value, min, max) {
  return h('input', { type: 'number', value, min, max });
}
function check(label, checked) {
  const cb = h('input', { type: 'checkbox', checked });
  return [h('label.check', cb, label), cb];
}

// ---------------------------------------------------------------- ping

class PingTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.hosts = h('input', { value: params.hosts || '', placeholder: '8.8.8.8, 1.1.1.1, router.lan', spellcheck: false });
    this.count = num(params.count ?? 0, 0);
    this.interval = num(1000, 100);
    this.timeout = num(1000, 100);
    this.size = num(32, 0, 65500);
    this.hosts.addEventListener('keydown', (e) => e.key === 'Enter' && this.start());
    this.stats = new Map();
    this.table = new DataTable({
      columns: [
        { key: 'host', label: 'Host', width: 170 },
        { key: 'ip', label: 'IP', width: 130, mono: true, sort: (r) => ipSort(r.ip) },
        { key: 'status', label: 'Status', width: 80, render: (r) => h('span.pill', { class: r.status === 'Up' ? 'ok' : r.status === 'Down' ? 'err' : 'muted' }, r.status) },
        { key: 'sent', label: 'Sent', width: 60, num: true },
        { key: 'recv', label: 'Recv', width: 60, num: true },
        { key: 'loss', label: 'Loss', width: 66, num: true, render: (r) => (r.sent ? r.loss.toFixed(1) + '%' : '') },
        { key: 'last', label: 'Last', width: 74, num: true, render: (r) => (r.lastOk ? fmtMs(r.last) : r.sent ? '—' : '') },
        { key: 'min', label: 'Min', width: 70, num: true, render: (r) => fmtMs(r.min) },
        { key: 'avg', label: 'Avg', width: 70, num: true, render: (r) => fmtMs(r.avg) },
        { key: 'max', label: 'Max', width: 70, num: true, render: (r) => fmtMs(r.max) },
        { key: 'jitter', label: 'Jitter', width: 70, num: true, render: (r) => fmtMs(r.jitter) },
        { key: 'hist', label: 'History', width: 180, sortable: false, render: (r) => r.canvas },
      ],
      rowKey: (r) => r.host,
      emptyText: 'Enter one or more hosts and press Start.',
      onContext: (e, rows) => rows[0] && contextMenu(e.clientX, e.clientY, hostMenuItems(this.app, rows[0].ip || rows[0].host)),
    });
    this.log = h('div.log');
    this.summary = h('div.tool-summary', h('span', 'Idle'));
    this.el.append(
      this.header([
        field('Hosts', this.hosts, 'wide'),
        field('Count (0 = ∞)', this.count, 'num'),
        field('Interval ms', this.interval, 'num'),
        field('Timeout ms', this.timeout, 'num'),
        field('Size', this.size, 'num'),
        this.runButton('Start'),
      ]),
      this.summary,
      h('div.tool-split', this.table.el, this.log)
    );
    this.renderSoon = throttle(() => this.render(), 250);
    if (params.hosts) setTimeout(() => this.start(), 0);
  }

  start() {
    if (this.disposed || this.jobId) return;
    const hosts = this.hosts.value.trim();
    if (!hosts) return toast('Enter at least one host');
    this.stats.clear();
    for (const host of hosts.split(/[\s,;]+/).filter(Boolean)) this.stats.set(host, this.newStat(host));
    this.log.replaceChildren();
    this.title = 'Ping ' + hosts.split(/[\s,;]+/)[0] + (this.stats.size > 1 ? ` +${this.stats.size - 1}` : '');
    this.app.setTabTitle(this, this.title);
    this.render();
    this.runJob('ping', {
      hosts,
      count: Number(this.count.value) || 0,
      interval: Number(this.interval.value) || 1000,
      timeout: Number(this.timeout.value) || 1000,
      size: Number(this.size.value) || 32,
    });
  }

  newStat(host) {
    const canvas = h('canvas.spark', { width: 320, height: 40 });
    return { host, ip: '', status: '…', sent: 0, recv: 0, loss: 0, last: null, lastOk: false, min: null, max: null, avg: null, sum: 0, jitter: null, jsum: 0, prev: null, hist: [], canvas };
  }

  onEvent(type, d) {
    if (type === 'resolved') {
      const s = this.stats.get(d.host);
      if (s) s.ip = d.ip;
    } else if (type === 'reply') {
      const s = this.stats.get(d.host);
      if (!s) return;
      if (d.seq > 0) s.sent++;
      if (d.ok) {
        s.recv++;
        s.last = d.ms;
        s.lastOk = true;
        s.min = s.min == null ? d.ms : Math.min(s.min, d.ms);
        s.max = s.max == null ? d.ms : Math.max(s.max, d.ms);
        s.sum += d.ms;
        s.avg = s.sum / s.recv;
        if (s.prev != null) {
          s.jsum += Math.abs(d.ms - s.prev);
          s.jitter = s.jsum / (s.recv - 1);
        }
        s.prev = d.ms;
        s.status = 'Up';
      } else {
        s.lastOk = false;
        s.status = 'Down';
      }
      s.loss = s.sent ? ((s.sent - s.recv) / s.sent) * 100 : 0;
      s.hist.push(d.ok ? d.ms : null);
      if (s.hist.length > 80) s.hist.shift();
      this.addLog(d);
      this.renderSoon();
    } else if (type === 'done') {
      this.render();
    }
  }

  addLog(d) {
    const t = new Date().toLocaleTimeString();
    const line = d.ok
      ? h('div.ok', `${t}  Reply from ${d.ip || d.host}: seq=${d.seq} time=${fmtMs(d.ms)}${d.ttl ? ' TTL=' + d.ttl : ''}`)
      : h('div.err', `${t}  ${d.host}: ${d.error || 'Request timed out'}${d.seq ? ' (seq=' + d.seq + ')' : ''}`);
    this.log.append(line);
    while (this.log.childElementCount > 500) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  render() {
    const rows = [...this.stats.values()];
    this.table.setRows(rows);
    rows.forEach((r) => drawSpark(r.canvas, r.hist));
    const up = rows.filter((r) => r.status === 'Up').length;
    const sent = rows.reduce((n, r) => n + r.sent, 0);
    const recv = rows.reduce((n, r) => n + r.recv, 0);
    this.summary.replaceChildren(
      h('span', h('b', rows.length), ' hosts'),
      h('span', h('b', up), ' up'),
      h('span', h('b', sent), ' sent'),
      h('span', h('b', sent ? (((sent - recv) / sent) * 100).toFixed(1) + '%' : '0%'), ' loss'),
      h('span', this.state === 'running' ? 'Running…' : 'Stopped'),
      h('span.right', h('button.btn.sm.ghost', {
        onclick: () => this.exportCsv('ping.csv', ['Host', 'IP', 'Sent', 'Received', 'Loss %', 'Min', 'Avg', 'Max', 'Jitter'], rows.map((r) => [r.host, r.ip, r.sent, r.recv, r.loss.toFixed(1), r.min, r.avg?.toFixed(2), r.max, r.jitter?.toFixed(2)])),
      }, 'Export CSV'))
    );
  }
}

function drawSpark(canvas, hist) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const vals = hist.filter((v) => v != null);
  const max = Math.max(10, ...vals) * 1.15;
  const bw = W / 80;
  hist.forEach((v, i) => {
    const x = W - (hist.length - i) * bw;
    if (v == null) {
      ctx.fillStyle = '#f0645b';
      ctx.fillRect(x, 0, Math.max(1, bw - 1), H);
    } else {
      const bh = Math.max(3, (v / max) * H);
      ctx.fillStyle = v > 150 ? '#e0a83a' : '#3fbf6a';
      ctx.fillRect(x, H - bh, Math.max(1, bw - 1), bh);
    }
  });
}

function throttle(fn, ms) {
  let t = null;
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    } else if (!t) {
      t = setTimeout(() => {
        t = null;
        last = Date.now();
        fn();
      }, ms - (now - last));
    }
  };
}

// ---------------------------------------------------------------- sweep

class SweepTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.targets = h('input', { value: params.targets || app.info.defaultSweep, spellcheck: false, placeholder: '192.168.1.0/24, 10.0.0.1-50' });
    this.targets.addEventListener('keydown', (e) => e.key === 'Enter' && this.start());
    this.timeout = num(800, 100);
    this.conc = num(64, 1, 512);
    const [l1, names] = check('Resolve names', true);
    const [l2, tcp] = check('TCP fallback', true);
    const [l3, macs] = check('MAC addresses', true);
    this.opts = { names, tcp, macs };
    this.hosts = new Map();
    this.table = new DataTable({
      columns: [
        { key: 'ip', label: 'IP Address', width: 140, mono: true, sort: (r) => ipSort(r.ip) },
        { key: 'status', label: 'Status', width: 80, render: () => h('span.pill.ok', 'Up') },
        { key: 'ms', label: 'RTT', width: 80, num: true, render: (r) => fmtMs(r.ms) },
        { key: 'name', label: 'Hostname' },
        { key: 'mac', label: 'MAC Address', width: 150, mono: true },
        { key: 'method', label: 'Detected by', width: 120 },
        { key: 'ttl', label: 'TTL (OS guess)', width: 170, render: (r) => (r.ttl ? `${r.ttl} ${osGuess(r.ttl)}` : '') },
      ],
      rowKey: (r) => r.ip,
      emptyText: 'Live hosts will appear here.',
      onActivate: (r) => this.app.openTool('portscan', { targets: r.ip }),
      onContext: (e, rows) => rows[0] && contextMenu(e.clientX, e.clientY, hostMenuItems(this.app, rows[0].ip)),
    });
    this.table.sortKey = 'ip';
    this.bar = h('div.progress', h('div'));
    this.summary = h('div.tool-summary', h('span', 'Idle'));
    this.el.append(
      this.header(
        [
          field('Targets (CIDR, range, list)', this.targets, 'wide'),
          field('Timeout ms', this.timeout, 'num'),
          field('Parallel', this.conc, 'num'),
          h('div.opts', l1, l2, l3),
          this.runButton('Sweep'),
        ],
        { note: AUTH_NOTE }
      ),
      this.summary,
      h('div.tool-body', this.table.el)
    );
    this.renderSoon = throttle(() => this.render(), 200);
    this.progress = { done: 0, total: 0, alive: 0 };
  }

  async start() {
    if (this.disposed || this.jobId) return;
    this.hosts.clear();
    this.progress = { done: 0, total: 0, alive: 0 };
    this.app.setTabTitle(this, 'Sweep ' + this.targets.value.trim().split(/[\s,]+/)[0]);
    await this.runJob('sweep', {
      targets: this.targets.value.trim(),
      timeout: Number(this.timeout.value) || 800,
      concurrency: Number(this.conc.value) || 64,
      resolveNames: this.opts.names.checked,
      tcpFallback: this.opts.tcp.checked,
      macs: this.opts.macs.checked,
    });
    this.render();
  }

  onEvent(type, d) {
    if (type === 'result' && d.alive) this.hosts.set(d.ip, { ...d, mac: this.hosts.get(d.ip)?.mac || '' });
    else if (type === 'mac' && this.hosts.has(d.ip)) this.hosts.get(d.ip).mac = d.mac;
    else if (type === 'progress') this.progress = d;
    this.renderSoon();
  }

  render() {
    const rows = [...this.hosts.values()];
    this.table.setRows(rows);
    const p = this.progress;
    this.bar.firstChild.style.width = p.total ? (p.done / p.total) * 100 + '%' : '0';
    const secs = this.started ? ((Date.now() - this.started) / 1000).toFixed(1) : 0;
    this.summary.replaceChildren(
      this.bar,
      h('span', h('b', p.done), ' / ', p.total || '?', ' scanned'),
      h('span', h('b', rows.length), ' alive'),
      h('span', `${secs}s`),
      h('span', this.state === 'running' ? 'Running…' : p.total ? 'Finished' : 'Idle'),
      h('span.right', h('button.btn.sm.ghost', {
        onclick: () => this.exportCsv('sweep.csv', ['IP', 'RTT ms', 'Hostname', 'MAC', 'Method', 'TTL'], rows.map((r) => [r.ip, r.ms, r.name, r.mac, r.method, r.ttl])),
      }, 'Export CSV'))
    );
  }
}

function osGuess(ttl) {
  if (ttl <= 64) return '(Linux/Unix)';
  if (ttl <= 128) return '(Windows)';
  return '(Network gear)';
}

// ---------------------------------------------------------------- port scan

class PortScanTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.targets = h('input', { value: params.targets || '', placeholder: '10.0.0.5, 192.168.1.0/28, server.lan', spellcheck: false });
    this.ports = h('input', { value: params.ports || app.presetPorts('top100'), spellcheck: false });
    this.preset = h(
      'select',
      { onchange: () => this.preset.value && (this.ports.value = this.preset.value === 'all' ? '1-65535' : this.preset.value === 'wk' ? '1-1024' : app.presetPorts(this.preset.value)) },
      [['top100', 'Top 100'], ['network', 'Network gear'], ['web', 'Web'], ['windows', 'Windows / AD'], ['database', 'Databases'], ['iot', 'IoT / ICS'], ['wk', 'Well-known 1-1024'], ['all', 'All 1-65535']].map(([v, l]) => h('option', { value: v }, l))
    );
    this.timeout = num(1000, 100);
    this.conc = num(200, 1, 2000);
    const [l1, banner] = check('Grab banners', true);
    const [l2, showAll] = check('Show closed / filtered', false);
    this.banner = banner;
    this.showAll = showAll;
    for (const i of [this.targets, this.ports]) i.addEventListener('keydown', (e) => e.key === 'Enter' && this.start());
    this.results = [];
    this.table = new DataTable({
      columns: [
        { key: 'host', label: 'Host', width: 150, mono: true, sort: (r) => ipSort(r.ip || r.host) },
        { key: 'port', label: 'Port', width: 70, num: true },
        { key: 'state', label: 'State', width: 90, render: (r) => h('span.pill', { class: r.state === 'open' ? 'ok' : r.state === 'closed' ? 'err' : 'muted' }, r.state) },
        { key: 'service', label: 'Service', width: 130 },
        { key: 'banner', label: 'Banner / TLS', mono: true },
        { key: 'ms', label: 'Time', width: 70, num: true, render: (r) => (r.ms != null ? r.ms + ' ms' : '') },
      ],
      rowKey: (r) => `${r.host}:${r.port}`,
      emptyText: 'Open ports will appear here.',
      onActivate: (r) => r.state === 'open' && this.connectTo(r),
      onContext: (e, rows) => rows[0] && contextMenu(e.clientX, e.clientY, hostMenuItems(this.app, rows[0].ip || rows[0].host, rows[0].port)),
    });
    this.table.sortKey = 'host';
    this.bar = h('div.progress', h('div'));
    this.summary = h('div.tool-summary', h('span', 'Idle'));
    this.el.append(
      this.header(
        [
          field('Targets', this.targets, 'wide'),
          field('Ports', this.ports, 'wide'),
          field('Preset', this.preset),
          field('Timeout ms', this.timeout, 'num'),
          field('Parallel', this.conc, 'num'),
          h('div.opts', l1, l2),
          this.runButton('Scan'),
        ],
        { note: AUTH_NOTE }
      ),
      this.summary,
      h('div.tool-body', this.table.el)
    );
    this.progress = {};
    this.renderSoon = throttle(() => this.render(), 200);
    if (params.targets) setTimeout(() => this.start(), 0);
  }

  connectTo(r) {
    const host = r.ip || r.host;
    if (r.port === 22) this.app.quickConnect({ protocol: 'ssh', host, port: 22 });
    else if (r.port === 23) this.app.quickConnect({ protocol: 'telnet', host, port: 23 });
    else contextMenu(innerWidth / 2, innerHeight / 2, hostMenuItems(this.app, host, r.port));
  }

  async start() {
    if (this.disposed || this.jobId) return;
    if (!this.targets.value.trim()) return toast('Enter a target');
    this.results = [];
    this.progress = {};
    this.app.setTabTitle(this, 'Scan ' + this.targets.value.trim().split(/[\s,]+/)[0]);
    await this.runJob('portscan', {
      targets: this.targets.value.trim(),
      ports: this.ports.value.trim(),
      timeout: Number(this.timeout.value) || 1000,
      concurrency: Number(this.conc.value) || 200,
      banner: this.banner.checked,
      showAll: this.showAll.checked,
    });
    this.render();
  }

  onEvent(type, d) {
    if (type === 'result') this.results.push(d);
    else if (type === 'progress') this.progress = d;
    this.renderSoon();
  }

  render() {
    this.table.setRows(this.results);
    const p = this.progress;
    this.bar.firstChild.style.width = p.total ? (p.done / p.total) * 100 + '%' : '0';
    const secs = this.started ? ((Date.now() - this.started) / 1000).toFixed(1) : 0;
    this.summary.replaceChildren(
      this.bar,
      h('span', h('b', p.done || 0), ' / ', p.total || '?', ' probes'),
      h('span', h('b', p.open || 0), ' open'),
      h('span', h('b', p.closed || 0), ' closed'),
      h('span', h('b', p.filtered || 0), ' filtered'),
      h('span', `${secs}s`),
      h('span.right', h('button.btn.sm.ghost', {
        onclick: () => this.exportCsv('portscan.csv', ['Host', 'IP', 'Port', 'State', 'Service', 'Banner', 'ms'], this.results.map((r) => [r.host, r.ip, r.port, r.state, r.service, r.banner, r.ms])),
      }, 'Export CSV'))
    );
  }
}

// ---------------------------------------------------------------- traceroute

class TraceTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.host = h('input', { value: params.host || '', placeholder: 'example.com or 8.8.8.8', spellcheck: false });
    this.host.addEventListener('keydown', (e) => e.key === 'Enter' && this.start());
    this.maxHops = num(30, 1, 64);
    this.timeout = num(1000, 100);
    const [l1, names] = check('Resolve names', false);
    this.names = names;
    this.hops = [];
    const rtt = (i) => (r) => (r.rtts[i] == null ? h('span', { style: { color: 'var(--faint)' } }, '*') : fmtMs(r.rtts[i]));
    this.table = new DataTable({
      columns: [
        { key: 'hop', label: 'Hop', width: 56, num: true },
        { key: 'r1', label: 'RTT 1', width: 80, num: true, render: rtt(0), sort: (r) => r.rtts[0] ?? 1e9 },
        { key: 'r2', label: 'RTT 2', width: 80, num: true, render: rtt(1), sort: (r) => r.rtts[1] ?? 1e9 },
        { key: 'r3', label: 'RTT 3', width: 80, num: true, render: rtt(2), sort: (r) => r.rtts[2] ?? 1e9 },
        { key: 'ip', label: 'Address', width: 150, mono: true },
        { key: 'host', label: 'Host / message' },
      ],
      rowKey: (r) => r.hop,
      multi: false,
      emptyText: 'Enter a host and press Trace.',
      onContext: (e, rows) => rows[0] && rows[0].ip && contextMenu(e.clientX, e.clientY, hostMenuItems(this.app, rows[0].ip)),
    });
    this.table.sortKey = 'hop';
    this.log = h('div.log');
    this.summary = h('div.tool-summary', h('span', 'Idle'));
    this.el.append(
      this.header([
        field('Destination', this.host, 'wide'),
        field('Max hops', this.maxHops, 'num'),
        field('Timeout ms', this.timeout, 'num'),
        h('div.opts', l1),
        this.runButton('Trace'),
      ]),
      this.summary,
      h('div.tool-split', this.table.el, this.log)
    );
    if (params.host) setTimeout(() => this.start(), 0);
  }

  async start() {
    if (this.disposed || this.jobId) return;
    const host = this.host.value.trim();
    if (!host) return toast('Enter a destination');
    this.hops = [];
    this.log.replaceChildren();
    this.app.setTabTitle(this, 'Trace ' + host);
    this.table.setRows([]);
    this.summary.replaceChildren(h('span', `Tracing route to ${host}…`));
    await this.runJob('traceroute', { host, maxHops: Number(this.maxHops.value) || 30, timeout: Number(this.timeout.value) || 1000, resolveNames: this.names.checked });
  }

  onEvent(type, d) {
    if (type === 'hop') {
      if (!d.ip && d.host && /^\d+\.\d+\.\d+\.\d+$/.test(d.host)) d.ip = d.host;
      if (d.ip === d.host) d.host = '';
      this.hops.push(d);
      this.table.setRows(this.hops);
    } else if (type === 'line') {
      this.log.append(h('div', d));
    } else if (type === 'done') {
      const last = this.hops[this.hops.length - 1];
      this.summary.replaceChildren(h('span', h('b', this.hops.length), ' hops'), last ? h('span', 'Last hop ', h('b', last.ip || last.host || '*')) : null, h('span', d.stopped ? 'Stopped' : 'Complete'));
    }
  }
}

// ---------------------------------------------------------------- DNS

class DnsTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.name = h('input', { value: params.name || '', placeholder: 'example.com or an IP for reverse lookup', spellcheck: false });
    this.type = h('select', ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'ALL', 'SYSTEM'].map((t) => h('option', { value: t }, t === 'ALL' ? 'All common' : t === 'SYSTEM' ? 'OS resolver' : t)));
    this.server = h('input', { placeholder: 'System default', list: 'dns-servers', spellcheck: false, style: { width: '170px' } });
    const dl = h('datalist#dns-servers', ['1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222'].map((s) => h('option', { value: s })));
    for (const i of [this.name, this.server]) i.addEventListener('keydown', (e) => e.key === 'Enter' && this.start());
    this.table = new DataTable({
      columns: [
        { key: 'type', label: 'Type', width: 80 },
        { key: 'name', label: 'Name', width: 220 },
        { key: 'value', label: 'Value', mono: true },
        { key: 'ttl', label: 'TTL', width: 80, num: true },
      ],
      rowKey: (r) => r.type + r.value,
      emptyText: 'Results will appear here.',
      onContext: (e, rows) =>
        rows[0] &&
        contextMenu(e.clientX, e.clientY, [
          { label: 'Copy value', icon: 'copy', action: () => api.invoke('clipboard:write', rows.map((r) => r.value).join('\n')) },
          ['A', 'AAAA', 'PTR'].includes(rows[0].type) ? '-' : null,
          ...(['A', 'AAAA'].includes(rows[0].type) ? hostMenuItems(this.app, rows[0].value).slice(4) : []),
        ]),
    });
    this.summary = h('div.tool-summary', h('span', 'Idle'));
    this.btn = h('button.btn.primary', { onclick: () => this.start() }, icon('search'), 'Lookup');
    this.el.append(
      this.header([field('Name', this.name, 'wide'), field('Type', this.type), field('Server', this.server), dl, this.btn]),
      this.summary,
      h('div.tool-body', this.table.el)
    );
    if (params.name) setTimeout(() => this.start(), 0);
  }

  async start() {
    const name = this.name.value.trim();
    if (!name) return toast('Enter a name');
    this.summary.replaceChildren(h('span', 'Looking up…'));
    this.app.setTabTitle(this, 'DNS ' + name);
    try {
      const r = await api.invoke('tools:dns', { name, type: this.type.value, server: this.server.value.trim() });
      this.table.setRows(r.records);
      this.summary.replaceChildren(
        h('span', h('b', r.records.length), ' records'),
        h('span', 'Server ', h('b', r.server)),
        h('span', `${r.ms} ms`),
        r.errors && r.errors.length ? h('span', { style: { color: 'var(--err)' } }, r.errors.join(' · ')) : null
      );
    } catch (e) {
      this.table.setRows([]);
      this.summary.replaceChildren(h('span', { style: { color: 'var(--err)' } }, errMsg(e)));
    }
  }
}

// ---------------------------------------------------------------- whois

class WhoisTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.query = h('input', { value: params.query || '', placeholder: 'example.com, 8.8.8.8 or AS15169', spellcheck: false });
    this.query.addEventListener('keydown', (e) => e.key === 'Enter' && this.start());
    this.out = h('pre.pre-out', '');
    this.el.append(this.header([field('Query', this.query, 'wide'), h('button.btn.primary', { onclick: () => this.start() }, icon('search'), 'Lookup')]), h('div.tool-body', this.out));
  }

  async start() {
    const q = this.query.value.trim();
    if (!q) return;
    this.out.textContent = 'Querying…';
    this.app.setTabTitle(this, 'Whois ' + q);
    try {
      this.out.textContent = await api.invoke('tools:whois', { query: q });
    } catch (e) {
      this.out.textContent = 'Error: ' + errMsg(e);
    }
  }
}

// ---------------------------------------------------------------- subnet calculator

function v4Info(ip, bits) {
  const a = ipToInt(ip);
  const size = 2 ** (32 - bits);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = Math.floor(a / size) * size;
  const broadcast = network + size - 1;
  const first = bits >= 31 ? network : network + 1;
  const last = bits >= 31 ? broadcast : broadcast - 1;
  const usable = bits === 32 ? 1 : bits === 31 ? 2 : size - 2;
  const o1 = a >>> 24;
  const cls = o1 < 128 ? 'A' : o1 < 192 ? 'B' : o1 < 224 ? 'C' : o1 < 240 ? 'D (multicast)' : 'E (reserved)';
  const inRange = (base, b) => Math.floor(a / 2 ** (32 - b)) === Math.floor(ipToInt(base) / 2 ** (32 - b));
  const kind = inRange('10.0.0.0', 8) || inRange('172.16.0.0', 12) || inRange('192.168.0.0', 16)
    ? 'Private (RFC 1918)'
    : inRange('127.0.0.0', 8) ? 'Loopback'
    : inRange('169.254.0.0', 16) ? 'Link-local (APIPA)'
    : inRange('100.64.0.0', 10) ? 'Shared / CGNAT (RFC 6598)'
    : inRange('224.0.0.0', 4) ? 'Multicast'
    : 'Public';
  const bin = (n) => intToIp(n).split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('.');
  return {
    rows: [
      ['Address', ip],
      ['CIDR notation', `${intToIp(network)}/${bits}`],
      ['Netmask', intToIp(mask)],
      ['Wildcard mask', intToIp(~mask >>> 0)],
      ['Network', intToIp(network)],
      ['Broadcast', bits >= 31 ? '—' : intToIp(broadcast)],
      ['First usable', intToIp(first)],
      ['Last usable', intToIp(last)],
      ['Usable hosts', usable.toLocaleString()],
      ['Total addresses', size.toLocaleString()],
      ['Class', cls],
      ['Type', kind],
      ['Address (binary)', bin(a)],
      ['Netmask (binary)', bin(mask)],
      ['Address (hex)', '0x' + a.toString(16).padStart(8, '0').toUpperCase()],
      ['Reverse zone', intToIp(network).split('.').slice(0, Math.max(1, Math.ceil(bits / 8))).reverse().join('.') + '.in-addr.arpa'],
    ],
    network,
    bits,
  };
}

function v6Expand(addr) {
  let [head, tail] = addr.split('::');
  const hp = head ? head.split(':') : [];
  const tp = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (addr.includes('::')) {
    const fill = 8 - hp.length - tp.length;
    if (fill < 0) return null;
    return [...hp, ...Array(fill).fill('0'), ...tp];
  }
  return hp.length === 8 ? hp : null;
}

function v6Info(addr, bits) {
  const parts = v6Expand(addr);
  if (!parts || parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) throw new Error('Invalid IPv6 address');
  const n = parts.reduce((acc, p) => (acc << 16n) | BigInt(parseInt(p, 16)), 0n);
  const hostBits = BigInt(128 - bits);
  const mask = ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
  const net = n & mask;
  const last = net | ((1n << hostBits) - 1n);
  // RFC 5952 form: longest run (2+) of zero groups collapses to "::".
  const fmt = (x) => {
    const g = [];
    for (let i = 7; i >= 0; i--) g.push(((x >> BigInt(i * 16)) & 0xffffn).toString(16));
    let best = -1;
    let bestLen = 1;
    for (let i = 0; i < 8; ) {
      if (g[i] !== '0') {
        i++;
        continue;
      }
      let j = i;
      while (j < 8 && g[j] === '0') j++;
      if (j - i > bestLen) {
        best = i;
        bestLen = j - i;
      }
      i = j;
    }
    if (best < 0) return g.join(':');
    return g.slice(0, best).join(':') + '::' + g.slice(best + bestLen).join(':');
  };
  const full = (x) => {
    const g = [];
    for (let i = 7; i >= 0; i--) g.push(((x >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, '0'));
    return g.join(':');
  };
  return {
    rows: [
      ['Address', fmt(n)],
      ['Expanded', full(n)],
      ['Prefix', `${fmt(net)}/${bits}`],
      ['First address', fmt(net)],
      ['Last address', fmt(last)],
      ['Total addresses', (1n << hostBits).toLocaleString()],
      ['/64 subnets in prefix', bits <= 64 ? (1n << BigInt(64 - bits)).toLocaleString() : '—'],
    ],
  };
}

class SubnetTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.input = h('input', { value: params.input || '192.168.10.37/26', spellcheck: false });
    this.split = h('select', h('option', { value: '' }, 'Split into…'));
    this.input.addEventListener('input', () => this.calc());
    this.split.addEventListener('change', () => this.calc());
    this.kv = h('div.kv');
    this.subnets = new DataTable({
      columns: [
        { key: 'n', label: '#', width: 60, num: true },
        { key: 'net', label: 'Network', mono: true, sort: (r) => r.n },
        { key: 'range', label: 'Usable range', mono: true, sort: (r) => r.n },
        { key: 'bc', label: 'Broadcast', mono: true, sort: (r) => r.n },
      ],
      rowKey: (r) => r.n,
      onContext: (e, rows) => rows[0] && contextMenu(e.clientX, e.clientY, [
        { label: 'Sweep this subnet', icon: 'radar', action: () => this.app.openTool('sweep', { targets: rows[0].net }) },
        { label: 'Copy', icon: 'copy', action: () => api.invoke('clipboard:write', rows.map((r) => r.net).join('\n')) },
      ]),
    });
    this.err = h('div.tool-summary');
    this.el.append(
      this.header([
        field('Address / prefix (or address + mask, IPv6 too)', this.input, 'wide'),
        field('Subnetting', this.split),
        h('button.btn', { onclick: () => this.app.openTool('sweep', { targets: this.current }) }, icon('radar'), 'Sweep network'),
      ]),
      this.err,
      h('div.tool-body', { style: { overflow: 'auto' } }, this.kv, this.subnets.el)
    );
    this.calc();
  }

  calc() {
    const raw = this.input.value.trim();
    this.err.replaceChildren();
    try {
      if (raw.includes(':')) {
        const [a, b = '64'] = raw.split('/');
        const bits = Number(b);
        if (!(bits >= 0 && bits <= 128)) throw new Error('Prefix must be 0-128');
        const info = v6Info(a, bits);
        this.kv.replaceChildren(...info.rows.flatMap(([k, v]) => [h('div', k), h('div', v)]));
        this.subnets.setRows([]);
        this.subnets.el.classList.add('hidden');
        return;
      }
      let ip;
      let bits;
      const m = raw.match(/^([^\s/]+)\s*(?:\/\s*(\d+)|\s+(\d+\.\d+\.\d+\.\d+))?$/);
      if (!m) throw new Error('Enter an address like 10.1.2.3/24 or 10.1.2.3 255.255.255.0');
      ip = m[1];
      if (ipToInt(ip) === null) throw new Error('Invalid IPv4 address');
      if (m[3]) {
        const mi = ipToInt(m[3]);
        if (mi === null) throw new Error('Invalid netmask');
        bits = mi.toString(2).replace(/0+$/, '').length;
        if (!/^1*0*$/.test(mi.toString(2).padStart(32, '0'))) throw new Error('Netmask is not contiguous');
      } else bits = m[2] != null ? Number(m[2]) : 24;
      if (bits > 32) throw new Error('Prefix must be 0-32');
      const info = v4Info(ip, bits);
      this.current = `${intToIp(info.network)}/${bits}`;
      this.kv.replaceChildren(...info.rows.flatMap(([k, v]) => [h('div', k), h('div', v)]));
      // Subnet splitting options
      const keep = this.split.value;
      this.split.replaceChildren(h('option', { value: '' }, 'Split into…'));
      for (let b = bits + 1; b <= Math.min(32, bits + 12); b++) this.split.append(h('option', { value: b, selected: String(b) === keep }, `/${b} — ${2 ** (b - bits)} subnets of ${2 ** (32 - b)}`));
      const sb = Number(this.split.value);
      this.subnets.el.classList.toggle('hidden', !sb);
      if (sb) {
        const size = 2 ** (32 - sb);
        const rows = [];
        for (let i = 0; i < Math.min(4096, 2 ** (sb - bits)); i++) {
          const n = info.network + i * size;
          rows.push({
            n: i + 1,
            net: `${intToIp(n)}/${sb}`,
            range: sb >= 31 ? `${intToIp(n)} - ${intToIp(n + size - 1)}` : `${intToIp(n + 1)} - ${intToIp(n + size - 2)}`,
            bc: sb >= 31 ? '—' : intToIp(n + size - 1),
          });
        }
        this.subnets.setRows(rows);
      }
    } catch (e) {
      this.kv.replaceChildren();
      this.subnets.el.classList.add('hidden');
      this.err.replaceChildren(h('span', { style: { color: 'var(--err)' } }, e.message));
    }
  }
}

// ---------------------------------------------------------------- Wake-on-LAN

class WolTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    const { els, read } = buildFields([
      { name: 'mac', label: 'MAC address', placeholder: 'aa:bb:cc:dd:ee:ff', value: params.mac || '' },
      { name: 'broadcast', label: 'Broadcast address', value: '255.255.255.255' },
      { name: 'port', label: 'UDP port', type: 'number', value: 9 },
    ]);
    els[0].classList.add('wide');
    this.read = read;
    this.log = h('div.log', { style: { flex: 1, borderTop: 0 } });
    this.el.append(
      this.header([...els, h('button.btn.primary', { onclick: () => this.send() }, icon('power'), 'Send magic packet')], {
        note: 'Tip: use the subnet broadcast (e.g. 192.168.1.255) when the target is on another VLAN behind a router that forwards directed broadcasts.',
      }),
      h('div.tool-body', this.log)
    );
  }

  async send() {
    const v = this.read();
    try {
      const r = await api.invoke('tools:wol', v);
      this.log.append(h('div.ok', `${new Date().toLocaleTimeString()}  Sent ${r.bytes}-byte magic packet for ${v.mac} to ${v.broadcast}:${v.port}`));
    } catch (e) {
      this.log.append(h('div.err', `${new Date().toLocaleTimeString()}  ${errMsg(e)}`));
    }
  }
}

// ---------------------------------------------------------------- interfaces / ARP

class NetInfoTool extends ToolView {
  constructor(app, def, params) {
    super(app, def, params);
    this.ifaces = new DataTable({
      columns: [
        { key: 'name', label: 'Interface', width: 200 },
        { key: 'family', label: 'Family', width: 70 },
        { key: 'address', label: 'Address', mono: true },
        { key: 'cidr', label: 'CIDR', mono: true },
        { key: 'network', label: 'Network', width: 150, mono: true },
        { key: 'mac', label: 'MAC', width: 150, mono: true },
      ],
      rowKey: (r) => r.name + r.address,
      onContext: (e, rows) => rows[0] && contextMenu(e.clientX, e.clientY, [
        rows[0].network && { label: `Sweep ${rows[0].network}`, icon: 'radar', action: () => this.app.openTool('sweep', { targets: rows[0].network }) },
        { label: 'Subnet calculator', icon: 'calc', action: () => this.app.openTool('subnet', { input: rows[0].cidr }) },
        { label: 'Copy address', icon: 'copy', action: () => api.invoke('clipboard:write', rows[0].address) },
      ]),
    });
    this.arp = new DataTable({
      columns: [
        { key: 'ip', label: 'IP Address', width: 180, mono: true, sort: (r) => ipSort(r.ip) },
        { key: 'mac', label: 'MAC Address', mono: true },
      ],
      rowKey: (r) => r.ip,
      onActivate: (r) => this.app.openTool('portscan', { targets: r.ip }),
      onContext: (e, rows) => rows[0] && contextMenu(e.clientX, e.clientY, hostMenuItems(this.app, rows[0].ip)),
    });
    this.arp.sortKey = 'ip';
    const sec = (t) => h('div.tool-summary', h('b', t));
    this.el.append(
      this.header([h('button.btn', { onclick: () => this.load() }, icon('refresh'), 'Refresh')]),
      h('div.tool-body', { style: { display: 'grid', gridTemplateRows: 'auto 1fr auto 1fr' } }, sec('Network interfaces'), this.ifaces.el, sec('ARP cache'), this.arp.el)
    );
    this.load();
  }

  async load() {
    const [ifs, arp] = await Promise.all([api.invoke('tools:interfaces'), api.invoke('tools:arp')]);
    this.ifaces.setRows(ifs.filter((i) => !i.internal || i.family === 'IPv4'));
    this.arp.setRows(arp);
  }
}

const CLASSES = { capture: CaptureTab, ping: PingTool, sweep: SweepTool, portscan: PortScanTool, traceroute: TraceTool, dns: DnsTool, whois: WhoisTool, subnet: SubnetTool, wol: WolTool, netinfo: NetInfoTool };

export function createTool(app, kind, params = {}) {
  if (kind === 'incidents') return new IncidentTab(app, params);
  if (kind === 'snapshots') return new SnapshotTab(app, params);
  if (kind === 'device') return new DeviceTab(app, params);
  if (kind === 'ai') return new AITab(app, params);
  if (kind === 'wifi') return createWifiTool(app, params);
  if (kind === 'mist') return createMistTool(app, params);
  if (kind === 'security') return createSecurityTool(app, params);
  const def = TOOLS.find((t) => t.kind === kind);
  if (kind === 'capture') return new CaptureTab(app, params);
  return new CLASSES[kind](app, def, params);
}
