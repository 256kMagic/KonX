'use strict';
const { sameFile, replaceOwnedFile, publishNewFile } = require('./atomic-replacement');
// Local workflow records own decisions and retained copies, never collectors or
// connections. Snapshot interpretation stays with the existing comparison owner.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { compareSnapshots } = require('./device-snapshots');
const LIMITS = Object.freeze({ records: 100, recordBytes: 4 * 1024 * 1024, reportBytes: 1024 * 1024, comparisonBytes: 2 * 1024 * 1024,
  listBytes: 32 * 1024 * 1024, evidence: 12, checks: 24, timeline: 256, exportBytes: 32 * 1024 * 1024 });
const PHASES = ['plan', 'baseline', 'maintenance', 'after', 'review'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KIND = 'konx-change-validation';
const fail = (message, code = 'CHANGE_INVALID') => { throw Object.assign(new Error(message), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, allowed, label) { if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(`Unsupported ${label} fields; connection specifications and credentials are not accepted.`); return value; }
function text(value, label, max = 4000, required = false) { if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || required && !value.trim()) fail(`Enter valid ${label} (up to ${max} characters).`); return value; }
const id = value => typeof value === 'string' && UUID.test(value) ? value : fail('Invalid saved identifier.');
const time = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : fail('Invalid saved timestamp.');
const revision = value => Number.isSafeInteger(value) && value > 0 ? value : fail('Reopen the record before saving; its revision is required.', 'CHANGE_CONFLICT');
function bounded(value, max, label) { const result = JSON.stringify(value); if (Buffer.byteLength(result) > max) fail(`${label} exceeds its byte limit. Use a smaller report; no partial copy was saved.`, 'CHANGE_LIMIT'); return result; }
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = value => structuredClone(value);
function planOf(value) {
  keys(value, ['name', 'scope', 'expectedOutcome', 'rollbackPlan', 'checks'], 'plan');
  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > LIMITS.checks) fail('Use 1–24 review checks.');
  const seen = new Set();
  const checks = value.checks.map(c => { keys(c, ['id', 'label'], 'review check'); const key = text(c.id, 'check identifier', 64, true);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || seen.has(key)) fail('Review check identifiers must be unique.'); seen.add(key);
    return { id: key, label: text(c.label, 'check label', 256, true) }; });
  return { name: text(value.name, 'change name', 256, true), scope: text(value.scope ?? '', 'scope', 8000),
    expectedOutcome: text(value.expectedOutcome ?? '', 'expected outcome', 8000), rollbackPlan: text(value.rollbackPlan ?? '', 'rollback plan', 8000), checks };
}
function sourcesOf(value) {
  keys(value, ['beforeId', 'afterId', 'devicePairs'], 'snapshot selection');
  const beforeId = value.beforeId == null || value.beforeId === '' ? null : id(value.beforeId), afterId = value.afterId == null || value.afterId === '' ? null : id(value.afterId);
  if (beforeId && beforeId === afterId) fail('Choose different before and after snapshots; one snapshot cannot establish observations across a change.');
  if (!Array.isArray(value.devicePairs ?? []) || (value.devicePairs || []).length > 16) fail('Use at most 16 explicit device pairs.');
  const before = new Set(), after = new Set();
  const devicePairs = (value.devicePairs || []).map(pair => { keys(pair, ['beforeDeviceId', 'afterDeviceId'], 'device pair');
    const b = text(pair.beforeDeviceId, 'before device identifier', 128, true), a = text(pair.afterDeviceId, 'after device identifier', 128, true);
    if (before.has(b) || after.has(a)) fail('Explicit pairs must identify distinct devices.'); before.add(b); after.add(a); return { beforeDeviceId: b, afterDeviceId: a }; });
  return { beforeId, afterId, devicePairs };
}
// Copies explicitly reviewed result JSON without trusting it as proof of a
// collection. Reject structured credentials/connection specs; literal text is
// retained and may contain sensitive content, as the preview/export explains.
function reviewedReport(value) {
  let nodes = 0, bytes = 0;
  const charge = count => { bytes += count; if (bytes > LIMITS.reportBytes) fail('Reviewed report exceeds its 1 MiB byte limit.', 'CHANGE_LIMIT'); };
  const walk = (item, depth = 0) => {
    if (++nodes > 50000 || depth > 20) fail('Reviewed report is too complex.', 'CHANGE_LIMIT');
    if (item === null || typeof item === 'boolean') { charge(JSON.stringify(item).length); return item; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('Reviewed report contains a non-finite number.'); charge(String(item).length); return item; }
    if (typeof item === 'string') { text(item, 'report text', LIMITS.reportBytes); charge(Buffer.byteLength(JSON.stringify(item))); return item; }
    if (Array.isArray(item)) { if (item.length > 10000) fail('Reviewed report has too many rows.'); charge(2 + Math.max(0, item.length - 1)); return item.map(v => walk(v, depth + 1)); }
    if (!plain(item) || Object.keys(item).length > 128) fail('Reviewed report must contain ordinary bounded JSON.');
    const out = {}; charge(2 + Math.max(0, Object.keys(item).length - 1));
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:password|passphrase|privateKey|privateKeyPath|credential|credentials|authToken|authorization|apiKey|cookie|connectionSpec|sessionSpec|__proto__|constructor|prototype)$/i.test(key)) fail('Remove structured credentials or connection settings before attaching a report.');
      text(key, 'report property', 128, true); charge(Buffer.byteLength(JSON.stringify(key)) + 1); out[key] = walk(child, depth + 1);
    }
    return out;
  };
  const report = walk(value);
  if (report?.schemaVersion !== 1 || !['runbook', 'capture-comparison'].includes(report.kind)) fail('Attach an existing Runbook result or Capture Comparison report.');
  if (report.kind === 'runbook') {
    keys(report, ['schemaVersion', 'kind', 'name', 'startedAt', 'finishedAt', 'steps', 'stopped', 'complete', 'warnings'], 'runbook report');
    if (!Array.isArray(report.steps) || report.steps.length > 24 || typeof report.complete !== 'boolean' || typeof report.stopped !== 'boolean') fail('Invalid runbook result structure.');
  } else {
    keys(report, ['schemaVersion', 'kind', 'before', 'after', 'services', 'changes', 'warnings', 'limitations', 'summary'], 'capture comparison report');
    if (!plain(report.before) || !plain(report.after) || !Array.isArray(report.changes) || !Array.isArray(report.services) || !plain(report.summary)) fail('Invalid capture comparison structure.');
  }
  bounded(report, LIMITS.reportBytes, 'Reviewed report'); return report;
}
const unknownDecisions = plan => plan.checks.map(check => ({ checkId: check.id, status: 'unknown', rationale: 'Not reviewed.', sourceRefs: [], reviewedAt: null }));
function validateRecord(value, expectedId) {
  keys(value, ['schemaVersion', 'kind', 'id', 'revision', 'createdAt', 'updatedAt', 'phase', 'planVersion', 'plan', 'sources', 'comparison', 'evidence', 'decisions', 'maintenance', 'timeline'], 'workflow record');
  if (value.schemaVersion !== 1 || value.kind !== KIND || value.id !== id(expectedId) || !PHASES.includes(value.phase)) fail('Saved workflow schema or identity is invalid.');
  revision(value.revision); revision(value.planVersion); time(value.createdAt); time(value.updatedAt); planOf(value.plan); sourcesOf(value.sources);
  if (!Array.isArray(value.timeline) || value.timeline.length > LIMITS.timeline || !Array.isArray(value.evidence) || value.evidence.length > LIMITS.evidence || !Array.isArray(value.decisions) || value.decisions.length !== value.plan.checks.length) fail('Saved workflow exceeds its structural limits.');
  for (const event of value.timeline) { keys(event, ['at', 'action', 'details'], 'timeline event'); time(event.at); text(event.action, 'timeline action', 64, true); bounded(event.details, 65536, 'Timeline event'); }
  const evidenceIds = new Set();
  for (const evidence of value.evidence) { keys(evidence, ['id', 'label', 'phase', 'planVersion', 'attachedAt', 'provenance', 'report'], 'evidence');
    id(evidence.id); text(evidence.label, 'evidence label', 256, true); revision(evidence.planVersion); time(evidence.attachedAt);
    if (evidenceIds.has(evidence.id) || evidence.planVersion > value.planVersion) fail('Invalid retained evidence identity or plan version.'); evidenceIds.add(evidence.id);
    if (!['baseline', 'after'].includes(evidence.phase) || evidence.provenance !== 'User-reviewed copy; origin and completeness are reported by the source, not independently verified.') fail('Invalid evidence provenance.'); reviewedReport(evidence.report); }
  if (value.comparison) { const c = value.comparison; keys(c, ['id', 'at', 'planVersion', 'sources', 'snapshotMetadata', 'status', 'issues', 'report'], 'snapshot comparison'); id(c.id); time(c.at); revision(c.planVersion);
    if (JSON.stringify(sourcesOf(c.sources)) !== JSON.stringify(value.sources) || c.planVersion !== value.planVersion || !['compared', 'unavailable'].includes(c.status) || !Array.isArray(c.issues)) fail('Comparison sources do not match the workflow.');
    if (c.status === 'compared' !== !!c.report) fail('Comparison availability is inconsistent.');
    if (!Array.isArray(c.snapshotMetadata) || c.snapshotMetadata.length > 2) fail('Invalid snapshot provenance.');
    const sides = new Set();
    for (const source of c.snapshotMetadata) { keys(source, ['side', 'id', 'label', 'savedAt', 'immutable'], 'snapshot provenance');
      if (!['before', 'after'].includes(source.side) || sides.has(source.side) || source.id !== value.sources[source.side + 'Id'] || source.immutable !== true) fail('Invalid snapshot provenance identity.'); sides.add(source.side); text(source.label, 'snapshot label', 256, true); text(source.savedAt, 'snapshot timestamp', 64, true); if (!Number.isFinite(Date.parse(source.savedAt))) fail('Invalid snapshot timestamp.'); }
    if (c.report) {
      keys(c.report, ['schemaVersion', 'kind', 'before', 'after', 'devices', 'changes', 'unmatched', 'warnings', 'sensitive', 'summary'], 'retained comparison report');
      if (c.report.schemaVersion !== 1 || c.report.kind !== 'device-snapshot-comparison' || c.report.before?.id !== value.sources.beforeId || c.report.after?.id !== value.sources.afterId || sides.size !== 2
        || !Array.isArray(c.report.devices) || !Array.isArray(c.report.changes) || !Array.isArray(c.report.unmatched) || !Array.isArray(c.report.warnings) || !plain(c.report.summary) || typeof c.report.sensitive !== 'boolean') fail('Comparison identity or structure does not match its selected snapshots.');
    }
    bounded(c, LIMITS.comparisonBytes, 'Snapshot comparison'); }
  if (value.maintenance) { keys(value.maintenance, ['acknowledgedAt', 'reason', 'planVersion'], 'maintenance acknowledgement'); time(value.maintenance.acknowledgedAt); text(value.maintenance.reason, 'maintenance note', 4000, true); revision(value.maintenance.planVersion); if (value.maintenance.planVersion !== value.planVersion) fail('Maintenance acknowledgment belongs to an old plan.'); }
  if (['after', 'review'].includes(value.phase) !== !!value.maintenance) fail('Saved phase is inconsistent with manual maintenance acknowledgment.');
  const currentRefs = new Set(value.evidence.filter(e => e.planVersion === value.planVersion).map(e => e.id)); if (value.comparison?.report) currentRefs.add(value.comparison.id);
  const seen = new Set();
  for (const d of value.decisions) { keys(d, ['checkId', 'status', 'rationale', 'sourceRefs', 'reviewedAt'], 'review decision');
    if (!value.plan.checks.some(c => c.id === d.checkId) || seen.has(d.checkId) || !['pass', 'fail', 'unknown'].includes(d.status) || !Array.isArray(d.sourceRefs) || d.sourceRefs.length > 16) fail('Invalid review decision.'); seen.add(d.checkId);
    text(d.rationale, 'decision rationale', 4000, true); d.sourceRefs.forEach(id); if (d.reviewedAt !== null) time(d.reviewedAt);
    if (new Set(d.sourceRefs).size !== d.sourceRefs.length || d.sourceRefs.some(ref => !currentRefs.has(ref)) || d.status !== 'unknown' && (!d.reviewedAt || !d.sourceRefs.length) || d.reviewedAt && value.phase !== 'review') fail('Saved assessment lacks current reviewed evidence.'); }
  bounded(value, LIMITS.recordBytes, 'Workflow'); return value;
}

