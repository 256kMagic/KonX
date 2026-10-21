'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SnapshotStore, compareSnapshots, hostIdentity, MAX_FILE_BYTES, MAX_SNAPSHOTS } = require('../src/main/device-snapshots');
const { COMMANDS, INVENTORY_COMMANDS, SNAPSHOT_COMMANDS, commandsForProfile, analyzeDevice, analyzeDevices, configSections } = require('../src/main/device-analysis');
const { collectDevice } = require('../src/main/device-collector');
const { EventEmitter } = require('node:events');
const demo = require('../assets/device-snapshot-demo.json');
const fresh = () => structuredClone(demo);
const record = (report, id = 'test') => ({ id, label: id, savedAt: '2026-10-21T13:00:00Z', report });
const compare = input => compareSnapshots(record(input.before, 'before'), record(input.after, 'after'));
const cmd = (device, id) => device.commands.find(c => c.id === id);
async function inStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-snapshot-test-'));
  try { await fn(new SnapshotStore(dir), dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function runDeviceSnapshotTests(test) {
  console.log('device snapshots: storage, profiles and before/after observations');
  await test('snapshot profiles preserve inventory and require explicit configuration selection', async () => {
    assert.equal(INVENTORY_COMMANDS.length, 9); assert.equal(SNAPSHOT_COMMANDS.length, 11); assert.equal(COMMANDS.length, 11);
    assert.equal(commandsForProfile().length, 9); assert.equal(commandsForProfile('snapshot').length, 10);
    assert.equal(commandsForProfile('snapshot', true).length, 11); assert.equal(commandsForProfile('inventory', true).length, 9);
    assert.throws(() => commandsForProfile('arbitrary'), /profile/);
    const d = analyzeDevice([], { profile: 'snapshot' });
    assert.equal(d.coverage.some(c => c.commandId === 'routes'), true);
    assert.equal(d.coverage.some(c => c.commandId === 'runningConfig'), false);
    assert.equal(analyzeDevice([], { profile: 'snapshot', includeRunningConfig: true }).coverage.some(c => c.commandId === 'runningConfig'), true);
    assert.equal(analyzeDevice([]).port, null);
  });
  await test('snapshot collection executes configuration only after explicit opt-in', async () => {
    for (const includeRunningConfig of [false, true]) {
      const client = new EventEmitter(), channel = new EventEmitter(), writes = [];
      channel.stderr = new EventEmitter(); channel.destroy = () => channel.emit('close');
      channel.write = value => { const command = value.trim(); writes.push(command); queueMicrotask(() => channel.emit('data', Buffer.from(command + '\r\noutput\r\nswitch#'))); };
      client.shell = (_options, callback) => { callback(null, channel); queueMicrotask(() => channel.emit('data', Buffer.from('switch#'))); };
      const collected = await collectDevice({ client }, { id: 'live', profile: 'snapshot', includeRunningConfig, port: 22 }, { stopped: false }, { remaining: 1024 * 1024 }, { openTimeoutMs: 1000, commandTimeoutMs: 1000, settleMs: 1 });
      assert.equal(collected.commands.length, includeRunningConfig ? 11 : 10);
      assert.equal(writes.includes('show running-config'), includeRunningConfig);
      assert.equal(writes.includes('show ip route'), true);
      assert.equal(writes.includes('configure terminal'), false);
    }
  });
  await test('snapshot route parsing handles connected, OSPF external and ECMP evidence', () => {
    const d = analyzeDevice([{ id: 'routes', output: 'C 192.0.2.0/24 is directly connected, Vlan10\nO E2 198.51.100.0/24 [110/20] via 192.0.2.2, 00:00:01, GigabitEthernet1/0/1\n                    [110/20] via 192.0.2.3, 00:00:01, GigabitEthernet1/0/2\nS 203.0.113.0/24 [1/0] via 192.0.2.4\n', status: 'ok' }], { profile: 'snapshot' });
    assert.equal(d.facts.routes.length, 4);
    assert.equal(d.facts.routes[0].interface, 'Vl10'); assert.equal(d.facts.routes[0].nextHop, null);
    assert.equal(d.facts.routes[1].protocol, 'O E2'); assert.equal(d.facts.routes[2].nextHop, '192.0.2.3');
    assert.equal(d.facts.routes[2].source.line, 3); assert.equal(d.facts.routes[3].interface, null);
  });
  await test('snapshot configuration facts contain counts but no configuration values', () => {
    const secret = 'FAKE_PRIVATE_VALUE';
    const d = analyzeDevice([{ id: 'runningConfig', output: 'hostname lab\nusername user secret ' + secret + '\ninterface Gi1/0/1\n description private desk\n!\nend\n', status: 'ok' }], { profile: 'snapshot', includeRunningConfig: true });
    assert.equal(d.facts.configSummary.sectionCount, 3); assert.equal(d.facts.configSummary.lineCount, 4);
    assert.equal(JSON.stringify(d.facts).includes(secret), false);
    assert.equal(JSON.stringify(d.facts).includes('private desk'), false);
    assert.equal(d.commands[0].output.includes(secret), true);
  });
  await test('snapshot store round-trips immutable reports and collection timestamps', async () => inStore(async store => {
    const data = fresh(), first = await store.save({ label: 'Before maintenance', report: data.before });
    const second = await store.save({ label: 'After maintenance', report: data.after });
    assert.notEqual(first.id, second.id); assert.equal(first.includesConfiguration, true); assert.equal(first.deviceCount, 2);
    const value = await store.get(first.id);
    assert.equal(value.report.collectedAt, data.before.collectedAt); assert.equal(value.report.devices[0].port, 22);
    assert.equal(value.report.devices[0].commands.length, 11);
    const listed = await store.list(); assert.equal(listed.snapshots.length, 2); assert.deepEqual(listed.issues, []);
    const comparison = compareSnapshots(value, await store.get(second.id));
    assert.equal(comparison.summary.comparedDevices, 2); assert.equal(comparison.summary.unknown, 0);
    assert.equal(comparison.changes.some(c => c.category === 'configuration'), true);
    await store.remove(first.id); assert.equal((await store.list()).snapshots.length, 1);
    await assert.rejects(store.get(first.id), /ENOENT/);
  }));
  await test('snapshot read reanalyzes source instead of trusting stored facts', async () => inStore(async store => {
    const saved = await store.save({ label: 'Untrusted facts', report: fresh().before });
    const file = path.join(store.directory, saved.id + '.json');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    value.report.devices[0].facts.interfaces[0].status = 'forged-status';
    await fs.writeFile(file, JSON.stringify(value));
    const loaded = await store.get(saved.id);
    assert.equal(loaded.report.devices[0].facts.interfaces[0].status, 'connected');
  }));
  await test('snapshot malformed and foreign files are surfaced without losing healthy entries', async () => inStore(async store => {
    const saved = await store.save({ label: 'Healthy', report: fresh().before });
    const corrupt = crypto.randomUUID(); await fs.writeFile(path.join(store.directory, corrupt + '.json'), '{invalid');
    await fs.writeFile(path.join(store.directory, 'foreign.json'), '{}');
    const list = await store.list(); assert.equal(list.snapshots.length, 1); assert.equal(list.snapshots[0].id, saved.id);
    assert.equal(list.issues.length, 2); assert.match(list.issues.find(i => i.id === corrupt).message, /malformed/);
    await store.remove(corrupt); assert.equal((await store.list()).issues.length, 1);
  }));
  await test('snapshot paths, symlinks and file byte limits fail closed', async () => inStore(async (store, directory) => {
    const saved = await store.save({ label: 'Original', report: fresh().before });
    await assert.rejects(store.get('../outside'), /identifier/); await assert.rejects(store.remove('..\\outside'), /identifier/);
    const oversized = crypto.randomUUID(), handle = await fs.open(path.join(store.directory, oversized + '.json'), 'w');
    await handle.truncate(MAX_FILE_BYTES + 1); await handle.close();
    await assert.rejects(store.get(oversized), /20 MiB/);
    const linked = crypto.randomUUID(), target = path.join(directory, 'outside'); await fs.writeFile(target, 'outside');
    try { await fs.symlink(target, path.join(store.directory, linked + '.json')); }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    if (await fs.lstat(path.join(store.directory, linked + '.json')).catch(() => null)) {
      await assert.rejects(store.get(linked), /regular file/); await assert.rejects(store.remove(linked), /regular file/);
    }
    assert.equal((await store.get(saved.id)).label, 'Original'); assert.equal(await fs.readFile(target, 'utf8'), 'outside');
  }));
  await test('snapshot failed publication preserves existing files and cleans owned temporary files', async () => inStore(async (store, directory) => {
    const original = await store.save({ label: 'Original', report: fresh().before });
    const originalBytes = await fs.readFile(path.join(store.directory, original.id + '.json'));
    const broken = new SnapshotStore(directory, { fs: { ...fs, link: async () => { throw new Error('Synthetic publication failure'); } } });
    await assert.rejects(broken.save({ label: 'New', report: fresh().after }), /Synthetic publication failure/);
    assert.deepEqual(await fs.readdir(store.directory), [original.id + '.json']);
    assert.deepEqual(await fs.readFile(path.join(store.directory, original.id + '.json')), originalBytes);
  }));
  await test('snapshot save serializes capacity checks and refuses a full store', async () => inStore(async store => {
    await store.ready();
    for (let i = 0; i < MAX_SNAPSHOTS; i++) await fs.writeFile(path.join(store.directory, crypto.randomUUID() + '.json'), '{}');
    await assert.rejects(store.save({ label: 'Overflow', report: fresh().before }), /500-file limit/);
    assert.equal((await fs.readdir(store.directory)).length, MAX_SNAPSHOTS);
  }));
  await test('snapshot comparison separates state changes and counter deltas', () => {
    const comparison = compare(fresh());
    assert.deepEqual(comparison.summary, { added: 4, removed: 4, changed: 4, unknown: 0, comparedDevices: 2 });
    const iface = comparison.changes.find(c => c.category === 'interfaces');
    assert.equal(iface.before.status, 'connected'); assert.equal(iface.after.status, 'disabled');
    assert.equal(iface.counterDeltas.inputErrors.delta, 6); assert.equal(iface.counterDeltas.crc.delta, 3);
    assert.deepEqual(iface.beforeSource, { deviceId: 'demo-edge', commandId: 'interfaces', line: 1 });
  });
  await test('snapshot decreasing counters are reset-or-wrap observations, not negative traffic', () => {
    const data = fresh(); cmd(data.after.devices[1], 'interfaces').output = cmd(data.after.devices[1], 'interfaces').output.replace('18 input errors, 12 CRC', '2 input errors, 1 CRC');
    const iface = compare(data).changes.find(c => c.category === 'interfaces');
    assert.equal(iface.counterDeltas.crc.delta, null); assert.match(iface.counterDeltas.crc.reason, /reset or wrap/);
  });
  await test('snapshot missing and partial command coverage is unknown rather than removals', () => {
    const data = fresh();
    for (const d of data.after.devices) { d.commands = d.commands.filter(c => !['routes', 'runningConfig'].includes(c.id)); cmd(d, 'interfaceStatus').status = 'timeout'; }
    const comparison = compare(data);
    assert.equal(comparison.changes.some(c => ['routes', 'configuration', 'interfaces'].includes(c.category) && c.status !== 'unknown'), false);
    assert.equal(comparison.summary.unknown, 6); assert.equal(comparison.devices.every(d => d.status === 'partial'), true);
  });
  await test('snapshot mixed recognized and unsupported rows cannot manufacture removals', () => {
    const cases = [
      ['interfaces', 'interfaceStatus', output => output.replace('connected    trunk', 'unknown-state trunk')],
      ['vlans', 'vlans', output => output.replace('Demo-clients                     active', 'Demo-clients                     unfamiliar')],
      ['routes', 'routes', output => output.replace('S* 0.0.0.0/0 [1/0] via 192.0.2.253', 'S* 0.0.0.0/0 unsupported next-hop syntax')],
      ['neighbors', 'cdp', output => output + '\n-------------------------\nDevice ID: partial-peer\nInterface: Gi1/0/8, unsupported port layout\n'],
      ['configuration', 'runningConfig', output => output.replace(/\nend\n$/, '\n')],
    ];
    for (const [category, id, mutate] of cases) {
      const data = fresh(), d = data.after.devices[1]; cmd(d, id).output = mutate(cmd(d, id).output);
      const analyzed = analyzeDevices(data.after).devices[1];
      assert.equal(analyzed.coverage.find(c => c.commandId === id).complete, false, id);
      assert.equal(analyzed.coverage.find(c => c.commandId === id).recognizedRows > 0, true, id);
      const changes = compare(data).changes.filter(c => c.deviceId === d.id && c.category === category);
      assert.equal(changes.length, 1, id); assert.equal(changes[0].status, 'unknown', id);
    }
  });
  await test('snapshot unknown legacy ports and duplicate host identities require explicit pairing', () => {
    const data = fresh();
    data.before.devices[0].port = null; data.after.devices[0].port = null;
    let comparison = compare(data); assert.equal(comparison.summary.comparedDevices, 1); assert.equal(comparison.unmatched.length, 2);
    comparison = compareSnapshots(record(data.before), record(data.after), [{ beforeDeviceId: 'demo-core', afterDeviceId: 'demo-core' }]);
    assert.equal(comparison.summary.comparedDevices, 2); assert.equal(comparison.devices[0].pairing, 'manual');
    const duplicate = structuredClone(data.before.devices[1]); duplicate.id = 'duplicate'; data.before.devices.push(duplicate);
    assert.equal(compare(data).summary.comparedDevices, 0);
    assert.throws(() => compareSnapshots(record(data.before), record(data.after), [{ beforeDeviceId: 'missing', afterDeviceId: 'demo-core' }]), /distinct devices/);
    assert.equal(hostIdentity({ host: 'SWITCH.EXAMPLE.', port: 22 }), 'switch.example|22');
    assert.equal(hostIdentity({ host: '2001:0db8:0:0:0:0:0:1', port: 22 }), '2001:db8::1|22');
  });
  await test('snapshot duplicate row and configuration identities stay ambiguous', () => {
    const data = fresh();
    cmd(data.after.devices[0], 'routes').output += 'C 192.0.2.0/24 is directly connected, Vlan10\n';
    cmd(data.after.devices[0], 'runningConfig').output += 'hostname duplicate-host\n';
    const result = compare(data);
    assert.equal(result.changes.some(c => c.category === 'routes' && c.status === 'unknown'), true);
    assert.equal(result.changes.some(c => c.category === 'configuration' && c.identity === 'hostname' && c.status === 'unknown'), true);
  });
  await test('snapshot configuration sections keep banner bodies and ignore generated timestamps', () => {
    const banner = 'banner motd ^C\ninterface this-is-banner-text\nDo not parse me as a device interface\n^C\n!\ninterface Gi1/0/1\n description Real\n!\nend\n';
    const sections = configSections(banner); assert.equal(sections.length, 2); assert.equal(sections[0].lines.length, 4); assert.equal(sections[1].key, 'interface Gi1/0/1');
    const data = fresh(); data.after = structuredClone(data.before);
    for (const d of data.after.devices) { cmd(d, 'runningConfig').output = cmd(d, 'runningConfig').output.replace('11:00:00', '19:59:59'); cmd(d, 'version').output = cmd(d, 'version').output.replace('2 weeks', '3 weeks'); }
    assert.equal(compare(data).changes.length, 0);
  });
  await test('snapshot compare warns when chronology is reversed and never trusts forged parsed values', () => {
    const data = fresh();
    for (const d of data.after.devices) { d.collectedAt = '2020-01-01T00:00:00Z'; d.facts = { routes: [{ prefix: 'forged' }] }; }
    const result = compare(data); assert.equal(result.devices.every(d => d.warnings.some(w => /older/.test(w))), true);
    assert.equal(JSON.stringify(result).includes('forged'), false);
  });
}
module.exports = { runDeviceSnapshotTests };
if (require.main === module) {
  let failed = 0, total = 0;
  runDeviceSnapshotTests(async (name, fn) => { total++; try { await fn(); console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } })
    .then(() => { console.log(`${total - failed}/${total} snapshot tests passed`); process.exitCode = failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
