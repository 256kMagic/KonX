'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Server, Client, utils } = require('ssh2');
const { run, listConnections, collectDevice } = require('../src/main/device-collector');
const { COMMANDS, analyzeDevices } = require('../src/main/device-analysis');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metadata = { id: 'terminal-one', connectionId: 'terminal-one', label: 'Test switch', host: '192.0.2.1', collectedAt: '2026-10-21T00:00:00Z' };
const options = { openTimeoutMs: 100, commandTimeoutMs: 100, settleMs: 2, commandBytes: 4096 };

function mockShell({ reply, delayOpen = 0, prompt = 'fixture#', openError = null } = {}) {
  const client = new EventEmitter();
  const channel = new EventEmitter(); channel.stderr = new EventEmitter();
  const writes = []; let closed = 0; let ended = 0;
  client.end = () => { ended++; };
  channel.destroy = () => { closed++; channel.emit('close'); };
  channel.write = (value) => {
    const command = value.replace(/\r$/, ''); writes.push(command);
    if (reply) { reply(command, channel, writes); return; }
    queueMicrotask(() => channel.emit('data', Buffer.from(command + '\r\noutput\r\n' + prompt)));
  };
  client.shell = (_opts, cb) => setTimeout(() => {
    cb(openError, openError ? undefined : channel);
    if (!openError) queueMicrotask(() => channel.emit('data', Buffer.from('Banner\r\n' + prompt)));
  }, delayOpen);
  return { client, channel, writes, get closed() { return closed; }, get ended() { return ended; } };
}

