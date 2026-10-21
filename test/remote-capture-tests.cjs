'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Server, Client } = require('ssh2');
const { sshHostKey } = require('./lib/ssh-host-key.cjs');
const { validate, commandFor, CompletePcap, PcapFile, run, captureOnClient } = require('../src/main/remote-capture');
const remoteCaptureOwner = require('../src/main/remote-capture');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const params = { connectionId: 'fixture-terminal', interface: 'eth0', duration: 1, packetLimit: 10, filter: 'udp port 5060' };
const short = { openTimeoutMs: 100, stopGraceMs: 15, deadlineMs: 120, exitTimeoutMs: 20 };
function header({ le = true, nano = false, snaplen = 65535 } = {}) {
  const bytes = Buffer.alloc(24); bytes.set(Buffer.from(le ? nano ? '4d3cb2a1' : 'd4c3b2a1' : nano ? 'a1b23c4d' : 'a1b2c3d4', 'hex'));
  bytes[le ? 4 : 5] = 2; bytes[le ? 6 : 7] = 4;
  bytes[le ? 'writeUInt32LE' : 'writeUInt32BE'](snaplen, 16); bytes[le ? 'writeUInt32LE' : 'writeUInt32BE'](1, 20); return bytes;
}
function record(length = 60, { le = true, fraction = 123456, original = length, fill = 0x42 } = {}) {
  const bytes = Buffer.alloc(length + 16, fill); const write = (value, offset) => bytes[le ? 'writeUInt32LE' : 'writeUInt32BE'](value, offset);
  write(1792530000, 0); write(fraction, 4); write(length, 8); write(original, 12); return bytes;
}
const capture = () => Buffer.concat([header(), record(), record(80)]);
function inspectFile(bytes) {
  assert.ok(bytes.length >= 24); let cursor = 24, packets = 0;
  const le = ['d4c3b2a1', '4d3cb2a1'].includes(bytes.subarray(0, 4).toString('hex'));
  while (cursor < bytes.length) {
    assert.ok(bytes.length - cursor >= 16, 'complete record header');
    const length = bytes[le ? 'readUInt32LE' : 'readUInt32BE'](cursor + 8); cursor += 16 + length;
    assert.ok(cursor <= bytes.length, 'complete record payload'); packets++;
  }
  assert.equal(cursor, bytes.length); return packets;
}
async function temp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-remote-test-'));
  try { return await fn(dir); } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.match(path.basename(dir), /^konx-remote-test-/); await fs.rm(dir, { recursive: true, force: true }); }
}
function mockChannel({ start, delayOpen = 0, openError } = {}) {
  const client = new EventEmitter(), channel = new PassThrough(); channel.stderr = new PassThrough();
  const commands = [], signals = []; let ended = 0;
  client.end = () => { ended++; };
  channel.signal = value => { signals.push(value); };
  client.exec = (command, callback) => {
    commands.push(command);
    setTimeout(() => { callback(openError, openError ? undefined : channel); if (!openError) start?.(channel, client); }, delayOpen);
  };
  return { client, channel, commands, signals, session: { host: '192.0.2.50', password: 'do-not-export-password' }, get ended() { return ended; } };
}
async function liveFixture(handler) {
  const peers = new Set(), commands = [], signals = [];
  const server = new Server({ hostKeys: [sshHostKey()] }, peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('error', () => {});
    peer.on('authentication', c => c.method === 'password' && c.username === 'fixture' && c.password === 'fixture' ? c.accept() : c.reject());
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept(); session.on('pty', acceptPty => acceptPty());
      session.on('shell', acceptShell => { const stream = acceptShell(); stream.on('error', () => {}); stream.on('data', bytes => stream.write(bytes)); });
      session.on('exec', (acceptExec, _reject, info) => {
        commands.push(info.command); const stream = acceptExec(); stream.on('error', () => {});
        session.on('signal', (_accept, _reject, info) => { signals.push(info.name); handler.onSignal?.(stream, info.name); });
        handler.start(stream);
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client(); client.on('error', () => {});
  await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture', hostVerifier: () => true }); });
  const terminal = await new Promise((resolve, reject) => client.shell((error, stream) => error ? reject(error) : resolve(stream)));
  let text = ''; terminal.on('data', bytes => { text += bytes.toString(); });
  return { client, terminal, commands, signals, session: { host: '127.0.0.1', password: 'fixture-secret' },
    async alive() { terminal.write('terminal-alive'); for (let i = 0; i < 40 && !text.includes('terminal-alive'); i++) await pause(5); assert.match(text, /terminal-alive/); },
    async close() { terminal.destroy(); client.end(); for (const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve)); }
  };
}
async function runRemoteCaptureTests(test) {
  await test('remote capture: shell quoting and option boundary preserve exactly one BPF expression', () => {
    const filter = "host example.test or port 80; $(touch /tmp/no) `id` 'quoted'";
    const command = commandFor({ ...params, filter });
    assert.ok(command.endsWith("'--' 'host example.test or port 80; $(touch /tmp/no) `id` '\\''quoted'\\'''"));
    assert.match(command, /^exec 'timeout' '--signal=INT' '--kill-after=5s' '1s' 'tcpdump'/);
    assert.ok(commandFor({ ...params, filter: '-r /etc/passwd' }).endsWith("'--' '-r /etc/passwd'"));
    assert.doesNotMatch(command, /sudo|apt-get|yum|dnf/);
    for (const bad of [{ interface: 'eth0; id' }, { duration: 0 }, { duration: 301 }, { duration: '1' }, { packetLimit: 100001 }, { filter: 'x\nwhoami' }, { filter: 'é'.repeat(1025) }, { interface: '' }]) assert.throws(() => validate({ ...params, ...bad }));
  });
  await test('remote capture: real SSH exec streams a complete capture and leaves the original terminal usable', async () => temp(async dir => {
    const fixture = await liveFixture({ start(stream) { const bytes = capture(); stream.stderr.write('tcpdump: listening on eth0\n'); stream.write(bytes.subarray(0, 29)); setTimeout(() => { stream.write(bytes.subarray(29)); stream.exit(0); stream.end(); }, 15); } });
    try {
      const events = [], signal = { stopped: false };
      const report = await run(params, (kind, data) => events.push({ kind, data }), signal, { sshClient: () => fixture }, dir);
      const bytes = await fs.readFile(report.file);
      const { readCapture } = await import('../src/renderer/js/capture/pcapfile.mjs');
      assert.equal(readCapture(bytes).packets.length, 2);
      assert.equal(inspectFile(bytes), 2); assert.equal(report.packets, 2); assert.equal(report.bytes, bytes.length); assert.equal(report.complete, true); assert.equal(report.remoteExitConfirmed, true);
      assert.equal(report.exitCode, 0); assert.match(report.stderr, /listening/); assert.equal(signal.onStop, null);
      assert.deepEqual(fixture.commands, [commandFor(params)]); assert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
      assert.equal(events.filter(event => event.kind === 'report').length, 1); await fixture.alive();
    } finally { await fixture.close(); }
  }));
  await test('remote capture: real SSH stop saves the complete prefix and signals only the capture channel', async () => temp(async dir => {
    let signal = { stopped: false };
    const fixture = await liveFixture({ start(stream) { stream.write(Buffer.concat([header(), record(), record(200).subarray(0, 25)])); }, onSignal(stream) { stream.exit(130); stream.end(); } });
    try {
      let stopped = false;
      const report = await captureOnClient(params, (kind, data) => { if (kind === 'progress' && data.packets && !stopped) { stopped = true; signal.stopped = true; signal.onStop(); } }, signal, fixture, dir, { ...short, openTimeoutMs: 1000, stopGraceMs: 500, deadlineMs: 2000 });
      const bytes = await fs.readFile(report.file);
      assert.equal(inspectFile(bytes), 1); assert.equal(report.packets, 1); assert.equal(report.complete, false); assert.equal(report.stopped, true); assert.match(report.warnings.join(' '), /incomplete final/);
      assert.deepEqual(fixture.signals, ['INT']); await fixture.alive();
    } finally { await fixture.close(); }
  }));
  await test('remote parser: split headers, endian formats and nanosecond fractions retain exact complete records', async () => {
    for (const le of [true, false]) for (const nano of [true, false]) {
      const input = Buffer.concat([header({ le, nano }), record(13, { le, fraction: nano ? 999999999 : 999999 }), record(0, { le, fraction: 0 })]);
      const parser = new CompletePcap(); const chunks = [];
      for (let i = 0; i < input.length; i++) await parser.feed(input.subarray(i, i + 1), async b => chunks.push(Buffer.from(b)));
      parser.finish(); assert.equal(parser.truncated, false); assert.equal(parser.packets, 2); assert.deepEqual(Buffer.concat(chunks), input);
    }
  });
  await test('remote parser: a huge input chunk is processed one bounded frame at a time', async () => {
    const input = Buffer.concat([header(), ...Array.from({ length: 2000 }, () => record(1500))]);
    const parser = new CompletePcap(); let largest = 0, packets = 0;
    await parser.feed(input, async (bytes, isPacket) => { largest = Math.max(largest, bytes.length); if (isPacket) packets++; }); parser.finish();
    assert.equal(packets, 2000); assert.equal(largest, 1516); assert.equal(parser.bytes, input.length);
  });
  await test('remote parser: malformed lengths, fractions and formats fail before committing invalid records', async () => {
    for (const bad of [Buffer.from('not a pcap header at all!!!'), Buffer.concat([header({ snaplen: 4 }), record(5)]), Buffer.concat([header(), record(4, { original: 3 })]), Buffer.concat([header(), record(4, { fraction: 1000000 })])]) {
      const parser = new CompletePcap(); let packets = 0;
      await assert.rejects(parser.feed(bad, async (_bytes, packet) => { if (packet) packets++; }), /PCAP/); assert.equal(packets, 0);
    }
  });
  await test('remote file owner: partial system writes count only full records and roll back a failed record', async () => temp(async dir => {
    const file = path.join(dir, 'partial.pcap'), real = await fs.open(file, 'wx');
    let fail = false, writes = 0;
    const handle = { write: async (b, o, n, position) => { if (fail && writes++ > 0) throw Error('disk full'); return real.write(b, o, Math.min(7, n), position); }, truncate: n => real.truncate(n), stat: () => real.stat() };
    const owner = new PcapFile(handle);
    try {
      await owner.commit(header(), false); await owner.commit(record(), true); fail = true;
      await assert.rejects(owner.commit(record(100), true), /disk full/); await owner.verify();
      assert.equal(owner.bytes, 100); assert.equal(owner.packets, 1); assert.equal(inspectFile(await fs.readFile(file)), 1); assert.equal(owner.safe, true);
    } finally { await real.close(); }
  }));
  await test('remote file owner: rollback failure invalidates the file rather than advertising it', async () => {
    const owner = new PcapFile({ write: async () => { throw Error('disk failed'); }, truncate: async () => { throw Error('truncate failed'); } });
    await assert.rejects(owner.commit(header(), false), /could not remove/); assert.equal(owner.safe, false); assert.equal(owner.bytes, 0); assert.equal(owner.packets, 0);
  });
  await test('remote capture: byte and packet limits retain a readable exact prefix', async () => temp(async dir => {
    for (const limits of [{ maxBytes: 24 + 76 }, { maxBytes: 4096 }]) {
      const fixture = mockChannel({ start(ch) { ch.write(capture()); ch.emit('exit', 0); ch.end(); } });
      const report = await captureOnClient({ ...params, packetLimit: 1 }, () => {}, {}, fixture, dir, { ...short, ...limits });
      const bytes = await fs.readFile(report.file); assert.equal(bytes.length, 100); assert.equal(inspectFile(bytes), 1); assert.equal(report.packets, 1); assert.equal(report.complete, false); assert.match(report.warnings.join(' '), /limit/); assert.equal(fixture.ended, 0);
    }
  }));
  await test('remote capture: partial final record on clean EOF is omitted and never marked complete', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.write(Buffer.concat([header(), record(), record(10).subarray(0, 18)])); ch.emit('exit', 0); ch.end(); } });
    const report = await captureOnClient(params, () => {}, {}, fixture, dir, short);
    assert.equal(report.packets, 1); assert.equal(report.complete, false); assert.equal(inspectFile(await fs.readFile(report.file)), 1); assert.match(report.warnings.join(' '), /incomplete final/);
  }));
  await test('remote capture: late callback after cancellation closes only the returned channel', async () => temp(async dir => {
    const fixture = mockChannel({ delayOpen: 40 }), signal = { stopped: false };
    const pending = captureOnClient(params, () => {}, signal, fixture, dir, short);
    for (let i = 0; i < 20 && !fixture.commands.length; i++) await pause(2);
    signal.stopped = true; signal.onStop(); await assert.rejects(pending, /cancelled/); await pause(60);
    assert.equal(fixture.channel.destroyed, true); assert.equal(fixture.ended, 0); assert.deepEqual(fixture.signals, ['INT']);
    assert.equal(fixture.client.listenerCount('close'), 0); assert.equal(signal.onStop, null); assert.deepEqual(await fs.readdir(path.join(dir, 'remote-captures')), []);
  }));
  await test('remote capture: open timeout releases late channels and does not close the shared client', async () => temp(async dir => {
    const fixture = mockChannel({ delayOpen: 40 });
    await assert.rejects(captureOnClient(params, () => {}, {}, fixture, dir, { ...short, openTimeoutMs: 5 }), /Timed out opening/); await pause(60);
    assert.equal(fixture.channel.destroyed, true); assert.equal(fixture.ended, 0); assert.deepEqual(fixture.signals, ['INT']);
  }));
  await test('remote capture: capture deadline preserves committed packets even if the server ignores INT', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.write(Buffer.concat([header(), record()])); } });
    const report = await captureOnClient(params, () => {}, {}, fixture, dir, { ...short, deadlineMs: 10 });
    assert.equal(report.complete, false); assert.equal(report.packets, 1); assert.equal(inspectFile(await fs.readFile(report.file)), 1); assert.match(report.warnings.join(' '), /deadline/); assert.equal(report.remoteExitConfirmed, false); assert.equal(fixture.ended, 0);
    assert.ok(fixture.signals.includes('INT'));
  }));
  await test('remote capture: transport loss retains valid records and reports the lost connection', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch, client) { ch.write(Buffer.concat([header(), record()])); setTimeout(() => client.emit('close'), 15); } });
    const report = await captureOnClient(params, () => {}, {}, fixture, dir, short);
    assert.equal(report.packets, 1); assert.equal(report.complete, false); assert.match(report.warnings.join(' '), /SSH connection closed/); assert.equal(fixture.ended, 0);
  }));
  await test('remote capture: missing tools/permissions surface bounded stderr and remove empty output', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.stderr.write('tcpdump: permission denied\n'); ch.emit('exit', 1); ch.end(); } });
    await assert.rejects(captureOnClient(params, () => {}, {}, fixture, dir, short), /permission denied/);
    assert.deepEqual(await fs.readdir(path.join(dir, 'remote-captures')), []);
    const large = mockChannel({ start(ch) { ch.stderr.write('x'.repeat(20000)); ch.write(header()); ch.emit('exit', 1); ch.end(); } });
    const report = await captureOnClient(params, () => {}, {}, large, dir, short);
    assert.equal(report.stderr.length, 8192); assert.equal(report.complete, false); assert.match(report.warnings.join(' '), /8192 bytes/);
  }));
  await test('remote capture: duration expiry 124 with complete EOF is a successful bounded capture', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.write(capture()); ch.emit('exit', 124); ch.end(); } });
    const report = await captureOnClient(params, () => {}, {}, fixture, dir, short); assert.equal(report.complete, true); assert.equal(report.exitCode, 124);
  }));
  await test('remote capture: missing exit status cannot masquerade as completion', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.write(capture()); ch.end(); } });
    const report = await captureOnClient(params, () => {}, {}, fixture, dir, short); assert.equal(report.complete, false); assert.equal(report.remoteExitConfirmed, false);
  }));
  await test('remote capture: already stopped and unavailable connections never execute commands', async () => temp(async dir => {
    const fixture = mockChannel(); await captureOnClient(params, () => {}, { stopped: true }, fixture, dir, short); assert.equal(fixture.commands.length, 0);
    await assert.rejects(run(params, () => {}, {}, { sshClient: () => null }, dir), /no longer connected/);
  }));
  await test('remote capture: cancellation from the start event prevents exec and removes the empty file', async () => temp(async dir => {
    const fixture = mockChannel(), signal = { stopped: false };
    await captureOnClient(params, () => { signal.stopped = true; signal.onStop(); }, signal, fixture, dir, short);
    assert.equal(fixture.commands.length, 0); assert.equal(signal.onStop, null); assert.deepEqual(await fs.readdir(path.join(dir, 'remote-captures')), []);
  }));
  await test('remote capture: channel errors preserve a committed prefix and clean up listeners', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.write(Buffer.concat([header(), record()])); setTimeout(() => ch.emit('error', Error('fixture channel failure')), 15); } });
    const report = await captureOnClient(params, () => {}, {}, fixture, dir, short);
    assert.equal(report.packets, 1); assert.equal(report.complete, false); assert.match(report.warnings.join(' '), /fixture channel failure/);
    assert.equal(fixture.client.listenerCount('close'), 0); assert.equal(fixture.client.listenerCount('error'), 0); assert.equal(fixture.ended, 0);
  }));
  await test('remote file owner: failed size verification cannot advertise an unverified capture', async () => {
    const owner = new PcapFile({ stat: async () => { throw Error('stat failed'); } });
    await assert.rejects(owner.verify(), /stat failed/); assert.equal(owner.safe, false);
  });
  await test('remote capture: failed writable-file close remains owned and never advertises a cleaned capture', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.write(capture()); ch.emit('exit', 0); ch.end(); } });
    let fail = true, closeCalls = 0; const events = [];
    try {
      await assert.rejects(captureOnClient(params, (type, data) => events.push({ type, data }), {}, fixture, dir, { ...short,
        openFile: async file => { const handle = await fs.open(file, 'wx'); return {
          write: (...args) => handle.write(...args), truncate: (...args) => handle.truncate(...args), stat: (...args) => handle.stat(...args), sync: () => handle.sync(),
          close: async () => { closeCalls++; if (fail) throw Error('fixture writable handle is busy'); return handle.close(); }
        }; }
      }), /cleanup did not finish/);
      assert.equal(remoteCaptureOwner.hasPendingCleanup, true); assert.equal(events.some(event => event.type === 'report'), false); assert.equal(closeCalls, 1);
      await assert.rejects(run(params, () => {}, {}, { sshClient: () => { throw Error('must not borrow'); } }, dir), /cleanup is pending/);
      await assert.rejects(remoteCaptureOwner.closePending(), /cleanup is incomplete/); assert.equal(remoteCaptureOwner.hasPendingCleanup, true); assert.equal(closeCalls, 2);
      fail = false; await remoteCaptureOwner.closePending(); assert.equal(remoteCaptureOwner.hasPendingCleanup, false); assert.equal(closeCalls, 3);
      const files = await fs.readdir(path.join(dir, 'remote-captures')); assert.equal(files.length, 1); assert.equal(inspectFile(await fs.readFile(path.join(dir, 'remote-captures', files[0]))), 2);
    } finally { fail = false; await remoteCaptureOwner.closePending(); }
  }));
  await test('remote capture: failed incomplete-file removal retains closed ownership and rejects a replacement on retry', async () => temp(async dir => {
    const fixture = mockChannel({ start(ch) { ch.emit('exit', 1); ch.end(); } });
    let fail = true, ownedPath, movedPath, closeCalls = 0; const events = [];
    try {
      await assert.rejects(captureOnClient(params, (type, data) => events.push({ type, data }), {}, fixture, dir, { ...short,
        openFile: async file => { ownedPath = file; const handle = await fs.open(file, 'wx'); return {
          write: (...args) => handle.write(...args), truncate: (...args) => handle.truncate(...args), stat: (...args) => handle.stat(...args), sync: () => handle.sync(),
          close: async () => { closeCalls++; return handle.close(); }
        }; },
        unlinkFile: async file => { if (fail) throw Error('fixture removal denied'); await fs.unlink(file); }
      }), /cleanup did not finish.*removal denied/);
      assert.equal(remoteCaptureOwner.hasPendingCleanup, true); assert.equal(closeCalls, 1); assert.equal(events.some(event => event.type === 'report'), false);
      await assert.rejects(remoteCaptureOwner.closePending(), /removal denied/); assert.equal(closeCalls, 1);
      movedPath = ownedPath + '.original'; await fs.rename(ownedPath, movedPath); await fs.writeFile(ownedPath, 'foreign replacement'); fail = false;
      await assert.rejects(remoteCaptureOwner.closePending(), /no longer identifies the owned file/);
      assert.equal(await fs.readFile(ownedPath, 'utf8'), 'foreign replacement'); assert.equal(remoteCaptureOwner.hasPendingCleanup, true);
      await fs.unlink(ownedPath); await fs.rename(movedPath, ownedPath); movedPath = null;
      await remoteCaptureOwner.closePending(); assert.equal(remoteCaptureOwner.hasPendingCleanup, false); assert.equal(closeCalls, 1);
      assert.deepEqual(await fs.readdir(path.join(dir, 'remote-captures')), []);
    } finally {
      fail = false;
      if (movedPath) { await fs.unlink(ownedPath); await fs.rename(movedPath, ownedPath); }
      await remoteCaptureOwner.closePending();
    }
  }));
}
module.exports = { runRemoteCaptureTests };
if (require.main === module) {
  let total = 0, failed = 0;
  runRemoteCaptureTests(async (name, fn) => { total++; try { await fn(); console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } })
    .then(() => { console.log(`\n${total - failed}/${total} remote capture tests passed`); process.exitCode = failed ? 1 : 0; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