class ChangeValidationStore {
  constructor(profile, options = {}) {
    if (typeof profile !== 'string' || !path.isAbsolute(profile)) fail('Change validation needs an absolute profile path.');
    this.directory = path.join(profile, 'change-validation'); this.io = options.fs || fs; this.publishNew = options.publishNew || publishNewFile; this.snapshots = options.snapshots; this.incidents = options.incidents;
    this.readVersions = new WeakMap(); this.queue = Promise.resolve(); this.operations = 0; this.owners = new Set(); this.closing = null;
  }
  get hasOwnership() { return this.operations > 0 || this.owners.size > 0; }
  get hasPendingCleanup() { return this.owners.size > 0; }
  serialize(fn) {
    if (this.closing) return Promise.reject(new Error('Change validation is closing.'));
    this.operations++;
    const pending = this.queue.then(fn).finally(() => { this.operations--; }); this.queue = pending.catch(() => {}); return pending;
  }
  async cleanup(owner) {
    if (owner.remove && !owner.identity && owner.handle) { const stat = await owner.handle.stat({ bigint: true }); if (!stat.isFile() || stat.ino === 0n) fail('Owned temporary file identity is unavailable.'); owner.identity = stat; }
    if (owner.handle) { await owner.handle.close(); owner.handle = null; }
    if (owner.remove) {
      let stat; try { stat = await this.io.lstat(owner.file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) { if (!owner.identity || !stat.isFile() || stat.isSymbolicLink() || stat.dev !== owner.identity.dev || stat.ino !== owner.identity.ino) fail('Owned temporary path changed; cleanup remains pending.'); await this.io.unlink(owner.file); }
    }
    this.owners.delete(owner);
  }
  async retryCleanup() { const errors = []; for (const owner of [...this.owners]) try { await this.cleanup(owner); } catch (error) { errors.push(error.message); } if (errors.length) fail('Change validation cleanup remains pending. Retry closing when storage is available.', 'CHANGE_CLEANUP'); }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.queue.then(() => this.retryCleanup()).finally(() => { this.closing = null; }); return this.closing;
  }
  async ready() { await this.retryCleanup(); await this.io.mkdir(this.directory, { recursive: true }); const stat = await this.io.lstat(this.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Change validation storage must be a real directory.'); }
  file(value) { return path.join(this.directory, id(value) + '.json'); }
  async readFile(file, max = LIMITS.recordBytes, observed) {
    const before = await this.io.lstat(file, { bigint: true }); if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(max)) fail('Workflow must be a bounded regular file.');
    const owner = { file, handle: await this.io.open(file, 'r'), remove: false }; this.owners.add(owner);
    try {
      const opened = await owner.handle.stat({ bigint: true }); if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('Workflow changed while opening.', 'CHANGE_CONFLICT');
      const buffer = Buffer.alloc(Number(before.size) + 1); let used = 0;
      while (used < buffer.length) { const { bytesRead } = await owner.handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
      const after = await owner.handle.stat({ bigint: true }); if (BigInt(used) !== before.size || after.size !== before.size || after.mtimeNs !== opened.mtimeNs) fail('Workflow changed while reading.', 'CHANGE_CONFLICT');
      observed?.(after); return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
    } finally { await this.cleanup(owner); }
  }
  async read(value) { let parsed, version; try { parsed = JSON.parse(await this.readFile(this.file(value), LIMITS.recordBytes, stat => { version = stat; })); } catch (error) { if (error.code === 'ENOENT') fail('Saved change validation was not found.', 'CHANGE_NOT_FOUND'); throw error; } const record = validateRecord(parsed, value); this.readVersions.set(record, version); return record; }
  async entries() {
    const owner = { handle: await this.io.opendir(this.directory), remove: false }; this.owners.add(owner); const entries = [];
    try { for (;;) { const entry = await owner.handle.read(); if (!entry) break; entries.push(entry.name); if (entries.length > LIMITS.records * 2) break; } }
    finally { await this.cleanup(owner); } return entries;
  }
  async write(destination, content, initial = false, expectedVersion) {
    const targetVersion = initial ? null : expectedVersion || await this.io.lstat(destination, { bigint: true });
    const file = path.join(path.dirname(destination), '.change-' + crypto.randomUUID() + '.tmp');
    const owner = { file, handle: await this.io.open(file, 'wx', 0o600), remove: true, identity: null }; this.owners.add(owner);
    let published = false;
    try {
      owner.identity = await owner.handle.stat({ bigint: true }); await owner.handle.writeFile(content, 'utf8'); await owner.handle.sync();
      const sourceVersion = await owner.handle.stat({ bigint: true }); if (!sameFile(owner.identity, sourceVersion)) fail('Owned replacement identity is unavailable.', 'CHANGE_CONFLICT');
      await owner.handle.close(); owner.handle = null;
      if (initial) owner.remove = !await this.publishNew(this.io, file, destination, sourceVersion);
      else { try { await replaceOwnedFile(this.io, file, destination, sourceVersion, targetVersion); } catch (error) { if (error.code === 'ATOMIC_CONFLICT') error.code = 'CHANGE_CONFLICT'; throw error; } owner.remove = false; }
      published = true;
    } finally { try { await this.cleanup(owner); } catch (error) { if (!published) throw error; } }
    // A committed record stays a successful save even if owned temp cleanup
    // needs retry. hasOwnership keeps updater/quit aware of that obligation.
  }
  async publish(record, initial = false) { validateRecord(record, record.id); await this.write(this.file(record.id), bounded(record, LIMITS.recordBytes, 'Workflow'), initial, this.readVersions.get(record)); return clone(record); }
  async update(value, expected, action, change) {
    await this.ready(); const record = await this.read(value); if (record.revision !== revision(expected)) fail('This workflow changed since it was opened. Reopen it before saving.', 'CHANGE_CONFLICT');
    if (record.revision === Number.MAX_SAFE_INTEGER || record.timeline.length >= LIMITS.timeline) fail('Workflow history limit reached. Export it and create a new validation.', 'CHANGE_LIMIT');
    const details = await change(record), now = new Date().toISOString(); record.revision++; record.updatedAt = now; record.timeline.push({ at: now, action, details: details || {} }); return this.publish(record);
  }
  list() { return this.serialize(async () => {
    await this.ready(); const records = [], issues = []; let bytes = 0;
    const entries = await this.entries();
    for (const name of entries.slice(0, LIMITS.records * 2)) {
      if (!UUID.test(name.slice(0, -5)) || !name.endsWith('.json')) { issues.push({ message: 'Unrecognized workflow entry was not loaded.' }); continue; }
      if (records.length >= LIMITS.records) { issues.push({ message: 'Workflow count limit reached; remaining entries are unexamined.' }); break; }
      try { const stat = await this.io.lstat(path.join(this.directory, name)); if (bytes + stat.size > LIMITS.listBytes) { issues.push({ message: 'Workflow listing byte limit reached.' }); break; } bytes += stat.size;
        const r = await this.read(name.slice(0, -5)); records.push({ id: r.id, revision: r.revision, name: r.plan.name, phase: r.phase, updatedAt: r.updatedAt, assessment: assessment(r) }); }
      catch (error) { if (this.owners.size) throw error; issues.push({ id: name.slice(0, -5), message: error.message }); }
    }
    if (entries.length > LIMITS.records * 2) issues.push({ message: 'Directory entry limit reached; remaining files are unexamined.' });
    return { records: records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), issues, limits: LIMITS, phases: PHASES };
  }); }
  get(value) { id(value); return this.serialize(async () => { await this.ready(); return clone(await this.read(value)); }); }
  remove(value, expected) { id(value); return this.serialize(async () => { await this.ready(); const record = await this.read(value); if (record.revision !== revision(expected)) fail('Reopen the workflow before deleting it.', 'CHANGE_CONFLICT'); await this.io.unlink(this.file(value)); return { removed: value }; }); }
  create(input) {
    const plan = planOf(input);
    return this.serialize(async () => { await this.ready(); const entries = await this.entries(); if (entries.length > LIMITS.records * 2 || entries.filter(n => UUID.test(n.slice(0, -5)) && n.endsWith('.json')).length >= LIMITS.records) fail('Saved workflow capacity reached.', 'CHANGE_LIMIT');
      const now = new Date().toISOString(), record = { schemaVersion: 1, kind: KIND, id: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now, phase: 'plan', planVersion: 1,
        plan, sources: { beforeId: null, afterId: null, devicePairs: [] }, comparison: null, evidence: [], decisions: unknownDecisions(plan), maintenance: null,
        timeline: [{ at: now, action: 'created', details: { planVersion: 1 } }] }; return this.publish(record, true); });
  }
  savePlan(value, expected, input) { id(value); const plan = planOf(input); return this.serialize(() => this.update(value, expected, 'plan-updated', r => {
    if (JSON.stringify(r.plan) === JSON.stringify(plan)) return { unchanged: true };
    r.plan = plan; r.planVersion++; r.phase = 'plan'; r.sources = { beforeId: null, afterId: null, devicePairs: [] }; r.comparison = null; r.maintenance = null; r.decisions = unknownDecisions(plan);
    return { planVersion: r.planVersion, previousEvidenceRetained: r.evidence.length, previousAssessmentsInvalidated: true };
  })); }
  advance(value, expected, input) {
    id(value); keys(input, ['to', 'acknowledgment', 'reason'], 'phase transition'); const next = input.to, reason = text(input.reason ?? '', 'phase note', 4000);
    return this.serialize(() => this.update(value, expected, 'phase-advanced', r => {
      if (PHASES.indexOf(next) !== PHASES.indexOf(r.phase) + 1) fail('Advance one phase at a time. Reopening a workflow never advances it.');
      if (r.phase === 'plan' && (!r.plan.scope.trim() || !r.plan.expectedOutcome.trim())) fail('Record the change scope and expected outcome before establishing the baseline.');
      if (r.phase === 'maintenance') {
        if (input.acknowledgment !== true || !reason.trim()) fail('Explicitly acknowledge your manual maintenance activity and record what was done, skipped, or rolled back.');
        r.maintenance = { acknowledgedAt: new Date().toISOString(), reason, planVersion: r.planVersion };
      }
      const previous = r.phase; r.phase = next; return { from: previous, to: next, reason, automaticActions: false };
    }));
  }
  setSnapshots(value, expected, input) { id(value); const sources = sourcesOf(input); return this.serialize(() => this.update(value, expected, 'snapshot-selection', r => {
    if (JSON.stringify(r.sources) === JSON.stringify(sources)) return { unchanged: true };
    r.sources = sources; r.comparison = null; r.decisions = unknownDecisions(r.plan); return { ...sources, comparisonAndDecisionsInvalidated: true };
  })); }
  compare(value, expected) { id(value); return this.serialize(() => this.update(value, expected, 'snapshots-compared', async r => {
    if (!r.sources.beforeId || !r.sources.afterId) fail('Choose different before and after snapshots first.');
    const results = await Promise.allSettled([this.snapshots.get(r.sources.beforeId), this.snapshots.get(r.sources.afterId)]);
    const issues = results.flatMap((result, i) => result.status === 'rejected' ? [{ side: i ? 'after' : 'before', code: 'SNAPSHOT_UNAVAILABLE', message: 'Snapshot is missing, invalid or unreadable; its observations remain unknown.' }] : []);
    const metadata = results.map((result, i) => result.status === 'fulfilled' ? { side: i ? 'after' : 'before', id: result.value.id, label: result.value.label, savedAt: result.value.savedAt, immutable: true } : null).filter(Boolean);
    const report = issues.length ? null : compareSnapshots(results[0].value, results[1].value, r.sources.devicePairs);
    r.comparison = { id: crypto.randomUUID(), at: new Date().toISOString(), planVersion: r.planVersion, sources: clone(r.sources), snapshotMetadata: metadata, status: report ? 'compared' : 'unavailable', issues, report };
    bounded(r.comparison, LIMITS.comparisonBytes, 'Snapshot comparison'); r.decisions = unknownDecisions(r.plan);
    return { comparisonId: r.comparison.id, status: r.comparison.status, sources: r.sources, automaticVerdict: false };
  })); }
  addEvidence(value, expected, input) {
    id(value); keys(input, ['label', 'phase', 'report', 'reviewed'], 'reviewed evidence');
    if (input.reviewed !== true || !['baseline', 'after'].includes(input.phase)) fail('Preview the report and explicitly choose its baseline or after phase.');
    const report = reviewedReport(input.report), label = text(input.label, 'evidence label', 256, true), phase = input.phase;
    return this.serialize(() => this.update(value, expected, 'evidence-attached', r => {
      if (r.evidence.length >= LIMITS.evidence) fail('Workflow evidence limit reached. Export it and create another validation.', 'CHANGE_LIMIT');
      const evidence = { id: crypto.randomUUID(), label, phase, planVersion: r.planVersion, attachedAt: new Date().toISOString(),
        provenance: 'User-reviewed copy; origin and completeness are reported by the source, not independently verified.', report };
      r.evidence.push(evidence); r.decisions = unknownDecisions(r.plan); return { evidenceId: evidence.id, phase, kind: report.kind, assessmentsInvalidated: true };
    }));
  }
  decide(value, expected, input) {
    id(value); if (!Array.isArray(input) || input.length > LIMITS.checks) fail('Provide the checklist decisions.');
    const decisions = input.map(d => { keys(d, ['checkId', 'status', 'rationale', 'sourceRefs'], 'review decision');
      if (!['pass', 'fail', 'unknown'].includes(d.status) || !Array.isArray(d.sourceRefs) || d.sourceRefs.length > 16) fail('Invalid review decision or evidence references.');
      return { checkId: text(d.checkId, 'check identifier', 64, true), status: d.status, rationale: text(d.rationale, 'decision rationale', 4000, true), sourceRefs: d.sourceRefs.map(id) }; });
    return this.serialize(() => this.update(value, expected, 'review-recorded', r => {
      if (r.phase !== 'review') fail('Advance to review before recording assessments.');
      if (decisions.length !== r.plan.checks.length) fail('Review every checklist item, using Unknown when evidence is missing.');
      const refs = new Set(r.evidence.filter(e => e.planVersion === r.planVersion).map(e => e.id)); if (r.comparison?.report) refs.add(r.comparison.id);
      const seen = new Set();
      r.decisions = decisions.map(d => { keys(d, ['checkId', 'status', 'rationale', 'sourceRefs'], 'review decision');
        if (!r.plan.checks.some(c => c.id === d.checkId) || seen.has(d.checkId) || !['pass', 'fail', 'unknown'].includes(d.status)) fail('Choose one decision for each checklist item.'); seen.add(d.checkId);
        const rationale = text(d.rationale, 'decision rationale', 4000, true);
        if (!Array.isArray(d.sourceRefs) || d.sourceRefs.length > 16 || d.sourceRefs.some(ref => !refs.has(ref)) || new Set(d.sourceRefs).size !== d.sourceRefs.length) fail('Choose current retained evidence as the decision source.');
        if (d.status !== 'unknown' && !d.sourceRefs.length) fail('Pass and Fail require a retained evidence reference. Choose Unknown when evidence is missing.');
        return { checkId: d.checkId, status: d.status, rationale, sourceRefs: [...d.sourceRefs], reviewedAt: new Date().toISOString() };
      }); return { decisions: clone(r.decisions), assessment: assessment(r), author: 'Explicit user decisions; not an automatic health verdict.' };
    }));
  }
  exportJson(value, expected) { return this.serialize(async () => { await this.ready(); const record = await this.read(value); if (expected !== undefined && record.revision !== revision(expected)) fail('The workflow changed. Review its current report before exporting.', 'CHANGE_CONFLICT'); return this.reportJson(record); }); }
  reportJson(record) {
    const report = { schemaVersion: 1, kind: KIND + '-report', exportedAt: new Date().toISOString(), assessment: assessment(record), limitations: limitations(), workflow: record };
    const pretty = JSON.stringify(report, null, 2) + '\n';
    // Full JSON still fits IncidentStore's text-file budget when indentation
    // would expand a deeply nested but bounded report. Content is never cut.
    return Buffer.byteLength(pretty) <= 8 * 1024 * 1024 ? pretty : bounded(report, 8 * 1024 * 1024, 'Export report');
  }
  reportHtml(record) {
    const json = this.reportJson(record), rows = record.plan.checks.map(c => { const d = record.decisions.find(d => d.checkId === c.id); return `<tr><td>${html(c.label)}</td><td>${html(d.status)}</td><td>${html(d.rationale)}</td><td>${html(d.sourceRefs.join(', ') || 'No retained source')}</td></tr>`; }).join('');
    const result = `<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>${html(record.plan.name)}</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#172234}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aab6c4;padding:10px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:16px}h2{margin-top:30px}</style><h1>${html(record.plan.name)}</h1><p>Phase: ${html(record.phase)} · User assessment: ${html(assessment(record))}</p><h2>Scope</h2><pre>${html(record.plan.scope)}</pre><h2>Expected outcome</h2><pre>${html(record.plan.expectedOutcome)}</pre><h2>Rollback plan</h2><pre>${html(record.plan.rollbackPlan || 'Not recorded')}</pre><h2>Manual maintenance acknowledgment</h2><pre>${html(record.maintenance ? record.maintenance.acknowledgedAt + '\n' + record.maintenance.reason : 'Not recorded')}</pre><h2>Review decisions</h2><table><tr><th>Check</th><th>User decision</th><th>Rationale</th><th>Evidence references</th></tr>${rows}</table><h2>Interpretation limits</h2><ul>${limitations().map(x => `<li>${html(x)}</li>`).join('')}</ul><h2>Complete retained report</h2><p>Includes comparison observations, evidence copies, source references and the workflow timeline.</p><pre>${html(json)}</pre></html>`;
    if (Buffer.byteLength(result) > LIMITS.exportBytes) fail('HTML report exceeds its export limit.'); return result;
  }
  exportHtml(value) { return this.serialize(async () => { await this.ready(); return this.reportHtml(await this.read(value)); }); }
  exportFile(value, format, destination, expected) {
    id(value); if (!['json', 'html'].includes(format) || typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) fail('Choose a local JSON or HTML export file.');
    const target = path.resolve(destination), fold = v => process.platform === 'win32' ? v.toLowerCase() : v;
    if (fold(target) === fold(this.directory) || fold(target).startsWith(fold(this.directory) + path.sep)) fail('Export outside the managed workflow library.');
    return this.serialize(async () => { await this.ready(); const record = await this.read(value); if (expected !== undefined && record.revision !== revision(expected)) fail('The workflow changed. Review its current report before exporting.', 'CHANGE_CONFLICT'); const parent = await this.io.lstat(path.dirname(target)); if (!parent.isDirectory() || parent.isSymbolicLink()) fail('Export directory must be a real directory.');
      const [realParent, realLibrary] = await Promise.all([this.io.realpath(path.dirname(target)), this.io.realpath(this.directory)]);
      const resolvedTarget = path.join(realParent, path.basename(target));
      if (fold(resolvedTarget) === fold(realLibrary) || fold(resolvedTarget).startsWith(fold(realLibrary) + path.sep)) fail('Export outside the managed workflow library.');
      // Resolve ancestor aliases once, then write through that canonical parent.
      // The user-selected filename is preserved and cannot target our library via a junction.
      let initial = false; try { await this.io.lstat(resolvedTarget); } catch (error) { if (error.code !== 'ENOENT') throw error; initial = true; }
      await this.write(resolvedTarget, format === 'json' ? this.reportJson(record) : this.reportHtml(record), initial); return { path: target }; });
  }
  addToIncident(value, expected, incidentId) {
    id(value); id(incidentId);
    return this.serialize(async () => {
      await this.ready(); const record = await this.read(value); if (record.revision !== revision(expected)) fail('Reopen the workflow before attaching its current report.', 'CHANGE_CONFLICT');
      const file = path.join(this.directory, '.incident-' + crypto.randomUUID() + '.tmp'), owner = { file, handle: await this.io.open(file, 'wx', 0o600), remove: true, identity: null }; this.owners.add(owner);
      let result;
      try { owner.identity = await owner.handle.stat({ bigint: true }); await owner.handle.writeFile(this.reportJson(record), 'utf8'); await owner.handle.sync(); await owner.handle.close(); owner.handle = null;
        result = await this.incidents.addFile(incidentId, { kind: 'tool', label: record.plan.name.slice(0, 230) + ' · Change validation', sourcePath: file });
      } finally { try { await this.cleanup(owner); } catch (error) { if (!result) throw error; } }
      return { incidentId, revision: record.revision, evidenceCount: result.evidence.length, copied: true };
    });
  }
}
function assessment(record) { if (record.decisions.some(d => !d.reviewedAt)) return 'not fully reviewed'; if (record.decisions.some(d => d.status === 'fail')) return 'fail'; if (record.decisions.some(d => d.status === 'unknown')) return 'unknown'; return 'pass'; }
function limitations() { return ['Decisions are explicit user assessments, not an automatic device or service health verdict.', 'Changed observations do not establish failure; unchanged observations do not establish health.', 'Missing, ambiguous, incomplete or unavailable observations remain unknown. Review source coverage and device pairing.', 'Opening, saving and advancing this workflow do not connect, run checks, or apply configuration.', 'Snapshot comparisons reuse stored immutable observations. Attached tool reports are user-reviewed copies; source authenticity is not independently verified.', 'Reports retain notes and observation text, which may contain sensitive information. No claim is made that literal text is free of credentials.']; }
module.exports = { ChangeValidationStore, LIMITS, PHASES, assessment, planOf, reviewedReport };
