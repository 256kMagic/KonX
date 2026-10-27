import { installInvestigationContext, investigationChanged } from './copilot-investigations.mjs';
import { h, icon, api, modal, toast, errMsg } from './ui.js';
import { APP_LAYOUTS } from './workspace-layouts.mjs';
import { normalizeWorkspaceGeometry, contractFloatBounds, expandFloatBounds } from './workspace-panels-model.mjs';
import { savedSessionId } from './connection-session-model.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const uid = () => crypto.randomUUID();
const viewport = app => ({ width: Math.max(1, app.views.clientWidth), height: Math.max(1, app.views.clientHeight) });
const availableSessions = app => app.sessions?.data?.sessions || [];
const fields = record => ({ name: record.name, description: record.description, notes: record.notes,
  sessions: copy(record.sessions), captures: copy(record.captures), incidentIds: [...record.incidentIds], layout: copy(record.layout) });
const empty = () => ({ name: '', description: '', notes: '', sessions: [], captures: [], incidentIds: [],
  layout: { preset: 'classic', geometry: normalizeWorkspaceGeometry(), wallCount: 4, panels: [] } });
const identity = panel => [panel.kind, panel.referenceId || '', panel.toolKind || '', panel.sessionMode || 'terminal'].join(':');
const labelFor = (workspace, panel) => panel.kind === 'session' ? workspace.sessions.find(s => s.id === panel.referenceId)?.name || 'Saved session'
  : panel.kind === 'capture' ? workspace.captures.find(c => c.id === panel.referenceId)?.name || 'Capture reference'
  : panel.kind === 'incident' ? 'Incident reference' : panel.kind === 'notes' ? workspace.name + ' · Notes' : panel.toolKind;

/** Snapshot only durable references. Runtime connection options, tool params and output never enter the record. */
export function captureSiteLayout(app, refs = {}, toolKinds = []) {
  const current = app.workspaceLayout.get(), sessions = copy(refs.sessions || []), captures = copy(refs.captures || []);
  const incidentIds = [...(refs.incidentIds || [])], panels = [], omissions = [], ids = new Map(), keys = new Set();
  const saved = availableSessions(app), allowed = new Set(toolKinds);
  const slots = new Map(app.workspaceLayout.model.slots().filter(s => s.id).map(s => [s.id, s.slot]));
  for (const tab of app.tabs) {
    if (tab.disposed || tab.toolKind === 'sites' || tab.kind === 'welcome') continue;
    let descriptor;
    if (tab.siteWorkspace && (!refs.id || tab.siteWorkspace.workspaceId === refs.id)) {
      const p = tab.siteWorkspace.panel;
      const exists = p.kind === 'session' ? sessions.some(s => s.id === p.referenceId) : p.kind === 'capture' ? captures.some(c => c.id === p.referenceId)
        : p.kind === 'incident' ? incidentIds.includes(p.referenceId) : p.kind === 'notes' || allowed.has(p.toolKind);
      if (exists) descriptor = { key: p.key, kind: p.kind, ...(p.referenceId ? { referenceId: p.referenceId } : {}), ...(p.toolKind ? { toolKind: p.toolKind } : {}),
        ...(p.kind === 'session' ? { sessionMode: p.sessionMode || 'terminal' } : {}) };
    }
    if (!descriptor && ['terminal', 'sftp'].includes(tab.kind)) {
      const session = saved.find(s => s.id === savedSessionId(tab));
      if (session) { if (!sessions.some(s => s.id === session.id)) sessions.push({ id: session.id, name: session.name || 'Saved session', group: '' });
        descriptor = { key: uid(), kind: 'session', referenceId: session.id, sessionMode: tab.kind === 'sftp' ? 'sftp' : 'terminal' }; }
      else { omissions.push('An unsaved or unavailable connection was omitted. Save it in Sessions before adding it here.'); continue; }
    }
    if (!descriptor && tab.toolKind === 'incidents' && tab.report?.id) {
      if (!incidentIds.includes(tab.report.id)) incidentIds.push(tab.report.id);
      descriptor = { key: uid(), kind: 'incident', referenceId: tab.report.id };
    }
    if (!descriptor && (tab.kind === 'capture' || tab.toolKind === 'capture') && tab.fileName) {
      omissions.push('An open capture without a saved workspace reference was omitted. Use Add capture file to retain its path.'); continue;
    }
    if (!descriptor && allowed.has(tab.toolKind)) descriptor = { key: uid(), kind: 'tool', toolKind: tab.toolKind };
    if (!descriptor) { omissions.push('A view without a supported saved reference was omitted.'); continue; }
    if (keys.has(descriptor.key)) continue;
    if (panels.length >= 32) { omissions.push('Only the first 32 supported panels were retained.'); continue; }
    keys.add(descriptor.key); ids.set(tab.id, descriptor.key);
    const floating = app.workspaceLayout.floating?.get(tab), placement = app.workspaceLayout.placement(tab);
    panels.push({ ...descriptor, placement: placement === 'docked' ? 'docked' : 'floating',
      ...(placement === 'docked' && slots.has(tab.id) ? { slot: slots.get(tab.id) } : {}),
      ...(placement !== 'docked' ? { bounds: floating ? contractFloatBounds(floating.bounds, viewport(app)) : current.geometry.lastFloatRect } : {}) });
  }
  return { sessions, captures, incidentIds, layout: { preset: current.layout, geometry: normalizeWorkspaceGeometry(current.geometry),
    wallCount: current.wallCount, panels, ...(ids.has(current.focusedId) ? { activePanelKey: ids.get(current.focusedId) } : {}) }, omissions: [...new Set(omissions)] };
}

