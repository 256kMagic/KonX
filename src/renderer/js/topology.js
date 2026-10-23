import { h, icon, api, errMsg, toast } from './ui.js';

const shown = value => value === null || value === undefined || value === '' ? 'Unknown' : String(value);
const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown time';
const short = (value, limit = 34) => String(value || 'Unknown').length > limit ? String(value).slice(0, limit - 1) + '…' : String(value || 'Unknown');
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value); else node.setAttribute(name, value);
  }
  for (const child of children.flat()) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
function activate(event, action) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); } }

export class TopologyTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'topology'; this.icon = 'link'; this.title = 'Visual Topology';
    this.id = 'topology-' + Math.random().toString(36).slice(2); this.state = 'idle'; this.seq = 0; this.snapshotSeq = 0;
    this.report = null; this.inputReport = null; this.busy = false; this.disposed = false; this.positions = new Map(); this.selection = null;
    this.status = h('p.topology-status', { role: 'status', 'aria-live': 'polite' }, 'Load observations or a saved snapshot. Opening this map never connects to or collects from a device.');
    this.demoButton = h('button.btn', { onclick: () => this.load(() => api.invoke('tools:deviceDemo'), 'Synthetic demo loaded. No network connection was made.') }, icon('play'), 'Load demo');
    this.importButton = h('button.btn', { onclick: () => this.load(() => api.invoke('tools:topologyImport'), 'Saved report loaded. Collection times are retained.') }, icon('folder-open'), 'Load report');
    this.exportButton = h('button.btn', { disabled: true, onclick: () => this.export() }, icon('download'), 'Export JSON');
    this.snapshots = h('select.input', { 'aria-label': 'Topology saved snapshot', onchange: () => this.updateButtons() }, h('option', { value: '' }, 'Choose saved snapshot'));
    this.refreshButton = h('button.btn.sm', { onclick: () => this.refreshSnapshots(), title: 'Refresh saved snapshots', 'aria-label': 'Refresh saved snapshots' }, icon('refresh'));
    this.snapshotButton = h('button.btn', { disabled: true, onclick: () => this.load(async () => { const record = await api.invoke('tools:snapshotGet', this.snapshots.value); if (!record?.report) throw new Error('Snapshot is no longer available. Refresh the list.'); return record.report; }, 'Saved snapshot loaded. This is recorded evidence, not live device status.') }, 'Load snapshot');
    this.query = h('input.input', { value: params.endpoint || '', placeholder: 'MAC or IPv4 address', 'aria-label': 'Topology endpoint MAC or IPv4', onkeydown: event => { if (event.key === 'Enter') this.rebuild(); } });
    this.traceButton = h('button.btn.primary', { disabled: true, onclick: () => this.rebuild() }, icon('search'), 'Trace endpoint');
    this.clearButton = h('button.btn.sm', { disabled: true, onclick: () => { this.query.value = ''; this.rebuild(); } }, 'Clear trace');
    this.threshold = h('select.input', { 'aria-label': 'Topology stale threshold', onchange: () => this.rebuild() },
      [[1, '1 hour'], [6, '6 hours'], [24, '24 hours'], [168, '7 days'], [720, '30 days']].map(([value, label]) => h('option', { value: String(value) }, label)));
    this.threshold.value = '24';
    this.summary = h('div.topology-summary', 'No observations loaded');
    this.zoomOutButton = h('button.btn.sm', { 'aria-label': 'Zoom topology out', onclick: () => this.zoom(1.25) }, '−');
    this.zoomInButton = h('button.btn.sm', { 'aria-label': 'Zoom topology in', onclick: () => this.zoom(0.8) }, '+');
    this.fitButton = h('button.btn.sm', { onclick: () => this.fit() }, 'Fit map');
    this.map = svg('svg', { class: 'topology-map', role: 'group', 'aria-label': 'Observed network topology', viewBox: '0 0 800 450',
      onpointermove: event => this.move(event), onpointerup: event => this.endDrag(event), onpointercancel: event => this.endDrag(event) });
    this.map.addEventListener('pointerdown', event => {
      if (!this.report || event.button !== 0 || event.target.closest('[data-node-id],[data-link-id]')) return;
      this.drag = { pointerId: event.pointerId, start: this.point(event), view: { ...this.view } }; this.map.setPointerCapture(event.pointerId);
    });
    this.empty = h('div.topology-empty', icon('link'), h('strong', 'Map the evidence you already have'), h('p', 'CDP and LLDP links, recorded interface states, and candidate endpoint paths. Load demo to explore.'));
    this.canvas = h('div.topology-canvas', this.map, this.empty,
      h('div.topology-map-controls', this.zoomOutButton, this.zoomInButton, this.fitButton));
    this.detail = h('aside.topology-detail', { 'aria-label': 'Selected topology evidence' }, h('p.hint', 'Select a node or a link. Drag nodes to arrange the map; use arrow keys on a focused node to move it.'));
    this.evidenceHeading = h('p.hint'); this.raw = h('pre.topology-raw', { tabIndex: 0, 'aria-label': 'Topology source command output' });
    this.evidence = h('details.topology-evidence', h('summary', 'Source command evidence'), this.evidenceHeading, this.raw);
    this.coverage = h('div.topology-coverage'); this.endpointSummary = h('div.topology-endpoint');
    this.el = h('div.view.topology-view', h('link', { rel: 'stylesheet', href: new URL('../topology.css', import.meta.url).href }),
      h('div.tool-head', h('div.tool-title', icon('link'), h('h2', 'Visual Topology'), h('span.sub', 'Observed links and candidate paths')),
        h('div.topology-actions', this.demoButton, this.importButton, this.exportButton, this.snapshots, this.refreshButton, this.snapshotButton),
        h('div.topology-actions', this.query, this.traceButton, this.clearButton, h('label.topology-threshold', 'Stale after', this.threshold)), this.status),
      h('div.topology-summary-row', this.summary, h('span.hint', 'Schematic positions · recorded observations')),
      h('div.topology-content', this.canvas, this.detail), h('div.topology-bottom', this.endpointSummary, this.coverage, this.evidence));
    this.fit();
    this.ready = Promise.all([this.refreshSnapshots(), params.report ? this.load(() => params.report, 'Existing observations loaded. No collection was started.', params.deviceId) : Promise.resolve()]);
    this.updateButtons();
  }

  updateButtons() {
    for (const button of [this.demoButton, this.importButton]) button.disabled = this.busy;
    this.exportButton.disabled = this.traceButton.disabled = this.clearButton.disabled = this.threshold.disabled = this.busy || !this.report;
    this.snapshotButton.disabled = this.busy || !this.snapshots.value; this.snapshots.disabled = this.busy || this.snapshotBusy;
    this.refreshButton.disabled = this.snapshotBusy || this.busy; this.query.disabled = this.busy;
    for (const button of [this.zoomInButton, this.zoomOutButton, this.fitButton]) button.disabled = !this.report;
  }
  async refreshSnapshots() {
    if (this.disposed || this.snapshotBusy || this.busy) return;
    const request = ++this.snapshotSeq; this.snapshotBusy = true; this.updateButtons();
    try {
      const result = await api.invoke('tools:snapshotList');
      if (this.disposed || request !== this.snapshotSeq) return;
      const previous = this.snapshots.value;
      this.snapshots.replaceChildren(h('option', { value: '' }, 'Choose saved snapshot'), ...(result.snapshots || []).map(record => h('option', { value: record.id }, `${record.label} · ${when(record.savedAt)}`)));
      if ([...this.snapshots.options].some(option => option.value === previous)) this.snapshots.value = previous;
      this.snapshots.title = (result.issues || []).map(String).join('\n');
    } catch (error) { if (!this.disposed && request === this.snapshotSeq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.snapshotSeq) { this.snapshotBusy = false; this.updateButtons(); } }
  }
  async load(provider, message, selectedDeviceId) {
    if (this.disposed || this.busy) return;
    const request = ++this.seq; this.busy = true; this.updateButtons(); this.status.textContent = 'Building from captured observations…';
    try {
      const input = await provider();
      if (this.disposed || request !== this.seq || !input) { if (!this.disposed) this.status.textContent = 'Load cancelled. The previous map remains available.'; return; }
      const graph = await api.invoke('tools:topologyBuild', input, { staleHours: Number(this.threshold.value), endpoint: this.query.value.trim() });
      if (this.disposed || request !== this.seq) return;
      if (graph?.kind !== 'topology' || graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) throw new Error('Invalid topology response.');
      this.inputReport = input; this.report = graph; this.selection = null;
      this.graphOptions = { staleHours: graph.staleHours, at: graph.generatedAt, endpoint: graph.endpoint?.query || '' };
      this.aiContext = { kind: 'topology-summary', nodeCount: graph.nodes.length, linkCount: graph.links.length, staleHours: graph.staleHours, coverage: graph.coverage,
        unresolved: graph.nodes.filter(n => n.resolution === 'ambiguous' || n.resolution === 'unresolved').length, limitation: 'Recorded observations only; physical connectivity and endpoint attachment remain unverified.' };
      this.render(); this.status.textContent = message;
      if (selectedDeviceId && graph.nodes.some(n => n.id === 'device:' + selectedDeviceId)) this.select('node', 'device:' + selectedDeviceId);
      this.app.updateStatus?.(this);
    } catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); } }
  }
  rebuild() { if (this.inputReport) return this.load(() => this.inputReport, 'Map rebuilt from the same captured observations. No collection was started.'); }

  render() {
    const graph = this.report; this.positions.clear();
    const remaining = new Set(graph.nodes.map(n => n.id)); let componentRow = 0;
    while (remaining.size) {
      const seed = remaining.values().next().value; const levels = new Map([[seed, 0]]); const queue = [seed]; remaining.delete(seed);
      for (let index = 0; index < queue.length; index++) for (const link of graph.links) {
        const other = link.from === queue[index] ? link.to : link.to === queue[index] ? link.from : null;
        if (other && remaining.has(other)) { remaining.delete(other); levels.set(other, levels.get(queue[index]) + 1); queue.push(other); }
      }
      const rows = new Map();
      for (const id of queue) { const level = levels.get(id), row = rows.get(level) || 0; rows.set(level, row + 1); this.positions.set(id, { x: 160 + level * 300, y: 90 + (componentRow + row) * 125 }); }
      componentRow += Math.max(...rows.values()) + 1;
    }
    this.linkEls = new Map(); this.nodeEls = new Map(); this.curves = new Map();
    const pairCounts = new Map(), pairIndex = new Map(), pairKey = link => JSON.stringify([link.from, link.to].sort());
    for (const link of graph.links) pairCounts.set(pairKey(link), (pairCounts.get(pairKey(link)) || 0) + 1);
    for (const link of graph.links) { const key = pairKey(link), index = pairIndex.get(key) || 0; pairIndex.set(key, index + 1); this.curves.set(link.id, Math.max(-120, Math.min(120, (index - (pairCounts.get(key) - 1) / 2) * 38)) * (link.from < link.to ? 1 : -1)); }

    this.map.replaceChildren();
    for (const link of graph.links) {
      const group = svg('g', { class: `topology-link ${link.kind} ${link.age} ${link.resolution}`, 'data-link-id': link.id, tabindex: '0', role: 'button',
        'aria-label': `${link.protocols.join('/')} ${shown(link.localInterface)} to ${shown(link.remoteInterface)} · ${link.resolution}`, onclick: () => this.select('link', link.id), onkeydown: event => activate(event, () => this.select('link', link.id)) },
        svg('path', { class: 'topology-link-hit' }), svg('path', { class: 'topology-link-line' }), svg('title', {}, `${link.protocols.join('/')} · ${link.resolution} · ${link.age}`));
      this.map.append(group); this.linkEls.set(link.id, group);
    }
    for (const node of graph.nodes) {
      const group = svg('g', { class: `topology-node ${node.kind} ${node.age} ${node.resolution || ''}`, 'data-node-id': node.id, tabindex: '0', role: 'button',
        'aria-label': `${node.label} · ${node.kind} · ${node.age}`, onclick: () => this.select('node', node.id),
        onpointerdown: event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); this.select('node', node.id); this.drag = { pointerId: event.pointerId, nodeId: node.id, start: this.point(event), origin: { ...this.positions.get(node.id) } }; this.map.setPointerCapture(event.pointerId); },
        onkeydown: event => { const vectors = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }; if (vectors[event.key]) { event.preventDefault(); const p = this.positions.get(node.id); p.x += vectors[event.key][0]; p.y += vectors[event.key][1]; this.drawPositions(); } else activate(event, () => this.select('node', node.id)); } },
        svg('rect', { x: '-110', y: '-34', width: '220', height: '68', rx: '10' }),
        svg('text', { y: '-7', 'text-anchor': 'middle', class: 'topology-node-label' }, short(node.label, 28)),
        svg('text', { y: '15', 'text-anchor': 'middle', class: 'topology-node-caption' }, `${node.kind === 'device' ? 'Collected device' : node.kind === 'endpoint' ? 'Candidate endpoint' : node.resolution} · ${node.age === 'within-threshold' ? 'recorded' : node.age}`),
        svg('title', {}, `${node.label}\n${shown(node.host)}\n${when(node.collectedAt)}`));
      this.map.append(group); this.nodeEls.set(node.id, group);
    }
    this.drawPositions(); this.fit(); this.empty.hidden = graph.nodes.length > 0;
    this.summary.textContent = `${graph.nodes.length} nodes · ${graph.links.length} observed links · ${graph.nodes.filter(n => n.age === 'stale').length} stale nodes`;
    this.detail.replaceChildren(h('h3', 'Select an observation'), h('p.hint', 'Select a device, neighbor, endpoint or link. Directional advertisements may appear as separate links. A missing link does not establish a failure.'));
    this.evidence.open = false; this.raw.replaceChildren(); this.evidenceHeading.textContent = '';
    const c = graph.coverage;
    this.coverage.replaceChildren(h('details', h('summary', `Coverage · ${c.completeGraph ? 'All bounded graph entries shown' : 'Graph limited'} · ${c.observationsComplete ? 'Neighbor/interface commands complete' : 'Incomplete command evidence'}`),
      !c.completeGraph ? h('p.notice', `Omitted nodes ${c.omittedNodes}, links ${c.omittedLinks}, evidence ${c.omittedEvidence}, ARP evidence ${c.omittedArpEvidence}, trace matches ${c.omittedTraceMatches}, paths ${c.omittedTracePaths}; clipped fields ${c.clippedFields}, omitted warnings ${c.omittedWarnings}.`) : null,
      h('ul', graph.limitations.map(line => h('li', line)))));
    this.endpointSummary.replaceChildren(...(graph.endpoint ? [h('details', { open: true }, h('summary', `Endpoint ${graph.endpoint.query} · ${graph.endpoint.matches.length} retained MAC-table matches`),
      h('p.hint', 'Candidate paths do not prove direct endpoint attachment.'), ...graph.endpoint.warnings.map(w => h('p.hint', w)),
      ...(graph.endpoint.arpEvidence || []).map(ref => h('div.topology-actions', h('span', `${ref.ip} → ${ref.mac}`), this.sourceButton(ref))),
      ...graph.endpoint.paths.map(path => h('p.topology-path', `${path.mac} · VLAN ${shown(path.vlan)} · ${path.steps.map(step => `${step.deviceLabel} / ${step.interface}`).join(' → ')} · ${path.status}. ${path.reason}`)))] : []));
  }
  drawPositions() {
    for (const [id, element] of this.nodeEls || []) { const p = this.positions.get(id); element.setAttribute('transform', `translate(${p.x} ${p.y})`); }
    for (const link of this.report?.links || []) {
      const a = this.positions.get(link.from), b = this.positions.get(link.to); if (!a || !b) continue;
      const bend = this.curves.get(link.id) || 0, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
      const route = `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2 - dy / length * bend} ${(a.y + b.y) / 2 + dx / length * bend} ${b.x} ${b.y}`;
      for (const element of this.linkEls.get(link.id).querySelectorAll('path')) element.setAttribute('d', route);
    }
  }
  fit() {
    if (!this.positions.size) { this.view = { x: 0, y: 0, width: 800, height: 450 }; return this.applyView(); }
    const points = [...this.positions.values()], minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    this.view = { x: minX - 150, y: minY - 80, width: Math.max(450, maxX - minX + 300), height: Math.max(250, maxY - minY + 160) }; this.applyView();
  }
  zoom(factor) { if (!this.view) return; const width = Math.max(200, Math.min(20000, this.view.width * factor)), ratio = width / this.view.width, height = this.view.height * ratio; this.view = { x: this.view.x + (this.view.width - width) / 2, y: this.view.y + (this.view.height - height) / 2, width, height }; this.applyView(); }
  applyView() { this.map.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.width} ${this.view.height}`); }
  point(event) { const p = this.map.createSVGPoint(); p.x = event.clientX; p.y = event.clientY; const matrix = this.map.getScreenCTM(); return matrix ? p.matrixTransform(matrix.inverse()) : { x: 0, y: 0 }; }
  move(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const p = this.point(event), dx = p.x - this.drag.start.x, dy = p.y - this.drag.start.y;
    if (this.drag.nodeId) { this.positions.set(this.drag.nodeId, { x: this.drag.origin.x + dx, y: this.drag.origin.y + dy }); this.drawPositions(); }
    else { this.view = { ...this.drag.view, x: this.view.x - dx, y: this.view.y - dy }; this.applyView(); }
  }
  endDrag(event) { if (this.drag?.pointerId !== event.pointerId) return; try { this.map.releasePointerCapture(event.pointerId); } catch {} this.drag = null; }

  fields(rows) { return h('dl.topology-facts', rows.map(([label, value]) => [h('dt', label), h('dd', shown(value))])); }
  select(type, id) {
    this.selection = { type, id };
    for (const [key, element] of this.nodeEls) element.classList.toggle('selected', type === 'node' && key === id);
    for (const [key, element] of this.linkEls) element.classList.toggle('selected', type === 'link' && key === id);
    if (type === 'link') {
      const link = this.report.links.find(item => item.id === id); if (!link) return;
      const sourceNode = this.report.nodes.find(n => n.id === link.from), targetNode = this.report.nodes.find(n => n.id === link.to);
      this.detail.replaceChildren(h('h3', `${link.protocols.join(' / ')} observation`), h('p', `${sourceNode?.label} → ${targetNode?.label}`),
        this.fields([['Local interface', link.localInterface], ['Remote interface', link.remoteInterface], ['Recorded local state', link.localState], ['Resolution', link.resolution], ['Collected', when(link.collectedAt)], ['Age', link.age]]),
        h('p.notice', link.meaning), h('h4', 'Source evidence'), ...link.evidence.map(ref => this.sourceButton(ref)), this.deviceActions(sourceNode?.deviceId));
      return;
    }
    const node = this.report.nodes.find(item => item.id === id); if (!node) return;
    const device = this.inputReport?.devices?.find(item => item.id === node.deviceId);
    const interfaces = device?.facts?.interfaces || [];
    this.detail.replaceChildren(h('h3', node.label), this.fields([['Kind', node.kind], ['Address', node.host], ['Recorded hostname', node.hostname], ['Collected', when(node.collectedAt)], ['Age', node.age], ['Resolution', node.resolution || 'Supplied collection record'], ...(node.mac ? [['MAC', node.mac], ['VLAN', node.vlan]] : [])]),
      node.candidateDeviceIds?.length ? h('p.notice', 'Ambiguous candidates: ' + node.candidateDeviceIds.join(', ')) : null,
      ...(node.warnings || []).map(w => h('p.notice', w)),
      device ? this.deviceActions(device.id) : h('p.hint', 'No unique collected device is associated with this observation.'),
      device?.facts?.version?.source ? this.sourceButton({ deviceId: device.id, ...device.facts.version.source }) : null,
      node.coverage ? h('details', h('summary', 'Device command coverage'), ...node.coverage.map(c => h('p.hint', `${c.commandId}: ${c.complete ? 'complete' : c.status === 'ok' ? 'incomplete parsing' : c.status} · ${c.recognizedRows} recognized rows`))) : null,
      device ? h('details', h('summary', `${node.interfaceCount} interface observation(s)`), ...interfaces.slice(0, 50).map(row => h('button.topology-interface', { onclick: () => this.showSource({ deviceId: device.id, ...row.source }) }, `${row.name} · ${shown(row.status)} · ${shown(row.description)}`)), interfaces.length > 50 ? h('p.hint', 'Showing 50 interfaces. Open Device Inspector for all observations.') : null) : null);
  }
  sourceButton(ref) {
    const device = this.inputReport?.devices?.find(item => item.id === ref.deviceId), command = device?.commands?.find(c => c.id === ref.commandId);
    return h('button.btn.sm.topology-source', { onclick: () => this.showSource(ref) }, `${command?.command || ref.command || ref.commandId} · line ${ref.line}${ref.complete === false ? ' · incomplete' : ''}`);
  }
  showSource(ref) {
    const device = this.inputReport?.devices?.find(item => item.id === ref.deviceId), command = device?.commands?.find(c => c.id === ref.commandId);
    if (!command) { this.status.textContent = 'The referenced command is unavailable in this source report.'; return; }
    const lines = command.output.split(/\r\n|\n|\r/), start = Math.max(0, ref.line - 6), selected = lines.slice(start, start + 30);
    this.evidenceHeading.replaceChildren(`${device.label} · ${command.command} · ${command.status} · lines ${start + 1}–${start + selected.length} of ${lines.length}. Full output is retained in Export JSON. `,
      h('button.btn.sm', { onclick: () => this.openInspector(device.id, ref) }, 'Open in Device Inspector'));
    this.raw.replaceChildren(...selected.map((line, i) => h('span', { class: start + i + 1 === ref.line ? 'topology-source-line' : '' }, `${start + i + 1}  ${line.slice(0, 2000)}${line.length > 2000 ? '… [line clipped in this view]' : ''}\n`)));
    this.evidence.open = true; this.evidence.scrollIntoView({ block: 'nearest' });
  }
  terminalFor(deviceId) {
    const device = this.inputReport?.devices?.find(item => item.id === deviceId), tab = device?.connectionId && this.app.byId.get(device.connectionId);
    return tab?.kind === 'terminal' && tab.protocol === 'ssh' && tab.state === 'connected' ? tab : null;
  }
  deviceActions(deviceId) {
    if (!deviceId) return null;
    return h('div.topology-actions', h('button.btn.sm', { onclick: () => this.openInspector(deviceId) }, 'Open Device Inspector'),
      h('button.btn.sm', { disabled: !this.terminalFor(deviceId), onclick: () => { const tab = this.terminalFor(deviceId); if (tab) this.app.activate(tab); else this.status.textContent = 'The original SSH terminal is no longer connected.'; } }, icon('terminal'), 'Open terminal'));
  }
  openInspector(deviceId, source) { if (!this.disposed && this.inputReport) this.app.openDeviceInspector(this.inputReport, { deviceId, ...(source ? { source } : {}) }); }
  async export() {
    if (this.busy || this.disposed || !this.inputReport || !this.report) return;
    const request = ++this.seq; this.busy = true; this.updateButtons();
    try { const file = await api.invoke('tools:topologyExport', this.inputReport, this.graphOptions); if (this.disposed || request !== this.seq) return; this.status.textContent = file ? 'Saved topology and canonical command evidence to ' + file : 'Export cancelled.'; if (file) toast('Saved ' + file, 'ok'); }
    catch (error) { if (!this.disposed && request === this.seq) this.status.textContent = errMsg(error); }
    finally { if (!this.disposed && request === this.seq) { this.busy = false; this.updateButtons(); } }
  }
  show() { this.active = true; if (this.selection) this.select(this.selection.type, this.selection.id); }
  cancelDrag() { if (this.drag) { try { this.map.releasePointerCapture(this.drag.pointerId); } catch {} this.drag = null; } }
  hide() { this.active = false; this.cancelDrag(); }
  focus() { this.demoButton.focus(); }
  refit() { /* SVG viewBox follows its container without changing observations. */ }
  onHostWindowChanged() { this.cancelDrag(); }
  statusSegments() { return [{ icon: 'link', text: 'Visual Topology' }, { text: `${this.report?.nodes.length || 0} nodes · ${this.report?.links.length || 0} links` }]; }
  dispose() { this.disposed = true; ++this.seq; ++this.snapshotSeq; this.cancelDrag(); }
}
