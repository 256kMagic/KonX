'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { SerialPortStream } = require('@serialport/stream');
const { MockBinding } = require('@serialport/binding-mock');
const root = process.env.KONX_TEST_ASAR || path.join(__dirname, '..');
const { SerialConnection, serialAvailable } = require(path.join(root, 'src/main/serial'));
const { BAUD_RATES, MAX_SAMPLE_BYTES, scoreSample } = require(path.join(root, 'src/main/serial-autobaud'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, label) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(2); }
}

// Actual SerialPortStream parsing, read/write queues and callback behavior,
// backed by an owned synthetic binding. No hardware ports are listed or opened.
function fixture(config = {}, opts = {}) {
  MockBinding.reset();
  MockBinding.createPort('/konx-owned-autobaud', { record: true, maxReadSize: 37 });
  const native = [], timers = new Set(), updates = [], writes = [], visits = new Map(), errors = [], progress = [], output = [];
  let opens = 0, closes = 0, flushes = 0, sets = 0;
  function schedule(binding) {
    const rate = binding.testRate, visit = visits.get(rate) || 0;
    const sample = config.sample ? config.sample(rate, visit) : rate === 115200 ? (visit === 1 ? 'Switch#\r\n' : '\x1b[32mSwitch#\x1b[0m\r\n') : Buffer.from([0xff, 0x00, 0x81]);
    if (sample == null) return;
    const chunks = Array.isArray(sample) ? sample : [sample];
    chunks.forEach((chunk, index) => {
      const timer = setTimeout(() => { timers.delete(timer); if (binding.isOpen) binding.emitData(chunk); }, 3 + index * 2);
      timers.add(timer);
    });
  }
  const binding = {
    list: async () => { throw new Error('Tests must not enumerate ports'); },
    async open(options) {
      opens++;
      if (config.openGate) await config.openGate.promise;
      if (config.openError) throw new Error('Owned open failure');
      const port = await MockBinding.open(options); port.testRate = options.baudRate; native.push(port);
      const original = Object.fromEntries(['update', 'write', 'flush', 'close', 'set'].map(name => [name, port[name].bind(port)]));
      port.update = async options => {
        updates.push(options.baudRate);
        if (config.updateGate && updates.length === 1) await config.updateGate.promise;
        if (options.baudRate === config.unsupported) throw Object.assign(new Error('Unsupported baud rate'), { code: 'EINVAL' });
        if (options.baudRate === config.unsupportedWindows) throw new Error('Update (SetCommState): The parameter is incorrect');
        if (config.updateError) throw new Error(typeof config.updateError === 'string' ? config.updateError : 'Owned update failure');
        await original.update(options);
        port.testRate = options.baudRate;
      };
      port.flush = async () => {
        flushes++;
        if (config.flushError) throw new Error('Owned flush failure');
        await original.flush();
        const rate = port.testRate; visits.set(rate, (visits.get(rate) || 0) + 1);
        if (opts.serialAutoBaudProbe !== true) schedule(port);
      };
      port.write = async bytes => {
        writes.push(Buffer.from(bytes));
        if (config.writeError) throw new Error('Owned write failure');
        await original.write(bytes);
        if (opts.serialAutoBaudProbe === true) schedule(port);
      };
      port.close = async () => {
        closes++;
        if (config.closeFailOnce && closes === 1) throw new Error('Owned close failure');
        await original.close();
      };
      port.set = async values => { sets++; await original.set(values); };
      return port;
    },
  };
  class Port extends SerialPortStream { constructor(options) { super({ ...options, binding }); } }
  const connection = new SerialConnection({ serialPort: '/konx-owned-autobaud', baudRate: 'auto', ...opts },
    { SerialPort: Port, timing: { settleMs: 2, sampleMs: 18, confirmationMs: 24, operationMs: config.operationMs || 300 } });
  connection.on('error', error => errors.push(error));
  connection.on('data', bytes => output.push(Buffer.from(bytes)));
  connection.on('baud-detect', event => progress.push(event));
  return { connection, native, updates, writes, visits, errors, progress, output,
    get opens() { return opens; }, get closes() { return closes; }, get flushes() { return flushes; }, get sets() { return sets; },
    async cleanup() {
      config.openGate?.resolve(); config.updateGate?.resolve(); connection.close();
      await until(() => !connection.hasOwnership, 'owned serial cleanup');
      for (const timer of timers) clearTimeout(timer); timers.clear();
      assert.ok(native.every(port => !port.isOpen));
    } };
}

