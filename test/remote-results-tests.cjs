'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { RemoteCaptureResults, MAX_RESULTS } = require('../src/main/remote-results');
const { samplePcap } = require('./lib/remote-fixture.cjs');
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-remote-results-'));
  try { return await fn(dir); }
  finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.match(path.basename(dir), /^konx-remote-results-/); await fs.rm(dir, { recursive: true, force: true }); }
}
async function makeReport(dir) {
  const directory = path.join(dir, 'remote-captures'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, crypto.randomUUID() + '.pcap'), bytes = samplePcap(); await fs.writeFile(file, bytes);
  return { schemaVersion: 1, kind: 'remote-capture', file, bytes: bytes.length, packets: 2, complete: true, warnings: [], stderr: '', host: '127.0.0.1' };
}
async function runRemoteResultTests(test) {
  await test('remote result registry: opaque public ID opens exact bytes through the retained handle', async () => temporary(async dir => {
    const report = await makeReport(dir); let opens = 0;
    const registry = new RemoteCaptureResults(dir, { fs: { ...fs, open: async (...args) => { opens++; return fs.open(...args); } } });
    try {
      const publicReport = await registry.remember({ ...report, session: { password: 'not-public' } });
      assert.equal(registry.hasOpenHandles, true); assert.equal(publicReport.fileName, path.basename(report.file));
      assert.equal(Object.hasOwn(publicReport, 'file'), false); assert.equal(Object.hasOwn(publicReport, 'session'), false); assert.match(publicReport.captureId, /^[0-9a-f-]{36}$/); assert.notEqual(publicReport.captureId, path.basename(report.file, '.pcap'));
      const result = await registry.read(publicReport.captureId); assert.deepEqual(result.bytes, samplePcap()); assert.equal(result.name, publicReport.fileName);
      assert.equal(opens, 1, 'read must use the registered handle, not reopen its path');
      await registry.remove(publicReport.captureId); await assert.rejects(fs.stat(report.file), { code: 'ENOENT' }); await assert.rejects(registry.read(publicReport.captureId), /Unknown/);
      assert.equal(registry.hasOpenHandles, false);
    } finally { await registry.close(); }
  }));
  await test('remote result registry: foreign IDs, paths and names never become file authority', async () => temporary(async dir => {
    const report = await makeReport(dir), registry = new RemoteCaptureResults(dir);
    try {
      await assert.rejects(registry.read('../outside'), /Unknown/); await assert.rejects(registry.remove(crypto.randomUUID()), /Unknown/);
      await assert.rejects(registry.remember({ ...report, file: path.join(dir, path.basename(report.file)) }), /outside/);
      await assert.rejects(registry.remember({ ...report, file: path.join(dir, 'remote-captures', 'capture.pcap') }), /outside/);
      await assert.rejects(registry.remember({ ...report, bytes: report.bytes + 1 }), /changed before registration/);
      const pub = await registry.remember(report); await assert.rejects(registry.remember(report), /already registered/); assert.deepEqual((await registry.read(pub.captureId)).bytes, samplePcap());
    } finally { await registry.close(); }
  }));
  await test('remote result registry: same-size mutation is detected by content hash while owned removal remains possible', async () => temporary(async dir => {
    const report = await makeReport(dir), registry = new RemoteCaptureResults(dir);
    try {
      const pub = await registry.remember(report), changed = samplePcap(); changed[changed.length - 1] ^= 1; await fs.writeFile(report.file, changed);
      await assert.rejects(registry.read(pub.captureId), /bytes changed/); await registry.remove(pub.captureId); await assert.rejects(fs.stat(report.file), { code: 'ENOENT' });
    } finally { await registry.close(); }
  }));
  await test('remote result registry: replacing a path cannot substitute bytes or authorize deleting its replacement', async () => temporary(async dir => {
    const report = await makeReport(dir), registry = new RemoteCaptureResults(dir);
    try {
      const pub = await registry.remember(report), moved = report.file + '.owned-old'; await fs.rename(report.file, moved); await fs.writeFile(report.file, samplePcap());
      await assert.rejects(registry.read(pub.captureId), /changed identity/); await assert.rejects(registry.remove(pub.captureId), /changed identity/);
      assert.equal((await fs.stat(report.file)).isFile(), true); assert.equal((await fs.stat(moved)).isFile(), true);
      await fs.unlink(report.file); await fs.rename(moved, report.file); await registry.remove(pub.captureId);
    } finally { await registry.close(); }
  }));
  await test('remote result registry: simulated file-symlink metadata is rejected before opening the file', async () => temporary(async dir => {
    const report = await makeReport(dir); let opens = 0;
    // Windows does not permit creating a file symlink in this test account.
    // Exercise the stat boundary explicitly; real junctions are tested below.
    const registry = new RemoteCaptureResults(dir, { fs: { ...fs,
      lstat: async (...args) => { const stat = await fs.lstat(...args); if (args[0] === report.file) { const linkStat = Object.create(stat); linkStat.isSymbolicLink = () => true; return linkStat; } return stat; },
      open: async (...args) => { opens++; return fs.open(...args); } } });
    try { await assert.rejects(registry.remember(report), /symbolic link/); assert.equal(opens, 0); assert.deepEqual(await fs.readFile(report.file), samplePcap()); }
    finally { await registry.close(); }
  }));
  await test('remote result registry: a real directory junction is rejected before registration', async () => temporary(async dir => {
    const report = await makeReport(dir), directory = path.join(dir, 'remote-captures'), moved = path.join(dir, 'moved-captures');
    await fs.rename(directory, moved); await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
    const registry = new RemoteCaptureResults(dir);
    try {
      await assert.rejects(registry.remember(report), /directory identity/); assert.deepEqual(await fs.readFile(path.join(moved, path.basename(report.file))), samplePcap());
    } finally { await registry.close(); }
  }));
  await test('remote result registry: changed directory metadata blocks registered reads and deletion', async () => temporary(async dir => {
    const report = await makeReport(dir), directory = path.join(dir, 'remote-captures'), target = path.join(dir, 'other-directory'), junction = path.join(dir, 'junction');
    await fs.mkdir(target); await fs.symlink(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const linkStat = await fs.lstat(junction, { bigint: true }); let replaced = false, unlinks = 0;
    // Open file handles prevent an actual directory rename on Windows. Feed the
    // actual junction's metadata at the identity boundary to test both actions.
    const registry = new RemoteCaptureResults(dir, { fs: { ...fs,
      lstat: (...args) => replaced && args[0] === directory ? Promise.resolve(linkStat) : fs.lstat(...args),
      unlink: async file => { unlinks++; return fs.unlink(file); } } });
    try {
      const pub = await registry.remember(report); replaced = true;
      await assert.rejects(registry.read(pub.captureId), /directory identity/); await assert.rejects(registry.remove(pub.captureId), /directory identity/); assert.equal(unlinks, 0);
      replaced = false; await registry.remove(pub.captureId);
    } finally { await registry.close(); }
  }));
  await test('remote result registry: failed unlink keeps registration and owned handle available for retry', async () => temporary(async dir => {
    const report = await makeReport(dir); let fail = true;
    const registry = new RemoteCaptureResults(dir, { fs: { ...fs, unlink: async file => { if (fail) throw Error('fixture unlink failure'); return fs.unlink(file); } } });
    try {
      const pub = await registry.remember(report); await assert.rejects(registry.remove(pub.captureId), /unlink failure/);
      assert.deepEqual((await registry.read(pub.captureId)).bytes, samplePcap()); fail = false; await registry.remove(pub.captureId); await assert.rejects(registry.read(pub.captureId), /Unknown/);
    } finally { await registry.close(); }
  }));
  await test('remote result registry: failed handle close after unlink remains registered for exact cleanup retry', async () => temporary(async dir => {
    const report = await makeReport(dir); let fail = true;
    const registry = new RemoteCaptureResults(dir, { fs: { ...fs, open: async (...args) => { const handle = await fs.open(...args); return { stat: (...a) => handle.stat(...a), read: (...a) => handle.read(...a), close: async () => { if (fail) { fail = false; throw Error('fixture close failure'); } return handle.close(); } }; } } });
    try {
      const pub = await registry.remember(report); await assert.rejects(registry.remove(pub.captureId), /close failure/); await assert.rejects(registry.read(pub.captureId), /waiting for handle cleanup/);
      await registry.remove(pub.captureId); await assert.rejects(registry.read(pub.captureId), /Unknown/);
    } finally { await registry.close(); }
  }));
  await test('remote result registry: session capacity counts pending jobs and rejects new results at the bound', async () => temporary(async dir => {
    const registry = new RemoteCaptureResults(dir);
    try {
      registry.assertCapacity(MAX_RESULTS - 1); assert.throws(() => registry.assertCapacity(MAX_RESULTS), /128-result/);
      for (let i = 0; i < MAX_RESULTS; i++) await registry.remember(await makeReport(dir));
      assert.throws(() => registry.assertCapacity(), /128-result/); await assert.rejects(registry.remember(await makeReport(dir)), /128-result/);
    } finally { await registry.close(); }
  }));
  await test('remote result registry: session close releases handles but leaves captured files intact', async () => temporary(async dir => {
    const report = await makeReport(dir), registry = new RemoteCaptureResults(dir), pub = await registry.remember(report);
    await registry.close(); assert.equal(registry.hasOpenHandles, false); assert.deepEqual(await fs.readFile(report.file), samplePcap()); await assert.rejects(registry.read(pub.captureId), /Unknown/);
  }));
  await test('remote result registry: failed shutdown close retains ownership until cleanup retry succeeds', async () => temporary(async dir => {
    const report = await makeReport(dir); let fail = true;
    const registry = new RemoteCaptureResults(dir, { fs: { ...fs, open: async (...args) => { const handle = await fs.open(...args); return { stat: (...a) => handle.stat(...a), read: (...a) => handle.read(...a), close: async () => { if (fail) throw Error('fixture close blocked'); return handle.close(); } }; } } });
    try {
      const pub = await registry.remember(report); await assert.rejects(registry.close(), /cleanup is incomplete/); assert.equal(registry.hasOpenHandles, true);
      assert.deepEqual((await registry.read(pub.captureId)).bytes, samplePcap()); fail = false; await registry.close(); assert.equal(registry.hasOpenHandles, false);
      assert.deepEqual(await fs.readFile(report.file), samplePcap());
    } finally { fail = false; await registry.close(); }
  }));
}
module.exports = { runRemoteResultTests };
if (require.main === module) {
  let total = 0, failed = 0;
  runRemoteResultTests(async (name, fn) => { total++; try { await fn(); console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } })
    .then(() => { console.log(`\n${total - failed}/${total} remote result tests passed`); process.exitCode = failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
