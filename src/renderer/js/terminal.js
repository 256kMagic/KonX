// A terminal tab: xterm.js view bound to one SSH / Telnet / raw / serial connection.
import { Terminal, FitAddon, SearchAddon, WebLinksAddon } from './vendor.js';
import { h, icon, api, contextMenu, modal, toast, errMsg, debounce } from './ui.js';
import { scheme, terminalTheme, usesThemeEffects } from './themes.js';
import { mountThemeOutput } from './theme-effects.js';
import { CiscoOutputHighlighter } from './cisco-highlighting.mjs';

let seq = 0;

const PROTO_LABEL = { ssh: 'SSH2', telnet: 'Telnet', raw: 'Raw TCP', serial: 'Serial' };

export class TerminalTab {
  /**
   * @param app   the App
   * @param spec  {sessionId} for a saved session, or an inline session object
   * @param meta  {name, protocol, colorScheme, fontSize}
   */
  constructor(app, spec, meta) {
    this.app = app;
    this.spec = spec;
    this.meta = meta;
    this.kind = 'terminal';
    this.id = `t${++seq}-${Date.now().toString(36)}`;
    this.title = meta.name;
    this.icon = meta.protocol === 'serial' ? 'usb' : 'terminal';
    this.protocol = meta.protocol || 'ssh';
    this.state = 'idle';
    this.info = null;
    this.disposed = false;
    this.visibilityGeneration = 0;
    this.logRequest = null;
    this.lastLogPath = '';
    this.logError = '';
    this.highlightOverride = null;

    const s = app.settings;
    this.term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: meta.fontSize || s.fontSize,
      theme: terminalTheme(s, meta),
      allowTransparency: true,
      scrollback: s.scrollback,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      allowProposedApi: true,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: true,
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((e, uri) => e.ctrlKey && api.invoke('app:openExternal', uri)));

    this.wrap = h('div.term-wrap');
    this.overlay = null;
    this.findbar = null;
    this.logState = h('span.term-log-state', 'Off');
    this.logSwitch = h('button.btn.sm.term-log-switch', {
      type: 'button', role: 'switch', 'aria-label': 'Log console to text file',
      'aria-checked': 'false', onclick: () => this.toggleLog(),
    }, h('span.term-log-track', { 'aria-hidden': 'true' }), 'Log to text file', this.logState);
    this.logPath = h('span.term-log-path');
    this.logReveal = h('button.btn.sm.ghost.term-log-reveal', {
      type: 'button', title: 'Show log in folder', 'aria-label': 'Show log in folder',
      onclick: async () => {
        if (!this.lastLogPath || this.disposed) return;
        try { await api.invoke('app:showItem', this.lastLogPath); }
        catch (error) { if (!this.disposed) toast(errMsg(error), 'err'); }
      },
    }, icon('folder-open'));
    this.logErrorEl = h('span.term-log-error.hidden', { role: 'alert' });
    this.ciscoState = h('span.term-log-state', 'Off');
    this.ciscoSwitch = h('button.btn.sm.term-cisco-switch', {
      type: 'button', role: 'switch', 'aria-label': 'Highlight Cisco output',
      'aria-checked': 'false', onclick: () => this.toggleCiscoHighlighting(),
    }, h('span.term-log-track', { 'aria-hidden': 'true' }), 'Cisco colors', this.ciscoState);
    this.logbar = h('div.term-logbar', this.logSwitch, this.ciscoSwitch, this.logPath, this.logReveal, this.logErrorEl);
    this.el = h('div.view', this.logbar, this.wrap);
    this._renderLogging();
    this.term.open(this.wrap);
    this.ciscoHighlighter = new CiscoOutputHighlighter(this.term, { enabled: this._highlightingMode() === 'cisco' });
    mountThemeOutput(this.wrap);
    this.applyColors(s);

    this.term.onData((d) => this._input(d, false));
    this.term.onBinary((d) => this._input(d, true));
    this.term.onResize(({ cols, rows }) => {
      api.send('conn:resize', this.id, cols, rows);
      this.app.updateStatus(this);
    });
    this.term.onTitleChange((t) => {
      if (t && this.app.settings.useRemoteTitle) this.app.setTabTitle(this, t);
    });
    const copySel = debounce(() => {
      if (this.disposed) return;
      const sel = this.term.getSelection();
      if (sel && this.app.settings.copyOnSelect) api.invoke('clipboard:write', sel);
    }, 120);
    this.term.onSelectionChange(copySel);
    this.term.attachCustomKeyEventHandler((e) => this._key(e));

