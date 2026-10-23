'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { collectSupportReport, sanitizeSupportLog, validateSupportExport, MAX_REPORT_BYTES, MAX_LOG_BYTES } = require('../src/main/support-report');
const info = { version: '0.18.1', platform: 'win32', arch: 'x64', electron: '44.9.0', node: '24.22.0', mode: 'portable',
  features: { serial: true, encryption: true, capture: false, portableUpdater: true, installedUpdater: false } };

async function fixture(run) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'konx-support-test-'));
  try { return await run(root); }
  finally {
    const real = await fs.realpath(root);
    assert.equal(path.dirname(real), parent); assert.ok(path.basename(real).startsWith('konx-support-test-'));
    await fs.rm(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function runSupportReportTests(test) {
  await test('support report: default collection whitelists facts and never reads logs or ambient values', async () => {
    const privateValue = 'PRIVATE_SENTINEL_PROFILE_HOST_CREDENTIAL_CONTENT';
    const report = await collectSupportReport({ info: { ...info, logDir: privateValue, hostname: privateValue, env: { TOKEN: privateValue },
      features: { ...info.features, providerKey: privateValue } }, screens: [{ id: privateValue, label: privateValue, bounds: { x: 100, y: -50, width: 1920, height: 1080 }, scaleFactor: 1.25 }],
      counts: { tabs: 3, connections: 1, jobs: 0, sessions: [privateValue] }, logDir: privateValue, logs: privateValue, content: privateValue },
    { fs: new Proxy({}, { get() { throw new Error('Default report must not access the filesystem'); } }) });
    assert.deepEqual(report.runtime, { version: '0.18.1', platform: 'win32', arch: 'x64', electron: '44.9.0', node: '24.22.0', mode: 'portable' });
    assert.deepEqual(report.displays, [{ width: 1920, height: 1080, scaleFactor: 1.25 }]);
    assert.deepEqual(report.counts, { tabs: 3, connections: 1, jobs: 0 });
    assert.equal(report.features.capture, false); assert.equal(report.logs.requested, false); assert.deepEqual(report.logs.entries, []);
    assert.ok(report.omissions.includes('LOGS_NOT_REQUESTED')); assert.equal(report.privacy.uploaded, false);
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  });

  await test('support report: malformed facts stay unknown and collections stay bounded', async () => {
    for (const input of [null, false, 'unexpected', []]) assert.equal((await collectSupportReport(input)).runtime.version, null);
    const report = await collectSupportReport({ info: { version: 'private-name', platform: {}, arch: 'private-host', electron: Infinity,
      node: '24.1.0\nsecret', mode: 'private-path', features: { serial: 'yes' } }, counts: { tabs: -1, connections: Infinity, jobs: 1000001 },
      screens: Array.from({ length: 1000 }, () => ({ width: Infinity, height: -1, scaleFactor: NaN, label: 'PRIVATE_SCREEN' })) });
    assert.equal(report.runtime.mode, 'unknown'); assert.deepEqual(report.counts, { tabs: null, connections: null, jobs: null });
    assert.equal(report.displays.length, 8); assert.deepEqual(report.displays[0], { width: null, height: null, scaleFactor: null });
    assert.equal(report.features.serial, null); assert.ok(report.omissions.includes('DISPLAYS_TRUNCATED'));
    assert.equal(JSON.stringify(report).includes('PRIVATE_SCREEN'), false);
    assert.equal((await collectSupportReport({ includeLogs: 'true' })).logs.requested, false);
  });

  await test('support report: explicit logs use only fixed filenames and redact known paths and credentials', () => fixture(async root => {
    const home = String.raw`C:\Users\SyntheticPerson`, profile = home + String.raw`\AppData\Roaming\KonX`;
    const text = `Error at ${profile}\\main.js\nfile:///${home.replace(/\\/g, '/')}\\note.js\n` +
      JSON.stringify({ stack: home + '\\private.js', password: 'PRIVATE_PASSWORD', api_key: 'PRIVATE_API' }) + '\n' +
      'Authorization: Bearer PRIVATE_AUTH\nssh://fixture:PRIVATE_URL@device.invalid\n' +
      '-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_PEM\n-----END RSA PRIVATE KEY-----\n' +
      'token=PRIVATE_TOKEN\nUsefulError: missing module\n';
    await fs.writeFile(path.join(root, 'javascript-errors.log'), text);
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'PRIVATE_UNREQUESTED_FILE');
    const opened = [], io = { ...fs, open: async (file, flags) => { opened.push(path.basename(file)); return fs.open(file, flags); } };
    const report = await collectSupportReport({ info, screens: [], includeLogs: true, logDir: root, redactPaths: [home, profile] }, { fs: io });
    assert.deepEqual(opened, ['javascript-errors.log']);
    assert.equal(report.logs.entries[0].status, 'included'); assert.equal(report.logs.entries[0].coverage, 'complete');
    assert.equal(report.logs.entries[1].status, 'LOG_NOT_FOUND');
    const exported = JSON.stringify(report);
    for (const secret of ['SyntheticPerson', 'PRIVATE_PASSWORD', 'PRIVATE_API', 'PRIVATE_AUTH', 'PRIVATE_URL', 'PRIVATE_PEM', 'PRIVATE_TOKEN', 'PRIVATE_UNREQUESTED_FILE', root]) assert.equal(exported.includes(secret), false, secret);
    assert.match(report.logs.entries[0].text, /UsefulError: missing module/); assert.match(report.logs.notice, /not a guarantee/);
  }));

  await test('support report: oversized and escaping-heavy logs have explicit bounded coverage', () => fixture(async root => {
    for (const name of ['javascript-errors.log', 'javascript-errors.previous.log']) await fs.writeFile(path.join(root, name), '\u0001'.repeat(1024 * 1024) + 'UNREAD_TAIL');
    let bytesRead = 0;
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { stat: (...statArgs) => handle.stat(...statArgs), close: () => handle.close(), read: async (...readArgs) => {
        const result = await handle.read(...readArgs); bytesRead += result.bytesRead; return result;
      } };
    } };
    const report = await collectSupportReport({ info, screens: [], includeLogs: true, logDir: root }, { fs: io });
    assert.equal(bytesRead, MAX_LOG_BYTES * 2);
    for (const entry of report.logs.entries) { assert.equal(entry.coverage, 'prefix'); assert.equal(entry.bytesRead, MAX_LOG_BYTES); assert.ok(Buffer.byteLength(entry.text) <= MAX_LOG_BYTES); }
    const json = JSON.stringify(report, null, 2); assert.ok(Buffer.byteLength(json) <= MAX_REPORT_BYTES); assert.equal(json.includes('UNREAD_TAIL'), false);
    assert.equal(validateSupportExport(json), json);
    assert.ok(Buffer.byteLength(sanitizeSupportLog('🔒'.repeat(30000))) <= MAX_LOG_BYTES);
    assert.equal(sanitizeSupportLog('🔒'.repeat(30000)).includes('\ufffd'), false);
  }));

  await test('support report: symlink directories and nonregular log targets are never opened', () => fixture(async root => {
    const actual = path.join(root, 'actual'), linked = path.join(root, 'linked'); await fs.mkdir(actual);
    await fs.writeFile(path.join(actual, 'javascript-errors.log'), 'PRIVATE_LINK_TARGET');
    await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const io = { ...fs, open: async () => { throw new Error('Unsafe target must never be opened'); } };
    const linkedReport = await collectSupportReport({ includeLogs: true, logDir: linked }, { fs: io });
    assert.ok(linkedReport.omissions.includes('LOG_UNSAFE_PATH')); assert.deepEqual(linkedReport.logs.entries, []);
    const directory = path.join(root, 'logs'); await fs.mkdir(directory); await fs.mkdir(path.join(directory, 'javascript-errors.log'));
    const report = await collectSupportReport({ includeLogs: true, logDir: directory }, { fs: io });
    assert.equal(report.logs.entries[0].status, 'LOG_UNSAFE_PATH');
    assert.equal(JSON.stringify(report).includes('PRIVATE_LINK_TARGET'), false);
  }));

  await test('support report: file identity changes are rejected before reading and handles close', () => fixture(async root => {
    await fs.writeFile(path.join(root, 'javascript-errors.log'), 'PRIVATE_REPLACEMENT');
    let closes = 0, reads = 0;
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { stat: async (...statArgs) => { const stat = await handle.stat(...statArgs); stat.ino += 1n; return stat; },
        read: async () => { reads++; throw Error('must not read'); }, close: async () => { closes++; await handle.close(); } };
    } };
    const report = await collectSupportReport({ includeLogs: true, logDir: root }, { fs: io });
    assert.equal(report.logs.entries[0].status, 'LOG_CHANGED'); assert.equal(reads, 0); assert.equal(closes, 1);
    assert.equal(JSON.stringify(report).includes('PRIVATE_REPLACEMENT'), false);
  }));

  await test('support report: realpath escape and log symlink metadata fail before opening', () => fixture(async root => {
    await fs.writeFile(path.join(root, 'javascript-errors.log'), 'PRIVATE_ESCAPE');
    const noOpen = async () => { throw Error('unsafe path opened'); };
    const escapeIo = { ...fs, open: noOpen, realpath: async file => path.basename(file) === 'javascript-errors.log' ? path.join(path.dirname(root), 'outside.log') : fs.realpath(file) };
    assert.equal((await collectSupportReport({ includeLogs: true, logDir: root }, { fs: escapeIo })).logs.entries[0].status, 'LOG_UNSAFE_PATH');
    const linkIo = { ...fs, open: noOpen, lstat: async (file, ...args) => { const stat = await fs.lstat(file, ...args); if (path.basename(file) === 'javascript-errors.log') stat.isSymbolicLink = () => true; return stat; } };
    assert.equal((await collectSupportReport({ includeLogs: true, logDir: root }, { fs: linkIo })).logs.entries[0].status, 'LOG_UNSAFE_PATH');
  }));

  await test('support report: filesystem errors expose safe codes and failed reads still close handles', () => fixture(async root => {
    await fs.writeFile(path.join(root, 'javascript-errors.log'), 'fixture'); let closes = 0;
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { stat: (...statArgs) => handle.stat(...statArgs), read: async () => { throw Error('PRIVATE_ERROR_PATH_AND_CREDENTIAL'); }, close: async () => { closes++; await handle.close(); } };
    } };
    const report = await collectSupportReport({ includeLogs: true, logDir: root }, { fs: io });
    assert.equal(report.logs.entries[0].status, 'LOG_READ_FAILED'); assert.equal(closes, 1);
    assert.equal(JSON.stringify(report).includes('PRIVATE_ERROR'), false);
    assert.ok((await collectSupportReport({ includeLogs: true, logDir: 'relative/logs' })).omissions.includes('LOG_DIRECTORY_UNAVAILABLE'));
  }));

  await test('support report: editable export validates JSON identity and byte bounds without rewriting', async () => {
    const report = await collectSupportReport({ info, screens: [], counts: { tabs: 0, connections: 0, jobs: 0 } });
    report.userNotes = 'Reviewed by the user'; delete report.logs;
    const text = JSON.stringify(report, null, 4) + '\n'; assert.equal(validateSupportExport(text), text);
    for (const invalid of [null, {}, '[]', '{}', 'null', '{', '{"schemaVersion":2,"kind":"konx-support-report"}']) assert.throws(() => validateSupportExport(invalid));
    assert.throws(() => validateSupportExport(JSON.stringify({ schemaVersion: 1, kind: 'konx-support-report', notes: '🔒'.repeat(MAX_REPORT_BYTES / 3) })), /256 KiB/);
  });
}
module.exports = { runSupportReportTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runSupportReportTests(async (name, run) => { try { await run(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} support report tests passed`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
