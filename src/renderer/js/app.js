// Application shell: toolbar, sidebar, tabs, button bar, command window, status bar.
import { h, icon, api, modal, formDialog, contextMenu, toast, errMsg, fmtBytes, fmtDate, promptText } from './ui.js';
import { TerminalTab } from './terminal.js';
import { SftpTab } from './sftp.js';
import { SessionTree, editSessionDialog } from './sessions.js';
import { TOOLS, createTool, hostMenuItems } from './tools.js';
import { settingsDialog } from './settings.js';
import { NotepadTab } from './notepad/notepad.js';
import { toolContext } from './tool-context.mjs';
import { applyApplicationTheme } from './theme-effects.js';
import { updateKonx } from './updates.js';
import { incidentEvidence } from './incident-evidence.mjs';
import { WorkspaceLayout } from './workspace-layout.js';
import { WorkspacePopouts } from './workspace-popouts.js';
import { supportDialog } from './support.js';

const RECENT_KEY = 'konx.recent';

function unescapeSend(s) {
  return String(s).replace(/\\(r|n|t|e|\\|x[0-9a-fA-F]{2})/g, (_, c) =>
    c === 'r' ? '\r' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'e' ? '\x1b' : c === '\\' ? '\\' : String.fromCharCode(parseInt(c.slice(1), 16))
  );
}

const quickBaud = (value, fallback = 9600) => {
  const text = String(value ?? '').trim();
  return text === '' ? fallback : text.toLowerCase() === 'auto' ? 'auto' : Number(text);
};
const validQuickBaud = value => value === 'auto' || (Number.isSafeInteger(value) && value > 0);

/** "user@host:port", "ssh://user@host:2222", "telnet://10.0.0.1", "COM3@auto" */
export function parseQuick(text, defaultProto = 'ssh') {
  let t = text.trim();
  let protocol = defaultProto;
  const scheme = t.match(/^(ssh|telnet|raw|serial|sftp):\/\//i);
  if (scheme) {
    protocol = scheme[1].toLowerCase();
    t = t.slice(scheme[0].length);
  }
  const serial = t.match(/^(COM\d+|\/dev\/[^@:,\s]+)(?:[@:,](.*))?$/i);
  if (serial || protocol === 'serial') {
    const [port, baud] = serial ? serial.slice(1) : t.split(/[@:,]/);
    return { protocol: 'serial', serialPort: port.toUpperCase().startsWith('COM') ? port.toUpperCase() : port, baudRate: quickBaud(baud) };
  }
  let username = '';
  const at = t.lastIndexOf('@');
  if (at > 0) {
    username = t.slice(0, at);
    t = t.slice(at + 1);
  }
  let host = t;
  let port;
  const v6 = t.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    port = v6[2];
  } else if ((t.match(/:/g) || []).length === 1) {
    [host, port] = t.split(':');
  }
  return { protocol, host, port: Number(port) || (protocol === 'telnet' || protocol === 'raw' ? 23 : 22), username };
}

class WelcomeTab {
  constructor(app) {
    this.app = app;
    this.kind = 'welcome';
    this.id = 'welcome';
    this.title = 'Home';
    this.icon = 'home';
    this.state = 'idle';
    this.disposed = false;
    this.el = h('div.view');
    this.render();
  }

