'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PREFIX = 'konx-diagnostics-electron-';
const FIXTURE_MESSAGE = 'KONX_SYNTHETIC_FATAL_fixture';

async function runFixture(mode) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, PREFIX));
  let child;
  let output = '';
  try {
    const env = { ...process.env, KONX_DIAGNOSTIC_TEST_ROOT: root,
      KONX_USERDATA: path.join(root, 'profile'), KONX_DEMO: '', KONX_CAPTURE: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [__filename, '--diagnostics-fixture', mode], {
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (bytes) => { output = (output + bytes).slice(-65536); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const exitCode = await new Promise((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      // Waiting for close also drains both pipes before assertions and cleanup.
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) reject(new Error(`Electron ${mode} diagnostics fixture timed out\n${output}`));
        else resolve(code);
      });
    });
    assert.equal(exitCode, 0, output);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
    assert.equal(result.mode, mode);
    assert.equal(result.dialogCalls, mode === 'throw' ? 1 : 0, 'Electron must retain its normal error policy');
    assert.equal(result.logWasSavedSynchronously, true);
    assert.equal(result.handlersPreserved, true);
    assert.equal(result.origin, mode === 'reject' ? 'unhandledRejectionWarning' : 'uncaughtException');
    const text = fs.readFileSync(path.join(root, 'diagnostics', 'javascript-errors.log'), 'utf8');
    assert.match(text, new RegExp(FIXTURE_MESSAGE));
    assert.ok(text.includes(`KonX ${require('../package.json').version} | Electron ${result.electronVersion} | ${result.origin}`));
    if (mode === 'throw') assert.equal(text.split(FIXTURE_MESSAGE).length - 1, 1, 'One fatal error must produce one log entry');
    if (mode === 'reject') assert.match(output, /UnhandledPromiseRejectionWarning: Error: KONX_SYNTHETIC_FATAL_fixture/,
      'Electron must still emit its ordinary unhandled-rejection warning');
  } finally {
    if (child && child.exitCode === null && !child.killed) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await closed;
    }
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent, 'Only the fresh test directory may be removed');
    assert.ok(path.basename(target).startsWith(PREFIX));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runDiagnosticsElectronTests(test) {
  await test('real Electron saves an asynchronous exception before its default error dialog', () => runFixture('throw'));
  await test('real Electron saves unhandled-rejection evidence while preserving its default warning policy', () => runFixture('reject'));
}

function electronFixture() {
  const { app, dialog } = require('electron');
  // Also intercept fixture setup failures, before any assertions can throw.
  dialog.showErrorBox = (_title, message) => { console.error(message); app.exit(1); };
  const mode = process.argv[process.argv.indexOf('--diagnostics-fixture') + 1];
  const root = path.resolve(process.env.KONX_DIAGNOSTIC_TEST_ROOT || '.');
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith(PREFIX));
  assert.ok(mode === 'throw' || mode === 'reject');
  fs.mkdirSync(path.join(root, 'profile'));
  app.setPath('userData', path.join(root, 'profile'));
  app.disableHardwareAcceleration();
  const beforeException = process.listeners('uncaughtException');
  const beforeRejection = process.listeners('unhandledRejection');
  const beforeWarning = process.listeners('warning');
  assert.ok(beforeException.length > 0, 'Fixture requires Electron default exception handling');
  const diagnostics = require('../src/main/diagnostics').installDiagnostics({ logDir: path.join(root, 'diagnostics') });
  const handlersPreserved = () => {
    assert.deepEqual(process.listeners('uncaughtException'), beforeException);
    assert.deepEqual(process.listeners('unhandledRejection'), beforeRejection);
    for (const handler of beforeWarning) assert.ok(process.listeners('warning').includes(handler), 'Default warning handlers must be preserved');
    return true;
  };
  handlersPreserved();
  let dialogCalls = 0;
  let finished = false;
  const fail = (error) => {
    if (finished) return;
    finished = true;
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ error: String(error.stack || error) }));
    console.error(error.stack || error);
    app.exit(1);
  };
  // Electron's existing fatal handler resolves this property at call time. Intercept
  // only its display so this synthetic error can never open a user-facing dialog.
  dialog.showErrorBox = (title, message) => {
    dialogCalls++;
    try {
      assert.equal(dialogCalls, 1);
      assert.ok(String(message).includes(FIXTURE_MESSAGE));
      const log = fs.readFileSync(diagnostics.filePath, 'utf8');
      const origin = 'uncaughtException';
      assert.ok(log.includes(FIXTURE_MESSAGE), 'Log must exist when Electron handles the error');
      assert.ok(log.includes(` | ${origin}\n`));
      assert.ok(log.includes(`KonX ${require('../package.json').version} | Electron ${process.versions.electron}`));
      const result = { mode, dialogCalls, logWasSavedSynchronously: true, handlersPreserved: handlersPreserved(),
        origin, electronVersion: process.versions.electron };
      fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result));
      finished = true;
      app.exit(0);
    } catch (error) { fail(error); }
  };
  if (mode === 'reject') {
    process.on('warning', (warning) => {
      if (finished || warning.name !== 'UnhandledPromiseRejectionWarning' || !String(warning.stack).includes(FIXTURE_MESSAGE)) return;
      try {
        const text = fs.readFileSync(diagnostics.filePath, 'utf8');
        assert.equal(dialogCalls, 0, 'A warning-only rejection must not become a fatal error dialog');
        assert.ok(text.includes(FIXTURE_MESSAGE), 'Original rejection evidence must be saved synchronously');
        assert.ok(text.includes('at Immediate.'), 'Original asynchronous stack must be saved');
        assert.ok(text.includes(' | unhandledRejectionWarning\n'));
        const result = { mode, dialogCalls, logWasSavedSynchronously: true, handlersPreserved: handlersPreserved(),
          origin: 'unhandledRejectionWarning', electronVersion: process.versions.electron };
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result));
        finished = true;
        // Let Electron emit its remaining default warning context before ending
        // this deliberately rejected, isolated test process.
        setImmediate(() => app.exit(0));
      } catch (error) { fail(error); }
    });
  }
  // This fixture intentionally leaves Electron's exception/rejection listeners
  // untouched; an observer alone must not suppress the ordinary error path.
  app.whenReady().then(() => {
    setImmediate(() => {
      if (mode === 'throw') throw new Error(FIXTURE_MESSAGE);
      Promise.reject(new Error(FIXTURE_MESSAGE));
    });
  }).catch(fail);
}

module.exports = { runDiagnosticsElectronTests };
if (process.versions.electron && process.argv.includes('--diagnostics-fixture')) electronFixture();
else if (require.main === module) {
  runDiagnosticsElectronTests(async (name, test) => { await test(); console.log('PASS ' + name); })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
