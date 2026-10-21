'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const MAX_LOG_BYTES = 128 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024;
const TEMP_PREFIX = 'konx-diagnostics-test-';

function fixture(run) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, TEMP_PREFIX));
  const disposers = [];
  try {
    return run({ root, disposeLater: (diagnostics) => { disposers.push(diagnostics.dispose); return diagnostics; } });
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent, 'Only the direct test temporary directory may be removed');
    assert.ok(path.basename(target).startsWith(TEMP_PREFIX), 'Temporary directory must have the diagnostics test prefix');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function runDiagnosticsTests(test) {
  const { installDiagnostics } = require('../src/main/diagnostics');

  await test('diagnostics: observes fatal errors synchronously without replacing default process handling', () => fixture(({ root, disposeLater }) => {
    const process = new EventEmitter();
    const existingMonitor = () => {};
    const existingException = () => {};
    const existingRejection = () => {};
    process.on('uncaughtExceptionMonitor', existingMonitor);
    process.on('uncaughtException', existingException);
    process.on('unhandledRejection', existingRejection);
    let exitCalls = 0;
    process.exit = () => { exitCalls++; };
    const stderr = [];
    const logDir = path.join(root, 'logs');
    const diagnostics = disposeLater(installDiagnostics({
      process, logDir, writeStderr: (text) => stderr.push(text), now: () => new Date('2026-10-20T18:23:45.000Z'),
    }));
    assert.equal(diagnostics.filePath, path.join(logDir, 'javascript-errors.log'));
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), 2);
    assert.deepEqual(process.listeners('uncaughtException'), [existingException]);
    assert.deepEqual(process.listeners('unhandledRejection'), [existingRejection]);

    const error = new Error('diagnostics fixture failure');
    error.stack = 'Error: diagnostics fixture failure\n    at fixture (fixture.js:7:3)';
    process.emit('uncaughtExceptionMonitor', error, 'unhandledRejection');
    let content = fs.readFileSync(diagnostics.filePath, 'utf8');
    assert.match(content, /2026-10-20T18:23:45\.000Z/);
    assert.match(content, /unhandledRejection/);
    assert.match(content, /diagnostics fixture failure/);
    assert.match(content, /fixture\.js:7:3/);
    assert.equal(exitCalls, 0, 'The logger must leave termination to the process');

    const startupError = new Error('startup deduplication fixture');
    startupError.stack = 'Error: startup deduplication fixture';
    diagnostics.record(startupError, 'startup');
    const afterStartup = fs.readFileSync(diagnostics.filePath, 'utf8');
    process.emit('uncaughtExceptionMonitor', startupError, 'uncaughtException');
    content = fs.readFileSync(diagnostics.filePath, 'utf8');
    assert.equal(content, afterStartup, 'A module-load error seen again by the monitor must be logged once');
    assert.match(content, /startup deduplication fixture/);

    diagnostics.dispose();
    diagnostics.dispose();
    assert.deepEqual(process.listeners('uncaughtExceptionMonitor'), [existingMonitor]);
    assert.deepEqual(process.listeners('uncaughtException'), [existingException]);
    assert.deepEqual(process.listeners('unhandledRejection'), [existingRejection]);
    process.emit('uncaughtExceptionMonitor', new Error('after dispose'), 'uncaughtException');
    assert.equal(fs.readFileSync(diagnostics.filePath, 'utf8'), content, 'Disposed diagnostics must stop writing');
  }));

  await test('diagnostics: bounds a large Unicode stack by bytes', () => fixture(({ root, disposeLater }) => {
    const process = new EventEmitter();
    const diagnostics = disposeLater(installDiagnostics({ process, logDir: path.join(root, 'logs'), writeStderr: () => {}, now: () => new Date('2026-10-20T00:00:00Z') }));
    const error = new Error('oversize fixture');
    error.stack = 'Error: oversize fixture\n' + '🔒'.repeat(20000) + '\nEND_OF_UNBOUNDED_STACK';
    assert.doesNotThrow(() => process.emit('uncaughtExceptionMonitor', error, 'uncaughtException'));
    const bytes = fs.readFileSync(diagnostics.filePath);
    assert.ok(bytes.length <= MAX_ENTRY_BYTES, `One entry used ${bytes.length} bytes`);
    assert.match(bytes.toString('utf8'), /oversize fixture/);
    assert.ok(!bytes.toString('utf8').includes('END_OF_UNBOUNDED_STACK'));
    assert.ok(!bytes.toString('utf8').includes('\uFFFD'), 'Truncation must not split a UTF-8 sequence');
  }));

  await test('diagnostics: rotates before crossing the log limit and replaces the single previous log', () => fixture(({ root, disposeLater }) => {
    const process = new EventEmitter();
    const logDir = path.join(root, 'logs');
    fs.mkdirSync(logDir);
    const current = path.join(logDir, 'javascript-errors.log');
    const previous = path.join(logDir, 'javascript-errors.previous.log');
    const seed = 'a'.repeat(MAX_LOG_BYTES - 64);
    fs.writeFileSync(current, seed);
    const diagnostics = disposeLater(installDiagnostics({ process, logDir, writeStderr: () => {}, now: () => new Date('2026-10-20T00:00:00Z') }));
    const first = new Error('first rotation ' + 'x'.repeat(1024));
    process.emit('uncaughtExceptionMonitor', first, 'uncaughtException');
    assert.equal(fs.readFileSync(previous, 'utf8'), seed);
    assert.match(fs.readFileSync(current, 'utf8'), /first rotation/);
    assert.ok(fs.statSync(current).size <= MAX_LOG_BYTES);

    const nextSeed = 'b'.repeat(MAX_LOG_BYTES - 64);
    fs.writeFileSync(current, nextSeed);
    process.emit('uncaughtExceptionMonitor', new Error('second rotation ' + 'y'.repeat(1024)), 'uncaughtException');
    assert.equal(fs.readFileSync(previous, 'utf8'), nextSeed);
    assert.match(fs.readFileSync(diagnostics.filePath, 'utf8'), /second rotation/);
    assert.ok(fs.statSync(current).size <= MAX_LOG_BYTES);
    assert.deepEqual(fs.readdirSync(logDir).sort(), ['javascript-errors.log', 'javascript-errors.previous.log']);
  }));

  await test('diagnostics: inaccessible log paths and failed stderr never cause another exception', () => fixture(({ root, disposeLater }) => {
    const process = new EventEmitter();
    const blocker = path.join(root, 'ordinary-file');
    fs.writeFileSync(blocker, 'fixture');
    let fallbackCalls = 0;
    let diagnostics;
    assert.doesNotThrow(() => {
      diagnostics = disposeLater(installDiagnostics({
        process, logDir: path.join(blocker, 'logs'), now: () => new Date('2026-10-20T00:00:00Z'),
        writeStderr: () => { fallbackCalls++; throw new Error('stderr unavailable'); },
      }));
    });
    assert.doesNotThrow(() => process.emit('uncaughtExceptionMonitor', new Error('unwritable fixture'), 'uncaughtException'));
    assert.ok(fallbackCalls > 0, 'A supplied stderr sink should be tried when the file cannot be written');
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'fixture');
    assert.equal(process.listenerCount('uncaughtException'), 0);
    assert.equal(process.listenerCount('unhandledRejection'), 0);
    assert.equal(diagnostics.filePath, path.join(blocker, 'logs', 'javascript-errors.log'));
  }));

  await test('diagnostics: string and non-Error throws are recorded safely', () => fixture(({ root, disposeLater }) => {
    const process = new EventEmitter();
    const diagnostics = disposeLater(installDiagnostics({ process, logDir: path.join(root, 'logs'), writeStderr: () => {}, now: () => new Date('2026-10-20T00:00:00Z') }));
    for (const value of ['string throw fixture', null, 42, { message: 'plain object fixture' }]) {
      assert.doesNotThrow(() => process.emit('uncaughtExceptionMonitor', value, 'uncaughtException'));
    }
    const content = fs.readFileSync(diagnostics.filePath, 'utf8');
    assert.match(content, /string throw fixture/);
    assert.match(content, /42/);
    assert.match(content, /null/);
    assert.match(content, /plain object fixture/);
    assert.equal(process.listenerCount('uncaughtException'), 0);
    assert.equal(process.listenerCount('unhandledRejection'), 0);
  }));

  await test('diagnostics: observes rejection warnings without changing warning listeners or rejection policy', () => fixture(({ root, disposeLater }) => {
    const process = new EventEmitter();
    const seen = [];
    const existingWarning = (warning) => seen.push(warning);
    process.on('warning', existingWarning);
    const diagnostics = disposeLater(installDiagnostics({ process, logDir: path.join(root, 'logs'), writeStderr: () => {}, now: () => new Date('2026-10-20T00:00:00Z') }));
    assert.equal(process.listenerCount('warning'), 2);
    assert.equal(process.listenerCount('unhandledRejection'), 0);

    const unrelated = new Error('unrelated fixture warning');
    unrelated.name = 'DeprecationWarning';
    process.emit('warning', unrelated);
    assert.equal(fs.existsSync(diagnostics.filePath), false, 'Ordinary warnings must not become JavaScript error records');
    const rejection = new Error('rejection warning fixture');
    rejection.name = 'UnhandledPromiseRejectionWarning';
    rejection.stack = 'UnhandledPromiseRejectionWarning: rejection warning fixture\n    at warningFixture (fixture.js:19:4)';
    process.emit('warning', rejection);
    const content = fs.readFileSync(diagnostics.filePath, 'utf8');
    assert.match(content, /unhandledRejectionWarning/);
    assert.match(content, /rejection warning fixture/);
    assert.match(content, /fixture\.js:19:4/);
    assert.ok(!content.includes('unrelated fixture warning'));
    assert.deepEqual(seen, [unrelated, rejection], 'Existing warning observers must still receive every warning');

    diagnostics.dispose();
    assert.deepEqual(process.listeners('warning'), [existingWarning]);
    assert.equal(process.listenerCount('unhandledRejection'), 0);
    const afterDispose = new Error('warning after dispose');
    afterDispose.name = 'UnhandledPromiseRejectionWarning';
    process.emit('warning', afterDispose);
    assert.equal(fs.readFileSync(diagnostics.filePath, 'utf8'), content);
    assert.equal(seen.at(-1), afterDispose);
  }));

  const bootSource = fs.readFileSync(path.join(__dirname, '../src/main/boot.js'), 'utf8');
  const runBoot = ({ profile, argv = [], setupError, mainError } = {}) => {
    const events = [];
    const recorded = [];
    const defaultProfile = path.resolve(__dirname, 'fixture-default-profile');
    const temp = path.resolve(__dirname, 'fixture-temp');
    const process = { argv: ['KonX.exe', ...argv], env: profile === undefined ? {} : { KONX_USERDATA: profile } };
    const app = {
      getPath(name) {
        events.push(['getPath', name]);
        if (name === 'userData') return defaultProfile;
        if (name === 'temp') return temp;
        throw new Error('Unexpected app path request: ' + name);
      },
      setPath(name, value) { events.push(['setPath', name, value]); },
      disableHardwareAcceleration() { events.push(['disableHardwareAcceleration']); },
      exit(code) { events.push(['exit', code]); },
    };
    const requireMock = (name) => {
      if (name === 'path' || name === 'node:path') return path;
      if (name === 'electron') return { app };
      if (name === './diagnostics') return {
        installDiagnostics(options) {
          events.push(['installDiagnostics', options]);
          if (setupError) throw setupError;
          return { record(error, origin) { recorded.push([error, origin]); } };
        },
      };
      if (name === './main') {
        events.push(['main']);
        if (mainError) throw mainError;
        return {};
      }
      if (name === './capture/helper') return {
        run(args, options) {
          events.push(['captureHelper', args]);
          options.exit(7);
        },
      };
      throw new Error('Unexpected boot import: ' + name);
    };
    let thrown;
    try { vm.runInNewContext(bootSource, { process, require: requireMock }, { filename: 'boot.js' }); }
    catch (error) { thrown = error; }
    return { events, recorded, thrown, defaultProfile, temp, process };
  };

  await test('diagnostics: boot configures an absolute profile override before loading the application', () => {
    const profile = path.resolve(__dirname, 'fixture override profile');
    const result = runBoot({ profile });
    assert.equal(result.thrown, undefined);
    assert.deepEqual(result.events.map(([name]) => name), ['installDiagnostics', 'main']);
    assert.equal(result.events[0][1].logDir, path.join(profile, 'diagnostics'));
    assert.deepEqual(result.recorded, []);
  });

  await test('diagnostics: boot resolves the normal user profile and rejects a relative override', () => {
    for (const profile of [undefined, 'relative-profile']) {
      const result = runBoot({ profile });
      assert.equal(result.thrown, undefined);
      assert.deepEqual(result.events.map(([name]) => name), ['getPath', 'installDiagnostics', 'main']);
      assert.equal(result.events[0][1], 'userData');
      assert.equal(result.events[1][1].logDir, path.join(result.defaultProfile, 'diagnostics'));
    }
  });

  await test('diagnostics: boot records and rethrows the original startup failure', () => {
    const error = new Error('module load fixture failure');
    const result = runBoot({ mainError: error });
    assert.equal(result.thrown, error);
    assert.equal(result.recorded.length, 1);
    assert.equal(result.recorded[0][0], error);
    assert.equal(result.recorded[0][1], 'startup');
  });

  await test('diagnostics: failed setup does not block normal application startup or replace its error', () => {
    const setupError = new Error('diagnostics setup fixture failure');
    const successful = runBoot({ setupError });
    assert.equal(successful.thrown, undefined);
    assert.equal(successful.events.at(-1)[0], 'main');
    const mainError = new Error('main fixture failure after failed diagnostic setup');
    const failed = runBoot({ setupError, mainError });
    assert.equal(failed.thrown, mainError);
    assert.deepEqual(failed.recorded, []);
  });

  await test('diagnostics: capture helper keeps its separate temporary profile without installing normal diagnostics', () => {
    const result = runBoot({ profile: path.resolve(__dirname, 'unused-normal-profile'), argv: ['--konx-capture-helper', '--fixture'] });
    assert.equal(result.thrown, undefined);
    assert.deepEqual(result.events.map(([name]) => name), ['disableHardwareAcceleration', 'getPath', 'setPath', 'captureHelper', 'exit']);
    assert.deepEqual(result.events[1], ['getPath', 'temp']);
    assert.deepEqual(result.events[2], ['setPath', 'userData', path.join(result.temp, 'konx-capture-helper')]);
    assert.equal(result.events[3][1], result.process.argv);
    assert.deepEqual(result.events[4], ['exit', 7]);
    assert.deepEqual(result.recorded, []);
  });
}

module.exports = { runDiagnosticsTests };
