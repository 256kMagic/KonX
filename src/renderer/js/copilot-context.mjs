// Explicit, immutable evidence snapshots. This module never reads DOM text,
// invokes IPC, retrieves files, or starts a tool. Full strings reach main's
// redaction boundary; resource limits omit entire values, never secret prefixes.
export const BASIC_COPILOT_KINDS = Object.freeze(['ping', 'sweep', 'portscan', 'traceroute', 'dns', 'whois', 'subnet', 'wol', 'netinfo']);
export const WORKSPACE_COPILOT_KINDS = Object.freeze(['terminal', 'connection', 'sftp', 'notepad']);
export const TRAFFIC_COPILOT_KINDS = Object.freeze(["capture-packet","capture-stream","sip-call","rtp-stream","capture-compare","remote-capture","security","wifi","mist"]);
export const COPILOT_SNAPSHOT_BYTES = 64 * 1024;
const MAX_ROWS = 200, MAX_NODES = 3500;
const bytes = value => new TextEncoder().encode(value).length;
const frozen = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; };

export function copilotContextSupport(tab) {
  const kind = tab?.toolKind || tab?.kind || 'unknown';
  const supported = (kind === 'capture' || [...BASIC_COPILOT_KINDS, ...WORKSPACE_COPILOT_KINDS, ...TRAFFIC_COPILOT_KINDS].includes(kind)) && typeof tab?.captureCopilotContext === 'function';
  return { supported, kind, reason: supported ? '' : 'Typed evidence for this view is not available yet. Ask a general question without attaching its data.' };
}

export function captureCopilotContext(tab, options) {
  const support = copilotContextSupport(tab);
  if (!support.supported) throw new Error(support.reason);
  return tab.captureCopilotContext(options);
}

// Whitelist parsed producer fields. Selection is read from the table's model,
// not rendered text; generated IDs avoid copying hostnames into identifiers.
export function* contextRows(rows, table, fields, prefix = 'row') {
  let index = 0;
  for (const row of rows) {
    const fact = { id: `${prefix}:${++index}` };
    for (const field of fields) if (row[field] !== undefined) fact[field] = row[field];
    yield { fact, selected: Boolean(table?.selected.has(table.rowKey(row))) };
  }
}