  render() {
    const app = this.app;
    const proto = h('select.input', [['ssh', 'SSH2'], ['sftp', 'SFTP'], ['telnet', 'Telnet'], ['raw', 'Raw TCP'], ['serial', 'Serial']].map(([v, l]) => h('option', { value: v }, l)));
    const host = h('input.input', { placeholder: 'Hostname, IP or COM port', spellcheck: false });
    const port = h('input.input', { name: 'quickPort', 'aria-label': 'Quick connect port', placeholder: '22', type: 'number' });
    const portLabel = h('span', 'Port');
    const serialProbe = h('input', { type: 'checkbox', name: 'quickSerialAutoBaudProbe', 'aria-label': 'Send Enter while detecting' });
    const serialProbeField = h('label.check.hidden', serialProbe, 'Send Enter while detecting');
    const user = h('input.input', { name: 'quickUsername', 'aria-label': 'Quick connect username', placeholder: 'Username (optional)', spellcheck: false, autocomplete: 'off' });
    const password = h('input.input', { name: 'quickPassword', 'aria-label': 'Quick connect password', type: 'password', placeholder: 'Password (optional)', autocomplete: 'off' });
    const remember = h('input', { name: 'saveQuickSession', 'aria-label': 'Save session and remember login', type: 'checkbox' });
    const userField = h('label.field', h('span', 'Username'), user);
    const passwordField = h('label.field', h('span', 'Password'), password);
    const rememberField = h('label.check.qc-remember', remember, 'Save session and remember login');
    const hint = h('div.hint.qc-hint');
    const error = h('div.qc-error.errbox.hidden', { role: 'alert' });
    let busy = false, revision = 0, savedAttempt = null;
    this.clearQuickPassword = () => { password.value = ''; };
    const target = () => {
      const parsed = parseQuick(host.value, proto.value);
      if (parsed.protocol === 'serial') {
        const baudRate = quickBaud(port.value, parsed.baudRate);
        return { ...parsed, baudRate, serialAutoBaudProbe: baudRate === 'auto' && serialProbe.checked };
      }
      return { ...parsed, ...(port.value ? { port: Number(port.value) } : {}) };
    };
    const sync = () => {
      const parsed = target(), protocol = parsed.protocol;
      const login = ['ssh', 'telnet', 'sftp'].includes(protocol);
      port.type = protocol === 'serial' ? 'text' : 'number';
      port.placeholder = protocol === 'serial' ? '9600 or auto' : protocol === 'telnet' || protocol === 'raw' ? '23' : '22';
      portLabel.textContent = protocol === 'serial' ? 'Baud rate' : 'Port';
      port.setAttribute('aria-label', protocol === 'serial' ? 'Quick connect baud rate' : 'Quick connect port');
      const automatic = protocol === 'serial' && parsed.baudRate === 'auto';
      serialProbeField.classList.toggle('hidden', !automatic);
      serialProbe.disabled = busy || !automatic;
      if (!login) { user.value = ''; password.value = ''; remember.checked = false; }
      if (app.info.encryption !== true) remember.checked = false;
      userField.classList.toggle('hidden', !login);
      passwordField.classList.toggle('hidden', !login);
      rememberField.classList.toggle('hidden', !login);
      user.disabled = password.disabled = busy || !login;
      remember.disabled = busy || !login || app.info.encryption !== true;
      for (const control of [proto, host, port, connect]) control.disabled = busy;
      connect.textContent = busy ? 'Saving session…' : remember.checked ? 'Save & connect' : 'Connect';
      hint.textContent = automatic ? 'Auto detect needs device output. Enter probes are optional. Only baud is detected; other serial settings stay at their defaults. You can cancel while detecting.'
        : protocol === 'serial' ? 'Use a baud rate or auto. Auto detect listens for readable output; saved sessions offer data, parity, stop-bit and flow-control options.'
        : !login ? 'This protocol does not use a username or password.'
        : app.info.encryption !== true ? 'Connect once. Saving login is unavailable because secure encryption is unavailable.'
        : remember.checked ? 'Creates a saved session with this username and an encrypted password on this computer. Passwords entered in later login prompts are not saved.'
        : 'Connect once without saving. Check the box to keep this login in Sessions.';
    };
    const go = async () => {
      if (busy || this.disposed) return;
      if (!host.value.trim()) return host.focus();
      const parsed = target();
      if (parsed.protocol === 'serial' && !validQuickBaud(parsed.baudRate)) {
        error.textContent = 'Enter a positive numeric baud rate or auto.';
        error.classList.remove('hidden'); port.focus(); return;
      }
      if (parsed.protocol !== 'serial' && !parsed.host) return host.focus();
      const login = ['ssh', 'telnet', 'sftp'].includes(parsed.protocol);
      const q = { ...parsed, ...(login && user.value.trim() ? { username: user.value.trim() } : {}), ...(login && password.value ? { password: password.value } : {}) };
      const save = login && remember.checked && app.info.encryption === true;
      const attemptRevision = revision;
      busy = true; error.classList.add('hidden'); sync();
      try {
        if (!save) {
          app.quickConnect(q);
          password.value = '';
          return;
        }
        // A completed save owns its ID even if refreshing the list fails. A
        // retry of unchanged form values reconnects that record, not a duplicate.
        if (savedAttempt?.revision !== attemptRevision) {
          const saved = await api.invoke('sessions:save', { ...q, protocol: q.protocol === 'sftp' ? 'ssh' : q.protocol, auth: 'password', name: q.host });
          savedAttempt = { revision: attemptRevision, session: saved };
          password.value = '';
        }
        await app.sessions.load();
        if (this.disposed) {
          toast('Session saved after Home closed. Open it from Sessions.', 'ok');
          return;
        }
        const saved = savedAttempt.session;
        app.sessions.selected = 's:' + saved.id;
        app.sessions.render();
        if (q.protocol === 'sftp') {
          app.rememberRecent(saved.id);
          app.openSftp({ sessionId: saved.id }, { name: saved.name || saved.host });
        } else app.connectSession(saved);
        savedAttempt = null;
        password.value = '';
      } catch (failure) {
        const message = savedAttempt?.revision === attemptRevision
          ? 'Session was saved, but could not be opened. Retry to use the saved session: ' + errMsg(failure)
          : (save ? 'Session was not saved: ' : 'Could not connect: ') + errMsg(failure);
        if (this.disposed) toast(message, 'err');
        else { error.textContent = message; error.classList.remove('hidden'); }
      } finally {
        busy = false;
        if (!this.disposed) sync();
      }
    };
    const connect = h('button.btn.primary', { type: 'button', 'data-action': 'quick-connect', onclick: go }, 'Connect');
    for (const control of [proto, host, port, user, password, remember, serialProbe]) {
      control.addEventListener(control === proto || control.type === 'checkbox' ? 'change' : 'input', () => { revision++; savedAttempt = null; sync(); });
    }
    for (const control of [host, port, user, password]) control.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void go(); } });
    sync();
    this.recentContent = h('div.welcome-recent-content');
    this.recentHost = h('section.welcome-recent', { 'aria-label': 'Recent sessions' },
      h('div.welcome-recent-head', h('h3', 'Recent sessions'),
        h('button.btn.sm', { type: 'button', 'data-action': 'clear-recent-sessions', title: 'Clear connection history; keep saved sessions and open connections.', onclick: () => app.clearRecentSessions() }, icon('trash'), 'Clear recent sessions')),
      this.recentContent);
    this.el.replaceChildren(
      h(
        'div.welcome',
        h('h1', h('img', { src: '../../assets/logo.svg', alt: '' }), app.info.name),
        h('p.lead', 'Terminal, file transfer and network toolkit — SSH2, Telnet, Serial, SFTP, ping, sweep, port scan and more in one window.'),
        h('div.welcome-update', h('span.hint', `KonX ${app.info.version || ''}`), h('button.btn.sm', { onclick: () => updateKonx(app) }, icon('download'), 'Update KonX'),
          h('button.btn.sm', { onclick: () => supportDialog(app) }, icon('info'), 'Report a problem')),
        h('h3', 'Quick connect'),
        h(
          'div.qc-form',
          h('label.field', h('span', 'Protocol'), proto),
          h('label.field', h('span', 'Host'), host),
          h('label.field', portLabel, port),
          userField, passwordField,
          h('div.qc-actions', rememberField, serialProbeField, connect),
          hint, error
        ),
        this.recentHost,
        h('h3', 'Sessions'),
        h('div.cards',
          h('div.card', { onclick: () => app.editSession() }, h('div.ic', icon('plus')), h('div', h('div.t', 'New session'), h('div.d', 'Save a host with credentials, jump host, forwards and logon actions'))),
          h('div.card', { onclick: () => app.sessions.import('securecrt') }, h('div.ic', icon('import')), h('div', h('div.t', 'Import from SecureCRT'), h('div.d', 'Bring over your existing session folders'))),
          h('div.card', { onclick: () => app.sessions.import('sshconfig') }, h('div.ic', icon('import')), h('div', h('div.t', 'Import ~/.ssh/config'), h('div.d', 'Host, user, port, key and ProxyJump entries'))),
          h('div.card', { onclick: () => app.openNotepad() }, h('div.ic', icon('edit')), h('div', h('div.t', 'Notepad'), h('div.d', 'Notepad++-style editor with config highlighting, compare, Find in Files and Send to terminal')))
        ),
        h('h3', 'Network tools'),
        h('div.cards', TOOLS.map((t) => h('div.card', { onclick: () => app.openTool(t.kind) }, h('div.ic', icon(t.icon)), h('div', h('div.t', t.label), h('div.d', t.desc))))),
        h('h3', 'Keyboard'),
        h('div.hint', { style: { lineHeight: '1.9' } },
          'Alt+Q quick connect · Alt+1…9 switch tab · Ctrl+Tab next tab · Ctrl+Shift+W close tab · Ctrl+Shift+C / V copy & paste · Ctrl+Shift+F find · Ctrl+= / Ctrl+- zoom · F12 developer tools')
      )
    );
    this.renderRecent();
  }

  renderRecent() {
    const app = this.app, recent = app.recentSessions();
    this.recentContent.replaceChildren(
      recent.length
        ? h('div.cards', recent.map((s) => h('button.card', { type: 'button', onclick: () => app.connectSession(s) },
            h('div.ic', icon(s.protocol === 'serial' ? 'usb' : 'server')),
            h('div', h('div.t', s.name || s.host), h('div.d', s.protocol === 'serial' ? `${s.serialPort} · ${s.baudRate}` : `${s.username ? s.username + '@' : ''}${s.host}:${s.port || 22}`)))))
        : h('p.hint', 'No recent sessions.')
    );
  }

  show() {
    this.active = true;
    this.renderRecent();
  }
  hide() {
    this.active = false;
  }
  focus() {}
  statusSegments() {
    return [{ icon: 'home', text: 'Home' }];
  }
  dispose() {
    this.disposed = true;
    this.clearQuickPassword?.();
  }
}

