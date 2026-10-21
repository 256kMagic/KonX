// Packet capture tab: live capture (Npcap, or Windows' built-in capture driver when Npcap is
// not installed) or capture files (.pcap, .pcapng, Windows .etl), decoded and analyzed.
import { h, icon, api, DataTable, contextMenu, modal, toast, errMsg, fmtBytes, confirmDialog } from './ui.js';
import { decode, Node, LINKTYPES } from './capture/decode.mjs';
import { compileFilter } from './capture/filter.mjs';
import { Analyzer } from './capture/analyze.mjs';
import { readCapture, writePcapng } from './capture/pcapfile.mjs';
import { showTraffic } from './capture/traffic-view.js';
import { analyzeSipCalls } from './capture/sip.mjs';
import { showSipCalls } from './capture/sip-view.js';
import { buildSipCallCapture, buildSipCallReport } from './capture/sip-export.mjs';
import { showRtpMedia } from './capture/rtp-view.js';
import { makeRtpDemo } from './capture/sample-rtp.mjs';

const ROW_H = 22;
const MAX_PACKETS = 1000000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtTime = (s) => (s == null ? '' : s.toFixed(6));
const fmtMs = (s) => (s == null ? 'n/a' : s < 1 ? `${(s * 1000).toFixed(1)} ms` : `${s.toFixed(2)} s`);
const fmtRate = (bps) => (bps >= 1e9 ? `${(bps / 1e9).toFixed(2)} Gbps` : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : bps >= 1e3 ? `${(bps / 1e3).toFixed(0)} kbps` : `${bps.toFixed(0)} bps`);

const BPF_PRESETS = ['not port 22 and not port 3389', 'host 192.168.1.1', 'net 192.168.1.0/24', 'port 53', 'tcp port 443', 'arp or icmp', 'udp', 'vlan', 'ether proto 0x88cc or ether dst 01:00:0c:cc:cc:cc'];
// Windows' built-in capture has no BPF: its capture filter uses the display-filter language,
// applied as packets arrive (packets that do not match are not kept).
const KONX_PRESETS = ['not port 22 and not port 3389', 'host 192.168.1.1', 'net 192.168.1.0/24', 'port 53', 'tcp port 443', 'arp or icmp', 'udp', 'vlan', 'lldp or cdp or stp', 'dns or dhcp'];
const NOTICE_KEY = 'konx.capture.builtinNoticeDismissed';
const QUICK = [
  ['Problems', 'warnings'],
  ['TCP issues', 'tcp.analysis.flags or rst'],
  ['DNS', 'dns or mdns or llmnr'],
  ['Web', 'http or tls or quic'],
  ['Discovery', 'arp or dhcp or lldp or cdp or stp'],
  ['Routing', 'ospf or bgp or hsrp or vrrp or pim'],
];

export class CaptureTab {
  constructor(app, params = {}) {
    this.app = app;
    this.kind = 'capture';
    this.id = `cap-${Math.random().toString(36).slice(2, 9)}`;
    this.title = 'Packet Capture';
    this.icon = 'capture';
    this.state = 'idle';
    this.packets = [];
    this.view = [];
    this.filter = null;
    this.analyzer = new Analyzer();
    this.selected = -1;
    this.autoScroll = true;
    this.resolveNames = true;
    this.linktype = 1;
    this.stats = { received: 0, dropped: 0 };
    this.rateHist = [];
    this.lastCount = 0;
    this.lastBytes = 0;
    this.fileName = '';
    this.sideTab = 'Insights';
    this.build(params);
    this.loadStatus();
  }

  // ------------------------------------------------------------ layout

