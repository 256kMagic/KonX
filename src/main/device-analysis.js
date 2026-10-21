'use strict';

// Cisco IOS/IOS-XE show-output interpretation. Every fact retains its command
// and one-based source line; a missing row never proves a device is absent.
const net = require('node:net');

const COMMANDS = Object.freeze([
  ['version', 'show version'], ['interfaces', 'show interfaces'],
  ['interfaceStatus', 'show interfaces status'], ['vlans', 'show vlan brief'],
  ['mac', 'show mac address-table'], ['arp', 'show ip arp'],
  ['cdp', 'show cdp neighbors detail'], ['lldp', 'show lldp neighbors detail'],
  ['poe', 'show power inline'],
].map(([id, command]) => Object.freeze({ id, command })));
const LIMITS = Object.freeze({ devices: 16, commandBytes: 1048576, totalBytes: 8388608, commands: COMMANDS.length, rows: 20000, lines: 50000, traceMatches: 512, tracePaths: 128 });
const commandById = new Map(COMMANDS.map(c => [c.id, c]));
const statuses = new Set(['ok', 'error', 'timeout', 'truncated', 'cancelled']);
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function text(value, name, max = 512, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}

function timestamp(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${name}`);
  return value;
}

const counter = value => Number.isSafeInteger(Number(value)) ? Number(value) : value;

function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!/^(?:[\da-f]{4}\.){2}[\da-f]{4}$|^(?:[\da-f]{2}:){5}[\da-f]{2}$|^(?:[\da-f]{2}-){5}[\da-f]{2}$|^[\da-f]{12}$/i.test(t)) return null;
  return t.replace(/[.:-]/g, '').toLowerCase().match(/../g).join(':');
}

function normalizeInterface(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/\s+(?=\d)/g, '');
  if (!t) return null;
  const aliases = [
    [/^(?:HundredGigE|HundredGigabitEthernet|Hu)(?=\d)/i, 'Hu'],
    [/^(?:FortyGigabitEthernet|FortyGigE|Fo)(?=\d)/i, 'Fo'],
    [/^(?:TwentyFiveGigE|TwentyFiveGigabitEthernet|Twe)(?=\d)/i, 'Twe'],
    [/^(?:TenGigabitEthernet|TenGigE|Te)(?=\d)/i, 'Te'],
    [/^(?:GigabitEthernet|Gi)(?=\d)/i, 'Gi'], [/^(?:FastEthernet|Fa)(?=\d)/i, 'Fa'],
    [/^(?:Ethernet|Eth|Et)(?=\d)/i, 'Eth'], [/^(?:Port-channel|PortChannel|Po)(?=\d)/i, 'Po'],
    [/^(?:Vlan|Vl)(?=\d)/i, 'Vl'], [/^(?:Loopback|Lo)(?=\d)/i, 'Lo'],
    [/^(?:Tunnel|Tu)(?=\d)/i, 'Tu'], [/^(?:Management|Mgmt|Ma)(?=\d)/i, 'Ma'],
  ];
  for (const [pattern, prefix] of aliases) if (pattern.test(t)) return t.replace(pattern, prefix);
  return t;
}

function validateCommands(input) {
  if (!Array.isArray(input) || input.length > LIMITS.commands) throw new Error('Invalid device command list');
  const seen = new Set();
  return input.map(c => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || !commandById.has(c.id) || seen.has(c.id)) throw new Error('Unknown or duplicate device command');
    seen.add(c.id);
    const definition = commandById.get(c.id);
    if (c.command !== undefined && c.command !== definition.command) throw new Error(`Command text does not match ${c.id}`);
    if (typeof c.output !== 'string' || Buffer.byteLength(c.output) > LIMITS.commandBytes) throw new Error(`Output exceeds the limit or is invalid for ${c.id}`);
    const status = c.status === undefined ? 'ok' : c.status;
    if (!statuses.has(status)) throw new Error(`Invalid command status for ${c.id}`);
    return { id: c.id, command: definition.command, output: c.output, status, ...(c.error ? { error: text(c.error, 'command error', 4096) } : {}) };
  });
}

function analyzeDevice(input, metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid device metadata');
  const commands = validateCommands(input);
  const device = {
    id: text(metadata.id, 'device id', 128, 'device'), label: text(metadata.label, 'device label', 256, metadata.host || 'Device'),
    host: text(metadata.host, 'device host', 256), connectionId: text(metadata.connectionId, 'connection id', 128, null),
    collectedAt: timestamp(metadata.collectedAt, 'collection time'), commands,
    facts: { version: {}, interfaces: [], vlans: [], mac: [], arp: [], neighbors: [], poe: [] }, coverage: [], warnings: [],
  };
  const facts = device.facts;
  const interfaceMap = new Map();
  let rowCount = 0;
  const add = (kind, row) => {
    if (rowCount >= LIMITS.rows) throw new Error('Device facts exceed the row limit');
    rowCount++;
    facts[kind].push(row);
  };
  const getInterface = (raw, source) => {
    const name = normalizeInterface(raw);
    if (!interfaceMap.has(name)) {
      const row = { name, displayName: raw, status: null, protocol: null, description: null, vlan: null, duplex: null, speed: null, inputErrors: null, crc: null, outputErrors: null, source, sources: [source] };
      interfaceMap.set(name, row); add('interfaces', row);
    }
    const row = interfaceMap.get(name);
    if (!row.sources.some(s => s.commandId === source.commandId && s.line === source.line)) row.sources.push(source);
    return row;
  };
  for (const c of commands) {
    const lines = c.output.split(/\r\n|\n|\r/);
    if (lines.length > LIMITS.lines) throw new Error(`Too many output lines for ${c.id}`);
    const clean = lines.map(line => line.replace(ANSI, '').replace(/\x08/g, '').trimEnd());
    const pager = clean.some(line => /--\s*More\s*--|<---\s*More\s*--->/i.test(line));
    const rejected = clean.some(line => /^\s*%\s*(?:Invalid input|Unknown command|Unrecognized command|Incomplete command|Ambiguous command|Authorization failed|Access denied|Error)/i.test(line));
    let complete = c.status === 'ok' && !pager && !rejected;
    if (!complete) device.warnings.push(`${c.command}: ${pager ? 'pagination markers remain; output is incomplete' : rejected ? 'device rejected the command' : c.status}${c.error ? ` (${c.error})` : ''}.`);
    let currentInterface = null, currentVlan = null, neighbor = null;
    const flushNeighbor = () => {
      if (neighbor && (neighbor.deviceId || neighbor.managementAddress) && neighbor.localInterface) add('neighbors', neighbor);
      neighbor = null;
    };
    for (let i = 0; i < clean.length; i++) {
      const line = clean[i], s = line.trim(), source = { commandId: c.id, line: i + 1 };
      if (!s || rejected) continue;
      let m;
      if (c.id === 'version') {
        if ((m = s.match(/^(.+?) uptime is (.+)$/))) { facts.version.hostname = m[1]; facts.version.uptime = m[2]; facts.version.source = source; }
        if ((m = s.match(/Cisco IOS(?: XE)? Software,.*?Version\s+([^,\s]+)/i)) || (m = s.match(/^Cisco IOS XE Software, Version\s+([^,\s]+)/i))) { facts.version.version = m[1]; facts.version.versionSource = source; }
        if ((m = s.match(/^Model [Nn]umber\s*:\s*(\S+)/)) || (m = s.match(/^[Cc]isco\s+(\S+)\s+\([^)]*\)\s+processor/))) { facts.version.model = m[1]; facts.version.modelSource = source; }
        if ((m = s.match(/^System image file is\s+"?([^"\r\n]+)"?$/i))) { facts.version.image = m[1]; facts.version.imageSource = source; }
      } else if (c.id === 'interfaces') {
        if ((m = s.match(/^(\S+) is (.+?), line protocol is ([^,(]+)(?:[, (].*)?$/))) {
          currentInterface = getInterface(m[1], source); currentInterface.status = m[2].trim(); currentInterface.protocol = m[3].trim();
        } else if (currentInterface) {
          if ((m = s.match(/^Description:\s*(.*)$/))) currentInterface.description = m[1];
          if ((m = s.match(/(\d+) input errors,\s*(\d+) CRC/i))) { currentInterface.inputErrors = counter(m[1]); currentInterface.crc = counter(m[2]); currentInterface.errorSource = source; }
          if ((m = s.match(/(\d+) output errors/i))) { currentInterface.outputErrors = counter(m[1]); currentInterface.outputErrorSource = source; }
          if ((m = s.match(/(Full-duplex|Half-duplex|Auto-duplex),\s*([^,]+)/i))) { currentInterface.duplex = m[1]; currentInterface.speed = m[2]; }
        }
      } else if (c.id === 'interfaceStatus') {
        if ((m = s.match(/^(\S+)\s+(.*?)\s+(connected|notconnect|disabled|err-disabled|inactive|monitoring|suspended|sfpAbsent|xcvrAbsent|noTransceiver|notpresent)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+.*)?$/i))) {
          const row = getInterface(m[1], source);
          row.description = m[2] || row.description; row.status = m[3]; row.vlan = m[4]; row.duplex = m[5]; row.speed = m[6]; row.statusSource = source;
        }
      } else if (c.id === 'vlans') {
        if ((m = s.match(/^(\d{1,4})\s+(.+?)\s+(active|suspended|act\/unsup|act\/lshut|sus\/lshut|shutdown)(?:\s+(.*))?$/i))) {
          const id = Number(m[1]);
          if (id < 1 || id > 4094) continue;
          currentVlan = { id, name: m[2], status: m[3], ports: (m[4] || '').split(/,\s*/).filter(Boolean).map(normalizeInterface), source };
          add('vlans', currentVlan);
        } else if (currentVlan && /^\s+\S/.test(line) && /^(?:Gi|Fa|Te|Twe|Hu|Fo|Eth|Et|Po)\d/i.test(s)) {
          currentVlan.ports.push(...s.split(/,\s*/).filter(Boolean).map(normalizeInterface));
        } else if (/^[- ]+$/.test(s) || /^VLAN|^Remote|^Primary|^Type/i.test(s)) currentVlan = null;
      } else if (c.id === 'mac') {
        // IOS and IOS-XE tables; CPU/drop/static router rows remain explicit.
        if ((m = s.match(/^[*+CGRO\s]*([0-9]{1,4}|All|---)\s+([\da-f.:-]+)\s+(DYNAMIC|STATIC|SECURE|SELF|SYSTEM|dynamic|static)\s+(.*)$/i))) {
          const mac = normalizeMac(m[2]); if (!mac) continue;
          const ports = m[4].split(',').map(part => part.trim().split(/\s+/).pop()).filter(Boolean);
          for (const port of ports) add('mac', { mac, vlan: /^\d+$/.test(m[1]) ? Number(m[1]) : m[1], type: m[3].toLowerCase(), interface: normalizeInterface(port), source });
        }
      } else if (c.id === 'arp') {
        if ((m = s.match(/^Internet\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:ARPA|SNAP|SAP)\s*(\S*)/i))) {
          if (net.isIP(m[1]) !== 4) continue;
          add('arp', { ip: m[1], mac: normalizeMac(m[3]), age: m[2] === '-' ? null : /^\d+$/.test(m[2]) ? Number(m[2]) : m[2], interface: normalizeInterface(m[4]), source, incomplete: /^Incomplete$/i.test(m[3]) });
        }
      } else if (c.id === 'cdp' || c.id === 'lldp') {
        const ensure = () => neighbor || (neighbor = { protocol: c.id.toUpperCase(), deviceId: null, managementAddress: null, localInterface: null, remoteInterface: null, capabilities: null, source });
        if (/^-{5,}$/.test(s)) { flushNeighbor(); continue; }
        if (c.id === 'cdp' && (m = s.match(/^Device ID:\s*(.+)$/i))) { flushNeighbor(); ensure().deviceId = m[1]; }
        else if (c.id === 'lldp' && (m = s.match(/^Local Intf:\s*(.+)$/i))) { if (neighbor?.localInterface) flushNeighbor(); ensure().localInterface = normalizeInterface(m[1]); }
        else if (c.id === 'lldp' && (m = s.match(/^System Name:\s*(.+)$/i))) ensure().deviceId = m[1];
        else if ((m = s.match(/^(?:IP(?:v4)? [Aa]ddress|Management Address|IP):\s*(\S+)/))) { if (net.isIP(m[1])) ensure().managementAddress = m[1]; }
        else if ((m = s.match(/^Interface:\s*([^,]+),\s*Port ID \(outgoing port\):\s*(.+)$/i))) { ensure().localInterface = normalizeInterface(m[1]); ensure().remoteInterface = normalizeInterface(m[2]); }
        else if (c.id === 'lldp' && (m = s.match(/^Port id:\s*(.+)$/i))) ensure().remoteInterface = normalizeInterface(m[1]);
        if ((m = s.match(/(?:^System Capabilities:|\bCapabilities:)\s*(.+)$/i))) ensure().capabilities = m[1];
      } else if (c.id === 'poe') {
        if ((m = s.match(/^(\S+)\s+(auto|static|never|off)\s+(on|off|faulty|denied|power-deny|Ieee|n\/a)\s+(\d+(?:\.\d+)?|n\/a)\s+(.+?)\s+(\S+)\s+(\d+(?:\.\d+)?|n\/a)\s*$/i))) {
          add('poe', { interface: normalizeInterface(m[1]), admin: m[2], oper: m[3], powerWatts: m[4] === 'n/a' ? null : Number(m[4]), device: m[5], class: m[6], maxWatts: m[7] === 'n/a' ? null : Number(m[7]), source });
        }
      }
    }
    flushNeighbor();
    const recognizedRows = Object.values(facts).filter(Array.isArray).flat().filter(row => row.source?.commandId === c.id || row.sources?.some(source => source.commandId === c.id)).length + (c.id === 'version' && Object.keys(facts.version).length ? 1 : 0);
    if (!recognizedRows && complete && clean.some(s => s.trim())) {
      complete = false;
      device.warnings.push(`${c.command}: no supported data rows were recognized; empty tables and unsupported layouts cannot always be distinguished.`);
    }
    device.coverage.push({ commandId: c.id, status: c.status, complete, recognizedRows });
  }
  for (const c of COMMANDS) if (!commands.some(item => item.id === c.id)) {
    device.coverage.push({ commandId: c.id, status: 'missing', complete: false, recognizedRows: 0 });
  }
  if (commands.length < COMMANDS.length) device.warnings.push('Some show commands were not supplied; their facts remain unknown.');
  return device;
}

function analyzeDevices(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.devices) || !input.devices.length || input.devices.length > LIMITS.devices) throw new Error(`Supply between 1 and ${LIMITS.devices} devices`);
  let bytes = 0;
  for (const d of input.devices) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.commands)) throw new Error('Invalid device record');
    for (const c of d.commands) { if (typeof c?.output !== 'string') throw new Error('Invalid command output'); bytes += Buffer.byteLength(c.output); }
    if (bytes > LIMITS.totalBytes) throw new Error('Device collection exceeds the total output limit');
  }
  const devices = input.devices.map((d, i) => analyzeDevice(d.commands, { ...d, id: d.id || `device-${i + 1}` }));
  if (new Set(devices.map(d => d.id)).size !== devices.length) throw new Error('Device identifiers must be unique');
  const suppliedTime = timestamp(input.collectedAt, 'collection time');
  const collectedAt = suppliedTime || (devices.every(d => d.collectedAt) ? devices.reduce((latest, d) => Date.parse(d.collectedAt) > Date.parse(latest) ? d.collectedAt : latest, devices[0].collectedAt) : null);
  return { schemaVersion: 1, kind: 'device', collectedAt, devices, limitations: [
    'Parsed Cisco IOS/IOS-XE show output. Unknown layouts and unsupported commands may leave facts incomplete; inspect the original output.',
    'Each device is an observation at its recorded time, not a simultaneous network snapshot. ARP and MAC entries can be stale.',
    'Endpoint results are candidates in the selected devices. Missing neighbors do not prove an access port; port-channel membership and other VRFs are not inferred.',
  ] };
}

function traceEndpoint(devices, value) {
  if (!Array.isArray(devices) || !devices.length || devices.length > LIMITS.devices) throw new Error('Invalid device collection for tracing');
  const query = text(value, 'endpoint query', 128).trim();
  const macQuery = normalizeMac(query), isIp = net.isIP(query) === 4;
  if (!macQuery && !isIp) throw new Error('Enter an IPv4 address or a complete MAC address');
  if (devices.some(d => !d || !d.facts || !['arp', 'mac', 'neighbors', 'interfaces'].every(k => Array.isArray(d.facts[k])))) throw new Error('Analyze the device collection before tracing');
  const macs = macQuery ? [macQuery] : [...new Set(devices.flatMap(d => d.facts.arp.filter(a => a.ip === query && a.mac).map(a => a.mac)))];
  const result = { query, queryType: isIp ? 'ipv4' : 'mac', macs, matches: [], paths: [], warnings: [] };
  if (!macs.length) { result.warnings.push('No complete ARP mapping for this IP was observed in the selected devices. The endpoint location is unknown.'); return result; }
  if (macs.length > 1) result.warnings.push('More than one MAC address was observed for this IP. All candidates are shown; no unique identity is established.');
  for (const d of devices) {
    if (d.coverage?.some(c => ['arp', 'mac', 'cdp', 'lldp'].includes(c.commandId) && !c.complete)) result.warnings.push(`${d.label}: endpoint evidence is incomplete; consult command coverage.`);
    for (const row of d.facts.mac) if (macs.includes(row.mac)) {
      if (result.matches.length >= LIMITS.traceMatches) { result.warnings.push(`Trace limited to ${LIMITS.traceMatches} MAC-table matches.`); break; }
      const neighbors = d.facts.neighbors.filter(n => n.localInterface === row.interface);
      const port = d.facts.interfaces.find(p => p.name === row.interface);
      const nonPort = !/^(?:Gi|Fa|Te|Twe|Hu|Fo|Eth|Po)\d/i.test(row.interface || '');
      const classification = /^Po\d/i.test(row.interface || '') ? 'unresolved-port-channel' : nonPort ? 'ambiguous' : neighbors.length ? 'observed-uplink' : 'candidate-edge';
      result.matches.push({ deviceId: d.id, deviceLabel: d.label, connectionId: d.connectionId, host: d.host, mac: row.mac, vlan: row.vlan, interface: row.interface, portStatus: port?.status ?? null, classification, source: row.source,
        warnings: classification === 'candidate-edge' ? ['No neighbor was observed on this port; this is a candidate location, not proof of an endpoint attachment.'] : classification === 'unresolved-port-channel' ? ['Port-channel members were not collected; the physical path is unresolved.'] : nonPort ? ['This MAC-table destination is not a supported physical port.'] : [] });
    }
  }
  if (!result.matches.length) { result.warnings.push('The MAC address was not found in the supplied MAC tables; this does not prove the endpoint is absent.'); return result; }
  const identity = s => typeof s === 'string' ? s.trim().replace(/\.$/, '').toLowerCase() : '';
  const targetsFor = (d, match) => {
    const neighbors = d.facts.neighbors.filter(n => n.localInterface === match.interface);
    const remote = [];
    for (const n of neighbors) {
      const matches = devices.filter(candidate => {
        const host = identity(candidate.host), hostname = identity(candidate.facts.version?.hostname);
        return (n.managementAddress && identity(n.managementAddress) === host) || (n.deviceId && [host, hostname].filter(Boolean).includes(identity(n.deviceId)));
      });
      for (const candidate of matches) if (!remote.some(x => x.device.id === candidate.id && x.neighbor.remoteInterface === n.remoteInterface)) remote.push({ device: candidate, neighbor: n });
    }
    return { neighbors, remote };
  };
  const incoming = new Set();
  for (const match of result.matches) {
    const d = devices.find(x => x.id === match.deviceId);
    for (const remote of targetsFor(d, match).remote) incoming.add([remote.device.id, match.mac, match.vlan].join('|'));
  }
  const roots = result.matches.filter(m => !incoming.has([m.deviceId, m.mac, m.vlan].join('|')));
  // A closed cycle has no root. Starting its observed rows lets the walk report
  // that uncertainty rather than silently dropping the entire component.
  const starts = [...roots, ...result.matches.filter(m => !roots.includes(m))];
  const covered = new Set();
  let truncatedPaths = false;
  for (const start of starts) {
    const startKey = [start.deviceId, start.mac, start.vlan, start.interface].join('|');
    if (covered.has(startKey)) continue;
    if (result.paths.length >= LIMITS.tracePaths) { truncatedPaths = true; break; }
    const path = { mac: start.mac, vlan: start.vlan, status: 'incomplete', steps: [], reason: '' };
    const seen = new Set(); let current = start;
    while (current) {
      if (seen.has(current.deviceId)) { path.status = 'cycle'; path.reason = 'The observed forwarding/neighbor path loops back to a device already visited.'; break; }
      seen.add(current.deviceId);
      covered.add([current.deviceId, current.mac, current.vlan, current.interface].join('|'));
      const d = devices.find(x => x.id === current.deviceId);
      const next = targetsFor(d, current);
      const step = { deviceId: d.id, deviceLabel: d.label, connectionId: d.connectionId, host: d.host, interface: current.interface, remoteDeviceId: next.remote.length === 1 ? next.remote[0].device.id : null, remoteInterface: next.remote.length === 1 ? next.remote[0].neighbor.remoteInterface : null, source: current.source };
      path.steps.push(step);
      if (current.classification === 'unresolved-port-channel') { path.reason = 'Port-channel physical membership is unavailable.'; break; }
      if (current.classification === 'ambiguous') { path.status = 'ambiguous'; path.reason = 'The MAC table points to a CPU, drop entry, or unsupported destination.'; break; }
      if (!next.neighbors.length) { path.status = 'candidate-edge'; path.reason = 'The last observed port has no supplied neighbor. Endpoint attachment remains unverified.'; break; }
      if (next.remote.length !== 1) { path.status = next.remote.length ? 'ambiguous' : 'incomplete'; path.reason = next.remote.length ? 'Neighbor observations match multiple selected devices or disagree about the remote port.' : 'The neighbor could not be identified among the selected devices.'; break; }
      const candidates = result.matches.filter(m => m.deviceId === next.remote[0].device.id && m.mac === current.mac && m.vlan === current.vlan);
      if (candidates.length !== 1) { path.status = candidates.length ? 'ambiguous' : 'incomplete'; path.reason = candidates.length ? 'Multiple forwarding ports remain possible on the next device.' : 'No matching MAC/VLAN forwarding row was observed on the next device.'; break; }
      current = candidates[0];
    }
    result.paths.push(path);
  }
  if (truncatedPaths) result.warnings.push(`Path display limited to ${LIMITS.tracePaths} starting points.`);
  result.warnings.push('Results follow observed MAC, ARP and neighbor entries only. Stale tables, capture times, missing devices and VLAN/VRF scope can leave the physical location unresolved.');
  return result;
}

module.exports = { COMMANDS, LIMITS, analyzeDevice, analyzeDevices, traceEndpoint, normalizeMac, normalizeInterface };
