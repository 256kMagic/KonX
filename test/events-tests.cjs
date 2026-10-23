'use strict';
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { EventConsole, LIMITS, validate } = require('../src/main/events');
const { parseSyslog, parseSnmp, MAX_VARBINDS } = require('../src/main/event-parsers');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description = 'condition') {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (check()) return; await pause(5); }
  throw new Error('Timed out waiting for ' + description);
}
async function portFor(type = 'udp4', host = '127.0.0.1') {
  const socket = dgram.createSocket(type);
  try { await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, host, resolve); }); return socket.address().port; }
  finally { await new Promise(resolve => socket.close(resolve)); }
}
const send = (socket, bytes, port, host = '127.0.0.1') => new Promise((resolve, reject) => socket.send(bytes, port, host, err => err ? reject(err) : resolve()));
const stop = signal => { signal.stopped = true; signal.onStop?.(); };
const terminal = task => task.then(() => ({ ok: true }), error => ({ ok: false, error }));
const v5424 = text => Buffer.from('<34>1 2026-10-23T09:31:05.123456-04:00 router konx 12 LINK [meta@32473 interface="Gi0/1" detail="a\\]b\\\"c\\\\d"] ' + text);
const tlv = (tag, bytes = Buffer.alloc(0)) => { bytes = Buffer.from(bytes); const n = bytes.length; return Buffer.concat([Buffer.from(n < 128 ? [tag, n] : n < 256 ? [tag, 0x81, n] : [tag, 0x82, n >> 8, n & 255]), bytes]); };
const sequence = (...bytes) => tlv(0x30, Buffer.concat(bytes));
const int = n => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(n); let at = 0; while (at < 3 && ((bytes[at] === 0 && !(bytes[at + 1] & 128)) || (bytes[at] === 255 && (bytes[at + 1] & 128)))) at++; return tlv(2, bytes.subarray(at)); };
const base128 = value => { let n = BigInt(value), result = [Number(n & 127n)]; while ((n >>= 7n)) result.unshift(Number(n & 127n) | 128); return result; };
const oid = name => { const parts = name.split('.').map(BigInt); return tlv(6, Buffer.from([ ...base128(parts[0] * 40n + parts[1]), ...parts.slice(2).flatMap(base128) ])); };
const vb = (name, value) => sequence(oid(name), value);
const uptime = () => vb('1.3.6.1.2.1.1.3.0', tlv(0x43, [1, 2]));
const trapOid = () => vb('1.3.6.1.6.3.1.1.4.1.0', oid('1.3.6.1.6.3.1.1.5.3'));
const community = 'SYNTHETIC_COMMUNITY_NOT_RETAINED';
const envelope = (version, pdu) => sequence(int(version), tlv(4, Buffer.from(community)), pdu);
const v2 = (values = [], tag = 0xa7) => envelope(1, tlv(tag, Buffer.concat([int(-17), int(0), int(0), sequence(uptime(), trapOid(), ...values)])));
const v1 = () => envelope(0, tlv(0xa4, Buffer.concat([oid('1.3.6.1.4.1.9'), tlv(0x40, [192, 0, 2, 7]), int(2), int(0), tlv(0x43, [1, 2]), sequence(vb('1.3.6.1.2.1.2.2.1.1.7', int(7)))])));

async function listening(console, protocol, id = protocol, host = '127.0.0.1') {
  const port = await portFor(host.includes(':') ? 'udp6' : 'udp4', host), signal = {}, events = [];
  const result = terminal(console.run({ listenerId: id, protocol, bindAddress: host, port }, (type, data) => events.push({ type, data, at: performance.now() }), signal));
  await until(() => console.snapshot(id).state === 'listening', 'listener binding');
  return { port, signal, events, result };
}
async function fixture(fn) {
  const console = new EventConsole(), sender = dgram.createSocket('udp4');
  try { await fn(console, sender); }
  finally { await console.close(); await new Promise(resolve => sender.close(resolve)); }
}