function connectSaved(app, id, sessionMode) {
  const session = availableSessions(app).find(s => s.id === id);
  if (!session) throw new Error('This saved session is missing. Add its replacement from the Sessions list.');
  return sessionMode === 'sftp' || session.protocol === 'sftp' ? app.openSftp({ sessionId: session.id }, { name: session.name }) : app.connectSession(session);
}

/** A restored reference is inert until its clearly labelled action is clicked. */
class SiteReferenceTab {
  constructor(app, workspace, panel) {
    this.app = app; this.kind = 'site-reference'; this.toolKind = panel.kind === 'incident' ? 'incidents' : null;
    this.id = 'site-panel-' + uid(); this.icon = panel.kind === 'session' ? 'terminal' : 'file'; this.state = 'idle'; this.disposed = false;
    this.siteWorkspace = { workspaceId: workspace.id, panel: copy(panel) }; this.workspace = workspace; this.title = labelFor(workspace, panel);
    this.status = h('p.hint', { role: 'status' });
    this.button = h('button.btn.primary', { 'data-site-reference-action': panel.kind, onclick: () => this.openReference() },
      panel.kind === 'session' ? 'Connect' : panel.kind === 'capture' ? 'Open capture' : 'Open incident');
    this.el = h('div.view.site-reference', { style: { padding: '24px', overflow: 'auto' } }, h('h2', this.title),
      h('p.hint', workspace.name), this.status, panel.kind === 'notes' ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, workspace.notes || 'No notes saved.') : this.button);
    this.updateReference(workspace);
  }
  async openReference() {
    if (this.busy || this.disposed) return;
    this.busy = true; this.button.disabled = true;
    const panel = this.siteWorkspace.panel;
    try {
      let tab;
      if (panel.kind === 'capture') {
        const result = await api.invoke('tools:siteReadCapture', this.workspace.id, panel.referenceId);
        if (this.disposed) return;
        tab = this.app.openTool('capture'); tab.siteWorkspace = copy(this.siteWorkspace);
        await tab.loadBytes(result.bytes, result.name);
      } else if (panel.kind === 'incident') tab = this.app.openTool('incidents', { incidentId: panel.referenceId });
      else tab = connectSaved(this.app, panel.referenceId, panel.sessionMode);
      if (!tab || this.disposed || tab.disposed || !this.app.tabs.includes(tab)) return;
      tab.siteWorkspace = copy(this.siteWorkspace);
      const layout = this.app.workspaceLayout, float = layout.floating?.get(this), slot = layout.model?.slots().find(s => s.id === this.id)?.slot;
      if (float) layout.float(tab, float.bounds); else if (slot) layout.pin(slot, tab.id);
      this.busy = false; await this.app.closeTab(this);
    } catch (error) { if (!this.disposed) { this.status.setAttribute('role', 'alert'); this.status.textContent = errMsg(error); } }
    finally { this.busy = false; if (!this.disposed) this.button.disabled = false; }
  }
  updateReference(workspace) {
    const panel = this.siteWorkspace.panel;
    this.workspace = workspace; this.title = labelFor(workspace, panel);
    this.el.querySelector('h2').textContent = this.title;
    if (panel.kind === 'notes') this.el.querySelector('pre').textContent = workspace.notes || 'No notes saved.';
    if (panel.kind === 'session') {
      const present = availableSessions(this.app).some(s => s.id === panel.referenceId);
      this.button.disabled = this.busy || !present;
      this.button.textContent = panel.sessionMode === 'sftp' ? 'Connect SFTP' : 'Connect';
      this.status.textContent = present ? 'Disconnected. Connect explicitly when ready.' : 'Saved session missing. Replace this reference in Saved Site Workspaces.';
    } else this.status.textContent = panel.kind === 'capture' ? 'The capture file has not been read. Open it explicitly when ready.' : panel.kind === 'incident' ? 'The incident has not been opened.' : 'Saved workspace notes. Edit them in Saved Site Workspaces.';
  }
  show() {} hide() {} focus() { this.button?.focus(); }
  statusSegments() { return [{ icon: this.icon, text: this.title }, { text: 'Saved reference' }]; }
  updateBlockers() { return this.busy ? ['Wait for the workspace reference to open.'] : []; }
  requestClose() { return !this.busy; }
  dispose() { this.disposed = true; }
}

