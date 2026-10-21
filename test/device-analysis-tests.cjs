'use strict';
const assert = require('node:assert/strict');
const { COMMANDS, LIMITS, analyzeDevice, analyzeDevices, traceEndpoint, normalizeInterface, normalizeMac } = require('../src/main/device-analysis');
const demo = require('../assets/device-inspector-demo.json');
const fresh = () => structuredClone(demo);
const command = (id, output, status = 'ok') => ({ id, output, status });
const device = (id, commands, host = '') => ({ id, label: id, host, commands });
const report = devices => analyzeDevices({ devices });
const cmd = (d, id) => d.commands.find(c => c.id === id);

async function runDeviceAnalysisTests(test) {
  console.log('device inspector: source parsing and candidate endpoint paths');
  await test('device demo parses nine commands with original source references', () => {
    const r = analyzeDevices(fresh());
    assert.equal(r.kind, 'device'); assert.equal(r.schemaVersion, 1); assert.equal(r.devices.length, 2);
    const core = r.devices[0], edge = r.devices[1];
    assert.equal(core.facts.version.hostname, 'core-sw');
    assert.equal(core.facts.version.version, '17.12.04');
    assert.equal(core.facts.version.model, 'C9300-24P');
    assert.equal(edge.facts.interfaces.find(p => p.name === 'Gi1/0/7').crc, 9);
    assert.equal(edge.facts.interfaces.find(p => p.name === 'Gi1/0/7').vlan, '10');
    assert.equal(edge.facts.poe.find(p => p.interface === 'Gi1/0/7').powerWatts, 6.3);
    assert.equal(core.facts.neighbors.length, 2);
    assert.equal(core.facts.neighbors[1].managementAddress, '192.0.2.2');
    assert.equal(core.facts.arp[0].source.line, 2);
    assert.match(cmd(core, 'arp').output.split('\n')[core.facts.arp[0].source.line - 1], /192\.0\.2\.100/);
    assert.equal(edge.coverage.every(c => c.complete && c.recognizedRows > 0), true);
    assert.equal(edge.warnings.length, 0);
  });
  await test('device IP trace follows selected switches and retains candidate status', () => {
    const r = analyzeDevices(fresh()), trace = traceEndpoint(r.devices, '192.0.2.100');
    assert.equal(trace.matches.length, 2); assert.equal(trace.paths.length, 1);
    assert.deepEqual(trace.paths[0].steps.map(s => [s.deviceId, s.interface]), [['demo-core', 'Gi1/0/24'], ['demo-edge', 'Gi1/0/7']]);
    assert.equal(trace.paths[0].status, 'candidate-edge'); assert.match(trace.paths[0].reason, /unverified/);
    assert.equal(trace.matches[0].classification, 'observed-uplink');
    assert.match(trace.matches[1].warnings.join(' '), /not proof/);
    assert.deepEqual(traceEndpoint(r.devices, '0011.2233.4455').matches, trace.matches);
  });
  await test('device interface and MAC normalization uses complete identities', () => {
    assert.equal(normalizeInterface('GigabitEthernet 1/0/7'), 'Gi1/0/7');
    assert.equal(normalizeInterface('Port-channel12'), 'Po12');
    assert.equal(normalizeInterface('TwentyFiveGigE1/0/1'), 'Twe1/0/1');
    assert.equal(normalizeInterface('HundredGigE1/0/1'), 'Hu1/0/1');
    assert.equal(normalizeInterface('Vlan100'), 'Vl100');
    assert.equal(normalizeInterface('UnknownName1'), 'UnknownName1');
    for (const value of ['00:AA:BB:CC:DD:EE', '00-AA-BB-CC-DD-EE', '00aabbccddee', '00aa.bbcc.ddee']) assert.equal(normalizeMac(value), '00:aa:bb:cc:dd:ee');
    for (const value of ['0011.2233.44', '00-11:22-33:44-55', 'xx:11:22:33:44:55', '']) assert.equal(normalizeMac(value), null);
  });
  await test('device parser handles ANSI, CRLF, wrapped VLAN ports and unset fields', () => {
    const d = analyzeDevice([
      command('interfaces', '\x1b[32mGigabitEthernet1/0/1 is administratively down, line protocol is down\x1b[0m\r\n  Description: Empty desk\r\n'),
      command('interfaceStatus', 'Gi1/0/2                        notconnect   12         auto   auto 10/100/1000BaseTX\n'),
      command('vlans', '12   Long client VLAN name           active    Gi1/0/1, Gi1/0/2\n                                                Gi1/0/3, Gi1/0/4\n'),
      command('arp', 'Internet 192.0.2.50 0 Incomplete ARPA\nInternet 192.0.2.51 - 0011.2233.4455 ARPA Vlan12\n'),
    ], { id: 'parser' });
    assert.equal(d.facts.interfaces[0].status, 'administratively down'); assert.equal(d.facts.interfaces[0].crc, null);
    assert.equal(d.facts.interfaces[1].description, null);
    assert.equal(d.facts.interfaces[1].status, 'notconnect');
    assert.deepEqual(d.facts.vlans[0].ports, ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Gi1/0/4']);
    assert.equal(d.facts.arp[0].mac, null); assert.equal(d.facts.arp[0].incomplete, true); assert.equal(d.facts.arp[0].interface, null);
    assert.equal(d.facts.arp[1].age, null);
  });
  await test('device partial and paginated output preserve rows without asserting completeness', () => {
    const d = analyzeDevice([
      command('mac', '10 0011.2233.4455 DYNAMIC Gi1/0/1\n --More--\n'),
      command('arp', 'Internet 192.0.2.100 1 0011.2233.4455 ARPA Vlan10\n', 'truncated'),
      command('cdp', '% Invalid input detected at marker.\nDevice ID: forged\nInterface: Gi1/0/1, Port ID (outgoing port): Gi1/0/2\n'),
      { ...command('lldp', '', 'error'), error: 'Exec rejected' },
    ], { id: 'partial' });
    assert.equal(d.facts.mac.length, 1); assert.equal(d.facts.arp.length, 1); assert.equal(d.facts.neighbors.length, 0);
    assert.equal(d.coverage.filter(c => c.complete).length, 0);
    assert.match(d.warnings.join(' '), /pagination.*incomplete/); assert.match(d.warnings.join(' '), /rejected/);
    assert.match(traceEndpoint([d], '192.0.2.100').warnings.join(' '), /incomplete/);
  });
  await test('device missing and unsupported output stays unknown', () => {
    const d = analyzeDevice([command('version', 'Vendor unsupported version output'), command('mac', 'Unfamiliar MAC layout')], { id: 'empty' });
    assert.deepEqual(d.facts.version, {}); assert.equal(d.facts.mac.length, 0);
    assert.equal(d.coverage.filter(c => c.status === 'missing').length, 7);
    assert.equal(d.coverage.some(c => c.complete), false);
    assert.match(d.warnings.join(' '), /no supported data rows/);
    assert.match(traceEndpoint([d], '192.0.2.1').warnings[0], /unknown/);
    assert.match(traceEndpoint([d], '0011.2233.4455').warnings.join(' '), /does not prove/);
  });
  await test('device neighbor blocks keep their own ports, names and source lines', () => {
    const d = analyzeDevice([command('lldp', [
      'Local Intf: Gi1/0/1', 'Port id: GigabitEthernet1/0/20', 'System Name: first', 'Management Addresses:', ' IP: 192.0.2.10',
      '------------------------------------------------', 'Local Intf: Gi1/0/2', 'Port id: Te1/0/2', 'System Name: second', 'Management Addresses:', ' IP: 192.0.2.11',
    ].join('\n'))], { id: 'lldp' });
    assert.equal(d.facts.neighbors.length, 2);
    assert.deepEqual(d.facts.neighbors.map(n => [n.deviceId, n.localInterface, n.remoteInterface, n.source.line]), [['first', 'Gi1/0/1', 'Gi1/0/20', 1], ['second', 'Gi1/0/2', 'Te1/0/2', 7]]);
  });
  await test('device import rejects unknown commands, duplicate IDs, bad statuses and excess bytes', () => {
    for (const invalid of [null, {}, { devices: [] }, { devices: Array(17).fill(device('x', [])) }]) assert.throws(() => analyzeDevices(invalid));
    assert.throws(() => analyzeDevice([command('writeErase', '')]), /Unknown/);
    assert.throws(() => analyzeDevice([command('mac', ''), command('mac', '')]), /duplicate/);
    assert.throws(() => analyzeDevice([{ id: 'mac', command: 'reload', output: '', status: 'ok' }]), /does not match/);
    assert.throws(() => analyzeDevice([command('mac', '', 'success')]), /status/);
    assert.throws(() => analyzeDevice([command('mac', 'é'.repeat(LIMITS.commandBytes / 2 + 1))]), /limit/);
    assert.throws(() => analyzeDevice([command('mac', '\n'.repeat(LIMITS.lines))]), /lines/);
    assert.throws(() => report([device('same', []), device('same', [])]), /unique/);
    const large = ' '.repeat(LIMITS.commandBytes);
    assert.throws(() => report([device('large', COMMANDS.map(c => command(c.id, large)))]), /total output limit/);
    assert.throws(() => analyzeDevice([command('mac', Array(LIMITS.rows + 1).fill('10 0011.2233.4455 DYNAMIC Gi1/0/1').join('\n'))]), /row limit/);
  });
  await test('device import retains literal content while excluding unrelated metadata and forged facts', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const raw = `GigabitEthernet1/0/1 is up, line protocol is up\n  Description: ${payload}\n`;
    const d = analyzeDevices({ devices: [{ id: 'literal', label: payload, commands: [command('interfaces', raw)], password: 'synthetic-secret', facts: { fake: true } }] }).devices[0];
    assert.equal(d.facts.interfaces[0].description, payload); assert.equal(d.label, payload); assert.equal(d.commands[0].output, raw);
    assert.equal(d.password, undefined); assert.equal(d.facts.fake, undefined);
    const roundtrip = analyzeDevices(JSON.parse(JSON.stringify({ devices: [d] })));
    assert.deepEqual(roundtrip.devices[0], d);
  });
  await test('device reanalysis preserves collection timestamps and leaves unknown times unknown', () => {
    const input = fresh(); input.collectedAt = '2026-10-21T12:00:05.000Z';
    const first = analyzeDevices(input), second = analyzeDevices(JSON.parse(JSON.stringify(first)));
    assert.equal(first.collectedAt, input.collectedAt); assert.equal(second.collectedAt, input.collectedAt);
    assert.deepEqual(second.devices.map(d => d.collectedAt), first.devices.map(d => d.collectedAt));
    assert.equal(analyzeDevices(fresh()).collectedAt, '2026-10-21T12:00:03.000Z');
    assert.equal(report([device('undated', [])]).collectedAt, null);
    assert.throws(() => analyzeDevices({ devices: [device('a', [])], collectedAt: 'today' }), /collection time/);
  });
  await test('device MAC rows retain every comma-separated forwarding port', () => {
    const d = analyzeDevice([command('mac', '10 0011.2233.4455 DYNAMIC Gi1/0/1, Gi1/0/2, Gi1/0/3\n')], { id: 'multiport' });
    assert.deepEqual(d.facts.mac.map(m => m.interface), ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3']);
  });
  await test('device counters preserve exact values beyond JavaScript integer precision', () => {
    const d = analyzeDevice([command('interfaces', 'GigabitEthernet1/0/1 is up, line protocol is up\n  9007199254740993 input errors, 0 CRC\n  9007199254740995 output errors\n')]);
    assert.equal(d.facts.interfaces[0].inputErrors, '9007199254740993');
    assert.equal(d.facts.interfaces[0].outputErrors, '9007199254740995');
    assert.equal(d.facts.interfaces[0].crc, 0);
  });
  await test('device ambiguous ARP identities and forwarding ports are all retained', () => {
    const input = fresh();
    cmd(input.devices[0], 'arp').output += 'Internet 192.0.2.100 1 0066.7788.9900 ARPA Vlan10\n';
    cmd(input.devices[1], 'mac').output += '10 0011.2233.4455 DYNAMIC Gi1/0/8\n10 0066.7788.9900 DYNAMIC Gi1/0/9\n';
    const trace = traceEndpoint(analyzeDevices(input).devices, '192.0.2.100');
    assert.equal(trace.macs.length, 2); assert.equal(trace.matches.length, 4);
    assert.match(trace.warnings.join(' '), /More than one MAC/);
    assert.equal(trace.paths.some(p => p.status === 'ambiguous' && /Multiple forwarding/.test(p.reason)), true);
  });
  await test('device port channels and non-port MAC rows do not become endpoint claims', () => {
    const r = report([device('channel', [command('mac', '10 0011.2233.4455 DYNAMIC Po10\nAll 0066.7788.9900 STATIC CPU\n')])]);
    const channel = traceEndpoint(r.devices, '0011.2233.4455');
    assert.equal(channel.matches[0].classification, 'unresolved-port-channel'); assert.equal(channel.paths[0].status, 'incomplete');
    const cpu = traceEndpoint(r.devices, '0066.7788.9900'); assert.equal(cpu.matches[0].classification, 'ambiguous'); assert.equal(cpu.paths[0].status, 'ambiguous');
  });
  await test('device incomplete paths never infer an inaccessible neighbor or cross VLANs', () => {
    const input = fresh();
    let trace = traceEndpoint(report([input.devices[0]]).devices, '192.0.2.100');
    assert.equal(trace.paths[0].status, 'incomplete'); assert.match(trace.paths[0].reason, /could not be identified/);
    cmd(input.devices[1], 'mac').output = '20 0011.2233.4455 DYNAMIC Gi1/0/7\n';
    trace = traceEndpoint(analyzeDevices(input).devices, '192.0.2.100');
    assert.equal(trace.paths.some(p => p.vlan === 10 && p.status === 'incomplete'), true);
    assert.equal(trace.paths.some(p => p.vlan === 20 && p.steps.length === 1), true);
    assert.equal(trace.paths.some(p => p.steps.length === 2), false);
  });
  await test('device contradictory neighbor identities remain ambiguous', () => {
    const input = fresh();
    const duplicate = structuredClone(input.devices[1]); duplicate.id = 'edge-duplicate'; duplicate.host = '192.0.2.9';
    input.devices.push(duplicate);
    const trace = traceEndpoint(analyzeDevices(input).devices, '192.0.2.100');
    assert.equal(trace.paths[0].status, 'ambiguous'); assert.match(trace.paths[0].reason, /multiple selected devices/);
  });
  await test('device contradictory CDP and LLDP peer ports remain ambiguous', () => {
    const input = fresh();
    cmd(input.devices[0], 'lldp').output = cmd(input.devices[0], 'lldp').output.replace('Port id: Gi1/0/24', 'Port id: Gi1/0/23');
    const trace = traceEndpoint(analyzeDevices(input).devices, '192.0.2.100');
    assert.equal(trace.paths[0].status, 'ambiguous'); assert.match(trace.paths[0].reason, /disagree about the remote port/);
    assert.equal(trace.paths[0].steps[0].remoteDeviceId, null);
  });
  await test('device cycles terminate and remain visible beside unrelated candidate paths', () => {
    const input = fresh();
    cmd(input.devices[1], 'mac').output = '10 0011.2233.4455 DYNAMIC Gi1/0/24\n';
    input.devices.push(device('isolated', [command('mac', '10 0011.2233.4455 DYNAMIC Gi1/0/3\n')]));
    const trace = traceEndpoint(analyzeDevices(input).devices, '192.0.2.100');
    assert.equal(trace.paths.some(p => p.status === 'cycle'), true);
    assert.equal(trace.paths.some(p => p.status === 'candidate-edge'), true);
    assert.ok(trace.paths.every(p => p.steps.length <= input.devices.length));
  });
  await test('device trace rejects invalid endpoint input without broadening its search', () => {
    const devices = analyzeDevices(fresh()).devices;
    for (const query of ['', 'host.example', '192.0.2.999', '192.0.2.0/24', '2001:db8::1', '0011.2233', '1;show run']) assert.throws(() => traceEndpoint(devices, query), /IPv4 address or a complete MAC/);
    assert.throws(() => traceEndpoint([], '192.0.2.1'), /collection/);
    assert.throws(() => traceEndpoint([{ id: 'not-analyzed' }], '192.0.2.1'), /Analyze/);
  });
}

module.exports = { runDeviceAnalysisTests };
if (require.main === module) {
  let failed = 0, total = 0;
  runDeviceAnalysisTests(async (name, fn) => { total++; try { await fn(); console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } })
    .then(() => { console.log(`${total - failed}/${total} device analysis tests passed`); process.exitCode = failed ? 1 : 0; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
