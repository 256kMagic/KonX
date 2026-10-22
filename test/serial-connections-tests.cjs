'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const artifactRoot = process.env.KONX_TEST_ASAR || path.resolve(__dirname, '..');
const { ConnectionManager } = require(path.join(artifactRoot, 'src/main/connections'));
const tick = () => new Promise(setImmediate);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const session = { protocol: 'serial', serialPort: 'SYNTHETIC-PORT', baudRate: 'auto' };

// Exercise the production connection manager through its serial boundary. The
// separately tested native serial transport owns opening, sampling and closing
// physical ports; these controllable peers model its asynchronous lifecycle.
function harness({ cancelRejects = true, closeAcknowledges = true } = {}) {
  const transports = [], events = [];
  class SerialPeer extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.writes = [];
      this.breaks = 0;
      this.closes = 0;
      transports.push(this);
    }
    connect() {
      for (const event of ['data', 'error', 'close', 'baud-detect']) assert.ok(this.listenerCount(event), event + ' listener precedes native open');
      return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    }
    ready(rate, auto = true) {
      this.baudRate = rate;
      if (auto) this.autoBaud = { method: 'heuristic', baudRate: rate, probe: this.options.serialAutoBaudProbe === true, candidatesTested: 3, score: 0.98, confirmed: true };
      this.resolve();
    }
    progress(phase, rate = 9600) {
      this.emit('baud-detect', { phase, baudRate: rate, index: 1, total: 11, message: `${phase} ${rate} baud` });
    }
    write(data) { this.writes.push(Buffer.from(data)); }
    sendBreak() { this.breaks++; }
    close() {
      this.closes++;
      if (cancelRejects) this.reject(Object.assign(new Error('Serial connection cancelled'), { name: 'AbortError' }));
      if (closeAcknowledges) this.emit('close');
    }
  }
  const manager = new ConnectionManager({ SerialConnection: SerialPeer, store: {}, emit: (...args) => events.push(args), defaultLogDir: () => { throw new Error('No fixture should open a log before ready'); } });
  const statuses = () => events.filter(([channel]) => channel === 'conn:status').map(([, , status]) => status);
  return { manager, transports, events, statuses };
}

