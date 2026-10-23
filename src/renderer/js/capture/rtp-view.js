import { h, icon, modal, toast, errMsg } from '../ui.js';
import { analyzeRtp, buildRtpAudio, encodeWav, audioWaveform } from './rtp.mjs';

const PAGE = 75, STREAM_PAGE = 30, NS = 'http://www.w3.org/2000/svg';
const known = (value) => value == null || value === '' ? 'Unknown' : String(value);
const number = (value, unit = '') => Number.isFinite(value) ? value.toFixed(2) + unit : 'Unknown';
const stamp = (value) => { const date = new Date(value * 1000); return Number.isFinite(value) && Number.isFinite(date.getTime()) ? date.toISOString() : 'Unknown'; };
const text = (value) => String(value ?? '');
const metadata = (items) => h('dl.rtp-metadata', items.map(([key, value]) => [h('dt', key), h('dd', known(value))]));
function notes(lines) {
  return h('div.rtp-notes', [...new Set(lines.filter(Boolean))].slice(0, 30).map((line) => h('div', line)));
}
function svg(name, attrs = {}, content) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  if (content != null) element.textContent = String(content);
  return element;
}
function pager(page, count, size, label, change) {
  return h('div.rtp-pager',
    h('button.btn.sm', { disabled: page === 0, onclick: () => change(page - 1), 'aria-label': 'Previous ' + label }, 'Previous'),
    h('span.hint', count ? `${page * size + 1}–${Math.min(count, (page + 1) * size)} of ${count}` : 'No ' + label),
    h('button.btn.sm', { disabled: (page + 1) * size >= count, onclick: () => change(page + 1), 'aria-label': 'Next ' + label }, 'Next'));
}
const codecLabel = (stream) => stream.payloadTypes.map((codec) => codec.name || 'Unknown codec').filter((value, index, all) => all.indexOf(value) === index).join(' / ') || 'Unknown codec';

/** Owns only a fixed capture snapshot. Nothing plays or exports until explicitly requested.
 * signal must be aborted when the owner replaces/clears its capture or disposes. */
