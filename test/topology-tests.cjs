'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.resolve(__dirname, '..');
const loadTopology = () => require('../src/main/topology');
const topology = loadTopology();
const demo = () => JSON.parse(fs.readFileSync(path.join(REPO, 'assets/device-inspector-demo.json'), 'utf8'));
const options = { at: '2026-10-21T13:00:00.000Z', staleHours: 24 };
const neighbor = (name, port, address = '192.0.2.99') => `Device ID: ${name}\nIP address: ${address}\nInterface: ${port}, Port ID (outgoing port): Gi1/0/24\n`;
async function runTopologyTests(test) {
  await test('Topology canonical demo merges CDP/LLDP evidence without inventing physical or live links', () => {
    const graph = topology.buildTopology(demo(), options);
    assert.equal(graph.nodes.length, 2); assert.equal(graph.links.length, 2);
    assert.ok(graph.links.every(l => l.resolution === 'resolved' && l.evidence.length === 2 && l.protocols.includes('CDP') && l.protocols.includes('LLDP')));
    const source = graph.links[0].evidence[0];
    assert.equal(source.command, 'show cdp neighbors detail'); assert.equal(source.line, 2); assert.equal(source.excerpt, 'Device ID: edge-sw');
    assert.equal(source.complete, true); assert.ok(graph.nodes.every(n => n.age === 'within-threshold'));
    assert.equal(graph.coverage.completeGraph, true); assert.equal(graph.coverage.observationsComplete, true);
    assert.match(graph.links[0].meaning, /does not prove/);
  });
  await test('Topology conflicting hostname/address identity stays ambiguous and unrelated neighbors unresolved', () => {
    const input = demo();
    const third = structuredClone(input.devices[1]); third.id = 'duplicate-name'; third.host = '192.0.2.3'; input.devices.push(third);
    input.devices[0].commands.find(c => c.id === 'cdp').output += neighbor('outside', 'Gi1/0/22');
    const graph = topology.buildTopology(input, options);
    const ambiguous = graph.nodes.find(n => n.resolution === 'ambiguous');
    assert.deepEqual(ambiguous.candidateDeviceIds, ['demo-edge', 'duplicate-name']);
    assert.ok(graph.links.some(l => l.to === ambiguous.id && l.resolution === 'ambiguous'));
    assert.ok(graph.nodes.some(n => n.label === 'outside' && n.resolution === 'unresolved'));
    assert.ok(!graph.links.some(l => l.from === 'device:demo-core' && l.to === 'device:demo-edge'));
  });
  await test('Topology graph completeness is separate from missing, malformed and paginated command evidence', () => {
    const input = demo(); input.devices[0].commands = input.devices[0].commands.filter(c => c.id !== 'lldp');
    input.devices[0].commands.find(c => c.id === 'cdp').output += '\n--More--';
    const graph = topology.buildTopology(input, options);
    assert.equal(graph.coverage.completeGraph, true); assert.equal(graph.coverage.observationsComplete, false);
    assert.equal(graph.links.find(l => l.from === 'device:demo-core').evidence[0].complete, false);
    assert.ok(graph.nodes[0].coverage.some(c => c.commandId === 'lldp' && c.status === 'missing'));
    assert.ok(graph.nodes[0].warnings.length);
  });
  await test('Topology timestamps preserve mixed stale, missing and future observations', () => {
    const input = demo(); input.devices[0].collectedAt = null;
    input.devices[1].collectedAt = '2026-10-22T13:00:00Z';
    let graph = topology.buildTopology(input, options);
    assert.ok(graph.nodes.every(n => n.age === 'unknown')); assert.equal(graph.collectedAt, null);
    graph = topology.buildTopology(demo(), { ...options, at: '2026-10-23T12:00:00Z' });
    assert.ok(graph.links.every(l => l.age === 'stale'));
    assert.throws(() => topology.buildTopology(demo(), { at: 'invalid' }), /valid comparison/);
    for (const staleHours of [0, Infinity, '24', 8761]) assert.throws(() => topology.buildTopology(demo(), { staleHours }), /stale threshold/);
  });
  await test('Topology endpoint overlay uses canonical ARP/MAC paths and retains candidate uncertainty', () => {
    const graph = topology.buildTopology(demo(), { ...options, endpoint: '192.0.2.100' });
    assert.equal(graph.endpoint.queryType, 'ipv4'); assert.equal(graph.endpoint.matches.length, 2);
    assert.equal(graph.endpoint.arpEvidence[0].commandId, 'arp'); assert.equal(graph.endpoint.arpEvidence[0].line, 2); assert.equal(graph.endpoint.arpEvidence[0].mac, '00:11:22:33:44:55');
    assert.equal(graph.nodes.filter(n => n.kind === 'endpoint').length, 1);
    assert.equal(graph.links.filter(l => l.kind === 'forwarding').length, 2);
    assert.ok(graph.endpoint.paths.some(p => p.status === 'candidate-edge' && p.steps.length === 2));
    assert.ok(graph.links.filter(l => l.kind === 'forwarding').every(l => l.evidence[0].commandId === 'mac' && /unverified/.test(l.meaning)));
    const empty = topology.buildTopology(demo(), { ...options, endpoint: '192.0.2.250' });
    assert.equal(empty.endpoint.matches.length, 0); assert.match(empty.endpoint.warnings[0], /unknown/);
    assert.throws(() => topology.buildTopology(demo(), { endpoint: '<not an endpoint>' }), /IPv4 address/);
  });
  await test('Topology graph and endpoint bounds expose omissions instead of exporting an apparently complete map', () => {
    const input = demo();
    input.devices[0].commands.find(c => c.id === 'cdp').output = Array.from({ length: 1000 }, (_, i) => neighbor('unknown-' + i, 'Gi1/0/' + i)).join('\n');
    input.devices[0].commands.find(c => c.id === 'mac').output = Array.from({ length: 700 }, (_, i) => `10 0011.2233.4455 DYNAMIC Gi1/0/${i}`).join('\n');
    const graph = topology.buildTopology(input, { ...options, endpoint: '0011.2233.4455' });
    assert.ok(graph.nodes.length <= topology.LIMITS.nodes && graph.links.length <= topology.LIMITS.links);
    assert.ok(Buffer.byteLength(JSON.stringify(graph, null, 2)) <= topology.LIMITS.graphBytes);
    assert.equal(graph.coverage.completeGraph, false);
    assert.ok(graph.coverage.omittedNodes > 0 && graph.coverage.omittedLinks > 0 && graph.coverage.omittedTraceMatches > 0);
    assert.ok(graph.endpoint.warnings.some(w => /limited to 512/.test(w)), 'canonical trace bound is retained');
    assert.ok(graph.links.every(l => graph.nodes.some(n => n.id === l.from) && graph.nodes.some(n => n.id === l.to)), 'no dangling links');
  });
  await test('Topology export retains canonical raw evidence and validates input rather than trusting supplied facts', () => {
    const input = demo(); input.devices[0].facts = { neighbors: [{ deviceId: 'FORGED' }] };
    input.devices[0].commands[0].output += '\nRAW_EVIDENCE_SENTINEL\n';
    const exported = JSON.parse(topology.exportTopology(input, options));
    assert.equal(exported.kind, 'topology'); assert.equal(exported.sourceReport.kind, 'device');
    assert.ok(exported.sourceReport.devices[0].commands[0].output.includes('RAW_EVIDENCE_SENTINEL'));
    assert.ok(!exported.nodes.some(n => n.label === 'FORGED'));
    assert.equal(JSON.stringify(input).includes('FORGED'), true, 'caller report is not mutated');
    input.devices[0].commands.push({ id: 'execute', output: 'show version' });
    assert.throws(() => topology.buildTopology(input), /Unknown or duplicate/);
  });
}
module.exports = { runTopologyTests, loadTopology, REPO };
if (require.main === module) runTopologyTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch(error => { console.error(error); process.exitCode = 1; });
