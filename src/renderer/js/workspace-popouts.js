import { h, icon, api, toast, errMsg, registerUiWindow, returnUiToMain } from './ui.js';

/** A child hosts live DOM; App remains the sole owner of tabs and their work. */
export class WorkspacePopouts {
  constructor(app) {
    this.app = app;
    this.entries = new Map();
    this.pending = new Map();
    this.closing = new Map();
    api.on('app:popoutDock', ({ id }) => {
      const entry = [...this.entries.values()].find(value => value.id === id);
      if (entry) this.dock(entry.tab);
      else if (this.closing.has(id)) this.closeNative(this.closing.get(id));
    });
    api.on('app:popoutClosed', ({ id }) => {
      this.closing.delete(id);
      const entry = [...this.entries.values()].find(value => value.id === id);
      if (entry) this.returnTab(entry, false);
    });
    this.headObserver = new MutationObserver(() => this.updateTheme());
    this.headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    this.themeObserver = new MutationObserver(() => this.updateTheme());
    this.themeObserver.observe(document.documentElement, { attributes: true });
  }

  async open(tab) {
    if (!this.app.tabs.includes(tab) || tab.disposed) return false;
    if (this.entries.has(tab.id)) { this.focus(tab); return true; }
    if (this.pending.has(tab.id)) return false;
    const attempt = {};
    this.pending.set(tab.id, attempt);
    let permit, entry;
    try {
      permit = await api.invoke('app:popoutPrepare');
      if (this.pending.get(tab.id) !== attempt || !this.app.tabs.includes(tab) || tab.disposed) {
        await api.invoke('app:popoutClose', permit.id); return false;
      }
      const child = window.open('about:blank', permit.frameName, 'popup,width=1000,height=700');
      if (!child) throw new Error('KonX could not create the pop-out window.');
      const doc = child.document;
      doc.documentElement.lang = document.documentElement.lang || 'en';
      const base = doc.createElement('base'); base.href = document.baseURI; doc.head.append(base);
      const title = h('strong.popout-title', tab.title);
      const status = h('span.popout-status', { role: 'status' });
      const body = h('div.workspace-pane-body.popout-body');
      const header = h('header.popout-header', icon(tab.icon || 'columns'), title,
        h('button.btn.sm', { onclick: () => this.dock(tab), 'aria-label': 'Dock back to KonX' }, 'Dock back'),
        h('button.btn.sm', { onclick: () => { this.dock(tab); this.app.workspaceLayout.float(tab); } }, 'Float in KonX'),
        h('button.btn.sm', { onclick: () => this.app.closeTab(tab), title: 'Close this tab and its work' }, 'Close tab'));
      doc.body.className = 'konx-popout';
      doc.body.append(h('main.popout-root', header, body, status));
      entry = { id: permit.id, tab, window: child, body, title, status, styles: new Map() };
      this.entries.set(tab.id, entry);
      entry.releaseUi = registerUiWindow(child);
      const activate = () => { if (this.app.active !== tab) this.app.activate(tab, { focus: false }); };
      const key = event => {
        if (doc.querySelector('.modal-back')) return;
        activate(); this.app.onGlobalKey(event);
      };
      const resize = () => { if (!tab.disposed) tab.refit?.(); };
      child.addEventListener('focus', activate);
      child.addEventListener('pointerdown', activate, true);
      child.addEventListener('keydown', key, true);
      child.addEventListener('resize', resize);
      entry.releaseEvents = () => {
        child.removeEventListener('focus', activate);
        child.removeEventListener('pointerdown', activate, true);
        child.removeEventListener('keydown', key, true);
        child.removeEventListener('resize', resize);
      };
      this.syncTheme(entry);
      const previous = tab.el.ownerDocument.defaultView;
      this.app.workspaceLayout.attachExternal(tab, { body, window: child });
      tab.onHostWindowChanged?.(child, previous);
      this.app.activate(tab, { focus: false });
      this.refresh(); child.focus(); tab.refit?.(); tab.focus?.();
      return true;
    } catch (error) {
      if (entry) this.returnTab(entry, true);
      else if (permit) void api.invoke('app:popoutClose', permit.id).catch(() => {});
      toast('Could not pop out this tab: ' + errMsg(error), 'err');
      return false;
    } finally {
      if (this.pending.get(tab.id) === attempt) this.pending.delete(tab.id);
    }
  }

  syncTheme(entry) {
    if (entry.window.closed) return;
    const doc = entry.window.document;
    const root = doc.documentElement;
    for (const attribute of [...root.attributes]) if (attribute.name !== 'lang' && !document.documentElement.hasAttribute(attribute.name)) root.removeAttribute(attribute.name);
    for (const attribute of document.documentElement.attributes) root.setAttribute(attribute.name, attribute.value);
    root.dataset.themeVisible = 'true';
    const sources = new Set(document.head.querySelectorAll('link[rel="stylesheet"],style,meta[http-equiv="Content-Security-Policy"]'));
    for (const [source, copy] of entry.styles) if (!sources.has(source)) { copy.remove(); entry.styles.delete(source); }
    for (const source of sources) {
      let copy = entry.styles.get(source);
      if (!copy) {
        copy = source.cloneNode(true);
        if (source.tagName === 'LINK') copy.href = source.href;
        doc.head.append(copy); entry.styles.set(source, copy);
        if (source.tagName === 'LINK') copy.addEventListener('load', () => entry.tab.refit?.());
      } else if (source.tagName === 'STYLE' && copy.textContent !== source.textContent) copy.textContent = source.textContent;
    }
  }

  updateTheme() { for (const entry of this.entries.values()) this.syncTheme(entry); }
  refresh() {
    for (const entry of this.entries.values()) {
      if (entry.window.closed) continue;
      entry.title.textContent = entry.tab.title;
      entry.window.document.title = `${entry.tab.title} — KonX`;
      entry.status.textContent = (entry.tab.statusSegments?.() || []).map(segment => segment.text).filter(Boolean).join(' · ');
    }
  }
  focus(tab) {
    const entry = this.entries.get(tab.id);
    if (entry && !entry.window.closed) entry.window.focus();
    else if (!entry && !document.hasFocus()) window.focus();
  }
  dock(tab) {
    this.pending.delete(tab.id);
    const entry = this.entries.get(tab.id);
    if (entry) this.returnTab(entry, true);
  }
  returnTab(entry, close) {
    this.entries.delete(entry.tab.id);
    this.app.workspaceLayout.releaseExternal(entry.tab);
    entry.tab.onHostWindowChanged?.(window, entry.window);
    returnUiToMain(entry.window);
    entry.releaseUi?.(); entry.releaseEvents?.();
    if (close) this.closeNative(entry);
    this.app.renderTabs();
    if (!entry.tab.disposed && this.app.tabs.includes(entry.tab)) this.app.activate(entry.tab);
  }
  closeNative(entry) {
    this.closing.set(entry.id, entry);
    void api.invoke('app:popoutClose', entry.id).then(() => this.closing.delete(entry.id), error => {
      toast('The panel is docked, but its empty window could not close. Close that window to retry: ' + errMsg(error), 'err');
    });
  }
  disposeTab(tab) { this.dock(tab); }
}
