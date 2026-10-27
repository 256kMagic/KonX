import { h, icon, toast, errMsg, api } from './ui.js';
import { APP_LAYOUTS, normalizeLayout } from './workspace-layouts.mjs';
import { normalizeWorkspaceGeometry, clampFloatBounds, expandFloatBounds, contractFloatBounds } from './workspace-panels-model.mjs';

const incident = (tab) => tab?.toolKind === 'incidents';
const label = (slot) => ({ primary: 'Main view', companion: 'Companion', dossier: 'Incident dossier' })[slot] || `View ${Number(slot.slice(5)) + 1}`;

/** Layout assignments reference the canonical tabs; visibility never owns jobs. */
export class WorkspaceLayoutModel {
  constructor() {
    this.layout = 'classic'; this.primaryId = null; this.companionId = null; this.dossierId = null;
    this.wallIds = [null, null, null, null]; this.wallCount = 4; this.wallFocus = 0; this.expandedSlot = null;
  }
  slots() {
    if (this.layout === 'operations-wall') return this.wallIds.slice(0, this.wallCount).map((id, i) => ({ slot: `wall-${i}`, id }));
    const slots = [{ slot: 'primary', id: this.primaryId }];
    if (this.layout === 'workbench') slots.push({ slot: 'companion', id: this.companionId });
    if (this.layout === 'incident-desk') slots.push({ slot: 'dossier', id: this.dossierId });
    return slots;
  }
  read(slot) { return /^wall-[0-3]$/.test(slot) ? this.wallIds[Number(slot.slice(5))] : this[slot + 'Id']; }
  write(slot, id) { if (/^wall-[0-3]$/.test(slot)) this.wallIds[Number(slot.slice(5))] = id; else this[slot + 'Id'] = id; }
  prune(tabs) {
    const ids = new Set(tabs.map(t => t.id));
    for (const slot of ['primary', 'companion', 'dossier', 'wall-0', 'wall-1', 'wall-2', 'wall-3']) if (!ids.has(this.read(slot))) this.write(slot, null);
    if (!incident(tabs.find(t => t.id === this.dossierId))) this.dossierId = null;
    if (this.layout === 'workbench' && this.primaryId === this.companionId) this.primaryId = null;
    if (this.layout === 'incident-desk' && this.primaryId === this.dossierId) this.primaryId = null;
    if (this.expandedSlot && !this.slots().some(s => s.slot === this.expandedSlot && s.id)) this.expandedSlot = null;
  }
  set(layout, tabs, activeId) {
    this.layout = normalizeLayout(layout); this.expandedSlot = null; this.prune(tabs);
    if (activeId) this.activate(activeId, tabs);
  }
  activate(id, tabs) {
    this.prune(tabs); if (!tabs.some(t => t.id === id)) return false;
    const existing = this.slots().find(s => s.id === id);
    if (this.layout === 'operations-wall') {
      if (existing) this.wallFocus = Number(existing.slot.slice(5));
      else {
        this.wallFocus = Math.min(this.wallFocus, this.wallCount - 1);
        const hidden = this.wallIds.indexOf(id), previous = this.wallIds[this.wallFocus];
        this.wallIds[this.wallFocus] = id;
        if (hidden >= 0) this.wallIds[hidden] = previous;
      }
    } else if (!existing || ['classic', 'focus'].includes(this.layout)) this.primaryId = id;
    if (this.expandedSlot) this.expandedSlot = this.slots().find(s => s.id === id)?.slot || null;
    return true;
  }
  pin(slot, id, tabs) {
    if (!this.slots().some(s => s.slot === slot)) throw new Error('That pane is not available in this layout.');
    const tab = tabs.find(t => t.id === id);
    if (id != null && !tab) throw new Error('Choose an existing open tab.');
    if (slot === 'dossier' && id != null && !incident(tab)) throw new Error('The dossier requires an existing Incident Workspace tab.');
    const assigned = this.layout === 'operations-wall' ? this.wallIds.map((value, i) => ({ slot: `wall-${i}`, id: value })) : this.slots();
    const previous = this.read(slot), other = assigned.find(s => s.slot !== slot && s.id === id && id != null);
    this.write(slot, id);
    if (other) this.write(other.slot, other.slot === 'dossier' && !incident(tabs.find(t => t.id === previous)) ? null : previous);
    this.prune(tabs);
  }
  remove(id) {
    for (const slot of ['primary', 'companion', 'dossier', 'wall-0', 'wall-1', 'wall-2', 'wall-3']) if (this.read(slot) === id) this.write(slot, null);
  }
}

