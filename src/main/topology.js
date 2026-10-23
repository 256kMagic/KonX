'use strict';

const crypto = require('node:crypto');
const { analyzeDevices, traceEndpoint } = require('./device-analysis');
const LIMITS = Object.freeze({ nodes: 256, links: 512, evidencePerLink: 16, traceMatches: 128, tracePaths: 32, graphBytes: 256 * 1024, exportBytes: 20 * 1024 * 1024 });
const identity = value => String(value || '').trim().replace(/\.$/, '').toLowerCase();
const size = value => Buffer.byteLength(JSON.stringify(value, null, 2));
const cost = value => { const json = JSON.stringify(value, null, 2); return Buffer.byteLength(json) + 12 * (json.match(/\n/g)?.length || 0); };

/** All interpretation belongs to device-analysis. This layer joins its facts and
 * retains evidence references; it never collects devices or parses CLI layouts. */
function derive(report, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid topology options.');
  const at = options.at === undefined ? Date.now() : typeof options.at === 'string' ? Date.parse(options.at) : NaN;
  const staleHours = options.staleHours === undefined ? 24 : options.staleHours;
  if (!Number.isFinite(at) || !Number.isFinite(staleHours) || staleHours < 1 || staleHours > 8760) throw new Error('Choose a valid comparison time and stale threshold from 1 to 8760 hours.');
  const age = time => !time || Date.parse(time) > at ? 'unknown' : at - Date.parse(time) > staleHours * 3600000 ? 'stale' : 'within-threshold';
  const coverage = { bounded: true, omittedNodes: 0, omittedLinks: 0, omittedEvidence: 0, omittedArpEvidence: 0, omittedTraceMatches: 0, omittedTracePaths: 0, clippedFields: 0, omittedWarnings: 0,
    observationsComplete: report.devices.every(d => ['cdp', 'lldp', 'interfaces', 'interfaceStatus'].every(id => d.coverage.some(c => c.commandId === id && c.complete))), completeGraph: true };
  const clip = (value, limit = 256) => { if (typeof value !== 'string') return value ?? null; if (value.length <= limit) return value; coverage.clippedFields++; return value.slice(0, limit) + '\u2026'; };
  // Reserve 16 KiB for metadata, coverage and fixed limitations. Every retained
  // graph object consumes its serialized size, including merged evidence.
  let bytes = 0;
  const reserve = amount => { if (bytes + amount > LIMITS.graphBytes - 16384) return false; bytes += amount; return true; };
  const traced = options.endpoint !== undefined && options.endpoint !== '' ? traceEndpoint(report.devices, options.endpoint) : null;
  const endpoint = traced ? { query: traced.query, queryType: traced.queryType, macs: traced.macs.slice(0, 128), arpEvidence: [], matches: [], paths: [], warnings: traced.warnings.map(w => clip(w, 512)) } : null;
  if (endpoint) reserve(cost(endpoint) + 2);
  const nodes = [], links = [], lookup = new Map(), linkMap = new Map(), omittedNodeIds = new Set(), omittedLinkIds = new Set(), rawLines = new Map();
  const addNode = node => {
    if (lookup.has(node.id)) return lookup.get(node.id);
    if (nodes.length >= LIMITS.nodes || !reserve(cost(node) + 2)) { omittedNodeIds.add(node.id); return null; }
    lookup.set(node.id, node); nodes.push(node); return node;
  };
  const source = (device, ref) => {
    const command = device.commands.find(c => c.id === ref.commandId);
    const key = JSON.stringify([device.id, ref.commandId]);
    if (!rawLines.has(key)) rawLines.set(key, command?.output.split(/\r\n|\n|\r/) || []);
    return { deviceId: device.id, collectedAt: device.collectedAt, commandId: ref.commandId, command: command?.command || ref.commandId, line: ref.line,
      excerpt: clip(rawLines.get(key)[ref.line - 1] || '', 160), complete: device.coverage.find(c => c.commandId === ref.commandId)?.complete === true };
  };
  if (traced?.queryType === 'ipv4') for (const device of report.devices) for (const row of device.facts.arp) {
    if (row.ip !== traced.query || !row.mac) continue;
    const evidence = { ...source(device, row.source), ip: row.ip, mac: row.mac };
    if (endpoint.arpEvidence.length < 32 && reserve(cost(evidence) + 1)) endpoint.arpEvidence.push(evidence); else coverage.omittedArpEvidence++;
  }
  for (const device of report.devices) {
    coverage.omittedWarnings += Math.max(0, device.warnings.length - 5);
    addNode({ id: 'device:' + device.id, kind: 'device', deviceId: device.id, label: device.label, hostname: clip(device.facts.version.hostname), host: device.host || null,
      connectionId: device.connectionId, collectedAt: device.collectedAt, age: age(device.collectedAt), interfaceCount: device.facts.interfaces.length,
      warnings: device.warnings.slice(0, 5).map(w => clip(w, 512)), coverage: device.coverage });
  }
  const addLink = (link, ports = [link.localInterface, link.remoteInterface]) => {
    const key = JSON.stringify([link.kind, link.from, ports[0], link.to, ports[1]]);
    const prior = linkMap.get(key);
    if (prior) {
      for (const protocol of link.protocols) if (!prior.protocols.includes(protocol)) {
        if (reserve(cost(protocol) + 1)) prior.protocols.push(protocol); else coverage.omittedEvidence++;
      }
      for (const evidence of link.evidence) {
        if (prior.evidence.some(e => e.deviceId === evidence.deviceId && e.commandId === evidence.commandId && e.line === evidence.line)) continue;
        if (prior.evidence.length < LIMITS.evidencePerLink && reserve(cost(evidence) + 1)) prior.evidence.push(evidence); else coverage.omittedEvidence++;
      }
      return;
    }
    link.id = 'link:' + links.length;
    if (links.length >= LIMITS.links || !reserve(cost(link) + 2)) { omittedLinkIds.add(key); return; }
    linkMap.set(key, link); links.push(link);
  };
  for (const device of report.devices) for (const neighbor of device.facts.neighbors) {
    // Union conflicting address and hostname candidates; never choose the first.
    const candidates = report.devices.filter(other => other.id !== device.id &&
      (neighbor.managementAddress && identity(other.host) === identity(neighbor.managementAddress) ||
       neighbor.deviceId && [other.host, other.facts.version.hostname].filter(Boolean).some(value => identity(value) === identity(neighbor.deviceId))));
    const resolution = candidates.length === 1 ? 'resolved' : candidates.length ? 'ambiguous' : 'unresolved';
    const neighborKey = JSON.stringify([device.id, neighbor.localInterface, neighbor.managementAddress, neighbor.deviceId]);
    const targetId = candidates.length === 1 ? 'device:' + candidates[0].id : 'neighbor:' + crypto.createHash('sha256').update(neighborKey).digest('hex');
    const target = candidates.length === 1 ? lookup.get(targetId) : addNode({
      id: targetId, kind: 'neighbor',
      label: clip(neighbor.deviceId || neighbor.managementAddress || 'Unknown neighbor'), host: clip(neighbor.managementAddress), resolution,
      candidateDeviceIds: candidates.map(d => d.id), collectedAt: device.collectedAt, age: age(device.collectedAt) });
    if (!target || !lookup.has('device:' + device.id)) { omittedLinkIds.add(JSON.stringify(['neighbor', 'device:' + device.id, neighbor.localInterface, targetId, neighbor.remoteInterface])); continue; }
    const local = device.facts.interfaces.find(row => row.name === neighbor.localInterface);
    addLink({ kind: 'neighbor', from: 'device:' + device.id, to: target.id, localInterface: clip(neighbor.localInterface), remoteInterface: clip(neighbor.remoteInterface),
      protocols: [neighbor.protocol], resolution, localState: clip(local?.status), age: age(device.collectedAt), collectedAt: device.collectedAt,
      evidence: [source(device, neighbor.source)], meaning: 'Observed neighbor advertisement; does not prove current physical connectivity.' }, [neighbor.localInterface, neighbor.remoteInterface]);
  }
  if (traced) {
    for (const match of traced.matches) {
      const device = report.devices.find(d => d.id === match.deviceId);
      const compact = { ...match, deviceLabel: clip(match.deviceLabel), host: clip(match.host), interface: clip(match.interface), portStatus: clip(match.portStatus), source: source(device, match.source) };
      if (endpoint.matches.length < LIMITS.traceMatches && reserve(cost(compact) + 1)) endpoint.matches.push(compact); else coverage.omittedTraceMatches++;
      const targetId = 'endpoint:' + JSON.stringify([match.mac, match.vlan]);
      const target = addNode({ id: targetId, kind: 'endpoint', label: match.mac, mac: match.mac, vlan: match.vlan,
        host: traced.query, resolution: 'candidate', collectedAt: null, age: 'unknown' });
      if (!target || !lookup.has('device:' + device.id)) { omittedLinkIds.add(JSON.stringify(['forwarding', 'device:' + device.id, match.interface, targetId, null])); continue; }
      addLink({ kind: 'forwarding', from: 'device:' + device.id, to: target.id, localInterface: clip(match.interface), remoteInterface: null, protocols: ['MAC'],
        resolution: match.classification, localState: clip(match.portStatus), age: age(device.collectedAt), collectedAt: device.collectedAt, evidence: [source(device, match.source)],
        meaning: 'Observed MAC forwarding entry; endpoint attachment to this port remains unverified.' }, [match.interface, null]);
    }
    for (const tracePath of traced.paths) {
      const compact = { ...tracePath, steps: tracePath.steps.map(step => ({ ...step, deviceLabel: clip(step.deviceLabel), host: clip(step.host), interface: clip(step.interface), remoteInterface: clip(step.remoteInterface) })) };
      if (endpoint.paths.length < LIMITS.tracePaths && reserve(cost(compact) + 1)) endpoint.paths.push(compact); else coverage.omittedTracePaths++;
    }
    endpoint.omittedMacs = Math.max(0, traced.macs.length - (endpoint.macs?.length || 0));
  }
  coverage.omittedNodes = omittedNodeIds.size; coverage.omittedLinks = omittedLinkIds.size;
  coverage.completeGraph = ![coverage.omittedNodes, coverage.omittedLinks, coverage.omittedEvidence, coverage.omittedArpEvidence, coverage.omittedTraceMatches, coverage.omittedTracePaths, coverage.clippedFields, coverage.omittedWarnings, endpoint?.omittedMacs].some(Boolean);
  const graph = { schemaVersion: 1, kind: 'topology', generatedAt: new Date(at).toISOString(), collectedAt: report.collectedAt, staleHours, nodes, links, endpoint, coverage,
    limitations: [...report.limitations, 'Age labels use the selected threshold and recorded collection time; within-threshold does not mean live.',
      'Neighbor identity matches exact observed hostnames or management addresses. Ambiguous neighbors are not merged.',
      'Directional advertisements can appear as separate links. Missing links and unknown interface states are not evidence of failure.',
      'Graph limits and clipped labels are recorded in coverage. Full canonical command evidence is retained in a JSON export; graph excerpts contain only the referenced source line.'] };
  if (size(graph) > LIMITS.graphBytes) throw new Error('Topology graph exceeded its byte limit. Use a smaller device report.');
  return graph;
}

function buildTopology(input, options = {}) { return derive(analyzeDevices(input), options); }
function exportTopology(input, options = {}) {
  const sourceReport = analyzeDevices(input);
  const exported = { ...derive(sourceReport, options), sourceReport };
  const serialized = JSON.stringify(exported, null, 2);
  if (Buffer.byteLength(serialized) > LIMITS.exportBytes) throw new Error('Topology export exceeds the 20 MiB file limit. Use a smaller device report.');
  return serialized;
}
module.exports = { buildTopology, exportTopology, LIMITS };
