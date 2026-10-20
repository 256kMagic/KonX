// Session manager: sidebar tree of saved sessions and the session editor dialog.
import { h, icon, api, contextMenu, confirmDialog, promptText, modal, buildFields, toast, errMsg } from './ui.js';
import { SCHEMES } from './themes.js';

const PROTO_TAG = { ssh: 'SSH', telnet: 'TEL', raw: 'RAW', serial: 'COM' };
const LS_KEY = 'konx.expanded';

function loadExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveExpanded(set) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...set]));
  } catch {}
}

export class SessionTree {
  constructor(app) {
    this.app = app;
    this.data = { folders: [], sessions: [] };
    this.expanded = loadExpanded();
    this.selected = null;
    this.filter = '';
    this.search = h('input', { placeholder: 'Filter sessions', spellcheck: false });
    this.search.addEventListener('input', () => {
      this.filter = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.visibleSessions()[0];
        if (first) this.app.connectSession(first);
      } else if (e.key === 'Escape') {
        this.search.value = '';
        this.filter = '';
        this.render();
      }
    });
    this.tree = h('div.tree', { tabIndex: 0 });
    this.tree.addEventListener('contextmenu', (e) => {
      if (e.target === this.tree) {
        e.preventDefault();
        this.rootMenu(e.clientX, e.clientY);
      }
    });
    this.tree.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h(
      'div.side-section.grow',
      h(
        'div.side-head',
        h('span.title', 'Sessions'),
        h('button', { title: 'New session', onclick: () => this.app.editSession() }, icon('plus')),
        h('button', { title: 'New folder', onclick: () => this.newFolder('') }, icon('folder')),
        h('button', { title: 'Import sessions', onclick: (e) => this.importMenu(e) }, icon('import'))
      ),
      h('div.side-search', icon('search'), this.search),
      this.tree
    );
  }

  async load() {
    this.data = await api.invoke('sessions:list');
    this.render();
  }

  visibleSessions() {
    const f = this.filter;
    return this.data.sessions.filter((s) => !f || [s.name, s.host, s.username, s.folder, s.serialPort].some((v) => v && String(v).toLowerCase().includes(f)));
  }

  render() {
    const rows = [];
    const { folders, sessions } = this.data;
    if (!sessions.length && !folders.length) {
      this.tree.replaceChildren(
        h('div.tree-empty', 'No saved sessions yet.', h('br'), 'Use ', h('b', '+'), ' to add one, or import from SecureCRT or ~/.ssh/config.')
      );
      return;
    }
    if (this.filter) {
      for (const s of this.visibleSessions()) rows.push(this.sessionRow(s, 0, true));
      if (!rows.length) rows.push(h('div.tree-empty', 'No matches.'));
      this.tree.replaceChildren(...rows);
      return;
    }
    const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const walk = (parent, depth) => {
      const children = folders.filter((f) => (parent ? f.startsWith(parent + '/') && !f.slice(parent.length + 1).includes('/') : !f.includes('/'))).sort(byName);
      for (const f of children) {
        const open = this.expanded.has(f);
        rows.push(this.folderRow(f, depth, open));
        if (open) walk(f, depth + 1);
      }
      sessions
        .filter((s) => (s.folder || '') === parent)
        .sort((a, b) => byName(a.name || a.host, b.name || b.host))
        .forEach((s) => rows.push(this.sessionRow(s, depth)));
    };
    walk('', 0);
    this.tree.replaceChildren(...rows);
  }

  countIn(folder) {
    return this.data.sessions.filter((s) => s.folder === folder || (s.folder || '').startsWith(folder + '/')).length;
  }

  folderRow(f, depth, open) {
    const name = f.split('/').pop();
    const row = h(
      'div.tree-row',
      { style: { paddingLeft: 4 + depth * 14 + 'px' }, class: this.selected === 'f:' + f ? 'selected' : '' },
      h('span.chev', icon(open ? 'chev-down' : 'chev-right')),
      icon(open ? 'folder-open' : 'folder'),
      h('span.name', name),
      h('span.meta', this.countIn(f) || '')
    );
    row.addEventListener('click', () => {
      this.selected = 'f:' + f;
      open ? this.expanded.delete(f) : this.expanded.add(f);
      saveExpanded(this.expanded);
      this.render();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.selected = 'f:' + f;
      this.render();
      this.folderMenu(e.clientX, e.clientY, f);
    });
    // Drop sessions onto folders to move them.
    row.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-konx-session')) {
        e.preventDefault();
        row.classList.add('drop-target');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async (e) => {
      row.classList.remove('drop-target');
      const id = e.dataTransfer.getData('application/x-konx-session');
      if (id) {
        await api.invoke('sessions:save', { id, folder: f });
        this.load();
      }
    });
    return row;
  }

  sessionRow(s, depth, showFolder = false) {
    const row = h(
      'div.tree-row',
      {
        style: { paddingLeft: 4 + depth * 14 + 'px' },
        class: this.selected === 's:' + s.id ? 'selected' : '',
        draggable: true,
        title: `${s.protocol === 'serial' ? s.serialPort : `${s.username ? s.username + '@' : ''}${s.host}:${s.port || ''}`}${s.notes ? '\n' + s.notes : ''}`,
      },
      h('span.chev'),
      icon(s.protocol === 'serial' ? 'usb' : 'server'),
      h('span.name', s.name || s.host),
      showFolder && s.folder ? h('span.meta', s.folder) : null,
      h('span.proto', PROTO_TAG[s.protocol] || 'SSH')
    );
    row.addEventListener('click', () => {
      this.selected = 's:' + s.id;
      this.render();
    });
    row.addEventListener('dblclick', () => this.app.connectSession(s));
    row.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-konx-session', s.id));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.selected = 's:' + s.id;
      this.render();
      this.sessionMenu(e.clientX, e.clientY, s);
    });
    return row;
  }

  selectedSession() {
    if (!this.selected || !this.selected.startsWith('s:')) return null;
    return this.data.sessions.find((s) => s.id === this.selected.slice(2));
  }

  onKey(e) {
    const s = this.selectedSession();
    if (e.key === 'Enter' && s) this.app.connectSession(s);
    else if (e.key === 'Delete' && s) this.deleteSession(s);
    else if (e.key === 'F2' && s) this.app.editSession(s);
  }

  sessionMenu(x, y, s) {
    contextMenu(x, y, [
      { label: 'Connect', icon: 'terminal', action: () => this.app.connectSession(s) },
      s.protocol === 'ssh' || !s.protocol ? { label: 'Connect SFTP', icon: 'file-transfer', action: () => this.app.openSftp({ sessionId: s.id }, { name: s.name || s.host }) } : null,
      '-',
      { label: 'Edit…', icon: 'edit', shortcut: 'F2', action: () => this.app.editSession(s) },
      { label: 'Duplicate', icon: 'copy', action: () => this.duplicate(s) },
      s.host ? { label: 'Ping host', icon: 'activity', action: () => this.app.openTool('ping', { hosts: s.host }) } : null,
      s.host ? { label: 'Port scan host', icon: 'target', action: () => this.app.openTool('portscan', { targets: s.host }) } : null,
      s.host ? { label: 'Capture traffic to host', icon: 'capture', action: () => this.app.openTool('capture', { filter: `host ${s.host}`, captureFilter: `host ${s.host}` }) } : null,
      '-',
      { label: 'Delete', icon: 'trash', danger: true, shortcut: 'Del', action: () => this.deleteSession(s) },
    ]);
  }

  folderMenu(x, y, f) {
    contextMenu(x, y, [
      { label: 'New session here', icon: 'plus', action: () => this.app.editSession({ folder: f }) },
      { label: 'New subfolder', icon: 'folder', action: () => this.newFolder(f) },
      { label: 'Connect all', icon: 'terminal', action: () => this.data.sessions.filter((s) => s.folder === f).forEach((s) => this.app.connectSession(s)) },
      '-',
      { label: 'Rename…', icon: 'edit', action: () => this.renameFolder(f) },
      { label: 'Delete folder', icon: 'trash', danger: true, action: () => this.deleteFolder(f) },
    ]);
  }

  rootMenu(x, y) {
    contextMenu(x, y, [
      { label: 'New session', icon: 'plus', action: () => this.app.editSession() },
      { label: 'New folder', icon: 'folder', action: () => this.newFolder('') },
      '-',
      { label: 'Import from SecureCRT…', icon: 'import', action: () => this.import('securecrt') },
      { label: 'Import from ~/.ssh/config…', icon: 'import', action: () => this.import('sshconfig') },
    ]);
  }

  importMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: 'Import from SecureCRT…', icon: 'import', action: () => this.import('securecrt') },
      { label: 'Import from ~/.ssh/config…', icon: 'import', action: () => this.import('sshconfig') },
    ]);
  }

  async import(kind) {
    try {
      const n = await api.invoke('sessions:import', kind);
      if (n == null) return;
      toast(`Imported ${n} session${n === 1 ? '' : 's'}`, 'ok');
      this.expanded.add(kind === 'securecrt' ? 'SecureCRT' : 'SSH config');
      saveExpanded(this.expanded);
      this.load();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async newFolder(parent) {
    const name = await promptText('New folder', 'Folder name');
    if (!name) return;
    const path = parent ? `${parent}/${name.replace(/\//g, '-')}` : name.replace(/\//g, '-');
    await api.invoke('sessions:addFolder', path);
    if (parent) this.expanded.add(parent);
    saveExpanded(this.expanded);
    this.load();
  }

  async renameFolder(f) {
    const name = await promptText('Rename folder', 'Folder name', f.split('/').pop(), 'Rename');
    if (!name) return;
    const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    await api.invoke('sessions:renameFolder', f, parent ? `${parent}/${name}` : name);
    this.load();
  }

  async deleteFolder(f) {
    const n = this.countIn(f);
    if (!(await confirmDialog(`Delete folder "${f}"?`, { danger: true, okLabel: 'Delete', detail: n ? `${n} session(s) inside will move to the parent folder.` : null }))) return;
    await api.invoke('sessions:deleteFolder', f);
    this.load();
  }

  async deleteSession(s) {
    if (!(await confirmDialog(`Delete session "${s.name || s.host}"?`, { danger: true, okLabel: 'Delete' }))) return;
    await api.invoke('sessions:delete', s.id);
    this.load();
  }

  async duplicate(s) {
    const { id, hasPassword, hasPassphrase, ...rest } = s;
    await api.invoke('sessions:save', { ...rest, name: (s.name || s.host) + ' (copy)' });
    this.load();
  }
}

// ---------------------------------------------------------------- editor

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** Session editor. Resolves {session, connect} or null. */
export async function editSessionDialog(app, input = {}) {
  const s = { protocol: 'ssh', port: 22, auth: 'password', keepalive: 30, termType: 'xterm-256color', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', ...input };
  const isNew = !s.id;
  const sessions = app.sessions.data.sessions;
  const folders = app.sessions.data.folders;

  const general = buildFields([
    { name: 'name', label: 'Name', placeholder: 'core-sw1', span: 2 },
    { name: 'folder', label: 'Folder', placeholder: '(top level)' },
    { name: 'protocol', label: 'Protocol', type: 'select', options: [['ssh', 'SSH2'], ['telnet', 'Telnet'], ['raw', 'Raw TCP'], ['serial', 'Serial']] },
    { name: 'host', label: 'Hostname or IP', placeholder: '10.0.0.1', span: 2 },
    { name: 'port', label: 'Port', type: 'number' },
    { name: 'username', label: 'Username' },
  ], s);
  const folderInput = general.inputs.folder;
  folderInput.setAttribute('list', 'folder-list');
  const folderList = h('datalist#folder-list', folders.map((f) => h('option', { value: f })));

  const serialPort = h('input', { list: 'serial-list', value: s.serialPort || 'COM1', spellcheck: false });
  const serialList = h('datalist#serial-list');
  const refreshPorts = async () => {
    const ports = await api.invoke('serial:list').catch(() => []);
    serialList.replaceChildren(...ports.map((p) => h('option', { value: p.path }, p.label)));
  };
  const serialFields = buildFields([
    { name: 'baudRate', label: 'Baud rate', type: 'select', options: BAUDS.map((b) => [b, String(b)]) },
    { name: 'dataBits', label: 'Data bits', type: 'select', options: [[8, '8'], [7, '7'], [6, '6'], [5, '5']] },
    { name: 'parity', label: 'Parity', type: 'select', options: [['none', 'None'], ['even', 'Even'], ['odd', 'Odd'], ['mark', 'Mark'], ['space', 'Space']] },
    { name: 'stopBits', label: 'Stop bits', type: 'select', options: [[1, '1'], [2, '2']] },
    { name: 'flowControl', label: 'Flow control', type: 'select', options: [['none', 'None'], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']] },
  ], s);
  const serialBox = h(
    'div.grid3',
    h('label.field', h('span', 'Port'), h('div.input-with-btn', serialPort, h('button.btn.sm', { type: 'button', onclick: refreshPorts }, icon('refresh')))),
    serialFields.els,
    serialList,
    app.info.serial ? null : h('div.hint.span3', 'Serial support is not available in this build.')
  );

  // ---- authentication
  const pw = h('input', { type: 'password', placeholder: s.hasPassword ? '•••••••• (saved — leave blank to keep)' : '', autocomplete: 'off' });
  const savePw = h('input', { type: 'checkbox', checked: s.hasPassword || isNew });
  const auth = buildFields([
    { name: 'auth', label: 'Method', type: 'select', options: [['password', 'Password / keyboard-interactive'], ['key', 'Public key file'], ['agent', 'SSH agent (Pageant / OpenSSH)']] },
    { name: 'keyPath', label: 'Private key file', browse: 'file', placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519' },
  ], s);
  const passphrase = h('input', { type: 'password', placeholder: s.hasPassphrase ? '•••••••• (saved)' : 'Leave blank to be asked', autocomplete: 'off' });
  const authBox = h(
    'div.mpane',
    auth.els[0],
    h('label.field', h('span', 'Password'), pw),
    h('label.check', savePw, app.info.encryption ? 'Save password (encrypted with Windows DPAPI)' : 'Save password (encryption unavailable — not recommended)'),
    auth.els[1],
    h('label.field', h('span', 'Key passphrase'), passphrase),
    h('div.hint', 'Telnet sessions use the username and password above to answer login prompts automatically.')
  );

  // ---- connection
  const jumpOptions = [['', '(none — connect directly)'], ...sessions.filter((x) => x.id !== s.id && (x.protocol || 'ssh') === 'ssh').map((x) => [x.id, `${x.name || x.host} (${x.host})`])];
  const conn = buildFields([
    { name: 'jumpId', label: 'Jump host (ProxyJump)', type: 'select', options: jumpOptions, span: 2 },
    { name: 'keepalive', label: 'Keepalive (seconds)', type: 'number' },
    { name: 'connectTimeout', label: 'Connect timeout (seconds)', type: 'number', placeholder: '20' },
    { name: 'termType', label: 'Terminal type', type: 'select', options: [['xterm-256color', 'xterm-256color'], ['xterm', 'xterm'], ['vt100', 'vt100'], ['vt220', 'vt220'], ['linux', 'linux'], ['ansi', 'ansi']] },
  ], s);

  // ---- rows editors
  const actions = rowsEditor(s.logonActions || [], [
    { name: 'expect', placeholder: 'Wait for (e.g. Username:)' },
    { name: 'send', placeholder: 'Then send (supports {username} {password} \\r \\t)' },
  ], 'Add logon action');
  const forwards = rowsEditor(s.forwards || [], [
    { name: 'type', type: 'select', options: [['L', 'Local (-L)'], ['R', 'Remote (-R)'], ['D', 'Dynamic SOCKS (-D)']] },
    { name: 'listenHost', placeholder: 'Listen host (127.0.0.1)' },
    { name: 'listenPort', placeholder: 'Listen port' },
    { name: 'destHost', placeholder: 'Destination host' },
    { name: 'destPort', placeholder: 'Destination port' },
  ], 'Add port forward');

  // ---- terminal + logging
  const term = buildFields([
    { name: 'colorScheme', label: 'Color scheme', type: 'select', options: [['', '(use default)'], ...Object.entries(SCHEMES).map(([k, v]) => [k, v.label])] },
    { name: 'fontSize', label: 'Font size', type: 'number', placeholder: 'default' },
  ], s);
  const logging = buildFields([
    { name: 'enabled', label: 'Log this session automatically', type: 'checkbox', span: 2 },
    { name: 'path', label: 'Log file', placeholder: `${app.info.logDir}\\%S_%Y-%M-%D_%h%m%s.log`, span: 2, hint: '%S session  %H host  %Y %M %D date  %h %m %s time' },
    { name: 'timestamps', label: 'Timestamp each line', type: 'checkbox' },
  ], s.logging || {});
  const notes = buildFields([{ name: 'notes', label: 'Notes', type: 'textarea', rows: 6, span: 2 }], s);

  const panes = {
    General: h('div.mpane.active', h('div.grid3', general.els, folderList), serialBox),
    Authentication: authBox,
    Connection: h('div.mpane', h('div.grid2', conn.els), h('div.hint', 'A jump host is another saved SSH session; this session is reached through it.')),
    'Logon Actions': h('div.mpane', h('div.hint', 'Runs after connecting: wait for each prompt, then send the reply followed by Enter.'), actions.el),
    'Port Forwarding': h('div.mpane', forwards.el, h('div.hint', 'Forwards start when the SSH session connects and stop when it closes.')),
    'Terminal & Log': h('div.mpane', h('div.grid2', term.els, logging.els)),
    Notes: h('div.mpane', notes.els),
  };
  const tabBtns = Object.keys(panes).map((name) =>
    h('button', { type: 'button', class: name === 'General' ? 'active' : '', onclick: (e) => {
      Object.values(panes).forEach((p) => p.classList.remove('active'));
      tabBtns.forEach((b) => b.classList.remove('active'));
      panes[name].classList.add('active');
      e.currentTarget.classList.add('active');
    } }, name)
  );

  const proto = general.inputs.protocol;
  const syncProto = () => {
    const p = proto.value;
    const serial = p === 'serial';
    serialBox.classList.toggle('hidden', !serial);
    general.inputs.host.closest('.field').classList.toggle('hidden', serial);
    general.inputs.port.closest('.field').classList.toggle('hidden', serial);
    tabBtns[2].classList.toggle('hidden', p !== 'ssh');
    tabBtns[4].classList.toggle('hidden', p !== 'ssh');
    tabBtns[1].classList.toggle('hidden', serial);
    auth.inputs.auth.closest('.field').classList.toggle('hidden', p !== 'ssh');
    if (serial && !app.serialPortsLoaded) {
      app.serialPortsLoaded = true;
      refreshPorts();
    }
  };
  proto.addEventListener('change', () => {
    const port = general.inputs.port;
    if (['', '22', '23'].includes(String(port.value))) port.value = proto.value === 'ssh' ? 22 : proto.value === 'serial' ? '' : 23;
    syncProto();
  });
  syncProto();
  if (proto.value === 'serial') refreshPorts();

  const collect = () => {
    const g = general.read();
    const out = {
      ...(s.id ? { id: s.id } : {}),
      ...g,
      name: g.name || (g.protocol === 'serial' ? serialPort.value : g.host),
      port: g.port || undefined,
      serialPort: serialPort.value.trim(),
      ...serialFields.read(),
      ...auth.read(),
      ...conn.read(),
      ...term.read(),
      fontSize: term.read().fontSize || undefined,
      logging: logging.read(),
      notes: notes.read().notes,
      logonActions: actions.read().filter((a) => a.expect || a.send),
      forwards: forwards.read().filter((f) => f.listenPort),
    };
    if (!savePw.checked) out.password = null;
    else if (pw.value) out.password = pw.value;
    if (passphrase.value) out.passphrase = passphrase.value;
    return out;
  };

  const result = await modal({
    title: isNew ? 'New session' : `Edit session — ${s.name || s.host}`,
    icon: 'server',
    width: 720,
    body: [h('div.mtabs', tabBtns), ...Object.values(panes)],
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'save' },
      { label: 'Save & Connect', value: 'connect', primary: true },
    ],
    onSubmit: () => {
      const v = collect();
      if (v.protocol !== 'serial' && !v.host) {
        toast('Enter a hostname', 'err');
        return false;
      }
      return true;
    },
  });
  if (!result) return null;
  try {
    const saved = await api.invoke('sessions:save', collect());
    // A one-time password typed without "save" is still used for this connection.
    if (!savePw.checked && pw.value) saved._oncePassword = pw.value;
    return { session: saved, connect: result === 'connect' };
  } catch (e) {
    toast(errMsg(e), 'err');
    return null;
  }
}

/** Editable list of rows. fields: [{name, placeholder, type, options}] */
function rowsEditor(initial, fields, addLabel) {
  const list = h('div.rows-editor');
  const rows = [];
  const add = (v = {}) => {
    const inputs = {};
    const r = h('div.r');
    for (const f of fields) {
      let el;
      if (f.type === 'select') el = h('select.input', f.options.map(([val, l]) => h('option', { value: val, selected: v[f.name] === val }, l)));
      else {
        el = h('input.input', { placeholder: f.placeholder, spellcheck: false });
        el.value = v[f.name] ?? '';
      }
      inputs[f.name] = el;
      r.append(el);
    }
    const entry = { r, inputs };
    r.append(h('button.icon-btn.del', { type: 'button', title: 'Remove', onclick: () => {
      r.remove();
      rows.splice(rows.indexOf(entry), 1);
    } }, icon('trash')));
    rows.push(entry);
    list.append(r);
  };
  initial.forEach(add);
  const el = h('div', list, h('button.btn.sm', { type: 'button', style: { marginTop: '8px' }, onclick: () => add() }, icon('plus'), addLabel));
  return {
    el,
    read: () => rows.map(({ inputs }) => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]))),
  };
}
