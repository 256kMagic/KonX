import { EvidenceContext } from './copilot-context.mjs';
export { INVESTIGATION_COPILOT_KINDS } from './copilot-context.mjs';
import { h, contextMenu, toast, errMsg } from './ui.js';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const list = value => Array.isArray(value) ? value : [];
const selection = tab => tab.table?.selectedRows?.() || [];
const ref = value => value == null ? null : pick(value, ['deviceId', 'commandId', 'command', 'line', 'complete', 'collectedAt', 'ip', 'mac']);
const notice = (out, message) => { if (!out.includes(message)) out.push(message); };
function mapBound(value, convert, omissions, name) {
  const rows = list(value); if (rows.length > 200) notice(omissions, `Partial coverage: ${name} includes at most 200 complete entries.`);
  return rows.slice(0, 200).map(convert);
}
const deviceFields = ['id', 'label', 'host', 'port', 'hostname', 'platform', 'collectedAt'];
const factFields = ['name', 'description', 'status', 'protocol', 'vlan', 'duplex', 'speed', 'inputErrors', 'crc', 'outputErrors', 'id', 'ports', 'mac', 'type', 'interface', 'ip', 'age', 'deviceId', 'managementAddress', 'localInterface', 'remoteInterface', 'capabilities', 'admin', 'oper', 'powerWatts', 'device', 'class', 'maxWatts', 'prefix', 'nextHop', 'distance', 'metric', 'heading', 'lines'];
const coverage = value => list(value).slice(0, 200).map(item => pick(item, ['commandId', 'complete', 'status', 'recognizedRows', 'reason']));
function deviceSummary(device) { return { ...pick(device, deviceFields), coverage: coverage(device?.coverage), warnings: device?.warnings || [] }; }
function parsedFact(value) { return value == null ? null : { ...pick(value, factFields), source: ref(value.source) }; }
function traceFacts(trace, omissions) {
  return { query: trace.query, warnings: trace.warnings, matches: mapBound(trace.matches, match => ({ ...pick(match, ['deviceId', 'deviceLabel', 'host', 'interface', 'mac', 'vlan', 'classification', 'portStatus', 'warnings']), source: ref(match.source) }), omissions, 'trace matches'),
    paths: mapBound(trace.paths, path => ({ ...pick(path, ['mac', 'vlan', 'status', 'reason']), steps: mapBound(path.steps, step => ({ ...pick(step, ['deviceId', 'deviceLabel', 'host', 'interface', 'remoteDeviceId', 'remoteInterface', 'classification', 'portStatus', 'warnings']), source: ref(step.source) }), omissions, 'path steps') }), omissions, 'candidate paths') };
}
function changeFact(change, records, omissions) {
  const values = {};
  for (const side of ['before', 'after']) {
    const source = change[side + 'Source'], device = records?.[side]?.report?.devices?.find(device => device.id === source?.deviceId), command = device?.commands?.find(command => command.id === source?.commandId);
    if (command && (command.status !== 'ok' || device.coverage?.find(item => item.commandId === command.id)?.complete !== true) || source?.complete === false) { values[side] = null; notice(omissions, 'Incomplete source command values were omitted whole from the selected comparison.'); }
    else {
      values[side] = parsedFact(change[side]);
      // Configuration lines form one source text field. Preserve that boundary
      // for whole-field redaction instead of splitting a multiline value.
      if (Array.isArray(values[side]?.lines)) {
        const lines = values[side].lines;
        if (lines.reduce((n, line) => n + (typeof line === 'string' ? line.length + 1 : 0), 0) > 48 * 1024) {
          values[side].text = null; notice(omissions, 'Complete configuration section exceeded the text limit and was omitted whole.');
        } else values[side].text = lines.join('\n');
        delete values[side].lines;
      }
    }
    values[side + 'Source'] = ref(source);
  }
  return { ...pick(change, ['deviceId', 'deviceLabel', 'category', 'status', 'identity', 'reason', 'counterDeltas']), ...values };
}
function snmp(trap, omissions) {
  if (!trap) return undefined;
  return { ...pick(trap, ['version', 'enterpriseOid', 'agentAddress', 'genericTrap', 'specificTrap', 'uptimeTicks', 'trapOid', 'trapOidSource', 'requestId']),
    variables: mapBound(trap.variables, variable => {
      const result = pick(variable, ['oid', 'type', 'byteLength', 'omitted', 'truncated']);
      if (variable.truncated) { result.value = null; notice(omissions, 'Truncated SNMP variable text was omitted whole; its OID, type and length are retained.'); }
      else result.value = variable.value ?? null;
      return result;
    }, omissions, 'SNMP variables') };
}
function eventFact(record, omissions) {
  return { ...pick(record, ['listenerId', 'sequence', 'receivedAt', 'protocol', 'format', 'parseStatus', 'severity', 'facility', 'timestamp', 'timestampText', 'timestampUncertainty', 'hostname', 'appName', 'procId', 'msgId', 'messageEncoding', 'message', 'reason']),
    source: pick(record.source, ['address', 'port', 'family']),
    ...(record.structuredData ? { structuredData: mapBound(record.structuredData, element => ({ id: element.id, params: mapBound(element.params, param => pick(param, ['name', 'value']), omissions, 'syslog parameters') }), omissions, 'syslog structured data') } : {}),
    ...(record.snmp ? { snmp: snmp(record.snmp, omissions) } : {}) };
}
function incidentEvidence(item, includeText, omissions) {
  const result = pick(item, ['id', 'label', 'kind', 'sourceName', 'originalPath', 'observedAt', 'addedAt', 'sourceModifiedAt', 'bytes', 'integrity', 'sha256', 'previewError', 'analysisError', 'previewOmitted', 'timelineCoverage', 'textPreviewTruncated']);
  if (includeText) {
    if (item.textPreviewTruncated || item.previewOmitted || item.integrity === 'error') { result.textPreview = null; notice(omissions, 'Truncated, omitted or failed-integrity evidence text was omitted whole. No file was read.'); }
    else result.textPreview = item.textPreview ?? null;
    if (item.textPreview == null) notice(omissions, 'No complete retained text preview is available for this evidence. No file was read.');
  }
  return result;
}
function timelineFact(event, omissions) {
  const result = pick(event, ['id', 'evidenceId', 'timestamp', 'timestampText', 'timestampStatus', 'time', 'timeText', 'line', 'kind', 'observedAt', 'addedAt', 'messageTruncated']);
  if (event.messageTruncated) { result.message = null; notice(omissions, 'Truncated incident timeline messages were omitted whole. Their source evidence and line references remain available.'); }
  else result.message = event.message ?? null;
  return result;
}
function runbookStep(step, omissions) {
  const evidence = step.evidence || {}, result = pick(step, ['id', 'title', 'kind', 'status', 'summary', 'startedAt', 'finishedAt', 'durationMs', 'incomplete', 'skipped']);
  result.evidence = pick(evidence, ['instructions', 'error', 'target', 'port', 'recordType', 'literal', 'server', 'servers', 'errors', 'ok', 'time', 'ms', 'ttl', 'state', 'address', 'code', 'reason', 'connectionId', 'rawOutputIncluded', 'limited']);
  if (evidence.limited) notice(omissions, 'The retained DNS result is limited; unretained answers remain unknown.');
  if (evidence.resolution) result.evidence.resolution = { ...pick(evidence.resolution, ['address', 'literal', 'family', 'error', 'errors', 'server', 'warning']),
    lookups: mapBound(evidence.resolution.lookups, lookup => ({ ...pick(lookup, ['server', 'ms', 'errors', 'limited']), records: mapBound(lookup.records, record => pick(record, ['type', 'name', 'value', 'ttl']), omissions, 'resolution answers') }), omissions, 'resolution queries') };
  if (evidence.records) result.evidence.records = mapBound(evidence.records, record => typeof record === 'string' ? record : pick(record, ['type', 'value', 'address', 'family', 'ttl', 'exchange', 'priority', 'name', 'target', 'port', 'weight', 'entries', 'nsname', 'hostmaster', 'serial', 'refresh', 'retry', 'expire', 'minttl']), omissions, 'DNS records');
  if (evidence.devices) result.evidence.devices = mapBound(evidence.devices, device => ({ ...deviceSummary(device), ...pick(device, ['interfaceCount', 'vlanCount']), commands: mapBound(device.commands, command => pick(command, ['id', 'status', 'error']), omissions, 'device command status') }), omissions, 'runbook devices');
  return result;
}
const plan = value => ({ ...pick(value, ['name', 'scope', 'expectedOutcome', 'rollbackPlan']), checks: list(value?.checks).map(check => pick(check, ['id', 'label'])) });
const decision = value => pick(value, ['checkId', 'status', 'rationale', 'sourceRefs', 'reviewedAt', 'planVersion']);