  build(params) {
    this.ifaceSel = h('select.input', { style: { width: '260px' }, onchange: () => this.onDeviceChange() }, h('option', 'Loading interfaces…'));
    this.bpf = h('input.input', { placeholder: 'Capture filter (BPF), e.g. host 10.0.0.1 and not port 22', list: `${this.id}-bpf`, spellcheck: false, value: params.captureFilter || '' });
    this.bpfList = h(`datalist#${this.id}-bpf`, BPF_PRESETS.map((p) => h('option', { value: p })));
    const bpfList = this.bpfList;
    this.startBtn = h('button.btn.primary', { onclick: () => (['running', 'starting', 'stopping'].includes(this.state) ? this.stop() : this.start()) }, icon('play'), 'Start');
    this.statsEl = h('div.cap-stats');
    this.spark = h('canvas.cap-spark', { width: 240, height: 48 });
    const bar = h(
      'div.cap-bar',
      this.ifaceSel,
      h('div.cap-bpf', icon('filter'), this.bpf, bpfList),
      this.startBtn,
      h('div.tb-sep'),
      h('button.icon-btn', { title: 'Open capture file (.pcap, .pcapng, Windows .etl)', onclick: () => this.openFile() }, icon('folder-open')),
      h('button.icon-btn', { title: 'Save capture (.pcapng)', onclick: (e) => this.saveMenu(e) }, icon('save')),
      h('button.icon-btn', { title: 'Clear', onclick: () => this.clear(true) }, icon('trash')),
      h('div', { style: { flex: 1 } }),
      this.statsEl,
      this.spark
    );

    this.dfilter = h('input', { placeholder: 'Display filter: host 10.0.0.5, port 443, dns, tcp.analysis.flags, http.host contains "api", "text"…', spellcheck: false, value: params.filter || '' });
    this.dfilter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyFilter();
      if (e.key === 'Escape') {
        this.dfilter.value = '';
        this.applyFilter();
      }
    });
    this.dfilter.addEventListener('input', () => this.validateFilter());
    this.filterBox = h('div.cap-dfilter', icon('search'), this.dfilter, h('button.btn.sm', { onclick: () => this.applyFilter() }, 'Apply'));
    const chips = QUICK.map(([label, f]) => h('button.chip', { onclick: () => this.setFilter(f) }, label));
    this.autoScrollCheckbox = h('input', { type: 'checkbox', checked: this.autoScroll, onchange: (e) => this.setAutoScroll(e.target.checked) });
    const names = h('input', { type: 'checkbox', checked: true, onchange: (e) => ((this.resolveNames = e.target.checked), this.list.render()) });
    this.sipButton = h('button.btn.sm', { title: 'Reconstruct SIP calls from all captured packets', onclick: () => this.openSipCalls() }, icon('route'), 'SIP Calls');
    this.rtpButton = h('button.btn.sm', { title: 'Inspect RTP streams, jitter and G.711 audio', onclick: () => this.openRtpMedia() }, icon('activity'), 'RTP Media');
    const frow = h('div.cap-frow', this.filterBox, ...chips, this.sipButton, this.rtpButton, h('label.check', this.autoScrollCheckbox, 'Auto-scroll'), h('label.check', names, 'Names'));

    this.list = new PacketList(this);
    this.notice = h('div.cap-notice.hidden');
    this.explainEl = h('div.cap-explain');
    this.treeEl = h('div.ptree', { tabIndex: 0 });
    this.hexEl = h('div.phex');
    const bottom = h('div.cap-bottom', h('div.cap-detail', this.explainEl, this.treeEl), this.hexEl);
    const splitter = h('div.cap-split');
    this.left = h('div.cap-left', this.notice, this.list.el, splitter, bottom);
    this.dragSplit(splitter);

    this.sideTabs = h('div.mtabs.cap-sidetabs');
    this.sideBody = h('div.cap-sidebody');
    this.side = h('div.cap-side', this.sideTabs, this.sideBody);
    this.main = h('div.cap-main', this.left, this.side);
    this.el = h('div.view', h('div.cap', bar, frow, this.main));
    this.renderSideTabs();
    this.setupDrop();
    if (params.filter) this.applyFilter();
  }

  setAutoScroll(enabled) {
    this.autoScroll = !!enabled;
    this.autoScrollCheckbox.checked = this.autoScroll;
    if (this.autoScroll) this.list.scrollToEnd();
  }

  dragSplit(splitter) {
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.left.querySelector('.cap-bottom').getBoundingClientRect().height;
      const move = (ev) => {
        const nh = Math.max(120, Math.min(this.left.getBoundingClientRect().height - 120, startH - (ev.clientY - startY)));
        this.left.style.setProperty('--bottom-h', nh + 'px');
        this.list.render();
      };
      const up = () => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  }

  setupDrop() {
    this.el.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    });
    this.el.addEventListener('drop', async (e) => {
      const f = e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      const p = api.pathForFile(f);
      try {
        const bytes = await api.invoke('cap:readFile', p);
        await this.loadBytes(bytes, f.name);
      } catch (err) {
        toast(errMsg(err), 'err');
      }
    });
  }

  async loadStatus() {
    this.status = await api.invoke('cap:status').catch((e) => ({ available: false, error: errMsg(e) }));
    if (!this.status.available) {
      this.ifaceSel.replaceChildren(h('option', 'Live capture unavailable'));
      this.ifaceSel.disabled = true;
      this.showNotice();
      return;
    }
    try {
      const devs = await api.invoke('cap:devices');
      this.devices = devs;
      const option = (d) => {
        const v4 = d.addresses.filter((a) => a.family === 4).map((a) => a.ip);
        const down = d.engine === 'builtin' && !d.up ? ' (not connected)' : '';
        return h('option', { value: d.name }, `${d.friendly || d.description || d.name}${v4.length ? ' — ' + v4.join(', ') : ''}${down}`);
      };
      const npcapDevs = devs.filter((d) => d.engine !== 'builtin');
      const builtinDevs = devs.filter((d) => d.engine === 'builtin');
      const prompt = this.status.builtin && !this.status.builtin.elevated ? ' (asks for admin)' : '';
      this.ifaceSel.replaceChildren(
        ...(npcapDevs.length && builtinDevs.length
          ? [h('optgroup', { label: 'Npcap' }, ...npcapDevs.map(option)), h('optgroup', { label: `Windows built-in capture${prompt}` }, ...builtinDevs.map(option))]
          : devs.map(option))
      );
      this.onDeviceChange();
    } catch (e) {
      this.ifaceSel.replaceChildren(h('option', 'No interfaces'));
      toast(errMsg(e), 'err');
    }
    this.showNotice();
  }

  selectedDevice() {
    return (this.devices || []).find((d) => d.name === this.ifaceSel.value) || null;
  }

  /** The capture filter speaks BPF with Npcap and the display-filter language with Windows' driver. */
  onDeviceChange() {
    const dev = this.selectedDevice();
    const builtin = !!dev && dev.engine === 'builtin';
    this.bpf.placeholder = builtin ? 'Capture filter (KonX filter), e.g. host 10.0.0.1 and not port 22' : 'Capture filter (BPF), e.g. host 10.0.0.1 and not port 22';
    this.bpf.title = builtin ? 'Windows\' built-in capture has no BPF: write the filter like a display filter. Packets that do not match are not kept.' : 'Berkeley Packet Filter, applied by the Npcap driver';
    this.bpfList.replaceChildren(...(builtin ? KONX_PRESETS : BPF_PRESETS).map((p) => h('option', { value: p })));
    this.app.updateStatus(this);
  }

  builtinNoticeDismissed() {
    try {
      return localStorage.getItem(NOTICE_KEY) === '1';
    } catch {
      return false;
    }
  }

  dismissBuiltinNotice() {
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {}
    this.showNotice();
  }

  showNotice() {
    const st = this.status;
    const builtin = !!st && st.available && st.engine === 'builtin';
    const show = !!st && !this.packets.length && (!st.available || !!this.installing || (builtin && !this.builtinNoticeDismissed()));
    if (!show) return this.notice.classList.add('hidden');
    let title;
    let text;
    if (this.installing === 'download') {
      title = 'Getting Npcap…';
      text = 'Downloading the official installer from npcap.com and checking its digital signature.';
    } else if (this.installing === 'waiting') {
      title = 'Finish the Npcap installer';
      text = 'Npcap\'s setup is open (it may be behind this window). KonX switches to it automatically as soon as it finishes.';
    } else if (builtin) {
      title = 'Live capture uses Windows\' built-in capture driver';
      text = st.builtin.elevated
        ? 'No extra driver needed, and KonX is running as administrator, so captures start right away. Npcap adds loopback capture and BPF capture filters.'
        : 'No extra driver needed. Windows asks for administrator permission each time you start a capture. Install Npcap to capture without the prompt, see loopback traffic and use BPF capture filters.';
    } else {
      title = st.missing ? 'Live capture needs Npcap' : 'Live capture is unavailable';
      text = st.missing ? 'Install the free Npcap driver (the same one Wireshark uses). KonX downloads its official installer from npcap.com and checks the signature; you then click through Npcap\'s own setup. Opening .pcap / .pcapng / .etl files works without it.' : st.error;
    }
    const busy = !!this.installing;
    this.notice.replaceChildren(
      icon(busy ? 'download' : 'info'),
      h('div', h('b', title), h('div', text)),
      st.missing && !busy ? h(builtin ? 'button.btn.sm' : 'button.btn.sm.primary', { onclick: () => this.installNpcap() }, icon('download'), 'Install Npcap') : null,
      st.missing && !builtin ? h('button.btn.sm', { title: 'Open npcap.com in your browser', onclick: () => api.invoke('app:openExternal', 'https://npcap.com/#download') }, 'Download page') : null,
      !busy && !builtin ? h('button.btn.sm', { onclick: () => this.retryStatus() }, 'Retry') : null,
      h('button.btn.sm', { onclick: () => this.openFile() }, icon('folder-open'), 'Open file'),
      h('button.btn.sm', { title: 'A branch-office capture with real problems in it', onclick: () => this.openSample() }, icon('insight'), 'Open sample'),
      builtin && !busy ? h('button.btn.sm', { title: 'Hide this message', onclick: () => this.dismissBuiltinNotice() }, 'Got it') : null
    );
    this.notice.classList.remove('hidden');
  }

  /** Download + verify Npcap's official installer, open it, and wait for the driver to appear. */
  async installNpcap() {
    if (this.installing) return;
    this.installing = 'download';
    this.showNotice();
    try {
      await api.invoke('cap:installNpcap');
      this.installing = 'waiting';
      this.showNotice();
      const t0 = Date.now();
      while (Date.now() - t0 < 20 * 60 * 1000 && !this.disposed) {
        await new Promise((r) => setTimeout(r, 3000));
        await api.invoke('cap:resetStatus');
        const s = await api.invoke('cap:status');
        if (s.engine === 'npcap') {
          this.installing = false;
          this.ifaceSel.disabled = false;
          await this.loadStatus();
          this.showNotice();
          toast(`${s.version.split(',')[0]} installed: live capture is ready`, 'ok');
          return;
        }
      }
    } catch (e) {
      toast(`Could not install Npcap: ${errMsg(e)}`, 'err');
    } finally {
      if (this.installing) {
        this.installing = false;
        this.showNotice();
      }
    }
  }

  async retryStatus() {
    await api.invoke('cap:resetStatus');
    this.ifaceSel.disabled = false;
    await this.loadStatus();
    this.showNotice();
    if (this.status.engine === 'npcap') toast('Npcap found: live capture is ready', 'ok');
  }

  // ------------------------------------------------------------ capture control

  async start() {
    if (this.disposed || this.stopPromise || ['running', 'starting', 'stopping'].includes(this.state)) return;
    if (!this.status || !this.status.available) return this.showNotice();
    if (this.packets.length && !(await confirmDialog('Start a new capture? The current packets will be cleared.', { okLabel: 'Start new capture' }))) return;
    if (this.disposed || this.stopPromise || ['running', 'starting', 'stopping'].includes(this.state)) return;
    const device = this.ifaceSel.value;
    const dev = this.selectedDevice();
    const builtin = !!dev && dev.engine === 'builtin';
    // Windows' driver has no BPF: check the KonX-syntax filter before asking for admin rights.
    let capFilter = null;
    if (builtin && this.bpf.value.trim()) {
      try {
        capFilter = compileFilter(this.bpf.value);
      } catch (e) {
        toast(`Capture filter: ${e.message}`, 'err');
        return;
      }
    }
    const generation = this.captureGeneration = (this.captureGeneration || 0) + 1;
    this.clear(false);
    this.acceptLivePackets = true;
    this.captureFilter = capFilter;
    this.capFiltered = 0;
    this.engine = builtin ? 'builtin' : 'npcap';
    this.cancelStart = false;
    this.setState('starting');
    if (builtin && !this.status.builtin.elevated) {
      this.statsEl.textContent = 'Waiting for administrator permission…';
      toast('Windows will ask for administrator permission to start the capture.');
    }
    try {
      const r = await api.invoke('cap:start', this.id, { device, filter: builtin ? '' : this.bpf.value.trim(), snaplen: 262144, promisc: true });
      if (this.disposed || generation !== this.captureGeneration) return;
      this.linktype = r.linktype;
      this.fileName = '';
      this.app.setTabTitle(this, `Capture: ${dev ? dev.friendly || dev.description : 'interface'}`);
      if (this.state === 'starting') {
        this.setState('running');
        this.tick = setInterval(() => this.onTick(), 1000);
      }
    } catch (e) {
      if (this.disposed || generation !== this.captureGeneration) return;
      this.acceptLivePackets = false;
      this.setState('idle');
      this.renderStats();
      const msg = errMsg(e);
      if (this.cancelStart) toast('Capture cancelled.');
      else if (/not granted/i.test(msg)) toast('Capture not started: administrator permission was declined.');
      else if (builtin && /administrator rights are required/i.test(msg)) toast('Windows refused to start the capture: it needs an administrator account. Ask an administrator, or install Npcap.', 'err');
      else if (/access is denied|permission|PacketOpenAdapter|Error opening adapter/i.test(msg)) toast(`Could not open the adapter: ${msg}. If Npcap was installed with "Restrict Npcap driver's access to Administrators only", run KonX as administrator or reinstall Npcap without that option.`, 'err');
      else toast(msg, 'err');
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === 'starting') this.cancelStart = true;
    this.captureGeneration = (this.captureGeneration || 0) + 1;
    if (!this.disposed && ['running', 'starting'].includes(this.state)) this.setState('stopping');
    this.stopPromise = api.invoke('cap:stop', this.id).then(() => {
      this.acceptLivePackets = false;
      if (!this.disposed) this.setState('idle');
    }).finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  setState(s) {
    this.state = s;
    const running = s === 'running' || s === 'starting' || s === 'stopping';
    this.startBtn.disabled = s === 'stopping';
    this.startBtn.replaceChildren(icon(running ? 'stop' : 'play'), running ? 'Stop' : 'Start');
    this.startBtn.classList.toggle('danger', running);
    this.startBtn.classList.toggle('primary', !running);
    this.ifaceSel.disabled = running || (this.status && !this.status.available);
    this.bpf.disabled = running;
    if (!running && this.tick) {
      clearInterval(this.tick);
      this.tick = null;
      this.onTick();
    }
    this.app.tabStateChanged(this);
  }

  onCapState(st) {
    if (st.stats) this.stats = st.stats;
    if (st.state === 'stopped') {
      this.acceptLivePackets = false;
      this.setState(this.stopPromise ? 'stopping' : 'idle');
      if (st.error) toast(st.error, 'err');
      this.refreshSide();
    }
    this.renderStats();
  }

  onLivePackets({ buf, meta, lts }) {
    if (this.disposed || !this.acceptLivePackets) return;
    const m = new Float64Array(meta);
    const u8 = new Uint8Array(buf);
    // Windows' driver tags every packet with its link type (Ethernet, raw IP, 802.11).
    const lt = lts ? new Uint16Array(lts) : null;
    const items = [];
    for (let i = 0; i < m.length; i += 4) items.push({ ts: m[i], caplen: m[i + 1], len: m[i + 2], data: u8.subarray(m[i + 3], m[i + 3] + m[i + 1]), linktype: lt ? lt[i / 4] : this.linktype });
    this.ingest(items, this.captureFilter);
    if (this.packets.length >= MAX_PACKETS && this.state === 'running') {
      this.stop();
      toast(`Capture stopped at ${MAX_PACKETS.toLocaleString()} packets (memory limit). Save it, then start a new one.`, 'err');
    }
  }

  /** capFilter: drop packets that do not match (capture filter of the built-in engine). */
  ingest(items, capFilter) {
    for (const it of items) {
      const pkt = { no: this.packets.length + 1, ts: it.ts, caplen: it.caplen, len: it.len, data: it.data, lt: it.linktype };
      pkt.d = decode(pkt.lt, pkt.data);
      if (capFilter && !capFilter.test(pkt)) {
        this.capFiltered++;
        continue;
      }
      this.analyzer.ingest(pkt);
      this.packets.push(pkt);
      if (!this.filter || this.filter.test(pkt)) this.view.push(this.packets.length - 1);
    }
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.list.setCount(this.view.length);
      if (this.autoScroll && this.state === 'running') this.list.scrollToEnd();
      this.list.render();
      this.renderStats();
      if (this.packets.length && !this.notice.classList.contains('hidden')) this.showNotice();
      const now = Date.now();
      if (!this.lastSide || now - this.lastSide > 1000) {
        this.lastSide = now;
        this.refreshSide();
      }
    });
  }

  onTick() {
    const bytes = this.analyzer.total.bytes;
    const pps = this.packets.length - this.lastCount;
    const bps = (bytes - this.lastBytes) * 8;
    this.lastCount = this.packets.length;
    this.lastBytes = bytes;
    this.rateHist.push(bps);
    if (this.rateHist.length > 60) this.rateHist.shift();
    this.rate = { pps, bps };
    this.renderStats();
    this.refreshSide();
  }

  renderStats() {
    const r = this.rate || { pps: 0, bps: 0 };
    const shown = this.view.length !== this.packets.length ? ` · ${this.view.length.toLocaleString()} shown` : '';
    const live = this.state === 'running' ? ` · ${r.pps}/s · ${fmtRate(r.bps)}` : '';
    const drops = this.stats.dropped ? ` · ${this.stats.dropped} dropped` : '';
    const filtered = this.capFiltered ? ` · ${this.capFiltered.toLocaleString()} filtered out` : '';
    this.statsEl.textContent = `${this.packets.length.toLocaleString()} packets${shown}${live}${filtered}${drops}`;
    this.app.updateStatus(this);
    // throughput sparkline: live rate, else per-second timeline
    const series = this.state === 'running' ? this.rateHist : this.analyzer.timeline.slice(-60).map((t) => t.bytes * 8);
    const ctx = this.spark.getContext('2d');
    const W = this.spark.width;
    const H = this.spark.height;
    ctx.clearRect(0, 0, W, H);
    if (!series.length) return;
    const max = Math.max(1, ...series);
    const errs = this.state === 'running' ? [] : this.analyzer.timeline.slice(-60).map((t) => t.errors);
    ctx.strokeStyle = '#3b9cf2';
    ctx.fillStyle = 'rgba(59,156,242,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = (i / Math.max(1, series.length - 1)) * (W - 2) + 1;
      const y = H - 2 - (v / max) * (H - 6);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.lineTo(W - 1, H);
    ctx.lineTo(1, H);
    ctx.fill();
    errs.forEach((e, i) => {
      if (!e) return;
      ctx.fillStyle = '#f0645b';
      ctx.fillRect((i / Math.max(1, series.length - 1)) * (W - 2), 0, 3, 5);
    });
  }

  clear(ask) {
    const go = () => {
      this.rtpAbort?.abort();
      this.packets = [];
      this.view = [];
      this.analyzer.reset();
      this.selected = -1;
      this.rateHist = [];
      this.lastCount = 0;
      this.lastBytes = 0;
      this.stats = { received: 0, dropped: 0 };
      this.capFiltered = 0;
      this.list.setCount(0);
      this.list.render();
      this.treeEl.replaceChildren();
      this.hexEl.replaceChildren();
      this.explainEl.replaceChildren();
      this.renderStats();
      this.refreshSide();
      this.showNotice();
    };
    if (ask && this.packets.length) confirmDialog(`Clear ${this.packets.length.toLocaleString()} packets?`, { okLabel: 'Clear', danger: true }).then((ok) => ok && go());
    else go();
  }

  // ------------------------------------------------------------ files

  async openFile() {
    try {
      const r = await api.invoke('cap:open');
      if (r) await this.loadBytes(r.bytes, r.name);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async openSample() {
    try {
      await this.loadBytes(await api.invoke('cap:sample'), 'branch-office-sample.pcapng');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async loadBytes(bytes, name) {
    const generation = this.loadGeneration = (this.loadGeneration || 0) + 1;
    await this.stop();
    const captureGeneration = this.captureGeneration;
    const current = () => !this.disposed && generation === this.loadGeneration && captureGeneration === this.captureGeneration;
    if (!current()) return;
    const { packets, format } = readCapture(bytes);
    this.clear(false);
    this.fileName = name;
    this.app.setTabTitle(this, name);
    // Decode in slices so the window stays responsive on big files.
    for (let i = 0; i < packets.length; i += 4000) {
      if (!current()) return;
      this.ingest(packets.slice(i, i + 4000));
      this.statsEl.textContent = `Loading… ${Math.min(packets.length, i + 4000).toLocaleString()} / ${packets.length.toLocaleString()}`;
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!current()) return;
    this.notice.classList.add('hidden');
    this.list.setCount(this.view.length);
    this.list.scrollTo(0);
    this.list.render();
    this.refreshSide();
    this.renderStats();
    toast(`Loaded ${packets.length.toLocaleString()} packets (${/\.etl$/i.test(name) ? 'Windows trace' : format})`, 'ok');
  }

  saveMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: `Save all packets (${this.packets.length.toLocaleString()})`, icon: 'save', disabled: !this.packets.length, action: () => this.save(this.packets) },
      { label: `Save displayed packets (${this.view.length.toLocaleString()})`, disabled: !this.view.length || this.view.length === this.packets.length, action: () => this.save(this.view.map((i) => this.packets[i])) },
    ]);
  }

  async save(pkts) {
    try {
      // Live capture can append packets while the native save dialog is open.
      const count = pkts.length;
      const bytes = writePcapng(pkts.map((p) => ({ ts: p.ts, len: p.len, linktype: p.lt, data: p.data })));
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const p = await api.invoke('cap:save', `${(this.fileName || 'konx-capture').replace(/\.(pcapng|pcap|cap)$/i, '')}-${stamp}.pcapng`, bytes);
      if (p) toast(`Saved ${count.toLocaleString()} packets to ${p}`, 'ok');
    } catch (error) {
      toast(errMsg(error), 'err');
    }
  }

  // ------------------------------------------------------------ filtering

  validateFilter() {
    try {
      compileFilter(this.dfilter.value);
      this.filterBox.classList.remove('bad');
      this.filterBox.classList.toggle('good', !!this.dfilter.value.trim());
      this.filterBox.title = '';
    } catch (e) {
      this.filterBox.classList.add('bad');
      this.filterBox.classList.remove('good');
      this.filterBox.title = e.message;
    }
  }

  setFilter(text) {
    this.dfilter.value = text;
    this.applyFilter();
  }

  applyFilter() {
    let f;
    try {
      f = compileFilter(this.dfilter.value);
    } catch (e) {
      this.validateFilter();
      toast(`Filter: ${e.message}`, 'err');
      return;
    }
    this.filter = f;
    const selNo = this.selected >= 0 ? this.packets[this.selected] && this.packets[this.selected].no : null;
    this.view = [];
    for (let i = 0; i < this.packets.length; i++) if (!f || f.test(this.packets[i])) this.view.push(i);
    this.validateFilter();
    this.list.setCount(this.view.length);
    const vi = selNo ? this.view.indexOf(selNo - 1) : -1;
    if (vi >= 0) this.list.ensureVisible(vi);
    else this.list.scrollTo(0);
    this.list.render();
    this.renderStats();
  }

  // ------------------------------------------------------------ selection + details

  select(pktIndex) {
    this.selected = pktIndex;
    this.list.render();
    const p = this.packets[pktIndex];
    if (!p) return;
    const full = decode(p.lt, p.data, { tree: true });
    const frame = new Node(`Frame ${p.no}: ${p.len} bytes on wire (${p.len * 8} bits), ${p.caplen} bytes captured`, 0, p.caplen);
    frame.add(`Arrival Time: ${new Date(p.ts * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC')}`);
    frame.add(`Time since first packet: ${p.rel.toFixed(6)} s`);
    frame.add(`Link type: ${LINKTYPES[p.lt] || p.lt}`);
    frame.add(`Protocols in frame: ${full.layers.join(':')}`);
    if (p.ann && p.ann.stream != null) frame.add(`Stream index: ${p.ann.stream}`);
    this.renderExplain(p, full);
    this.renderTree([frame, ...full.nodes]);
    this.renderHex(p.data);
  }

  renderExplain(p, full) {
    const items = [];
    for (const s of full.explain.slice(-2)) items.push(h('div.ex-line', icon('info'), s));
    for (const e of (p.ann && p.ann.expert) || []) items.push(h('div.ex-line', { class: 'ex-' + e.sev }, icon(e.sev === 'error' ? 'alert' : e.sev === 'warn' ? 'alert' : 'check'), e.text));
    for (const n of full.notes) items.push(h('div.ex-line.ex-note', icon('info'), n));
    this.explainEl.replaceChildren(...items);
  }

  renderTree(nodes) {
    const build = (n, depth) => {
      const hasKids = !!(n.children && n.children.length);
      const kids = hasKids ? h('div.tnode-kids', { class: n.open ? '' : 'hidden' }, n.children.map((c) => build(c, depth + 1))) : null;
      const row = h('div.trow', { style: { paddingLeft: 6 + depth * 16 + 'px' } }, h('span.tchev', hasKids ? icon(n.open ? 'chev-down' : 'chev-right') : ''), h('span', n.label));
      row.addEventListener('click', () => {
        this.treeEl.querySelectorAll('.trow.sel').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        this.highlight(n.start, n.len);
        if (hasKids) {
          n.open = !n.open;
          kids.classList.toggle('hidden', !n.open);
          row.querySelector('.tchev').replaceChildren(icon(n.open ? 'chev-down' : 'chev-right'));
        }
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [{ label: 'Copy', icon: 'copy', action: () => api.invoke('clipboard:write', n.label) }]);
      });
      return h('div.tnode', row, kids);
    };
    // Open the innermost protocol layer, like an expert would read it.
    if (nodes.length > 1) nodes[nodes.length - 1].open = true;
    this.treeEl.replaceChildren(...nodes.map((n) => build(n, 0)));
  }

  renderHex(data) {
    const lines = [];
    for (let o = 0; o < data.length; o += 16) {
      let hex = '';
      let asc = '';
      for (let i = 0; i < 16; i++) {
        if (o + i < data.length) {
          const b = data[o + i];
          hex += `<span data-o="${o + i}">${b.toString(16).padStart(2, '0')}</span>${i === 7 ? '  ' : ' '}`;
          asc += `<span data-o="${o + i}">${b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '.'}</span>`;
        } else hex += '   ';
      }
      lines.push(`<div class="hline"><span class="hoff">${o.toString(16).padStart(4, '0')}</span><span class="hhex">${hex}</span><span class="hasc">${asc}</span></div>`);
    }
    this.hexEl.innerHTML = lines.join('');
  }

  highlight(start, len) {
    this.hexEl.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
    if (!len) return;
    let first = null;
    for (let o = start; o < start + len; o++) {
      this.hexEl.querySelectorAll(`[data-o="${o}"]`).forEach((x) => {
        x.classList.add('hl');
        first = first || x;
      });
    }
    if (first) first.scrollIntoView({ block: 'nearest' });
  }

  name(addr) {
    if (!this.resolveNames || !addr) return addr;
    const n = this.analyzer.names.get(addr);
    return n || addr;
  }

  rowMenu(e, pktIndex) {
    const p = this.packets[pktIndex];
    const d = p.d;
    const stream = p.ann && p.ann.stream;
    const proto = d.tcp ? 'tcp' : d.udp ? 'udp' : null;
    const srcIp = d.f['ip.src'] || d.f['ipv6.src'];
    const dstIp = d.f['ip.dst'] || d.f['ipv6.dst'];
    contextMenu(e.clientX, e.clientY, [
      proto && { label: `Follow ${proto.toUpperCase()} stream`, icon: 'route', action: () => this.follow(stream, proto.toUpperCase()) },
      proto && { label: 'Filter on this conversation', icon: 'filter', action: () => this.setFilter(`${proto}.stream == ${stream}`) },
      srcIp && { label: `Filter on source ${srcIp}`, action: () => this.setFilter(`host ${srcIp}`) },
      dstIp && { label: `Filter on destination ${dstIp}`, action: () => this.setFilter(`host ${dstIp}`) },
      { label: `Filter on protocol ${d.proto}`, action: () => this.setFilter(d.proto.toLowerCase().replace(/v1\.3$/, '').replace('tlsv1.2', 'tls')) },
      '-',
      { label: 'Copy summary', icon: 'copy', action: () => api.invoke('clipboard:write', `${p.no}\t${fmtTime(p.rel)}\t${d.src}\t${d.dst}\t${d.proto}\t${p.len}\t${d.info}`) },
      { label: 'Copy as hex', action: () => api.invoke('clipboard:write', Array.from(p.data).map((b) => b.toString(16).padStart(2, '0')).join('')) },
      srcIp && '-',
      srcIp && { label: `Actions for ${srcIp}…`, icon: 'server', action: () => contextMenu(e.clientX + 20, e.clientY, this.app.hostMenu(srcIp)) },
      dstIp && { label: `Actions for ${dstIp}…`, icon: 'server', action: () => contextMenu(e.clientX + 20, e.clientY, this.app.hostMenu(dstIp, d.dport)) },
    ]);
  }

  async follow(streamId, proto = 'TCP') {
    if (this.followOpen) return;
    this.followOpen = true;
    const packets = this.packets;
    try {
      const stream = this.analyzer.followStream(packets, streamId, proto);
      if (!stream) return;
      const result = await showTraffic(stream);
      // A different capture may have been loaded while the dialog was open.
      if (!result || this.disposed || this.packets !== packets) return;
      if (result.action === 'filter') this.setFilter(`${proto.toLowerCase()}.stream == ${streamId}`);
      if (result.action === 'packet') {
        const index = packets.findIndex((p) => p.no === result.frame);
        if (index < 0) return;
        this.setAutoScroll(false);
        this.setFilter(`${proto.toLowerCase()}.stream == ${streamId}`);
        this.select(index);
        this.list.ensureVisible(this.view.indexOf(index));
      }
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      this.followOpen = false;
    }
  }

  async openSipCalls(callKey = null) {
    if (this.sipOpen) return;
    this.sipOpen = true;
    this.sipButton.disabled = true;
    const packets = this.packets;
    const snapshot = packets.slice();
    const sourceName = this.fileName || 'Live capture snapshot';
    let media = null;
    try {
      // Yield for the busy control to paint before bounded, on-demand analysis.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.disposed || this.packets !== packets) return;
      const analysis = analyzeSipCalls(snapshot);
      const save = async (format, bytes) => {
        const path = await api.invoke('cap:saveSip', format, bytes);
        if (path) toast('SIP call exported', 'ok');
      };
      const result = await showSipCalls(analysis, {
        initialCallKey: callKey,
        allowMedia: true,
        onExportCall: (call) => save('pcapng', buildSipCallCapture(snapshot, call)),
        onExportReport: (call) => save('json', buildSipCallReport(call, { ...analysis, sourceName })),
      });
      if (!result || this.disposed || this.packets !== packets) return;
      if (result.action === 'media') media = { callKey: result.callKey, packets, snapshot, sipCalls: analysis.calls };
      if (result.action === 'packet') {
        const index = packets.findIndex((packet) => packet.no === result.frame);
        if (index < 0) return;
        this.setAutoScroll(false);
        // SIP may be split over TCP packets that have no per-packet SIP label.
        if (!this.view.includes(index)) this.setFilter('');
        this.select(index);
        this.list.ensureVisible(this.view.indexOf(index));
      }
    } catch (error) {
      toast(errMsg(error), 'err');
    } finally {
      this.sipOpen = false;
      this.sipButton.disabled = false;
    }
    if (media && !this.disposed && this.packets === packets) await this.openRtpMedia(media.callKey, media);
  }

  async openRtpMedia(callKey = null, context = null) {
    if (this.rtpOpen || this.disposed) return;
    this.rtpOpen = true;
    this.rtpButton.disabled = true;
    const packets = context?.packets || this.packets;
    const snapshot = context?.snapshot || packets.slice();
    const controller = new AbortController();
    this.rtpAbort = controller;
    const current = () => !this.disposed && this.packets === packets && !controller.signal.aborted;
    let next = null;
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!current()) return;
      const sipCalls = context?.sipCalls || analyzeSipCalls(snapshot).calls;
      const result = await showRtpMedia(snapshot, {
        sipCalls, callKey, signal: controller.signal, allowDemo: true,
        onExportWav: (name, bytes) => {
          if (!current()) throw new Error('The source capture was replaced or closed.');
          return api.invoke('cap:saveBody', name, bytes);
        },
      });
      if (!result || !current()) return;
      if (result.action === 'packet') {
        const index = packets.findIndex(packet => packet.no === result.frame);
        if (index < 0) return;
        this.setAutoScroll(false);
        if (!this.view.includes(index)) this.setFilter('');
        this.select(index);
        this.list.ensureVisible(this.view.indexOf(index));
      } else if (result.action === 'demo' || result.action === 'call') next = result;
    } catch (error) { toast(errMsg(error), 'err'); }
    finally {
      controller.abort();
      if (this.rtpAbort === controller) this.rtpAbort = null;
      this.rtpOpen = false;
      this.rtpButton.disabled = false;
    }
    if (next?.action === 'demo' && !this.disposed) {
      if (packets.length && !(await confirmDialog('Replace this capture with the synthetic RTP demo? Save any packets you need first.', { okLabel: 'Load demo' }))) return;
      if (this.disposed || this.packets !== packets) return;
      const demo = makeRtpDemo();
      await this.loadBytes(demo.bytes, demo.name);
      if (!this.disposed) await this.openRtpMedia();
    } else if (next?.action === 'call' && !this.disposed && this.packets === packets) {
      await this.openSipCalls(next.callKey);
    }
  }

  // ------------------------------------------------------------ side panel

  renderSideTabs() {
    const tabs = ['Insights', 'Conversations', 'Endpoints', 'Protocols', 'Neighbors'];
    this.sideTabs.replaceChildren(
      ...tabs.map((t) => h('button', { class: t === this.sideTab ? 'active' : '', onclick: () => ((this.sideTab = t), this.renderSideTabs(), this.refreshSide(true)) }, t))
    );
  }

  refreshSide(force) {
    if (!this.active && !force) return;
    const a = this.analyzer;
    const keep = this.sideBody.scrollTop;
    if (this.sideTab === 'Insights') this.sideBody.replaceChildren(...this.insightsView(a));
    else if (this.sideTab === 'Conversations') this.sideBody.replaceChildren(this.convTable(a));
    else if (this.sideTab === 'Endpoints') this.sideBody.replaceChildren(this.endpointTable(a));
    else if (this.sideTab === 'Protocols') this.sideBody.replaceChildren(this.protoTable(a));
    else this.sideBody.replaceChildren(...this.neighborsView(a));
    this.sideBody.scrollTop = keep;
  }

  insightsView(a) {
    if (!a.total.pkts) return [h('div.side-empty', icon('insight'), h('div', 'Insights appear here as packets arrive: problems, security issues and what the network is telling you, in plain English.'))];
    const hlth = a.health();
    const kpi = (label, value, bad) => h('div.kpi', { class: bad ? 'bad' : '' }, h('div.kv-v', value), h('div.kv-l', label));
    const kpis = h(
      'div.kpis',
      kpi('TCP retrans', `${hlth.retransPct.toFixed(1)}%`, hlth.retransPct > 2),
      kpi('Handshake', fmtMs(hlth.handshakeAvg), hlth.handshakeAvg > 0.2),
      kpi('DNS avg', fmtMs(hlth.dnsAvg), hlth.dnsAvg > 0.2),
      kpi('DNS fails', `${hlth.dnsFailPct.toFixed(0)}%`, hlth.dnsFailPct > 5)
    );
    const cards = a.insights().map((i) =>
      h(
        'div.insight',
        { class: i.sev, title: i.filter ? `Click to filter: ${i.filter}` : '', onclick: () => i.filter && this.setFilter(i.filter) },
        h('div.ins-head', h('span.ins-cat', i.cat), i.count ? h('span.ins-count', String(i.count)) : null),
        h('div.ins-title', i.title),
        i.detail ? h('div.ins-detail', i.detail) : null
      )
    );
    return [kpis, ...cards];
  }

  convTable(a) {
    const t = new DataTable({
      columns: [
        { key: 'proto', label: '', width: 44 },
        { key: 'a', label: 'Address A', render: (c) => this.nameEndpoint(c.a) },
        { key: 'b', label: 'Address B', render: (c) => this.nameEndpoint(c.b) },
        { key: 'pkts', label: 'Pkts', width: 56, num: true, sort: (c) => c.pktsAB + c.pktsBA, render: (c) => c.pktsAB + c.pktsBA },
        { key: 'bytes', label: 'Bytes', width: 70, num: true, sort: (c) => c.bytesAB + c.bytesBA, render: (c) => fmtBytes(c.bytesAB + c.bytesBA) },
      ],
      rowKey: (c) => c.proto + c.id,
      emptyText: 'No TCP or UDP conversations yet.',
      onActivate: (c) => this.setFilter(`${c.proto.toLowerCase()}.stream == ${c.id}`),
      onContext: (e, rows) =>
        rows[0] &&
        contextMenu(e.clientX, e.clientY, [
          { label: 'Follow stream', icon: 'route', action: () => this.follow(rows[0].id, rows[0].proto) },
          { label: 'Filter this conversation', icon: 'filter', action: () => this.setFilter(`${rows[0].proto.toLowerCase()}.stream == ${rows[0].id}`) },
        ]),
    });
    t.sortKey = 'bytes';
    t.sortDir = -1;
    t.setRows(a.streams.filter((c) => c.pktsAB + c.pktsBA > 0));
    t.el.classList.add('side-table');
    return t.el;
  }

  nameEndpoint(ep) {
    const i = ep.lastIndexOf(':');
    const addr = ep.slice(0, i);
    const n = this.resolveNames && this.analyzer.names.get(addr);
    return n ? `${n}:${ep.slice(i + 1)}` : ep;
  }

  endpointTable(a) {
    const t = new DataTable({
      columns: [
        { key: 'addr', label: 'Address', render: (e) => (this.resolveNames && a.names.get(e.addr) ? `${e.addr} (${a.names.get(e.addr)})` : e.addr) },
        { key: 'pkts', label: 'Pkts', width: 60, num: true, sort: (e) => e.pktsTx + e.pktsRx, render: (e) => e.pktsTx + e.pktsRx },
        { key: 'bytes', label: 'Bytes', width: 76, num: true, sort: (e) => e.bytesTx + e.bytesRx, render: (e) => fmtBytes(e.bytesTx + e.bytesRx) },
      ],
      rowKey: (e) => e.addr,
      emptyText: 'No endpoints yet.',
      onActivate: (e) => this.setFilter(`host ${e.addr}`),
      onContext: (ev, rows) =>
        rows[0] &&
        contextMenu(ev.clientX, ev.clientY, [
          { label: `Filter on ${rows[0].addr}`, icon: 'filter', action: () => this.setFilter(`host ${rows[0].addr}`) },
          '-',
          ...(rows[0].addr.includes(':') && rows[0].addr.length === 17 ? [] : this.app.hostMenu(rows[0].addr)),
        ]),
    });
    t.sortKey = 'bytes';
    t.sortDir = -1;
    t.setRows([...a.endpoints.values()]);
    t.el.classList.add('side-table');
    return t.el;
  }

  protoTable(a) {
    const total = Math.max(1, a.total.pkts);
    const t = new DataTable({
      columns: [
        { key: 'name', label: 'Protocol' },
        { key: 'pkts', label: 'Packets', width: 70, num: true },
        { key: 'pct', label: '%', width: 56, num: true, render: (r) => ((r.pkts / total) * 100).toFixed(1) },
        { key: 'bytes', label: 'Bytes', width: 76, num: true, render: (r) => fmtBytes(r.bytes) },
      ],
      rowKey: (r) => r.name,
      emptyText: 'No packets yet.',
      onActivate: (r) => this.setFilter(r.name.toLowerCase().replace(/^tlsv1\.[23]$/, 'tls').replace(/^sshv2$/, 'ssh').replace(/^ipv4$/, 'ip')),
    });
    t.sortKey = 'pkts';
    t.sortDir = -1;
    t.setRows([...a.protocols].map(([name, v]) => ({ name, ...v })));
    t.el.classList.add('side-table');
    return t.el;
  }

  neighborsView(a) {
    const out = [];
    for (const n of a.neighbors.values()) {
      out.push(
        h(
          'div.neighbor',
          h('div.nb-title', icon('network'), h('b', n.device || n.chassis || 'Unknown device'), h('span.pill.muted', n.proto)),
          h('div.kvs', ...[['Your port on it', n.port], ['Port description', n.portDesc], ['Platform', n.platform], ['Software', n.software], ['Native VLAN', n.vlan], ['Voice VLAN', n.voiceVlan], ['Management IP', n.mgmt], ['Capabilities', (n.caps || []).join(', ')], ['Duplex', n.duplex], ['VTP domain', n.vtp], ['MAC', n.mac]]
            .filter(([, v]) => v != null && v !== '')
            .flatMap(([k, v]) => [h('div.k', k), h('div.v', String(v))])),
          n.mgmt ? h('div.nb-actions', h('button.btn.sm', { onclick: () => this.app.quickConnect({ protocol: 'ssh', host: n.mgmt, port: 22 }) }, icon('terminal'), 'SSH'), h('button.btn.sm', { onclick: () => this.app.openTool('ping', { hosts: n.mgmt }) }, icon('activity'), 'Ping')) : null
        )
      );
    }
    for (const s of a.dhcp.servers.values()) out.push(h('div.neighbor', h('div.nb-title', icon('server'), h('b', `DHCP server ${s.ip}`)), h('div.kvs', h('div.k', 'MAC'), h('div.v', s.mac || ''), h('div.k', 'Offers / ACKs'), h('div.v', `${s.offers} / ${s.acks}`), s.router ? h('div.k', 'Gateway') : null, s.router ? h('div.v', s.router.join(', ')) : null, s.dns ? h('div.k', 'DNS') : null, s.dns ? h('div.v', s.dns.join(', ')) : null)));
    if (!out.length) out.push(h('div.side-empty', icon('network'), h('div', 'Switches and phones announce themselves with CDP or LLDP every 30–60 s. Capture on a wired port for a minute to see which switch, port and VLAN you are plugged into.')));
    return out;
  }

  // ------------------------------------------------------------ tab interface

  show() {
    this.active = true;
    requestAnimationFrame(() => {
      this.list.render();
      this.refreshSide(true);
    });
  }

  hide() {
    this.active = false;
  }

  focus() {
    this.list.scroller.focus();
  }

  statusSegments() {
    const segs = [{ icon: 'capture', text: 'Packet Capture' }];
    if (this.state === 'running') segs.push({ text: 'Capturing', cls: 'warn' });
    else if (this.fileName) segs.push({ text: this.fileName });
    segs.push({ text: `${this.packets.length.toLocaleString()} packets` });
    if (this.status && this.status.available) {
      const dev = this.selectedDevice();
      if (dev && dev.engine === 'builtin') segs.push({ text: 'Windows capture driver' });
      else if (this.status.npcap && this.status.npcap.available) segs.push({ text: this.status.npcap.version.split(',')[0] });
    }
    return segs;
  }

  dispose() {
    this.disposed = true;
    this.rtpAbort?.abort();
    this.acceptLivePackets = false;
    this.captureGeneration = (this.captureGeneration || 0) + 1;
    api.invoke('cap:stop', this.id).catch(() => {});
    if (this.tick) clearInterval(this.tick);
  }
}

