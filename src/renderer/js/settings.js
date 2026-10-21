// Global settings dialog, including the known-hosts manager.
import { h, api, modal, buildFields, DataTable, contextMenu, confirmDialog, fmtDate } from './ui.js';
import { SCHEMES, APP_THEMES } from './themes.js';
import { createUpdatesPane } from './updates.js';

export async function settingsDialog(app) {
  const s = app.settings;
  const appearance = buildFields([
    { name: 'uiTheme', label: 'Application theme', type: 'select', options: Object.entries(APP_THEMES).map(([k, v]) => [k, v.label]) },
    { name: 'colorScheme', label: 'Terminal color scheme', type: 'select', options: Object.entries(SCHEMES).map(([k, v]) => [k, v.label]), hint: 'Follow application theme adds matching colors and backgrounds. Saved session palettes take priority.' },
    { name: 'themeAnimations', label: 'Animate theme effects', type: 'checkbox', span: 2, hint: 'Use Pause effects in the header at any time. Windows reduced-motion preferences are respected.' },
    { name: 'fontFamily', label: 'Terminal font', span: 2 },
    { name: 'fontSize', label: 'Font size', type: 'number', min: 7, max: 36 },
    { name: 'cursorStyle', label: 'Cursor', type: 'select', options: [['block', 'Block'], ['underline', 'Underline'], ['bar', 'Bar']] },
    { name: 'cursorBlink', label: 'Blinking cursor', type: 'checkbox' },
  ], s);
  const terminal = buildFields([
    { name: 'scrollback', label: 'Scrollback lines', type: 'number', min: 100, max: 500000 },
    { name: 'rightClick', label: 'Right-click in terminal', type: 'select', options: [['menu', 'Show menu'], ['paste', 'Paste (PuTTY style)']] },
    { name: 'copyOnSelect', label: 'Copy on select', type: 'checkbox' },
    { name: 'confirmMultilinePaste', label: 'Confirm before pasting multiple lines', type: 'checkbox' },
    { name: 'useRemoteTitle', label: 'Let the remote host set the tab title', type: 'checkbox' },
    { name: 'logDir', label: 'Default log folder', browse: 'dir', placeholder: app.info.logDir, span: 2 },
  ], s);
  const transfer = buildFields([
    { name: 'sftpLocalDir', label: 'Default local folder', browse: 'dir', placeholder: '(home folder)', span: 2 },
    { name: 'sftpConflict', label: 'When a file already exists', type: 'select', options: [['ask', 'Ask'], ['overwrite', 'Overwrite'], ['skip', 'Skip'], ['newer', 'Overwrite if source is newer']] },
    { name: 'sftpConcurrency', label: 'Simultaneous transfers', type: 'number', min: 1, max: 8 },
    { name: 'sftpShowHidden', label: 'Show hidden files', type: 'checkbox' },
  ], s);

  const hosts = new DataTable({
    columns: [
      { key: 'host', label: 'Host', width: 200, mono: true },
      { key: 'keyType', label: 'Key type', width: 140 },
      { key: 'fingerprint', label: 'Fingerprint', mono: true },
      { key: 'added', label: 'Added', width: 130, render: (r) => fmtDate(Date.parse(r.added)) },
    ],
    rowKey: (r) => r.host,
    emptyText: 'No saved host keys yet.',
    onContext: (e, rows) =>
      contextMenu(e.clientX, e.clientY, [
        { label: 'Remove', icon: 'trash', danger: true, disabled: !rows.length, action: async () => {
          if (!(await confirmDialog(`Forget ${rows.length} host key(s)? You will be asked to verify them again on the next connection.`, { danger: true, okLabel: 'Remove' }))) return;
          for (const r of rows) await api.invoke('hostkeys:delete', r.host);
          hosts.setRows(await api.invoke('hostkeys:list'));
        } },
      ]),
  });
  hosts.el.style.height = '300px';
  hosts.setRows(await api.invoke('hostkeys:list'));

  const readSettings = () => JSON.stringify({ ...appearance.read(), ...terminal.read(), ...transfer.read() });
  const initialSettings = readSettings();
  let settingsOpen = true;
  const updates = createUpdatesPane(app, { blockers: () => settingsOpen && readSettings() !== initialSettings ? ['Save or cancel your Settings changes.'] : [] });
  const panes = {
    Appearance: h('div.mpane.active', h('div.grid2', appearance.els)),
    Terminal: h('div.mpane', h('div.grid2', terminal.els)),
    'File Transfer': h('div.mpane', h('div.grid2', transfer.els)),
    'Known Hosts': h('div.mpane', h('div.hint', 'SSH host keys you have accepted. Right-click to remove one.'), hosts.el),
    Updates: updates.el,
  };
  const btns = Object.keys(panes).map((name, i) =>
    h('button', { type: 'button', class: i === 0 ? 'active' : '', onclick: (e) => {
      Object.values(panes).forEach((p) => p.classList.remove('active'));
      btns.forEach((b) => b.classList.remove('active'));
      panes[name].classList.add('active');
      e.currentTarget.classList.add('active');
    } }, name)
  );
  const r = await modal({
    title: 'Settings',
    icon: 'settings',
    width: 680,
    body: [h('div.mtabs', btns), ...Object.values(panes)],
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', value: true, primary: true },
    ],
  }).finally(() => { settingsOpen = false; updates.dispose(); });
  if (!r) return;
  const patch = { ...appearance.read(), ...terminal.read(), ...transfer.read() };
  patch.fontSize = Number(patch.fontSize) || 14;
  patch.scrollback = Number(patch.scrollback) || 10000;
  patch.sftpConcurrency = Math.min(8, Math.max(1, Number(patch.sftpConcurrency) || 2));
  await app.saveSettings(patch);
}
