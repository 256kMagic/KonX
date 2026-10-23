// Workspace evidence is collected only by an explicit per-view choice.
// This module reads existing models, never remote files, log files or other docs.
import { EvidenceContext, contextRows } from './copilot-context.mjs';
import { toast, errMsg } from './ui.js';

export const WORKSPACE_TEXT_LIMIT = 48 * 1024;
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => scalar(value?.[key])).map(key => [key, value[key]]));
const SESSION_FIELDS = ['id', 'name', 'protocol', 'host', 'port', 'username', 'auth', 'serialPort', 'baudRate', 'dataBits', 'parity', 'stopBits', 'flowControl', 'serialAutoBaudProbe', 'keepalive', 'termType'];
const row = fact => [{ fact: { id: 'row:1', ...fact }, selected: false }];
const now = () => new Date().toISOString();
const rename = (snapshot, kind, title) => Object.freeze({ ...snapshot, kind, title });
const collectionScope = (snapshot, choice) => Object.freeze({ ...snapshot, scope: Object.freeze({ ...snapshot.scope, inputs: Object.freeze({ collection: choice }) }) });

export function safeSessionMetadata(session) {
  const out = pick(session, SESSION_FIELDS);
  if (Array.isArray(session?.forwards)) out.configuredForwards = session.forwards.slice(0, 200).map(item => pick(item, ['type', 'listenHost', 'listenPort', 'destHost', 'destPort']));
  out.configuredForwardCount = Array.isArray(session?.forwards) ? session.forwards.length : null;
  return out;
}

export function requestedConnectionMetadata(tab) {
  const saved = tab.spec?.sessionId ? tab.app.sessions?.data?.sessions.find(session => session.id === tab.spec.sessionId) : null;
  const source = saved || (tab.spec?.sessionId || tab.spec?.fromConn ? {} : tab.spec);
  return { savedSessionId: tab.spec?.sessionId || null, fromConnectionId: tab.spec?.fromConn || null,
    configurationAvailable: Boolean(saved || !tab.spec?.sessionId && !tab.spec?.fromConn), requested: safeSessionMetadata(source) };
}

export function createWorkspaceEvidence(tab, title) {
  const context = new EvidenceContext(tab.kind, tab.id, title, { onChange: () => tab.app.copilot?.sourceChanged(tab) });
  context.begin({ view: tab.kind }, `${tab.id}:view`);
  context.state = 'unknown';
  return context;
}

export function workspaceContextChoices(tab) {
  if (tab?.disposed) return [];
  if (tab?.kind === 'terminal') return [
    { choice: 'selection', label: 'Explain selected terminal text', disabled: !tab.term?.hasSelection() },
    { choice: 'visible', label: 'Explain visible terminal text' },
    { choice: 'connection', label: 'Explain connection diagnostics' },
  ];
  if (tab?.kind === 'notepad') return [
    { choice: 'selection', label: 'Explain selected Notepad text', disabled: !tab.current || !(tab.editor?.getSelections() || []).some(range => !range.isEmpty()) },
    { choice: 'document', label: 'Explain current Notepad document', disabled: !tab.current },
  ];
  if (tab?.kind === 'sftp') return [
    { choice: 'local-selection', label: 'Explain selected local file metadata', disabled: !tab.local.table.selected.size },
    { choice: 'remote-selection', label: 'Explain selected remote file metadata', disabled: !tab.remote.table.selected.size },
    { choice: 'local-listing', label: 'Explain displayed local listing metadata' },
    { choice: 'remote-listing', label: 'Explain displayed remote listing metadata' },
    { choice: 'transfers', label: 'Explain transfer status and errors' },
  ];
  return [];
}

export function workspaceCopilotItems(tab) {
  return workspaceContextChoices(tab).map(item => ({ ...item, icon: 'insight', action: () => {
    try {
      const snapshot = tab.captureCopilotContext({ choice: item.choice });
      return tab.app.openCopilot(tab, { snapshot, question: `Explain this ${snapshot.title.toLowerCase()} evidence. Distinguish observations, unknowns and possible causes. Suggest checks I can choose to perform; do not execute or apply changes.` });
    } catch (error) { toast(errMsg(error), 'err'); }
  } }));
}

function requireChoice(tab, choice) {
  const found = workspaceContextChoices(tab).find(item => item.choice === choice);
  if (!found) throw new Error('Choose which current workspace evidence to attach to Copilot.');
  if (found.disabled) throw new Error('The selected workspace evidence is unavailable. Select text or metadata first.');
}

// Bound allocation before joining terminal lines or calling getSelection().
// Full wrapped logical lines clipped by the viewport are omitted, not extended
// into ambient scrollback or cut into partial credentials.
function boundedTerminalRange(term, start, end) {
  const buffer = term.buffer.active;
  if ((end - start + 1) * term.cols > WORKSPACE_TEXT_LIMIT) return false;
  let length = end - start + 1;
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y);
    for (let x = 0; line && x < term.cols; x++) {
      length += line.getCell(x)?.getChars().length || 1;
      if (length > WORKSPACE_TEXT_LIMIT) return false;
    }
  }
  return true;
}

