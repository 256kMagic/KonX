import { h, icon, modal, toast, errMsg } from '../ui.js';

const CALL_PAGE = 20;
const MESSAGE_PAGE = 50;
const ENDPOINT_PAGE = 8;
const RAW_CHARS = 128 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';
const known = (value) => value == null || value === '' ? 'Unknown' : String(value);
const short = (value, length = 100) => {
  const text = known(value);
  return text.length > length ? text.slice(0, length - 1) + '…' : text;
};
const seconds = (value) => Number.isFinite(value) ? value.toFixed(3) + ' s' : 'Unknown';
const timestamp = (value) => {
  if (!Number.isFinite(value)) return 'Unknown';
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value) + ' seconds';
};
const metadata = (items) => h('dl.sip-metadata', items.map(([label, value]) => [h('dt', label), h('dd', known(value))]));
function warningList(items = []) {
  const lines = [...new Set(items.filter(Boolean).map(String))];
  return lines.length ? h('div.sip-warning', lines.slice(0, 20).map((line) => h('div', icon('info'), line)),
    lines.length > 20 ? h('div', (lines.length - 20) + ' additional notes retained in the report.') : null) : null;
}
function svg(name, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text != null) element.textContent = String(text);
  return element;
}
const source = (message) => message.src || 'Unknown source';
const destination = (message) => message.dst || 'Unknown destination';
const method = (message) => message.method || (message.cseq && message.cseq.method) || '';
const messageLabel = (message) => message.type === 'response'
  ? [message.status, message.reason, method(message)].filter((part) => part != null && part !== '').join(' ')
  : message.method || message.startLine || 'Unknown SIP message';