async function liveFixture() {
  const key = utils.generateKeyPairSync('ed25519').private;
  const clients = new Set(); const commands = []; let shells = 0;
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept(); session.on('pty', (acc) => acc());
      session.on('shell', (acc) => {
        const stream = acc(); const number = ++shells; let line = '';
        stream.write('\r\nFixture IOS lab\r\nfixture#');
        stream.on('error', () => {});
        stream.on('data', (chunk) => {
          line += chunk.toString('utf8');
          for (;;) {
            const at = line.indexOf('\r'); if (at < 0) break;
            const command = line.slice(0, at); line = line.slice(at + 1);
            commands.push({ number, command });
            const output = command === 'show version' ? 'Cisco IOS XE Software, Version 17.9.4\r\nfixture uptime is 1 day' : command === 'terminal length 0' ? '' : command === 'show interfaces status' ? 'Port      Name               Status       Vlan       Duplex  Speed Type\r\nGi1/0/1   fixture            connected    10         a-full  a-1000 10/100/1000BaseTX' : command === 'echo alive' ? 'alive' : '';
            stream.write(command + '\r\n' + output + '\r\nfixt');
            setTimeout(() => { if (!stream.destroyed && stream.writable) stream.write('ure#'); }, 5);
          }
        });
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client(); client.on('error', () => {});
  await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture', hostVerifier: () => true }); });
  const terminal = await new Promise((resolve, reject) => client.shell({ term: 'vt100' }, (e, ch) => e ? reject(e) : resolve(ch)));
  let terminalText = ''; terminal.on('data', (chunk) => { terminalText += chunk.toString(); });
  return { client, terminal, commands, get terminalText() { return terminalText; }, close() { terminal.destroy(); client.end(); for (const peer of clients) peer.end(); return new Promise((resolve) => server.close(resolve)); } };
}

async function runDeviceCollectorTests(test) {
  await test('device collector: real SSH diagnostic channel preserves the terminal and uses only the command allowlist', async () => {
    const fixture = await liveFixture();
    try {
      const session = { name: metadata.label, host: metadata.host, password: 'never-render-this', passphrase: 'never-this-either' };
      const connections = { conns: new Map([[metadata.id, { id: metadata.id, protocol: 'ssh', closed: false, client: fixture.client, stream: fixture.terminal, session }]]), sshClient: () => ({ client: fixture.client, session }) };
      assert.deepEqual(listConnections(connections), [{ id: metadata.id, label: metadata.label, host: metadata.host }]);
      const events = []; const signal = { stopped: false, onStop: null };
      await run({ connectionIds: [metadata.id] }, (type, data) => events.push({ type, data }), signal, connections);
      const report = events.find((event) => event.type === 'report')?.data;
      assert.equal(report.devices.length, 1);
      assert.deepEqual(report.devices[0].commands.map((r) => r.status), COMMANDS.map(() => 'ok'));
      assert.deepEqual(fixture.commands.map((c) => c.command), ['terminal length 0', ...COMMANDS.map((c) => c.command)]);
      assert.ok(fixture.commands.every((c) => c.number === 2));
      assert.doesNotMatch(JSON.stringify(report), /never-render-this|never-this-either/);
      assert.equal(signal.onStop, null);
      fixture.terminal.write('echo alive\r');
      for (let i = 0; i < 30 && !fixture.terminalText.includes('alive'); i++) await pause(10);
      assert.match(fixture.terminalText, /alive/);
    } finally { await fixture.close(); }
  });

  await test('device collector: unavailable, duplicate and oversized selections fail before collection', async () => {
    let called = 0;
    const connections = { conns: new Map(), sshClient: () => { called++; return null; } };
    for (const connectionIds of [[], ['same', 'same'], Array.from({ length: 17 }, (_, i) => 'c' + i), ['x'.repeat(129)]]) await assert.rejects(run({ connectionIds }, () => {}, {}, connections), /distinct connected/);
    assert.equal(called, 0);
    await assert.rejects(run({ connectionIds: ['missing'] }, () => {}, {}, connections), /no longer connected/);
  });

  await test('device collector: command denial retains evidence and continues the remaining read-only commands', async () => {
    const fixture = mockShell({ reply(command, ch) { queueMicrotask(() => ch.emit('data', Buffer.from(command + '\r\n' + (command === 'show interfaces' ? "% Invalid input detected at '^' marker." : '') + '\r\nfixture#'))); } });
    const result = await collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, options);
    assert.equal(result.commands.find((c) => c.id === 'interfaces').status, 'error');
    assert.match(result.commands.find((c) => c.id === 'interfaces').output, /Invalid input/);
    assert.equal(result.commands.at(-1).status, 'ok');
    assert.equal(fixture.ended, 0); assert.equal(fixture.closed, 1);
  });

  await test('device collector: paging is explicitly incomplete and never sends continuation keys', async () => {
    const fixture = mockShell({ reply(command, ch) { queueMicrotask(() => ch.emit('data', Buffer.from(command + '\r\n' + (command === 'terminal length 0' ? 'fixture#' : 'partial output\r\n--More--')))); } });
    const result = await collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, options);
    assert.equal(result.commands[0].status, 'truncated'); assert.match(result.commands[0].output, /partial output/);
    assert.equal(fixture.writes.length, 2); assert.equal(fixture.ended, 0);
    assert.ok(result.commands.slice(1).every((row) => row.output === '' && row.status === 'truncated'));
  });

  await test('device collector: timeout retains partial output and stops the diagnostic channel', async () => {
    const fixture = mockShell({ reply(command, ch) { queueMicrotask(() => ch.emit('data', Buffer.from(command + '\r\n' + (command === 'terminal length 0' ? 'fixture#' : 'still collecting')))); } });
    const result = await collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, { ...options, commandTimeoutMs: 15 });
    assert.equal(result.commands[0].status, 'timeout'); assert.match(result.commands[0].output, /still collecting/);
    assert.equal(fixture.closed, 1); assert.equal(fixture.ended, 0);
  });

  await test('device collector: cancellation before a late channel callback still releases only that channel', async () => {
    const fixture = mockShell({ delayOpen: 30 }); const signal = { stopped: false };
    const pending = collectDevice(fixture, metadata, signal, { remaining: 100000 }, options);
    signal.stopped = true; signal.onStop();
    const result = await pending; await pause(40);
    assert.ok(result.commands.every((r) => r.status === 'cancelled'));
    assert.equal(fixture.closed, 1); assert.equal(fixture.ended, 0); assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.client.listenerCount('close'), 0);
  });

  await test('device collector: cancellation during output retains partial evidence and stops further commands', async () => {
    const signal = { stopped: false };
    const fixture = mockShell({ reply(command, ch) { queueMicrotask(() => {
      ch.emit('data', Buffer.from(command + '\r\n' + (command === 'terminal length 0' ? 'fixture#' : 'partial evidence')));
      if (command !== 'terminal length 0') { signal.stopped = true; signal.onStop(); }
    }); } });
    const result = await collectDevice(fixture, metadata, signal, { remaining: 100000 }, options);
    assert.equal(result.commands[0].status, 'cancelled'); assert.match(result.commands[0].output, /partial evidence/);
    assert.equal(fixture.writes.length, 2); assert.equal(fixture.ended, 0);
  });

  await test('device collector: output capacity is bounded before retaining excess bytes', async () => {
    const fixture = mockShell({ reply(command, ch) { queueMicrotask(() => ch.emit('data', Buffer.from(command === 'terminal length 0' ? command + '\r\nfixture#' : 'x'.repeat(9000)))); } });
    const result = await collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, { ...options, commandBytes: 128 });
    assert.equal(result.commands[0].status, 'truncated'); assert.equal(Buffer.byteLength(result.commands[0].output), 128);
    assert.equal(fixture.writes.length, 2); assert.equal(fixture.closed, 1);
  });

  await test('device collector: transport loss during pending channel creation cannot start commands later', async () => {
    const fixture = mockShell({ delayOpen: 30 });
    const pending = collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, options);
    fixture.client.emit('close');
    const result = await pending; await pause(40);
    assert.ok(result.commands.every((r) => r.status === 'error'));
    assert.equal(fixture.closed, 1); assert.deepEqual(fixture.writes, []); assert.equal(fixture.ended, 0);
  });

  await test('device collector: malformed UTF-8 expansion cannot exceed report limits', async () => {
    const fixture = mockShell({ reply(command, ch) { queueMicrotask(() => ch.emit('data', command === 'terminal length 0' ? Buffer.from(command + '\r\nfixture#') : Buffer.alloc(9000, 0xff))); } });
    const result = await collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, { ...options, commandBytes: 128 });
    assert.equal(result.commands[0].status, 'truncated');
    assert.ok(Buffer.byteLength(result.commands[0].output) <= 128);
    assert.doesNotThrow(() => analyzeDevices({ devices: [result] }));
    assert.equal(fixture.closed, 1);
  });

  await test('device collector: a timed-out channel request closes a later successful callback', async () => {
    const fixture = mockShell({ delayOpen: 30 });
    const result = await collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, { ...options, openTimeoutMs: 10 });
    await pause(40);
    assert.ok(result.commands.every((r) => r.status === 'timeout'));
    assert.equal(fixture.closed, 1); assert.equal(fixture.ended, 0); assert.deepEqual(fixture.writes, []);
  });

  await test('device collector: invalid public metadata is rejected before opening the diagnostic channel', async () => {
    const fixture = mockShell();
    const session = { name: 'x'.repeat(257), host: metadata.host };
    const connections = { conns: new Map([[metadata.id, { id: metadata.id, protocol: 'ssh', stream: {}, client: fixture.client, session }]]), sshClient: () => ({ client: fixture.client, session }) };
    await assert.rejects(run({ connectionIds: [metadata.id] }, () => {}, {}, connections), /cannot be represented.*label/);
    assert.deepEqual(fixture.writes, []); assert.equal(fixture.closed, 0);
  });

  await test('device collector: configuration mode is not treated as an EXEC prompt', async () => {
    const fixture = mockShell({ prompt: 'fixture(config)#' });
    const result = await collectDevice(fixture, metadata, { stopped: false }, { remaining: 100000 }, { ...options, openTimeoutMs: 15 });
    assert.ok(result.commands.every((r) => r.status === 'timeout'));
    assert.deepEqual(fixture.writes, []); assert.equal(fixture.ended, 0);
  });
}

module.exports = { runDeviceCollectorTests };
if (require.main === module) {
  let failed = 0; let total = 0;
  runDeviceCollectorTests(async (name, fn) => { total++; try { await fn(); console.log('ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } })
    .then(() => { console.log(`${total - failed}/${total} device collector tests passed`); process.exitCode = failed ? 1 : 0; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