export function captureTerminalContext(tab, { choice } = {}) {
  requireChoice(tab, choice);
  if (choice === 'connection') {
    const info = tab.info, requested = tab.copilot.inputs;
    const connection = pick(info, ['protocol', 'host', 'port', 'username', 'serialPort', 'baudRate', 'cipher', 'kex', 'via']);
    if (info?.hostKey) connection.hostKey = pick(info.hostKey, ['keyType', 'fingerprint']);
    const autoBaud = info?.autoBaud ? pick(info.autoBaud, ['method', 'confidence', 'baudRate', 'probe', 'candidatesTested', 'score', 'confirmed']) : null;
    const diagnostics = { connectionState: tab.state, message: tab.statusMessage || null, negotiated: connection,
      serialDetection: autoBaud, serialProgress: tab.baudDetection || null,
      logging: { active: tab.state === 'connected' && Boolean(info?.logging), pending: Boolean(tab.logRequest), path: info?.logging || null, lastPath: tab.lastLogPath || null, error: tab.logError || null },
      forwardingRuntimeStatus: null };
    const omissions = ['Only connection metadata and status are attached. Passwords, key paths, private keys, login commands, logon actions and console/logfile contents are excluded.',
      'Forwarding settings describe configured rules only. Runtime listener success and reachability are not observed by this view.'];
    if (requested.requested?.configuredForwardCount > 200) omissions.push('Only the first 200 configured forwarding rules are retained.');
    if (!requested.configurationAvailable) omissions.push('Original saved connection settings are unavailable in this view; missing configuration remains unknown.');
    return rename(tab.copilot.capture({ rows: row(diagnostics), summary: { evidence: 'local connection diagnostics' }, observed: 1, total: 1, omissions }), 'connection', 'Connection diagnostics');
  }
  const term = tab.term, buffer = term.buffer.active, omissions = [], facts = { choice, buffer: buffer.type };
  let text = null, total = null;
  if (choice === 'selection') {
    const range = term.getSelectionPosition();
    facts.range = range ? { start: pick(range.start, ['x', 'y']), end: pick(range.end, ['x', 'y']) } : null;
    if (range && boundedTerminalRange(term, range.start.y, range.end.y)) text = term.getSelection();
    else omissions.push('The complete terminal selection exceeds the text limit or is unavailable. Select a smaller region; no selection prefix was attached.');
    omissions.push('Only explicitly selected text is attached. Selections may omit surrounding context or cut across sensitive values; review the complete prepared request.');
  } else {
    const start = buffer.viewportY, end = Math.min(buffer.length - 1, start + term.rows - 1);
    facts.viewport = { startRow: start, endRow: end, columns: term.cols }; total = end - start + 1;
    if (!boundedTerminalRange(term, start, end)) omissions.push('The complete viewport exceeds the text limit. No viewport prefix was attached; select a smaller region.');
    else {
      const lines = []; let current = null, clipped = false, skipped = 0;
      for (let y = start; y <= end; y++) {
        const line = buffer.getLine(y); if (!line) continue;
        if (!line.isWrapped) { if (current !== null && !clipped) lines.push(current); current = ''; clipped = false; }
        else if (y === start) clipped = true;
        if (clipped) skipped++; else current += line.translateToString(buffer.getLine(y + 1)?.isWrapped !== true);
      }
      if (buffer.getLine(end + 1)?.isWrapped) { if (current !== null) skipped++; }
      else if (!clipped && current !== null) lines.push(current);
      if (skipped) omissions.push('Wrapped logical lines clipped by the viewport were wholly excluded; no off-screen scrollback was collected.');
      text = lines.join('\n');
    }
    omissions.push('Only the current visible viewport is attached. Earlier or later scrollback, command inputs and other terminals are not collected. Visible output may be incomplete.');
  }
  facts.text = text;
  return collectionScope(tab.copilot.capture({ rows: row(facts), summary: { evidence: 'explicit terminal text', connectionState: tab.state }, observed: text === null ? 0 : total, total, omissions }, choice === 'selection' ? { mode: 'selected', selectedRowIds: ['row:1'] } : {}), choice);
}