/** Display only the supplied capture snapshot. Captured text is never markup. */
export async function showSipCalls(analysis, { onExportCall, onExportReport } = {}) {
  let close;
  let alive = true;
  let exporting = false;
  let callPage = 0;
  let messagePage = 0;
  let endpointPage = 0;
  let selectedIndex = 0;
  let mediaPage = 0;
  let framePage = 0;
  let focusedEndpoints = null;
  let filtered = analysis.calls;
  let selectedCall = filtered[0] || null;
  let endpoints = [];
  const searchCache = new Map();
  const list = h('div.sip-call-list', { 'aria-label': 'SIP calls' });
  const listPager = h('div.sip-pager');
  const callSummary = h('div.sip-call-summary');
  const ladderPager = h('div.sip-pager');
  const endpointPager = h('div.sip-pager');
  const ladder = h('div.sip-ladder-scroll');
  const detail = h('div.sip-message-detail', { 'aria-live': 'polite' });
  const count = h('span.hint');
  const search = h('input.input', {
    type: 'search', placeholder: 'Search Call-ID, parties, outcome, or method',
    'aria-label': 'Search SIP calls',
    oninput: () => {
      const query = search.value.trim().toLocaleLowerCase();
      filtered = analysis.calls.filter((call) => !query || searchable(call).includes(query));
      callPage = 0;
      chooseCall(filtered[0] || null);
    },
  });

  function searchable(call) {
    if (!searchCache.has(call)) {
      const methods = [...new Set(call.messages.map((message) => method(message) || message.status || ''))];
      searchCache.set(call, [call.callId, call.from, call.to, call.outcome, ...methods].map((value) => value || '').join('\n').toLocaleLowerCase());
    }
    return searchCache.get(call);
  }
  function pager(page, size, total, label, change) {
    const pages = Math.max(1, Math.ceil(total / size));
    return [
      h('button.btn.sm', { disabled: page === 0, 'aria-label': 'Previous ' + label, onclick: () => change(page - 1) }, 'Previous'),
      h('span.hint', total ? (page * size + 1) + '–' + Math.min((page + 1) * size, total) + ' of ' + total + ' ' + label : 'No ' + label),
      h('button.btn.sm', { disabled: page + 1 >= pages, 'aria-label': 'Next ' + label, onclick: () => change(page + 1) }, 'Next'),
    ];
  }
  function chooseCall(call) {
    selectedCall = call;
    messagePage = 0; endpointPage = 0; selectedIndex = 0; mediaPage = 0; framePage = 0;
    focusedEndpoints = null;
    endpoints = call ? [...new Set(call.messages.flatMap((message) => [source(message), destination(message)]))] : [];
    renderCalls(); renderSummary(); renderLadder(); renderMessage();
    ladder.scrollTop = 0; detail.scrollTop = 0;
  }
  function chooseMessage(index, focus = false) {
    selectedIndex = index;
    mediaPage = 0; framePage = 0;
    messagePage = Math.floor(index / MESSAGE_PAGE);
    const message = selectedCall.messages[index];
    const visible = visibleEndpoints();
    if (!visible.includes(source(message)) || !visible.includes(destination(message))) {
      focusedEndpoints = [...new Set([source(message), destination(message), ...visible])].slice(0, ENDPOINT_PAGE);
    }
    renderLadder(); renderMessage(); detail.scrollTop = 0;
    if (focus) ladder.querySelector('[data-message-index="' + index + '"]')?.focus({ preventScroll: true });
  }
  function visibleEndpoints() {
    return focusedEndpoints || endpoints.slice(endpointPage * ENDPOINT_PAGE, (endpointPage + 1) * ENDPOINT_PAGE);
  }
  function renderCalls() {
    count.textContent = filtered.length + ' of ' + analysis.calls.length + ' calls · ' + (analysis.scannedPackets ?? 0).toLocaleString() + ' packets examined';
    list.replaceChildren(...filtered.slice(callPage * CALL_PAGE, (callPage + 1) * CALL_PAGE).map((call) =>
      h('button.sip-call-row', {
        type: 'button', class: call === selectedCall ? 'active' : '',
        'aria-pressed': String(call === selectedCall), onclick: () => chooseCall(call),
      },
      h('span.sip-call-top', h('strong', known(call.outcome)), h('span', call.messages.length + ' messages')),
      h('span.sip-call-parties', short(call.from, 100) + ' → ' + short(call.to, 100)),
      h('span.sip-call-id', { title: known(call.callId) }, call.callId ? short(call.callId, 120) : 'Unknown Call-ID · isolated messages'),
      h('span.sip-call-meta', timestamp(call.startTime)),
      h('span.sip-call-meta', 'Setup ' + seconds(call.setupTime) + ' · duration ' + seconds(call.duration)),
      (call.warnings.length || call.messages.some((message) => !message.complete)) ? h('span.sip-call-meta', 'Capture notes / incomplete evidence') : null)));
    if (!filtered.length) list.append(h('div.sip-empty', analysis.calls.length ? 'No SIP calls match this search.' : 'No SIP calls were found in the examined packets.'));
    listPager.replaceChildren(...pager(callPage, CALL_PAGE, filtered.length, 'calls', (page) => {
      callPage = page;
      chooseCall(filtered[page * CALL_PAGE] || null);
    }));
  }
  async function exportSelected(callback, success) {
    if (!selectedCall || exporting || typeof callback !== 'function') return;
    const call = selectedCall;
    exporting = true; renderSummary();
    try { if (await callback(call)) toast(success); }
    catch (error) { toast(errMsg(error), 'err'); }
    finally { exporting = false; if (alive) renderSummary(); }
  }
  function renderSummary() {
    if (!selectedCall) {
      callSummary.replaceChildren(h('div.sip-empty', 'Select a SIP call to inspect its signaling and packet evidence.'));
      return;
    }
    const call = selectedCall;
    const retransmissions = call.messages.filter((message) => message.retransmission).length;
    callSummary.replaceChildren(
      h('div.sip-actions', h('strong', known(call.outcome)),
        h('button.btn.sm', {
          disabled: exporting || typeof onExportCall !== 'function',
          onclick: () => exportSelected(onExportCall, 'Call capture saved'),
        }, icon('download'), 'Export call PCAPNG'),
        h('button.btn.sm', {
          disabled: exporting || typeof onExportReport !== 'function',
          onclick: () => exportSelected(onExportReport, 'Call report saved'),
        }, icon('file'), 'Export JSON report')),
      h('div.hint', 'PCAPNG saves original signaling packets. Shared TCP packets may also contain other messages; RTP media is not included.'),
      metadata([['Call-ID', call.callId], ['From', call.from], ['To', call.to],
        ['First observed', timestamp(call.startTime)], ['Last observed', timestamp(call.endTime)],
        ['Setup time', seconds(call.setupTime)], ['Call duration', seconds(call.duration)],
        ['Evidence', call.messages.length + ' messages · ' + call.frames.length + ' packets · ' + retransmissions + ' retransmissions']]),
      warningList(call.warnings),
      call.dialogs.length ? h('details.sip-dialogs', h('summary', call.dialogs.length + ' tagged SIP dialogs'),
        call.dialogs.slice(0, 12).map((dialog) => metadata([
          ['Dialog', dialog.id], ['From tag', dialog.fromTag], ['To tag', dialog.toTag],
          ['Observed outcome', dialog.outcome], ['Setup', seconds(dialog.setupTime)], ['Duration', seconds(dialog.duration)],
        ])),
        call.dialogs.length > 12 ? h('div.hint', 'Showing the first 12 dialogs. The JSON report retains all analyzed dialogs.') : null) :
        h('div.hint', 'Dialog tags were not established. Call grouping does not prove a complete call.'));
  }

  function renderLadder() {
    const scrollTop = ladder.scrollTop;
    if (!selectedCall) {
      ladder.replaceChildren(); ladderPager.replaceChildren(); endpointPager.replaceChildren();
      return;
    }
    const call = selectedCall;
    const lanes = visibleEndpoints();
    const width = 100 + Math.max(2, lanes.length) * 130;
    const messages = call.messages.slice(messagePage * MESSAGE_PAGE, (messagePage + 1) * MESSAGE_PAGE);
    const height = 66 + messages.length * 54;
    const chart = svg('svg', { class: 'sip-ladder', width, height, viewBox: '0 0 ' + width + ' ' + height, role: 'group', 'aria-label': 'SIP signaling ladder' });
    const x = (index) => 100 + (index + 0.5) * 130;
    chart.append(svg('text', { x: 8, y: 23, class: 'sip-time-label' }, 'Relative time'));
    lanes.forEach((endpoint, index) => {
      const lane = svg('line', { x1: x(index), y1: 48, x2: x(index), y2: height, class: 'sip-lane' });
      const label = svg('text', { x: x(index), y: 23, 'text-anchor': 'middle', class: 'sip-lane-label' }, short(endpoint, 21));
      label.append(svg('title', {}, endpoint));
      chart.append(lane, label);
    });
    messages.forEach((message, row) => {
      const index = messagePage * MESSAGE_PAGE + row;
      const y = 64 + row * 54;
      const from = lanes.indexOf(source(message));
      const to = lanes.indexOf(destination(message));
      const relative = Number.isFinite(message.ts) && Number.isFinite(call.startTime) ? seconds(message.ts - call.startTime) : 'Unknown time';
      const annotations = [message.retransmission ? 'retransmission' : '', !message.complete ? 'incomplete' : ''].filter(Boolean);
      const label = messageLabel(message) + (annotations.length ? ' · ' + annotations.join(', ') : '');
      const group = svg('g', {
        class: 'sip-message-arrow' + (index === selectedIndex ? ' selected' : '') + (message.retransmission ? ' retransmission' : '') + (!message.complete ? ' incomplete' : ''),
        tabindex: 0, role: 'button', 'data-message-index': index,
        'aria-label': relative + ' ' + label + ' from ' + source(message) + ' to ' + destination(message) + '. Show message details.',
      });
      group.append(svg('title', {}, known(message.startLine) + '\n' + source(message) + ' → ' + destination(message) + '\n' + timestamp(message.ts)),
        svg('rect', { x: 0, y: y - 10, width, height: 52, class: 'sip-arrow-hit', fill: 'transparent' }),
        svg('text', { x: 8, y: y + 18, class: 'sip-time-label' }, relative));
      if (from < 0 || to < 0) {
        group.append(svg('text', { x: 110, y: y + 10, class: 'sip-arrow-label' }, short(label, 90)),
          svg('text', { x: 110, y: y + 30, class: 'sip-time-label' }, short(source(message) + ' → ' + destination(message), 80) + ' · select to reveal lanes'));
      } else {
        const a = x(from), b = x(to);
        const lineY = y + 22;
        if (from === to) {
          group.append(svg('path', { d: 'M ' + a + ' ' + lineY + ' h 46 v 12 h -46', class: 'sip-arrow-line', fill: 'none' }),
            svg('path', { d: 'M ' + a + ' ' + (lineY + 12) + ' l 9 -5 v 10 z', class: 'sip-arrow-head' }));
        } else {
          const sign = b > a ? 1 : -1;
          group.append(svg('line', { x1: a, y1: lineY, x2: b, y2: lineY, class: 'sip-arrow-line' }),
            svg('path', { d: 'M ' + b + ' ' + lineY + ' l ' + (-sign * 9) + ' -5 v 10 z', class: 'sip-arrow-head' }));
        }
        group.append(svg('text', { x: from === to ? a + 12 : (a + b) / 2, y: y + 9, 'text-anchor': from === to ? 'start' : 'middle', class: 'sip-arrow-label' }, short(label, 65)));
      }
      group.addEventListener('click', () => chooseMessage(index));
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseMessage(index, true); }
      });
      chart.append(group);
    });
    ladder.replaceChildren(messages.length ? chart : h('div.sip-empty', 'No signaling messages retained for this call.'));
    ladder.scrollTop = scrollTop;
    ladderPager.replaceChildren(...pager(messagePage, MESSAGE_PAGE, call.messages.length, 'messages', (page) => {
      chooseMessage(page * MESSAGE_PAGE); ladder.scrollTop = 0;
    }));
    endpointPager.replaceChildren(...pager(endpointPage, ENDPOINT_PAGE, endpoints.length, 'endpoints', (page) => {
      endpointPage = page; focusedEndpoints = null; renderLadder();
    }), focusedEndpoints ? h('span.hint', 'Lanes include the selected message endpoints.') : null,
    endpoints.length > ENDPOINT_PAGE ? h('span.hint', 'Up to 8 lanes shown. Select a message to reveal its endpoints.') : null);
  }

  function packetButtons(message) {
    const frames = [...new Set(message.frames)];
    return h('div.traffic-frames', h('span', 'Source packets'),
      frames.slice(framePage * 20, (framePage + 1) * 20).map((frame) => h('button.traffic-frame', {
        title: 'Show original packet ' + frame,
        onclick: () => close({ action: 'packet', frame }),
      }, '#' + frame)),
      frames.length > 20 ? h('div.sip-pager', ...pager(framePage, 20, frames.length, 'source packets', (page) => { framePage = page; renderMessage(); })) : null);
  }
  function renderMessage() {
    const message = selectedCall && selectedCall.messages[selectedIndex];
    if (!message) { detail.replaceChildren(h('div.sip-empty', 'Select an arrow to inspect a SIP message.')); return; }
    const cseq = message.cseq;
    const raw = message.rawText || message.startLine + '\r\n' + message.headers.map((header) => header.name + ': ' + header.value).join('\r\n') + '\r\n\r\n' + (message.bodyText || '');
    detail.replaceChildren(
      h('h3', known(message.startLine)),
      metadata([['Direction', source(message) + ' → ' + destination(message)], ['Transport', message.transport],
        ['Captured at', timestamp(message.ts)], ['CSeq', cseq ? cseq.number + ' ' + cseq.method : null],
        ['From tag', message.fromTag], ['To tag', message.toTag], ['Branch', message.branch],
        ['Dialog', message.dialogId], ['Message', message.complete ? 'Complete captured message' : 'Incomplete captured message'],
        ['Retransmission', message.retransmission ? 'Observed retransmission' : message.retransmissionUnknown ? 'Unknown (comparison limited)' : 'Not marked as a retransmission']]),
      warningList(message.warnings),
      packetButtons(message),
      message.sdp ? renderSdp(message.sdp) : h('div.hint', 'No complete structured SDP was decoded for this message.'),
      h('details.sip-raw-detail', { open: true }, h('summary', 'Captured SIP headers and body'),
        h('pre.sip-raw', raw.slice(0, RAW_CHARS)),
        raw.length > RAW_CHARS ? h('div.sip-warning', 'Raw text display limited to 128 Ki characters. Inspect source packets or export the report for retained evidence.') : null));
  }
  function renderSdp(sdp) {
    const connection = (value) => value ? [value.networkType, value.addressType, value.address].filter(Boolean).join(' ') : null;
    const media = sdp.media.slice(mediaPage * 8, (mediaPage + 1) * 8);
    return h('section.sip-sdp', h('h3', 'Session Description Protocol'),
      warningList([...(sdp.warnings || []), ...(!sdp.complete ? ['SDP is incomplete or limited. Some session details may be unknown.'] : [])]),
      metadata([['Session', sdp.sessionName], ['Origin', sdp.origin], ['Connection', connection(sdp.connection)],
        ['Timing', sdp.timing ? sdp.timing.start + ' ' + sdp.timing.stop : null], ['Direction', sdp.direction], ['Direction source', sdp.directionSource]]),
      sdp.timings && sdp.timings.length > 1 ? h('div.hint', sdp.timings.length + ' timing entries are retained in the raw SDP and report.') : null,
      attributes(sdp.attributes, 'Session attributes'),
      sdp.unknownLines && sdp.unknownLines.length ? h('div.sip-warning', sdp.unknownLines.length + ' unrecognized session lines retained in raw SDP.') : null,
      media.map((entry, index) => h('article.sip-media',
        h('h4', 'Media ' + (mediaPage * 8 + index + 1) + ' · ' + known(entry.type) + (entry.disabled ? ' · disabled (port 0)' : '')),
        metadata([['Port', entry.port == null ? null : String(entry.port) + (entry.portCount > 1 ? '/' + entry.portCount : '')],
          ['Protocol', entry.protocol], ['Formats', entry.formats.join(', ')],
          ['Connection', connection(entry.connection)], ['Connection source', entry.connectionSource],
          ['Direction', entry.direction], ['Direction source', entry.directionSource],
          ['RTCP', entry.rtcp ? String(entry.rtcp.port) + (entry.rtcp.connection ? ' · ' + connection(entry.rtcp.connection) : '') : null]]),
        h('table.sip-codecs', h('thead', h('tr', ['Payload', 'Codec', 'Clock rate', 'Channels', 'Parameters'].map((label) => h('th', label)))),
          h('tbody', entry.codecs.slice(0, 32).map((codec) => h('tr',
            h('td', known(codec.payloadType)), h('td', codec.name || 'Unmapped'),
            h('td', known(codec.clockRate)), h('td', known(codec.channels)), h('td', short(codec.fmtp, 1024)))))),
        entry.codecs.length > 32 ? h('div.sip-warning', 'Showing the first 32 codec entries; remaining entries are retained in the report.') : null,
        attributes(entry.attributes, 'Media attributes'),
        entry.unknownLines && entry.unknownLines.length ? h('div.sip-warning', entry.unknownLines.length + ' unrecognized media lines retained in raw SDP.') : null)),
      sdp.media.length > 8 ? h('div.sip-pager', ...pager(mediaPage, 8, sdp.media.length, 'media sections', (page) => { mediaPage = page; renderMessage(); })) : null);
  }
  function attributes(items = [], title) {
    return items.length ? h('details.sip-attributes', h('summary', title + ' (' + items.length + ')'),
      h('pre.sip-raw', items.slice(0, 20).map((attribute) => attribute.name + (attribute.value == null ? '' : ':' + attribute.value)).join('\n')),
      items.length > 20 ? h('div.sip-warning', 'Showing the first 20 attributes; the raw SDP and report retain the rest.') : null) : null;
  }

  const body = h('div.sip-workspace',
    h('div.hint', 'Captured traffic snapshot. Outcomes and timing describe observed signaling; missing packets can leave call state unknown.'),
    warningList([...(analysis.warnings || []), ...(analysis.limited ? ['Analysis limits were reached. Additional SIP traffic may be omitted.'] : [])]),
    h('div.sip-toolbar', search, count),
    h('div.sip-columns',
      h('div.sip-call-panel', list, listPager),
      h('div.sip-investigation', callSummary, ladderPager, endpointPager, ladder, detail)));
  const done = modal({
    title: 'SIP calls · Signaling ladder', icon: 'route', width: 1320, body,
    buttons: [{ label: 'Close', value: null, primary: true }],
    onReady: (controls) => { close = controls.close; }, submitOnEnter: false,
  });
  done.then(() => { alive = false; });
  chooseCall(selectedCall);
  return done;
}
