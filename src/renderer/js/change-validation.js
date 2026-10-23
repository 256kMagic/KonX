import { h, icon, api, modal, toast, errMsg } from './ui.js';

const clone = value => JSON.parse(JSON.stringify(value));
const PHASES = ['plan', 'baseline', 'maintenance', 'after', 'review'];
const labels = { plan: '1 · Plan & scope', baseline: '2 · Baseline evidence', maintenance: '3 · Manual maintenance', after: '4 · After evidence', review: '5 · Review & export' };
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown';
const starter = () => ({ name: '', scope: '', expectedOutcome: '', rollbackPlan: '', checks: [{ id: 'expected', label: 'Expected change observed' }, { id: 'service', label: 'Affected service evidence reviewed' }, { id: 'unexpected', label: 'Unexpected differences reviewed' }] });
const assessment = r => r.decisions.some(d => !d.reviewedAt) ? 'Not fully reviewed' : r.decisions.some(d => d.status === 'fail') ? 'Fail' : r.decisions.some(d => d.status === 'unknown') ? 'Unknown' : 'Pass';
const decisionsInput = r => r.decisions.map(({ checkId, status, rationale, sourceRefs }) => ({ checkId, status, rationale, sourceRefs: [...sourceRefs] }));

/** A local guide. Only explicit tool buttons open collectors; this view never runs them. */
export class ChangeValidationTab {
  constructor(app, params = {}) {
    this.app = app; this.kind = 'tool'; this.toolKind = 'change-validation'; this.id = 'change-validation-' + crypto.randomUUID();
    this.title = 'Guided Change Validation'; this.icon = 'check'; this.state = 'idle'; this.disposed = false; this.busy = false; this.seq = 0;
    this.records = []; this.snapshots = []; this.incidents = []; this.record = null; this.page = 'plan'; this.plan = starter(); this.sources = { beforeId: null, afterId: null, devicePairs: [] }; this.decisions = [];
    this.baseline = this.values(); this.buttons = new Map(); this.panels = new Map(); this.phaseButtons = new Map(); this.fields = {};
    this.status = h('div.change-status', { role: 'status', 'aria-live': 'polite' }, 'Plan a change and save the workflow. Nothing connects or runs automatically.');
    this.search = h('input.input', { type: 'search', 'aria-label': 'Find change validation', placeholder: 'Find a saved validation', oninput: () => this.renderList() }); this.list = h('div.change-library');
    this.phasebar = h('div.change-phases', PHASES.map(phase => { const button = h('button.btn', { 'data-change-phase': phase, onclick: () => this.showPage(phase) }, labels[phase]); this.phaseButtons.set(phase, button); return button; }));
    const field = (key, label, max = 8000) => { const input = h(key === 'name' ? 'input.input' : 'textarea.input', { 'aria-label': label, maxLength: max, rows: key === 'name' ? undefined : 4,
      oninput: event => { this.plan[key] = event.target.value; this.changed(); } }); this.fields[key] = input; return h('label.field', h('span', label), input); };
    this.checkRows = h('div.change-plan-checks'); this.checkName = h('input.input', { 'aria-label': 'New review check', placeholder: 'Add a review criterion', maxLength: 256 });
    this.panel('plan', h('h3', 'Define the intended change'), field('name', 'Change name', 256), field('scope', 'Scope and affected services'), field('expectedOutcome', 'Expected outcome'), field('rollbackPlan', 'Manual rollback plan'),
      h('h3', 'Review checklist'), this.checkRows, h('div.change-actions', this.checkName, this.button('add-check', 'Add review check', () => this.addCheck())),
      h('p.hint', 'Changing a saved plan starts a new plan version. Snapshot selections, acknowledgment and assessments reset; earlier attached evidence stays labelled with its prior plan version.'), this.button('save-plan', 'Save plan', () => this.savePlan(), true));
    this.before = this.snapshotSelect('beforeId', 'Baseline snapshot'); this.after = this.snapshotSelect('afterId', 'After snapshot');
    this.runbook = h('select.input', { 'aria-label': 'Runbook to open' });
    this.evidenceSource = h('select.input', { 'aria-label': 'Open tool result to attach' });
    this.evidencePhase = h('select.input', { 'aria-label': 'Evidence phase' }, h('option', { value: 'baseline' }, 'Baseline'), h('option', { value: 'after' }, 'After'));
    this.evidenceList = h('div.change-evidence-list');
    this.sourcesPanel = h('section.change-sources', h('h3', 'Saved snapshot sources'), h('div.change-snapshot-grid', h('label.field', 'Baseline snapshot', this.before), h('label.field', 'After snapshot', this.after)),
      h('div.change-actions', this.button('save-sources', 'Save snapshot selection', () => this.saveSources()), this.button('load-pairs', 'Review device pairing', () => this.loadPairs())),
      h('p.hint', 'Different snapshots are required. Selecting a source does not collect data. Missing or incomplete observations remain unknown.'));
    this.pairs = h('div.change-pairs'); this.pairDetails = h('details', h('summary', 'Explicit device pairing'), h('p.hint', 'Automatic pairing requires a unique matching identity. Only map differing identities when you have evidence they refer to the same device.'), this.pairs);
    this.comparison = h('div.change-comparison');
    this.evidencePanel = h('section', h('h3', 'Reviewed tool evidence'), h('div.change-actions', this.evidenceSource, this.evidencePhase,
      this.button('refresh-tools', 'Refresh open results', () => this.renderToolSources()), this.button('attach', 'Preview & attach result', () => this.attachEvidence())), this.evidenceList);
    this.toolsPanel = h('section', h('h3', 'Collect evidence explicitly in its existing tool'), h('div.change-actions',
      this.button('device', 'Open Device Inspector', () => this.app.openTool('device', {})), this.button('snapshots', 'Open Snapshots', () => this.app.openTool('snapshots', {})),
      this.button('captures', 'Open Capture Comparison', () => this.app.openTool('capture-compare', {}))), h('div.change-actions', this.runbook, this.button('runbook', 'Open Runbooks', () => this.openRunbook())),
      h('p.hint', 'These buttons open tools for your review. Use their own explicit collection/run actions, then return here to attach the result. No configuration commands are generated or sent.'));
    this.evidenceHost = h('div'); this.panel('baseline', h('h3', 'Record the baseline'), h('p', 'Choose the saved before snapshot and attach any relevant existing results. Record what was actually observed before maintenance.'), this.evidenceHost);
    this.afterHost = h('div'); this.panel('after', h('h3', 'Record observations after maintenance'), h('p', 'Choose a separate after snapshot, compare it explicitly, and attach additional reviewed results.'), this.afterHost);
    this.maintenanceText = h('textarea.input', { rows: 5, maxLength: 4000, 'aria-label': 'Manual maintenance acknowledgment', placeholder: 'Record what you manually changed, skipped, or rolled back. KonX does not perform it.', oninput: () => this.changed() });
    this.maintenanceCheck = h('input', { type: 'checkbox', 'aria-label': 'I acknowledge the manual maintenance activity', onchange: () => this.changed() }); this.maintenanceSummary = h('p.hint');
    this.panel('maintenance', h('h3', 'Perform maintenance using your own reviewed procedure'), h('p', 'KonX is recording the workflow. This step does not connect to equipment or apply configuration.'),
      this.maintenanceText, h('label.change-ack', this.maintenanceCheck, ' I acknowledge the manual maintenance activity described above.'), this.maintenanceSummary);
    this.decisionRows = h('div.change-decisions'); this.reviewSummary = h('p'); this.incident = h('select.input', { 'aria-label': 'Incident for validation report' });
    this.panel('review', h('h3', 'Review retained evidence'), this.reviewSummary, h('p.notice', 'Changed does not mean failed. Unchanged does not mean healthy. Use Unknown when evidence is missing, ambiguous or insufficient.'),
      this.decisionRows, this.button('save-decisions', 'Save review decisions', () => this.saveDecisions(), true),
      h('div.change-actions', this.button('export-json', 'Export JSON report', () => this.export('json')), this.button('export-html', 'Export HTML report', () => this.export('html'))),
      h('div.change-actions', this.incident, this.button('add-incident', 'Add report to incident', () => this.addToIncident())),
      h('p.hint', 'Exports and incident copies include the complete retained comparison, reviewed evidence, notes and timeline. Literal observation text may contain sensitive information. Review it before sharing.'));
    this.timeline = h('div.change-timeline'); this.details = h('details', h('summary', 'Saved workflow timeline'), this.timeline);
    this.el = h('div.view.change-validation', h('style', `.change-validation{flex-direction:column;overflow:hidden}.change-validation.active{display:flex}.change-validation .change-actions,.change-validation .change-phases{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}.change-validation .change-columns{display:grid;grid-template-columns:minmax(180px,22%) minmax(0,1fr);flex:1;min-height:0;overflow:auto}.change-validation aside{padding:14px;border-right:1px solid var(--border);overflow:auto}.change-validation .change-body{padding:20px;overflow:auto;min-width:0}.change-validation .change-card{display:grid;width:100%;text-align:left;gap:5px;padding:12px;margin:8px 0;color:inherit;background:var(--panel);border:1px solid var(--border);border-radius:6px}.change-validation .change-card[aria-current=true]{border-color:var(--accent)}.change-validation textarea{width:100%;box-sizing:border-box}.change-validation select[multiple]{height:auto;min-height:68px}.change-validation .field{display:grid;gap:7px;margin:12px 0}.change-validation .change-check,.change-validation .change-decision,.change-validation .change-evidence{padding:12px;border:1px solid var(--border);border-radius:6px;margin:10px 0}.change-validation .change-check{display:flex;gap:8px}.change-validation .change-check input{flex:1}.change-validation .change-snapshot-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.change-validation pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}.change-validation .change-phases button[aria-current=true]{border-color:var(--accent)}.change-validation .change-ack{display:block;margin:12px 0}.change-validation section{margin:18px 0}.change-validation [role=alert]{color:var(--err)}@media(max-width:700px){.change-validation .change-columns,.change-validation .change-snapshot-grid{grid-template-columns:1fr}.change-validation aside{max-height:160px}.change-validation .change-body{overflow:visible}}`),
      h('div.tool-head', h('div.tool-title', icon('route'), h('h2', this.title)), h('div.change-actions', this.button('new', 'New validation', () => this.newRecord()), this.button('refresh', 'Refresh libraries', () => this.refresh()),
        this.button('advance', 'Advance phase', () => this.advance(), true), this.button('delete', 'Delete validation', () => this.remove())), this.status, this.phasebar),
      h('div.change-columns', h('aside', this.search, this.list), h('div.change-body', [...this.panels.values()], this.details)));
    this.render(); this.ready = this.refresh(params.validationId);
  }
  panel(key, ...children) { const panel = h('div.change-step', { 'data-change-panel': key }, children); this.panels.set(key, panel); return panel; }
  button(action, label, handler, primary = false) { const button = h('button.btn', { class: primary ? 'primary' : '', 'data-change-action': action, onclick: handler }, label); this.buttons.set(action, button); return button; }
  snapshotSelect(field, label) { return h('select.input', { 'aria-label': label, onchange: event => { this.sources[field] = event.target.value || null; this.sources.devicePairs = []; this.pairs.replaceChildren(h('p.hint', 'Reload device pairing for the selected snapshots.')); this.changed(); } }); }
  values() { return JSON.stringify({ plan: this.plan, sources: this.sources, decisions: this.decisions }); }
  // Record edits have independent save actions; this acknowledgment draft is saved by Advance.
  isRecordDirty() { return this.values() !== this.baseline; }
  hasMaintenanceDraft() { return !!this.maintenanceText?.value || !!this.maintenanceCheck?.checked; }
  isDirty() { return this.isRecordDirty() || this.hasMaintenanceDraft(); }
  changed() { this.updateButtons(); this.app.updateStatus(this); }
  updateButtons() {
    const locked = this.busy || this.prompting, saved = !!this.record;
    for (const el of this.el?.querySelectorAll('button,input,textarea,select') || []) el.disabled = locked;
    for (const action of ['advance', 'delete', 'load-pairs', 'attach', 'export-json', 'export-html', 'add-incident']) this.buttons.get(action).disabled = locked || !saved || this.isDirty() || !!this.pendingAttachment && action !== 'attach';
    this.buttons.get('advance').disabled = locked || !saved || this.isRecordDirty() || !!this.pendingAttachment || this.record?.phase === 'review';
    this.buttons.get('save-plan').disabled = locked || !this.plan.name.trim() || !!this.pendingAttachment || saved && JSON.stringify(this.plan) === JSON.stringify(this.record.plan);
    this.buttons.get('save-sources').disabled = locked || !saved || !!this.pendingAttachment || JSON.stringify(this.plan) !== JSON.stringify(this.record.plan) || JSON.stringify(this.sources) === JSON.stringify(this.record.sources);
    this.buttons.get('compare')?.setAttribute('aria-disabled', String(locked || !saved || this.isDirty()));
    if (this.buttons.has('compare')) this.buttons.get('compare').disabled = locked || !saved || this.isDirty() || !this.sources.beforeId || !this.sources.afterId;
    this.buttons.get('save-decisions').disabled = locked || !saved || this.record.phase !== 'review' || JSON.stringify(this.plan) !== JSON.stringify(this.record.plan) || JSON.stringify(this.sources) !== JSON.stringify(this.record.sources);
    for (const field of this.decisionRows.querySelectorAll('input,textarea,select')) field.disabled = locked || this.record?.phase !== 'review';
    this.maintenanceText.disabled = this.maintenanceCheck.disabled = locked || this.record?.phase !== 'maintenance';
    this.buttons.get('add-check').disabled ||= this.plan.checks.length >= 24;
    this.el?.setAttribute('aria-busy', String(!!locked));
  }
  async request(fn, apply, message) {
    if (this.busy || this.disposed) return null;
    const seq = ++this.seq; this.busy = true; this.updateButtons(); this.status.setAttribute('role', 'status'); this.status.textContent = message;
    try { const result = await fn(); if (this.disposed || seq !== this.seq) return null; if (apply) await apply(result); return result; }
    catch (error) { if (!this.disposed && seq === this.seq) { this.status.setAttribute('role', 'alert'); this.status.textContent = errMsg(error) + ' Unsaved input has been kept.'; } return null; }
    finally { if (!this.disposed && seq === this.seq) { this.busy = false; this.updateButtons(); this.app.updateStatus(this); } }
  }
  async dialog(options) {
    if (this.prompting || this.disposed) return null; this.prompting = true; this.updateButtons();
    try { return await modal({ ...options, onReady: control => { this.openDialog = control; } }); }
    finally { this.openDialog = null; this.prompting = false; if (!this.disposed) this.updateButtons(); }
  }
  hasUnsavedInput() { return this.isDirty() || !!this.pendingAttachment; }
  async discard() { return !this.hasUnsavedInput() || await this.dialog({ title: 'Unsaved validation', body: h('p', 'Discard unsaved plan, source selection, maintenance notes, reviewed evidence draft or review decisions?'), buttons: [{ label: 'Cancel', value: null }, { label: 'Discard changes', value: true, danger: true }] }) === true; }
  async refresh(selected) {
    await this.request(async () => {
      const [library, ...sources] = await Promise.all([api.invoke('tools:changeList'), ...['tools:snapshotList', 'tools:incidentList', 'tools:runbookTemplates', 'tools:runbookList'].map(channel => api.invoke(channel).then(value => ({ value }), error => ({ error: errMsg(error) })))]);
      return { library, sources };
    }, ({ library, sources }) => {
      this.records = library.records; this.snapshots = sources[0].value?.snapshots || []; this.incidents = sources[1].value?.incidents || [];
      this.runbook.replaceChildren(h('option', { value: '' }, 'Choose a diagnostic procedure'), ...(sources[2].value || []).map(t => h('option', { value: 'template:' + t.id }, t.definition.name)), ...(sources[3].value?.runbooks || []).map(r => h('option', { value: 'saved:' + r.id }, r.name)));
      this.renderList(); this.renderSources(); this.renderToolSources(); this.renderIncidents();
      this.status.textContent = `${this.records.length} saved validation(s). ` + (sources.some(s => s.error) || library.issues.length ? 'Some library entries are unavailable; missing observations remain unknown.' : 'Nothing is collected until explicitly requested in its tool.');
    }, 'Refreshing local libraries…');
    if (selected && !this.disposed) await this.select(selected);
  }
  accept(record) {
    this.record = clone(record); this.plan = clone(record.plan); this.sources = clone(record.sources); this.decisions = decisionsInput(record); this.baseline = this.values();
    this.pairs.replaceChildren(h('p.hint', 'Use Review device pairing to inspect the saved source identities.'));
    const summary = { id: record.id, name: record.plan.name, phase: record.phase, updatedAt: record.updatedAt, assessment: assessment(record) };
    const index = this.records.findIndex(r => r.id === record.id); if (index < 0) this.records.unshift(summary); else this.records[index] = summary;
    this.render(); this.renderList();
  }
  async select(value) { if (this.busy || !await this.discard() || this.disposed) return; await this.request(() => api.invoke('tools:changeGet', value), record => { this.pendingAttachment = null; this.maintenanceText.value = ''; this.maintenanceCheck.checked = false; this.page = record.phase; this.accept(record); this.status.textContent = 'Saved validation reopened. No phase advanced and no tool ran.'; }, 'Opening saved validation…'); }
  async newRecord() { if (this.busy || !await this.discard() || this.disposed) return; this.record = null; this.plan = starter(); this.sources = { beforeId: null, afterId: null, devicePairs: [] }; this.decisions = []; this.pendingAttachment = null; this.maintenanceText.value = ''; this.maintenanceCheck.checked = false; this.baseline = this.values(); this.page = 'plan'; this.render(); this.fields.name.focus(); }
  renderList() { const query = this.search.value.trim().toLowerCase(); this.list.replaceChildren(...this.records.filter(r => r.name.toLowerCase().includes(query)).map(r => h('button.change-card', { 'data-change-id': r.id, 'aria-current': String(r.id === this.record?.id), disabled: this.busy || this.prompting, onclick: () => this.select(r.id) }, h('strong', r.name), h('span.hint', `${labels[r.phase]} · ${r.assessment}`)))); if (!this.list.childElementCount) this.list.append(h('p.hint', 'No saved validations match.')); }
  render() {
    for (const [key, input] of Object.entries(this.fields)) input.value = this.plan[key];
    this.checkRows.replaceChildren(...this.plan.checks.map(check => h('div.change-check', h('input.input', { value: check.label, maxLength: 256, 'aria-label': 'Review check ' + check.id, oninput: e => { check.label = e.target.value; this.changed(); } }),
      h('button.btn.sm', { disabled: this.plan.checks.length === 1, onclick: () => { if (this.plan.checks.length < 2) return; this.plan.checks = this.plan.checks.filter(c => c.id !== check.id); this.render(); this.changed(); } }, 'Remove'))));
    this.renderSources(); this.renderEvidence(); this.renderComparison(); this.renderDecisions(); this.renderIncidents(); this.renderToolSources(); this.showPage(this.page);
    this.maintenanceSummary.textContent = this.record?.maintenance ? `Acknowledged ${date(this.record.maintenance.acknowledgedAt)}: ${this.record.maintenance.reason}` : 'No manual maintenance activity has been acknowledged.';
    this.timeline.replaceChildren(...(this.record?.timeline || []).map(event => h('details', h('summary', `${date(event.at)} · ${event.action}`), h('pre', JSON.stringify(event.details, null, 2)))));
    this.aiContext = { kind: 'change-validation-summary', phase: this.record?.phase || 'unsaved', checkCount: this.plan.checks.length, evidenceCount: this.record?.evidence.length || 0,
      comparisonStatus: this.record?.comparison?.status || 'not compared', assessment: this.record ? assessment(this.record) : 'Not reviewed', limitation: 'Counts and explicit user assessment only; source content, scope, identifiers and notes are excluded.' };
    this.updateButtons();
  }
  showPage(phase) {
    this.page = phase;
    for (const [key, panel] of this.panels) panel.hidden = key !== phase;
    for (const [key, button] of this.phaseButtons) { button.setAttribute('aria-current', String(key === phase)); button.title = this.record?.phase === key ? 'Current saved phase' : 'View this section; this does not advance the saved phase'; }
    if (phase === 'baseline' || phase === 'after') { (phase === 'baseline' ? this.evidenceHost : this.afterHost).append(this.sourcesPanel, this.pairDetails, this.toolsPanel, this.evidencePanel, this.comparison); this.evidencePhase.value = phase; }
    this.buttons.get('advance').textContent = this.record && this.record.phase !== 'review' ? 'Advance to ' + labels[PHASES[PHASES.indexOf(this.record.phase) + 1]].slice(4) : 'Advance phase';
  }
  renderSources() {
    for (const [field, select] of [['beforeId', this.before], ['afterId', this.after]]) {
      const selected = this.sources[field]; select.replaceChildren(h('option', { value: '' }, 'Not selected / unknown'), ...this.snapshots.map(s => h('option', { value: s.id }, `${s.label} · ${date(s.savedAt)}`)));
      if (selected && !this.snapshots.some(s => s.id === selected)) select.append(h('option', { value: selected }, 'Unavailable saved snapshot · ' + selected)); select.value = selected || '';
    }
  }
  renderComparison() {
    const c = this.record?.comparison, report = c?.report;
    const compare = this.buttons.get('compare') || this.button('compare', 'Compare saved snapshots', () => this.compare(), true);
    this.comparison.replaceChildren(h('h3', 'Snapshot comparison'), compare,
      !c ? h('p.hint', 'Not compared. Save the selected snapshots, then compare explicitly.') : !report ? h('p.notice', c.issues.map(i => i.side + ': ' + i.message).join(' ')) : [
        h('p', `${report.summary.comparedDevices} paired device(s) · ${report.summary.changed} changed · ${report.summary.added} added · ${report.summary.removed} removed · ${report.summary.unknown} unknown observations`),
        ...report.warnings.map(w => h('p.hint', w)),
        h('details', h('summary', 'Inspect complete retained comparison and source references'), h('pre', JSON.stringify(c, null, 2))) ]);
  }
  renderToolSources() { const selected = this.evidenceSource.value; this.evidenceSource.replaceChildren(h('option', { value: '' }, 'Choose a completed open tool result'), ...this.app.tabs.filter(t => !t.disposed && ['runbook', 'capture-compare'].includes(t.toolKind) && t.report && !t.jobId && !t.busy).map(t => h('option', { value: t.id }, t.title))); this.evidenceSource.value = selected; }
  renderEvidence() { this.evidenceList.replaceChildren(...(this.record?.evidence || []).map(e => h('details.change-evidence', h('summary', `${e.label} · ${e.phase} · plan ${e.planVersion}${e.planVersion !== this.record.planVersion ? ' (prior scope; not eligible for current decisions)' : ''}`), h('p.hint', e.provenance), h('p.hint', 'Source reference: ' + e.id), h('pre', JSON.stringify(e.report, null, 2))))); }
  renderIncidents() { const selected = this.incident.value; this.incident.replaceChildren(h('option', { value: '' }, 'Choose an incident'), ...this.incidents.map(i => h('option', { value: i.id }, i.title))); this.incident.value = selected; }
  renderDecisions() {
    this.reviewSummary.textContent = this.record ? `User assessment: ${assessment(this.record)}. Saved phase: ${this.record.phase}.` + (this.record.phase !== 'review' ? ' Advance through manual maintenance and after evidence before editing review decisions.' : '') : 'Save a plan to begin.';
    const sources = (this.record?.evidence || []).filter(e => e.planVersion === this.record.planVersion).map(e => ({ id: e.id, label: e.label + ' · ' + e.phase }));
    if (this.record?.comparison?.report) sources.unshift({ id: this.record.comparison.id, label: 'Retained snapshot comparison' });
    this.decisionRows.replaceChildren(...this.plan.checks.map(check => {
      const decision = this.decisions.find(d => d.checkId === check.id); if (!decision) return h('p.hint', check.label + ' · Save the plan first.');
      const status = h('select.input', { 'aria-label': 'Decision for ' + check.id, onchange: e => { decision.status = e.target.value; this.changed(); } }, ['unknown', 'pass', 'fail'].map(v => h('option', { value: v }, v === 'unknown' ? 'Unknown / insufficient evidence' : v === 'pass' ? 'Pass · user assessment' : 'Fail · user assessment'))); status.value = decision.status;
      const refs = h('select.input', { multiple: true, size: Math.min(4, Math.max(2, sources.length)), 'aria-label': 'Evidence for ' + check.id, onchange: () => { decision.sourceRefs = [...refs.selectedOptions].map(o => o.value); this.changed(); } }, sources.map(s => h('option', { value: s.id, selected: decision.sourceRefs.includes(s.id) }, s.label)));
      const rationale = h('textarea.input', { rows: 2, maxLength: 4000, 'aria-label': 'Rationale for ' + check.id, oninput: e => { decision.rationale = e.target.value; this.changed(); } }); rationale.value = decision.rationale;
      return h('div.change-decision', h('strong', check.label), h('label.field', 'Decision', status), h('label.field', 'Rationale', rationale), h('label.field', 'Retained evidence (Ctrl-click for multiple)', refs));
    }));
  }
  addCheck() { if (!this.checkName.value.trim() || this.plan.checks.length >= 24 || this.busy) return; this.plan.checks.push({ id: 'check-' + crypto.randomUUID(), label: this.checkName.value.trim() }); this.checkName.value = ''; this.render(); this.changed(); }
  async savePlan() {
    if (!this.plan.name.trim()) return;
    if (this.record && JSON.stringify(this.plan) !== JSON.stringify(this.record.plan) && !await this.dialog({ title: 'Update plan scope', body: h('p', 'Save a new plan version and reset snapshot selections, acknowledgment and review decisions? Earlier evidence remains retained under its old plan version.'), buttons: [{ label: 'Cancel', value: null }, { label: 'Save new plan version', value: true, primary: true }] })) return;
    if (this.disposed) return;
    await this.request(() => this.record ? api.invoke('tools:changeSavePlan', this.record.id, this.record.revision, clone(this.plan)) : api.invoke('tools:changeCreate', clone(this.plan)), r => { this.maintenanceText.value = ''; this.maintenanceCheck.checked = false; this.page = r.phase; this.accept(r); this.status.textContent = 'Plan saved locally. No connection or check started.'; }, 'Saving plan…');
  }
  async saveSources() {
    if (!this.record || this.pendingAttachment || JSON.stringify(this.plan) !== JSON.stringify(this.record.plan) || JSON.stringify(this.sources) === JSON.stringify(this.record.sources)) return;
    if (JSON.stringify(this.decisions) !== JSON.stringify(decisionsInput(this.record)) && !await this.dialog({ title: 'Change snapshot sources', body: h('p', 'Saving different snapshot sources discards your unsaved review decisions and resets the retained comparison and assessments. Continue?'), buttons: [{ label: 'Cancel', value: null }, { label: 'Save sources and reset review', value: true, danger: true }] })) return;
    if (this.disposed) return;
    await this.request(() => api.invoke('tools:changeSetSnapshots', this.record.id, this.record.revision, clone(this.sources)), r => { this.accept(r); this.status.textContent = 'Snapshot references saved. Comparison and assessments reset to unreviewed.'; }, 'Saving source selection…');
  }
  async loadPairs() {
    if (!this.sources.beforeId || !this.sources.afterId || this.isDirty()) return;
    await this.request(() => Promise.all([api.invoke('tools:snapshotGet', this.sources.beforeId), api.invoke('tools:snapshotGet', this.sources.afterId)]), ([before, after]) => {
      this.pairs.replaceChildren(...before.report.devices.map(device => {
        const select = h('select.input', { 'aria-label': 'Pair before device ' + device.id, onchange: () => { this.sources.devicePairs = this.sources.devicePairs.filter(p => p.beforeDeviceId !== device.id); if (select.value) this.sources.devicePairs.push({ beforeDeviceId: device.id, afterDeviceId: select.value }); this.changed(); } }, h('option', { value: '' }, 'Automatic unique identity'), ...after.report.devices.map(d => h('option', { value: d.id }, `${d.label} · ${d.host} · ${d.port ?? 'unknown port'}`)));
        select.value = this.sources.devicePairs.find(p => p.beforeDeviceId === device.id)?.afterDeviceId || ''; return h('label.field', `${device.label} · ${device.host}`, select);
      })); this.pairDetails.open = true; this.status.textContent = 'Device identities loaded from saved snapshots. Save any explicit pair changes before comparing.';
    }, 'Reading saved snapshot identities…');
  }
  async compare() { if (!this.record || this.isDirty()) return; await this.request(() => api.invoke('tools:changeCompare', this.record.id, this.record.revision), r => { this.accept(r); this.status.textContent = 'Saved observations compared. No health verdict has been inferred.'; }, 'Comparing stored observations…'); }
  async advance() {
    if (!this.record || this.isRecordDirty() || this.pendingAttachment || this.record.phase === 'review') return;
    const to = PHASES[PHASES.indexOf(this.record.phase) + 1], input = { to };
    if (this.record.phase === 'maintenance') { input.acknowledgment = this.maintenanceCheck.checked; input.reason = this.maintenanceText.value; if (!input.acknowledgment || !input.reason.trim()) { this.showPage('maintenance'); this.status.textContent = 'Describe and explicitly acknowledge the manual maintenance activity before advancing.'; return; } }
    await this.request(() => api.invoke('tools:changeAdvance', this.record.id, this.record.revision, input), r => { this.page = r.phase; this.maintenanceCheck.checked = false; this.maintenanceText.value = ''; this.accept(r); this.status.textContent = 'Phase advanced. No connection, collection or configuration action was performed.'; }, 'Recording phase transition…');
  }
  async openRunbook() { try { const selected = this.runbook.value, tab = this.app.openTool('runbook', {}); if (selected) { await tab.ready; if (!tab.disposed) await tab.select(selected); } } catch (error) { if (!this.disposed) { this.status.setAttribute('role', 'alert'); this.status.textContent = errMsg(error); } } }
  async attachEvidence() {
    if (!this.record || this.isDirty()) return;
    const source = this.app.tabs.find(t => t.id === this.evidenceSource.value && !t.disposed && !t.jobId && !t.busy && t.report);
    if (!source && !this.pendingAttachment) { this.status.textContent = 'Choose a completed open Runbook or Capture Comparison result.'; return; }
    const pending = this.pendingAttachment || { label: source.title, phase: this.evidencePhase.value, text: JSON.stringify(source.report, null, 2) };
    if (new TextEncoder().encode(pending.text).length > 1024 * 1024) { this.status.textContent = 'This result exceeds the 1 MiB attachment limit. Keep it in its original tool or export it there.'; return; }
    const label = h('input.input', { value: pending.label, maxLength: 256, 'aria-label': 'Evidence copy label' }); const preview = h('textarea.input', { rows: 18, maxLength: 1048576, spellcheck: false, 'aria-label': 'Reviewed evidence JSON' }); preview.value = pending.text; const error = h('p', { role: 'alert' });
    const accepted = await this.dialog({ title: 'Review tool evidence copy', width: 850, body: [h('p', 'Review or edit this JSON before retaining it. It may contain sensitive observation text. The copy does not independently verify its origin or completeness.'), label, preview, error],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Attach reviewed copy', value: true, primary: true }], onSubmit: () => { try { JSON.parse(preview.value); if (!label.value.trim()) throw new Error('Enter an evidence label.'); } catch (e) { error.textContent = errMsg(e); return false; } } });
    if (!accepted || this.disposed) return;
    this.pendingAttachment = { label: label.value, phase: pending.phase, text: preview.value };
    await this.request(() => api.invoke('tools:changeAddEvidence', this.record.id, this.record.revision, { label: label.value, phase: pending.phase, report: JSON.parse(preview.value), reviewed: true }), r => {
      this.pendingAttachment = null; this.accept(r); this.status.textContent = 'Reviewed evidence copy retained. Assessments reset for a fresh review.';
    }, 'Saving reviewed evidence copy…');
  }
  async saveDecisions() { if (!this.record) return; await this.request(() => api.invoke('tools:changeDecide', this.record.id, this.record.revision, clone(this.decisions)), r => { this.accept(r); this.status.textContent = 'Explicit user assessments saved with rationale and evidence references.'; }, 'Saving review decisions…'); }
  async reviewExport(label) {
    const report = await this.request(() => api.invoke('tools:changePreview', this.record.id, this.record.revision), null, 'Preparing the saved report for review…');
    if (!report || this.disposed) return false;
    return await this.dialog({ title: 'Review retained report', width: 850, body: [h('p', 'This report includes scope, notes, source identifiers, comparisons and full retained evidence. Review before exporting or adding it to an incident.'), h('pre', { style: { maxHeight: '400px', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, report.text)], buttons: [{ label: 'Cancel', value: null }, { label, value: true, primary: true }] });
  }
  async export(format) { if (!this.record || this.isDirty() || !await this.reviewExport('Choose export file') || this.disposed) return; await this.request(() => api.invoke('tools:changeExport', this.record.id, this.record.revision, format), result => { this.status.textContent = result ? 'Complete retained report exported.' : 'Export cancelled.'; }, 'Choose an export destination…'); }
  async addToIncident() { if (!this.record || this.isDirty() || !this.incident.value || !await this.reviewExport('Add reviewed report') || this.disposed) return; await this.request(() => api.invoke('tools:changeAddToIncident', this.record.id, this.record.revision, this.incident.value), () => { this.status.textContent = 'Complete retained report copied to the selected incident.'; }, 'Copying reviewed report to incident…'); }
  async remove() {
    if (!this.record || this.isDirty() || !await this.dialog({ title: 'Delete validation', body: h('p', 'Delete this workflow record? Original snapshots, source reports and incident copies remain.'), buttons: [{ label: 'Cancel', value: null }, { label: 'Delete validation', value: true, danger: true }] }) || this.disposed) return;
    const selected = this.record.id;
    await this.request(() => api.invoke('tools:changeRemove', selected, this.record.revision), () => { this.records = this.records.filter(r => r.id !== selected); this.record = null; this.plan = starter(); this.sources = { beforeId: null, afterId: null, devicePairs: [] }; this.decisions = []; this.pendingAttachment = null; this.maintenanceText.value = ''; this.maintenanceCheck.checked = false; this.baseline = this.values(); this.page = 'plan'; this.render(); this.renderList(); this.status.textContent = 'Workflow deleted; original evidence is retained by its owners.'; }, 'Deleting saved validation…');
  }
  updateBlockers() { return [...(this.busy || this.prompting ? ['Wait for the change validation operation.'] : []), ...(this.hasUnsavedInput() ? ['Save or discard the unsaved change validation input.'] : [])]; }
  async requestClose() { if (this.busy || this.prompting) { toast('Wait for the change validation operation to finish.', 'err'); return false; } return this.discard(); }
  show() {} hide() {} focus() { this.fields.name.focus(); }
  statusSegments() { return [{ icon: 'route', text: this.title }, { text: this.record?.phase || 'New plan' }, { text: this.isDirty() ? 'Unsaved changes' : this.record ? assessment(this.record) : 'Ready' }]; }
  dispose() { this.disposed = true; this.seq++; this.openDialog?.close(null); }
}
