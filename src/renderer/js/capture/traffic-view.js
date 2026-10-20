import { h, icon, api, modal, toast, errMsg, fmtBytes } from '../ui.js';
import { parseHttpStream } from './http.mjs';
import { buildStreamPreview } from './stream-preview.mjs';

const PREVIEW_BYTES = 256 * 1024;
const PAGE_SIZE = 30;
const textDecoder = new TextDecoder();
const warnText = (value) => typeof value === 'string' ? value : value.message || value.reason || String(value);
const warnings = (items) => [...new Set((items || []).map(warnText))];
const warningList = (items) => {
  const lines = warnings(items);
  return lines.length ? h('div.traffic-warnings', lines.map((line) => h('div', icon('info'), line))) : null;
};
const bytesIn = (dir) => dir.ranges.reduce((n, r) => n + (r.kind === 'data' ? r.data.length : 0), 0);

/** A local, text-only view. Captured HTML and links are never rendered or fetched. */
export async function showTraffic(stream) {
  const rawPreview = buildStreamPreview(stream);
  let close;
  let mode = 'readable';
  let pageSize = PAGE_SIZE;
  let parsed = null;
  let parseError = '';
  let alive = true;
  const out = h('div.traffic-content', h('div.hint', 'Reconstructing messages…'));
  const summary = h('div.traffic-summary');
  const notices = h('div');
  const search = h('input.input', {
    type: 'search', placeholder: 'Search requests, responses, headers, or body text',
    'aria-label': 'Search traffic', oninput: () => { pageSize = PAGE_SIZE; render(); },
  });
  const modes = h('div.traffic-modes');
  const endpoint = (dir) => h('span', { class: dir.fromA ? 'fa-key' : 'fb-key' },
    `${dir.fromA ? stream.conv.a : stream.conv.b} · ${fmtBytes(bytesIn(dir))}`);
  const done = modal({
    title: `${stream.conv.proto} stream ${stream.conv.id} · Readable traffic`,
    icon: 'route', width: 1100,
    body: h('div.traffic', h('div.follow-head', stream.directions.map(endpoint)),
      h('div.hint', 'Captured traffic snapshot. Packet buttons return to the original evidence.'),
      h('div.traffic-toolbar', modes, search), summary, notices, out),
    footerLeft: h('button.btn.sm', {
      onclick: async () => {
        try { await api.invoke('clipboard:write', out.innerText); toast('Visible traffic copied'); }
        catch (e) { toast(errMsg(e), 'err'); }
      },
    }, icon('copy'), 'Copy visible text'),
    buttons: [
      { label: 'Filter this stream', value: { action: 'filter' } },
      { label: 'Close', value: null, primary: true },
    ],
    onReady: (controls) => { close = controls.close; },
    submitOnEnter: false,
  });
  done.then(() => { alive = false; });

  function frames(numbers) {
    const unique = [...new Set(numbers || [])];
    const links = (list) => list.map((no) => h('button.traffic-frame', {
      title: `Show original packet ${no}`, onclick: () => close({ action: 'packet', frame: no }),
    }, `#${no}`));
    return h('div.traffic-frames', h('span', 'Packets'), links(unique.slice(0, 12)),
      unique.length > 12 ? h('details', h('summary', `${unique.length - 12} more`), links(unique.slice(12, 200)),
        unique.length > 200 ? h('span.hint', `Showing the first 200 of ${unique.length} source packets. Filter this stream to inspect the capture.`) : null) : null);
  }

  function messageCard(message, request) {
    if (!message) return h('div.traffic-absent', 'No matching message captured');
    const preview = message.text;
    const bodyBytes = message.decodedBody || message.body;
    const canSave = message.exportable && message.decodedBody != null && message.decodedBody.length > 0;
    const save = h('button.btn.sm', {
      disabled: !canSave,
      title: canSave ? 'Save the complete decoded body' : 'Only complete, unambiguous decoded bodies can be saved',
      onclick: async () => {
        save.disabled = true;
        try {
          const target = (request && request.target) || message.target || '';
          const leaf = target.split('?')[0].split('/').pop();
          const ext = /json/i.test(message.mediaType) ? 'json' : /html/i.test(message.mediaType) ? 'html' : /xml/i.test(message.mediaType) ? 'xml' : /^text\//i.test(message.mediaType) ? 'txt' : 'bin';
          const file = await api.invoke('cap:saveBody', leaf || `stream-${stream.conv.id}-${message.id}.${ext}`, message.decodedBody);
          if (file) toast('Body saved');
        } catch (e) { toast(errMsg(e), 'err'); }
        finally { save.disabled = !canSave; }
      },
    }, icon('download'), 'Save body');
    return h('section.traffic-message', { class: message.fromA ? 'from-a' : 'from-b' },
      h('div.traffic-message-head', h('strong', message.type === 'request' ? 'Request' : 'Response'),
        h('span.traffic-state', { class: message.complete && !message.warnings.length ? 'complete' : 'incomplete' },
          message.complete ? (message.exportable ? 'Complete' : 'See notes') : 'Incomplete'),
        save),
      h('pre.traffic-start', message.startLine),
      h('div.hint', `${message.mediaType || 'No content type'} · ${fmtBytes(bodyBytes.length)} body`),
      warningList(message.warnings),
      h('details.traffic-headers', h('summary', `${message.headers.length} headers`),
        h('pre', message.headers.map(({ name, value }) => `${name}: ${value}`).join('\n')),
        message.trailers.length ? h('pre', 'Trailers\n' + message.trailers.map(({ name, value }) => `${name}: ${value}`).join('\n')) : null),
      preview ? h('pre.traffic-body', preview.slice(0, PREVIEW_BYTES)) :
        h('div.traffic-binary', bodyBytes.length ? 'Binary or undecoded body. Use Hex to inspect the captured bytes.' : 'No body'),
      message.previewTruncated || (preview && preview.length > PREVIEW_BYTES) ? h('div.hint',
        `Body text preview is truncated. ${canSave ? 'Save the body for the full content.' : 'Inspect the original packets for the available content.'}`) : null,
      frames(message.frames));
  }

  function renderReadable() {
    if (parseError) return [h('div.traffic-gap', `Unable to interpret HTTP: ${parseError}. Text and Hex remain available.`)];
    if (!parsed) return [h('div.hint', 'Reconstructing messages…')];
    if (!parsed.recognized) return [h('div.traffic-empty',
      h('strong', 'No supported HTTP/1 messages found'),
      h('p', 'Use Text or Hex for other protocols. TLS payloads remain encrypted; key-log decryption is not included in this view.'))];
    const query = search.value.trim().toLocaleLowerCase();
    const searchable = (m) => m && [m.startLine, ...m.headers.map((v) => `${v.name}: ${v.value}`), m.text || ''].join('\n').toLocaleLowerCase().includes(query);
    const rows = parsed.exchanges.filter((exchange) => !query || [exchange.request, exchange.response, ...exchange.informational].some(searchable));
    summary.textContent = `${rows.length} of ${parsed.exchanges.length} exchanges${query ? ' match' : ''} · HTTP/1`;
    const nodes = rows.slice(0, pageSize).map((exchange) => h('article.traffic-exchange',
      h('div.traffic-exchange-title', h('span', `Exchange ${parsed.exchanges.indexOf(exchange) + 1}`),
        h('strong', exchange.request ? `${exchange.request.method} ${exchange.request.target}` : 'Response without a captured request'),
        exchange.response ? h('span', `${exchange.response.status} ${exchange.response.reason || ''}`) : h('span.hint', 'No final response')),
      warningList(exchange.warnings),
      exchange.informational.length ? h('details', h('summary', `${exchange.informational.length} interim responses`),
        exchange.informational.map((m) => messageCard(m, exchange.request))) : null,
      h('div.traffic-pair', messageCard(exchange.request, exchange.request), messageCard(exchange.response, exchange.request))));
    if (!rows.length) nodes.push(h('div.traffic-empty', 'No exchanges match this search.'));
    if (rows.length > pageSize) nodes.push(h('button.btn', { onclick: () => { pageSize += PAGE_SIZE; render(); } }, `Show ${Math.min(PAGE_SIZE, rows.length - pageSize)} more`));
    return nodes;
  }

  function renderRaw() {
    const nodes = [];
    const query = search.value.toLocaleLowerCase();
    for (const block of rawPreview.blocks) {
      if (block.kind === 'gap') {
        nodes.push(h('div.traffic-gap', `${block.fromA ? stream.conv.a : stream.conv.b}: ${fmtBytes(block.length)} missing from capture. These bytes are unknown.`));
        continue;
      }
      const text = mode === 'hex' ? hex(block.data) : textDecoder.decode(block.data);
      if (!query || text.toLocaleLowerCase().includes(query)) nodes.push(h('section.traffic-raw',
        h('div.traffic-raw-head', { class: block.fromA ? 'fa-key' : 'fb-key' }, block.fromA ? stream.conv.a : stream.conv.b),
        h('pre.follow-chunk', { class: block.fromA ? 'fa' : 'fb' }, text || '(Empty datagram)'), frames(block.frames)));
    }
    summary.textContent = `${mode === 'hex' ? 'Hex' : 'UTF-8 text'} · by direction in sequence order · ${query ? 'search within the preview' : 'gaps shown separately'}`;
    if (rawPreview.truncated) nodes.push(h('div.traffic-gap', 'Preview limited to 256 KiB and 200 blocks. Later content is not shown; the original capture remains available.'));
    if (!nodes.length) nodes.push(h('div.traffic-empty', query ? 'No text matches in the preview.' : 'This stream has no payload data.'));
    return nodes;
  }

  function render() {
    if (!alive) return;
    modes.replaceChildren(...[['readable', 'Readable'], ['text', 'Text'], ['hex', 'Hex']].map(([key, label]) =>
      h('button.btn.sm', { class: mode === key ? 'primary' : '', 'aria-pressed': mode === key,
        onclick: () => { mode = key; render(); } }, label)));
    search.placeholder = mode === 'readable' ? 'Search requests, responses, headers, or body text' : 'Search the bounded stream preview';
    out.replaceChildren(...(mode === 'readable' ? renderReadable() : renderRaw()));
  }
  render();
  try {
    parsed = stream.conv.proto === 'TCP' ? await parseHttpStream(stream) : { recognized: false, exchanges: [], warnings: [] };
    const details = [...(stream.warnings || []), ...stream.directions.flatMap((d) => [
      ...(d.warnings || []),
      ...(d.conflicts.length ? ['Conflicting retransmissions: reconstructed bytes are ambiguous. See packet evidence.'] : []),
      ...(!d.startKnown && stream.conv.proto === 'TCP' ? ['The start of this TCP direction was not captured.'] : []),
    ]), ...(parsed.warnings || [])];
    if (alive) notices.replaceChildren(warningList(details));
    render();
  } catch (e) {
    parseError = errMsg(e);
    render();
  }
  return done;
}

function hex(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    lines.push(`${i.toString(16).padStart(8, '0')}  ${Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${Array.from(row, (b) => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')}`);
  }
  return lines.join('\n');
}