/** Virtualized packet list: only the visible rows exist in the DOM. */
class PacketList {
  constructor(tab) {
    this.tab = tab;
    this.count = 0;
    const cols = ['No.', 'Time', 'Source', 'Destination', 'Protocol', 'Length', 'Info'];
    this.head = h('div.prow.phead', cols.map((c) => h('span', c)));
    this.spacer = h('div.pspacer');
    this.rows = h('div.prows');
    this.scroller = h('div.pscroll', { tabIndex: 0 }, this.spacer, this.rows);
    this.el = h('div.plist', this.head, this.scroller);
    this.scroller.addEventListener('scroll', () => {
      // Scrolling up pauses following until Auto-scroll is checked again.
      const atEnd = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - ROW_H * 2;
      if (this.tab.state === 'running' && !atEnd && this.lastTop > this.scroller.scrollTop) this.tab.setAutoScroll(false);
      this.lastTop = this.scroller.scrollTop;
      this.render();
    });
    this.rows.addEventListener('mousedown', (e) => {
      const r = e.target.closest('.prow');
      if (!r) return;
      this.tab.select(Number(r.dataset.p));
      this.scroller.focus();
    });
    this.rows.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.prow');
      if (!r) return;
      e.preventDefault();
      this.tab.select(Number(r.dataset.p));
      this.tab.rowMenu(e, Number(r.dataset.p));
    });
    this.rows.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.prow');
      const p = r && this.tab.packets[Number(r.dataset.p)];
      if (p && p.ann && p.ann.stream != null && (p.d.tcp || p.d.udp)) this.tab.follow(p.ann.stream, p.d.tcp ? 'TCP' : 'UDP');
    });
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
  }

  setCount(n) {
    this.count = n;
    this.spacer.style.height = n * ROW_H + 'px';
  }

  scrollToEnd() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.lastTop = this.scroller.scrollTop;
  }

  scrollTo(vi) {
    this.scroller.scrollTop = vi * ROW_H;
  }

  ensureVisible(vi) {
    const top = vi * ROW_H;
    const s = this.scroller;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (top + ROW_H > s.scrollTop + s.clientHeight) s.scrollTop = top + ROW_H - s.clientHeight;
  }

  onKey(e) {
    const t = this.tab;
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = t.view.indexOf(t.selected);
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_H) - 1);
    let vi = cur < 0 ? 0 : cur;
    if (e.key === 'ArrowDown') vi++;
    if (e.key === 'ArrowUp') vi--;
    if (e.key === 'PageDown') vi += page;
    if (e.key === 'PageUp') vi -= page;
    if (e.key === 'Home') vi = 0;
    if (e.key === 'End') vi = t.view.length - 1;
    vi = Math.max(0, Math.min(t.view.length - 1, vi));
    if (t.view[vi] == null) return;
    t.setAutoScroll(false);
    this.ensureVisible(vi);
    t.select(t.view[vi]);
  }

  render() {
    const t = this.tab;
    const s = this.scroller;
    const first = Math.max(0, Math.floor(s.scrollTop / ROW_H) - 5);
    const last = Math.min(this.count, first + Math.ceil((s.clientHeight || 600) / ROW_H) + 10);
    let html = '';
    for (let vi = first; vi < last; vi++) {
      const pi = t.view[vi];
      const p = t.packets[pi];
      if (!p) continue;
      const d = p.d;
      const src = t.name(d.src);
      const dst = t.name(d.dst);
      html += `<div class="prow c-${d.cls || 'none'}${pi === t.selected ? ' sel' : ''}" data-p="${pi}" style="top:${vi * ROW_H}px"><span>${p.no}</span><span>${fmtTime(p.rel)}</span><span title="${esc(d.src)}">${esc(src)}</span><span title="${esc(d.dst)}">${esc(dst)}</span><span>${esc(d.proto)}</span><span>${p.len}</span><span title="${esc(d.info)}">${esc(d.info)}</span></div>`;
    }
    this.rows.innerHTML = html;
  }
}