export function investigationContextChoices(tab) {
  const chosen = selection(tab), kind = tab.toolKind;
  const item = (choice, label, available) => ({ choice, label, disabled: !available });
  if (kind === 'device') return [item('facts', 'Explain selected device facts', !!tab.currentDevice()?.facts && chosen.length), item('command', 'Explain complete selected command output', !!tab.currentDevice()?.commands?.some(command => command.id === tab.commandSelect.value)), item('trace', 'Explain retained endpoint trace candidates', !!tab.trace)];
  if (kind === 'snapshots') return [item('changes', 'Explain selected before/after changes', !!tab.report && chosen.length)];
  if (kind === 'topology') return [item('selection', 'Explain selected topology node or link', !!tab.report && !!tab.selection), item('paths', 'Explain retained candidate paths', !!tab.report?.endpoint)];
  if (kind === 'events') return [item('selected-events', 'Explain explicitly selected events', tab.selected.size > 0)];
  if (kind === 'sites') return [item('draft', 'Explain current workspace draft and references', !!tab.draft), item('saved', 'Explain saved workspace and references', !!tab.saved)];
  if (kind === 'incidents') return [item('evidence', 'Explain selected incident evidence', !!tab.selectedEvidence), item('timeline', 'Explain selected timeline event', tab.mode === 'timeline' && chosen.length > 0)];
  if (kind === 'runbook') return [item('steps', 'Explain selected retained runbook steps', !!tab.report && chosen.length > 0 && !tab.jobId)];
  if (kind === 'change-validation') return [item('draft-plan', 'Review current plan draft', !!tab.plan), item('saved-plan', 'Explain saved plan and manual decisions', !!tab.record),
    ...list(tab.record?.evidence).map((e, index) => item('evidence:' + index, 'Explain retained evidence: ' + e.label, true)), item('comparison', 'Explain saved before/after comparison', !!tab.record?.comparison)];
  return [];
}

