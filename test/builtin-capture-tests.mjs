// Tests for Windows' built-in capture engine: NDIS fragment assembly, the helper pipe
// protocol, ETW trace reading, and the helper end to end (without administrator rights:
// live sessions need admin, so recorded .etl traces stand in for the live session).
//   node test/builtin-capture-tests.mjs      (also run by test/run-tests.js)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCapture } from '../src/renderer/js/capture/pcapfile.mjs';
import * as P from './lib/packets.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { FrameAssembler, KW, linktypeFor, toPcapng } = require('../src/main/capture/ndiscap.js');
const pipe = require('../src/main/capture/pipe.js');
const helperPath = path.join(here, '../src/main/capture/helper.js');
const isWin = process.platform === 'win32';
const A = 'aa:aa:aa:00:00:01';
const B = 'bb:bb:bb:00:00:02';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fragEvent = ({ ifIndex = 20, data, kw, processor = 0, time = 1700000000 }) => {
  const userData = Buffer.alloc(12 + data.length);
  userData.writeUInt32LE(ifIndex, 0);
  userData.writeUInt32LE(ifIndex, 4);
  userData.writeUInt32LE(data.length, 8);
  Buffer.from(data).copy(userData, 12);
  return { id: 1001, keyword: kw, processor, time, userData };
};

/** Launches helper.js with plain node (no UAC), optionally reading a recorded trace. */
function nodeLauncher(children, sourceFile) {
  return async (args) => {
    const code = sourceFile
      ? `require(${JSON.stringify(helperPath)}).run(process.argv, { source: { file: ${JSON.stringify(sourceFile)} } })`
      : `require(${JSON.stringify(helperPath)}).run(process.argv)`;
    const c = spawn(process.execPath, ['-e', code, '--', ...args], { stdio: 'ignore', windowsHide: true });
    children.push(c);
  };
}

const exited = (c) => (c.exitCode != null ? Promise.resolve(c.exitCode) : new Promise((r) => c.once('exit', r)));

function sampleFrames() {
  const big = P.frame.tcp(A, B, '10.0.0.5', '10.0.0.9', { sport: 50000, dport: 445, seq: 1, flags: 'PA' }, new Array(2900).fill(0x41));
  return [
    { data: P.frame.tcp(A, B, '10.0.0.5', '93.184.215.14', { sport: 51000, dport: 443, flags: 'S', mss: 1460 }), ifIndex: 20 },
    { data: big, ifIndex: 20, fragment: 1000, send: true }, // three fragments
    { data: P.frame.udp(B, A, '10.0.0.1', '10.0.0.5', { sport: 53, dport: 40000 }, P.dns({ id: 7, name: 'konx.test', response: true, answers: [{ type: 'A', data: '10.1.2.3' }] })), ifIndex: 7 },
    // A cellular (WWAN) adapter delivers bare IP packets.
    { data: P.ipv4({ src: '100.64.0.2', dst: '8.8.8.8', proto: 1 }, P.icmpEcho(8, 1, 1)), ifIndex: 31, keyword: KW.WIRELESS_WAN },
  ];
}