/** Add/reuse owned panels without closing any existing view or invoking connection/file actions. */
export async function restoreSiteLayout(app, workspace, toolKinds = []) {
  const layout = app.workspaceLayout, allowed = new Set(toolKinds), opened = [], issues = [], selected = new Map();
  await app.saveSettings({ uiLayout: workspace.layout.preset, workspaceGeometry: workspace.layout.geometry });
  layout.geometry = normalizeWorkspaceGeometry(workspace.layout.geometry); layout.set(workspace.layout.preset); layout.setPaneCount(workspace.layout.wallCount);
  for (const panel of workspace.layout.panels) {
    let tab = app.tabs.find(t => !t.disposed && t.siteWorkspace?.workspaceId === workspace.id && t.siteWorkspace.panel.key === panel.key && identity(t.siteWorkspace.panel) === identity(panel));
    if (!tab) {
      if (panel.kind === 'tool') {
        if (!allowed.has(panel.toolKind)) { issues.push('An unsupported tool panel was skipped.'); continue; }
        tab = app.openTool(panel.toolKind, {});
      } else tab = app.addTab(new SiteReferenceTab(app, workspace, panel));
      tab.siteWorkspace = { workspaceId: workspace.id, panel: copy(panel) }; opened.push(tab.id);
    }
    tab.updateReference?.(workspace); selected.set(panel.key, tab);
    if (layout.placement(tab) === 'external') await app.popouts.dock(tab);
    if (panel.placement === 'floating' || panel.placement === 'external') await layout.float(tab, expandFloatBounds(panel.bounds || layout.geometry.lastFloatRect, viewport(app)));
    else { await layout.dock(tab); if (panel.slot && !layout.pin(panel.slot, tab.id)) issues.push('A panel could not use its saved slot in this layout.'); }
  }
  // Adding tabs changes the active pane. Reapply assignments after all additions.
  for (const panel of workspace.layout.panels) if (panel.placement === 'docked' && panel.slot && selected.has(panel.key)) layout.pin(panel.slot, selected.get(panel.key).id);
  const active = selected.get(workspace.layout.activePanelKey); if (active) app.activate(active);
  layout.refresh();
  return { opened: opened.length, reused: selected.size - opened.length, issues };
}

