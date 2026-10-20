// Notepad Tools menu, Find in Files, Send to terminal and hash verification.
import { h, icon, api, modal, toast, errMsg, buildFields, fmtBytes } from '../ui.js';
import * as T from './textops.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lsGet = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export function toolsMenu(np) {
  const tf = (fn, opts) => () => np.transform(fn, { lines: false, ...opts });
  const toNewDoc = (title, fn, language) => () => {
    try {
      const out = fn(np.selectionOrAll());
      np.newDoc({ text: out, title, language });
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  return [
    { label: 'JSON: format', icon: 'edit', action: tf((t) => T.jsonFormat(t, 2)) },
    { label: 'JSON: minify', action: tf(T.jsonMinify) },
    { label: 'XML / HTML: format', action: tf((t) => T.xmlFormat(t)) },
    '-',
    { label: 'Base64 encode', action: tf(T.base64Encode) },
    { label: 'Base64 decode', action: tf(T.base64Decode) },
    { label: 'URL encode', action: tf(T.urlEncode) },
    { label: 'URL decode', action: tf(T.urlDecode) },
    { label: 'Hex encode', action: tf(T.hexEncode) },
    { label: 'Hex decode', action: tf(T.hexDecode) },
    '-',
    { label: 'Hash text (MD5 / SHA)…', icon: 'hash', action: () => hashText(np) },
    { label: 'Verify a file hash (firmware)…', icon: 'shield', action: () => hashFile(np) },
    '-',
    { label: 'Extract IPv4 addresses', icon: 'network', action: toNewDoc('IP addresses', (t) => T.extractIPv4(t).join('\n') || '(none found)', 'plaintext') },
    { label: 'Extract MAC addresses', action: toNewDoc('MAC addresses', (t) => T.extractMacs(t).join('\n') || '(none found)', 'plaintext') },
    {
      label: 'Copy config without secrets', icon: 'lock',
      action: () => {
        const r = T.sanitizeConfig(np.current.model.getValue());
        np.newDoc({ text: r.text, title: `${np.current.title} (sanitized)`, language: np.current.model.getLanguageId() });
        toast(r.count ? `Removed ${r.count} password, key or community string(s)` : 'No secrets found', 'ok');
      },
    },
    { label: 'Statistics', icon: 'info', action: () => statsDialog(np) },
    '-',
    { label: 'Compare with…', icon: 'columns', action: () => np.compareDialog() },
    { label: 'Send to terminal…', icon: 'send', action: () => sendToTerminalDialog(np) },
  ];
}

// ---------------------------------------------------------------- hashing

async function hashText(np) {
  const text = np.selectionOrAll();
  const r = await api.invoke('np:hashText', text);
  hashDialog(`Hash of ${np.editor.getSelection().isEmpty() ? np.current.title : 'selection'} (UTF-8, ${fmtBytes(r.size)})`, r);
}

async function hashFile() {
  const p = await api.invoke('np:pickFile');
  if (!p) return;
  toast('Hashing… large images take a few seconds');
  try {
    const r = await api.invoke('np:hashFile', p);
    hashDialog(`${p.split(/[\\/]/).pop()} (${fmtBytes(r.size)})`, r);
  } catch (e) {
    toast(errMsg(e), 'err');
  }
}

export function hashDialog(title, r) {
  const rows = [
    ['MD5', r.md5],
    ['SHA-1', r.sha1],
    ['SHA-256', r.sha256],
    ['SHA-512', r.sha512],
  ];
  const expected = h('input.input.mono', { placeholder: 'Paste the expected hash (e.g. from the vendor download page) to verify', spellcheck: false });
  const verdict = h('div.np-verdict');
  const cells = rows.map(([name, v]) => h('div.np-hashrow', h('span.np-hashname', name), h('span.mono.np-hashval', v), h('button.icon-btn', { title: 'Copy', onclick: () => api.invoke('clipboard:write', v) }, icon('copy'))));
  expected.addEventListener('input', () => {
    const want = expected.value.trim().toLowerCase().replace(/^(md5|sha1|sha256|sha512)[:=\s]*/i, '');
    cells.forEach((c) => c.classList.remove('match'));
    if (!want) return verdict.replaceChildren();
    const i = rows.findIndex(([, v]) => v === want);
    if (i >= 0) {
      cells[i].classList.add('match');
      verdict.replaceChildren(h('span.pill.ok', `✓ ${rows[i][0]} matches: the file is intact`));
    } else verdict.replaceChildren(h('span.pill.err', '✗ No match: the file is corrupt, tampered with, or a different version'));
  });
  modal({ title, icon: 'hash', width: 820, body: [...cells, expected, verdict], buttons: [{ label: 'Close', value: null, primary: true }] });
}

function statsDialog(np) {
  const s = T.stats(np.selectionOrAll());
  modal({
    title: 'Statistics',
    icon: 'info',
    body: h('div.kvs', ...[['Lines', s.lines], ['Words', s.words], ['Characters', s.chars], ['Characters (no spaces)', s.charsNoSpaces], ['Size (UTF-8)', fmtBytes(s.bytes)]].flatMap(([k, v]) => [h('div.k', k), h('div.v', String(v.toLocaleString()))])),
    buttons: [{ label: 'Close', value: null, primary: true }],
  });
}

// ---------------------------------------------------------------- Find in Files

export async function findInFilesDialog(np) {
  const last = lsGet('konx.np.find', { dir: '', filters: '*.*', regex: false, caseSensitive: false, wholeWord: false, recurse: true });
  const sel = np.editor && np.editor.getSelection();
  const seed = sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber ? np.editor.getModel().getValueInRange(sel) : last.query || '';
  const { els, read, inputs } = buildFields(
    [
      { name: 'query', label: 'Find what', span: 2 },
      { name: 'dir', label: 'Directory', browse: 'dir', span: 2 },
      { name: 'filters', label: 'Filters', placeholder: '*.cfg *.txt *.log', hint: 'Space or ; separated wildcards' },
      { name: 'recurse', label: 'Include subfolders', type: 'checkbox' },
      { name: 'caseSensitive', label: 'Match case', type: 'checkbox' },
      { name: 'wholeWord', label: 'Whole word', type: 'checkbox' },
      { name: 'regex', label: 'Regular expression', type: 'checkbox' },
    ],
    { ...last, query: seed, dir: last.dir || (np.current && np.current.path ? np.current.path.replace(/[\\/][^\\/]*$/, '') : '') }
  );
  setTimeout(() => inputs.query.select(), 30);
  const ok = await modal({ title: 'Find in Files', icon: 'search', width: 640, body: h('div.grid2', els), buttons: [{ label: 'Cancel', value: null }, { label: 'Find all', value: true, primary: true }] });
  if (!ok) return;
  const opts = read();
  if (!opts.query || !opts.dir) return toast('Enter text and choose a folder', 'err');
  lsSet('konx.np.find', opts);
  if (np.findPanel) np.findPanel.stop();
  np.findPanel = new FindPanel(np, opts);
}

class FindPanel {
  constructor(np, opts) {
    this.np = np;
    this.opts = opts;
    this.job = `f${Date.now().toString(36)}`;
    this.count = 0;
    this.files = new Map();
    this.head = h('div.np-res-head');
    this.list = h('div.np-res-list');
    np.results.replaceChildren(this.head, this.list);
    np.results.classList.remove('hidden');
    this.running = true;
    this.renderHead();
    api.invoke('np:find:start', this.job, opts);
  }

  renderHead(summary) {
    const o = this.opts;
    this.head.replaceChildren(
      icon('search'),
      h('span', 'Find "', h('b', o.query), '" in ', h('span.mono', o.dir), ` (${o.filters || '*'})`),
      h('span.hint', summary || `${this.count} hits in ${this.files.size} files${this.running ? ' · searching…' : ''}`),
      h('span', { style: { flex: 1 } }),
      this.running ? h('button.btn.sm', { onclick: () => this.stop() }, icon('stop'), 'Stop') : null,
      h('button.icon-btn', { title: 'Close results', onclick: () => this.close() }, icon('x'))
    );
  }

  add(job, rows) {
    if (job !== this.job) return;
    for (const r of rows) {
      this.count++;
      let f = this.files.get(r.file);
      if (!f) {
        const body = h('div.np-res-hits');
        const label = h('span.np-res-count', '');
        const head = h('div.np-res-file', icon('file'), h('span.mono', r.file), label);
        head.addEventListener('click', () => body.classList.toggle('hidden'));
        f = { body, label, n: 0 };
        this.files.set(r.file, f);
        this.list.append(head, body);
      }
      f.n++;
      f.label.textContent = ` (${f.n})`;
      if (this.list.childElementCount > 6000) continue;
      const before = r.text.slice(0, r.col - 1);
      const match = r.text.slice(r.col - 1, r.col - 1 + r.len);
      const after = r.text.slice(r.col - 1 + r.len);
      const row = h('div.np-res-hit', h('span.np-res-line', String(r.line)), h('span.mono', before.length > 80 ? '…' + before.slice(-80) : before, h('mark', match), after.slice(0, 200)));
      row.addEventListener('click', () => this.np.openFile(r.file, { line: r.line, col: r.col, len: r.len }));
      f.body.append(row);
    }
    this.renderHead();
  }

  done(job, s) {
    if (job !== this.job) return;
    this.running = false;
    if (s.error) return this.renderHead(`Error: ${s.error}`);
    this.renderHead(`${s.hits} hits in ${s.files} of ${s.scanned} files${s.truncated ? ' (stopped at the limit)' : ''}${s.stopped ? ' (stopped)' : ''}`);
  }

  stop() {
    if (this.running) api.invoke('np:find:stop', this.job);
  }

  close() {
    this.stop();
    this.np.results.classList.add('hidden');
    this.np.findPanel = null;
  }
}

// ---------------------------------------------------------------- Send to terminal

/**
 * Paste text into a terminal tab line by line with a delay, so network devices that drop
 * fast pasted input (console ports, busy switches) receive every line of a config.
 */
export async function sendToTerminalDialog(np) {
  const terms = np.app.tabs.filter((t) => t.kind === 'terminal' && t.state === 'connected');
  if (!terms.length) return toast('Connect a terminal tab first (SSH, Telnet or serial)', 'err');
  if (np.sending) return toast('Already sending; stop it first', 'err');
  const sel = np.editor.getSelection();
  const hasSel = sel && !sel.isEmpty();
  const lastTarget = terms.find((t) => t.id === np.lastTerminal) || terms[terms.length - 1];
  const { els, read } = buildFields(
    [
      { name: 'target', label: 'Send to', type: 'select', options: terms.map((t) => [t.id, `${t.title}${t.info && t.info.host ? ' (' + t.info.host + ')' : ''}`]), span: 2 },
      { name: 'scope', label: 'What', type: 'select', options: hasSel ? [['sel', 'Selected lines'], ['all', 'Whole document']] : [['all', 'Whole document']] },
      { name: 'delay', label: 'Delay between lines (ms)', type: 'number', min: 0, max: 10000 },
      { name: 'skip', label: 'Skip blank lines and "!" comments', type: 'checkbox', span: 2 },
      { name: 'show', label: 'Switch to the terminal while sending', type: 'checkbox', span: 2 },
    ],
    { target: lastTarget.id, scope: hasSel ? 'sel' : 'all', delay: np.opts.sendDelay ?? 150, skip: true, show: true }
  );
  const ok = await modal({ title: 'Send to terminal', icon: 'send', width: 560, body: [h('div.grid2', els), h('div.hint', 'Each line is sent followed by Enter. A short delay keeps slow consoles and busy devices from dropping characters.')], buttons: [{ label: 'Cancel', value: null }, { label: 'Send', value: true, primary: true }] });
  if (!ok) return;
  const o = read();
  const target = terms.find((t) => t.id === o.target);
  np.lastTerminal = target.id;
  np.opts.sendDelay = Number(o.delay) || 0;
  np.persistOpts();
  const model = np.editor.getModel();
  const m = np.monaco;
  let text;
  if (o.scope === 'sel' && hasSel) {
    const s = np.editor.getSelection();
    text = model.getValueInRange(new m.Range(s.startLineNumber, 1, s.endLineNumber, model.getLineMaxColumn(s.endLineNumber)), m.editor.EndOfLinePreference.LF);
  } else text = model.getValue(m.editor.EndOfLinePreference.LF);
  let lines = text.split('\n');
  if (o.skip) lines = lines.filter((l) => l.trim() && !/^\s*!/.test(l));
  if (!lines.length) return toast('Nothing to send', 'err');
  np.sending = { target: target.title, total: lines.length, done: 0, cancel: false };
  if (o.show) np.app.activate(target);
  for (const line of lines) {
    if (np.sending.cancel || target.state !== 'connected') break;
    target.sendText(line + '\r');
    np.sending.done++;
    np.updateStatus();
    if (np.sending.done < lines.length) await sleep(np.opts.sendDelay);
  }
  const s = np.sending;
  np.sending = null;
  np.updateStatus();
  if (s.cancel) toast(`Stopped after ${s.done} of ${s.total} lines`, 'err');
  else if (target.state !== 'connected') toast(`${target.title} disconnected after ${s.done} of ${s.total} lines`, 'err');
  else toast(`Sent ${s.done} lines to ${target.title}`, 'ok');
}
