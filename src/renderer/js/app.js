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

const RECENT_KEY = 'konx.recent';

function unescapeSend(s) {
  return String(s).replace(/\\(r|n|t|e|\\|x[0-9a-fA-F]{2})/g, (_, c) =>
    c === 'r' ? '\r' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'e' ? '\x1b' : c === '\\' ? '\\' : String.fromCharCode(parseInt(c.slice(1), 16))
  );
}

/** "user@host:port", "ssh://user@host:2222", "telnet://10.0.0.1", "COM3" */
export function parseQuick(text, defaultProto = 'ssh') {
  let t = text.trim();
  let protocol = defaultProto;
  const scheme = t.match(/^(ssh|telnet|raw|serial|sftp):\/\//i);
  if (scheme) {
    protocol = scheme[1].toLowerCase();
    t = t.slice(scheme[0].length);
  }
  if (/^(COM\d+|\/dev\/\S+)$/i.test(t)) {
    const [port, baud] = t.split(/[@:,]/);
    return { protocol: 'serial', serialPort: port.toUpperCase().startsWith('COM') ? port.toUpperCase() : port, baudRate: Number(baud) || 9600 };
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
    this.el = h('div.view');
    this.render();
  }

  render() {
    const app = this.app;
    const proto = h('select.input', [['ssh', 'SSH2'], ['telnet', 'Telnet'], ['raw', 'Raw TCP'], ['serial', 'Serial']].map(([v, l]) => h('option', { value: v }, l)));
    const host = h('input.input', { placeholder: 'Hostname, IP or COM port', spellcheck: false });
    const port = h('input.input', { placeholder: '22', type: 'number' });
    const user = h('input.input', { placeholder: 'Username (optional)', spellcheck: false });
    proto.addEventListener('change', () => (port.placeholder = proto.value === 'ssh' ? '22' : proto.value === 'serial' ? 'baud' : '23'));
    const go = () => {
      if (!host.value.trim()) return host.focus();
      if (proto.value === 'serial') app.quickConnect({ protocol: 'serial', serialPort: host.value.trim(), baudRate: Number(port.value) || 9600 });
      else app.quickConnect({ ...parseQuick(host.value, proto.value), ...(port.value ? { port: Number(port.value) } : {}), ...(user.value.trim() ? { username: user.value.trim() } : {}) });
    };
    for (const i of [host, port, user]) i.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    const recent = app.recentSessions();
    this.el.replaceChildren(
      h(
        'div.welcome',
        h('h1', h('img', { src: '../../assets/logo.svg', alt: '' }), app.info.name),
        h('p.lead', 'Terminal, file transfer and network toolkit — SSH2, Telnet, Serial, SFTP, ping, sweep, port scan and more in one window.'),
        h('div.welcome-update', h('span.hint', `KonX ${app.info.version || ''}`), h('button.btn.sm', { onclick: () => updateKonx(app) }, icon('download'), 'Update KonX')),
        h('h3', 'Quick connect'),
        h(
          'div.qc-form',
          h('label.field', h('span', 'Protocol'), proto),
          h('label.field', h('span', 'Host'), host),
          h('label.field', h('span', 'Port'), port),
          h('label.field', h('span', 'Username'), user),
          h('button.btn.primary', { onclick: go }, icon('zap'), 'Connect')
        ),
        recent.length ? h('h3', 'Recent sessions') : null,
        recent.length
          ? h('div.cards', recent.map((s) => h('div.card', { onclick: () => app.connectSession(s) },
              h('div.ic', icon(s.protocol === 'serial' ? 'usb' : 'server')),
              h('div', h('div.t', s.name || s.host), h('div.d', s.protocol === 'serial' ? `${s.serialPort} · ${s.baudRate}` : `${s.username ? s.username + '@' : ''}${s.host}:${s.port || 22}`)))))
          : null,
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
  }

  show() {
    this.active = true;
    this.render();
  }
  hide() {
    this.active = false;
  }
  focus() {}
  statusSegments() {
    return [{ icon: 'home', text: 'Home' }];
  }
  dispose() {}
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
        this.active && this.active.refit && this.active.refit();
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
    this.cmdInput.addEventListener('keydown', (e) => this.onCmdKey(e));
    this.cmdwin = h('div#cmdwin.hidden', icon('command'), this.cmdInput, h('label', this.cmdAll, 'Send to all terminal tabs'));
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
    setTimeout(() => this.active && this.active.refit && this.active.refit(), 50);
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
    setTimeout(() => this.active && this.active.refit && this.active.refit(), 30);
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
    const targets = all ? this.tabs.filter((t) => t.kind === 'terminal' && t.state === 'connected') : this.active && this.active.kind === 'terminal' ? [this.active] : [];
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
    this.views.append(tab.el);
    this.renderTabs();
    this.activate(tab);
    return tab;
  }

  activate(tab) {
    if (this.active && this.active !== tab) {
      this.active.el.classList.remove('active');
      this.active.hide();
    }
    this.active = tab;
    tab.activity = false;
    tab.el.classList.add('active');
    tab.show();
    this.renderTabs(true);
    this.updateStatus(tab);
    setTimeout(() => tab.focus && tab.focus(), 0);
  }

  async closeTab(tab) {
    if (tab.kind === 'sftp' && tab.xfers.active()) {
      const ok = await modal({ title: 'Transfers in progress', body: h('div.message', 'Closing this tab cancels the remaining transfers.'), buttons: [{ label: 'Cancel', value: null }, { label: 'Close tab', value: true, danger: true }] });
      if (!ok) return;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
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
    this.tabbar.replaceChildren(
      ...this.tabs.map((t, i) => {
        const dotCls = t.kind === 'terminal' || t.kind === 'sftp' ? t.state : t.state === 'running' ? 'connecting' : '';
        const el = h(
          'div.tab',
          { class: t === this.active ? 'active' : '', draggable: true, title: t.title },
          t.kind === 'terminal' || t.kind === 'sftp' ? h('span.dot', { class: dotCls + (t.activity ? ' activity' : '') }) : h('span.ticon', icon(t.icon)),
          h('span.title', t.title),
          h('button.close', { title: 'Close (Ctrl+Shift+W)', onclick: (e) => (e.stopPropagation(), this.closeTab(t)) }, icon('x'))
        );
        el.addEventListener('mousedown', (e) => {
          // Activating rebuilds the tab bar; keep X in place until its click fires.
          if (e.button === 0 && !e.target.closest('button.close')) this.activate(t);
          if (e.button === 1) {
            e.preventDefault();
            this.closeTab(t);
          }
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.tabMenu(e.clientX, e.clientY, t);
        });
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/x-tab', String(i));
          el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.addEventListener('dragover', (e) => e.dataTransfer.types.includes('text/x-tab') && e.preventDefault());
        el.addEventListener('drop', (e) => {
          const from = Number(e.dataTransfer.getData('text/x-tab'));
          if (isNaN(from) || from === i) return;
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(i, 0, moved);
          this.renderTabs(true);
        });
        return el;
      })
    );
    // Background activity and title updates must not undo manual tab scrolling.
    this.tabbar.scrollLeft = scrollLeft;
    this.scheduleTabLayout(revealActive);
  }

  tabMenu(x, y, t) {
    contextMenu(x, y, [
      { label: 'Rename…', icon: 'edit', action: async () => {
        const n = await promptText('Rename tab', 'Title', t.title, 'Rename');
        if (n) this.setTabTitle(t, n);
      } },
      t.kind === 'terminal' && { label: 'Clone', icon: 'copy', action: () => this.openTerminal(t.spec, t.meta) },
      t.kind === 'terminal' && t.protocol === 'ssh' && { label: 'Open SFTP tab', icon: 'file-transfer', disabled: t.state !== 'connected', action: () => this.openSftpFromTerminal(t) },
      t.kind === 'terminal' && t.state !== 'connected' && { label: 'Reconnect', icon: 'refresh', action: () => t.reconnect() },
      t.kind === 'terminal' && t.state === 'connected' && { label: 'Disconnect', icon: 'unplug', action: () => t.disconnect() },
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
    if (tab !== this.active) return;
    const segs = tab.statusSegments ? tab.statusSegments() : [];
    const open = this.tabs.filter((t) => (t.kind === 'terminal' || t.kind === 'sftp') && t.state === 'connected').length;
    this.status.replaceChildren(
      ...segs.map((s) => h('span.seg', { class: s.cls || '', title: s.title || '' }, s.icon ? icon(s.icon) : null, s.text)),
      h('span.spacer'),
      h('span.seg', `${open} connected`),
      h('span.seg', `${this.info.name} ${this.info.version}`)
    );
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
    return this.openTerminal({ sessionId: s.id, override }, { name: s.name || s.host, protocol: s.protocol || 'ssh', colorScheme: s.colorScheme, fontSize: s.fontSize, ...extra });
  }

  quickConnect(q) {
    const name = q.protocol === 'serial' ? q.serialPort : q.host;
    if (q.protocol === 'sftp') return this.quickSftp(q);
    return this.openTerminal({ ...q, auth: 'password', name }, { name, protocol: q.protocol });
  }

  quickSftp(q) {
    return this.openSftp({ protocol: 'ssh', host: q.host, port: q.port || 22, username: q.username, auth: 'password' }, { name: q.host });
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
    return t.ready.then(() => t);
  }

  openTool(kind, params = {}) {
    const tab = createTool(this, kind, params);
    if (kind !== 'ai') {
      const heading = tab.el.querySelector('.tool-title') || tab.el.querySelector('.tool-head') || tab.el.querySelector('.cap-frow');
      heading?.append(h('button.btn.sm', { title: 'Preview these results in AI & Knowledge', onclick: () => this.explainTool(tab) }, icon('insight'), 'Explain with AI'));
    }
    return this.addTab(tab);
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

  hostMenu(host, port) {
    return hostMenuItems(this, host, port);
  }

  presetPorts(name) {
    return (this.presets.presets[name] || []).join(',');
  }

  registerJob(id, tab) {
    this.jobs.set(id, tab);
  }

  unregisterJob(id) {
    this.jobs.delete(id);
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
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x !== id);
      list.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
    } catch {}
  }

  recentSessions() {
    let ids = [];
    try {
      ids = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch {}
    return ids.map((id) => this.sessions.data.sessions.find((s) => s.id === id)).filter(Boolean);
  }

  async saveSettings(patch) {
    this.settings = await api.invoke('settings:set', patch);
    this.applyTheme();
    for (const t of this.tabs) if (t.applySettings) t.applySettings(this.settings);
    this.renderButtonBar();
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