/** Source revisions change at producer boundaries, never through capture or redraw. */
export function investigationChanged(tab) {
  if (!tab.copilot) return;
  tab.copilot.touch();
}
export function installInvestigationContext(tab) {
  tab.copilot = new EvidenceContext(tab.toolKind, tab.id, tab.title, { onChange: () => tab.app.copilot?.sourceChanged(tab) });
  tab.copilot.begin({ view: tab.toolKind }, tab.id + ':retained-evidence'); tab.copilot.state = 'unknown';
  tab.copilotContextChoices = () => investigationContextChoices(tab);
  tab.captureCopilotContext = options => captureInvestigationContext(tab, options);
  tab.navigateCopilotSource = locator => navigateInvestigationSource(tab, locator);
  tab.copilotButton = h('button.btn.sm', { 'aria-label': 'Ask KonX-AI about investigation evidence', onclick: event => {
    contextMenu(event.clientX, event.clientY, tab.copilotContextChoices().map(choice => ({ ...choice, action: () => {
      if (choice.disabled || tab.disposed) return;
      try { const snapshot = tab.captureCopilotContext({ choice: choice.choice }); Promise.resolve(tab.app.openCopilot(tab, { snapshot, question: choice.label + '. Distinguish observations, manual assessments, inferences and unknowns.' })).catch(error => toast(errMsg(error), 'error')); }
      catch (error) { toast(errMsg(error), 'error'); }
    } })));
  } }, 'Ask KonX-AI');
  tab.el.querySelector('.tool-title')?.append(tab.copilotButton);
}