function boundedCopy(input, budget, notices) {
  let remaining = budget, nodes = 0;
  const ancestors = new Set(), reasons = new Set();
  const omit = reason => { reasons.add(reason); return undefined; };
  const charge = n => { if (remaining < n) return false; remaining -= n; return true; };
  function visit(value, depth) {
    if (++nodes > MAX_NODES) return omit('node limit');
    if (depth > 8) return omit('nesting limit');
    if (typeof value === 'string') {
      if (value.includes('\0')) return omit('unsupported NUL text');
      // Length precheck bounds JSON escaping and UTF-8 allocation.
      if (value.length > 48 * 1024) return omit('whole-field text limit');
      const encoded = JSON.stringify(value);
      if (!charge(bytes(encoded))) return omit('snapshot byte limit');
      return value;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      if (!charge(String(value).length)) return omit('snapshot byte limit');
      return value;
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return omit('non-JSON value');
    if (ancestors.has(value)) return omit('cyclic value');
    if (!charge(2)) return omit('snapshot byte limit');
    ancestors.add(value);
    const out = Array.isArray(value) ? [] : {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (++count > 200) { omit('collection limit'); break; }
      if (!Array.isArray(value) && (!key || key.length > 128 || key.includes('\0') || ['__proto__', 'prototype', 'constructor'].includes(key))) { omit('field-name limit'); continue; }
      if (!charge(Array.isArray(value) ? 1 : bytes(JSON.stringify(key)) + 2)) { omit('snapshot byte limit'); break; }
      const child = visit(value[key], depth + 1);
      if (child !== undefined) Array.isArray(value) ? out.push(child) : out[key] = child;
      if (nodes >= MAX_NODES || remaining < 8) { omit(nodes >= MAX_NODES ? 'node limit' : 'snapshot byte limit'); break; }
    }
    ancestors.delete(value);
    return out;
  }
  const out = visit(input, 0);
  for (const reason of reasons) notices.push(`Partial coverage: complete values were omitted at the ${reason}; source strings were not truncated.`);
  return out;
}

/** One owner per tool tab. Tokens prevent late one-shot replies replacing a new run. */
export class EvidenceContext {
  constructor(kind, tabId, title, { now = () => new Date().toISOString(), onChange = () => {} } = {}) {
    if (![...BASIC_COPILOT_KINDS, ...WORKSPACE_COPILOT_KINDS, ...TRAFFIC_COPILOT_KINDS].includes(kind)) throw new Error('Unsupported evidence context');
    this.kind = kind; this.tabId = tabId; this.title = title; this.now = now; this.onChange = onChange;
    this.revision = 0; this.sequence = 0; this.runId = null; this.state = 'idle'; this.inputs = {};
    this.startedAt = null; this.updatedAt = null; this.completedAt = null; this.error = null; this.inputOmissions = [];
  }
  begin(inputs, runId = `${this.tabId}:context:${++this.sequence}`) {
    this.inputOmissions = [];
    this.inputs = frozen(boundedCopy(inputs, 8 * 1024, this.inputOmissions) || {});
    this.runId = runId; this.state = 'running'; this.error = null;
    this.startedAt = this.now(); this.updatedAt = this.startedAt; this.completedAt = null; this.revision++; this.onChange();
    return runId;
  }
  current(token) { return token === this.runId; }
  touch(token = this.runId) { if (!this.current(token)) return false; this.updatedAt = this.now(); this.revision++; this.onChange(); return true; }
  finish(state = 'complete', error = null, token = this.runId) {
    if (!this.current(token)) return false;
    this.state = state; this.error = error; this.completedAt = this.now();
    return this.touch(token);
  }
  capture(descriptor = {}, options = {}) {
    if (options.mode !== undefined && !['all', 'selected'].includes(options.mode)) throw new Error('Choose all or selected Copilot rows');
    if (options.selectedRowIds !== undefined && (!Array.isArray(options.selectedRowIds) || options.selectedRowIds.length > MAX_ROWS || options.selectedRowIds.some(id => typeof id !== 'string' || !/^[a-z]+:\d+$/.test(id)))) throw new Error('Choose at most 200 valid Copilot row identifiers');
    const mode = options.mode || (options.selectedRowIds !== undefined || descriptor.hasSelection ? 'selected' : 'all');
    const requested = options.selectedRowIds === undefined ? null : new Set(options.selectedRowIds);
    const omissions = [...this.inputOmissions, ...(descriptor.omissions || [])];
    const rows = [], ids = [], seen = new Set();
    if (this.runId) for (const { fact, selected } of descriptor.rows || []) {
      if (mode === 'selected' && !(requested ? requested.has(fact.id) : selected)) continue;
      if (rows.length >= MAX_ROWS) { omissions.push('Partial coverage: at most 200 rows are attached; additional rows remain in the source tool.'); break; }
      rows.push(fact); ids.push(fact.id); seen.add(fact.id);
    }
    if (requested && [...requested].some(id => !seen.has(id))) omissions.push('Partial coverage: one or more selected row identifiers are unavailable in this run.');
    if (mode === 'selected') omissions.push('Only the selected rows are attached. Run summary and coverage counts describe the whole run, not additional row evidence.');
    if (!this.runId) omissions.push('No run has produced evidence. Current form inputs have not been attached as results.');
    else if (this.state !== 'complete') omissions.push(`Run state is ${this.state}; missing observations must remain unknown.`);
    const facts = boundedCopy({ runSummary: this.runId ? descriptor.summary || {} : {}, rows, error: this.error }, 48 * 1024, omissions) || {};
    const safeIds = (facts.rows || []).map(row => row.id).filter(id => typeof id === 'string');
    if (safeIds.length !== ids.length) omissions.push('Partial coverage: selected rows were omitted by the evidence resource limits.');
    const n = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const observed = this.runId ? n(descriptor.observed) : null, total = this.runId ? n(descriptor.total) : null;
    const out = {
      schemaVersion: 1, kind: this.kind, title: this.title, capturedAt: this.now(),
      source: { tabId: this.tabId, runId: this.runId, revision: this.revision }, state: this.state,
      scope: { inputs: this.inputs, startedAt: this.startedAt, updatedAt: this.updatedAt, completedAt: this.completedAt },
      selection: { mode, ids: mode === 'selected' ? [...(requested || safeIds)] : [] }, facts,
      coverage: { observed, total: total !== null && observed !== null && observed > total ? null : total, complete: this.state === 'complete' && descriptor.complete === true && omissions.length === 0 },
      omissions: [...new Set(omissions)],
    };
    // A programmer/schema error is explicit, never repaired by raw truncation.
    if (out.omissions.length > 32 || bytes(JSON.stringify(out)) > COPILOT_SNAPSHOT_BYTES) throw new Error('Copilot snapshot exceeds its bounded evidence envelope');
    return frozen(out);
  }
}

// Existing basic producers retain their narrower boundary.
export class BasicToolContext extends EvidenceContext {
  constructor(kind, ...args) {
    if (!BASIC_COPILOT_KINDS.includes(kind)) throw new Error('Unsupported basic tool context');
    super(kind, ...args);
  }
}
