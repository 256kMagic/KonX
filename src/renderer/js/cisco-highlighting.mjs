// Display-only Cisco hints. Buffer cells remain the source of truth: no ANSI,
// writes, cursor changes, selection changes, or rewritten copy/log output.
const INTERFACE = '(?:Fa(?:stEthernet)?|Gi(?:gabitEthernet)?|Te(?:nGigabitEthernet)?|Twe(?:ntyFiveGigE)?|Fo(?:rtyGigabitEthernet)?|Hu(?:ndredGigE)?|Eth(?:ernet)?|Et|Se(?:rial)?|Po(?:rt-channel)?|Vl(?:an)?|Lo(?:opback)?|Tu(?:nnel)?|MgmtEth|Management|BVI|BDI|Dialer|Virtual-Access|Virtual-Template|Multilink|Null|AppGigabitEthernet|Async|Bundle-Ether|nve)\\d[\\w./:-]*';
const HEADER = new RegExp('^\\s*(?:Interface\\s+)?' + INTERFACE + '\\s+is\\s+(administratively down|up|down)\\b', 'i');
const BRIEF = new RegExp('^\\s*' + INTERFACE + '\\s+\\S+\\s+(?:YES|NO)\\s+\\S+\\s+(administratively down|up|down)\\s+(up|down)\\s*$', 'i');
const STATUS = new RegExp('^\\s*' + INTERFACE + '\\s+.*?\\b(connected|notconnect|err-disabled|disabled|inactive|suspended)\\s+(?:\\d+|trunk|routed|unassigned)\\s+', 'i');
const CHANGE = new RegExp('\\b(?:Interface|Line protocol on Interface)\\s+' + INTERFACE + ',\\s+changed state to\\s+(administratively down|up|down)\\b', 'gi');
const PRIORITY = { error: 5, warning: 4, down: 3, up: 2, ip: 1 };

function ipv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function ipVersion(value) {
  if (ipv4(value)) return 4;
  let address = value;
  const zone = address.indexOf('%');
  if (zone !== -1) {
    if (!/^[A-Za-z0-9_.-]+$/.test(address.slice(zone + 1))) return 0;
    address = address.slice(0, zone);
  }
  if (!address.includes(':') || !/^[\da-f:.]+$/i.test(address)) return 0;
  if ((address.match(/::/g) || []).length > 1 || address.includes(':::')) return 0;
  const compressed = address.includes('::');
  if (!compressed && (address.startsWith(':') || address.endsWith(':'))) return 0;
  const parts = address.split(':').filter(Boolean);
  let units = parts.length;
  if (parts.at(-1)?.includes('.')) {
    if (!ipv4(parts.pop())) return 0;
    units++;
  }
  if (!parts.every(part => /^[\da-f]{1,4}$/i.test(part))) return 0;
  return (compressed ? units < 8 : units === 8) ? 6 : 0;
}

function addressLength(token) {
  // Consume whole candidates, so malformed addresses/hostnames/version strings
  // cannot yield a valid-looking suffix. A final full stop is punctuation.
  let candidate = token.endsWith('.') ? token.slice(0, -1) : token;
  const port = candidate.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
  if (port) return ipv4(port[1]) && Number(port[2]) <= 65535 ? port[1].length : 0;
  const pieces = candidate.split('/');
  if (pieces.length > 2) return 0;
  const version = ipVersion(pieces[0]);
  if (!version) return 0;
  if (pieces.length === 2 && (!/^\d{1,3}$/.test(pieces[1]) || Number(pieces[1]) > (version === 4 ? 32 : 128))) return 0;
  return candidate.length;
}