class App {
  async init() {
    this.info = await api.invoke('app:info');
    this.settings = await api.invoke('settings:get');
    this.motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    this.motionPreference.addEventListener('change', () => this.updateThemeHeader());
    document.addEventListener('visibilitychange', () => {
      document.documentElement.dataset.themeVisible = String(!document.hidden);
    });
    this.presets = await api.invoke('tools:presets');
    document.title = this.info.name;
    this.applyTheme();
    this.tabs = [];
    this.byId = new Map();
    this.jobs = new Map();
    this.active = null;
    this.cmdHistory = [];
    this.buildLayout();
    this.popouts = new WorkspacePopouts(this);
    this.workspaceLayout = new WorkspaceLayout(this);
    this.sessions = new SessionTree(this);
    this.sideSessions.replaceWith(this.sessions.el);
    await this.sessions.load();
    this.bindEvents();
    this.addTab(new WelcomeTab(this));
    window.__app = this;
  }

  applyTheme() {
    this.theme = applyApplicationTheme(this.settings);
    document.documentElement.style.setProperty('--sidebar-w', (this.settings.sidebarWidth || 260) + 'px');
    this.updateThemeHeader();
    this.popouts?.updateTheme();
  }

  updateThemeHeader() {
    if (!this.themeHeader) return;
    this.themeHeader.classList.toggle('hidden', !this.theme.animated);
    this.themeName.textContent = this.theme.label;
    const reduced = this.motionPreference.matches;
    const paused = this.settings.themeAnimations === false;
    const label = reduced ? 'Reduced motion' : paused ? 'Resume effects' : 'Pause effects';
    this.themeMotion.textContent = label;
    this.themeMotion.disabled = reduced || !!this.savingThemeMotion;
    this.themeMotion.setAttribute('aria-label', label + ' for ' + this.theme.label);
    this.themeMotion.setAttribute('aria-pressed', String(paused || reduced));
    this.themeMotion.title = reduced ? 'Animations are disabled by your Windows reduced-motion preference.' : label;
  }

  // ------------------------------------------------------------ layout

