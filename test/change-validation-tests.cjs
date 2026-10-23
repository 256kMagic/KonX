'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..');
const loadBackend = () => require('../src/main/change-validation');
const { ChangeValidationStore, LIMITS, assessment } = loadBackend();
const { SnapshotStore, compareSnapshots } = require(path.join(repo, 'src/main/device-snapshots'));
const { IncidentStore } = require(path.join(repo, 'src/main/incidents'));
const runbooks = require(path.join(repo, 'src/main/runbooks'));
const demo = require(path.join(repo, 'assets/device-snapshot-demo.json'));
const plan = () => ({ name: 'Branch maintenance', scope: 'Owned synthetic branch', expectedOutcome: 'Expected VLAN addition; existing links stay available', rollbackPlan: 'Restore the reviewed prior configuration manually', checks: [{ id: 'intended', label: 'Expected change observed' }, { id: 'service', label: 'Service evidence reviewed' }] });
async function inStore(fn) {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'konx-change-test-'));
  const snapshots = new SnapshotStore(root), incidents = new IncidentStore(root), store = new ChangeValidationStore(root, { snapshots, incidents });
  try { await fn({ store, snapshots, incidents, root }); }
  finally { await store.close().catch(() => {}); assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-change-test-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
async function savedPair(snapshots) { const before = await snapshots.save({ label: 'Before', report: structuredClone(demo.before) }), after = await snapshots.save({ label: 'After', report: structuredClone(demo.after) }); return { beforeId: before.id, afterId: after.id, devicePairs: [] }; }
async function toReview(store, record) {
  for (const to of ['baseline', 'maintenance', 'after', 'review']) record = await store.advance(record.id, record.revision, { to, ...(to === 'after' ? { acknowledgment: true, reason: 'Synthetic maintenance acknowledged; no device action was performed by this test.' } : {}) });
  return record;
}
async function runChangeValidationTests(test) {
  await test('change workflow real snapshot comparison/manual runbook evidence survives restart and complete JSON/HTML/incident export', () => inStore(async ({ store, snapshots, incidents, root }) => {
    let record = await store.create(plan()); const selection = await savedPair(snapshots);
    record = await store.setSnapshots(record.id, record.revision, selection); record = await store.compare(record.id, record.revision);
    const expected = compareSnapshots(await snapshots.get(selection.beforeId), await snapshots.get(selection.afterId)); assert.deepEqual(record.comparison.report, expected); assert.equal(assessment(record), 'not fully reviewed');
    const report = await runbooks.run({ definition: { schemaVersion: 1, name: 'Manual verification', inputs: [], steps: [{ id: 'review', title: 'Review service observation', kind: 'checklist', instructions: 'Read owned evidence.' }] }, inputs: {} }, () => {}, { stopped: false }, null);
    record = await store.addEvidence(record.id, record.revision, { label: 'Manual runbook result', phase: 'after', reviewed: true, report });
    assert.equal(record.evidence[0].report.steps[0].status, 'unknown'); record = await toReview(store, record);
    record = await store.decide(record.id, record.revision, [{ checkId: 'intended', status: 'pass', rationale: 'User reviewed the expected synthetic change.', sourceRefs: [record.comparison.id] }, { checkId: 'service', status: 'unknown', rationale: 'No service transaction evidence is available.', sourceRefs: [record.evidence[0].id] }]);
    assert.equal(assessment(record), 'unknown'); const reopened = new ChangeValidationStore(root, { snapshots, incidents }); assert.deepEqual(await reopened.get(record.id), record);
    const reportJson = JSON.parse(await reopened.exportJson(record.id)); assert.deepEqual(reportJson.workflow, record); assert.equal(reportJson.assessment, 'unknown');
    const out = path.join(root, 'report.html'); await reopened.exportFile(record.id, 'html', out); const html = await fs.readFile(out, 'utf8'); assert.match(html, /Complete retained report/); assert.match(html, /Changed observations do not establish failure/); assert.ok(html.includes('Manual runbook result'));
    const incident = await incidents.create({ title: 'Synthetic maintenance evidence' }); const result = await reopened.addToIncident(record.id, record.revision, incident.id); assert.equal(result.copied, true);
    const retained = await incidents.get(incident.id); assert.equal(retained.evidence.length, 1); const text = await incidents.verifiedText(incident.id, retained.evidence[0]); assert.deepEqual(JSON.parse(text).workflow, record);
    await reopened.close(); assert.equal(reopened.hasOwnership, false);
  }));
  await test('change workflow phases require explicit manual acknowledgment and never call collectors when opened or advanced', () => inStore(async ({ store }) => {
    let record = await store.create(plan()); await assert.rejects(store.advance(record.id, record.revision, { to: 'after', acknowledgment: true, reason: 'skip' }), /one phase/);
    record = await store.advance(record.id, record.revision, { to: 'baseline' }); record = await store.advance(record.id, record.revision, { to: 'maintenance' });
    for (const input of [{ to: 'after' }, { to: 'after', acknowledgment: true, reason: '' }, { to: 'after', acknowledgment: 'true', reason: 'note' }]) await assert.rejects(store.advance(record.id, record.revision, input), /acknowledge/);
    const unchanged = await store.get(record.id); assert.equal(unchanged.phase, 'maintenance'); assert.equal(unchanged.revision, record.revision);
    record = await store.advance(record.id, record.revision, { to: 'after', acknowledgment: true, reason: 'Maintenance skipped; observation only.' }); assert.match(record.maintenance.reason, /skipped/); assert.equal(record.timeline.at(-1).details.automaticActions, false);
  }));
  await test('change workflow rejects same snapshot and retains missing comparison as unknown without inventing a verdict', () => inStore(async ({ store, snapshots }) => {
    let record = await store.create(plan()); const selection = await savedPair(snapshots);
    await assert.rejects(async () => store.setSnapshots(record.id, record.revision, { beforeId: selection.beforeId, afterId: selection.beforeId }), /different/);
    record = await store.setSnapshots(record.id, record.revision, { beforeId: selection.beforeId, afterId: crypto.randomUUID() }); record = await store.compare(record.id, record.revision);
    assert.equal(record.comparison.status, 'unavailable'); assert.equal(record.comparison.report, null); assert.equal(record.comparison.issues[0].side, 'after'); assert.equal(assessment(record), 'not fully reviewed');
    record = await toReview(store, record); await assert.rejects(store.decide(record.id, record.revision, plan().checks.map(c => ({ checkId: c.id, status: 'pass', rationale: 'Assumed healthy', sourceRefs: [] }))), /retained evidence/);
  }));
  await test('change workflow optimistic revisions and evidence/source/plan changes invalidate old user assessments', () => inStore(async ({ store, snapshots }) => {
    let record = await store.create(plan()); const first = structuredClone(record);
    record = await store.setSnapshots(record.id, record.revision, await savedPair(snapshots)); await assert.rejects(store.savePlan(first.id, first.revision, plan()), /changed since/);
    record = await store.compare(record.id, record.revision); record = await toReview(store, record);
    record = await store.decide(record.id, record.revision, plan().checks.map(c => ({ checkId: c.id, status: 'pass', rationale: 'Reviewed synthetic source', sourceRefs: [record.comparison.id] })));
    assert.equal(assessment(record), 'pass'); const oldComparison = record.comparison.id;
    record = await store.setSnapshots(record.id, record.revision, record.sources); assert.equal(record.comparison.id, oldComparison); assert.equal(assessment(record), 'pass');
    record = await store.setSnapshots(record.id, record.revision, { ...record.sources, afterId: null }); assert.equal(record.comparison, null); assert.equal(assessment(record), 'not fully reviewed');
    await assert.rejects(store.decide(record.id, record.revision, plan().checks.map(c => ({ checkId: c.id, status: 'pass', rationale: 'Stale', sourceRefs: [oldComparison] }))), /current retained/);
    record = await store.savePlan(record.id, record.revision, { ...plan(), scope: 'Changed scope' }); assert.equal(record.phase, 'plan'); assert.equal(record.planVersion, 2); assert.equal(record.maintenance, null);
    assert.equal(record.sources.beforeId, null); assert.ok(record.timeline.length > 6);
  }));
  await test('change workflow rejects inline credentials, unknown executable fields, oversized and malformed reviewed evidence before storage', () => inStore(async ({ store }) => {
    await assert.rejects(async () => store.create({ ...plan(), password: 'PRIVATE_SENTINEL' }), /Unsupported/);
    let record = await store.create(plan());
    const base = { schemaVersion: 1, kind: 'runbook', name: 'Synthetic', steps: [], complete: false, stopped: false, warnings: [] };
    for (const report of [{ ...base, connectionSpec: { host: 'PRIVATE_HOST' } }, { ...base, steps: [{ evidence: { password: 'PRIVATE_SENTINEL' } }] }, { ...base, name: 'x'.repeat(LIMITS.reportBytes + 1) }]) await assert.rejects(async () => store.addEvidence(record.id, record.revision, { label: 'Unsafe', phase: 'baseline', reviewed: true, report }));
    await assert.rejects(async () => store.addEvidence(record.id, record.revision, { label: 'Not reviewed', phase: 'baseline', reviewed: false, report: base }), /Preview/);
    assert.equal((await store.get(record.id)).evidence.length, 0);
    const requested = { label: 'Owned reviewed copy', phase: 'baseline', reviewed: true, report: base }; const pending = store.addEvidence(record.id, record.revision, requested); requested.report.name = 'MUTATED_AFTER_QUEUE'; record = await pending;
    assert.equal(record.evidence[0].report.name, 'Synthetic'); assert.match(record.evidence[0].provenance, /not independently verified/);
  }));
  await test('change evidence retains the actual offline capture comparator report including uncertainty and original frame references', () => inStore(async ({ store }) => {
    const imported = relative => import(pathToFileURL(path.join(repo, 'src/renderer/js/capture', relative)).href);
    const [{ createComparisonDemo }, { readCapture }, { compareCaptures }] = await Promise.all([imported('sample-compare.mjs'), imported('pcapfile.mjs'), imported('capture-compare.mjs')]);
    const sample = createComparisonDemo(), before = readCapture(sample.before.bytes), after = readCapture(sample.after.bytes);
    const report = await compareCaptures(before.packets, after.packets, { labels: { before: sample.before.name, after: sample.after.name } });
    let record = await store.create(plan()); record = await store.addEvidence(record.id, record.revision, { label: 'Offline capture comparison', phase: 'after', reviewed: true, report });
    assert.deepEqual(record.evidence[0].report, report); assert.ok(report.changes.length); assert.ok(report.limitations.length); assert.equal(assessment(record), 'not fully reviewed');
  }));
  await test('change workflow exact serialized capacity stays readable and an oversized update preserves the prior record', () => inStore(async ({ store }) => {
    const attachment = length => ({ label: 'reviewed', phase: 'after', reviewed: true, report: { schemaVersion: 1, kind: 'runbook', steps: [{ text: 'x'.repeat(length) }], complete: true, stopped: false } });
    const seed = async () => { let record = await store.create({ ...plan(), checks: [plan().checks[0]] }); for (let i = 0; i < 3; i++) record = await store.addEvidence(record.id, record.revision, attachment(1048000)); return record; };
    // Both records use the same public operations; generated UUIDs/timestamps have
    // fixed encoded widths, so the first measures the fourth attachment overhead.
    let reference = await seed(); reference = await store.addEvidence(reference.id, reference.revision, attachment(1));
    const fill = 1 + LIMITS.recordBytes - Buffer.byteLength(JSON.stringify(reference));
    let record = await seed(); record = await store.addEvidence(record.id, record.revision, attachment(fill));
    assert.equal(Buffer.byteLength(JSON.stringify(record)), LIMITS.recordBytes); assert.equal((await fs.stat(store.file(record.id))).size, LIMITS.recordBytes);
    assert.deepEqual(await store.get(record.id), record);
    await assert.rejects(store.addEvidence(record.id, record.revision, attachment(1)), /byte limit/);
    assert.deepEqual(await store.get(record.id), record, 'Capacity failure cannot replace the valid saved record');
  }));
  await test('change report HTML escapes source/plan text and atomic export does not overwrite the managed library', () => inStore(async ({ store, root }) => {
    const record = await store.create({ ...plan(), name: '<script>alert(1)</script>', scope: '<img src=x onerror=alert(1)>' });
    const html = await store.exportHtml(record.id); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/); assert.ok(!html.includes('<img src=x'));
    await assert.rejects(async () => store.exportFile(record.id, 'json', store.file(record.id)), /outside/);
    const alias = path.join(root, 'profile-alias'); await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.exportFile(record.id, 'json', path.join(alias, 'change-validation', record.id + '.json')), /outside/);
    assert.deepEqual(await store.get(record.id), record, 'Ancestor aliases cannot overwrite a managed workflow');
    await fs.unlink(alias);
    const out = path.join(root, 'existing.json'); await fs.writeFile(out, 'OLD'); await store.exportFile(record.id, 'json', out); assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).workflow.id, record.id);
  }));
  await test('change atomic write failure keeps prior revision and tracked failed cleanup retries on close', () => inStore(async ({ store, snapshots, incidents, root }) => {
    const record = await store.create(plan()); let failWrite = true, failClose = true;
    const io = Object.create(fs); io.open = async (file, flags, mode) => { const handle = await fs.open(file, flags, mode); if (flags !== 'wx') return handle;
      return { stat: (...args) => handle.stat(...args), sync: () => handle.sync(), writeFile: async (...args) => { if (failWrite) throw new Error('Synthetic write failure'); return handle.writeFile(...args); },
        close: async () => { if (failClose) throw new Error('Synthetic close failure'); return handle.close(); } }; };
    const owned = new ChangeValidationStore(root, { snapshots, incidents, fs: io });
    await assert.rejects(owned.savePlan(record.id, record.revision, { ...plan(), name: 'Failed replacement' }), /Synthetic/); assert.equal(owned.hasOwnership, true); assert.deepEqual(await store.get(record.id), record);
    await assert.rejects(owned.close(), /cleanup remains pending/); assert.equal(owned.hasOwnership, true);
    failWrite = false; failClose = false; await owned.close(); assert.equal(owned.hasOwnership, false); assert.equal((await fs.readdir(owned.directory)).some(name => name.endsWith('.tmp')), false);
  }));
  await test('change pending read retains handle ownership, close waits queued work and blocks new work while cleanup runs', () => inStore(async ({ store, root, snapshots, incidents }) => {
    const record = await store.create(plan()); let release, entered; const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
    const io = Object.create(fs); io.open = async (file, flags, mode) => { const handle = await fs.open(file, flags, mode); if (flags !== 'r') return handle;
      return { stat: (...args) => handle.stat(...args), read: async (...args) => { entered(); await blocked; return handle.read(...args); }, close: () => handle.close() }; };
    const owned = new ChangeValidationStore(root, { snapshots, incidents, fs: io }); const pending = owned.get(record.id); await started; assert.equal(owned.hasOwnership, true);
    const closing = owned.close(); await assert.rejects(owned.get(record.id), /closing/); release(); assert.equal((await pending).id, record.id); await closing; assert.equal(owned.hasOwnership, false);
  }));
  await test('change POSIX link publication remains successful through alias cleanup failure and never deletes a replaced identity', () => inStore(async ({ root }) => {
    let failUnlink = true; const io = Object.create(fs); io.unlink = async file => { if (failUnlink && path.basename(file).startsWith('.change-')) throw Error('Synthetic unlink failure'); return fs.unlink(file); };
    const store = new ChangeValidationStore(root, { fs: io, publishNew: (...args) => require('../src/main/atomic-replacement').publishNewFile(...args, { platform: 'linux' }) }); const record = await store.create(plan()); assert.equal(record.revision, 1); assert.equal(store.hasOwnership, true);
    const owner = [...store.owners][0]; assert.equal(path.dirname(owner.file), store.directory);
    await fs.unlink(owner.file); const replacement = path.join(store.directory, 'replacement.tmp'); await fs.writeFile(replacement, 'FOREIGN_SYNTHETIC_FILE'); await fs.rename(replacement, owner.file);
    failUnlink = false; await assert.rejects(store.close(), /cleanup remains pending/); assert.equal(await fs.readFile(owner.file, 'utf8'), 'FOREIGN_SYNTHETIC_FILE'); assert.equal(store.hasOwnership, true);
    // This entire isolated directory belongs to this test. Production correctly
    // retains the unresolved owner instead of removing the replacement.
  }));
  await test('change list rejects malformed/oversized records and refuses symlink storage without deleting foreign data', () => inStore(async ({ store, root }) => {
    const record = await store.create(plan()); await fs.writeFile(store.file(record.id), '{invalid'); const list = await store.list(); assert.equal(list.records.length, 0); assert.ok(list.issues.length);
    await assert.rejects(store.get(record.id));
    const other = path.join(root, 'foreign'); await fs.mkdir(other); const nested = path.join(root, 'linked-profile'); await fs.mkdir(nested); await fs.symlink(other, path.join(nested, 'change-validation'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = new ChangeValidationStore(nested); await assert.rejects(linked.create(plan()), /real directory/); assert.deepEqual(await fs.readdir(other), []);
  }));
}
module.exports = { runChangeValidationTests, loadBackend, repo, inStore, plan };
if (require.main === module) runChangeValidationTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