    this.wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.app.settings.rightClick === 'paste') this.pasteClipboard();
      else this._menu(e.clientX, e.clientY);
    });
    this.wrap.addEventListener('mousedown', (e) => {
      // Middle click pastes, like most X11 / PuTTY-style terminals.
      if (e.button === 1) {
        e.preventDefault();
        this.pasteClipboard();
      }
    });

    this.ro = new ResizeObserver(debounce(() => this.refit(), 30));
    this.ro.observe(this.wrap);
  }

  // ------------------------------------------------------------ connection lifecycle

  async connect() {
    if (this.disposed) return;
    this._hideOverlay();
    this.state = 'connecting';
    this.logRequest = null;
    this.logError = '';
    this._renderLogging();
    this.app.tabStateChanged(this);
    this.refit();
    const r = await api.invoke('conn:open', this.id, this.spec, { cols: this.term.cols, rows: this.term.rows }).catch((e) => ({ ok: false, error: errMsg(e) }));
    if (this.disposed) return;
    if (!r.ok && this.state !== 'disconnected') this.onStatus({ state: 'disconnected', message: r.error });
  }

  onData(buf) {
    if (this.disposed) return;
    this.term.write(buf);
    if (!this.active) this.app.tabActivity(this);
  }

  onStatus(st) {
    if (this.disposed) return;
    this.state = st.state;
    if (st.info) this.info = st.info;
    if (this.info?.logging) this.lastLogPath = this.info.logging;
    if (st.state === 'connected') {
      this._hideOverlay();
    }
    if (st.state === 'disconnected') {
      this.logRequest = null;
      if (this.info) this.info = { ...this.info, logging: null };
      this.term.write(`\r\n\x1b[90m[${st.message || 'Disconnected'}]\x1b[0m\r\n`);
      this._showOverlay(st.message || 'Disconnected');
    }
    this._renderLogging();
    this.app.tabStateChanged(this);
  }

  reconnect() {
    if (this.disposed) return;
    this.term.write('\r\n');
    this.connect();
    this.focus();
  }

  disconnect() {
    api.invoke('conn:close', this.id);
  }

  _input(data, binary) {
    if (this.state === 'disconnected') {
      if (data === '\r') this.reconnect();
      return;
    }
    if (this.state !== 'connected') return;
    api.send('conn:write', this.id, data, binary);
  }

  /** Send text as if typed (used by the button bar and the command window). */
  sendText(text) {
    if (this.state === 'connected') api.send('conn:write', this.id, text, false);
  }

  _showOverlay(message) {
    this._hideOverlay();
    this.overlay = h(
      'div.term-overlay',
      h('span.msg', message),
      h('button.btn.sm.primary', { onclick: () => this.reconnect() }, icon('refresh'), 'Reconnect'),
      h('span.hint', 'or press Enter')
    );
    this.wrap.append(this.overlay);
  }

  _hideOverlay() {
    if (this.overlay) this.overlay.remove();
    this.overlay = null;
  }

  // ------------------------------------------------------------ view

  show({ focus = true } = {}) {
    if (this.disposed) return;
    this.active = true;
    const generation = ++this.visibilityGeneration;
    requestAnimationFrame(() => {
      if (this.disposed || !this.active || generation !== this.visibilityGeneration) return;
      this.refit();
      this.ciscoHighlighter?.refresh();
      if (focus) this.focus();
    });
  }

  hide() {
    this.active = false;
    this.visibilityGeneration++;
  }

  focus() {
    if (this.disposed || !this.active || this.app.active !== this) return;
    this.term.focus();
  }

  refit() {
    if (this.disposed || !this.active || !this.wrap.offsetParent) return;
    try {
      this.fit.fit();
    } catch {}
  }

  applySettings(s) {
    this.term.options.fontFamily = s.fontFamily;
    this.term.options.fontSize = this.meta.fontSize || s.fontSize;
    this.applyColors(s);
    this.term.options.cursorStyle = s.cursorStyle;
    this.term.options.cursorBlink = s.cursorBlink;
    this.term.options.scrollback = s.scrollback;
    this.refit();
  }

  applyColors(s) {
    this.term.options.theme = terminalTheme(s, this.meta);
    const background = scheme(this.meta.colorScheme || s.colorScheme || 'app', s.uiTheme).background;
    this.wrap.style.background = background;
    this.wrap.classList.toggle('theme-output-enabled', usesThemeEffects(s, this.meta));
    this.ciscoHighlighter?.setBackground(background);
    this._renderHighlighting(s);
  }

  _highlightingMode(settings = this.app.settings) {
    const session = this.meta.terminalHighlighting;
    // Missing session choices inherit the global default. Explicit unknown
    // values remain off until the user selects a supported mode.
    const global = settings.terminalHighlighting === undefined ? 'cisco' : settings.terminalHighlighting;
    return this.highlightOverride ?? (session === undefined || session === '' ? global : session);
  }

  _renderHighlighting(settings = this.app.settings) {
    const enabled = this._highlightingMode(settings) === 'cisco';
    this.ciscoHighlighter?.setEnabled(enabled);
    this.ciscoSwitch.setAttribute('aria-checked', String(enabled));
    this.ciscoState.textContent = enabled ? 'On' : 'Off';
    this.ciscoSwitch.title = `${enabled ? 'Turn off' : 'Turn on'} Cisco error, interface-state and IP highlighting for this tab. Save a default in Settings or the session's Terminal & Log page.`;
  }

  toggleCiscoHighlighting() {
    if (this.disposed) return;
    this.highlightOverride = this._highlightingMode() === 'cisco' ? 'off' : 'cisco';
    this._renderHighlighting();
  }

  cloneMeta() {
    return this.highlightOverride == null ? { ...this.meta } : { ...this.meta, terminalHighlighting: this.highlightOverride };
  }

  zoom(delta) {
    const cur = this.term.options.fontSize;
    this.term.options.fontSize = delta === 0 ? this.app.settings.fontSize : Math.max(7, Math.min(36, cur + delta));
    this.refit();
  }

  statusSegments() {
    const i = this.info || {};
    const segs = [];
    const state = this.state === 'connected' ? ['ok', 'Connected'] : this.state === 'connecting' ? ['warn', 'Connecting'] : ['err', 'Disconnected'];
    segs.push({ icon: this.state === 'connected' ? 'plug' : 'unplug', text: state[1], cls: state[0] });
    segs.push({ text: PROTO_LABEL[this.protocol] || this.protocol });
    if (this.protocol === 'serial') segs.push({ text: `${i.serialPort || ''} ${i.baudRate || ''}`.trim() });
    else if (i.host) segs.push({ text: `${i.username ? i.username + '@' : ''}${i.host}:${i.port}` });
    if (i.via) segs.push({ icon: 'route', text: 'via ' + i.via });
    if (i.cipher) segs.push({ icon: 'lock', text: i.cipher });
    segs.push({ text: `${this.term.cols}×${this.term.rows}` });
    if (this.state === 'connected' && i.logging) segs.push({ icon: 'log', text: 'Logging', cls: 'ok', title: i.logging });
    return segs;
  }

  // ------------------------------------------------------------ clipboard / keys / menu

  copy() {
    const sel = this.term.getSelection();
    if (sel) api.invoke('clipboard:write', sel);
  }

  async pasteClipboard() {
    const text = await api.invoke('clipboard:read');
    if (text) this.paste(text);
  }

  async paste(text) {
    if (this.state !== 'connected') return;
    const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length > 1 && this.app.settings.confirmMultilinePaste) {
      const ok = await modal({
        title: 'Paste multiple lines?',
        icon: 'alert',
        body: [
          h('div.message', `You are pasting ${lines.length} lines into ${this.title}. Each line will run as a command.`),
          h('pre.fp', { style: { maxHeight: '220px', overflow: 'auto', whiteSpace: 'pre' } }, lines.slice(0, 40).join('\n') + (lines.length > 40 ? '\n…' : '')),
        ],
        buttons: [
          { label: 'Cancel', value: null },
          { label: `Paste ${lines.length} lines`, value: true, primary: true },
        ],
      });
      this.focus();
      if (!ok) return;
    }
    if (this.disposed) return;
    this.term.paste(text);
  }

  _key(e) {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && k === 'c') {
      this.copy();
      return false;
    }
    if ((e.ctrlKey && e.shiftKey && k === 'v') || (e.shiftKey && k === 'insert')) {
      this.pasteClipboard();
      return false;
    }
    if (e.ctrlKey && k === 'insert') {
      this.copy();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && k === 'f') {
      this.openFind();
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && (k === '=' || k === '+')) {
      this.zoom(1);
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && k === '-') {
      this.zoom(-1);
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && k === '0') {
      this.zoom(0);
      return false;
    }
    if (e.shiftKey && (k === 'pageup' || k === 'pagedown')) {
      this.term.scrollPages(k === 'pageup' ? -1 : 1);
      return false;
    }
    return true;
  }

  openFind() {
    if (this.findbar) {
      this.findbar.querySelector('input').select();
      return;
    }
    const input = h('input', { placeholder: 'Find in scrollback', spellcheck: false });
    const opts = { caseSensitive: false, regex: false };
    const next = () => input.value && this.search.findNext(input.value, opts);
    const prev = () => input.value && this.search.findPrevious(input.value, opts);
    const close = () => {
      this.findbar.remove();
      this.findbar = null;
      this.search.clearDecorations && this.search.clearDecorations();
      this.term.clearSelection();
      this.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.shiftKey ? prev : next)();
      else if (e.key === 'Escape') close();
      e.stopPropagation();
    });
    input.addEventListener('input', () => input.value && this.search.findNext(input.value, { ...opts, incremental: true }));
    this.findbar = h(
      'div.findbar',
      input,
      h('button', { title: 'Previous (Shift+Enter)', onclick: prev }, icon('up')),
      h('button', { title: 'Next (Enter)', onclick: next }, icon('chev-down')),
      h('button', { title: 'Close (Esc)', onclick: close }, icon('x'))
    );
    this.wrap.append(this.findbar);
    input.focus();
  }

  /** Copy the whole scrollback (e.g. a long show run) into a new Notepad document. */
  async openScrollback() {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const np = await this.app.openNotepad();
    np.newDoc({ text: lines.join('\n'), title: `${this.title} scrollback` });
  }

  async toggleLog() {
    if (this.disposed || this.state !== 'connected' || this.logRequest) return;
    const request = {};
    this.logRequest = request;
    this.logError = '';
    this._renderLogging();
    try {
      if (this.info && this.info.logging) await api.invoke('conn:stopLog', this.id);
      else await api.invoke('conn:startLog', this.id);
    } catch (e) {
      if (!this.disposed && this.logRequest === request) this.logError = errMsg(e);
    } finally {
      if (!this.disposed && this.logRequest === request) {
        this.logRequest = null;
        this._renderLogging();
      }
    }
  }

  _renderLogging() {
    const logging = this.state === 'connected' && !!this.info?.logging;
    this.logSwitch.setAttribute('aria-checked', String(logging));
    this.logSwitch.setAttribute('aria-busy', String(!!this.logRequest));
    this.logSwitch.disabled = this.state !== 'connected' || !!this.logRequest;
    this.logSwitch.title = this.state !== 'connected' ? 'Connect this console to start logging' : logging ? 'Stop logging this console' : 'Start logging this console to a text file';
    this.logState.textContent = this.logRequest ? 'Working…' : logging ? 'On' : 'Off';
    this.logPath.textContent = this.lastLogPath || 'No log file yet';
    this.logPath.title = this.lastLogPath ? `${logging ? 'Logging to' : 'Last log file'}: ${this.lastLogPath}` : 'Start logging to save new console output';
    this.logReveal.disabled = !this.lastLogPath;
    this.logReveal.title = this.lastLogPath ? `Show log in folder: ${this.lastLogPath}` : 'No log file yet';
    this.logErrorEl.textContent = this.logError;
    this.logErrorEl.classList.toggle('hidden', !this.logError);
  }

  _menu(x, y) {
    const connected = this.state === 'connected';
    const sel = this.term.getSelection();
    contextMenu(x, y, [
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+Shift+C', disabled: !sel, action: () => this.copy() },
      { label: 'Paste', icon: 'file', shortcut: 'Ctrl+Shift+V', disabled: !connected, action: () => this.pasteClipboard() },
      { label: 'Select All', action: () => this.term.selectAll() },
      { label: 'Find…', icon: 'search', shortcut: 'Ctrl+Shift+F', action: () => this.openFind() },
      { label: 'Clear Scrollback', action: () => { this.term.clear(); this.ciscoHighlighter.refresh(); } },
      { label: 'Open scrollback in Notepad', icon: 'edit', action: () => this.openScrollback() },
      '-',
      this.protocol === 'ssh' && { label: 'Open SFTP Tab', icon: 'file-transfer', disabled: !connected, action: () => this.app.openSftpFromTerminal(this) },
      { label: this.info && this.info.logging ? 'Stop Logging' : 'Start Logging', icon: 'log', disabled: !connected || !!this.logRequest, action: () => this.toggleLog() },
      { label: this._highlightingMode() === 'cisco' ? 'Turn Cisco colors off' : 'Turn Cisco colors on', action: () => this.toggleCiscoHighlighting() },
      (this.protocol === 'serial' || this.protocol === 'telnet') && { label: 'Send Break', disabled: !connected, action: () => api.invoke('conn:break', this.id) },
      '-',
      connected
        ? { label: 'Disconnect', icon: 'unplug', action: () => this.disconnect() }
        : { label: 'Reconnect', icon: 'refresh', action: () => this.reconnect() },
      { label: 'Clone Tab', icon: 'copy', action: () => this.app.openTerminal(this.spec, this.cloneMeta()) },
    ]);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    this.ro.disconnect();
    api.invoke('conn:close', this.id);
    this.ciscoHighlighter?.dispose();
    this.term.dispose();
  }
}