  buildLayout() {
    this.quickProto = h('select.input.quick-proto', { 'aria-label': 'Quick connect protocol' }, [['ssh', 'SSH'], ['telnet', 'Telnet'], ['raw', 'Raw'], ['serial', 'Serial']].map(([v, l]) => h('option', { value: v }, l)));
    this.quickInput = h('input.input.quick-host', { placeholder: 'Quick connect: user@host:port', 'aria-label': 'Quick connect address', spellcheck: false });
    this.quickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.quickInput.value.trim()) {
        const q = parseQuick(this.quickInput.value, this.quickProto.value);
        this.quickConnect(q);
        this.quickInput.value = '';
      } else if (e.key === 'Escape') {
        this.quickInput.blur();
      }
    });
    const toolsBtn = h('button.tb-btn', { onclick: (e) => this.toolsMenu(e) }, icon('wifi'), 'Network Tools', icon('chev-down'));
    this.buttonBarToggle = h('button.tb-btn.icon-only', { 'aria-controls': 'buttonbar', onclick: () => this.toggle('buttonbar') }, icon('button-bar'));
    this.themeName = h('span.theme-header-name');
    this.themeMotion = h('button.theme-motion-toggle', { type: 'button', onclick: async () => {
      this.savingThemeMotion = true;
      this.updateThemeHeader();
      try { await this.saveSettings({ themeAnimations: this.settings.themeAnimations === false }); }
      catch (error) { toast(errMsg(error)); }
      finally { this.savingThemeMotion = false; this.updateThemeHeader(); }
    } });
    this.themeHeader = h('div.theme-header.hidden', this.themeName, this.themeMotion);
    this.toolbar = h(
      'div#toolbar',
      h('div.brand', h('img.logo', { src: '../../assets/logo.svg', alt: '' }), this.info.name),
      h('button.tb-btn.icon-only', { title: 'Toggle session manager', onclick: () => this.toggleSidebar() }, icon('sidebar')),
      h('div.tb-sep'),
      h('div.quick', icon('zap'), this.quickProto, this.quickInput),
      h('button.tb-btn', { onclick: () => this.editSession() }, icon('plus'), 'New Session'),
      h('button.tb-btn', { title: 'Open an SFTP tab for the current SSH tab or a saved session', onclick: () => this.sftpForActive() }, icon('file-transfer'), 'SFTP'),
      h('button.tb-btn', { title: 'Notepad++-style editor', onclick: () => this.openNotepad() }, icon('edit'), 'Notepad'),
      toolsBtn,
      h('div.tb-spacer'),
      this.themeHeader,
      this.buttonBarToggle,
      h('button.tb-btn.icon-only', { title: 'Command window (send to one or all tabs)', onclick: () => this.toggle('cmdwin') }, icon('command')),
      h('button.tb-btn.icon-only', { title: 'Home', onclick: () => this.showHome() }, icon('home')),
      h('button.tb-btn.icon-only', { title: 'Settings', onclick: () => settingsDialog(this) }, icon('settings'))
    );

    this.sideSessions = h('div');
    const toolList = h('div.tool-list', TOOLS.map((t) => h('div.tool-item', { onclick: () => this.openTool(t.kind) }, icon(t.icon), t.label)));
    const resizer = h('div.resizer');
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const move = (ev) => {
        const w = Math.max(180, Math.min(520, ev.clientX));
        document.documentElement.style.setProperty('--sidebar-w', w + 'px');
        this.settings.sidebarWidth = w;
        this.scheduleTabLayout(true);
        this.workspaceLayout?.refit();
      };
      const up = () => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        api.invoke('settings:set', { sidebarWidth: this.settings.sidebarWidth });
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    this.sidebar = h('div#sidebar', this.sideSessions, h('div.side-section.side-tools', h('div.side-head', h('span.title', 'Network Tools')), toolList), resizer);

    this.tabbar = h('div#tabbar');
    this.tabScrollLeft = h('button.tb-btn.icon-only.tab-nav', { title: 'Scroll tabs left', 'aria-label': 'Scroll tabs left', onclick: () => this.scrollTabs(-1) }, icon('chev-left'));
    this.tabScrollRight = h('button.tb-btn.icon-only.tab-nav', { title: 'Scroll tabs right', 'aria-label': 'Scroll tabs right', onclick: () => this.scrollTabs(1) }, icon('chev-right'));
    const allTabs = h('button.tb-btn.icon-only.tab-nav', { title: 'Show all tabs', 'aria-label': 'Show all tabs', 'aria-haspopup': 'menu', onclick: (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      contextMenu(rect.left, rect.bottom, this.tabs.map((tab) => ({
        label: tab.title, icon: tab === this.active ? 'check' : tab.icon,
        action: () => this.activate(tab),
      })));
    } }, icon('chev-down'));
    this.tabControls = h('div.tab-controls.hidden', this.tabScrollLeft, this.tabScrollRight, allTabs);
    this.tabstrip = h('div#tabstrip', this.tabbar, this.tabControls);
    this.tabbar.addEventListener('scroll', () => this.updateTabNavigation(), { passive: true });
    this.tabbar.addEventListener('wheel', (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || this.tabbar.scrollWidth <= this.tabbar.clientWidth) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? this.tabbar.clientWidth : 1;
      this.tabbar.scrollLeft += e.deltaY * unit;
    }, { passive: false });
    this.views = h('div#views');
    this.buttonbar = h('div#buttonbar', { class: this.settings.showButtonBar === false ? 'hidden' : '' });
    this.updateButtonBarToggle();
    this.renderButtonBar();
    this.cmdInput = h('input', { type: 'text', placeholder: 'Command window — type a command and press Enter to send it', spellcheck: false });
    this.cmdAll = h('input', { type: 'checkbox' });
    this.cmdAll.addEventListener('change', () => this.workspaceLayout?.updateContext());
    this.cmdInput.addEventListener('keydown', (e) => this.onCmdKey(e));
    this.cmdTarget = h('span.workspace-command-target');
    this.cmdwin = h('div#cmdwin.hidden', icon('command'), this.cmdInput, this.cmdTarget, h('label', this.cmdAll, 'Send to all terminal tabs'));
    this.main = h('div#main', this.tabstrip, this.views, this.buttonbar, this.cmdwin);
    this.status = h('div#statusbar');
    this.root = h('div#app', this.toolbar, this.sidebar, this.main, this.status);
    document.body.append(this.root);
    this.updateThemeHeader();
    this.tabResizeObserver = new ResizeObserver(() => this.scheduleTabLayout(true));
    this.tabResizeObserver.observe(this.tabstrip);
  }

  toggleSidebar() {
    this.root.classList.toggle('no-sidebar');
    this.scheduleTabLayout(true);
    this.workspaceLayout?.refresh();
  }

  toggle(which) {
    const el = which === 'buttonbar' ? this.buttonbar : this.cmdwin;
    el.classList.toggle('hidden');
    if (which === 'buttonbar') {
      this.settings.showButtonBar = !el.classList.contains('hidden');
      this.updateButtonBarToggle();
      api.invoke('settings:set', { showButtonBar: this.settings.showButtonBar });
    }
    if (which === 'cmdwin' && !el.classList.contains('hidden')) this.cmdInput.focus();
    this.workspaceLayout?.refit();
  }

  updateButtonBarToggle() {
    const shown = !this.buttonbar.classList.contains('hidden');
    const label = `${shown ? 'Hide' : 'Show'} button bar`;
    this.buttonBarToggle.title = label;
    this.buttonBarToggle.setAttribute('aria-label', label);
    this.buttonBarToggle.setAttribute('aria-pressed', String(shown));
  }

  toolsMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, TOOLS.map((t) => ({ label: t.label, icon: t.icon, action: () => this.openTool(t.kind) })));
  }

  // ------------------------------------------------------------ button bar

  renderButtonBar() {
    const buttons = this.settings.buttons || [];
    this.buttonbar.replaceChildren(
      ...buttons.map((b, i) => {
        const el = h('button.bb', { title: `Sends: ${b.send}\nCtrl+click: send to all tabs · right-click to edit` }, b.label);
        el.addEventListener('click', (e) => this.sendToTerminals(unescapeSend(b.send), e.ctrlKey));
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Edit…', icon: 'edit', action: () => this.editButton(i) },
            { label: 'Move left', disabled: i === 0, action: () => this.moveButton(i, -1) },
            { label: 'Move right', disabled: i === buttons.length - 1, action: () => this.moveButton(i, 1) },
            '-',
            { label: 'Delete', icon: 'trash', danger: true, action: () => this.saveButtons(buttons.filter((_, j) => j !== i)) },
          ]);
        });
        return el;
      }),
      h('button.bb.add', { title: 'Add button', onclick: () => this.editButton(-1) }, icon('plus'))
    );
  }

  async editButton(i) {
    const buttons = [...(this.settings.buttons || [])];
    const cur = buttons[i] || { label: '', send: '\\r' };
    const r = await formDialog({
      title: i < 0 ? 'New button' : 'Edit button',
      icon: 'more',
      fields: [
        { name: 'label', label: 'Label', value: cur.label },
        { name: 'send', label: 'Send', value: cur.send, hint: 'Escapes: \\r Enter, \\n newline, \\t tab, \\e Escape, \\x03 Ctrl+C. Add \\r at the end to run the command.' },
      ],
    });
    if (!r || !r.label) return;
    if (i < 0) buttons.push(r);
    else buttons[i] = r;
    this.saveButtons(buttons);
  }

  moveButton(i, d) {
    const b = [...this.settings.buttons];
    [b[i], b[i + d]] = [b[i + d], b[i]];
    this.saveButtons(b);
  }

  async saveButtons(buttons) {
    await this.saveSettings({ buttons });
  }

  sendToTerminals(text, all) {
    const targets = all ? this.tabs.filter((t) => t.kind === 'terminal' && t.state === 'connected') : this.active?.kind === 'terminal' && this.active.state === 'connected' ? [this.active] : [];
    if (!targets.length) return toast('No connected terminal tab');
    targets.forEach((t) => t.sendText(text));
    if (!all && this.active.focus) this.active.focus();
  }

  onCmdKey(e) {
    if (e.key === 'Enter') {
      const v = this.cmdInput.value;
      this.sendToTerminals(v + '\r', this.cmdAll.checked);
      if (v) this.cmdHistory.push(v);
      this.histPos = this.cmdHistory.length;
      this.cmdInput.value = '';
      this.cmdInput.focus();
    } else if (e.key === 'ArrowUp' && this.cmdHistory.length) {
      this.histPos = Math.max(0, (this.histPos ?? this.cmdHistory.length) - 1);
      this.cmdInput.value = this.cmdHistory[this.histPos];
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      this.histPos = Math.min(this.cmdHistory.length, (this.histPos ?? 0) + 1);
      this.cmdInput.value = this.cmdHistory[this.histPos] || '';
      e.preventDefault();
    }
  }

  // ------------------------------------------------------------ tabs

  addTab(tab) {
    this.tabs.push(tab);
    this.byId.set(tab.id, tab);
    if (tab.sftpId) this.byId.set(tab.sftpId, tab);
    this.workspaceLayout.mount(tab);
    this.renderTabs();
    this.activate(tab);
    return tab;
  }

  activate(tab, { focus = true } = {}) {
    if (!tab || !this.tabs.includes(tab)) return;
    this.workspaceLayout.cancelFocus();
    this.active = tab;
    tab.activity = false;
    this.workspaceLayout.activate(tab);
    this.renderTabs(true);
    this.updateStatus(tab);
    if (focus) {
      this.popouts.focus(tab);
      this.workspaceLayout.focusTarget(tab);
    }
  }

  async closeTab(tab) {
    if (tab.requestClose && !(await tab.requestClose())) return;
    if (tab.kind === 'sftp' && tab.xfers.active()) {
      const ok = await modal({ title: 'Transfers in progress', body: h('div.message', 'Closing this tab cancels the remaining transfers.'), buttons: [{ label: 'Cancel', value: null }, { label: 'Close tab', value: true, danger: true }] });
      if (!ok) return;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.workspaceLayout.detach(tab);
    this.tabs.splice(i, 1);
    this.byId.delete(tab.id);
    tab.el.remove();
    tab.dispose();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next);
      else this.addTab(new WelcomeTab(this));
    }
    this.renderTabs(true);
  }

  scrollTabs(direction) {
    this.tabbar.scrollBy({ left: direction * Math.max(120, this.tabbar.clientWidth * 0.7), behavior: 'smooth' });
  }

  updateTabNavigation() {
    this.tabScrollLeft.disabled = this.tabbar.scrollLeft <= 1;
    this.tabScrollRight.disabled = this.tabbar.scrollLeft + this.tabbar.clientWidth >= this.tabbar.scrollWidth - 1;
  }

  scheduleTabLayout(revealActive = false) {
    this.tabRevealPending ||= revealActive;
    if (this.tabLayoutFrame) return;
    this.tabLayoutFrame = requestAnimationFrame(() => {
      this.tabLayoutFrame = 0;
      // Compare with the entire strip so controls disappear once all tabs fit.
      this.tabControls.classList.toggle('hidden', this.tabbar.scrollWidth <= this.tabstrip.clientWidth + 1);
      if (this.tabRevealPending) {
        const selected = this.tabbar.children[this.tabs.indexOf(this.active)];
        if (selected) {
          const viewport = this.tabbar.getBoundingClientRect();
          const tab = selected.getBoundingClientRect();
          if (tab.left < viewport.left) this.tabbar.scrollLeft += tab.left - viewport.left;
          else if (tab.right > viewport.right) this.tabbar.scrollLeft += tab.right - viewport.right;
        }
      }
      this.tabRevealPending = false;
      this.updateTabNavigation();
    });
  }

  renderTabs(revealActive = false) {
    const scrollLeft = this.tabbar.scrollLeft;
    const live = new Set(this.tabs.map(t => t.tabElement).filter(Boolean));
    for (const node of [...this.tabbar.children]) if (!live.has(node)) node.remove();
    this.tabs.forEach((t, i) => {
        const dotCls = t.kind === 'terminal' || t.kind === 'sftp' ? t.state : t.state === 'running' ? 'connecting' : '';
        let el = t.tabElement;
        if (!el) {
          el = t.tabElement = h(
          'div.tab',
          { draggable: true, 'data-tab-id': t.id },
          t.kind === 'terminal' || t.kind === 'sftp' ? h('span.dot', { class: dotCls + (t.activity ? ' activity' : '') }) : h('span.ticon', icon(t.icon)),
          h('span.title', t.title),
          h('button.close', { title: 'Close (Ctrl+Shift+W)', onclick: (e) => (e.stopPropagation(), this.closeTab(t)) }, icon('x'))
        );
        el.addEventListener('mousedown', (e) => {
          el.konxWasDragged = false;
          if (e.button === 0 && !e.target.closest('button.close')) this.activate(t, { focus: false });
          if (e.button === 1) {
            e.preventDefault();
            this.closeTab(t);
          }
        });
        el.addEventListener('click', e => {
          if (!el.konxWasDragged && !e.target.closest('button.close')) this.activate(t);
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.tabMenu(e.clientX, e.clientY, t);
        });
        this.bindTabDrag(el, t);
        el.addEventListener('dragover', (e) => e.dataTransfer.types.includes('text/x-konx-tab') && e.preventDefault());
        el.addEventListener('drop', (e) => {
          const id = e.dataTransfer.getData('text/x-konx-tab');
          const from = this.tabs.findIndex(tab => tab.id === id), target = this.tabs.indexOf(t);
          if (from < 0 || target < 0 || from === target) return;
          e.preventDefault(); e.stopPropagation();
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(target, 0, moved);
          this.renderTabs(true);
        });
        }
        const placement = this.workspaceLayout?.placement?.(t) || 'docked';
        el.classList.toggle('active', t === this.active);
        el.dataset.placement = placement;
        el.title = t.title + (placement === 'external' ? ' — popped out' : placement === 'floating' ? ' — floating' : '');
        el.querySelector('.title').textContent = t.title;
        const dot = el.querySelector('.dot');
        if (dot) dot.className = 'dot ' + dotCls + (t.activity ? ' activity' : '');
        if (this.tabbar.children[i] !== el) this.tabbar.insertBefore(el, this.tabbar.children[i] || null);
      });
    // Background activity and title updates must not undo manual tab scrolling.
    this.tabbar.scrollLeft = scrollLeft;
    this.scheduleTabLayout(revealActive);
    this.workspaceLayout?.refresh();
    this.popouts?.refresh();
  }

  bindTabDrag(element, tab) {
    element.draggable = true;
    element.addEventListener('dragstart', e => {
      if (e.target.closest('button,input,select,textarea')) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/x-konx-tab', tab.id);
      e.dataTransfer.effectAllowed = 'move';
      element.konxWasDragged = true;
      this.draggedTab = tab; element.classList.add('dragging');
    });
    element.addEventListener('dragend', () => { this.draggedTab = null; element.classList.remove('dragging'); });
  }

  tabMenu(x, y, t) {
    contextMenu(x, y, [
      { label: 'Float in workspace', icon: 'columns', action: () => this.workspaceLayout.float(t) },
      { label: 'Pop out to window', icon: 'upload', action: () => this.popouts.open(t) },
      this.workspaceLayout.placement?.(t) !== 'docked' && { label: 'Dock back', icon: 'download', action: () => this.workspaceLayout.dock(t) },
      '-',
      { label: 'Rename…', icon: 'edit', action: async () => {
        const n = await promptText('Rename tab', 'Title', t.title, 'Rename');
        if (n) this.setTabTitle(t, n);
      } },
      t.kind === 'terminal' && { label: 'Clone', icon: 'copy', action: () => this.openTerminal(t.spec, t.cloneMeta()) },
      (t.kind === 'terminal' || t.kind === 'capture' || (t.kind === 'tool' && !['ai', 'incidents'].includes(t.toolKind))) && { label: 'Add evidence to incident…', icon: 'file', action: () => this.addToIncident(t) },
      t.kind === 'terminal' && t.protocol === 'ssh' && { label: 'Open SFTP tab', icon: 'file-transfer', disabled: t.state !== 'connected', action: () => this.openSftpFromTerminal(t) },
      t.kind === 'terminal' && t.state === 'disconnected' && { label: 'Reconnect', icon: 'refresh', action: () => t.reconnect() },
      t.kind === 'terminal' && ['connected', 'connecting'].includes(t.state) && { label: t.state === 'connecting' ? 'Cancel connection' : 'Disconnect', icon: 'unplug', action: () => t.disconnect() },
      '-',
      { label: 'Close', icon: 'x', action: () => this.closeTab(t) },
      { label: 'Close others', action: () => this.tabs.filter((x) => x !== t).forEach((x) => this.closeTab(x)) },
      { label: 'Close all', action: () => [...this.tabs].forEach((x) => this.closeTab(x)) },
    ]);
  }

  setTabTitle(tab, title) {
    tab.title = title;
    this.renderTabs();
  }

  tabStateChanged(tab) {
    this.renderTabs();
    if (tab === this.active) this.updateStatus(tab);
  }

  tabActivity(tab) {
    if (!tab.activity) {
      tab.activity = true;
      this.renderTabs();
    }
  }

  updateStatus(tab) {
    this.popouts?.refresh();
    if (tab !== this.active) return;
    const segs = tab.statusSegments ? tab.statusSegments() : [];
    const open = this.tabs.filter((t) => (t.kind === 'terminal' || t.kind === 'sftp') && t.state === 'connected').length;
    this.status.replaceChildren(
      ...segs.map((s) => h('span.seg', { class: s.cls || '', title: s.title || '' }, s.icon ? icon(s.icon) : null, s.text)),
      h('span.spacer'),
      h('span.seg', `${open} connected`),
      h('span.seg', `${this.info.name} ${this.info.version}`)
    );
    this.workspaceLayout?.updateContext();
  }

  showHome() {
    const w = this.tabs.find((t) => t.kind === 'welcome');
    if (w) this.activate(w);
    else this.addTab(new WelcomeTab(this));
  }

  // ------------------------------------------------------------ opening things

  openTerminal(spec, meta) {
    const tab = this.addTab(new TerminalTab(this, spec, meta));
    // Replace the Home tab when it is the only other thing open.
    const home = this.tabs.find((t) => t.kind === 'welcome');
    if (home && this.tabs.length === 2) this.closeTab(home);
    tab.connect();
    return tab;
  }

  connectSession(s, extra = {}) {
    this.rememberRecent(s.id);
    const override = s._oncePassword ? { password: s._oncePassword } : undefined;
    return this.openTerminal({ sessionId: s.id, override }, { name: s.name || s.host, protocol: s.protocol || 'ssh', colorScheme: s.colorScheme, fontSize: s.fontSize, terminalHighlighting: s.terminalHighlighting, ...extra });
  }

  quickConnect(q) {
    if (q.protocol === 'serial') {
      const baudRate = quickBaud(q.baudRate);
      if (!validQuickBaud(baudRate)) { toast('Enter a positive numeric baud rate or auto.', 'err'); return null; }
      q = { ...q, baudRate };
    }
    const name = q.protocol === 'serial' ? q.serialPort : q.host;
    if (q.protocol === 'sftp') return this.quickSftp(q);
    return this.openTerminal({ ...q, auth: 'password', name }, { name, protocol: q.protocol, terminalHighlighting: q.terminalHighlighting });
  }

  quickSftp(q) {
    return this.openSftp({ protocol: 'ssh', host: q.host, port: q.port || 22, username: q.username, password: q.password, auth: 'password' }, { name: q.host });
  }

  openSftp(spec, meta) {
    const tab = this.addTab(new SftpTab(this, spec, meta));
    tab.connect();
    return tab;
  }

  openSftpFromTerminal(t) {
    return this.openSftp({ fromConn: t.id }, { name: t.title });
  }

  sftpForActive() {
    const t = this.active;
    if (t && t.kind === 'terminal' && t.protocol === 'ssh' && t.state === 'connected') return this.openSftpFromTerminal(t);
    const s = this.sessions.selectedSession();
    if (s && (s.protocol || 'ssh') === 'ssh') return this.openSftp({ sessionId: s.id }, { name: s.name || s.host });
    formDialog({
      title: 'SFTP connect',
      icon: 'file-transfer',
      fields: [
        { name: 'host', label: 'Host', placeholder: 'user@host:port' },
      ],
      okLabel: 'Connect',
    }).then((r) => r && r.host && this.quickSftp(parseQuick(r.host)));
  }

  /** The single Notepad tab (it keeps its own document tabs). Resolves once the editor is ready. */
  openNotepad() {
    let t = this.tabs.find((x) => x.kind === 'notepad');
    if (t) this.activate(t);
    else t = this.addTab(new NotepadTab(this));
    return t.ready.then(() => { if (t.disposed || !this.tabs.includes(t)) throw new Error('Notepad was closed before its editor finished loading.'); return t; });
  }

  openTool(kind, params = {}) {
    const tab = createTool(this, kind, params);
    if (kind !== 'ai' && kind !== 'events') {
      const heading = tab.el.querySelector('.tool-title') || tab.el.querySelector('.tool-head') || tab.el.querySelector('.cap-frow');
      heading?.append(h('button.btn.sm', { title: 'Preview these results in AI & Knowledge', onclick: () => this.explainTool(tab) }, icon('insight'), 'Explain with AI'));
      if (kind !== 'incidents' && kind !== 'change-validation') heading?.append(h('button.btn.sm', { title: 'Choose an incident for a snapshot of this evidence', onclick: () => this.addToIncident(tab) }, icon('file'), 'Add to incident'));
    }
    return this.addTab(tab);
  }

  openDeviceInspector(report, { deviceId, source } = {}) {
    const tab = this.openTool('device');
    tab.acceptReport(report);
    const device = tab.report.devices.find(item => item.id === deviceId);
    if (device) { tab.deviceSelect.value = device.id; tab.renderDevice(); if (source) tab.showSource(device, source); }
    return tab;
  }

  async explainTool(tab) {
    if (tab.disposed) return;
    try {
      const preview = await api.invoke('tools:aiPreview', { context: toolContext(tab) });
      if (tab.disposed) return;
      return this.openTool('ai', { label: tab.title, context: preview.context,
        question: `Explain these ${tab.title} results in plain language. Distinguish observed facts, unknowns, and possible causes, then suggest which KonX tool to use next.` });
    } catch (error) { toast(errMsg(error), 'err'); }
  }

  addToIncident(tab) {
    try { return this.openTool('incidents', { evidence: incidentEvidence(tab) }); }
    catch (error) { toast(errMsg(error), 'err'); }
  }

  hostMenu(host, port) {
    return hostMenuItems(this, host, port);
  }

  presetPorts(name) {
    return (this.presets.presets[name] || []).join(',');
  }

  registerJob(id, tab) {
    this.jobs.set(id, tab);
    this.workspaceLayout?.updateContext();
  }

  unregisterJob(id) {
    this.jobs.delete(id);
    this.workspaceLayout?.updateContext();
  }

  async editSession(s) {
    const r = await editSessionDialog(this, s || {});
    if (!r) return;
    await this.sessions.load();
    this.sessions.selected = 's:' + r.session.id;
    this.sessions.render();
    if (r.connect) this.connectSession(r.session);
  }

  rememberRecent(id) {
    if (typeof id !== 'string' || !id) return;
    try {
      const list = this.recentSessionIds().filter((x) => x !== id);
      list.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
    } catch {}
    this.refreshRecentSessions();
  }

  recentSessionIds() {
    try {
      const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      const ids = [];
      for (const id of value) {
        if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
        if (ids.length === 8) break;
      }
      return ids;
    } catch {}
    return [];
  }

  recentSessions() {
    return this.recentSessionIds().map((id) => this.sessions.data.sessions.find((s) => s.id === id)).filter(Boolean);
  }

  refreshRecentSessions() {
    for (const tab of this.tabs) if (tab.kind === 'welcome') tab.renderRecent();
  }

  clearRecentSessions() {
    try { localStorage.removeItem(RECENT_KEY); }
    catch (error) { toast('Could not clear recent sessions: ' + errMsg(error), 'err'); return false; }
    this.refreshRecentSessions();
    toast('Recent sessions cleared.');
    return true;
  }

  async saveSettings(patch) {
    const prior = this.settings, next = await api.invoke('settings:set', patch);
    const changed = Object.keys(next).filter(key => JSON.stringify(prior[key]) !== JSON.stringify(next[key]));
    this.settings = next;
    // A structural selection need not reapply terminal/editor colors or fonts.
    if (changed.some(key => !['uiLayout', 'workspaceGeometry'].includes(key))) {
      this.applyTheme();
      for (const t of this.tabs) if (t.applySettings) t.applySettings(this.settings);
      this.renderButtonBar();
    }
    this.workspaceLayout.set(this.settings.uiLayout);
  }

  // ------------------------------------------------------------ events from main

  bindEvents() {
    api.on('conn:data', (id, buf) => {
      const t = this.byId.get(id);
      if (t && t.onData) t.onData(buf);
    });
    api.on('conn:status', (id, st) => {
      const t = this.byId.get(id);
      if (t && t.onStatus) t.onStatus(st);
    });
    api.on('xfer:update', (j) => {
      const t = this.byId.get(j.sftpId);
      if (t && t.xfers) t.xfers.update(j);
    });
    api.on('sftp:changed', (id, side, dir) => {
      const t = this.byId.get(id);
      if (t && t.onChanged) t.onChanged(side, dir);
    });
    api.on('sftp:closed', (id) => {
      const t = this.byId.get(id);
      if (t && t.onClosed) t.onClosed();
    });
    api.on('sftp:edited', (id, p) => toast(`Uploaded ${p}`, 'ok'));
    api.on('sftp:edit-error', (id, p, message) => toast(`Could not upload ${p}: ${message}`, 'err'));
    api.on('cap:packets', (id, payload) => {
      const t = this.byId.get(id);
      if (t && t.onLivePackets) t.onLivePackets(payload);
    });
    api.on('cap:state', (id, st) => {
      const t = this.byId.get(id);
      if (t && t.onCapState) t.onCapState(st);
    });
    api.on('tools:event', (jobId, type, data) => {
      const t = this.jobs.get(jobId);
      if (t) t.onJobEvent(type, data);
    });
    api.on('ui:prompt', async (p) => {
      let value = null;
      try {
        value = await this.handlePrompt(p);
      } catch (e) {
        toast(errMsg(e), 'err');
      }
      api.invoke('ui:promptResponse', p.id, value);
    });

    addEventListener('keydown', (e) => this.onGlobalKey(e), true);
  }

  async handlePrompt(p) {
    if (p.kind === 'form') return formDialog({ title: p.title, message: p.message, fields: p.fields, okLabel: 'OK', icon: 'lock' });
    if (p.kind === 'hostkey') {
      const body = p.changed
        ? [
            h('div.errbox', h('b', 'WARNING: the host key for this server has changed!'), h('br'), 'Someone could be intercepting the connection (man-in-the-middle), or the server was reinstalled. Only continue if you know why the key changed.'),
            h('div.hint', 'Previously saved fingerprint'),
            h('div.fp', `${p.previous.keyType} ${p.previous.fingerprint}`),
            h('div.hint', 'Fingerprint presented now'),
            h('div.fp', `${p.keyType} ${p.fingerprint}`),
          ]
        : [
            h('div.message', `The host key for ${p.host}${p.port !== 22 ? ':' + p.port : ''} is not known. Verify the fingerprint with the server administrator before accepting.`),
            h('div.fp', `${p.keyType}\n${p.fingerprint}`),
          ];
      const r = await modal({
        title: p.changed ? 'Host key changed' : 'New host key',
        icon: 'shield',
        width: 560,
        body,
        buttons: [
          { label: 'Cancel', value: 'reject' },
          { label: 'Accept once', value: 'once' },
          { label: p.changed ? 'Replace & connect' : 'Accept & save', value: 'save', primary: !p.changed, danger: p.changed },
        ],
      });
      return r || 'reject';
    }
    if (p.kind === 'conflict') {
      const all = h('input', { type: 'checkbox' });
      const r = await modal({
        title: 'File already exists',
        icon: 'alert',
        body: [
          h('div.message', h('b', p.name), ' already exists at the destination.'),
          h('div.grid2',
            h('div.field', h('span', 'Source'), h('div', `${fmtBytes(p.srcSize)} · ${fmtDate(p.srcMtime)}`)),
            h('div.field', h('span', 'Existing'), h('div', `${fmtBytes(p.dstSize)} · ${fmtDate(p.dstMtime)}`))),
          h('label.check', all, 'Do this for all remaining files in this transfer'),
        ],
        buttons: [
          { label: 'Skip', value: 'skip' },
          { label: 'Overwrite', value: 'overwrite', primary: true },
        ],
      });
      return { action: r || 'skip', all: all.checked };
    }
    return null;
  }

  onGlobalKey(e) {
    const k = e.key.toLowerCase();
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (this.active && this.active.onGlobalKey && this.active.onGlobalKey(e)) return stop();
    if (e.ctrlKey && k === 'tab') {
      stop();
      const i = this.tabs.indexOf(this.active);
      const n = this.tabs.length;
      this.activate(this.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n]);
    } else if ((e.ctrlKey && e.shiftKey && k === 'w') || (e.ctrlKey && k === 'f4')) {
      stop();
      if (this.active) this.closeTab(this.active);
    } else if (e.altKey && !e.ctrlKey && k === 'q') {
      stop();
      this.quickInput.focus();
    } else if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
      const t = this.tabs[Number(e.key) - 1];
      if (t) {
        stop();
        this.activate(t);
      }
    } else if (e.key === 'F12') {
      stop();
      api.invoke('app:devtools');
    }
  }
}

const app = new App();
app.init().catch((e) => {
  document.body.textContent = 'Startup failed: ' + errMsg(e);
  console.error(e);
});
