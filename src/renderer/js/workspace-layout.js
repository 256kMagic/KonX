import { h, icon, toast, errMsg } from './ui.js';
import { APP_LAYOUTS, normalizeLayout } from './workspace-layouts.mjs';

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
    this.contextHidden = { classic: true, workbench: false, 'incident-desk': true, 'operations-wall': true, focus: true };
    this.focusGeneration = 0; this.borrowed = null;
    this.layoutSelect = h('select.input.workspace-layout-select', { 'aria-label': 'Workspace layout', title: 'Workspace layout', onchange: async () => {
      const chosen = this.layoutSelect.value; this.layoutSelect.disabled = true;
      try { await app.saveSettings({ uiLayout: chosen }); } catch (error) { this.layoutSelect.value = this.model.layout; toast(errMsg(error), 'err'); }
      finally { this.layoutSelect.disabled = false; }
    } }, Object.entries(APP_LAYOUTS).map(([id, value]) => h('option', { value: id }, value.label)));
    app.toolbar.insertBefore(this.layoutSelect, app.themeHeader);
    this.target = h('span.workspace-target', { role: 'status' });
    this.contextToggle = h('button.btn.sm.workspace-context-toggle', { onclick: () => this.toggleContext() }, 'Context');
    this.sessionToggle = h('button.btn.sm.workspace-sessions-toggle', { onclick: () => app.toggleSidebar() }, 'Sessions');
    this.wallCount = h('select.input.workspace-wall-count', { 'aria-label': 'Operations Wall pane count', onchange: () => this.setPaneCount(Number(this.wallCount.value)) }, [1, 2, 3, 4].map(n => h('option', { value: n }, `${n} pane${n === 1 ? '' : 's'}`)));
    this.restoreButton = h('button.btn.sm', { onclick: () => this.expand(null) }, 'Restore panes');
    this.bar = h('div.workspace-bar', this.sessionToggle, this.contextToggle, this.wallCount, this.restoreButton, this.target);
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
    this.shell = h('div.workspace-shell', this.navigation, this.panes, this.context);
    app.views.append(this.shell, this.parking);
    this.resize = new ResizeObserver(() => this.refit()); this.resize.observe(app.views);
    this.set(app.settings.uiLayout);
  }
  get() {
    return { layout: this.model.layout, primaryId: this.model.primaryId, companionId: this.model.companionId, dossierId: this.model.dossierId,
      wallIds: [...this.model.wallIds], wallCount: this.model.wallCount, focusedId: this.app.active?.id || null, expandedSlot: this.model.expandedSlot,
      visibleIds: [...this.visible].map(t => t.id) };
  }
  set(id) {
    const next = normalizeLayout(id), prior = this.model.layout;
    if (prior !== 'focus' && next === 'focus') { this.sidebarBeforeFocus = this.app.root.classList.contains('no-sidebar'); this.app.root.classList.add('no-sidebar'); }
    else if (prior === 'focus' && next !== 'focus') this.app.root.classList.toggle('no-sidebar', !!this.sidebarBeforeFocus);
    if (prior !== next) this.model.set(next, this.app.tabs, this.app.active?.id);
    else this.model.prune(this.app.tabs);
    this.app.root.dataset.layout = next; this.layoutSelect.value = next;
    if (next === 'focus') { if (this.app.tabstrip !== this.app.main.lastElementChild) this.app.main.append(this.app.tabstrip); }
    else if (this.app.tabstrip.nextElementSibling !== this.app.views) this.app.main.insertBefore(this.app.tabstrip, this.app.views);
    this.refresh(); this.app.scheduleTabLayout(true);
  }
  mount(tab) { tab.active = false; tab.el.inert = true; this.parking.append(tab.el); }
  activate(tab) { this.model.activate(tab.id, this.app.tabs); this.refresh(); }
  pin(slot, id) {
    try {
      this.model.pin(slot, id || null, this.app.tabs);
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
    if (this.model.layout === 'operations-wall' && this.app.active) this.model.activate(this.app.active.id, this.app.tabs);
    this.refresh();
  }
  toggleContext() { this.contextHidden[this.model.layout] = !this.contextHidden[this.model.layout]; this.refresh(); }
  pane(slot) {
    if (this.paneNodes.has(slot)) return this.paneNodes.get(slot);
    const title = h('span', label(slot));
    const select = h('select.input.workspace-pane-select', { 'aria-label': `${label(slot)}: choose an open tab`, onchange: () => this.pin(slot, select.value) });
    const focus = h('button.btn.sm.workspace-pane-focus', { onclick: () => this.focus(slot) }, 'Focus');
    const expand = h('button.btn.sm.workspace-pane-expand', { onclick: () => this.expand(slot) }, 'Expand');
    const head = h('div.workspace-pane-head', title, select, focus, expand);
    const empty = h('div.workspace-empty', h('p', slot === 'dossier' ? 'Choose an existing Incident Workspace above. Opening or pinning a view never adds evidence.' : 'Choose an open tab above. Your other tabs remain available in the tab strip.'));
    const body = h('div.workspace-pane-body', empty);
    const el = h('section.workspace-pane', { 'data-slot': slot, 'aria-label': label(slot) }, head, body);
    if (slot === 'companion') el.classList.add('workspace-companion');
    if (slot === 'dossier') el.classList.add('workspace-dossier');
    for (const event of ['pointerdown', 'focusin']) body.addEventListener(event, () => {
      const tab = this.app.tabs.find(t => t.id === this.model.read(slot));
      if (tab && this.app.active !== tab) this.app.activate(tab, { focus: false });
    });
    const pane = { el, head, title, select, focus, expand, body, empty, optionSignature: null };
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
    this.model.prune(this.app.tabs);
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
      pane.focus.disabled = pane.expand.disabled = !tab; pane.focus.textContent = tab === this.app.active ? 'Focused' : 'Focus';
      pane.expand.textContent = this.model.expandedSlot === slot ? 'Restore' : 'Expand';
      pane.empty.classList.toggle('hidden', !!tab);
      const choices = this.app.tabs.filter(t => slot !== 'dossier' || incident(t));
      const signature = JSON.stringify(choices.map(t => [t.id, t.title]));
      if (pane.optionSignature !== signature) {
        pane.select.replaceChildren(h('option', { value: '' }, 'Choose open tab…'), ...choices.map(t => h('option', { value: t.id }, t.title)));
        pane.optionSignature = signature;
      }
      pane.select.value = id || '';
      if (tab && shown) { nextVisible.add(tab); if (tab.el.parentElement !== pane.body) pane.body.append(tab.el); }
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
    this.updateContext(); this.refit();
  }
  updateContext() {
    const tab = this.app.active, all = !!this.app.cmdAll?.checked;
    const target = all ? `Command target: ALL connected terminals (${this.app.tabs.filter(t => t.kind === 'terminal' && t.state === 'connected').length})` : tab?.kind === 'terminal' ? `Command target: ${tab.title} (${tab.state})` : 'Command target: no terminal selected';
    this.target.textContent = target; this.target.title = target;
    if (this.app.cmdTarget) { this.app.cmdTarget.textContent = target; this.app.cmdTarget.title = target; }
    this.contextTitle.textContent = tab?.title || 'No focused view';
    this.contextStatus.textContent = tab ? [tab.toolKind || tab.kind, tab.state, ...(tab.statusSegments?.() || []).map(s => s.text)].filter(Boolean).join('\n') : '';
    const jobs = [...new Set([...this.app.jobs.values(), ...this.app.tabs.filter(t => t.state === 'running' || t.jobId || t.busy)])].filter(t => this.app.tabs.includes(t));
    const signature = JSON.stringify(jobs.map(t => [t.id, t.title, t.state]));
    if (signature !== this.jobSignature) {
      this.jobSignature = signature;
      this.jobs.replaceChildren(...(jobs.length ? jobs.map(t => h('button.workspace-job', { onclick: () => this.app.activate(t) }, icon(t.icon || 'activity'), h('span', t.title))) : [h('p.hint', 'No running work.')]));
    }
  }
  refit() {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => { this.fitFrame = 0; for (const tab of this.visible) tab.refit?.(); });
  }
  focusTarget(tab) {
    const generation = ++this.focusGeneration, previouslyFocused = document.activeElement;
    setTimeout(() => {
      const focusUnchanged = document.activeElement === previouslyFocused || document.activeElement === document.body;
      if (generation === this.focusGeneration && focusUnchanged && this.app.active === tab && this.visible.has(tab) && this.app.tabs.includes(tab) && !tab.disposed && !document.querySelector('.modal-back')) tab.focus?.();
    }, 0);
  }
  cancelFocus() { this.focusGeneration++; }
  detach(tab) {
    this.cancelFocus();
    if (this.borrowed?.tab === tab) this.restoreLibrary();
    if (this.visible.delete(tab)) { tab.hide?.(); tab.active = false; }
    this.model.remove(tab.id);
  }
}