export class SiteWorkspacesTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'sites'; this.id = 'sites-' + uid(); this.icon = 'folder'; this.title = 'Saved Site Workspaces'; this.state = 'idle';
    this.disposed = false; this.busy = false; this.seq = 0; this.workspaces = []; this.incidents = []; this.toolKinds = []; this.draft = empty(); this.saved = null;
    this.baseline = JSON.stringify(fields(this.draft)); this.buttons = new Map();
    this.status = h('div', { role: 'status', 'aria-live': 'polite', 'data-site-status': '' });
    this.search = h('input.input', { type: 'search', placeholder: 'Find a workspace', 'aria-label': 'Find saved site workspace', oninput: () => this.renderList() });
    this.list = h('div.site-list', { 'aria-label': 'Saved site workspaces' });
    const input = (field, label, maxLength, textarea = false) => h(textarea ? 'textarea.input' : 'input.input', { 'aria-label': label, maxLength, rows: textarea ? 4 : undefined,
      oninput: event => { this.draft[field] = event.target.value; this.changed(); } });
    this.name = input('name', 'Workspace name', 256); this.description = input('description', 'Workspace description', 4000, true); this.notes = input('notes', 'Workspace notes', 131072, true);
    this.sessionSelect = h('select.input', { 'aria-label': 'Saved session to add' }); this.group = h('input.input', { 'aria-label': 'Session group', placeholder: 'Group (optional)', maxLength: 512 });
    this.sessionRows = h('div.site-reference-list'); this.captureRows = h('div.site-reference-list'); this.incidentRows = h('div.site-reference-list');
    this.incidentSelect = h('select.input', { 'aria-label': 'Saved incident to add' });
    this.preset = h('select.input', { 'aria-label': 'Saved panel layout', onchange: () => {
      this.draft.layout.preset = this.preset.value; for (const panel of this.draft.layout.panels) delete panel.slot; this.changed(); this.renderLayout();
    } }, Object.entries(APP_LAYOUTS).map(([value, def]) => h('option', { value }, def.label)));
    this.panelSummary = h('div.site-layout-summary');
    this.editor = h('div.site-editor', h('label', 'Name', this.name), h('label', 'Description', this.description),
      h('section', h('h3', 'Saved sessions'), h('p.hint', 'References use the saved session in this profile. Opening a workspace never connects.'),
        h('div.site-actions', this.sessionSelect, this.group, this.button('add-session', 'Add session', () => this.addSession())), this.sessionRows),
      h('section', h('h3', 'Capture references'), h('p.hint', 'Files stay at their original paths and are read only when you click Open capture.'),
        this.button('add-capture', 'Add capture file', () => this.pickCapture()), this.captureRows),
      h('section', h('h3', 'Incident references'), h('div.site-actions', this.incidentSelect, this.button('add-incident', 'Add incident', () => this.addIncident())), this.incidentRows),
      h('section', h('h3', 'Notes'), this.notes, h('p.hint', 'Notes and local capture paths are included in workspace exports. Review them before sharing.')),
      h('section', h('h3', 'Panel layout'), h('div.site-actions', this.preset, this.button('capture-layout', 'Capture current panels', () => this.captureLayout())), this.panelSummary,
        h('p.hint', 'Restoring keeps existing tabs open. Native pop-outs return as floating panels; live connections and running jobs are never saved.')));
    this.el = h('div.view.site-workspaces', h('style', `.site-workspaces{display:flex;flex-direction:column;overflow:hidden}.site-workspaces .site-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.site-workspaces .site-columns{display:grid;grid-template-columns:minmax(180px,24%) minmax(0,1fr);min-height:0;flex:1;overflow:auto}.site-workspaces aside{padding:16px;border-right:1px solid var(--border);overflow:auto}.site-workspaces .site-editor{padding:20px;overflow:auto;min-width:0}.site-workspaces .site-editor>label{display:grid;gap:6px;margin-bottom:12px}.site-workspaces section{margin:18px 0}.site-workspaces textarea{width:100%;box-sizing:border-box}.site-workspaces .site-card{display:grid;text-align:left;width:100%;padding:12px;margin:8px 0;gap:5px;background:var(--panel);color:inherit;border:1px solid var(--border);border-radius:7px;overflow-wrap:anywhere}.site-workspaces .site-card[aria-current=true]{border-color:var(--accent)}.site-workspaces .site-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.site-workspaces .site-row>span{flex:1;min-width:120px}.site-workspaces .site-layout-summary{margin-top:10px}.site-workspaces [role=alert]{color:var(--err)}@media(max-width:650px){.site-workspaces .site-columns{grid-template-columns:1fr}.site-workspaces aside{max-height:180px}.site-workspaces .site-editor{overflow:visible}}`),
      h('div.tool-head', h('div.tool-title', icon('folder'), h('h2', this.title)), h('div.site-actions',
        this.button('new', 'New', () => this.newWorkspace()), this.button('save-current', 'Save current workspace', () => this.newWorkspace(true)),
        this.button('save', 'Save', () => this.save(), true), this.button('open', 'Open workspace', () => this.open()),
        this.button('duplicate', 'Duplicate', () => this.duplicate()), this.button('import', 'Import', () => this.import()),
        this.button('export', 'Export', () => this.export()), this.button('delete', 'Delete', () => this.remove()), this.button('refresh', 'Refresh', () => this.refresh())), this.status),
      h('div.site-columns', h('aside', this.search, this.list), this.editor));
    installInvestigationContext(this); this.renderDraft(); this.ready = this.refresh(params.workspaceId);
  }
  button(action, label, handler, primary = false) {
    const button = h('button.btn', { class: primary ? 'primary' : '', 'data-site-action': action, onclick: handler }, label);
    this.buttons.set(action, button); return button;
  }
  isDirty() { return JSON.stringify(fields(this.draft)) !== this.baseline; }
  changed() { investigationChanged(this); this.updateButtons(); this.app.updateStatus(this); }
  updateButtons() {
    const blocked = this.busy || this.prompting;
    for (const button of this.el?.querySelectorAll('button') || []) button.disabled = blocked;
    for (const control of this.editor?.querySelectorAll('input,textarea,select') || []) control.disabled = blocked;
    for (const key of ['duplicate', 'export', 'delete', 'open']) this.buttons.get(key).disabled = blocked || !this.saved || this.isDirty();
    this.buttons.get('save').disabled = blocked || !this.draft.name.trim();
    for (const button of this.el?.querySelectorAll('[data-requires-saved]') || []) button.disabled = blocked || !this.saved || this.isDirty();
    for (const button of this.el?.querySelectorAll('[data-missing]') || []) button.disabled = true;
    this.el?.setAttribute('aria-busy', String(this.busy));
  }
  async request(action, apply, message) {
    if (this.busy || this.disposed) return null;
    const seq = ++this.seq; this.busy = true; this.updateButtons(); this.status.setAttribute('role', 'status'); this.status.textContent = message;
    try { const result = await action(); if (this.disposed || seq !== this.seq) return null; if (apply) await apply(result); return result; }
    catch (error) { if (!this.disposed && seq === this.seq) { this.status.setAttribute('role', 'alert'); this.status.textContent = errMsg(error) + ' Your draft has been kept.'; } return null; }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); this.app.updateStatus(this); } }
  }
  async confirm(message, options) {
    if (this.prompting || this.disposed) return false;
    this.prompting = true; this.updateButtons();
    try { return await modal({ title: options.title, body: [h('div.message', message), options.detail ? h('p.hint', options.detail) : null],
      buttons: [{ label: 'Cancel', value: null }, { label: options.okLabel, value: true, primary: !options.danger, danger: !!options.danger }],
      onReady: control => { this.dialog = control; } }) === true; }
    finally { this.dialog = null; this.prompting = false; if (!this.disposed) this.updateButtons(); }
  }
  async discardChanges() { return !this.isDirty() || await this.confirm('Discard unsaved workspace changes?', { title: 'Unsaved workspace', okLabel: 'Discard changes', danger: true }); }
  async refresh(id) {
    await this.request(async () => {
      const [library, , incidents] = await Promise.all([api.invoke('tools:siteList'), this.app.sessions.load(), api.invoke('tools:incidentList')]);
      return { library, incidents };
    }, ({ library, incidents }) => {
      this.workspaces = library.workspaces; this.toolKinds = library.capabilities?.toolKinds || [];
      this.incidents = incidents.incidents; this.renderList(); this.renderReferences();
      this.status.textContent = `${this.workspaces.length} saved workspace(s). ${library.issues?.length ? 'Some saved files could not be read; they have not been removed.' : 'Opening and importing never connects.'}`;
    }, 'Loading saved workspaces…');
    if (id && !this.disposed) await this.select(id);
  }
  accept(record) {
    this.saved = copy(record); this.draft = fields(record); this.baseline = JSON.stringify(this.draft); investigationChanged(this);
    const index = this.workspaces.findIndex(w => w.id === record.id); if (index < 0) this.workspaces.unshift(record); else this.workspaces[index] = record;
    this.renderDraft(); this.renderList();
  }
  async select(id) {
    if (this.busy || this.disposed || !await this.discardChanges() || this.disposed) return;
    await this.request(() => api.invoke('tools:siteGet', id), record => { this.accept(record); this.status.textContent = 'Workspace selected. Click Open workspace to restore its panels, or Connect beside a session.'; }, 'Loading workspace definition…');
  }
  async newWorkspace(capture = false) {
    if (this.busy || this.disposed || !await this.discardChanges() || this.disposed) return;
    this.saved = null; this.draft = empty(); this.baseline = JSON.stringify(this.draft); investigationChanged(this);
    if (capture) { this.draft.name = 'New site workspace'; this.captureLayout(); }
    this.renderDraft(); this.renderList(); this.name.focus();
  }
  renderList() {
    const query = this.search.value.trim().toLocaleLowerCase();
    this.list.replaceChildren(...this.workspaces.filter(w => [w.name, w.description].join(' ').toLocaleLowerCase().includes(query)).map(w => h('button.site-card',
      { 'data-site-id': w.id, 'aria-current': String(w.id === this.saved?.id), disabled: this.busy || this.prompting, onclick: () => this.select(w.id) }, h('strong', w.name), h('span.hint', w.description || 'Saved references and panel layout'))));
    if (!this.list.childElementCount) this.list.append(h('p.hint', 'No matching workspaces.'));
  }
  renderDraft() { this.name.value = this.draft.name; this.description.value = this.draft.description; this.notes.value = this.draft.notes; this.preset.value = this.draft.layout.preset; this.renderReferences(); this.renderLayout(); this.updateButtons(); }
  renderReferences() {
    const sessions = availableSessions(this.app);
    this.sessionSelect.replaceChildren(h('option', { value: '' }, 'Choose a saved session'), ...sessions.filter(s => !this.draft.sessions.some(ref => ref.id === s.id)).map(s => h('option', { value: s.id }, s.name || 'Saved session')));
    this.sessionRows.replaceChildren(...this.draft.sessions.map(ref => {
      const session = sessions.find(s => s.id === ref.id), group = h('input.input', { value: ref.group, maxLength: 512, 'aria-label': 'Group for ' + ref.name,
        oninput: event => { ref.group = event.target.value; this.changed(); } });
      return h('div.site-row', { 'data-session-reference': ref.id }, h('span', ref.name || 'Saved session', !session ? ' · Missing saved session' : ''), group,
        h('button.btn.sm', { 'data-site-connect': ref.id, 'data-missing': session ? undefined : '', disabled: !session || this.busy, onclick: () => {
          try { connectSaved(this.app, ref.id); } catch (error) { this.status.setAttribute('role', 'alert'); this.status.textContent = errMsg(error); }
        } }, 'Connect'), h('button.btn.sm', { onclick: () => this.removeReference('session', ref.id) }, 'Remove'));
    }));
    this.captureRows.replaceChildren(...this.draft.captures.map(ref => h('div.site-row', h('span', h('strong', ref.name), h('div.hint', ref.path)),
      h('button.btn.sm', { 'data-requires-saved': '', 'data-open-capture': ref.id, onclick: () => this.openReference('capture', ref.id) }, 'Open capture'),
      h('button.btn.sm', { onclick: () => this.removeReference('capture', ref.id) }, 'Remove'))));
    this.incidentSelect.replaceChildren(h('option', { value: '' }, 'Choose a saved incident'), ...this.incidents.filter(i => !this.draft.incidentIds.includes(i.id)).map(i => h('option', { value: i.id }, i.title)));
    this.incidentRows.replaceChildren(...this.draft.incidentIds.map(id => h('div.site-row', h('span', this.incidents.find(i => i.id === id)?.title || 'Missing incident · ' + id),
      h('button.btn.sm', { 'data-requires-saved': '', 'data-open-incident': id, onclick: () => this.openReference('incident', id) }, 'Open incident'),
      h('button.btn.sm', { onclick: () => this.removeReference('incident', id) }, 'Remove'))));
  }
  ensurePanel(kind, referenceId) {
    if (this.draft.layout.panels.some(p => p.kind === kind && p.referenceId === referenceId)) return;
    if (this.draft.layout.panels.length >= 32) { this.status.textContent = 'Reference added. The layout already contains 32 panels; it remains available in this editor.'; return; }
    this.draft.layout.panels.push({ key: uid(), kind, ...(referenceId ? { referenceId } : {}), placement: 'docked',
      ...(kind === 'session' ? { sessionMode: availableSessions(this.app).find(s => s.id === referenceId)?.protocol === 'sftp' ? 'sftp' : 'terminal' } : {}) });
  }
  addSession() {
    const session = availableSessions(this.app).find(s => s.id === this.sessionSelect.value); if (!session || this.busy) return;
    this.draft.sessions.push({ id: session.id, name: session.name || 'Saved session', group: this.group.value }); this.ensurePanel('session', session.id); this.group.value = '';
    this.renderReferences(); this.renderLayout(); this.changed();
  }
  addIncident() { const id = this.incidentSelect.value; if (!id || this.busy) return; this.draft.incidentIds.push(id); this.ensurePanel('incident', id); this.renderReferences(); this.renderLayout(); this.changed(); }
  async pickCapture() { await this.request(() => api.invoke('tools:sitePickCapture'), ref => { if (ref) { this.draft.captures.push(ref); this.ensurePanel('capture', ref.id); this.renderReferences(); this.renderLayout(); this.status.textContent = 'Capture path added. Save the workspace before opening its reference.'; } else this.status.textContent = 'Capture selection cancelled.'; }, 'Choose a capture reference…'); }
  removeReference(kind, id) {
    if (this.busy) return;
    if (kind === 'session') this.draft.sessions = this.draft.sessions.filter(s => s.id !== id);
    if (kind === 'capture') this.draft.captures = this.draft.captures.filter(c => c.id !== id);
    if (kind === 'incident') this.draft.incidentIds = this.draft.incidentIds.filter(i => i !== id);
    const removed = new Set(this.draft.layout.panels.filter(p => p.kind === kind && p.referenceId === id).map(p => p.key));
    this.draft.layout.panels = this.draft.layout.panels.filter(p => !removed.has(p.key));
    if (removed.has(this.draft.layout.activePanelKey)) delete this.draft.layout.activePanelKey;
    this.renderReferences(); this.renderLayout(); this.changed();
  }
  captureLayout() {
    if (this.busy) return;
    const snapshot = captureSiteLayout(this.app, { ...this.draft, id: this.saved?.id }, this.toolKinds);
    Object.assign(this.draft, { sessions: snapshot.sessions, captures: snapshot.captures, incidentIds: snapshot.incidentIds, layout: snapshot.layout });
    this.status.textContent = snapshot.omissions.length ? snapshot.omissions.join(' ') : 'Current panel arrangement captured. Save to retain it.';
    this.renderDraft(); this.changed();
  }
  renderLayout() {
    this.panelSummary.textContent = `${this.draft.layout.panels.length} panel(s) · ${APP_LAYOUTS[this.draft.layout.preset]?.label || this.draft.layout.preset} · split sizes and floating bounds retained`;
    this.aiContext = { kind: 'site-workspace-summary', sessionReferences: this.draft.sessions.length, captureReferences: this.draft.captures.length,
      incidentReferences: this.draft.incidentIds.length, panelCount: this.draft.layout.panels.length, layout: this.draft.layout.preset,
      limitation: 'Only reference counts and layout type are shared. Notes, names, identifiers, paths and connection settings are excluded.' };
  }
  async save() {
    if (this.busy || this.disposed || !this.draft.name.trim()) return;
    // Notes get their own passive panel. No terminal text or editor buffer is copied.
    if (this.draft.notes.trim()) this.ensurePanel('notes');
    const input = { ...fields(this.draft), ...(this.saved ? { id: this.saved.id, revision: this.saved.revision } : {}) };
    await this.request(() => api.invoke('tools:siteSave', input), record => { this.accept(record); this.status.textContent = 'Workspace saved. No connections were started.'; }, 'Saving workspace…');
  }
  async openReference(kind, referenceId) {
    if (!this.saved || this.isDirty() || this.busy || this.disposed) return;
    const panel = this.saved.layout.panels.find(p => p.kind === kind && p.referenceId === referenceId) || { key: 'reference-' + referenceId, kind, referenceId, placement: 'docked' };
    const existing = this.app.tabs.find(t => !t.disposed && t.siteWorkspace?.workspaceId === this.saved.id && identity(t.siteWorkspace.panel) === identity(panel));
    if (existing) { this.app.activate(existing); if (existing instanceof SiteReferenceTab) await existing.openReference(); return; }
    const tab = this.app.addTab(new SiteReferenceTab(this.app, this.saved, panel)); await tab.openReference();
  }
  async open() {
    if (!this.saved || this.isDirty()) return;
    await this.request(() => restoreSiteLayout(this.app, copy(this.saved), this.toolKinds), result => {
      this.status.textContent = `Opened ${result.opened} panel(s), reused ${result.reused}. Sessions stay disconnected until Connect is clicked. ${result.issues.join(' ')}`;
    }, 'Restoring reference panels…');
  }
  async duplicate() { if (!this.saved || this.isDirty()) return; await this.request(() => api.invoke('tools:siteDuplicate', this.saved.id, {}), record => { this.accept(record); this.status.textContent = 'Workspace duplicated. No panels or connections were opened.'; }, 'Duplicating workspace…'); }
  async import() {
    if (this.busy || this.disposed || !await this.discardChanges() || this.disposed) return;
    await this.request(() => api.invoke('tools:siteImport'), record => { if (record) { this.accept(record); this.status.textContent = 'Workspace imported with a new identity. Review references before opening; nothing has connected or read a capture.'; } else this.status.textContent = 'Import cancelled. Your draft is unchanged.'; }, 'Choose a workspace JSON file…');
  }
  async export() {
    if (!this.saved || this.isDirty() || this.busy) return;
    if (!await this.confirm('Export this saved workspace?', { title: 'Review before sharing', okLabel: 'Choose export file', detail: 'The JSON includes notes, session names and IDs, incident IDs, and local capture paths. Capture bytes and connection settings are not included. Free-text notes may contain sensitive information; review them before sharing.' }) || this.disposed) return;
    await this.request(() => api.invoke('tools:siteExport', this.saved.id), file => { this.status.textContent = file ? 'Workspace exported.' : 'Export cancelled.'; }, 'Choose an export destination…');
  }
  async remove() {
    if (!this.saved || this.busy || this.isDirty()) return;
    const id = this.saved.id;
    if (!await this.confirm('Delete this saved workspace definition? Existing sessions, captures, incidents and open tabs are kept.', { title: 'Delete workspace', okLabel: 'Delete workspace', danger: true }) || this.disposed) return;
    await this.request(() => api.invoke('tools:siteRemove', id), () => {
      this.workspaces = this.workspaces.filter(w => w.id !== id); this.saved = null; this.draft = empty(); this.baseline = JSON.stringify(fields(this.draft)); investigationChanged(this); this.renderDraft(); this.renderList(); this.status.textContent = 'Workspace definition deleted. Referenced data and open tabs were kept.';
    }, 'Deleting workspace definition…');
  }
  updateBlockers() { return [...(this.busy || this.prompting ? ['Wait for the saved workspace operation.'] : []), ...(this.isDirty() ? ['Save or discard the unsaved workspace definition.'] : [])]; }
  async requestClose() { if (this.busy || this.prompting) { toast('Wait for the workspace operation to finish.', 'err'); return false; } return this.discardChanges(); }
  show() {} hide() {} focus() { this.name.focus(); }
  statusSegments() { return [{ icon: 'folder', text: this.title }, { text: this.busy ? 'Working…' : this.isDirty() ? 'Unsaved changes' : this.saved?.name || 'Ready' }]; }
  dispose() { this.disposed = true; this.seq++; this.dialog?.close(null); }
}