async function runSerialConnectionsTests(test) {
  await test('Serial manager keeps auto detection connecting, blocks input and logon, then reports the confirmed rate without overwriting Auto', async () => {
    const h = harness();
    const spec = { ...session, serialAutoBaudProbe: true, logonActions: [{ send: 'show clock' }] };
    try {
      const opening = h.manager.open('console', spec);
      const peer = h.transports[0];
      for (const phase of ['sampling', 'confirming']) peer.progress(phase, 115200);
      h.manager.write('console', 'unsafe input\r');
      h.manager.write('console', '\x03', true);
      h.manager.sendBreak('console');
      assert.equal(h.manager.startLog('console'), null);
      await pause(230);
      assert.equal(h.manager.conns.size, 1, 'pending detection still blocks update installation');
      assert.deepEqual(peer.writes, []);
      assert.equal(peer.breaks, 0);
      assert.equal(h.statuses().some(status => status.state === 'connected'), false);
      assert.deepEqual(h.statuses().at(-1), { state: 'connecting', message: 'confirming 115200 baud', baudDetect: { phase: 'confirming', baudRate: 115200, index: 1, total: 11, message: 'confirming 115200 baud' } });
      assert.equal(peer.options.serialAutoBaudProbe, true);
      peer.progress('complete', 115200);
      peer.ready(115200);
      peer.emit('data', Buffer.from('CONFIRMED SAMPLE BEFORE AWAIT'));
      const result = await opening;
      assert.equal(result.ok, true);
      assert.equal(result.info.baudRate, 115200);
      assert.deepEqual(result.info.autoBaud, peer.autoBaud);
      assert.equal(result.info.autoBaud.confirmed, true);
      assert.equal(h.manager.conns.get('console').session.baudRate, 'auto');
      assert.equal(spec.baudRate, 'auto');
      await pause(230);
      assert.ok(h.events.some(([channel, , bytes]) => channel === 'conn:data' && bytes.toString() === 'CONFIRMED SAMPLE BEFORE AWAIT'));
      assert.deepEqual(peer.writes.map(bytes => bytes.toString()), ['show clock\r']);
      h.manager.write('console', 'show version\r'); h.manager.sendBreak('console');
      assert.equal(peer.writes.at(-1).toString(), 'show version\r');
      assert.equal(peer.breaks, 1);
      const count = h.events.length;
      peer.progress('sampling');
      assert.equal(h.events.length, count, 'late detection progress cannot regress a ready session');
    } finally { h.manager.closeAll(); }
  });

  await test('Serial manager closes a failed detection transport and emits one disconnected status even with reentrant close', async () => {
    const h = harness();
    try {
      const opening = h.manager.open('console', session);
      const peer = h.transports[0];
      peer.progress('sampling');
      peer.reject(new Error('No confident baud rate detected; choose a rate manually.'));
      const result = await opening;
      assert.equal(result.ok, false);
      assert.match(result.error, /No confident baud rate/);
      assert.equal(peer.closes, 1, 'failed connect still owns transport shutdown');
      assert.equal(h.manager.conns.size, 0);
      assert.deepEqual(h.statuses().map(status => status.state), ['connecting', 'connecting', 'disconnected']);
      const count = h.events.length;
      peer.progress('complete'); peer.emit('data', Buffer.from('late')); peer.emit('error', new Error('late native error')); peer.emit('close');
      await tick();
      assert.equal(h.events.length, count);
    } finally { h.manager.closeAll(); }
  });

  await test('Serial manager cancellation during pending native open closes once and never becomes connected', async () => {
    const h = harness();
    try {
      const opening = h.manager.open('console', session);
      const peer = h.transports[0];
      h.manager.close('console'); h.manager.close('console');
      assert.equal((await opening).ok, false);
      assert.equal(peer.closes, 1);
      assert.equal(h.manager.conns.size, 0);
      assert.deepEqual(h.statuses().map(status => status.state), ['connecting', 'disconnected']);
      const count = h.events.length;
      peer.ready(9600); peer.progress('complete'); peer.emit('close');
      h.manager.write('console', 'late'); h.manager.sendBreak('console');
      await tick();
      assert.equal(h.events.length, count);
      assert.deepEqual(peer.writes, []);
      assert.equal(peer.breaks, 0);
    } finally { h.manager.closeAll(); }
  });

  await test('Serial manager preserves actionable detection failures when native cleanup closes before rejecting', async () => {
    for (const message of ['No readable serial data; choose a baud rate manually.', 'Ambiguous serial baud rate; choose a rate manually.']) {
      const h = harness();
      try {
        const opening = h.manager.open('console', session);
        const peer = h.transports[0];
        peer.emit('close');
        assert.equal(h.manager.conns.size, 1, 'native cleanup does not discard the pending detection outcome');
        peer.reject(new Error(message));
        const result = await opening;
        assert.equal(result.ok, false);
        assert.equal(result.error, message);
        assert.equal(h.manager.conns.size, 0);
        assert.equal(peer.closes, 1);
        assert.deepEqual(h.statuses().map(status => status.state), ['connecting', 'disconnected']);
        assert.equal(h.statuses().at(-1).message, 'Connection failed: ' + message);
        assert.ok(h.events.some(([channel, , bytes]) => channel === 'conn:data' && bytes.toString().includes(message)));
      } finally { h.manager.closeAll(); }
    }
  });

  await test('Serial manager rejects a port closed between ready resolution and the manager continuation', async () => {
    const h = harness();
    try {
      const opening = h.manager.open('console', session);
      const peer = h.transports[0];
      peer.ready(9600); peer.emit('close');
      const result = await opening;
      assert.equal(result.ok, false);
      assert.match(result.error, /Serial port closed before/);
      assert.equal(h.manager.conns.size, 0);
      assert.equal(h.statuses().some(status => status.state === 'connected'), false);
    } finally { h.manager.closeAll(); }
  });

  await test('Serial manager replacement rejects late completion and never flushes old data into the new same-id console', async () => {
    const h = harness({ cancelRejects: false });
    try {
      const oldOpening = h.manager.open('console', session);
      const old = h.transports[0];
      old.emit('data', Buffer.from('OLD BUFFERED DATA'));
      const newOpening = h.manager.open('console', { ...session, serialPort: 'SECOND-SYNTHETIC-PORT' });
      const replacement = h.transports[1];
      const afterReplacementStarts = h.events.length;
      old.progress('complete', 9600); old.emit('error', new Error('old error')); old.emit('data', Buffer.from('OLD LATE DATA')); old.emit('close'); old.ready(9600);
      replacement.progress('confirming', 19200); replacement.ready(19200);
      assert.equal((await oldOpening).ok, false);
      assert.equal((await newOpening).ok, true);
      replacement.emit('data', Buffer.from('NEW DATA'));
      await tick();
      assert.equal(old.closes, 1);
      assert.equal(replacement.closes, 0);
      assert.equal(h.manager.info('console').baudRate, 19200);
      const later = h.events.slice(afterReplacementStarts);
      assert.equal(later.some(([channel, , status]) => channel === 'conn:status' && status.state === 'disconnected'), false);
      assert.equal(later.some(([channel, , bytes]) => channel === 'conn:data' && bytes.toString().includes('OLD')), false);
      assert.equal(later.some(([channel, , bytes]) => channel === 'conn:data' && bytes.toString() === 'NEW DATA'), true);
      const before = h.events.slice(0, afterReplacementStarts);
      const oldData = before.findIndex(([channel, , bytes]) => channel === 'conn:data' && bytes.toString() === 'OLD BUFFERED DATA');
      const oldDisconnected = before.findIndex(([channel, , status]) => channel === 'conn:status' && status.state === 'disconnected');
      assert.equal(oldData, -1, 'cancelled startup output is discarded before the console becomes ready');
      assert.ok(oldDisconnected >= 0);
    } finally { h.manager.closeAll(); }
  });

  await test('Serial manager fixed baud metadata stays numeric and disconnect flushes final data exactly once', async () => {
    const h = harness();
    try {
      const opening = h.manager.open('console', { ...session, baudRate: '38400' });
      const peer = h.transports[0];
      peer.ready(38400, false);
      const result = await opening;
      assert.equal(result.ok, true);
      assert.equal(result.info.baudRate, 38400);
      assert.equal(Object.hasOwn(result.info, 'autoBaud'), false);
      peer.emit('data', Buffer.from('FINAL SERIAL DATA'));
      peer.emit('close');
      await tick();
      assert.equal(peer.closes, 1);
      assert.equal(h.manager.conns.size, 0);
      assert.equal(h.events.filter(([channel, , bytes]) => channel === 'conn:data' && bytes.toString() === 'FINAL SERIAL DATA').length, 1);
      assert.equal(h.statuses().filter(status => status.state === 'disconnected').length, 1);
    } finally { h.manager.closeAll(); }
  });

  await test('Serial manager retains a failed native close after tab removal, times out honestly and retries cleanup', async () => {
    const h = harness({ closeAcknowledges: false });
    const opening = h.manager.open('console', session), peer = h.transports[0];
    peer.ready(9600); await opening;
    peer.cleanupError = new Error('Synthetic driver close failure');
    h.manager.close('console');
    assert.equal(h.manager.conns.size, 0);
    assert.equal(h.manager.hasSerialOwnership, true);
    await assert.rejects(h.manager.waitForSerialCleanup(15), { code: 'SERIAL_CLEANUP_PENDING' });
    assert.equal(h.manager.hasSerialOwnership, true, 'timeout does not release a still-owned native handle');
    assert.equal(h.manager.serialCleanupWaiters.size, 0, 'timed-out waiter does not remain subscribed');
    const beforeRetry = peer.closes;
    h.manager.closeAll();
    assert.equal(peer.closes, beforeRetry + 1, 'closeAll retries a detached transport');
    const cleanup = h.manager.waitForSerialCleanup(1000);
    await tick();
    assert.equal(h.manager.hasSerialOwnership, true);
    peer.cleanupError = null; peer.emit('close');
    await cleanup;
    assert.equal(h.manager.hasSerialOwnership, false);
    assert.equal(h.manager.serialCleanupWaiters.size, 0);
    assert.equal(h.statuses().filter(status => status.state === 'disconnected').length, 1);
  });

  await test('Serial manager waits for every cancelled pending native open and its late close acknowledgement', async () => {
    const h = harness({ closeAcknowledges: false });
    const attempts = [h.manager.open('first', session), h.manager.open('second', session)];
    h.manager.closeAll();
    assert.equal((await Promise.all(attempts)).every(result => !result.ok), true);
    assert.equal(h.manager.conns.size, 0);
    assert.equal(h.manager.serialOwners.size, 2);
    const cleanup = h.manager.waitForSerialCleanup(1000);
    let complete = false; cleanup.then(() => { complete = true; });
    h.transports[0].ready(9600); h.transports[0].emit('close');
    await tick();
    assert.equal(complete, false);
    assert.equal(h.manager.serialOwners.size, 1);
    h.transports[1].ready(115200); h.transports[1].emit('close');
    await cleanup;
    assert.equal(h.manager.hasSerialOwnership, false);
    assert.equal(h.statuses().some(status => status.state === 'connected'), false);
  });

  await test('Serial manager replays Auto and fixed-rate startup prompts once to logging, logon actions and console in arrival order', async () => {
    const parent = fs.realpathSync(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(parent, 'konx-serial-startup-'));
    try {
      for (const baudRate of ['auto', 38400]) {
        const h = harness(), file = path.join(directory, String(baudRate) + '.txt');
        try {
          const opening = h.manager.open('console', { ...session, baudRate, logging: { enabled: true, path: file }, logonActions: [{ expect: 'login:', send: 'synthetic-user' }] });
          const peer = h.transports[0];
          const write = peer.write.bind(peer);
          peer.write = bytes => { write(bytes); peer.emit('data', Buffer.from('\r\naccepted\r\n')); };
          peer.emit('data', Buffer.from('Router lo')); peer.emit('data', Buffer.from('gin:'));
          assert.deepEqual(peer.writes, []);
          assert.equal(fs.existsSync(file), false, 'logging starts only once the connection is ready');
          peer.ready(baudRate === 'auto' ? 115200 : baudRate, baudRate === 'auto');
          assert.equal((await opening).ok, true);
          await tick();
          assert.deepEqual(peer.writes.map(bytes => bytes.toString()), ['synthetic-user\r']);
          const output = h.events.filter(([channel, , bytes]) => channel === 'conn:data' && !bytes.toString().startsWith('\x1b[')).map(([, , bytes]) => bytes);
          assert.equal(Buffer.concat(output).toString(), 'Router login:\r\naccepted\r\n');
          const stream = h.manager.conns.get('console').logger.stream;
          const closed = new Promise(resolve => stream.once('close', resolve));
          h.manager.close('console'); await closed;
          const log = fs.readFileSync(file, 'utf8');
          assert.equal(log.split('Router login:').length, 2);
          assert.equal(log.split('accepted').length, 2);
          assert.ok(log.includes('Router login:\naccepted\n'));
        } finally { h.manager.closeAll(); }
      }
    } finally {
      assert.equal(path.dirname(fs.realpathSync(directory)), parent);
      assert.ok(path.basename(directory).startsWith('konx-serial-startup-'));
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await test('Serial manager bounds startup output and fails explicitly without connecting or leaking buffered bytes', async () => {
    const h = harness();
    try {
      const opening = h.manager.open('console', session), peer = h.transports[0];
      peer.emit('data', Buffer.alloc(64 * 1024, 65));
      peer.emit('data', Buffer.from('overflow'));
      const result = await opening;
      assert.equal(result.ok, false);
      assert.match(result.error, /Serial startup output exceeded 64 KiB/);
      assert.equal(h.manager.conns.size, 0);
      assert.equal(h.manager.hasSerialOwnership, false);
      assert.equal(peer.closes, 1);
      await tick();
      assert.equal(h.statuses().some(status => status.state === 'connected'), false);
      assert.equal(h.events.some(([channel, , bytes]) => channel === 'conn:data' && bytes.length >= 64 * 1024), false);
    } finally { h.manager.closeAll(); }
  });
}

module.exports = { runSerialConnectionsTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runSerialConnectionsTests(async (name, fn) => {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name, error); }
  });
  console.log(`${passed}/${passed + failed} serial connection manager tests passed`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