async function withFixture(config, opts, work) {
  const value = fixture(config, opts);
  try { await work(value); } finally { await value.cleanup(); }
}

async function runSerialAutoBaudTests(test) {
  await test('serial sample scoring accepts short and ANSI prompts, rejects malformed/binary/insufficient samples', () => {
    for (const text of ['Switch#', 'R1(config)#', 'Username: ', '\x1b[32mRouter>\x1b[0m\r\n', 'Cisco IOS Software, Version 15.2\r\nSystem initialization is complete and the console is ready.\r\n']) assert.equal(scoreSample(Buffer.from(text)).plausible, true, text);
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xfe]), Buffer.from('hello\0there'), Buffer.from('???'), Buffer.from('\r'), Buffer.from('a'), Buffer.alloc(MAX_SAMPLE_BYTES + 1, 65)]) assert.equal(scoreSample(bytes).plausible, false);
    assert.equal(serialAvailable(), true, 'installed optional serial module must load in this runtime');
  });
  await test('serial auto baud scans one owned stream, preserves framing and releases only fresh confirmed bytes', () => withFixture({},
    { dataBits: 7, stopBits: 2, parity: 'even', flowControl: 'xonxoff' }, async f => {
      await f.connection.connect();
      assert.equal(f.opens, 1); assert.equal(f.connection.state, 'connected'); assert.equal(f.connection.baudRate, 115200);
      assert.equal(f.connection.autoBaud.confidence, 'likely'); assert.equal(f.connection.autoBaud.confirmed, true);
      assert.equal(f.connection.autoBaud.candidatesTested, BAUD_RATES.length);
      assert.deepEqual(f.progress.filter(p => p.phase === 'sampling').map(p => p.baudRate), BAUD_RATES);
      assert.equal(f.progress.at(-1).phase, 'complete'); assert.equal(f.writes.length, 0);
      assert.equal(Buffer.concat(f.output).toString(), '\x1b[32mSwitch#\x1b[0m\r\n');
      const settings = f.native[0].openOptions;
      assert.equal(settings.dataBits, 7); assert.equal(settings.stopBits, 2); assert.equal(settings.parity, 'even'); assert.equal(settings.xon, true); assert.equal(settings.xoff, true); assert.equal(settings.rtscts, false);
    }));
  await test('serial explicit probing sends one CR per window and suppresses ordinary writes and BREAK during detection', () => withFixture({},
    { serialAutoBaudProbe: true }, async f => {
      f.connection.on('baud-detect', event => { if (event.phase !== 'complete') { f.connection.write('unexpected login\r'); f.connection.sendBreak(); } });
      await f.connection.connect();
      assert.equal(f.writes.length, BAUD_RATES.length + 1); assert.ok(f.writes.every(bytes => bytes.equals(Buffer.from('\r')))); assert.equal(f.sets, 0);
      f.connection.write('show version\r'); await until(() => f.writes.length === BAUD_RATES.length + 2, 'ready user write');
    }));
  for (const [name, sample, message] of [
    ['silent', () => null, /no serial output/],
    ['binary', () => Buffer.from([0xff, 0x00, 0x80]), /could not identify readable/],
    ['ambiguous', rate => rate === 115200 ? 'Switch#' : rate === 9600 ? 'Cisco IOS Software, Version 15.2\r\nSystem initialization is complete and the console is ready.\r\n' : null, /ambiguous.*9600, 115200/],
    ['overflowing', () => Buffer.from('Switch#\r\n'.repeat(MAX_SAMPLE_BYTES)), /could not identify readable/],
    ['failed fresh confirmation', (rate, visit) => rate === 115200 && visit === 1 ? 'Switch#' : null, /could not confirm/],
  ]) await test(`serial ${name} auto detection fails actionably without exposing sampled bytes`, () => withFixture({ sample }, {}, async f => {
    await assert.rejects(f.connection.connect(), message); await until(() => !f.connection.hasOwnership, 'failed detection closes native port');
    assert.equal(f.output.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.connection.baudRate, null);
  }));
  await test('serial unsupported rates are skipped once while other rates and confirmation remain eligible', () => withFixture({ unsupported: 921600 }, {}, async f => {
    await f.connection.connect(); assert.equal(f.connection.baudRate, 115200);
    assert.equal(f.progress.filter(p => p.phase === 'unsupported').length, 1); assert.equal(f.updates.filter(rate => rate === 921600).length, 1);
  }));
  await test('serial Windows SetCommState unsupported-rate message skips only that rate', () => withFixture({ unsupportedWindows: 921600 }, {}, async f => {
    await f.connection.connect(); assert.equal(f.connection.baudRate, 115200);
    assert.equal(f.progress.filter(p => p.phase === 'unsupported').length, 1);
  }));
  await test('serial Windows invalid-handle and access-denied update failures remain fatal', async () => {
    for (const updateError of ['Update (SetCommState): Invalid handle', 'Update (SetCommState): Access denied']) await withFixture({ updateError }, {}, async f => {
      await assert.rejects(f.connection.connect(), error => error.message === updateError);
      assert.equal(f.progress.filter(p => p.phase === 'unsupported').length, 0);
    });
  });
  await test('serial fragmented UTF-8 and ANSI samples are scored together and confirmed bytes stay unchanged', async () => {
    const bytes = Buffer.from('\x1b[32mSwitch#\x1b[0m\r\nNative café 😀\r\n');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    await withFixture({ sample: rate => rate === 115200 ? [bytes.subarray(0, split), bytes.subarray(split)] : null }, {}, async f => {
      await f.connection.connect(); assert.ok(Buffer.concat(f.output).equals(bytes));
    });
  });
  for (const [setting, message, opts] of [['openError', /Owned open failure/, {}], ['updateError', /Owned update failure/, {}], ['flushError', /Owned flush failure/, {}], ['writeError', /Owned write failure/, { serialAutoBaudProbe: true }]]) {
    await test(`serial ${setting} rejects pending connect and closes owned transport`, () => withFixture({ [setting]: true }, opts, async f => {
      await assert.rejects(f.connection.connect(), message); await until(() => !f.connection.hasOwnership, 'failed callback closes'); assert.equal(f.output.length, 0);
    }));
  }
  await test('serial manual rates and default retain numeric settings without detection or probe', async () => {
    for (const value of [undefined, '', 9600, '115200', 230400]) await withFixture({}, { baudRate: value, serialAutoBaudProbe: true }, async f => {
      await f.connection.connect(); assert.equal(f.connection.baudRate, value === '' || value === undefined ? 9600 : Number(value));
      assert.equal(f.connection.autoBaud, null); assert.equal(f.updates.length, 0); assert.equal(f.flushes, 0); assert.equal(f.writes.length, 0); assert.equal(f.progress.length, 0);
      f.native[0].emitData('manual output'); await until(() => f.output.length, 'manual incoming bytes'); assert.equal(Buffer.concat(f.output).toString(), 'manual output');
    });
  });
  await test('serial malformed fixed rates reject before opening a port', async () => {
    for (const baudRate of [null, 'AUTO', 'invalid', '9600junk', '0x2580', -1, 0, Infinity, NaN, 9600.5, {}, 9007199254740992]) await withFixture({}, { baudRate }, async f => {
      await assert.rejects(f.connection.connect(), /positive whole number/); assert.equal(f.opens, 0);
    });
  });
  await test('serial cancellation before connect never opens a native port', () => withFixture({}, {}, async f => {
    f.connection.close(); await assert.rejects(f.connection.connect(), { name: 'AbortError' }); assert.equal(f.opens, 0);
  }));
  await test('serial cancellation during pending native open closes the late-opened binding', () => withFixture({ openGate: deferred() }, {}, async f => {
    const pending = f.connection.connect(), rejected = assert.rejects(pending, { name: 'AbortError' });
    await until(() => f.opens === 1, 'open pending'); f.connection.close(); await rejected;
    assert.equal(f.connection.hasOwnership, true); assert.equal(f.connection.baudRate, null);
    // cleanup releases the gate; this tests the actual late binding callback.
  }));
  await test('serial cancellation during native update cannot accept its late callback', () => {
    const gate = deferred();
    return withFixture({ updateGate: gate }, {}, async f => {
      const pending = f.connection.connect(), rejected = assert.rejects(pending, { name: 'AbortError' });
      await until(() => f.updates.length === 1, 'update pending'); f.connection.close(); await rejected;
      gate.resolve(); await sleep(5); assert.equal(f.connection.baudRate, null); assert.equal(f.output.length, 0);
    });
  });
  for (const phase of ['sampling', 'confirming']) await test(`serial cancellation during ${phase} clears timers and suppresses samples`, () => withFixture({}, {}, async f => {
    const pending = f.connection.connect(), rejected = assert.rejects(pending, { name: 'AbortError' });
    await until(() => f.progress.at(-1)?.phase === phase && !!f.connection.sampleWindow, phase);
    f.connection.close(); await rejected; assert.equal(f.connection.sampleWindow, null); assert.equal(f.output.length, 0);
  }));
  await test('serial cancellation at final detection notification never resolves ready or releases confirmed bytes', () => withFixture({}, {}, async f => {
    f.connection.on('baud-detect', event => { if (event.phase === 'complete') f.connection.close(); });
    await assert.rejects(f.connection.connect(), { name: 'AbortError' }); assert.equal(f.output.length, 0);
    await until(() => !f.connection.hasOwnership, 'cancelled confirmation cleanup'); assert.equal(f.connection.state, 'closed');
  }));
  await test('serial native open timeout retains ownership and closes a late successful open', () => withFixture({ openGate: deferred(), operationMs: 15 }, {}, async f => {
    await assert.rejects(f.connection.connect(), /open timed out/); assert.equal(f.connection.hasOwnership, true); assert.equal(f.connection.baudRate, null);
  }));
  await test('serial close failure retains owner and explicit retry completes without an unhandled error', () => withFixture({ closeFailOnce: true }, { baudRate: 9600 }, async f => {
    await f.connection.connect(); let closed = 0; f.connection.on('close', () => closed++);
    f.connection.sendBreak(); await until(() => !!f.connection.breakTimer, 'manual BREAK active');
    f.connection.close(); await until(() => !!f.connection.cleanupError, 'close failure observed');
    assert.equal(f.connection.hasOwnership, true); assert.equal(closed, 0); assert.match(f.connection.cleanupError.message, /Owned close failure/);
    assert.equal(f.sets, 2, 'failed close still releases an active manual BREAK');
    f.connection.close(); await until(() => !f.connection.hasOwnership, 'close retry'); assert.equal(closed, 1); assert.equal(f.closes, 2);
    await assert.rejects(f.connection.connect(), { name: 'AbortError' });
  }));
  await test('serial runtime error disconnects established stream and late data remains suppressed', () => withFixture({}, { baudRate: 9600 }, async f => {
    await f.connection.connect(); f.connection.port.emit('error', new Error('Owned runtime error')); await until(() => !f.connection.hasOwnership, 'runtime error cleanup');
    f.connection.port.emit('data', Buffer.from('late bytes')); assert.equal(f.output.length, 0); assert.equal(f.errors.length, 1);
  }));
}

module.exports = { runSerialAutoBaudTests };
if (require.main === module) runSerialAutoBaudTests(async (name, test) => { await test(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