export async function showRtpMedia(packetSnapshot, { sipCalls = [], callKey = null, onExportWav, allowDemo = false, allowCopilot = false, signal } = {}) {
  if (signal?.aborted) return null;
  let analysis, selected, filtered = [], streamPage = 0, packetPage = 0, close;
  let alive = true, busy = false, audio = null, audioError = '', playback = null, playEpoch = 0;
  const streams = h('div.rtp-streams', { 'aria-label': 'Directional media streams' });
  const streamPager = h('div'), details = h('div.rtp-detail'), count = h('span.hint');
  const warningBox = h('details.rtp-analysis-notes');
  const search = h('input.input', { type: 'search', placeholder: 'Search endpoints, SSRC or codec', 'aria-label': 'Search RTP streams', oninput: () => filterStreams() });
  const callFilter = h('select.input', { 'aria-label': 'Filter media by SIP call', onchange: () => filterStreams() },
    h('option', { value: '' }, 'All SIP calls / unassociated'),
    sipCalls.map((call) => h('option', { value: call.id }, text(call.callId || call.id))));
  callFilter.value = callKey || '';
  const heuristic = h('input', { type: 'checkbox', 'aria-label': 'Find possible RTP without SDP', onchange: () => reanalyze() });
  const heuristicAudio = h('input', { type: 'checkbox', 'aria-label': 'Accept heuristic RTP interpretation for audio', onchange: () => { audio = null; audioError = ''; stop(); renderDetails(); } });
  const problemOnly = h('input', { type: 'checkbox', 'aria-label': 'Show problem packets only', onchange: () => { packetPage = 0; renderPackets(); } });
  const packetHost = h('div.rtp-packet-host'), waveHost = h('div.rtp-wave-host'), audioStatus = h('div.hint', { 'aria-live': 'polite' });
  const previewButton = h('button.btn.sm', { onclick: () => prepareAudio() }, 'Build waveform');
  const playButton = h('button.btn.sm', { onclick: () => play(false) }, icon('play'), 'Play stream');
  const pairButton = h('button.btn.sm', { onclick: () => play(true) }, 'Play both directions');
  const stopButton = h('button.btn.sm', { disabled: true, onclick: () => stop() }, 'Stop');
  const copilotButton = h('button.btn.sm', { disabled: true, onclick: () => close({ action: 'copilot', stream: selected, analysis }) }, 'Ask KonX-AI about stream quality');
  const exportButton = h('button.btn.sm', { onclick: () => exportAudio() }, icon('download'), 'Export WAV');

  function reanalyze() {
    stop(); audio = null; audioError = ''; heuristicAudio.checked = false;
    analysis = analyzeRtp(packetSnapshot, { sipCalls, allowHeuristic: heuristic.checked });
    warningBox.replaceChildren(h('summary', 'Coverage and interpretation notes'),
      notes([...(analysis.warnings || []), analysis.limited ? 'Analysis reached a resource limit. Some media is omitted.' : '',
        'Jitter is calculated from captured arrival times and declared RTP clock rates. Unknown clocks remain unknown.',
        'Sequence gaps describe missing capture observations, not proven network loss.']),
      metadata([['Packets examined', analysis.scannedPackets], ['Bytes examined', analysis.examinedBytes],
        ...Object.entries(analysis.excluded || {}).filter(([, value]) => value).map(([key, value]) => ['Excluded: ' + key, value])]));
    filterStreams();
  }
  function filterStreams() {
    const query = search.value.trim().toLocaleLowerCase(), key = callFilter.value;
    filtered = analysis.streams.filter((stream) => (!key || stream.associations.some((association) => association.callKey === key)) &&
      (!query || [stream.src, stream.dst, stream.ssrc, codecLabel(stream)].join('\n').toLocaleLowerCase().includes(query)));
    streamPage = 0;
    choose(filtered.includes(selected) ? selected : filtered[0] || null);
  }
  function choose(stream) {
    stop(); selected = stream; audio = null; audioError = ''; heuristicAudio.checked = false; packetPage = 0;
    renderStreams(); renderDetails(); details.scrollTop = 0;
  }
  function renderStreams() {
    count.textContent = `${filtered.length} of ${analysis.streams.length} directional streams`;
    streams.replaceChildren(...filtered.slice(streamPage * STREAM_PAGE, (streamPage + 1) * STREAM_PAGE).map((stream) =>
      h('button.rtp-stream', { class: stream === selected ? 'active' : '', 'aria-pressed': String(stream === selected), 'data-stream-id': stream.id, onclick: () => choose(stream) },
        h('strong', codecLabel(stream)), h('span', stream.src), h('span', '→ ' + stream.dst),
        h('span.hint', `${stream.packetCount} packets · ${number(stream.durationSeconds, ' s')} · SSRC ${stream.ssrc}`),
        h('span.hint', `${stream.sequenceGaps} missing · ${stream.outOfOrderPackets} reordered · ${stream.duplicatePackets} duplicate`),
        h('span.hint', stream.identification + (stream.incomplete ? ' · incomplete' : '')))));
    if (!filtered.length) streams.append(h('div.rtp-empty', analysis.streams.length ? 'No streams match these filters.' :
      'No SDP-associated RTP was found. Encrypted media is excluded. For captures without signaling, you can explicitly enable possible RTP detection.'));
    streamPager.replaceChildren(pager(streamPage, filtered.length, STREAM_PAGE, 'streams', (page) => { streamPage = page; renderStreams(); }));
  }
  function pairFor(stream) {
    if (!stream || stream.identification === 'heuristic candidate') return null;
    const keys = [...new Set(stream.associations.map((association) => association.callKey).filter(Boolean))];
    if (keys.length !== 1) return null;
    const candidates = analysis.streams.filter((other) => other !== stream && other.src === stream.dst && other.dst === stream.src &&
      other.audioSupported && other.identification !== 'heuristic candidate' &&
      new Set(other.associations.map((association) => association.callKey).filter(Boolean)).size === 1 &&
      other.associations.some((association) => association.callKey === keys[0]));
    return candidates.length === 1 ? candidates[0] : null;
  }
  function controls() {
    copilotButton.disabled = !selected || busy;
    const supported = selected?.audioSupported && (selected.identification !== 'heuristic candidate' || heuristicAudio.checked);
    previewButton.disabled = !supported || busy;
    playButton.disabled = !supported || busy || Boolean(playback);
    pairButton.disabled = !supported || busy || Boolean(playback) || !pairFor(selected);
    exportButton.disabled = !supported || busy || typeof onExportWav !== 'function';
    stopButton.disabled = !playback;
  }
  function renderDetails() {
    if (!selected) {
      details.replaceChildren(h('div.rtp-empty', h('h3', 'RTP media'), h('p', 'Select a directional stream to inspect packet timing, codec and audio.'),
        allowDemo ? h('button.btn', { 'data-action': 'demo', onclick: () => close({ action: 'demo' }) }, 'Load synthetic RTP demo') : null), renderRtcp());
      return;
    }
    const stream = selected;
    const calls = [...new Map(stream.associations.filter((association) => association.callKey).map((association) => [association.callKey, association])).values()];
    details.replaceChildren(h('h3', stream.src + ' → ' + stream.dst),
      h('div.rtp-actions', ...calls.slice(0, 32).map((association) => h('button.btn.sm', { onclick: () => close({ action: 'call', callKey: association.callKey }) }, 'SIP ladder: ' + known(association.callId)))),
      metadata([['Codec', codecLabel(stream)], ['SSRC', stream.ssrc], ['Identification', stream.identification], ['Duration observed', number(stream.durationSeconds, ' s')],
        ['First captured', stamp(stream.startTime)], ['Last captured', stamp(stream.endTime)], ['Captured / unique', `${stream.packetCount} / ${stream.uniquePackets}`],
        ['Sequence gaps', stream.sequenceGaps], ['Reordered / duplicate', `${stream.outOfOrderPackets} / ${stream.duplicatePackets}`],
        ['Conflicting sequences', stream.conflictingPackets], ['Sequence epochs', stream.sequenceEpochs], ['Clock rate', stream.clockRate == null ? 'Unknown' : stream.clockRate + ' Hz'],
        ['Maximum / last jitter', number(stream.maxJitterMs, ' ms') + ' / ' + number(stream.lastJitterMs, ' ms')]]),
      notes(stream.warnings || []),
      h('section.rtp-audio', h('h3', 'Captured audio'),
        h('div.hint', 'Unencrypted mono G.711 (PCMU / PCMA) only. Missing timestamp intervals become marked silence, not recovered speech.'),
        stream.identification === 'heuristic candidate' ? h('label.check', heuristicAudio, 'Accept assumed RTP/AVP interpretation for this stream’s audio') : null,
        !stream.audioSupported ? h('div.rtp-notes', 'Audio is unavailable: codec, sequence or payload evidence is unsupported or ambiguous.') : null,
        h('div.rtp-actions', previewButton, playButton, pairButton, stopButton, exportButton),
        h('div.hint', 'Both directions align by capture time; this does not establish synchronized sender clocks. Each WAV contains one selected direction.'), audioStatus, waveHost),
      h('section', h('h3', 'Jitter by captured packet'), renderJitter(stream)),
      h('section', h('h3', 'Packet evidence'), h('label.check', problemOnly, 'Show problem packets only'), packetHost), renderRtcp());
    renderAudio(); renderPackets(); controls();
  }
  function prepareAudio() {
    if (!selected || busy) return null;
    try {
      if (!audio) audio = buildRtpAudio(selected, { allowHeuristic: heuristicAudio.checked });
      audioError = ''; renderAudio(); return audio;
    } catch (error) { audioError = errMsg(error); renderAudio(); return null; }
  }
  function renderAudio() {
    waveHost.replaceChildren();
    audioStatus.textContent = audioError || (playback ? playback.pair ? 'Playing both directions · capture-time alignment' : 'Playing selected stream' :
      audio ? `${number(audio.durationSeconds, ' s')} · ${audio.insertedSilenceSamples} inserted silence samples · ${audio.gaps.length} timestamp gaps` : 'Build a waveform, play, or export to reconstruct captured audio.');
    if (!audio) return;
    const chart = svg('svg', { viewBox: '0 0 800 130', class: 'rtp-wave', role: 'img', 'aria-label': 'Audio waveform; shaded intervals are inserted silence' });
    const bins = audioWaveform(audio, 800), duration = audio.durationSeconds || 1;
    chart.append(svg('line', { x1: 0, x2: 800, y1: 55, y2: 55, class: 'rtp-baseline' }));
    // Combine silence into display columns so many small gaps cannot create an unbounded SVG.
    const silence = new Uint8Array(800);
    for (const gap of audio.gaps) silence.fill(1, Math.floor(gap.startSample / audio.sampleRate / duration * 800), Math.ceil(gap.endSample / audio.sampleRate / duration * 800));
    for (let start = 0; start < silence.length; start++) {
      if (!silence[start]) continue;
      let end = start + 1; while (end < silence.length && silence[end]) end++;
      chart.append(svg('rect', { x: start, y: 5, width: end - start, height: 100, class: 'rtp-silence' })); start = end - 1;
    }
    chart.append(svg('path', { class: 'rtp-wave-line', d: bins.map((bin) => `M ${bin.startSeconds / duration * 800} ${55 - bin.max * 45} v ${(bin.max - bin.min) * 45}`).join(' ') }),
      svg('text', { x: 2, y: 124, class: 'rtp-chart-label' }, '0 s'), svg('text', { x: 798, y: 124, 'text-anchor': 'end', class: 'rtp-chart-label' }, number(duration, ' s')));
    waveHost.append(chart, notes(audio.warnings));
    if (audio.gaps.length) waveHost.append(h('details', h('summary', `${audio.gaps.length} inserted silence intervals`),
      audio.gaps.slice(0, PAGE).map((gap) => h('div.rtp-gap', `${number(gap.startSample / audio.sampleRate, ' s')}–${number(gap.endSample / audio.sampleRate, ' s')} `,
        gap.beforeFrame == null ? null : frameButton(gap.beforeFrame), frameButton(gap.afterFrame))),
      audio.gaps.length > PAGE ? h('div.hint', 'Showing the first ' + PAGE + ' intervals.') : null));
  }
  async function stop() {
    playEpoch++;
    const active = playback; playback = null;
    if (active) {
      for (const source of active.sources) { source.onended = null; try { source.stop(); } catch {} try { source.disconnect(); } catch {} }
      try { await active.context.close(); } catch (error) { if (alive) toast('Audio cleanup: ' + errMsg(error), 'err'); }
    }
    if (alive) { controls(); renderAudio(); }
  }
  async function play(both) {
    if (busy || playback || !selected) return;
    const primary = prepareAudio(); if (!primary) return;
    let tracks = [primary];
    try {
      if (both) {
        const paired = pairFor(selected); if (!paired) throw new Error('An unambiguous opposite direction is unavailable.');
        tracks.push(buildRtpAudio(paired));
        if (!tracks.every((track) => Number.isFinite(track.startCaptureTime))) throw new Error('Capture times are unavailable for two-direction alignment.');
        if (Math.abs(tracks[0].startCaptureTime - tracks[1].startCaptureTime) > 600) throw new Error('Capture time alignment exceeds ten minutes.');
      }
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Audio playback is unavailable on this system. WAV export is still supported.');
      const context = new Context(), current = { context, sources: [], pair: both };
      playback = current; const epoch = ++playEpoch; controls(); renderAudio();
      await context.resume();
      if (!alive || playback !== current || epoch !== playEpoch) return;
      const origin = both ? Math.min(...tracks.map((track) => track.startCaptureTime)) : primary.startCaptureTime;
      let remaining = tracks.length;
      for (const track of tracks) {
        const buffer = context.createBuffer(1, track.samples.length, track.sampleRate), channel = buffer.getChannelData(0);
        for (let i = 0; i < track.samples.length; i++) channel[i] = track.samples[i] / 32768;
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); current.sources.push(source);
        source.onended = () => { if (--remaining === 0 && playback === current) stop(); };
      }
      const startAt = context.currentTime + 0.025;
      current.sources.forEach((source, index) => source.start(startAt + (both ? tracks[index].startCaptureTime - origin : 0)));
    } catch (error) { audioError = errMsg(error); await stop(); renderAudio(); }
  }
  async function exportAudio() {
    if (busy || typeof onExportWav !== 'function') return;
    const built = prepareAudio(); if (!built) return;
    const stream = selected; busy = true; controls();
    try { if (await onExportWav('konx-rtp-' + String(stream.ssrc).replace(/[^a-z0-9-]/gi, '_') + '.wav', encodeWav(built))) { if (alive) toast('WAV saved'); } }
    catch (error) { if (alive) toast(errMsg(error), 'err'); }
    finally { busy = false; if (alive) controls(); }
  }
  function frameButton(frame) {
    return h('button.traffic-frame', { title: 'Show original captured packet ' + frame, 'data-frame': frame, onclick: () => close({ action: 'packet', frame }) }, '#' + frame);
  }
  function renderJitter(stream) {
    const usable = stream.packets.filter((packet) => Number.isFinite(packet.jitterMs));
    if (!usable.length) return h('div.hint', 'Jitter is unknown: no comparable captured arrival interval with a known clock rate.');
    const chart = svg('svg', { viewBox: '0 0 800 145', class: 'rtp-jitter', role: 'img', 'aria-label': 'Jitter by arrival order. Use packet table to inspect exact values.' });
    const max = usable.reduce((value, packet) => Math.max(value, packet.jitterMs), 0.01), points = usable.length <= 800 ? usable :
      Array.from({ length: 800 }, (_, index) => usable[Math.floor(index * (usable.length - 1) / 799)]);
    chart.append(svg('text', { x: 1, y: 13, class: 'rtp-chart-label' }, number(max, ' ms')),
      svg('line', { x1: 0, x2: 800, y1: 120, y2: 120, class: 'rtp-baseline' }),
      svg('polyline', { points: points.map((packet, index) => `${index / Math.max(1, points.length - 1) * 798 + 1},${120 - packet.jitterMs / max * 98}`).join(' '), class: 'rtp-jitter-line' }),
      svg('text', { x: 1, y: 141, class: 'rtp-chart-label' }, '#' + points[0].frame),
      svg('text', { x: 798, y: 141, 'text-anchor': 'end', class: 'rtp-chart-label' }, '#' + points.at(-1).frame));
    chart.addEventListener('click', (event) => {
      const bounds = chart.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      close({ action: 'packet', frame: points[Math.round(ratio * (points.length - 1))].frame });
    });
    return h('div', chart, h('div.hint', 'Click the chart to open a sampled source packet. Values follow capture arrival order; the packet table retains exact measurements.'));
  }
  function renderPackets() {
    if (!selected) return;
    const rows = problemOnly.checked ? selected.packets.filter((packet) => packet.flags.length) : selected.packets;
    packetHost.replaceChildren(pager(packetPage, rows.length, PAGE, 'packets', (page) => { packetPage = page; renderPackets(); }),
      h('div.rtp-table-scroll', h('table.rtp-table', h('thead', h('tr', ['Packet', 'Sequence', 'RTP timestamp', 'Codec', 'Delta', 'Jitter', 'Payload', 'Flags'].map((label) => h('th', label)))),
        h('tbody', rows.slice(packetPage * PAGE, (packetPage + 1) * PAGE).map((packet) => h('tr',
          h('td', frameButton(packet.frame)), h('td', packet.sequence), h('td', packet.timestamp), h('td', known(packet.codec?.name)),
          h('td', number(packet.deltaMs, ' ms')), h('td', number(packet.jitterMs, ' ms')), h('td', packet.payloadBytes + ' B'), h('td', packet.flags.join(', ') || '—')))))),
      !rows.length ? h('div.hint', 'No packets match the selected evidence filter.') : null);
  }
  function renderRtcp() {
    const reports = analysis.rtcp || [];
    return h('details.rtp-rtcp', h('summary', `RTCP reports (${reports.length})`),
      h('div.hint', 'Receiver jitter is retained in RTP timestamp units. These reports do not establish round-trip time or call quality.'),
      reports.slice(0, PAGE).map((report) => h('article', frameButton(report.frame),
        metadata([['Report', report.type === 'SR' ? 'Sender report' : 'Receiver report'], ['Direction', report.src + ' → ' + report.dst],
          ['Sender SSRC', report.senderSsrc], ['Captured', stamp(report.time)]]),
        report.sender ? metadata([['NTP seconds / fraction', `${report.sender.ntpSeconds} / ${report.sender.ntpFraction}`],
          ['RTP timestamp', report.sender.rtpTimestamp], ['Sender packets / bytes', `${report.sender.packetCount} / ${report.sender.octetCount}`]]) : null,
        report.reception.map((entry) => metadata([['Source SSRC', entry.ssrc], ['Receiver reported loss fraction', entry.fractionLost],
          ['Receiver reported cumulative loss', entry.cumulativeLost], ['Highest extended sequence', entry.extendedHighestSequence],
          ['Receiver jitter (timestamp units)', entry.jitterTimestampUnits], ['Last sender report', entry.lastSenderReport],
          ['Delay since sender report (1/65536 s)', entry.delaySinceLastSenderReportUnits65536]])))),
      reports.length > PAGE ? h('div.hint', 'Showing the first ' + PAGE + ' RTCP reports.') : null);
  }
  const body = h('div.rtp-workspace', h('div.rtp-toolbar', search, callFilter, count, allowCopilot ? copilotButton : null),
    h('label.check', heuristic, 'Find possible RTP without SDP (heuristic)'), warningBox,
    h('div.rtp-columns', h('aside.rtp-stream-panel', streams, streamPager), details));
  const done = modal({ title: 'RTP media · Captured audio', icon: 'route', width: 1320, body,
    buttons: [{ label: 'Close', value: null, primary: true }], submitOnEnter: false, onReady: (controls) => { close = controls.close; } });
  const abort = () => close(null);
  signal?.addEventListener('abort', abort, { once: true });
  try { reanalyze(); return await done; }
  finally { alive = false; signal?.removeEventListener('abort', abort); close(null); await stop(); audio = null; }
}