export async function runBuiltinCaptureTests(test) {
  console.log('built-in capture (Windows NDIS)');

  await test('fragments are reassembled per processor and adapter', () => {
    const asm = new FrameAssembler();
    const frame = Uint8Array.from({ length: 300 }, (_, i) => i & 255);
    const S = KW.PACKET_START;
    const E = KW.PACKET_END;
    assert.strictEqual(asm.push(fragEvent({ data: frame.subarray(0, 100), kw: S | KW.RECEIVE, processor: 1 })), null);
    // Another processor finishes a whole frame in between.
    const other = asm.push(fragEvent({ data: [1, 2, 3], kw: S | E | KW.SEND, processor: 2, ifIndex: 7 }));
    assert.deepStrictEqual([...other.data], [1, 2, 3]);
    assert.strictEqual(other.dir, 'out');
    assert.strictEqual(other.ifIndex, 7);
    assert.strictEqual(asm.push(fragEvent({ data: frame.subarray(100, 200), kw: KW.RECEIVE, processor: 1 })), null);
    const f = asm.push(fragEvent({ data: frame.subarray(200), kw: E | KW.RECEIVE, processor: 1, time: 5 }));
    assert.deepStrictEqual([...f.data], [...frame]);
    assert.strictEqual(f.len, 300);
    assert.strictEqual(f.ts, 1700000000, 'timestamp of the first fragment');
    assert.strictEqual(f.dir, 'in');
    // A continuation without a start (capture began mid-frame) is dropped and counted.
    assert.strictEqual(asm.push(fragEvent({ data: [9], kw: E })), null);
    assert.strictEqual(asm.stats.frames, 2);
    assert.strictEqual(asm.stats.broken, 1);
    // Events other than fragments are ignored.
    assert.strictEqual(asm.push({ id: 1002, keyword: 0n, processor: 0, time: 0, userData: Buffer.alloc(40) }), null);
  });

  await test('adapter filter, snap length and link types', () => {
    const asm = new FrameAssembler({ ifIndex: 20, snaplen: 64 });
    const S = KW.PACKET_START | KW.PACKET_END;
    assert.strictEqual(asm.push(fragEvent({ ifIndex: 7, data: [1], kw: S })), null);
    assert.strictEqual(asm.stats.skipped, 1);
    const f = asm.push(fragEvent({ data: new Uint8Array(1500), kw: S }));
    assert.strictEqual(f.caplen, 64);
    assert.strictEqual(f.len, 1500);
    assert.strictEqual(linktypeFor(0n), 1);
    assert.strictEqual(linktypeFor(KW.NATIVE_802_11), 105);
    assert.strictEqual(linktypeFor(KW.WIRELESS_WAN), 101);
  });

  await test('helper pipe framing survives any chunking', () => {
    const meta = new Float64Array([1.5, 3, 3, 0, 2.25, 2, 60, 3]);
    const lts = new Uint16Array([1, 101]);
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = Buffer.concat([pipe.encodeJson({ type: 'hello', token: 'x' }), pipe.encodeBatch({ buf: buf.buffer, meta: meta.buffer, lts: lts.buffer }), pipe.encodeJson({ type: 'stopped' })]);
    for (const step of [1, 2, 7, 64, stream.length]) {
      const got = [];
      const r = new pipe.FrameReader((kind, body) => got.push(kind === pipe.KIND_JSON ? JSON.parse(body) : pipe.decodeBatch(Buffer.from(body))));
      for (let i = 0; i < stream.length; i += step) r.push(stream.subarray(i, i + step));
      assert.strictEqual(got.length, 3, `step ${step}`);
      assert.strictEqual(got[0].token, 'x');
      assert.deepStrictEqual([...new Float64Array(got[1].meta)], [...meta]);
      assert.deepStrictEqual([...new Uint16Array(got[1].lts)], [1, 101]);
      assert.deepStrictEqual([...new Uint8Array(got[1].buf)], [1, 2, 3, 4, 5]);
      assert.strictEqual(got[2].type, 'stopped');
    }
    // A packet pointing past its batch, or an absurd frame length, is rejected.
    const bad = pipe.encodeBatch({ buf: new Uint8Array(2).buffer, meta: new Float64Array([0, 10, 10, 0]).buffer, lts: new Uint16Array([1]).buffer });
    assert.throws(() => pipe.decodeBatch(bad.subarray(5)), /outside/);
    assert.throws(() => new pipe.FrameReader(() => {}).push(Buffer.from([0xff, 0xff, 0xff, 0x7f, 1])), /Bad frame length/);
  });

  await test('NDIS frames convert to pcapng with one interface per adapter', () => {
    const frames = sampleFrames().map((f, i) => ({ ts: 1700000000 + i / 4, len: f.data.length, data: Uint8Array.from(f.data), ifIndex: f.ifIndex, linktype: linktypeFor(f.keyword || 0n) }));
    const cap = readCapture(new Uint8Array(toPcapng(frames)));
    assert.strictEqual(cap.format, 'pcapng');
    assert.strictEqual(cap.packets.length, 4);
    cap.packets.forEach((p, i) => {
      assert.deepStrictEqual([...p.data], [...frames[i].data]);
      assert.strictEqual(p.linktype, frames[i].linktype);
      assert.ok(Math.abs(p.ts - frames[i].ts) < 1e-6);
    });
  });

  await test('helper validates its command line', () => {
    const { parseArgs } = require(helperPath);
    const pipeName = 'konx-cap-' + 'a'.repeat(32);
    const token = 'b'.repeat(64);
    assert.deepStrictEqual(parseArgs(['x', '--konx-capture-helper', pipeName, token]), { pipe: pipeName, token });
    assert.strictEqual(parseArgs(['x', '--konx-capture-helper', '..\\evil', token]), null);
    assert.strictEqual(parseArgs(['x', '--konx-capture-helper', pipeName, 'short']), null);
    assert.strictEqual(parseArgs(['x']), null);
  });

  if (!isWin) return;
  const { writeNdisEtl } = require('./lib/etl-writer.js');
  const { BuiltinCapture } = require('../src/main/capture/builtin.js');
  const etw = require('../src/main/capture/etw.js');
  const elevated = require('../src/main/capture/elevate.js').isElevated();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'konx-ndis-'));
  const etl = path.join(tmp, 'ndis.etl');
  const frames = sampleFrames();
  writeNdisEtl(etl, frames, { extra: [{ id: 1002, payload: new Uint8Array(24) }] });

  await test('Windows .etl traces open as packets (ETW reader, worker thread)', async () => {
    const bc = new BuiltinCapture({ emit: () => {} });
    const cap = readCapture(new Uint8Array(await bc.readEtl(etl)));
    assert.strictEqual(cap.packets.length, frames.length);
    cap.packets.forEach((p, i) => assert.deepStrictEqual([...p.data], [...frames[i].data], `frame ${i}`));
    assert.deepStrictEqual(cap.packets.map((p) => p.linktype), [1, 1, 1, 101]);
    const now = Date.now() / 1000;
    assert.ok(cap.packets.every((p) => Math.abs(p.ts - now) < 600), 'event timestamps converted to Unix time');
    // A trace without packet events says how to record one.
    const empty = path.join(tmp, 'empty.etl');
    writeNdisEtl(empty, []);
    await assert.rejects(bc.readEtl(empty), /netsh trace start capture=yes/);
  });

  await test('live ETW sessions require administrator rights', () => {
    assert.ok(Array.isArray(etw.listSessions()));
    if (elevated) return;
    assert.throws(() => etw.startSession('KonX-Capture-test', [{ guid: '{2ED6006E-4729-4609-B423-3EE7BCD678EF}' }]), (e) => e.code === 5 && /administrator/.test(e.message));
  });

  await test('helper streams a trace to the capture tab over the pipe', async () => {
    const children = [];
    const events = [];
    const bc = new BuiltinCapture({ emit: (...a) => events.push(a), launch: nodeLauncher(children, etl), elevated: () => false });
    const devs = await bc.listDevices();
    assert.strictEqual(devs[devs.length - 1].name, 'ndis:all');
    assert.ok(devs.every((d) => d.engine === 'builtin' && /^ndis:(\d+|all)$/.test(d.name)));
    const r = await bc.start('t1', { device: 'ndis:20' });
    assert.strictEqual(r.engine, 'builtin');
    const stopped = () => events.some((e) => e[0] === 'cap:state' && e[2].state === 'stopped');
    for (let i = 0; i < 100 && !stopped(); i++) await sleep(50);
    assert.ok(stopped(), 'capture ends when the trace ends');
    const got = [];
    for (const [ch, id, b] of events.filter((e) => e[0] === 'cap:packets')) {
      assert.strictEqual(id, 't1');
      const m = new Float64Array(b.meta);
      const lts = new Uint16Array(b.lts);
      for (let i = 0; i < m.length; i += 4) got.push({ data: [...new Uint8Array(b.buf, m[i + 3], m[i + 1])], lt: lts[i / 4] });
    }
    // Only adapter 20 was asked for.
    assert.deepStrictEqual(got.map((g) => g.data), [frames[0].data, frames[1].data].map((d) => [...d]));
    assert.ok(got.every((g) => g.lt === 1));
    assert.ok(!events.some((e) => e[0] === 'cap:state' && e[2].error), 'no error');
    assert.strictEqual(await exited(children[0]), 0);
  });

  await test('without admin the helper reports why the capture could not start', async () => {
    if (elevated) return;
    const children = [];
    const bc = new BuiltinCapture({ emit: () => {}, launch: nodeLauncher(children), elevated: () => false });
    await assert.rejects(bc.start('t2', { device: 'ndis:all' }), /administrator rights are required/);
    assert.strictEqual(bc.sessions.size, 0);
    assert.strictEqual(await exited(children[0]), 1);
  });

  await test('stopping while Windows is still asking for permission cancels cleanly', async () => {
    const bc = new BuiltinCapture({ emit: () => {}, launch: () => sleep(300), elevated: () => false });
    const p = bc.start('t3', { device: 'ndis:all' });
    await sleep(50);
    bc.stop('t3');
    await assert.rejects(p, /cancelled/);
    assert.strictEqual(bc.sessions.size, 0);
  });

  await test('a stranger on the pipe without the token is ignored', async () => {
    const net = await import('node:net');
    let pipeName;
    const children = [];
    const launcher = nodeLauncher(children, etl);
    const bc = new BuiltinCapture({
      emit: () => {},
      elevated: () => false,
      launch: async (args) => {
        pipeName = args[1];
        // Someone else connects first and claims to be the helper.
        const evil = net.connect(`\\\\.\\pipe\\${pipeName}`);
        await new Promise((r) => evil.once('connect', r));
        evil.write(pipe.encodeJson({ type: 'hello', token: 'f'.repeat(64) }));
        await new Promise((r) => evil.once('close', r));
        await launcher(args);
      },
    });
    const r = await bc.start('t4', { device: 'ndis:all' });
    assert.strictEqual(r.engine, 'builtin');
    bc.stop('t4');
    await exited(children[0]);
  });

  await test('KonX.exe runs as its own capture helper (Electron entry point)', async () => {
    let electronExe;
    try {
      electronExe = require('electron');
    } catch {
      return;
    }
    if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) return;
    const children = [];
    const appDir = path.join(here, '..');
    const bc = new BuiltinCapture({
      emit: () => {},
      elevated: () => false,
      launch: async (args) => children.push(spawn(electronExe, [appDir, ...args], { stdio: 'ignore', windowsHide: true })),
    });
    if (elevated) {
      // Would really capture; just make sure it starts and stops.
      await bc.start('t5', { device: 'ndis:all' });
      bc.stop('t5');
    } else await assert.rejects(bc.start('t5', { device: 'ndis:all' }), /administrator rights are required/);
    await exited(children[0]);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Standalone run.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = [];
  await runBuiltinCaptureTests(async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push(true);
      console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
      results.push(false);
      console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 5).join('\n       ')}`);
    }
  });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