export function captureNotepadContext(tab, { choice } = {}) {
  requireChoice(tab, choice);
  const doc = tab.current, model = doc.model, ranges = (tab.editor.getSelections() || []).filter(range => !range.isEmpty());
  const omissions = ['Only the current document or its explicit selection is attached. Other open documents, comparison contents and files on disk are not collected.'];
  const facts = { documentId: doc.id, documentVersion: model.getVersionId(), title: doc.title, language: model.getLanguageId(), encoding: doc.encoding, eol: doc.eol,
    dirty: tab.isDirty(doc), origin: doc.remote ? { type: 'remote', ...pick(doc.remote, ['host', 'path']) } : { type: doc.path ? 'local' : 'unsaved', path: doc.path || null }, choice, text: null };
  let length;
  if (choice === 'selection') {
    facts.ranges = ranges.slice(0, 200).map(range => pick(range, ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn']));
    length = ranges.reduce((sum, range) => sum + model.getValueLengthInRange(range), 0) + Math.max(0, ranges.length - 1);
    if (length <= WORKSPACE_TEXT_LIMIT && ranges.length <= 200) facts.text = ranges.map(range => model.getValueInRange(range)).join('\n');
    omissions.push('Unselected text is excluded. Multiple selections are separated by a newline and may omit surrounding context.');
  } else {
    length = model.getValueLength();
    if (length <= WORKSPACE_TEXT_LIMIT) facts.text = model.getValue();
  }
  if (facts.text === null) omissions.push('The complete chosen text exceeds the evidence limit. Select a smaller region; no raw text prefix was attached.');
  return tab.copilot.capture({ rows: row(facts), summary: { evidence: 'explicit editor content', coverageUnit: 'UTF-16 code units', selectedCodeUnits: length }, observed: facts.text === null ? 0 : length, total: length, omissions }, choice === 'selection' ? { mode: 'selected', selectedRowIds: ['row:1'] } : {});
}

export function captureSftpContext(tab, { choice } = {}) {
  requireChoice(tab, choice);
  const omissions = ['Metadata only: no local or remote file contents are read, downloaded, uploaded or modified by this attachment.'];
  if (choice === 'transfers') {
    const jobs = tab.xfers.jobs;
    return collectionScope(tab.copilot.capture({ rows: contextRows(jobs.values(), tab.xfers.table, ['direction', 'name', 'src', 'dst', 'size', 'done', 'speed', 'status', 'error']),
      hasSelection: Boolean(tab.xfers.table.selected.size), summary: { evidence: 'retained transfer status', connectionState: tab.state, retainedTransfers: jobs.size }, observed: jobs.size, total: jobs.size,
      omissions: [...omissions, 'Only retained transfer entries are available; cleared or earlier transfers remain unknown.'] }), choice);
  }
  const [side, mode] = choice.split('-'), pane = tab[side], selected = mode === 'selection';
  const rows = pane.table.rows;
  const summary = { evidence: 'retained displayed directory metadata', side, connectionState: tab.state, observedPath: pane.cwd || null,
    observedAt: pane.listingObservedAt || null, observedRunId: pane.listingRunId || null, request: pane.listingRequest || null, displayedCount: rows.length, retainedCount: pane.entries.length, showHidden: pane.showHidden };
  if (!pane.listingObservedAt) omissions.push('No successful listing has been observed for this pane.');
  if (side === 'remote' && pane.listingRunId && pane.listingRunId !== tab.copilot.runId) omissions.push('Retained remote rows belong to an earlier connection attempt and may be stale.');
  if (pane.entries.length !== rows.length) omissions.push('Hidden entries excluded from the displayed listing are not attached.');
  if (side === 'remote' && tab.state !== 'connected') omissions.push('The remote connection is not live; any retained listing may be stale.');
  if (pane.listingRequest?.state !== 'complete') omissions.push('The latest navigation is pending or failed; retained rows describe the last successful observed path.');
  return collectionScope(tab.copilot.capture({ rows: contextRows(rows, pane.table, ['name', 'isDir', 'type', 'size', 'mtime', 'perms', 'owner', 'mode']),
    hasSelection: selected, summary, observed: rows.length, total: pane.entries.length, omissions }, { mode: selected ? 'selected' : 'all' }), choice);
}

export function captureSessionContext(session) {
  const context = new EvidenceContext('connection', 'saved-session', 'Saved session configuration');
  context.begin({ sessionId: session.id || null, source: 'explicitly selected saved-session record' }, 'saved-session-snapshot'); context.finish();
  const safe = safeSessionMetadata(session);
  const snapshot = context.capture({ rows: row({ configuration: safe, connectionState: null, forwardingRuntimeStatus: null }), observed: 1, total: 1,
    omissions: ['Configuration only; no connection was attempted. Runtime state and persisted revision are unknown.',
      'Passwords, key paths, private keys, login commands, logon actions, notes and other sessions are excluded.',
      ...(safe.configuredForwardCount > 200 ? ['Only the first 200 configured forwarding rules are retained.'] : [])] });
  return Object.freeze({ ...snapshot, source: Object.freeze({ ...snapshot.source, runId: null, revision: null }) });
}

export function recordListingRequest(pane, path, state, error = null) {
  pane.listingRequest = { path, state, at: now(), error };
  pane.tab.copilot.touch();
}