export function captureInvestigationContext(tab, { choice } = {}) {
  const allowed = investigationContextChoices(tab).find(item => item.choice === choice);
  if (!allowed || allowed.disabled || tab.disposed) throw new Error('Choose available investigation evidence explicitly. Nothing has been collected or read.');
  const omissions = [], rows = []; let summary = { choice }, total = null, state = 'complete', startedAt = null, completedAt = null;
  const row = (fact, locator = {}) => rows.push({ fact: { ...fact, ...(fact.id !== undefined ? { sourceId: fact.id } : {}), id: 'row:' + (rows.length + 1), locator: { ...locator, sourceRevision: tab.copilot.revision } }, selected: true });
  const kind = tab.toolKind;
  if (kind === 'device') {
    const device = tab.currentDevice(); summary = { ...summary, device: deviceSummary(device), report: pick(tab.report, ['schemaVersion', 'collectedAt', 'createdAt', 'limitations']) }; startedAt = device?.collectedAt ?? null;
    if (choice === 'facts') {
      const category = tab.factSelect.value, facts = list(device.facts[category]); total = facts.length;
      for (const selected of selection(tab)) { const fact = facts[selected._index]; if (fact) row({ category, observation: parsedFact(fact) }, { type: 'device-fact', deviceId: device.id, category, index: selected._index }); }
    } else if (choice === 'command') {
      const command = device.commands.find(item => item.id === tab.commandSelect.value); total = 1;
      const commandCoverage = device.coverage?.find(item => item.commandId === command.id);
      const result = { ...pick(command, ['id', 'command', 'status', 'startedAt', 'finishedAt', 'durationMs', 'error']), coverage: commandCoverage ? coverage([commandCoverage])[0] : null };
      if (command.status !== 'ok' || commandCoverage?.complete !== true) { result.output = null; notice(omissions, 'Incomplete or unverified command output was omitted whole. Parsed facts are available through a separate explicit choice.'); }
      else result.output = command.output ?? null;
      row(result, { type: 'device-command', deviceId: device.id, commandId: command.id });
      if (command.status !== 'ok') notice(omissions, 'Selected command did not report successful completion; missing observations remain unknown.');
    } else { summary = { ...summary, device: undefined, interpretation: 'Candidate paths are derived from retained observations, not verified forwarding or direct attachment.' }; row(traceFacts(tab.trace, omissions), { type: 'device-trace' }); total = 1; }
    if (tab.jobId || tab.tracing) notice(omissions, 'A new request is pending. This attachment contains the previously retained result, not current form targets or future results.');
    notice(omissions, 'Only explicitly chosen device evidence is attached; live device state and unselected commands are unknown.');
  } else if (kind === 'snapshots') {
    const report = tab.report; summary = { ...summary, before: report.before, after: report.after, summary: report.summary, warnings: report.warnings }; total = report.changes.length;
    for (const selected of selection(tab)) { const change = report.changes[selected._index]; if (change) row(changeFact(change, tab.records, omissions), { type: 'snapshot-change', index: selected._index, beforeId: report.before?.id, afterId: report.after?.id }); }
    notice(omissions, 'Only selected changes are attached. A difference is not a failure; missing or incomplete observations remain unknown.');
  } else if (kind === 'topology') {
    const graph = tab.report; startedAt = graph.generatedAt; summary = { ...summary, generatedAt: graph.generatedAt, staleHours: graph.staleHours, coverage: graph.coverage, limitations: graph.limitations };
    if (choice === 'paths') { row({ ...traceFacts(graph.endpoint, omissions), arpEvidence: mapBound(graph.endpoint.arpEvidence, ref, omissions, 'ARP source references') }, { type: 'topology-paths' }); total = 1; }
    else if (tab.selection.type === 'node') {
      const node = graph.nodes.find(node => node.id === tab.selection.id); if (!node) throw new Error('Selected topology node is unavailable.');
      row({ ...pick(node, ['id', 'label', 'kind', 'host', 'hostname', 'collectedAt', 'age', 'resolution', 'mac', 'vlan', 'candidateDeviceIds', 'warnings', 'deviceId', 'interfaceCount']), coverage: coverage(node.coverage) }, { type: 'topology-node', id: node.id }); total = graph.nodes.length;
    } else {
      const link = graph.links.find(link => link.id === tab.selection.id); if (!link) throw new Error('Selected topology link is unavailable.');
      row({ ...pick(link, ['id', 'from', 'to', 'protocols', 'kind', 'age', 'resolution', 'localInterface', 'remoteInterface', 'localState', 'collectedAt', 'meaning']), evidence: mapBound(link.evidence, ref, omissions, 'link source references'),
        endpoints: [link.from, link.to].map(id => pick(graph.nodes.find(node => node.id === id), ['id', 'label', 'kind', 'host', 'resolution'])) }, { type: 'topology-link', id: link.id }); total = graph.links.length;
    }
    if (graph.coverage?.clippedFields) {
      // The graph reports clipping only in aggregate. It cannot identify which
      // field still contains a secret prefix, so do not guess from an ellipsis.
      rows.length = 0; row({ graphEvidence: null }, { type: 'topology-clipped' });
      delete summary.limitations;
      notice(omissions, 'Selected graph evidence was omitted whole because the topology producer reports clipped fields without identifying each affected field. Inspect complete source observations in Device Inspector.');
    }
    notice(omissions, 'Topology links and paths are observations or candidates, not verified live reachability. Unselected graph evidence is excluded.');
  } else if (kind === 'events') {
    summary = { ...summary, listenerId: tab.listenerId, listener: pick(tab.summary, ['state', 'settings', 'startedAt', 'stoppedAt', 'retainedRecords', 'firstSequence', 'lastSequence', 'counters']) };
    total = tab.records.length; startedAt = tab.summary?.startedAt ?? null; completedAt = tab.summary?.stoppedAt ?? null; state = tab.summary?.hasOwnership ? 'running' : 'complete';
    for (const record of tab.records) if (tab.selected.has(record.sequence)) row(eventFact(record, omissions), { type: 'event', listenerId: tab.listenerId, sequence: record.sequence, receivedAt: record.receivedAt });
    notice(omissions, 'Only selected retained UDP events are attached. UDP delivery is not complete; source time stays unknown without a complete sender timestamp. Receive time is separate.');
  } else if (kind === 'sites') {
    const workspace = choice === 'saved' ? tab.saved : tab.draft;
    summary = { ...summary, savedIdentity: pick(tab.saved, ['id', 'revision', 'createdAt', 'updatedAt']), draft: choice === 'draft', unsavedChanges: choice === 'draft' ? tab.isDirty() : false };
    row({ ...pick(workspace, ['name', 'description', 'notes']), sessions: mapBound(workspace.sessions, item => pick(item, ['id', 'name', 'group']), omissions, 'session references'),
      captures: mapBound(workspace.captures, item => pick(item, ['id', 'name', 'path']), omissions, 'capture references'), incidentIds: workspace.incidentIds,
      layout: { preset: workspace.layout?.preset, panels: mapBound(workspace.layout?.panels, item => pick(item, ['key', 'kind', 'referenceId', 'toolKind', 'sessionMode', 'placement', 'slot', 'bounds']), omissions, 'layout panel references') } }, { type: 'site', id: tab.saved?.id ?? null, draft: choice === 'draft' }); total = 1;
    state = choice === 'draft' ? 'unknown' : 'complete'; notice(omissions, 'Workspace references were not resolved. No saved credentials, capture contents, incident contents or live connections were read.');
  } else if (kind === 'incidents') {
    const report = tab.report; summary = { ...summary, incident: pick(report, ['id', 'title', 'description', 'createdAt', 'updatedAt', 'timelineLimited', 'totalBytes']) };
    if (choice === 'evidence') {
      const item = report.evidence.find(item => item.id === tab.selectedEvidence.id); if (!item) throw new Error('Selected retained evidence is unavailable.');
      row(incidentEvidence(item, true, omissions), { type: 'incident-evidence', incidentId: report.id, evidenceId: item.id }); total = report.evidence.length;
    } else {
      for (const selected of selection(tab)) { const event = report.timeline.find(event => event.id === selected.id); if (event) row({ event: timelineFact(event, omissions), evidence: incidentEvidence(report.evidence.find(item => item.id === event.evidenceId) || {}, false, omissions) }, { type: 'incident-event', incidentId: report.id, eventId: event.id, evidenceId: event.evidenceId, line: event.line }); } total = report.timeline.length;
    }
    notice(omissions, 'Only selected retained incident evidence is attached. No evidence file was opened; unsaved notes and unselected evidence are excluded.');
  } else if (kind === 'runbook') {
    const report = tab.report; summary = { ...summary, report: pick(report, ['schemaVersion', 'name', 'startedAt', 'finishedAt', 'stopped', 'complete', 'warnings']) }; startedAt = report.startedAt; completedAt = report.finishedAt; state = report.complete ? 'complete' : report.stopped ? 'stopped' : 'unknown'; total = report.steps.length;
    for (const selected of selection(tab)) { const step = report.steps.find(step => step.id === selected.id); if (step) row(runbookStep(step, omissions), { type: 'runbook-step', id: step.id, startedAt: report.startedAt }); }
    notice(omissions, 'Only selected steps from the retained report are attached, not the editable procedure or current input fields. Manual steps remain unknown until independently evidenced.');
  } else if (kind === 'change-validation') {
    const record = tab.record; summary = { ...summary, validation: pick(record, ['id', 'revision', 'phase', 'planVersion', 'createdAt', 'updatedAt']), draft: choice === 'draft-plan', manualAssessment: true };
    if (choice === 'draft-plan') { row({ plan: plan(tab.plan), unsavedChanges: tab.isRecordDirty() }, { type: 'change-plan', id: record?.id ?? null, draft: true }); state = 'unknown'; total = 1; }
    else if (choice === 'saved-plan') { row({ plan: plan(record.plan), sources: pick(record.sources, ['beforeId', 'afterId', 'devicePairs']), maintenance: pick(record.maintenance, ['acknowledgedAt', 'reason']), decisions: mapBound(record.decisions, decision, omissions, 'manual decisions') }, { type: 'change-plan', id: record.id, revision: record.revision }); total = 1; }
    else if (choice === 'comparison') {
      const comparison = record.comparison, report = comparison.report; summary.comparison = pick(comparison, ['id', 'createdAt', 'status', 'issues', 'planVersion']);
      summary.before = report?.before; summary.after = report?.after; summary.coverage = report?.summary; total = report?.changes?.length ?? 0;
      for (const [index, change] of list(report?.changes).entries()) { row(changeFact(change, null, omissions), { type: 'change-comparison', id: record.id, comparisonId: comparison.id, index }); if (rows.length > 200) break; }
      if (!report) notice(omissions, 'No comparison report is available. Source errors do not establish absence of changes.');
    } else {
      const item = record.evidence[Number(choice.slice(9))]; summary.evidence = pick(item, ['id', 'label', 'phase', 'planVersion', 'addedAt', 'provenance']); total = 1;
      // Reviewed copies have no verified origin. Include their bounded JSON as
      // one complete field: never reinterpret arbitrary nested data as authority.
      row({ reviewedCopy: item.report, originVerified: false, eligibleForCurrentPlan: item.planVersion === record.planVersion }, { type: 'change-evidence', id: record.id, evidenceId: item.id, revision: record.revision });
      notice(omissions, 'This is a user-reviewed evidence copy; origin and completeness were not independently verified.');
    }
    notice(omissions, 'Pass/fail decisions are explicit manual assessments, not inferred health verdicts. A missing decision or missing evidence remains unknown.');
  }
  if (!rows.length && !(kind === 'change-validation' && choice === 'comparison')) throw new Error('The selected evidence is no longer available. Select a retained item again.');
  // Use an ephemeral view of the owner with the same stable revision. A choice
  // cannot mutate source state or relabel a retained report as a fresh run.
  const owner = Object.assign(Object.create(Object.getPrototypeOf(tab.copilot)), tab.copilot, { state, startedAt, completedAt });
  return owner.capture({ rows, hasSelection: true, summary, observed: rows.length, total, complete: false, omissions }, { mode: 'selected' });
}