/** UTF-16 ranges in plain logical-line text; no terminal state or side effects. */
export function findCiscoHighlights(text) {
  if (typeof text !== 'string' || !text) return [];
  const spans = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const add = (start, end, kind) => { if (end > start) spans.push({ start: offset + start, end: offset + end, kind }); };
    const state = (start, value) => add(start, start + value.length, /^(?:up|connected)$/i.test(value) ? 'up' : 'down');
    const diagnostic = line.match(/^\s*(?:%\s*(?:Invalid input|Ambiguous command|Incomplete command|Unknown command|Unrecognized command|Error\b|Bad (?:IP|mask|address)|Access denied|Permission denied|Authentication failed|Connection refused)|ERROR\s*:)[^\r]*$/i);
    if (diagnostic) add(line.search(/\S/), line.trimEnd().length, 'error');
    for (const match of line.matchAll(/%[A-Z][A-Z0-9_-]*-([0-7])-[A-Z0-9_]+:/gi)) {
      const severity = Number(match[1]);
      if (severity <= 4) add(match.index, line.trimEnd().length, severity <= 3 ? 'error' : 'warning');
    }
    for (const match of line.matchAll(/(?:^|,)\s*(\d+\s+(?:input|output) errors)\b/gi)) {
      if (parseInt(match[1], 10) > 0) add(match.index + match[0].length - match[1].length, match.index + match[0].length, 'error');
    }
    const header = HEADER.exec(line);
    if (header) {
      state(header.index + header[0].length - header[1].length, header[1]);
      const protocol = /\bline protocol is\s+(up|down)\b/i.exec(line);
      if (protocol) state(protocol.index + protocol[0].length - protocol[1].length, protocol[1]);
    }
    const brief = BRIEF.exec(line);
    if (brief) {
      // Locate status columns from the end, not a similarly named interface.
      const suffix = /(administratively down|up|down)\s+(up|down)\s*$/i.exec(line);
      if (suffix) { state(suffix.index, suffix[1]); state(suffix.index + suffix[0].lastIndexOf(suffix[2]), suffix[2]); }
    }
    const status = STATUS.exec(line);
    if (status) {
      const match = /\b(connected|notconnect|err-disabled|disabled|inactive|suspended)\s+(?:\d+|trunk|routed|unassigned)\s+$/i.exec(status[0]);
      if (match) state(match.index, match[1]);
    }
    CHANGE.lastIndex = 0;
    for (const match of line.matchAll(CHANGE)) state(match.index + match[0].length - match[1].length, match[1]);
    for (const match of line.matchAll(/[A-Za-z0-9_.:%/\-]+/g)) {
      if (/\b(?:version|release)\s*[:=]?\s*$/i.test(line.slice(0, match.index))) continue;
      const length = addressLength(match[0]);
      if (length) add(match.index, match.index + length, 'ip');
    }
    offset += line.length + 1;
  }
  spans.sort((a, b) => a.start - b.start || PRIORITY[b.kind] - PRIORITY[a.kind] || b.end - a.end);
  const selected = [];
  for (const span of spans) {
    const previous = selected.at(-1);
    if (!previous || span.start >= previous.end) selected.push(span);
    else if (PRIORITY[span.kind] > PRIORITY[previous.kind]) selected[selected.length - 1] = span;
  }
  return selected;
}

// Work is bounded by the viewport, not scrollback. Extremely long wrapped
// records are left untouched rather than parsed as misleading partial lines.
const LIMITS = { rows: 256, cells: 65536, logicalCells: 8192, wraps: 32, decorations: 2048 };
const DARK = { error: '#ff6b6b', down: '#ff6b6b', up: '#55d98b', warning: '#ffc66d', ip: '#67b7ff' };
const LIGHT = { error: '#b42318', down: '#b42318', up: '#116b35', warning: '#8a4b00', ip: '#175caa' };
function palette(background) {
  let hex = typeof background === 'string' ? background : '';
  if (/^#[\da-f]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map(char => char + char).join('');
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(hex)) return DARK;
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] > 0.35 ? LIGHT : DARK;
}

/** Public xterm APIs only; enable allowProposedApi for markers/decorations. */
export class CiscoOutputHighlighter {
  constructor(term, { enabled = true, background = '#101820' } = {}) {
    this.term = term; this.enabled = !!enabled; this.colors = palette(background);
    this.disposed = false; this.frame = null; this.groups = []; this.listeners = [];
    const window = term.element?.ownerDocument?.defaultView || globalThis;
    this.schedule = window.requestAnimationFrame ? fn => window.requestAnimationFrame(fn) : fn => setTimeout(fn, 16);
    this.cancel = window.cancelAnimationFrame ? id => window.cancelAnimationFrame(id) : id => clearTimeout(id);
    for (const event of ['onWriteParsed', 'onScroll', 'onResize']) this.listeners.push(term[event](() => this.refresh()));
    this.listeners.push(term.buffer.onBufferChange(() => { this.clear(); this.refresh(); }));
    this.refresh();
  }

  setEnabled(enabled) {
    if (this.disposed) return;
    this.enabled = !!enabled;
    if (!this.enabled) { if (this.frame !== null) this.cancel(this.frame); this.frame = null; this.clear(); }
    else this.refresh();
  }

  setBackground(background) {
    if (this.disposed) return;
    const colors = palette(background);
    if (colors !== this.colors) { this.colors = colors; this.refresh(); }
  }

  refresh() {
    if (this.disposed || !this.enabled || this.frame !== null) return;
    this.frame = this.schedule(() => {
      this.frame = null;
      if (!this.disposed && this.enabled) this.update();
    });
  }

