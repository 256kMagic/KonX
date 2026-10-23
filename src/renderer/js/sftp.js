// SFTP tab: local and remote file panes side by side plus a transfer queue.
import { h, icon, api, DataTable, contextMenu, confirmDialog, promptText, modal, toast, errMsg, fmtBytes, fmtDate, debounce } from './ui.js';

import { createWorkspaceEvidence, requestedConnectionMetadata, captureSftpContext, workspaceCopilotItems, workspaceContextChoices, recordListingRequest } from './copilot-workspace.mjs';

let seq = 0;
const IS_WIN = api.platform === 'win32';

const posix = {
  join: (a, b) => (a.endsWith('/') ? a + b : a + '/' + b),
  parent: (p) => {
    if (p === '/' || !p) return '/';
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  },
};

function localJoin(dir, name) {
  if (IS_WIN && (dir === 'This PC' || !dir)) return name;
  const sep = IS_WIN ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

class FilePane {
  constructor(tab, side) {
    this.tab = tab;
    this.side = side;
    this.cwd = '';
    this.entries = [];
    this.navigationGeneration = 0;
    this.listingObservedAt = null;
    this.listingRunId = null;
    this.listingRequest = null;
    this.showHidden = tab.app.settings.sftpShowHidden;
    this.ready = side === 'local';

    this.pathInput = h('input.path', { spellcheck: false });
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.navigate(this.pathInput.value.trim());
    });
    this.hiddenBtn = h('button.icon-btn', { title: 'Show hidden files', class: this.showHidden ? 'on' : '', onclick: () => this.toggleHidden() }, icon('eye'));
    this.label = h('span', side === 'local' ? 'Local' : 'Remote');
    this.head = h(
      'div.pane-head',
      h('div.label', icon(side === 'local' ? 'home' : 'server'), this.label),
      h('button.icon-btn', { title: 'Up one level (Backspace)', onclick: () => this.up() }, icon('up')),
      h('button.icon-btn', { title: 'Home', onclick: () => this.goHome() }, icon('home')),
      this.pathInput,
      h('button.icon-btn', { title: 'Refresh (F5)', onclick: () => this.refresh() }, icon('refresh')),
      h('button.icon-btn', { title: 'New folder', onclick: () => this.newFolder() }, icon('folder')),
      this.hiddenBtn,
      h('button.icon-btn', {
        title: side === 'local' ? 'Upload selected to remote' : 'Download selected to local',
        onclick: () => this.transferSelected(),
      }, icon(side === 'local' ? 'upload' : 'download'))
    );

    const cols = [
      {
        key: 'name',
        label: 'Name',
        render: (r) =>
          h('span.fname', icon(r.isDir ? 'folder' : r.type === 'l' ? 'link' : 'file', r.isDir ? 'd' : r.type === 'l' ? 'l' : 'f'), r.name),
        sort: (r) => r.name.toLowerCase(),
      },
      { key: 'size', label: 'Size', width: 90, num: true, render: (r) => (r.isDir ? '' : fmtBytes(r.size)) },
      { key: 'mtime', label: 'Modified', width: 140, render: (r) => fmtDate(r.mtime) },
    ];
    if (side === 'remote') {
      cols.push({ key: 'perms', label: 'Permissions', width: 100, mono: true });
      cols.push({ key: 'owner', label: 'Owner', width: 80 });
    }
    this.table = new DataTable({
      columns: cols,
      rowKey: (r) => r.name,
      onActivate: (r) => this.activate(r),
      onContext: (e, rows) => this.menu(e, rows),
    });
    // Folders first, regardless of sort column.
    this.table.pin = (r) => (r.isDir ? 0 : 1);
    this.table.defaultSort = (a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1);
    this.table.decorate = (tr, r) => {
      tr.draggable = true;
      tr.addEventListener('dragstart', (e) => {
        if (!this.table.selected.has(r.name)) {
          this.table.selected = new Set([r.name]);
          this.table.render();
        }
        e.dataTransfer.setData('application/x-konx-files', JSON.stringify({ tab: this.tab.id, side: this.side, paths: this.selectedPaths() }));
        e.dataTransfer.effectAllowed = 'copy';
      });
    };
    this.table.el.addEventListener('keydown', (e) => this.onKey(e));
    this._setupDrop();
    this.foot = h('div.pane-foot', '');
    this.msg = h('div.pane-msg.hidden');
    this.el = h('div.pane', this.head, this.msg, this.table.el, this.foot);
  }

  get other() {
    return this.side === 'local' ? this.tab.remote : this.tab.local;
  }

  async list(dir) {
    if (this.side === 'local') return api.invoke('local:list', dir);
    return api.invoke('sftp:list', this.tab.sftpId, dir);
  }

  join(name) {
    return this.side === 'local' ? localJoin(this.cwd, name) : posix.join(this.cwd, name);
  }

  async parentOf(dir) {
    return this.side === 'local' ? api.invoke('local:parent', dir) : posix.parent(dir);
  }

  async navigate(dir) {
    if (!this.ready || this.tab.disposed) return;
    const generation = ++this.navigationGeneration;
    recordListingRequest(this, dir, 'running');
    try {
      const entries = await this.list(dir);
      if (this.tab.disposed || generation !== this.navigationGeneration) return;
      this.listingObservedAt = new Date().toISOString();
      this.listingRunId = this.tab.copilot.runId;
      this.cwd = dir;
      this.entries = entries;
      this.pathInput.value = dir;
      this.render();
      this.table.el.scrollTop = 0;
      recordListingRequest(this, dir, 'complete');
    } catch (e) {
      if (this.tab.disposed || generation !== this.navigationGeneration) return;
      recordListingRequest(this, dir, 'error', errMsg(e));
      toast(`Cannot open ${dir}: ${errMsg(e)}`, 'err');
      this.pathInput.value = this.cwd;
    }
  }

  render() {
    const rows = this.showHidden ? this.entries : this.entries.filter((e) => !(e.hidden || e.name.startsWith('.')));
    this.table.setRows(rows);
    const files = rows.filter((r) => !r.isDir);
    const total = files.reduce((n, r) => n + (r.size || 0), 0);
    this.foot.textContent = `${rows.length} items · ${files.length} files · ${fmtBytes(total)}${this.entries.length !== rows.length ? ` · ${this.entries.length - rows.length} hidden` : ''}`;
  }

  refresh() {
    return this.navigate(this.cwd);
  }

  async up() {
    this.navigate(await this.parentOf(this.cwd));
  }

  async goHome() {
    if (this.side === 'local') this.navigate(await api.invoke('local:home'));
    else this.navigate(this.tab.home || '/');
  }

  toggleHidden() {
    this.showHidden = !this.showHidden;
    this.hiddenBtn.classList.toggle('on', this.showHidden);
    this.render();
    this.tab.copilot.touch();
  }

  setMessage(content) {
    if (!content) {
      this.msg.classList.add('hidden');
      this.table.el.classList.remove('hidden');
      return;
    }
    this.msg.replaceChildren(...[content].flat());
    this.msg.classList.remove('hidden');
    this.table.el.classList.add('hidden');
  }

  selectedPaths() {
    return this.table.selectedRows().map((r) => this.join(r.name));
  }

  activate(r) {
    if (r.isDir) return this.navigate(r.drive ? r.name : this.join(r.name));
    // Double-clicking a file transfers it to the other side, SecureFX-style.
    this.transfer([this.join(r.name)]);
  }

  transferSelected() {
    const paths = this.selectedPaths();
    if (!paths.length) return toast('Select files or folders first');
    this.transfer(paths);
  }

  async transfer(paths, destDir) {
    const t = this.tab;
    if (!t.remote.ready) return toast('Remote side is not connected', 'err');
    const conflict = t.app.settings.sftpConflict;
    try {
      if (this.side === 'local') {
        const n = await api.invoke('sftp:upload', t.sftpId, paths, destDir || t.remote.cwd, { conflict });
        toast(`Queued ${n} file${n === 1 ? '' : 's'} for upload`);
      } else {
        const n = await api.invoke('sftp:download', t.sftpId, paths, destDir || t.local.cwd, { conflict });
        toast(`Queued ${n} file${n === 1 ? '' : 's'} for download`);
      }
      t.xfers.expand();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  _setupDrop() {
    const el = this.table.el;
    el.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types;
      const internal = types.includes('application/x-konx-files');
      if (internal || (types.includes('Files') && this.side === 'remote')) {
        e.preventDefault();
        el.classList.add('drop');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      const raw = e.dataTransfer.getData('application/x-konx-files');
      const row = e.target.closest('tr[data-k]');
      const rowEntry = row && this.entries.find((x) => x.name === row.dataset.k);
      const dest = rowEntry && rowEntry.isDir ? this.join(rowEntry.name) : this.cwd;
      if (raw) {
        const d = JSON.parse(raw);
        if (d.tab !== this.tab.id || d.side === this.side) return;
        this.other.transfer(d.paths, dest);
      } else if (e.dataTransfer.files.length && this.side === 'remote') {
        const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
        if (paths.length) this.tab.local.transfer(paths, dest);
      }
    });
  }

  onKey(e) {
    if (e.key === 'F5') {
      e.preventDefault();
      this.refresh();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      this.up();
    } else if (e.key === 'Enter') {
      const r = this.table.selectedRows()[0];
      if (r) this.activate(r);
    } else if (e.key === 'Delete') {
      this.remove(this.table.selectedRows());
    } else if (e.key === 'F2') {
      const r = this.table.selectedRows()[0];
      if (r) this.rename(r);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.table.selectAll();
    }
  }

  async newFolder() {
    const name = await promptText('New folder', 'Folder name');
    if (!name) return;
    try {
      if (this.side === 'local') await api.invoke('local:mkdir', this.join(name));
      else await api.invoke('sftp:mkdir', this.tab.sftpId, this.join(name));
      this.refresh();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async rename(r) {
    const name = await promptText('Rename', 'New name', r.name, 'Rename');
    if (!name || name === r.name) return;
    try {
      if (this.side === 'local') await api.invoke('local:rename', this.join(r.name), this.join(name));
      else await api.invoke('sftp:rename', this.tab.sftpId, this.join(r.name), this.join(name));
      this.refresh();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async remove(rows) {
    if (!rows.length) return;
    const what = rows.length === 1 ? `"${rows[0].name}"` : `${rows.length} items`;
    const ok = await confirmDialog(
      this.side === 'local' ? `Move ${what} to the Recycle Bin?` : `Permanently delete ${what} on the server?`,
      {
        title: 'Delete',
        okLabel: 'Delete',
        danger: this.side === 'remote',
        detail: this.side === 'remote' && rows.some((r) => r.isDir) ? 'Folders are deleted with everything inside them. This cannot be undone.' : null,
      }
    );
    if (!ok) return;
    try {
      const paths = rows.map((r) => this.join(r.name));
      if (this.side === 'local') await api.invoke('local:trash', paths);
      else await api.invoke('sftp:remove', this.tab.sftpId, paths);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
    this.refresh();
  }

  async chmod(rows) {
    const first = rows[0];
    const bits = ['Owner', 'Group', 'Others'];
    const perms = ['Read', 'Write', 'Execute'];
    const boxes = [];
    const octal = h('input.input.mono', { value: (first.mode & 0o777).toString(8).padStart(3, '0'), style: { width: '90px' } });
    const fromBoxes = () => {
      let m = 0;
      boxes.forEach((b, i) => b.checked && (m |= 1 << (8 - i)));
      octal.value = m.toString(8).padStart(3, '0');
    };
    const grid = h('div.grid3');
    bits.forEach((who, wi) => {
      grid.append(
        h('div.field', h('span', who), ...perms.map((p, pi) => {
          const cb = h('input', { type: 'checkbox', checked: !!(first.mode & (1 << (8 - (wi * 3 + pi)))), onchange: fromBoxes });
          boxes.push(cb);
          return h('label.check', cb, p);
        }))
      );
    });
    octal.addEventListener('input', () => {
      const m = parseInt(octal.value, 8);
      if (!isNaN(m)) boxes.forEach((b, i) => (b.checked = !!(m & (1 << (8 - i)))));
    });
    const r = await modal({
      title: `Permissions — ${rows.length === 1 ? first.name : rows.length + ' items'}`,
      icon: 'lock',
      body: [grid, h('label.field.inline', h('span', 'Octal'), octal)],
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Apply', value: true, primary: true },
      ],
    });
    if (!r) return;
    try {
      await api.invoke('sftp:chmod', this.tab.sftpId, rows.map((x) => this.join(x.name)), parseInt(octal.value, 8));
      this.refresh();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async openFile(r) {
    const p = this.join(r.name);
    try {
      if (this.side === 'local') await api.invoke('app:openPath', p);
      else {
        await api.invoke('sftp:edit', this.tab.sftpId, p);
        toast(`Editing ${r.name} — saves are uploaded automatically`, 'ok');
      }
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async openInNotepad(r) {
    const np = await this.tab.app.openNotepad();
    if (this.side === 'local') np.openFile(this.join(r.name));
    else np.openRemote(this.tab.sftpId, this.join(r.name), this.tab.info ? this.tab.info.title.replace(/^@/, '') : 'remote');
  }

  menu(e, rows) {
    const one = rows.length === 1 ? rows[0] : null;
    const local = this.side === 'local';
    contextMenu(e.clientX, e.clientY, [
      one && one.isDir && { label: 'Open', icon: 'folder-open', action: () => this.activate(one) },
      one && !one.isDir && { label: local ? 'Open in KonX Notepad' : 'Edit in KonX Notepad', icon: 'edit', action: () => this.openInNotepad(one) },
      one && !one.isDir && { label: local ? 'Open with default app' : 'Edit with default app', action: () => this.openFile(one) },
      rows.length && { label: local ? 'Upload' : 'Download', icon: local ? 'upload' : 'download', action: () => this.transfer(rows.map((r) => this.join(r.name))) },
      rows.length && '-',
      one && { label: 'Rename', shortcut: 'F2', action: () => this.rename(one) },
      !local && rows.length && { label: 'Permissions…', icon: 'lock', action: () => this.chmod(rows) },
      rows.length && { label: local ? 'Move to Recycle Bin' : 'Delete', icon: 'trash', danger: true, shortcut: 'Del', action: () => this.remove(rows) },
      rows.length && '-',
      one && { label: 'Copy Path', icon: 'copy', action: () => api.invoke('clipboard:write', this.join(one.name)) },
      local && one && { label: 'Show in Explorer', action: () => api.invoke('app:showItem', this.join(one.name)) },
      { label: 'New Folder', icon: 'folder', action: () => this.newFolder() },
      { label: 'Refresh', icon: 'refresh', shortcut: 'F5', action: () => this.refresh() },
      '-',
      ...workspaceCopilotItems(this.tab).filter(item => item.choice.startsWith(this.side + '-')),
    ].filter((x) => x !== 0 && x !== undefined && x !== null && x !== ''));
  }
}

class TransferPanel {
  constructor(tab) {
    this.tab = tab;
    this.jobs = new Map();
    this.collapsed = true;
    const policy = h(
      'select',
      { title: 'When the destination file already exists', onchange: (e) => tab.app.saveSettings({ sftpConflict: e.target.value }) },
      [['ask', 'If file exists: Ask'], ['overwrite', 'Overwrite'], ['skip', 'Skip'], ['newer', 'Overwrite if newer']].map(([v, l]) =>
        h('option', { value: v, selected: tab.app.settings.sftpConflict === v }, l)
      )
    );
    this.count = h('span.hint', '');
    this.table = new DataTable({
      columns: [
        { key: 'direction', label: '', width: 38, render: (j) => icon(j.direction === 'up' ? 'upload' : 'download'), sortable: false },
        { key: 'name', label: 'File', render: (j) => j.name },
        { key: 'dst', label: 'Destination', render: (j) => j.dst },
        { key: 'size', label: 'Size', width: 90, num: true, render: (j) => fmtBytes(j.size) },
        {
          key: 'pct', label: 'Progress', width: 160, sortable: false,
          render: (j) => {
            const pct = j.size ? Math.min(100, (j.done / j.size) * 100) : j.status === 'done' ? 100 : 0;
            return h('div.progress', { class: j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : '' }, h('div', { style: { width: pct + '%' } }));
          },
        },
        { key: 'speed', label: 'Speed', width: 90, num: true, render: (j) => (j.speed && j.status === 'running' ? fmtBytes(j.speed) + '/s' : '') },
        {
          key: 'status', label: 'Status', width: 110,
          render: (j) => h('span.pill', { class: { done: 'ok', error: 'err', running: 'warn', cancelled: 'muted', skipped: 'muted', queued: 'muted' }[j.status], title: j.error || '' }, j.status),
        },
      ],
      rowKey: (j) => j.id,
      emptyText: 'No transfers yet. Drag files between the panes, or double-click a file.',
      onContext: (e, rows) =>
        contextMenu(e.clientX, e.clientY, [
          { label: 'Cancel', icon: 'x', disabled: !rows.some((r) => r.status === 'queued' || r.status === 'running'), action: () => rows.forEach((r) => api.invoke('xfer:cancel', r.id)) },
          { label: 'Clear finished', action: () => this.clear() },
        ]),
    });
    this.table.defaultSort = (a, b) => b.id - a.id;
    this.el = h(
      'div.xfers.collapsed',
      h(
        'div.xfers-head',
        h('span.title', { onclick: () => this.toggle() }, icon('file-transfer'), 'Transfers'),
        this.count,
        h('span', { style: { flex: 1 } }),
        policy,
        h('button.btn.sm.ghost', { onclick: () => this.cancelAll() }, 'Cancel all'),
        h('button.btn.sm.ghost', { onclick: () => this.clear() }, 'Clear finished'),
        h('button.icon-btn', { onclick: () => this.toggle(), title: 'Show / hide' }, icon('chev-down'))
      ),
      this.table.el
    );
    this.renderSoon = debounce(() => this.render(), 100);
  }

  toggle() {
    this.collapsed = !this.collapsed;
    this.el.classList.toggle('collapsed', this.collapsed);
  }

  expand() {
    if (this.collapsed) this.toggle();
  }

  update(j) {
    if (this.tab.disposed) return;
    this.jobs.set(j.id, j);
    this.tab.copilot.touch();
    this.renderSoon();
  }

  render() {
    const all = [...this.jobs.values()];
    this.table.setRows(all);
    const active = all.filter((j) => j.status === 'running' || j.status === 'queued').length;
    this.count.textContent = active ? `${active} active` : all.length ? `${all.length} total` : '';
    this.tab.app.updateStatus(this.tab);
  }

  active() {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
  }

  cancelAll() {
    for (const j of this.jobs.values()) if (j.status === 'running' || j.status === 'queued') api.invoke('xfer:cancel', j.id);
  }

  clear() {
    for (const [k, j] of this.jobs) if (j.status !== 'running' && j.status !== 'queued') this.jobs.delete(k);
    api.invoke('xfer:clear');
    this.render();
    this.tab.copilot.touch();
  }
}

export class SftpTab {
  /** spec: {sessionId} | {fromConn} | inline session ; meta: {name} */
  constructor(app, spec, meta) {
    this.app = app;
    this.spec = spec;
    this.meta = meta;
    this.kind = 'sftp';
    this.id = `s${++seq}-${Date.now().toString(36)}`;
    this.sftpId = this.id;
    this.title = meta.name + ' (SFTP)';
    this.icon = 'file-transfer';
    this.state = 'connecting';
    this.disposed = false;
    this.connectionGeneration = 0;
    this.copilot = createWorkspaceEvidence(this, 'SFTP metadata');
    this.local = new FilePane(this, 'local');
    this.remote = new FilePane(this, 'remote');
    this.xfers = new TransferPanel(this);
    this.copilotButton = h('button.btn.sm', { type: 'button', 'aria-label': 'Choose SFTP evidence for KonX-AI', onclick: e => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom, workspaceCopilotItems(this)); } }, icon('insight'), 'Ask KonX-AI');
    this.el = h('div.view', h('div.tool-summary', this.copilotButton), h('div.sftp', h('div.sftp-panes', this.local.el, this.remote.el), this.xfers.el));
    this.refreshLocalSoon = debounce(() => this.local.refresh(), 300);
    this.refreshRemoteSoon = debounce(() => this.remote.refresh(), 300);
  }

  async connect() {
    if (this.disposed) return;
    const generation = ++this.connectionGeneration;
    this.copilot.begin(requestedConnectionMetadata(this), `${this.id}:connection:${generation}`);
    this.info = null;
    this.remote.navigationGeneration++;
    this.state = 'connecting';
    this.app.tabStateChanged(this);
    this.remote.ready = false;
    this.remote.setMessage([h('div', 'Connecting to ', h('b', this.meta.name), '…')]);
    if (!this.local.cwd) this.local.navigate(this.app.settings.sftpLocalDir || (await api.invoke('local:home')));
    if (this.disposed || generation !== this.connectionGeneration) return;
    try {
      const r = await api.invoke('sftp:open', this.sftpId, this.spec);
      if (this.disposed || generation !== this.connectionGeneration) return;
      this.home = r.home;
      this.remote.ready = true;
      this.remote.label.textContent = r.title;
      this.remote.setMessage(null);
      this.state = 'connected';
      this.info = r;
      await this.remote.navigate(this.remote.cwd || r.home);
    } catch (e) {
      if (this.disposed || generation !== this.connectionGeneration) return;
      this.onClosed(errMsg(e));
      return;
    }
    this.app.tabStateChanged(this);
  }

  copilotContextChoices() { return workspaceContextChoices(this); }

  captureCopilotContext(options) { return captureSftpContext(this, options); }

  onClosed(reason = 'Connection closed') {
    if (this.disposed) return;
    this.connectionGeneration++;
    this.remote.navigationGeneration++;
    if (this.remote.listingRequest?.state === 'running') recordListingRequest(this.remote, this.remote.listingRequest.path, 'stopped', reason);
    this.copilot.finish('stopped', reason);
    this.state = 'disconnected';
    this.remote.ready = false;
    this.remote.setMessage([
      h('div', reason),
      h('div', { style: { marginTop: '12px' } }, h('button.btn.primary', { onclick: () => this.connect() }, icon('refresh'), 'Reconnect')),
    ]);
    this.app.tabStateChanged(this);
  }

  onChanged(side, dir) {
    if (side === 'local' && dir === this.local.cwd) this.refreshLocalSoon();
    if (side === 'remote' && dir === this.remote.cwd) this.refreshRemoteSoon();
  }

  show() {
    this.active = true;
  }

  hide() {
    this.active = false;
  }

  focus() {
    this.remote.table.el.focus();
  }

  statusSegments() {
    const segs = [];
    const st = this.state === 'connected' ? ['ok', 'Connected'] : this.state === 'connecting' ? ['warn', 'Connecting'] : ['err', 'Disconnected'];
    segs.push({ icon: this.state === 'connected' ? 'plug' : 'unplug', text: st[1], cls: st[0] });
    segs.push({ text: 'SFTP' });
    if (this.info) segs.push({ text: this.info.title });
    const a = this.xfers.active();
    if (a) segs.push({ icon: 'file-transfer', text: `${a} transfer${a === 1 ? '' : 's'} active`, cls: 'warn' });
    return segs;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.connectionGeneration++; this.local.navigationGeneration++; this.remote.navigationGeneration++;
    this.copilot.finish('stopped');
    api.invoke('sftp:close', this.sftpId);
  }
}