export function navigateInvestigationSource(tab, locator) {
  if (!locator || tab.disposed || locator.sourceRevision !== tab.copilot.revision) return false;
  if (locator.type === 'topology-node' || locator.type === 'topology-link') { const type = locator.type === 'topology-node' ? 'node' : 'link'; if (!tab.report?.[type === 'node' ? 'nodes' : 'links'].some(item => item.id === locator.id)) return false; tab.select(type, locator.id); return true; }
  if (locator.type === 'event') { const record = tab.records.find(item => item.sequence === locator.sequence && item.listenerId === locator.listenerId && item.receivedAt === locator.receivedAt); if (!record) return false; tab.detailSequence = record.sequence; tab.renderDetails(); return true; }
  if (locator.type === 'incident-evidence' || locator.type === 'incident-event') { if (tab.report?.id !== locator.incidentId || !tab.report.evidence.some(item => item.id === locator.evidenceId)) return false; tab.showEvidence(locator.evidenceId, locator.line); return true; }
  if (locator.type === 'runbook-step') { if (tab.report?.startedAt !== locator.startedAt) return false; const step = tab.report.steps.find(item => item.id === locator.id); if (!step) return false; tab.showStep(step); return true; }
  if (locator.type === 'device-command') { const device = tab.report?.devices.find(item => item.id === locator.deviceId); if (!device?.commands.some(item => item.id === locator.commandId)) return false; tab.deviceSelect.value = device.id; tab.renderDevice(); tab.commandSelect.value = locator.commandId; tab.renderEvidence(); return true; }
  return false;
}
