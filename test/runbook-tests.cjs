'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { run, validateDefinition, validateInputs, getTemplates } = require('../src/main/runbooks');
const { RunbookStore } = require('../src/main/runbook-store');
const nettools = require('../src/main/nettools');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const definition = steps => ({ schemaVersion: 1, name: 'Loopback procedure', steps });
const dnsStep = server => ({ id: 'dns', title: 'Local DNS query', kind: 'dns', target: 'fixture.example.test', server, timeoutMs: 1000 });
const tcpStep = port => ({ id: 'tcp', title: 'Local TCP connect', kind: 'tcp', target: '127.0.0.1', port, timeoutMs: 1000 });
const manual = { id: 'manual', title: 'Review context', kind: 'checklist', instructions: 'Check the affected client.' };
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-runbook-test-'));
  try { return await fn(dir); } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.match(path.basename(dir), /^konx-runbook-test-/); await fs.rm(dir, { recursive: true, force: true }); }
}
async function tcpFixture() {
  const sockets = new Set(); let connections = 0;
  const server = net.createServer(socket => { connections++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, get connections() { return connections; }, get sockets() { return sockets.size; }, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
async function dnsFixture({ silent = false, nxdomain = false } = {}) {
  const socket = dgram.createSocket('udp4'); let queries = 0;
  socket.on('message', (query, remote) => {
    queries++; if (silent) return;
    let end = 12; while (query[end]) end += 1 + query[end]; end += 5;
    const type = query.readUInt16BE(end - 4), body = type === 28 ? Buffer.from('00000000000000000000000000000001', 'hex') : Buffer.from([127, 0, 0, 1]);
    const head = Buffer.from(query.subarray(0, 12)); head.writeUInt16BE(nxdomain ? 0x8183 : 0x8180, 2); head.writeUInt16BE(nxdomain ? 0 : 1, 6); head.writeUInt16BE(0, 8); head.writeUInt16BE(0, 10);
    const answer = Buffer.alloc(12); answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(type, 2); answer.writeUInt16BE(1, 4); answer.writeUInt32BE(30, 6); answer.writeUInt16BE(body.length, 10);
    socket.send(Buffer.concat([head, query.subarray(12, end), ...(nxdomain ? [] : [answer, body])]), remote.port, remote.address);
  });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  return { server: '127.0.0.1:' + socket.address().port, get queries() { return queries; }, close: () => new Promise(resolve => socket.close(resolve)) };
}
async function runRunbookTests(test) {
  await test('runbook declarations: all built-ins validate without scripts or arbitrary commands', () => {
    const templates = getTemplates(); assert.deepEqual(templates.map(t => t.id), ['gateway', 'application-slow', 'phone-no-audio']);
    for (const template of templates) assert.deepEqual(validateDefinition(template.definition), template.definition);
    assert.deepEqual(templates[2].definition.steps.filter(s => s.kind === 'capture').map(s => s.view), ['sip', 'rtp']);
    templates[0].definition.name = 'Changed'; assert.notEqual(getTemplates()[0].definition.name, 'Changed');
  });
  await test('runbook declarations: malicious fields, target ranges, bad references and bounds fail before operations', async () => {
    const bad = [definition([{ ...tcpStep(80), command: 'id' }]), definition([{ ...manual, kind: 'shell' }]), definition([{ ...tcpStep(80), target: '127.0.0.1; whoami' }]), definition([{ ...tcpStep(80), target: '127.0.0.1/24' }]), definition([{ ...tcpStep(80), port: '80' }]), definition([{ ...tcpStep(80), target: { input: 'missing' } }]), definition([{ ...dnsStep('127.0.0.1'), recordType: 'SYSTEM' }]), definition(Array.from({ length: 25 }, (_, i) => ({ ...manual, id: 's' + i }))), definition([manual, manual])];
    for (const item of bad) assert.throws(() => validateDefinition(item));
    await assert.rejects(run({ definition: bad[0] }, () => assert.fail('No tool event may precede validation'), {}, {}));
    const d = getTemplates()[0].definition; assert.throws(() => validateInputs(d, {}), /Enter Gateway/); assert.throws(() => validateInputs(d, { gateway: '127.0.0.1', extra: 'x' }), /declared inputs/);
  });
  await test('runbook execution: real loopback DNS, TCP and system ping retain observed evidence', async () => {
    const dns = await dnsFixture(), tcp = await tcpFixture();
    try {
      const events = [], signal = {};
      const report = await run({ definition: definition([dnsStep(dns.server), { ...tcpStep(tcp.port), target: 'fixture.example.test', server: dns.server }, { id: 'ping', title: 'Loopback echo', kind: 'ping', target: '127.0.0.1', timeoutMs: 3000 }]) }, (kind, data) => events.push({ kind, data }), signal, {});
      assert.deepEqual(report.steps.map(s => s.status), ['pass', 'pass', 'pass']); assert.equal(report.steps[0].evidence.records[0].value, '127.0.0.1'); assert.equal(report.steps[1].evidence.resolution.address, '127.0.0.1'); assert.equal(report.steps[1].evidence.port, tcp.port);
      assert.equal(report.complete, true); assert.equal(signal.onStop, null); assert.equal(events.filter(e => e.kind === 'report').length, 1); assert.equal(events.filter(e => e.kind === 'step').length, 3);
      await pause(20); assert.equal(tcp.sockets, 0);
    } finally { await dns.close(); await tcp.close(); }
  });
  await test('runbook execution: refused TCP is a failed check and NXDOMAIN retains DNS evidence', async () => {
    const tcp = await tcpFixture(), port = tcp.port; await tcp.close(); const dns = await dnsFixture({ nxdomain: true });
    try {
      const report = await run({ definition: definition([tcpStep(port), dnsStep(dns.server)]) }, () => {}, {}, {});
      assert.deepEqual(report.steps.map(s => s.status), ['fail', 'fail']); assert.equal(report.steps[0].evidence.state, 'closed'); assert.match(report.steps[1].evidence.errors.join(' '), /ENOTFOUND/);
    } finally { await dns.close(); }
  });
  await test('runbook execution: manual and capture steps remain unknown and never claim an automatic diagnosis', async () => {
    const report = await run({ definition: definition([manual, { id: 'rtp', title: 'Inspect RTP', kind: 'capture', view: 'rtp', instructions: 'Inspect source packets.' }]) }, () => {}, {}, {});
    assert.deepEqual(report.steps.map(s => s.status), ['unknown', 'unknown']); assert.deepEqual(report.steps[1].action, { type: 'capture', view: 'rtp' }); assert.match(report.warnings.join(' '), /root cause/);
  });
  await test('runbook cancellation: pending DNS is cancelled through its owner and later probes never start', async () => {
    const dns = await dnsFixture({ silent: true }), tcp = await tcpFixture(), signal = {};
    try {
      const pending = run({ definition: definition([dnsStep(dns.server), tcpStep(tcp.port)]) }, () => {}, signal, {});
      for (let i = 0; i < 50 && !dns.queries; i++) await pause(2);
      assert.equal(dns.queries, 1); signal.stopped = true; signal.onStop(); const report = await pending;
      assert.equal(report.stopped, true); assert.equal(report.complete, false); assert.equal(report.steps[0].status, 'unknown'); assert.equal(report.steps[1].skipped, true); assert.equal(tcp.connections, 0);
      const requests = dns.queries; await pause(150); assert.equal(dns.queries, requests); assert.equal(signal.onStop, null);
    } finally { await dns.close(); await tcp.close(); }
  });
  await test('runbook deadlines: step timeout cancels DNS then continues, overall deadline skips the rest', async () => {
    const dns = await dnsFixture({ silent: true });
    try {
      const stepReport = await run({ definition: definition([{ ...dnsStep(dns.server), timeoutMs: 100 }, manual]) }, () => {}, {}, {});
      assert.match(stepReport.steps[0].summary, /Step deadline/); assert.equal(stepReport.steps[0].incomplete, true); assert.equal(stepReport.steps[1].skipped, undefined); assert.equal(stepReport.complete, false);
      const overallReport = await run({ definition: { ...definition([dnsStep(dns.server), manual]), timeoutMs: 100 } }, () => {}, {}, {});
      assert.match(overallReport.steps[0].summary, /Runbook deadline/); assert.equal(overallReport.steps[1].skipped, true);
    } finally { await dns.close(); }
  });
  await test('runbook cancellation: stopping from progress prevents the first operation', async () => {
    const tcp = await tcpFixture(), signal = {};
    try {
      const report = await run({ definition: definition([tcpStep(tcp.port)]) }, kind => { if (kind === 'progress') { signal.stopped = true; signal.onStop(); } }, signal, {});
      assert.equal(tcp.connections, 0); assert.equal(report.stopped, true); assert.equal(report.steps[0].status, 'unknown');
    } finally { await tcp.close(); }
  });
  await test('runbook optional inputs: an absent parameter skips the whole step before DNS', async () => {
    const dns = await dnsFixture();
    try {
      const d = { ...definition([{ ...tcpStep(80), target: 'fixture.example.test', server: dns.server, port: { input: 'port' } }]), inputs: [{ id: 'port', label: 'Optional port', kind: 'port', required: false }] };
      const report = await run({ definition: d }, () => {}, {}, {}); assert.equal(report.steps[0].status, 'unknown'); assert.match(report.steps[0].summary, /was not provided/); assert.equal(dns.queries, 0);
    } finally { await dns.close(); }
  });
  await test('runbook device bridge: cancellation releases a late dedicated shell without closing the shared client', async () => {
    const client = new EventEmitter(), channel = new EventEmitter(); channel.stderr = new EventEmitter(); let destroyed = 0, clientEnds = 0, opens = 0;
    channel.destroy = () => { destroyed++; }; channel.write = () => assert.fail('Cancelled collection must not run a command'); client.end = () => { clientEnds++; };
    client.shell = (_options, callback) => { opens++; setTimeout(() => callback(null, channel), 40); };
    const session = { host: '192.0.2.1', name: 'Fixture', password: 'secret-not-for-report' };
    const connections = { conns: new Map([['c', { id: 'c', protocol: 'ssh', closed: false, stream: {}, client, session }]]), sshClient: () => ({ client, session }) };
    const signal = {}, pending = run({ definition: definition([{ id: 'device', title: 'Collect', kind: 'device', connectionId: 'c' }]) }, () => {}, signal, connections);
    for (let i = 0; i < 50 && !opens; i++) await pause(1); signal.stopped = true; signal.onStop(); const report = await pending; await pause(60);
    assert.equal(opens, 1); assert.equal(destroyed, 1); assert.equal(clientEnds, 0); assert.equal(report.steps[0].status, 'unknown'); assert.doesNotMatch(JSON.stringify(report), /secret-not-for-report/);
  });
  await test('nettools compatibility: unsignalled DNS, TCP and ping keep their existing public result fields', async () => {
    const dns = await dnsFixture(), tcp = await tcpFixture();
    try {
      const d = await nettools.dnsLookup({ name: 'fixture.example.test', type: 'A', server: dns.server }); assert.equal(d.records[0].value, '127.0.0.1');
      assert.equal((await nettools.probePort('127.0.0.1', tcp.port)).state, 'open'); assert.equal((await nettools.pingOnce('127.0.0.1')).ok, true);
    } finally { await dns.close(); await tcp.close(); }
  });
  await test('nettools cancellation: TCP waits for local socket close and rejects uncancellable resolver paths', async () => {
    const tcp = await tcpFixture(), controller = new AbortController();
    try {
      const pending = nettools.probePort('127.0.0.1', tcp.port, { signal: controller.signal }); controller.abort();
      const result = await pending; assert.equal(result.error, 'cancelled'); await pause(20); assert.equal(tcp.sockets, 0);
      await assert.rejects(nettools.probePort('localhost', tcp.port, { signal: new AbortController().signal }), /already resolved/);
      await assert.rejects(nettools.dnsLookup({ name: 'localhost', type: 'SYSTEM', signal: new AbortController().signal }), /SYSTEM/);
      await assert.rejects(nettools.pingOnce('localhost', { signal: new AbortController().signal }), /already resolved/);
    } finally { await tcp.close(); }
  });
  await test('nettools cancellation: ping resolves only after its spawned process closes', async () => {
    const cp = require('node:child_process'), original = cp.spawn, modulePath = require.resolve('../src/main/nettools'), cached = require.cache[modulePath]; let observedClose = false;
    cp.spawn = (...args) => { const child = original(...args); child.once('close', () => { observedClose = true; }); return child; };
    let instrumented;
    try { delete require.cache[modulePath]; instrumented = require('../src/main/nettools'); } finally { cp.spawn = original; if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath]; }
    const controller = new AbortController(), pending = instrumented.pingOnce('127.0.0.1', { signal: controller.signal }); controller.abort();
    assert.equal((await pending).error, 'cancelled'); assert.equal(observedClose, true);
  });
  await test('runbook store: atomic create, update, export, reopen, list and delete preserve identity', async () => temporary(async dir => {
    const store = new RunbookStore(dir), saved = await store.save({ definition: definition([manual]) });
    assert.match(saved.id, /^[0-9a-f-]{36}$/); const originalCreatedAt = saved.createdAt;
    const updated = await store.save({ id: saved.id, definition: { ...saved.definition, name: 'Updated procedure' } });
    assert.equal(updated.id, saved.id); assert.equal(updated.createdAt, originalCreatedAt); assert.equal((await new RunbookStore(dir).get(saved.id)).definition.name, 'Updated procedure');
    assert.equal(JSON.parse(await store.export(saved.id)).name, 'Updated procedure'); assert.equal((await store.list()).runbooks[0].stepCount, 1);
    const exported = path.join(dir, 'exported.json'); assert.equal(await store.exportFile(saved.id, exported), exported); assert.equal(JSON.parse(await fs.readFile(exported, 'utf8')).name, 'Updated procedure');
    assert.equal((await store.remove(saved.id)).removed, true); assert.deepEqual((await store.list()).runbooks, []);
  }));
  await test('runbook store: invalid identities and malformed files cannot be read but owned corruption can be deleted', async () => temporary(async dir => {
    const store = new RunbookStore(dir), saved = await store.save({ definition: definition([manual]) });
    for (const id of ['../outside', 'abc', saved.id + '/../outside']) await assert.rejects(store.get(id), /identifier/);
    await fs.writeFile(path.join(dir, 'runbooks', saved.id + '.json'), '{bad json');
    await assert.rejects(store.get(saved.id), /malformed/); assert.equal((await store.list()).issues.length, 1); await store.remove(saved.id);
    assert.deepEqual((await store.list()).runbooks, []);
  }));
  await test('runbook store: failed atomic replacement leaves the previous record intact and removes temporary output', async () => temporary(async dir => {
    const store = new RunbookStore(dir), saved = await store.save({ definition: definition([manual]) });
    const failing = new RunbookStore(dir, { fs: { ...fs, rename: async () => { throw Error('fixture rename failure'); } } });
    await assert.rejects(failing.save({ id: saved.id, definition: { ...saved.definition, name: 'Must not replace' } }), /rename failure/);
    assert.equal((await store.get(saved.id)).definition.name, saved.definition.name); assert.deepEqual(await fs.readdir(path.join(dir, 'runbooks')), [saved.id + '.json']);
  }));
  await test('runbook store: concurrent mutations serialize and imported definitions remain validated', async () => temporary(async dir => {
    const store = new RunbookStore(dir); const saved = await Promise.all(Array.from({ length: 5 }, (_, i) => store.save({ definition: { ...definition([manual]), name: 'Procedure ' + i } })));
    assert.equal(new Set(saved.map(s => s.id)).size, 5); assert.equal((await store.list()).runbooks.length, 5);
    await assert.rejects(store.save({ definition: definition([{ ...manual, command: 'whoami' }]) }), /fields/); assert.equal((await store.list()).runbooks.length, 5);
  }));
  await test('runbook store: failed writable close stays owned, blocks queued writes, and retries exact temporary cleanup', async () => temporary(async dir => {
    let fail = true, opens = 0;
    const store = new RunbookStore(dir, { fs: { ...fs, open: async (file, flags) => {
      const handle = await fs.open(file, flags); opens++;
      return { writeFile: (...args) => handle.writeFile(...args), sync: () => handle.sync(), stat: (...args) => handle.stat(...args),
        close: async () => { if (fail) throw Error('fixture close failure'); return handle.close(); } };
    } } });
    try {
      const first = store.save({ definition: definition([manual]) }), second = store.save({ definition: definition([manual]) });
      const outcomes = await Promise.allSettled([first, second]); assert.ok(outcomes.every(result => result.status === 'rejected')); assert.equal(opens, 1);
      assert.equal(store.hasOwnership, true); assert.equal(store.hasPendingCleanup, true);
      await assert.rejects(store.save({ definition: definition([manual]) }), /cleanup is pending/);
      await assert.rejects(store.close(), /cleanup is incomplete/); assert.equal(store.hasPendingCleanup, true);
      fail = false; await store.close(); assert.equal(store.hasOwnership, false); assert.deepEqual(await fs.readdir(path.join(dir, 'runbooks')), []);
      const saved = await store.save({ definition: definition([manual]) }); assert.ok(saved.id);
    } finally { fail = false; await store.close(); }
  }));
  await test('runbook store: failed removal retains closed file identity and never removes a replacement on retry', async () => temporary(async dir => {
    let fail = true, owned, moved;
    const store = new RunbookStore(dir, { fs: { ...fs,
      rename: async () => { throw Error('fixture rename failure'); },
      unlink: async file => { owned = file; if (fail) throw Error('fixture unlink failure'); return fs.unlink(file); }
    } });
    try {
      await assert.rejects(store.save({ definition: definition([manual]) }), /temporary runbook cleanup failed/); assert.equal(store.hasPendingCleanup, true);
      moved = owned + '.original'; await fs.rename(owned, moved); await fs.writeFile(owned, 'foreign bytes'); fail = false;
      await assert.rejects(store.close(), /no longer identifies the owned file/); assert.equal(await fs.readFile(owned, 'utf8'), 'foreign bytes'); assert.equal(store.hasPendingCleanup, true);
      await fs.unlink(owned); await fs.rename(moved, owned); moved = null; await store.close(); assert.equal(store.hasOwnership, false);
      assert.deepEqual(await fs.readdir(path.join(dir, 'runbooks')), []);
    } finally { fail = false; if (moved) { await fs.unlink(owned); await fs.rename(moved, owned); } await store.close(); }
  }));
  await test('runbook store: failed read close remains owned and listing stops before opening more files', async () => temporary(async dir => {
    const original = new RunbookStore(dir); await original.save({ definition: definition([manual]) }); await original.save({ definition: definition([manual]) });
    let fail = true, opens = 0;
    const store = new RunbookStore(dir, { fs: { ...fs, open: async (file, flags) => {
      const handle = await fs.open(file, flags); opens++;
      return { read: (...args) => handle.read(...args), stat: (...args) => handle.stat(...args), close: async () => { if (fail) throw Error('fixture read close failure'); return handle.close(); } };
    } } });
    try {
      await assert.rejects(store.list(), /cleanup did not finish/); assert.equal(opens, 1); assert.equal(store.hasOwnership, true);
      await assert.rejects(store.close(), /cleanup is incomplete/); fail = false; await store.close(); assert.equal(store.hasOwnership, false);
      assert.equal((await store.list()).runbooks.length, 2);
    } finally { fail = false; await store.close(); }
  }));
  await test('runbook import: selected files are bounded, regular, validated, and remain unsaved', async () => temporary(async dir => {
    const store = new RunbookStore(dir), selected = path.join(dir, 'selected.json');
    await fs.writeFile(selected, '\uFEFF' + JSON.stringify(definition([manual])));
    assert.equal((await store.importFile(selected)).name, definition([manual]).name); assert.equal(store.hasOwnership, false);
    await assert.rejects(fs.stat(path.join(dir, 'runbooks')), { code: 'ENOENT' });
    await fs.writeFile(selected, JSON.stringify(definition([{ ...manual, command: 'unsafe' }]))); await assert.rejects(store.importFile(selected), /fields/);
    await fs.writeFile(selected, ' '.repeat(65537)); await assert.rejects(store.importFile(selected), /bounded regular/);
    await assert.rejects(store.importFile(dir), /bounded regular/); await assert.rejects(store.importFile('relative.json'), /local runbook/);
    assert.equal(store.hasOwnership, false);
  }));
  await test('runbook export: near-limit definitions use compact JSON and round-trip through the bounded importer', async () => temporary(async dir => {
    let candidate;
    for (let length = 2400; length <= 2800; length++) {
      const value = validateDefinition(definition(Array.from({ length: 24 }, (_, index) => ({ ...manual, id: 'step' + index, instructions: 'x'.repeat(length) }))));
      if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > 65536) { candidate = value; break; }
    }
    assert.ok(candidate, 'Fixture must cross the pretty JSON limit while compact JSON remains valid');
    const store = new RunbookStore(dir), saved = await store.save({ definition: candidate }), exported = await store.export(saved.id);
    assert.ok(Buffer.byteLength(exported) <= 65536); assert.deepEqual(JSON.parse(exported), candidate);
    const selected = path.join(dir, 'roundtrip.json'); await store.exportFile(saved.id, selected);
    assert.deepEqual(await store.importFile(selected), candidate);
  }));
}
module.exports = { runRunbookTests };
if (require.main === module) {
  let total = 0, failed = 0;
  runRunbookTests(async (name, fn) => { total++; try { await fn(); console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } })
    .then(() => { console.log(`\n${total - failed}/${total} runbook tests passed`); process.exitCode = failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
