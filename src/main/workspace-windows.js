'use strict';
const crypto = require('node:crypto');

function isPrimaryFrame(event, primary) {
  return !!primary && !primary.isDestroyed() && event?.sender === primary.webContents
    && !!event.senderFrame && event.senderFrame === primary.webContents.mainFrame;
}

/** Native popouts present views whose objects and IPC remain owned by the opener. */
class WorkspaceWindows {
  constructor({ primary, BrowserWindow, emit, openExternal, now = Date.now, screen = require('electron').screen }) {
    this.primary = primary;
    this.BrowserWindow = BrowserWindow;
    this.emit = emit;
    this.openExternal = openExternal;
    this.now = now;
    this.screen = screen;
    this.permits = new Map();
    this.opening = new Map();
    this.windows = new Map();
    this.waiters = new Set();
    this.disposed = false;
    this.stopping = false;
    this.originalThrottling = primary.webContents.getBackgroundThrottling();
    primary.webContents.setWindowOpenHandler(details => this._allow(details));
    primary.webContents.on('did-create-window', (child, details) => this._created(child, details));
    primary.once('closed', () => this.dispose());
    this.recoverDisplays = () => {
      for (const { child } of this.windows.values()) this._keepVisible(child);
    };
    this.metricsChanged = (_event, _display, metrics) => {
      if (!metrics || metrics.some(metric => ['bounds', 'workArea', 'scaleFactor'].includes(metric))) this.recoverDisplays();
    };
    screen?.on('display-removed', this.recoverDisplays);
    screen?.on('display-metrics-changed', this.metricsChanged);
  }

  _expire() {
    for (const entries of [this.permits, this.opening]) for (const [name, permit] of entries) {
      if (permit.expires <= this.now()) entries.delete(name);
    }
  }

  prepare() {
    if (this.disposed || this.stopping || this.primary.isDestroyed()) throw new Error('KonX is closing. A view cannot be popped out now.');
    this._expire();
    if (this.permits.size + this.opening.size + this.windows.size >= 16) throw new Error('Close an existing pop-out window before opening another.');
    const id = crypto.randomBytes(16).toString('hex'), frameName = `konx-popout-${id}`;
    this.permits.set(frameName, { id, frameName, expires: this.now() + 15000 });
    return { id, frameName };
  }

  _allow({ url, frameName }) {
    this._expire();
    const permit = this.permits.get(frameName);
    if (!this.disposed && !this.stopping && url === 'about:blank' && permit) {
      this.permits.delete(frameName);
      this.opening.set(frameName, permit);
      return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: {
        minWidth: 420, minHeight: 300, autoHideMenuBar: true,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, backgroundThrottling: false },
      } };
    }
    if (!this.disposed && /^https?:\/\//i.test(url)) {
      try { Promise.resolve(this.openExternal(url)).catch(() => {}); } catch {}
    }
    return { action: 'deny' };
  }

  _created(child, { url, frameName }) {
    const permit = this.opening.get(frameName);
    this.opening.delete(frameName);
    if (this.disposed || url !== 'about:blank' || !permit || permit.expires <= this.now()) { child.destroy(); this._changed(); return; }
    const record = { ...permit, child, approved: false, requested: false };
    this.windows.set(record.id, record);
    this._keepVisible(child);
    this.primary.webContents.setBackgroundThrottling(false);
    // about:blank can inherit its opener's preferences; enforce live rendering
    // after native creation as well, including while the primary is minimized.
    child.webContents.setBackgroundThrottling(false);
    const denyNavigation = event => event.preventDefault();
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) child.webContents.on(event, denyNavigation);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['restore', 'unmaximize', 'leave-full-screen']) child.on(event, () => this._keepVisible(child));
    child.on('close', event => {
      if (record.approved || this.disposed) return;
      event.preventDefault();
      this._requestDock(record);
    });
    child.once('closed', () => {
      this.windows.delete(record.id);
      if (!this.disposed && !record.approved) this.emit('app:popoutClosed', { id: record.id });
      this._changed();
    });
    if (this.stopping) this._requestDock(record);
  }

  _requestDock(record) {
    if (record.requested || record.child.isDestroyed()) return;
    record.requested = true;
    this.emit('app:popoutDock', { id: record.id });
  }

  _keepVisible(child) {
    if (this.disposed || !this.screen || child.isDestroyed() || child.isMinimized() || child.isMaximized() || child.isFullScreen()) return;
    const bounds = child.getBounds();
    const display = this.screen.getDisplayMatching(bounds), area = display?.workArea;
    if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0) return;
    // Electron screen/window rectangles share device-independent coordinates.
    // Keep the native title bar and KonX's docking controls reachable after a
    // monitor disappears, its scale changes, or its usable work area shrinks.
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
    if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) child.setBounds({ x, y, width, height });
  }

  close(id) {
    const record = this.windows.get(id);
    if (record) {
      record.approved = true;
      record.child.close();
      return true;
    }
    for (const entries of [this.permits, this.opening]) for (const [name, permit] of entries) {
      if (permit.id === id) { entries.delete(name); this._changed(); return true; }
    }
    return false;
  }

  get hasOwnership() { return this.windows.size > 0 || this.opening.size > 0; }

  dialogOwner() {
    const focused = this.BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed() && [...this.windows.values()].some(record => record.child === focused)) return focused;
    return this.primary.isDestroyed() ? undefined : this.primary;
  }

  _changed() {
    if (!this.windows.size && !this.primary.isDestroyed()) this.primary.webContents.setBackgroundThrottling(this.originalThrottling);
    for (const check of this.waiters) check();
  }

  redockAll(timeoutMs = 5000) {
    this.stopping = true;
    this.permits.clear();
    this._expire();
    if (!this.hasOwnership) { this.stopping = false; return Promise.resolve(); }
    const wait = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(30000, Math.floor(timeoutMs))) : 5000;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.hasOwnership) return;
        clearTimeout(timer); this.waiters.delete(check); this.stopping = false; resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check); this.stopping = false;
        // Keep every native window and view owned so a later quit can retry.
        for (const record of this.windows.values()) record.requested = false;
        reject(new Error('Pop-out views have not finished docking. KonX has stayed open; try closing again.'));
      }, wait);
      this.waiters.add(check);
      for (const record of this.windows.values()) this._requestDock(record);
      check();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.permits.clear(); this.opening.clear();
    this.screen?.removeListener('display-removed', this.recoverDisplays);
    this.screen?.removeListener('display-metrics-changed', this.metricsChanged);
    for (const record of this.windows.values()) record.child.destroy();
    this.windows.clear(); this._changed();
  }
}

module.exports = { WorkspaceWindows, isPrimaryFrame };