async function runEventsTests(test) {
  await test('events validation defaults to loopback high ports and rejects DNS, malformed settings and implicit coercion', async () => {
    assert.deepEqual(validate({ listenerId: 'syslog', protocol: 'syslog' }), { listenerId: 'syslog', protocol: 'syslog', bindAddress: '127.0.0.1', port: 5514 });
    assert.equal(validate({ listenerId: 'snmp', protocol: 'snmp' }).port, 5162);
    for (const bad of [{ bindAddress: 'localhost' }, { bindAddress: '::1%4' }, { port: 0 }, { port: -1 }, { port: '5514' }, { port: NaN }, { port: 65536 }, { community: 'secret' }, { protocol: 'tcp' }]) assert.throws(() => validate({ listenerId: 'listener', protocol: 'syslog', ...bad }));
  });
  await test('syslog parser preserves structured values, offset precision, unknown legacy year/zone and invalid original text', async () => {
    const modern = parseSyslog(v5424('Interface up — café'));
    assert.equal(modern.parseStatus, 'parsed'); assert.equal(modern.timestamp, '2026-10-23T09:31:05.123456-04:00'); assert.equal(modern.severity, 2); assert.equal(modern.facility, 4);
    assert.equal(modern.structuredData[0].params[1].value, 'a]b"c\\d'); assert.equal(modern.message, 'Interface up — café');
    const legacy = parseSyslog(Buffer.from('<13>Oct  7 07:08:09 switch link[42]: port down'));
    assert.equal(legacy.format, 'rfc3164'); assert.equal(legacy.timestamp, null); assert.equal(legacy.timestampText, 'Oct  7 07:08:09'); assert.equal(legacy.procId, '42'); assert.equal(legacy.message, 'port down');
    assert.equal(parseSyslog(Buffer.from('<0>1 - - - - - -')).timestamp, null);
    const repeated = parseSyslog(Buffer.from('<1>1 - r a p m [x key="a" key="b\\q"] \uFEFFtext'));
    assert.deepEqual(repeated.structuredData[0].params, [{ name: 'key', value: 'a' }, { name: 'key', value: 'b\\q' }]); assert.equal(repeated.messageEncoding, 'utf8-bom');
    assert.equal(modern.messageEncoding, 'unspecified-decoded-as-utf8');
    const invalid = ['<192>1 - - - - - -', '<00>Oct  7 07:08:09 r msg', '<1>1 2025-02-29T00:00:00Z r a p m - bad', '<1>1 2024-02-29T24:00:00Z r a p m - bad', '<1>1 - r a p m [x key="a]b"]', '<1>1 - r a p m [x][x]', '\uFEFF<1>1 - r a p m - text', '<1>Feb 30 07:08:09 r bad', 'no header <script>literal</script>'];
    for (const text of invalid) { const result = parseSyslog(Buffer.from(text)); assert.equal(result.parseStatus, 'invalid', text); assert.equal(result.message, text); }
    assert.equal(parseSyslog(Buffer.from('<1>2 - r a p m - next-version')).parseStatus, 'unsupported');
    assert.equal(parseSyslog(Buffer.from([0xff, 0xfe])).parseStatus, 'invalid');
  });
  await test('SNMP parser reads v1/v2c trap semantics, large OID first arcs and exact unsigned 64-bit values without community', async () => {
    const first = parseSnmp(v1()); assert.equal(first.parseStatus, 'parsed'); assert.equal(first.snmp.agentAddress, '192.0.2.7'); assert.equal(first.snmp.genericTrap, 2); assert.equal(first.snmp.uptimeTicks, 258);
    const second = parseSnmp(v2([
      vb('2.999.4294967295.1', tlv(0x46, [0,255,255,255,255,255,255,255,255])), vb('1.3.6.1.4.1.9.1', tlv(4, Buffer.from('café'))),
      vb('1.3.6.1.4.1.9.2', tlv(4, [0,255,1])), vb('1.3.6.1.4.1.9.3', tlv(0x40, [127,0,0,1])), vb('1.3.6.1.4.1.9.4', tlv(0x80)),
    ]));
    assert.equal(second.parseStatus, 'parsed'); assert.equal(second.snmp.requestId, -17);
    assert.equal(second.snmp.variables[2].oid, '2.999.4294967295.1'); assert.equal(second.snmp.variables[2].value, '18446744073709551615');
    assert.equal(second.snmp.variables[3].value, 'café'); assert.equal(second.snmp.variables[4].value, null); assert.equal(second.snmp.variables[4].omitted, 'Binary octet string');
    assert.doesNotMatch(JSON.stringify([first, second]), new RegExp(community));
  });
  await test('SNMP rejects malformed BER, over-complex variables, trailing data and invalid trap fields without packet leakage', async () => {
    const malformed = [Buffer.from([0x30,0x80,0,0]), Buffer.concat([v2(), Buffer.from([0])]), v2().subarray(0,-1),
      envelope(1, tlv(0xa7, Buffer.concat([int(1), int(0), int(0), sequence(trapOid(), uptime())]))),
      v2([vb('1.3.6.1.4.1.9', tlv(6, [0x81]))]), v2([vb('1.3.6.1.4.1.9', tlv(0x46, [0x80]))]),
      v2([vb('1.3.6.1.4.1.9', tlv(0x40, [1,2,3]))]), v2([vb('1.3.6.1.4.1.9', tlv(0x30, []))]),
      v2(Array.from({ length: MAX_VARBINDS }, () => vb('1.3.6.1.4.1.9', int(1))))];
    for (const bytes of malformed) { const parsed = parseSnmp(bytes); assert.equal(parsed.parseStatus, 'invalid'); assert.doesNotMatch(JSON.stringify(parsed), new RegExp(community)); assert.equal(Object.keys(parsed).includes('raw'), false); }
    assert.equal(parseSnmp(v2([], 0xa6)).parseStatus, 'unsupported');
    assert.equal(parseSnmp(sequence(int(3), tlv(4, Buffer.from(community)))).parseStatus, 'unsupported');
    assert.equal(parseSnmp(envelope(0, tlv(0xa0))).parseStatus, 'unsupported');
    for (let end = 0; end < v2().length; end++) assert.doesNotMatch(JSON.stringify(parseSnmp(v2().subarray(0, end))), new RegExp(community));
  });
  await test('real UDP syslog receives readable events in bounded batches and preserves history across stop and restart', async () => fixture(async (console, sender) => {
    const first = await listening(console, 'syslog');
    for (let i = 0; i < 8; i++) await send(sender, v5424('sample ' + i), first.port);
    await until(() => console.snapshot('syslog').counters.received === 8);
    assert.equal(first.events.filter(event => event.type === 'events').length, 0, 'Events are not emitted per packet');
    await until(() => first.events.some(event => event.type === 'events'));
    const result = console.snapshot('syslog', { afterSequence: 0, limit: 3 }); assert.equal(result.records.length, 3); assert.equal(result.hasMore, true); assert.equal(result.nextSequence, 3);
    assert.equal(result.records[0].source.address, '127.0.0.1'); assert.ok(result.records[0].source.port > 0); assert.ok(result.records[0].receivedAt); assert.equal(console.hasOwnership, true);
    result.records[0].message = 'Caller mutation'; assert.equal(console.snapshot('syslog').records[0].message, 'sample 0');
    stop(first.signal); assert.deepEqual(await first.result, { ok: true }); assert.equal(console.hasOwnership, false); assert.equal(console.snapshot('syslog').state, 'stopped');
    await send(sender, v5424('after stop'), first.port); await pause(30); assert.equal(console.snapshot('syslog').counters.received, 8);
    const next = await listening(console, 'syslog'); await send(sender, v5424('restart'), next.port);
    await until(() => console.snapshot('syslog').counters.received === 9); assert.equal(console.snapshot('syslog').records.at(-1).sequence, 9);
    stop(next.signal); await next.result;
  }));
  await test('real UDP SNMP receives traps, counts malformed/unsupported traffic, omits community and never acknowledges informs', async () => fixture(async (console, sender) => {
    const run = await listening(console, 'snmp'); let responses = 0; sender.on('message', () => responses++);
    for (const bytes of [v1(), v2(), v2([],0xa6), sequence(int(3), tlv(4, Buffer.from(community))), Buffer.concat([v2(),Buffer.from([0])])]) await send(sender, bytes, run.port);
    await until(() => console.snapshot('snmp').counters.received === 5); await pause(130);
    const history = console.snapshot('snmp'); assert.equal(history.counters.parseErrors, 1); assert.equal(history.counters.unsupported, 2); assert.equal(history.records.length, 5); assert.equal(responses, 0);
    assert.doesNotMatch(JSON.stringify([history, run.events, console.list()]), new RegExp(community));
    stop(run.signal); await run.result;
  }));
  await test('real UDP clear removes pending display records without stopping the listener or resetting sequence/counters', async () => fixture(async (console, sender) => {
    const run = await listening(console, 'syslog'); await send(sender, v5424('before clear'), run.port);
    await until(() => console.snapshot('syslog').counters.received === 1);
    const cleared = console.clear('syslog'); assert.equal(cleared.retainedRecords, 0); assert.equal(cleared.state, 'listening'); assert.equal(console.hasOwnership, true);
    await pause(120); assert.equal(run.events.filter(event => event.type === 'events').flatMap(event => event.data.records).length, 0);
    await send(sender, v5424('after clear'), run.port); await until(() => console.snapshot('syslog').counters.received === 2);
    assert.equal(console.snapshot('syslog').records[0].sequence, 2); assert.throws(() => console.remove('syslog'), { code: 'EVENTS_BUSY' });
    stop(run.signal); await run.result; console.remove('syslog'); assert.equal(console.list().listeners.length, 0);
  }));
  await test('real UDP rate, datagram, batching and serialized history bounds report omitted traffic', async () => fixture(async (console, sender) => {
    const run = await listening(console, 'syslog');
    await send(sender, Buffer.alloc(LIMITS.datagramBytes + 1, 65), run.port); await until(() => console.snapshot('syslog').counters.received === 1);
    for (let i = 0; i < 230; i++) {
      await send(sender, Buffer.alloc(8000, 1), run.port);
      const deadline = Date.now() + 2000;
      while (console.list().listeners[0].counters.received < i + 2) {
        assert.ok(Date.now() < deadline, 'Each fixture datagram must reach the receiver before sending the next');
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    await until(() => console.snapshot('syslog').counters.received === 231);
    const result = console.snapshot('syslog', { limit: 1000 }); assert.equal(result.counters.oversized, 1); assert.ok(result.counters.rateDropped >= 31);
    assert.ok(result.counters.deliveryDropped > 0); assert.ok(result.counters.historyEvicted > 0); assert.ok(result.retainedBytes <= LIMITS.historyBytes); assert.ok(result.records.length <= LIMITS.records);
    assert.equal(console.snapshot('syslog', { afterSequence: 1 }).gap, true);
    stop(run.signal); await run.result;
    for (const batch of run.events.filter(event => event.type === 'events')) { assert.ok(batch.data.records.length <= LIMITS.batchRecords); assert.ok(Buffer.byteLength(JSON.stringify(batch.data.records)) <= LIMITS.batchBytes + 1024); }
  }));
  await test('real UDP binding failure and cancellation before/while binding release ownership and allow restart', async () => fixture(async (console, _sender) => {
    const held = dgram.createSocket('udp4'); await new Promise(resolve => held.bind(0, '127.0.0.1', resolve));
    try {
      const result = await terminal(console.run({ listenerId: 'conflict', protocol: 'syslog', port: held.address().port }, () => {}, {}));
      assert.equal(result.ok, false); assert.match(result.error.message, /EADDRINUSE/); assert.equal(console.hasOwnership, false); assert.equal(console.snapshot('conflict').state, 'error');
    } finally { await new Promise(resolve => held.close(resolve)); }
    const before = await console.run({ listenerId: 'not-created', protocol: 'syslog' }, () => {}, { stopped: true }); assert.equal(before, undefined); assert.equal(console.list().listeners.length, 1);
    const port = await portFor(), signal = {}; const task = terminal(console.run({ listenerId: 'cancel', protocol: 'syslog', port }, () => {}, signal)); stop(signal);
    assert.equal((await task).ok, true); assert.equal(console.hasOwnership, false);
    const restarted = await listening(console, 'syslog', 'cancel'); stop(restarted.signal); await restarted.result;
  }));
  await test('real UDP history evicts by record count independently of its byte bound', async () => fixture(async (console, sender) => {
    const run = await listening(console, 'syslog'), total = LIMITS.records + 5;
    for (let i = 0; i < total; i++) {
      if (i && i % LIMITS.datagramsPerSecond === 0) await pause(1010);
      await send(sender, Buffer.from('<1>1 - - - - - - ' + i), run.port);
      const deadline = Date.now() + 2000;
      while (console.list().listeners[0].counters.received < i + 1) {
        assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve));
      }
    }
    const result = console.snapshot('syslog', { limit: LIMITS.records });
    assert.equal(result.counters.rateDropped, 0); assert.equal(result.retainedRecords, LIMITS.records); assert.equal(result.counters.historyEvicted, 5);
    assert.equal(result.firstSequence, 6); assert.equal(result.records.at(-1).sequence, total); assert.ok(result.retainedBytes < LIMITS.historyBytes);
    stop(run.signal); await run.result;
  }));
  await test('real UDP IPv6 loopback accepts explicit literal bind without DNS', async () => {
    const console = new EventConsole(), sender = dgram.createSocket('udp6');
    try { const run = await listening(console, 'syslog', 'v6', '::1'); await send(sender, v5424('IPv6'), run.port, '::1');
      await until(() => console.snapshot('v6').records.length === 1); assert.equal(console.snapshot('v6').records[0].source.address, '::1'); stop(run.signal); await run.result;
    } finally { await console.close(); await new Promise(resolve => sender.close(resolve)); }
  });
  await test('real UDP active/history capacity is bounded and manager shutdown awaits each socket closure', async () => fixture(async (console, _sender) => {
    const active = []; for (let i = 0; i < LIMITS.listeners; i++) active.push(await listening(console, 'syslog', 'active-' + i));
    assert.throws(() => console.run({ listenerId: 'excess', protocol: 'syslog' }, () => {}, {}), { code: 'EVENTS_LIMIT' });
    assert.equal((await console.stop('active-0')).hasOwnership, false); assert.equal(console.hasOwnership, true);
    assert.equal(console.list().listeners.filter(item => item.hasOwnership).length, LIMITS.listeners - 1, 'Stopping one listener keeps other sockets running');
    const closing = console.close(); assert.throws(() => console.run({ listenerId: 'closing', protocol: 'syslog' }, () => {}, {}), { code: 'EVENTS_CLOSING' }); await closing;
    assert.equal(console.hasOwnership, false); for (const run of active) assert.equal((await run.result).ok, true);
    for (let i = LIMITS.listeners; i < LIMITS.histories; i++) { const run = await listening(console, 'syslog', 'active-' + i); stop(run.signal); await run.result; }
    assert.throws(() => console.run({ listenerId: 'new', protocol: 'syslog' }, () => {}, {}), { code: 'EVENTS_LIMIT' });
    console.remove('active-0'); const replacement = await listening(console, 'syslog', 'replacement'); stop(replacement.signal); await replacement.result;
  }));
  await test('socket close failures retain the exact owner and retry; late listening after cancellation is closed', async () => {
    class Socket extends EventEmitter {
      bind() { this.bindTimer = setTimeout(() => this.emit('listening'), 25); }
      close() { this.calls = (this.calls || 0) + 1; if (!this.allowClose) throw new Error('Synthetic close failure'); clearTimeout(this.bindTimer); setImmediate(() => this.emit('close')); }
    }
    const socket = new Socket(), console = new EventConsole({ createSocket: () => socket, closeTimeoutMs: 40 }), signal = {};
    const task = terminal(console.run({ listenerId: 'retained', protocol: 'syslog' }, () => {}, signal)); stop(signal);
    const outcome = await task; assert.equal(outcome.error.code, 'EVENTS_CLEANUP'); assert.equal(console.hasOwnership, true); assert.ok(socket.calls >= 2, 'late listening retried the pending close');
    assert.equal(console.snapshot('retained').state, 'cleanup-pending');
    assert.throws(() => console.run({ listenerId: 'retained', protocol: 'syslog' }, () => {}, {}), { code: 'EVENTS_BUSY' });
    await assert.rejects(console.close(), { code: 'EVENTS_CLEANUP' }); assert.equal(console.hasOwnership, true);
    socket.allowClose = true; await console.close(); assert.equal(console.hasOwnership, false); assert.equal(console.snapshot('retained').state, 'stopped');
  });
  await test('delivery failure and post-listening socket errors stop receiving and do not leak exception or packet text', async () => {
    class Socket extends EventEmitter { bind() { setImmediate(() => this.emit('listening')); } close() { setImmediate(() => this.emit('close')); } }
    for (const failDelivery of [false, true]) {
      const socket = new Socket(), console = new EventConsole({ createSocket: () => socket }), events = [];
      const task = terminal(console.run({ listenerId: 'error', protocol: 'snmp' }, (type, data) => { events.push(data); if (failDelivery && data.state === 'listening') throw new Error(community); }, {}));
      if (!failDelivery) { await until(() => console.snapshot('error').state === 'listening'); socket.emit('error', Object.assign(new Error(community), { code: 'EIO' })); }
      const outcome = await task; assert.equal(outcome.ok, false); assert.equal(console.hasOwnership, false); assert.doesNotMatch(JSON.stringify([events, console.list(), outcome.error.message]), new RegExp(community));
      const before = console.snapshot('error').counters.received; socket.emit('message', v2(), { address: '127.0.0.1', port: 1, family: 'IPv4' }); assert.equal(console.snapshot('error').counters.received, before); await console.close();
    }
  });
  await test('final batch delivery failure is reflected by rejected run and retained stopped-socket status', async () => fixture(async (console, sender) => {
    const port = await portFor(), signal = {}, statuses = [];
    const task = terminal(console.run({ listenerId: 'final-flush', protocol: 'syslog', port }, (type, data) => {
      if (type === 'events') throw new Error('Synthetic final delivery failure'); if (type === 'status') statuses.push(data);
    }, signal));
    await until(() => console.snapshot('final-flush').state === 'listening'); await send(sender, v5424('flush on stop'), port);
    await until(() => console.snapshot('final-flush').counters.received === 1);
    const stopped = await console.stop('final-flush'); assert.equal(stopped.state, 'error'); assert.equal(stopped.hasOwnership, false);
    const result = await task; assert.equal(result.error.code, 'EVENTS_DELIVERY'); assert.equal(console.snapshot('final-flush').state, 'error');
    assert.equal(statuses.at(-1).state, 'error'); assert.equal(console.hasOwnership, false);
  }));
}

module.exports = { runEventsTests, fixtures: { v1, v2, v5424 } };
if (require.main === module) {
  let passed = 0, failed = 0;
  runEventsTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (err) { failed++; console.error('FAIL ' + name + '\n' + err.stack); } })
    .then(() => { console.log(`${passed}/${passed + failed} event tests passed`); process.exitCode = failed ? 1 : 0; });
}