/** Single owner of tab placement, visibility callbacks, focus scheduling and fit. */
export class WorkspaceLayout {
  constructor(app) {
    this.app = app; this.model = new WorkspaceLayoutModel(); this.visible = new Set(); this.paneNodes = new Map();
    this.floating = new Map(); this.external = new Map();
    this.geometry = normalizeWorkspaceGeometry(app.settings.workspaceGeometry);
    this.contextHidden = { classic: true, workbench: false, 'incident-desk': true, 'operations-wall': true, focus: true };
    this.focusGeneration = 0; this.borrowed = null;
    this.layoutAction = null; this.popoutAction = null; this.singleLayout = 'classic';
    this.layoutSelect = h('select.input.workspace-layout-select', { 'aria-label': 'Workspace layout', title: 'Workspace layout', onchange: async () => {
      const chosen = this.layoutSelect.value; this.layoutSelect.disabled = true;
      try { await app.saveSettings({ uiLayout: chosen }); } catch (error) { this.layoutSelect.value = this.model.layout; toast(errMsg(error), 'err'); }
      finally { this.layoutSelect.disabled = false; }
    } }, Object.entries(APP_LAYOUTS).map(([id, value]) => h('option', { value: id }, value.label)));
    app.toolbar.insertBefore(this.layoutSelect, app.themeHeader);
    this.target = h('span.workspace-target', { role: 'status' });
    this.contextToggle = h('button.btn.sm.workspace-context-toggle', { onclick: () => this.toggleContext() }, 'Context');
    this.sessionToggle = h('button.btn.sm.workspace-sessions-toggle', { onclick: () => app.toggleSidebar() }, 'Sessions');
    this.wallCount = h('select.input.workspace-wall-count', { 'aria-label': 'Operations Wall pane count', onchange: () => this.requestPlacement(() => this.setPaneCount(Number(this.wallCount.value))) }, [1, 2, 3, 4].map(n => h('option', { value: n }, `${n} pane${n === 1 ? '' : 's'}`)));
    this.restoreButton = h('button.btn.sm', { onclick: () => this.requestPlacement(() => this.expand(null)) }, 'Restore panes');
    this.splitButton = h('button.btn.sm.workspace-split-active', { type: 'button', 'data-action': 'split-screen',
      title: 'Show two open views. Drag the divider to resize; narrow windows stack the panes.', onclick: () => this.split() }, 'Split screen');
    this.singleButton = h('button.btn.sm.workspace-single-active', { type: 'button', 'data-action': 'single-view',
      title: 'Return to one docked view without closing other tabs', onclick: () => this.singleView() }, 'Single view');
    this.popoutButton = h('button.btn.sm.workspace-popout-active', { type: 'button', 'data-action': 'popout-active',
      onclick: () => this.popoutActive() }, 'Pop out');
    this.floatButton = h('button.btn.sm.workspace-float-active', { onclick: () => this.requestPlacement(() => this.app.active && this.float(this.app.active)) }, 'Float panel');
    this.resetButton = h('button.btn.sm.workspace-reset', { onclick: () => this.requestPlacement(() => this.reset()) }, 'Reset workspace');
    this.bar = h('div.workspace-bar', this.sessionToggle, this.contextToggle, this.wallCount, this.restoreButton,
      this.splitButton, this.singleButton, this.popoutButton, this.floatButton, this.resetButton, this.target);
    app.main.insertBefore(this.bar, app.tabstrip);
    this.navigationTitle = h('strong', 'Case navigation');
    this.navigationHint = h('p.hint', 'Choose an existing Incident Workspace in the dossier pane. Its saved cases will appear here.');
    this.navigation = h('aside.workspace-navigation', { 'aria-label': 'Incident case navigation' }, this.navigationTitle, this.navigationHint);
    for (const event of ['pointerdown', 'focusin']) this.navigation.addEventListener(event, () => {
      if (this.borrowed && this.app.active !== this.borrowed.tab) this.app.activate(this.borrowed.tab, { focus: false });
    });
    this.contextTitle = h('div.workspace-context-title'); this.contextStatus = h('div.workspace-context-status');
    this.jobs = h('div.workspace-job-list');
    this.context = h('aside.workspace-context', { 'aria-label': 'Active view context and running work' },
      h('div.workspace-context-head', 'Context', h('button.btn.sm', { 'aria-label': 'Collapse context', onclick: () => this.toggleContext() }, icon('x'))),
      h('div.workspace-context-body', this.contextTitle, this.contextStatus, h('strong', 'Running work'), this.jobs));
    this.panes = h('div.workspace-panes'); this.parking = h('div.workspace-parking', { 'aria-hidden': 'true' });
    this.panes.addEventListener('scroll', () => this._positionSplitters(), { passive: true });
    this.floatLayer = h('div.workspace-float-layer');
    this.shell = h('div.workspace-shell', this.navigation, this.panes, this.context);
    app.views.append(this.shell, this.floatLayer, this.parking);
    this.resize = new ResizeObserver(() => this.refit()); this.resize.observe(app.views);
    this.set(app.settings.uiLayout);
  }
  get() {
    return { layout: this.model.layout, primaryId: this.model.primaryId, companionId: this.model.companionId, dossierId: this.model.dossierId,
      wallIds: [...this.model.wallIds], wallCount: this.model.wallCount, focusedId: this.app.active?.id || null, expandedSlot: this.model.expandedSlot,
      floatingIds: [...this.floating.keys()].map(tab => tab.id), externalIds: [...this.external.keys()].map(tab => tab.id),
      geometry: normalizeWorkspaceGeometry(this.geometry),
      visibleIds: [...this.visible].map(t => t.id) };
  }
  set(id) {
    this.gesture?.cancel();
    const next = normalizeLayout(id), prior = this.model.layout;
    if (prior !== 'focus' && next === 'focus') { this.sidebarBeforeFocus = this.app.root.classList.contains('no-sidebar'); this.app.root.classList.add('no-sidebar'); }
    else if (prior === 'focus' && next !== 'focus') this.app.root.classList.toggle('no-sidebar', !!this.sidebarBeforeFocus);
    if (prior !== next) this.model.set(next, this._dockable(), this.placement(this.app.active) === 'docked' ? this.app.active?.id : null);
    else this.model.prune(this._dockable());
    this.app.root.dataset.layout = next; this.layoutSelect.value = next;
    if (next === 'focus') { if (this.app.tabstrip !== this.app.main.lastElementChild) this.app.main.append(this.app.tabstrip); }
    else if (this.app.tabstrip.nextElementSibling !== this.app.views) this.app.main.insertBefore(this.app.tabstrip, this.app.views);
    this.refresh(); this.app.scheduleTabLayout(true);
  }
  mount(tab) { tab.active = false; tab.el.inert = true; this.parking.append(tab.el); }
  activate(tab) {
    if (this.placement(tab) === 'docked') this.model.activate(tab.id, this._dockable());
    if (this.floating.has(tab)) this._raise(tab);
    this.refresh();
  }
  _dockable() { return this.app.tabs.filter(tab => !this.floating.has(tab) && !this.external.has(tab)); }
  placement(tab) { return this.external.has(tab) ? 'external' : this.floating.has(tab) ? 'floating' : 'docked'; }
  requestPlacement(action) {
    // Only user controls pass through this gate. Internal docking and native
    // cleanup must remain available while a layout action owns the transition.
    if (this.layoutAction || this.popoutAction) return false;
    return action();
  }
  async split(tab = this.app.active) {
    if (this.layoutAction || this.popoutAction || !tab || tab.disposed || !this.app.tabs.includes(tab)) return false;
    this.gesture?.cancel();
    const action = {}; this.layoutAction = action; this.updateActions();
    this.layoutSelect.disabled = true;
    const previous = this.model.layout;
    try {
      // Persist the requested layout before moving any live view. A failed
      // write leaves its placement and connection completely unchanged.
      if (previous !== 'workbench') await this.app.saveSettings({ uiLayout: 'workbench' });
      if (this.model.layout === 'workbench' && previous !== 'workbench') this.singleLayout = ['classic', 'focus'].includes(previous) ? previous : 'classic';
      if (this.layoutAction !== action || tab.disposed || !this.app.tabs.includes(tab) || this.model.layout !== 'workbench') return false;
      // A later Split choice supersedes an unfinished tab-menu pop-out.
      // The existing native owner closes any permit that arrives afterward.
      if (this.app.popouts?.pending?.has(tab.id)) this.app.popouts.dock(tab);
      const shown = this.model.slots().find(slot => slot.id === tab.id);
      const other = this._dockable().find(item => item !== tab && this.model.slots().some(slot => slot.id === item.id));
      this.contextHidden.workbench = true;
      this.model.expandedSlot = null;
      if (previous === 'workbench' && shown && other) {
        // Repeated Split requests preserve the existing pair and its order.
        this.app.activate(tab, { focus: false });
      } else {
        const candidates = this._dockable().filter(item => item !== tab && !item.disposed && item.kind !== 'welcome');
        const companion = (previous === 'workbench' && other) || candidates.find(item => item.kind === 'terminal') || candidates[0];
        if (!await this.dock(tab, 'primary')) return false;
        if (tab.disposed || !this.app.tabs.includes(tab) || this.model.layout !== 'workbench') return false;
        const available = companion && !companion.disposed && this._dockable().includes(companion);
        this.model.pin('companion', available ? companion.id : null, this._dockable());
        this.app.activate(tab, { focus: false });
      }
      this.refresh();
      return true;
    } catch (error) {
      toast('Could not split the workspace: ' + errMsg(error), 'err'); return false;
    } finally {
      if (this.layoutAction === action) this.layoutAction = null;
      this.layoutSelect.disabled = false;
      this.updateActions();
    }
  }
  async singleView() {
    if (this.layoutAction || this.popoutAction) return false;
    this.gesture?.cancel();
    const action = {}; this.layoutAction = action; this.updateActions();
    this.layoutSelect.disabled = true;
    try {
      await this.app.saveSettings({ uiLayout: this.singleLayout });
      return true;
    } catch (error) {
      toast('Could not return to a single view: ' + errMsg(error), 'err'); return false;
    } finally {
      if (this.layoutAction === action) this.layoutAction = null;
      this.layoutSelect.disabled = false;
      this.updateActions();
    }
  }
  async popoutActive(tab = this.app.active) {
    if (this.layoutAction || this.popoutAction || !tab || tab.disposed || !this.app.tabs.includes(tab)) return false;
    const action = {}; this.popoutAction = action; this.updateActions();
    try {
      if (this.external.has(tab)) { await this.app.popouts.dock(tab); return true; }
      return await this.app.popouts.open(tab);
    } catch (error) {
      toast('Could not move this view: ' + errMsg(error), 'err'); return false;
    } finally {
      if (this.popoutAction === action) this.popoutAction = null;
      this.updateActions();
    }
  }
  updateActions() {
    const tab = this.app.active, available = tab && !tab.disposed && this.app.tabs.includes(tab);
    const busy = Boolean(this.layoutAction || this.popoutAction);
    this.splitButton.disabled = !available || busy;
    this.singleButton.disabled = busy;
    this.singleButton.classList.toggle('hidden', this.model.layout !== 'workbench');
    this.popoutButton.disabled = !available || busy;
    const external = available && this.external.has(tab);
    this.popoutButton.textContent = external ? 'Dock back' : 'Pop out';
    this.popoutButton.title = external ? 'Return the active window to KonX without reconnecting'
      : 'Move the active view to its own window; drag its title bar to another monitor';
    this.popoutButton.setAttribute('aria-label', external ? 'Dock active window back to KonX' : 'Pop out active view');
    this.floatButton.disabled = !available || busy || this.placement(tab) !== 'docked';
    this.resetButton.disabled = this.restoreButton.disabled = busy;
    this.wallCount.disabled = busy;
    for (const handle of Object.values(this.splitters || {})) handle.setAttribute('aria-disabled', String(busy));
    for (const [slot, pane] of this.paneNodes) {
      const empty = !this.model.read(slot);
      pane.select.disabled = busy;
      pane.float.disabled = pane.popout.disabled = pane.expand.disabled = busy || empty;
    }
    for (const entry of this.floating.values()) {
      for (const control of entry.head.querySelectorAll('[data-placement-control]')) control.disabled = busy;
    }
    for (const entry of this.external.values()) {
      if (!entry.window.closed) for (const control of entry.window.document.querySelectorAll('.popout-header [data-placement-control]')) control.disabled = busy;
    }
  }
  pin(slot, id) {
    try {
      this.model.pin(slot, id || null, this._dockable());
      const selected = this.app.tabs.find(t => t.id === id);
      if (selected) this.app.activate(selected, { focus: false });
      else if (!this.model.slots().some(s => s.id === this.app.active?.id)) {
        const next = this.app.tabs.find(t => this.model.slots().some(s => s.id === t.id)) || this.app.tabs[0];
        if (next) this.app.activate(next, { focus: false }); else this.refresh();
      } else this.refresh();
      return true;
    } catch (error) { toast(errMsg(error), 'err'); this.refresh(); return false; }
  }
  focus(slot) { const tab = this.app.tabs.find(t => t.id === this.model.read(slot)); if (tab) this.app.activate(tab); }
  expand(slot) {
    if (slot && !this.model.slots().some(s => s.slot === slot && s.id)) return;
    this.model.expandedSlot = this.model.expandedSlot === slot ? null : slot;
    if (slot) this.focus(slot); else this.refresh();
  }
  setPaneCount(count) {
    if (![1, 2, 3, 4].includes(count)) return;
    this.model.wallCount = count; this.model.expandedSlot = null;
    if (this.model.layout === 'operations-wall' && this.app.active && this.placement(this.app.active) === 'docked') this.model.activate(this.app.active.id, this._dockable());
    this.refresh();
  }
  toggleContext() { this.contextHidden[this.model.layout] = !this.contextHidden[this.model.layout]; this.refresh(); }
  _viewport() { return { width: this.app.views.clientWidth, height: this.app.views.clientHeight }; }
  _rememberGeometry() {
    const value = normalizeWorkspaceGeometry(this.geometry);
    this.app.settings.workspaceGeometry = value;
    // Serialize writes so finishing an earlier disk save cannot overwrite a
    // later gesture. Never serialize tabs or their connection specifications.
    this.saveGeometry = (this.saveGeometry || Promise.resolve()).catch(() => {}).then(() => api.invoke('settings:set', { workspaceGeometry: value }))
      .catch(error => toast('Could not save workspace geometry: ' + errMsg(error), 'err'));
  }
  _raise(tab) {
    const entry = this.floating.get(tab); if (!entry) return;
    this.floating.delete(tab); this.floating.set(tab, entry);
    let z = 1; for (const item of this.floating.values()) item.el.style.zIndex = String(z++);
  }
  _setFloatBounds(entry, bounds, refit = true) {
    entry.bounds = clampFloatBounds(bounds, this._viewport());
    const { x, y, width, height } = entry.bounds;
    Object.assign(entry.el.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
    if (refit) this.refit();
  }
  _gesture(event, element, update, finish) {
    if (event.button !== 0 || this.gesture || this.layoutAction || this.popoutAction) return;
    event.preventDefault(); this.cancelFocus();
    const owner = element.ownerDocument.defaultView, pointer = event.pointerId;
    const move = next => { if (next.pointerId === pointer) update(next); };
    const end = (next, cancelled = false) => {
      if (next?.pointerId != null && next.pointerId !== pointer) return;
      owner.removeEventListener('pointermove', move); owner.removeEventListener('pointerup', done);
      owner.removeEventListener('pointercancel', cancel); owner.removeEventListener('keydown', key); owner.removeEventListener('blur', cancel);
      element.removeEventListener('lostpointercapture', cancel);
      this.gesture = null;
      try { if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer); } catch {}
      document.documentElement.classList.remove('workspace-gesturing'); finish(cancelled);
    };
    const done = next => end(next), cancel = next => end(next, true);
    const key = next => { if (next.key === 'Escape') { next.preventDefault(); cancel(); } };
    this.gesture = { cancel: () => cancel() };
    owner.addEventListener('pointermove', move); owner.addEventListener('pointerup', done); owner.addEventListener('pointercancel', cancel);
    owner.addEventListener('keydown', key); owner.addEventListener('blur', cancel); element.addEventListener('lostpointercapture', cancel);
    try { element.setPointerCapture(pointer); } catch {}
    document.documentElement.classList.add('workspace-gesturing');
  }
  float(tab, bounds) {
    if (!tab || !this.app.tabs.includes(tab)) return false;
    if (this.external.has(tab)) return Promise.resolve(this.app.popouts?.dock(tab)).then(() => this.external.has(tab) ? false : this.float(tab, bounds));
    if (this.floating.has(tab)) {
      const entry = this.floating.get(tab);
      if (bounds && !entry.maximized) {
        this._setFloatBounds(entry, bounds); this.geometry.lastFloatRect = contractFloatBounds(entry.bounds, this._viewport()); this._rememberGeometry();
      }
      this.app.activate(tab); return true;
    }
    const previousSlot = this.model.slots().find(slot => slot.id === tab.id)?.slot;
    this.model.remove(tab.id);
    if (this.borrowed?.tab === tab) this.restoreLibrary();
    const title = h('span.workspace-float-title', tab.title);
    const maximize = h('button.btn.sm', { 'data-placement-control': 'true', 'aria-label': 'Maximize floating panel', onclick: () => this.requestPlacement(() => this.maximize(tab)) }, 'Maximize');
    const body = h('div.workspace-pane-body');
    const head = h('div.workspace-pane-head.workspace-float-head', title,
      h('button.btn.sm', { 'data-placement-control': 'true', onclick: () => this.requestPlacement(() => this.dock(tab)), 'aria-label': 'Dock floating panel' }, 'Dock'),
      h('button.btn.sm', { 'data-placement-control': 'true', onclick: () => this.requestPlacement(() => this.app.popouts?.open(tab)), 'aria-label': 'Pop out floating panel' }, 'Pop out'), maximize,
      h('button.btn.sm', { onclick: () => this.app.closeTab(tab), 'aria-label': 'Close panel tab' }, icon('x')));
    const el = h('section.workspace-pane.workspace-floating', { 'aria-label': 'Floating panel: ' + tab.title, 'data-tab-id': tab.id }, head, body);
    const entry = { el, head, title, body, maximize, previousSlot, bounds: null, maximized: false };
    this.floating.set(tab, entry); this.floatLayer.append(el); body.append(tab.el);
    head.addEventListener('pointerdown', event => {
      if (event.target.closest('button,select,input') || entry.maximized) return;
      const initial = { ...entry.bounds }, startX = event.clientX, startY = event.clientY;
      this.app.activate(tab, { focus: false });
      this._gesture(event, head, next => this._setFloatBounds(entry, { ...initial, x: initial.x + next.clientX - startX, y: initial.y + next.clientY - startY }), cancelled => {
        if (cancelled) this._setFloatBounds(entry, initial);
        else { this.geometry.lastFloatRect = contractFloatBounds(entry.bounds, this._viewport()); this._rememberGeometry(); }
      });
    });
    head.addEventListener('dblclick', event => { if (!event.target.closest('button,select,input')) this.requestPlacement(() => this.maximize(tab)); });
    for (const edge of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']) {
      const handle = h('div.workspace-float-resize', { 'data-edge': edge, 'aria-hidden': 'true' }); el.append(handle);
      handle.addEventListener('pointerdown', event => {
        if (entry.maximized) return;
        const initial = { ...entry.bounds }, startX = event.clientX, startY = event.clientY;
        this.app.activate(tab, { focus: false });
        this._gesture(event, handle, next => {
          const viewport = this._viewport(), minW = Math.min(300, viewport.width), minH = Math.min(220, viewport.height);
          let left = initial.x, right = initial.x + initial.width, top = initial.y, bottom = initial.y + initial.height;
          if (edge.includes('w')) left = Math.max(0, Math.min(right - minW, initial.x + next.clientX - startX));
          if (edge.includes('e')) right = Math.min(viewport.width, Math.max(left + minW, initial.x + initial.width + next.clientX - startX));
          if (edge.includes('n')) top = Math.max(0, Math.min(bottom - minH, initial.y + next.clientY - startY));
          if (edge.includes('s')) bottom = Math.min(viewport.height, Math.max(top + minH, initial.y + initial.height + next.clientY - startY));
          this._setFloatBounds(entry, { x: left, y: top, width: right - left, height: bottom - top });
        }, cancelled => {
          if (cancelled) this._setFloatBounds(entry, initial);
          else { this.geometry.lastFloatRect = contractFloatBounds(entry.bounds, this._viewport()); this._rememberGeometry(); }
        });
      });
    }
    for (const name of ['pointerdown', 'focusin']) body.addEventListener(name, () => { if (this.app.active !== tab) this.app.activate(tab, { focus: false }); });
    this._setFloatBounds(entry, bounds || expandFloatBounds(this.geometry.lastFloatRect, this._viewport()));
    this.geometry.lastFloatRect = contractFloatBounds(entry.bounds, this._viewport());
    this.app.activate(tab, { focus: false }); this._rememberGeometry(); return true;
  }
  maximize(tab) {
    const entry = this.floating.get(tab); if (!entry) return;
    this.gesture?.cancel();
    if (!entry.maximized) { entry.restoreBounds = { ...entry.bounds }; entry.maximized = true; this._setFloatBounds(entry, { x: 0, y: 0, ...this._viewport() }); }
    else { entry.maximized = false; this._setFloatBounds(entry, entry.restoreBounds); }
    entry.el.classList.toggle('workspace-maximized', entry.maximized);
    entry.maximize.textContent = entry.maximized ? 'Restore' : 'Maximize';
    entry.maximize.setAttribute('aria-label', entry.maximized ? 'Restore floating panel' : 'Maximize floating panel');
    this.app.activate(tab, { focus: false });
  }
  _dockSlot(tab, preferred) {
    const slots = this.model.slots();
    const valid = slot => slots.some(item => item.slot === slot) && (slot !== 'dossier' || incident(tab));
    return valid(preferred) ? preferred : slots.find(item => !item.id && valid(item.slot))?.slot || slots.find(item => valid(item.slot))?.slot;
  }
  dock(tab, slot) {
    if (!tab || !this.app.tabs.includes(tab)) return false;
    if (this.external.has(tab)) return Promise.resolve(this.app.popouts?.dock(tab)).then(() => this.external.has(tab) ? false : this.dock(tab, slot));
    this.gesture?.cancel();
    const entry = this.floating.get(tab), target = this._dockSlot(tab, slot || entry?.previousSlot);
    if (!target) return false;
    if (entry) { this.parking.append(tab.el); entry.el.remove(); this.floating.delete(tab); }
    this.model.pin(target, tab.id, this._dockable()); this.app.activate(tab, { focus: false }); this._rememberGeometry(); return true;
  }
  attachExternal(tab, { body, window: child }) {
    if (!tab || !this.app.tabs.includes(tab) || !body || !child) return false;
    this.gesture?.cancel();
    const entry = this.floating.get(tab), previousSlot = entry?.previousSlot || this.model.slots().find(slot => slot.id === tab.id)?.slot;
    if (this.borrowed?.tab === tab) this.restoreLibrary();
    this.model.remove(tab.id); body.append(tab.el);
    if (entry) { entry.el.remove(); this.floating.delete(tab); }
    this.external.set(tab, { body, window: child, previousSlot });
    this.refresh(); return true;
  }
  releaseExternal(tab) {
    const entry = this.external.get(tab); if (!entry) return false;
    this.external.delete(tab); this.parking.append(tab.el);
    if (this.app.tabs.includes(tab)) {
      const target = this._dockSlot(tab, entry.previousSlot);
      if (target) this.model.pin(target, tab.id, this._dockable());
    }
    this.refresh(); return true;
  }
  async reset() {
    this.gesture?.cancel();
    try { for (const tab of [...this.external.keys()]) await this.app.popouts?.dock(tab); }
    catch (error) { toast('Could not dock a window: ' + errMsg(error), 'err'); return; }
    this.geometry = normalizeWorkspaceGeometry(null);
    for (const tab of [...this.floating.keys()]) this.dock(tab);
    this.model.expandedSlot = null; this.model.wallCount = 4;
    this.refresh(); this._rememberGeometry();
  }
  pane(slot) {
    if (this.paneNodes.has(slot)) return this.paneNodes.get(slot);
    const title = h('span', label(slot));
    const select = h('select.input.workspace-pane-select', { 'aria-label': `${label(slot)}: choose an open tab`, onchange: () => this.requestPlacement(() => this.pin(slot, select.value)) });
    const focus = h('button.btn.sm.workspace-pane-focus', { onclick: () => this.focus(slot) }, 'Focus');
    const expand = h('button.btn.sm.workspace-pane-expand', { onclick: () => this.requestPlacement(() => this.expand(slot)) }, 'Expand');
    const float = h('button.btn.sm.workspace-pane-float', { onclick: () => this.requestPlacement(() => this.float(this.app.tabs.find(tab => tab.id === this.model.read(slot)))) }, 'Float');
    const popout = h('button.btn.sm.workspace-pane-popout', { onclick: () => this.requestPlacement(() => { const tab = this.app.tabs.find(tab => tab.id === this.model.read(slot)); if (tab) this.app.popouts?.open(tab); }) }, 'Pop out');
    const head = h('div.workspace-pane-head', title, select, focus, expand, float, popout);
    const empty = h('div.workspace-empty', h('p', slot === 'dossier' ? 'Choose an existing Incident Workspace above. Opening or pinning a view never adds evidence.'
      : 'Choose an open tab above, or open another connection with Quick connect and choose it here. Drag the divider to resize. Narrow windows stack the panes; widen KonX for side-by-side views.'));
    const body = h('div.workspace-pane-body', empty);
    const el = h('section.workspace-pane', { 'data-slot': slot, 'aria-label': label(slot) }, head, body);
    el.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('text/x-konx-tab')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; el.classList.add('workspace-drop-target'); } });
    el.addEventListener('dragleave', event => { if (!el.contains(event.relatedTarget)) el.classList.remove('workspace-drop-target'); });
    el.addEventListener('drop', event => {
      el.classList.remove('workspace-drop-target');
      if (!event.dataTransfer?.types.includes('text/x-konx-tab')) return;
      event.preventDefault(); event.stopPropagation();
      const tab = this.app.tabs.find(item => item.id === event.dataTransfer.getData('text/x-konx-tab'));
      if (!tab || (slot === 'dossier' && !incident(tab))) return;
      Promise.resolve(this.requestPlacement(() => this.dock(tab, slot))).catch(error => toast(errMsg(error), 'err'));
    });
    if (slot === 'companion') el.classList.add('workspace-companion');
    if (slot === 'dossier') el.classList.add('workspace-dossier');
    for (const event of ['pointerdown', 'focusin']) body.addEventListener(event, () => {
      const tab = this.app.tabs.find(t => t.id === this.model.read(slot));
      if (tab && this.app.active !== tab) this.app.activate(tab, { focus: false });
    });
    const pane = { el, head, title, select, focus, expand, float, popout, body, empty, optionSignature: null };
    this.paneNodes.set(slot, pane); this.panes.append(el); return pane;
  }
  restoreLibrary() {
    if (!this.borrowed) return;
    const { node, parent, next } = this.borrowed;
    parent.insertBefore(node, next?.parentElement === parent ? next : null); this.borrowed = null;
  }
  updateLibrary() {
    const tab = this.model.layout === 'incident-desk' ? this.app.tabs.find(t => t.id === this.model.dossierId) : null;
    if (this.borrowed?.tab !== tab) this.restoreLibrary();
    if (tab && !this.borrowed) {
      const node = tab.el.querySelector('.incident-library');
      if (node) { this.borrowed = { tab, node, parent: node.parentElement, next: node.nextSibling }; this.navigation.append(node); }
    }
    this.navigationHint.classList.toggle('hidden', !!this.borrowed);
  }
  refresh() {
    this.model.prune(this._dockable());
    const slots = this.model.slots(), nextVisible = new Set();
    this.updateLibrary();
    this.app.root.classList.toggle('context-collapsed', this.contextHidden[this.model.layout]);
    this.app.root.classList.toggle('workspace-expanded', !!this.model.expandedSlot);
    this.panes.dataset.count = String(this.model.expandedSlot ? 1 : slots.length);
    this.panes.dataset.expandedSlot = this.model.expandedSlot || '';
    for (const [slot, pane] of this.paneNodes) if (!slots.some(s => s.slot === slot)) pane.el.classList.add('hidden');
    for (const { slot, id } of slots) {
      const pane = this.pane(slot), tab = this.app.tabs.find(t => t.id === id), shown = !this.model.expandedSlot || this.model.expandedSlot === slot;
      pane.el.classList.toggle('hidden', !shown); pane.el.dataset.expanded = String(this.model.expandedSlot === slot);
      pane.el.classList.toggle('workspace-focused', !!tab && tab === this.app.active);
      pane.focus.disabled = pane.expand.disabled = pane.float.disabled = pane.popout.disabled = !tab; pane.focus.textContent = tab === this.app.active ? 'Focused' : 'Focus';
      pane.expand.textContent = this.model.expandedSlot === slot ? 'Restore' : 'Expand';
      pane.empty.classList.toggle('hidden', !!tab);
      const choices = this._dockable().filter(t => slot !== 'dossier' || incident(t));
      const signature = JSON.stringify(choices.map(t => [t.id, t.title]));
      if (pane.optionSignature !== signature) {
        pane.select.replaceChildren(h('option', { value: '' }, 'Choose open tab…'), ...choices.map(t => h('option', { value: t.id }, t.title)));
        pane.optionSignature = signature;
      }
      pane.select.value = id || '';
      if (tab && shown) { nextVisible.add(tab); if (tab.el.parentElement !== pane.body) pane.body.append(tab.el); }
    }
    for (const [tab, entry] of this.floating) {
      if (!this.app.tabs.includes(tab)) continue;
      nextVisible.add(tab); entry.title.textContent = tab.title; entry.el.setAttribute('aria-label', 'Floating panel: ' + tab.title);
      entry.el.classList.toggle('workspace-focused', tab === this.app.active);
      if (tab.el.parentElement !== entry.body) entry.body.append(tab.el);
    }
    for (const [tab, entry] of this.external) {
      if (!this.app.tabs.includes(tab)) continue;
      nextVisible.add(tab);
      if (tab.el.parentElement !== entry.body) entry.body.append(tab.el);
    }
    for (const tab of this.visible) if (!nextVisible.has(tab)) { tab.hide?.(); tab.active = false; }
    for (const tab of this.app.tabs) {
      const visible = nextVisible.has(tab);
      tab.el.classList.toggle('active', visible); tab.el.classList.toggle('workspace-visible', visible);
      tab.el.classList.toggle('workspace-focused', visible && tab === this.app.active); tab.el.inert = !visible;
      if (!visible && tab.el.parentElement !== this.parking) this.parking.append(tab.el);
      if (visible && !this.visible.has(tab)) tab.show?.({ focus: false });
    }
    this.visible = nextVisible;
    this.contextToggle.classList.toggle('hidden', !['workbench', 'focus'].includes(this.model.layout));
    this.contextToggle.textContent = this.contextHidden[this.model.layout] ? 'Show context' : 'Hide context';
    this.sessionToggle.textContent = this.app.root.classList.contains('no-sidebar') ? 'Show sessions' : 'Hide sessions';
    this.wallCount.classList.toggle('hidden', this.model.layout !== 'operations-wall'); this.wallCount.value = String(this.model.wallCount);
    this.restoreButton.classList.toggle('hidden', !this.model.expandedSlot);
    this.floatButton.disabled = !this.app.active || this.placement(this.app.active) !== 'docked';
    this.updateActions();
    this.updateContext(); this.refit();
  }
  updateContext() {
    const tab = this.app.active, all = !!this.app.cmdAll?.checked;
    const target = all ? `Command target: ALL connected terminals (${this.app.tabs.filter(t => t.kind === 'terminal' && t.state === 'connected').length})` : tab?.kind === 'terminal' ? `Command target: ${tab.title} (${tab.state})` : 'Command target: no terminal selected';
    this.target.textContent = target; this.target.title = target;
    if (this.app.cmdTarget) { this.app.cmdTarget.textContent = target; this.app.cmdTarget.title = target; }
    this.contextTitle.textContent = tab?.title || 'No focused view';
    this.contextStatus.textContent = tab ? [tab.toolKind || tab.kind, tab.state, ...(tab.statusSegments?.() || []).map(s => s.text)].filter(Boolean).join('\n') : '';
    const jobs = [...new Set([...this.app.jobs.values(), ...this.app.tabs.filter(t => t.state === 'running' || t.jobId || t.busy)].map(owner => owner.panel || owner))]
      .filter(t => this.app.tabs.includes(t) || t === this.app.copilot?.panel);
    const signature = JSON.stringify(jobs.map(t => [t.id, t.title, t.state]));
    if (signature !== this.jobSignature) {
      this.jobSignature = signature;
      this.jobs.replaceChildren(...(jobs.length ? jobs.map(t => h('button.workspace-job', { onclick: () => this.app.tabs.includes(t) ? this.app.activate(t) : this.app.openCopilot() }, icon(t.icon || 'activity'), h('span', t.title))) : [h('p.hint', 'No running work.')]));
    }
  }
  _applyGeometry() {
    const layout = this.model.layout, ratio = this.geometry.ratios[layout], narrow = innerWidth <= 1150;
    const slots = this.model.slots();
    let columns = null, rows = null;
    this.splitAxes = [];
    if (ratio && !this.model.expandedSlot && slots.length > 1) {
      const width = Math.max(1, this.panes.clientWidth - 24), height = Math.max(1, this.panes.clientHeight - 24);
      if (narrow) {
        const total = Math.max(height, slots.length * 320), first = Math.max(220, total * ratio.rows);
        rows = `${first}px repeat(${slots.length - 1}, minmax(220px, ${(total - first) / (slots.length - 1)}px))`;
        columns = 'minmax(0,1fr)'; this.splitAxes = ['rows']; this.splitSizes = { rows: total };
      } else {
        columns = `minmax(220px,${ratio.columns}fr) minmax(220px,${1 - ratio.columns}fr)`;
        this.splitAxes = ['columns']; this.splitSizes = { columns: Math.max(440, width) };
        if (layout === 'operations-wall' && slots.length > 2) {
          rows = `minmax(180px,${ratio.rows}fr) minmax(180px,${1 - ratio.rows}fr)`;
          this.splitAxes.push('rows'); this.splitSizes.rows = Math.max(360, height);
        } else rows = 'minmax(0,1fr)';
      }
    }
    this.panes.style.gridTemplateColumns = columns || '';
    this.panes.style.gridTemplateRows = rows || '';
    for (const axis of ['columns', 'rows']) {
      let handle = this.splitters?.[axis];
      if (!handle) {
        handle = h('div.workspace-splitter', { 'data-axis': axis, role: 'separator', tabindex: '0',
          'aria-label': axis === 'columns' ? 'Resize workspace columns' : 'Resize workspace rows', 'aria-orientation': axis === 'columns' ? 'vertical' : 'horizontal' });
        (this.splitters ||= {})[axis] = handle; this.panes.append(handle);
        handle.addEventListener('pointerdown', event => {
          const ratios = this.geometry.ratios[this.model.layout]; if (!ratios || !this.splitAxes.includes(axis)) return;
          const initial = ratios[axis], start = axis === 'columns' ? event.clientX : event.clientY, total = this.splitSizes[axis];
          this._gesture(event, handle, next => {
            ratios[axis] = Math.max(0.2, Math.min(0.8, initial + ((axis === 'columns' ? next.clientX : next.clientY) - start) / total)); this.refit();
          }, cancelled => { if (cancelled) { ratios[axis] = initial; this.refit(); } else this._rememberGeometry(); });
        });
        handle.addEventListener('keydown', event => {
          if (this.layoutAction || this.popoutAction) return;
          const ratios = this.geometry.ratios[this.model.layout]; if (!ratios || !this.splitAxes.includes(axis)) return;
          const positive = axis === 'columns' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
          const negative = axis === 'columns' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
          if (!positive && !negative && !['Home', 'End'].includes(event.key)) return;
          event.preventDefault(); ratios[axis] = event.key === 'Home' ? 0.2 : event.key === 'End' ? 0.8 : Math.max(0.2, Math.min(0.8, ratios[axis] + (positive ? 0.025 : -0.025)));
          this.refit(); this._rememberGeometry();
        });
      }
      handle.classList.toggle('hidden', !this.splitAxes.includes(axis));
      handle.setAttribute('aria-valuemin', '20'); handle.setAttribute('aria-valuemax', '80'); handle.setAttribute('aria-valuenow', String(Math.round((ratio?.[axis] || 0.5) * 100)));
    }
    this._positionSplitters();
    for (const entry of this.floating.values()) this._setFloatBounds(entry, entry.maximized ? { x: 0, y: 0, ...this._viewport() } : entry.bounds, false);
  }
  _positionSplitters() {
    if (!this.splitters) return;
    const slots = this.model.slots(), first = this.paneNodes.get(slots[0]?.slot)?.el;
    if (!first) return;
    const base = this.panes.getBoundingClientRect(), rect = first.getBoundingClientRect();
    const left = rect.left - base.left + this.panes.scrollLeft, top = rect.top - base.top + this.panes.scrollTop;
    const columns = this.splitters.columns, rows = this.splitters.rows;
    Object.assign(columns.style, { left: left + rect.width + 'px', top: top + 'px', width: '8px', height: Math.max(rect.height, this.panes.scrollHeight - 16) + 'px' });
    Object.assign(rows.style, { left: left + 'px', top: top + rect.height + 'px', height: '8px', width: Math.max(rect.width, this.panes.clientWidth - 16) + 'px' });
  }
  refit() {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => { this.fitFrame = 0; this._applyGeometry(); for (const tab of this.visible) tab.refit?.(); });
  }
  focusTarget(tab) {
    if (this.external.has(tab)) { this.app.popouts?.focus(tab); return; }
    const generation = ++this.focusGeneration, previouslyFocused = document.activeElement;
    setTimeout(() => {
      const focusUnchanged = document.activeElement === previouslyFocused || document.activeElement === document.body;
      if (generation === this.focusGeneration && focusUnchanged && this.app.active === tab && this.visible.has(tab) && this.app.tabs.includes(tab) && !tab.disposed && !document.querySelector('.modal-back')) tab.focus?.();
    }, 0);
  }
  cancelFocus() { this.focusGeneration++; }
  detach(tab) {
    this.gesture?.cancel();
    this.cancelFocus();
    this.app.popouts?.disposeTab?.(tab);
    if (this.external.has(tab)) { this.parking.append(tab.el); this.external.delete(tab); }
    const floating = this.floating.get(tab);
    if (floating) { this.parking.append(tab.el); floating.el.remove(); this.floating.delete(tab); }
    if (this.borrowed?.tab === tab) this.restoreLibrary();
    if (this.visible.delete(tab)) { tab.hide?.(); tab.active = false; }
    this.model.remove(tab.id);
  }
}