  clear() {
    for (const group of this.groups) this.release(group);
    this.groups = [];
  }

  release(group) {
    for (const entry of group.entries) { entry.render.dispose(); entry.decoration.dispose(); }
    group.marker.dispose();
  }

  update() {
    const term = this.term, buffer = term.buffer.active;
    if (buffer.type !== 'normal') { this.clear(); return; }
    const top = buffer.viewportY, bottom = Math.min(buffer.length, top + term.rows, top + LIMITS.rows);
    const wanted = new Map();
    let spent = 0, decorations = 0, row = top;
    while (row < bottom && spent < LIMITS.cells && decorations < LIMITS.decorations) {
      let first = row, last = row, count = 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped && count < LIMITS.wraps) { first--; count++; }
      let complete = !buffer.getLine(first)?.isWrapped;
      while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped && count < LIMITS.wraps) { last++; count++; }
      if (buffer.getLine(last + 1)?.isWrapped) complete = false;
      const cost = (last - first + 1) * term.cols;
      if (!complete || cost > LIMITS.logicalCells || cost + spent > LIMITS.cells) {
        // Advance across only the visible fragment of an oversized wrap chain.
        row = last + 1;
        while (row < bottom && buffer.getLine(row)?.isWrapped) row++;
        continue;
      }
      spent += cost;
      const cells = [], parts = [];
      let length = 0, overlong = false;
      const scratch = buffer.getNullCell();
      rows: for (let y = first; y <= last; y++) {
        const line = buffer.getLine(y);
        if (!line) continue;
        let columns = Math.min(term.cols, line.length);
        // xterm leaves one empty padding cell when a wide glyph wraps.
        if (y < last && line.getCell(columns - 1)?.getCode() === 0 && buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2) columns--;
        for (let x = 0; x < columns; x++) {
          const cell = line.getCell(x, scratch);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ', end = length + chars.length;
          // Combining characters can expand one terminal cell into a very long
          // JS string; cap that representation as well as physical cell visits.
          if (end > LIMITS.logicalCells * 2) { overlong = true; break rows; }
          parts.push(chars);
          cells.push({ start: length, end, row: y, x, width: cell.getWidth(),
            eligible: cell.isFgDefault() && cell.isBgDefault() && !cell.isInverse() && !cell.isInvisible() });
          length = end;
        }
      }
      const spans = overlong ? [] : findCiscoHighlights(parts.join('').trimEnd());
      let spanIndex = 0;
      for (const cell of cells) {
        while (spanIndex < spans.length && spans[spanIndex].end <= cell.start) spanIndex++;
        const span = spans[spanIndex];
        if (!span || span.start >= cell.end || !cell.eligible || cell.row < top || cell.row >= bottom) continue;
        let ranges = wanted.get(cell.row);
        if (!ranges) wanted.set(cell.row, ranges = []);
        const previous = ranges.at(-1);
        if (previous && previous.kind === span.kind && previous.x + previous.width === cell.x) previous.width += cell.width;
        else if (decorations < LIMITS.decorations) { ranges.push({ x: cell.x, width: cell.width, kind: span.kind, color: this.colors[span.kind] }); decorations++; }
      }
      row = last + 1;
    }
    // Reuse identical decorations. Decorating triggers renderer updates, but
    // never schedules us through onRender: there is no redraw feedback loop.
    const keep = [];
    for (const group of this.groups) {
      const ranges = wanted.get(group.marker.line);
      if (!group.marker.isDisposed && group.entries.every(entry => !entry.decoration.isDisposed) && ranges && group.signature === JSON.stringify(ranges)) {
        wanted.delete(group.marker.line); keep.push(group);
      } else this.release(group);
    }
    for (const [line, ranges] of wanted) {
      const marker = term.registerMarker(line - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const group = { marker, signature: JSON.stringify(ranges), entries: [] };
      for (const range of ranges) {
        const decoration = term.registerDecoration({ marker, x: range.x, width: range.width, foregroundColor: range.color, layer: 'bottom' });
        if (!decoration) continue;
        const render = decoration.onRender(element => {
          element.classList.add('konx-cisco-highlight'); element.dataset.kind = range.kind;
          element.style.pointerEvents = 'none'; element.setAttribute('aria-hidden', 'true');
        });
        group.entries.push({ decoration, render });
      }
      if (group.entries.length) keep.push(group); else marker.dispose();
    }
    this.groups = keep;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    for (const listener of this.listeners) listener.dispose();
    this.listeners = []; this.clear();
  }
}
