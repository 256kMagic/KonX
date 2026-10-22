'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const artifactRoot = process.env.KONX_TEST_ASAR || path.resolve(__dirname, '..');
const { ConnectionManager } = require(path.join(artifactRoot, 'src/main/connections'));
const tick = () => new Promise(setImmediate);
const closed = stream => new Promise(resolve => stream.once('close', resolve));

async function withConsole(run) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'konx-console-logging-'));
  const peers = new Set(), events = [];
  const server = net.createServer(socket => { peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  const manager = new ConnectionManager({ store: {}, emit: (...args) => events.push(args), defaultLogDir: () => directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const open = (id, extra = {}) => manager.open(id, { protocol: 'raw', name: 'same console', host: '127.0.0.1', port: server.address().port, ...extra });
  const send = async (id, value) => {
    const data = Buffer.from(value), transport = manager.conns.get(id).telnet;
    const peer = [...peers].find(socket => socket.remotePort === transport.sock.localPort);
    assert.ok(peer, 'the real TCP console peer must be connected');
    await new Promise((resolve, reject) => {
      let received = 0;
      const cleanup = () => { clearTimeout(timer); transport.removeListener('data', onData); };
      const onData = chunk => { received += chunk.length; if (received >= data.length) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Console data did not reach the real connection')); }, 5000);
      transport.on('data', onData); peer.write(data);
    });
  };
  try { await run({ manager, events, directory, open, send }); }
  finally {
    const closing = [...manager.conns.values()].filter(c => c.logger).map(c => closed(c.logger.stream));
    manager.closeAll();
    for (const peer of peers) peer.destroy();
    await Promise.all(closing);
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    assert.ok(path.basename(directory).startsWith('konx-console-logging-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runTerminalLoggingTests(test) {
  await test('Console logging: one API click opens a real text file only for a connected console and stop excludes later output', () => withConsole(async ({ manager, events, open, send }) => {
    const opening = open('manual');
    assert.equal(manager.startLog('manual'), null);
    assert.equal(events.some(([name, , status]) => name === 'conn:status' && status.state === 'connected'), false);
    assert.equal((await opening).ok, true);
    assert.equal(manager.info('manual').logging, null);
    const file = manager.startLog('manual');
    assert.equal(path.extname(file), '.txt');
    assert.equal(fs.statSync(file).isFile(), true, 'file open is verified before active state is returned');
    assert.equal(manager.info('manual').logging, file);
    assert.equal(manager.startLog('manual'), file, 'repeated start is idempotent');
    await send('manual', '\x1b['); await send('manual', '31mRED');
    for (const byte of Buffer.from('π😀')) await send('manual', Buffer.from([byte]));
    for (const chunk of ['\x1b[0m\r', '\n\x1b]0;hidden title', '\x1b', '\\NEXT\r\n']) await send('manual', chunk);
    const stream = manager.conns.get('manual').logger.stream, finished = closed(stream);
    manager.stopLog('manual');
    assert.equal(manager.info('manual').logging, null);
    await send('manual', 'AFTER STOP\r\n'); await finished;
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('REDπ😀\nNEXT\n'));
    assert.equal(/[\x1b\ufffd]/.test(text), false);
    assert.equal(text.includes('hidden title'), false);
    assert.equal(text.includes('AFTER STOP'), false);
    assert.equal(stream.closed, true);
    manager.close('manual'); assert.equal(manager.startLog('manual'), null);
  }));

  await test('Console logging: custom paths append, timestamps follow logical lines, and disconnect flushes the file', () => withConsole(async ({ manager, directory, open, send }) => {
    const file = path.join(directory, 'explicit.custom'); fs.writeFileSync(file, 'existing content\n');
    assert.equal((await open('timestamp', { logging: { enabled: true, timestamps: true, path: file } })).info.logging, file);
    for (const chunk of ['one', '\r', '\ntwo\n', 'three']) await send('timestamp', chunk);
    const stream = manager.conns.get('timestamp').logger.stream, finished = closed(stream);
    manager.close('timestamp'); await finished;
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith('existing content\n'));
    const stamped = text.split('\n').filter(line => /^\[\d{4}-/.test(line));
    assert.equal(stamped.length, 3);
    for (const [i, word] of ['one', 'two', 'three'].entries()) assert.match(stamped[i], new RegExp('^\\[\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\.\\d{3}\\] ' + word + '$'));
    assert.ok(text.includes('Session closed'));
    assert.equal(manager.info('timestamp'), null);
  }));

  await test('Console logging: simultaneous sessions with the same name get independent default files', () => withConsole(async ({ manager, open, send }) => {
    await open('first'); await open('second');
    const first = manager.startLog('first'), second = manager.startLog('second');
    assert.notEqual(first, second);
    await send('first', 'FIRST ONLY\n'); await send('second', 'SECOND ONLY\n');
    const finished = ['first', 'second'].map(id => closed(manager.conns.get(id).logger.stream));
    manager.stopLog('first'); manager.stopLog('second'); await Promise.all(finished);
    assert.ok(fs.readFileSync(first, 'utf8').includes('FIRST ONLY'));
    assert.equal(fs.readFileSync(first, 'utf8').includes('SECOND ONLY'), false);
    assert.ok(fs.readFileSync(second, 'utf8').includes('SECOND ONLY'));
    assert.equal(fs.readFileSync(second, 'utf8').includes('FIRST ONLY'), false);
  }));

  await test('Console logging: an invalid destination never reports active and automatic failure preserves the console', () => withConsole(async ({ manager, events, directory, open, send }) => {
    const result = await open('invalid', { logging: { enabled: true, path: directory } });
    assert.equal(result.ok, true); assert.equal(result.info.logging, null);
    assert.equal(manager.startLog('invalid'), null);
    assert.equal(events.some(([name, , status]) => name === 'conn:status' && status.info?.logging), false);
    await send('invalid', 'STILL CONNECTED\n'); await tick();
    assert.ok(events.some(([name, , data]) => name === 'conn:data' && data.toString().includes('STILL CONNECTED')));
    assert.ok(events.some(([name, , data]) => name === 'conn:data' && data.toString().includes('Could not start logging')));
  }));

  await test('Console logging: stream construction failure releases the opened descriptor', () => withConsole(async ({ manager, open }) => {
    await open('constructor');
    const realOpen = fs.openSync, realStream = fs.createWriteStream; let descriptor;
    try {
      fs.openSync = (...args) => { descriptor = realOpen(...args); return descriptor; };
      fs.createWriteStream = () => { throw new Error('Synthetic stream construction failure'); };
      assert.equal(manager.startLog('constructor'), null);
    } finally { fs.openSync = realOpen; fs.createWriteStream = realStream; }
    assert.equal(manager.info('constructor').logging, null);
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    assert.ok(manager.startLog('constructor'));
  }));

  await test('Console logging: later disk failure clears active status and closes the real descriptor without disconnecting', () => withConsole(async ({ manager, events, open, send }) => {
    await open('disk'); manager.startLog('disk');
    const logger = manager.conns.get('disk').logger, descriptor = logger.stream.fd, finished = closed(logger.stream);
    logger.stream.destroy(Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' })); await finished;
    assert.equal(manager.info('disk').logging, null);
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    const status = events.filter(([name, id]) => name === 'conn:status' && id === 'disk').at(-1)[2];
    assert.equal(status.state, 'connected'); assert.equal(status.info.logging, null);
    await send('disk', 'CONSOLE SURVIVED\n');
    const recovered = manager.startLog('disk'); assert.ok(recovered);
    logger.stream.emit('error', new Error('Late error from the previous log'));
    assert.equal(manager.info('disk').logging, recovered, 'a stale error cannot disable a newer logger');
  }));
}

module.exports = { runTerminalLoggingTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runTerminalLoggingTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} terminal logging tests passed`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
