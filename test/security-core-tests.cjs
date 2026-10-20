'use strict';
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { finding, makeReport, onCancel, checkCancelled } = require('../src/main/security/common');

async function runSecurityCoreTests(test) {
  const { validateReport, summary, compareReports, exportReport } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/js/security-report.mjs')).href);
  const report = (checks = []) => ({ ...makeReport({ kind: 'config', title: 'Configuration review', target: 'Lab', checks }), scopeId: 'a'.repeat(64) });
  const check = (id, status = 'unknown', evidence = 'Not accessible') => finding({ id, title: 'Check ' + id, status, evidence });
  await test('security: concurrent cancellation cleans up in any order and runs all remaining hooks', () => {
    const calls = [];
    const previous = () => calls.push('previous');
    const signal = { stopped: false, onStop: previous };
    const first = onCancel(signal, () => calls.push('first'));
    const throwing = onCancel(signal, () => { calls.push('throws'); throw new Error('fixture'); });
    const last = onCancel(signal, () => calls.push('last'));
    first(); signal.stopped = true; signal.onStop();
    assert.deepEqual(calls, ['previous', 'throws', 'last']);
    throwing(); last(); first();
    assert.equal(signal.onStop, previous);
    assert.throws(() => checkCancelled(signal), /cancelled/);
    let immediate = 0;
    const remove = onCancel(signal, () => immediate++);
    assert.equal(immediate, 1); remove(); assert.equal(signal.onStop, previous);
  });
  await test('security: malformed or duplicate report findings are rejected before display/export', () => {
    assert.throws(() => validateReport(report([check('a'), check('a')])), /Duplicate/);
    assert.throws(() => exportReport({ ...report(), schemaVersion: 2 }, 'json'), /Invalid/);
    assert.throws(() => validateReport(report([{ ...check('a'), status: 'secure' }])), /Invalid/);
    assert.throws(() => validateReport({ ...report(), checks: [{ ...check('a'), evidence: 'x'.repeat(4001) }] }), /Invalid/);
    assert.throws(() => validateReport({ ...report(), limitations: Array(31).fill('x') }), /Invalid/);
    assert.throws(() => exportReport(report(), 'pdf'), /Unsupported/);
  });
  await test('security: unknown checks remain distinct in summary and exported reports', () => {
    const value = report([check('a', 'pass'), check('b'), check('c', 'warning')]);
    assert.deepEqual(summary(value), { pass: 1, warning: 1, fail: 0, unknown: 1, info: 0 });
    assert.deepEqual(JSON.parse(exportReport(value, 'json')), validateReport(value));
    assert.match(exportReport(value, 'html'), /Unknown and inaccessible checks are not passing/);
  });
  await test('security: HTML report escapes all observations and contains no executable fixture markup', () => {
    const payload = '<img src=x onerror="alert(1)"><script>run()</script>&\'';
    const value = { ...report([check('a', 'warning', payload)]), title: payload, target: payload, limitations: [payload] };
    const html = exportReport(value, 'html');
    assert.ok(!html.includes('<script>') && !html.includes('<img'));
    assert.match(html, /&lt;script&gt;run\(\)&lt;\/script&gt;/);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /&quot;/); assert.match(html, /&#39;/);
  });
  await test('security: baseline comparison requires matching scope and distinguishes missing/new/changed checks', () => {
    const baseline = report([check('a'), check('b', 'warning'), check('old', 'fail')]);
    const current = report([check('a'), check('b', 'pass', 'Enabled'), check('new', 'info')]);
    const diff = compareReports(current, baseline);
    assert.deepEqual(diff.changes.map(({ id, change, previous }) => [id, change, previous]), [['a', 'unchanged', 'unknown'], ['b', 'changed', 'warning'], ['new', 'new', '']]);
    assert.deepEqual(diff.removed.map((c) => c.id), ['old']);
    for (const mismatch of [{ target: 'Other' }, { kind: 'windows' }, { scopeId: 'b'.repeat(64) }]) {
      assert.throws(() => compareReports(current, { ...baseline, ...mismatch }), /different assessment target/);
    }
    assert.throws(() => compareReports({ ...current, scopeId: '' }, { ...baseline, scopeId: '' }), /different assessment target/);
  });
  await test('security: manager rejects unknown jobs, honors cancellation, and assigns stable redacted scopes', async () => {
    const { run } = require('../src/main/security');
    await assert.rejects(run({ audit: '__proto__' }, () => {}, {}), /Unknown/);
    await assert.rejects(run({ audit: 'windows' }, () => {}, { stopped: true }), /cancelled/);
    const events = [];
    const params = { audit: 'config', label: 'Lab fixture', text: 'hostname lab\nversion 17.1\nip ssh version 2\nline vty 0 4\n transport input ssh\n' };
    await run(params, (type, data) => events.push([type, data]), {});
    const value = events.find(([type]) => type === 'report')[1];
    assert.equal(value.target, 'Lab fixture'); assert.match(value.scopeId, /^[a-f0-9]{64}$/);
    assert.equal(value.kind, 'config'); validateReport(value);
    const again = [];
    await run({ ...params, text: params.text + 'no ip http server\n' }, (type, data) => { if (type === 'report') again.push(data); }, {});
    assert.equal(again[0].scopeId, value.scopeId);
    assert.ok(!JSON.stringify(value).includes('hostname lab'));
    const unlabeled = [];
    await run({ ...params, label: '' }, (type, data) => { if (type === 'report') unlabeled.push(data); }, {});
    assert.equal(unlabeled[0].scopeId, '', 'unlabeled pasted configs must not share a baseline');
  });
}
module.exports = { runSecurityCoreTests };
