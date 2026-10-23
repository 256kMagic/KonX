'use strict';

// Offline observations only: never execute commands from a configuration/capture,
// and never return configuration lines or decoded credential values.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { finding, makeReport, checkCancelled } = require('./common');

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PACKETS = 50000;
const MAX_LINES = 100000;
const pause = () => new Promise((resolve) => setImmediate(resolve));
const refsText = (refs, label = 'Lines') => {
  const safe = [...new Set(refs)].filter((n) => Number.isSafeInteger(n) && n > 0);
  return `${label} ${safe.slice(0, 24).join(', ')}${safe.length > 24 ? `; ${safe.length - 24} more` : ''}`;
};

async function readBoundedFile(filePath, signal) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) throw new Error('Choose a regular file');
  checkCancelled(signal);
  let handle;
  try {
    const before = await fs.lstat(filePath);
    if (!before.isFile()) throw new Error('Security assessments require a regular file (not a directory or link)');
    if (before.size > MAX_BYTES) throw new Error('File exceeds the 32 MiB assessment limit');
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Security assessments require a regular file');
    if (stat.size > MAX_BYTES) throw new Error('File exceeds the 32 MiB assessment limit');
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      checkCancelled(signal);
      const { bytesRead } = await handle.read(bytes, used, Math.min(65536, bytes.length - used), used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    checkCancelled(signal);
    const after = await handle.stat();
    if (used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('File changed during assessment; try again after saving it');
    return bytes.subarray(0, used);
  } catch (error) {
    checkCancelled(signal);
    // fs errors contain the full path; do not put machine paths in scan results.
    if (error.code) throw new Error(`Unable to read the assessment file (${error.code})`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function configFamily(text, explicit) {
  if (explicit) return /^(?:cisco[ -]?)?(?:ios(?:[ -]?xe)?|nx[ -]?os)$/i.test(explicit) ? 'explicit' : '';
  if (/^!?\s*(?:Cisco (?:IOS|Nexus|NX-OS)|.*Cisco IOS|.*NX-OS)/im.test(text)) return 'header';
  // A generic "version" line alone is not sufficient to identify a platform.
  if (!/^version\s+\d+[.\d]*(?:\([^\r\n]*\))?/im.test(text)) return '';
  const markers = [/^hostname\s+\S+/im, /^interface\s+\S+/im, /^line vty\s+\d/im, /^feature\s+(?:ssh|telnet|nxapi)\b/im, /^snmp-server\s+/im, /^ip ssh\s+/im];
  return markers.filter((re) => re.test(text)).length >= 2 ? 'syntax' : '';
}

/** Pure offline config analysis; async only to allow cancellation/event-loop turns. */
async function analyzeConfig(text, { family, signal } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Provide configuration text or choose a configuration file');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Configuration exceeds the 32 MiB assessment limit');
  if (text.includes('\0')) throw new Error('Configuration must be a text file without NUL bytes');
  checkCancelled(signal);
  const detected = configFamily(text, family);
  const limitations = [
    'Supports explicit Cisco IOS, IOS-XE and NX-OS style settings only. This is a configuration observation, not a compliance certification or live reachability test.',
    'Missing settings remain unknown: snippets, platform defaults, ACLs, VRFs and inherited policy may change the effective behavior. No configuration is executed or changed.',
    'Evidence contains line references and fixed setting descriptions; credential values, account names and raw configuration lines are excluded.',
  ];
  if (!detected) return makeReport({ kind: 'config', title: 'Configuration Security Review', target: 'Configuration text', checks: [finding({ id: 'config-family', title: 'Configuration family is unsupported or unrecognized', status: 'unknown', severity: 'info', evidence: 'Cisco IOS, IOS-XE or NX-OS could not be identified. No configuration rules were treated as passed.', remediation: 'Provide a Cisco configuration with its version/platform header, or select a supported family.' })], limitations });
  if (detected === 'syntax') limitations.push('Platform family was inferred from version and Cisco-style syntax; verify it against the device model and software version.');

  let http, telnetFeature, sshVersion, sshFeature, aaa, loggingEnabled, ntpAuth;
  const users = new Map(), enables = new Map(), communities = new Map(), snmpHosts = new Map(), transports = new Map(), logHosts = new Map(), ntpHosts = new Map();
  let context = '', contextKey = '', offset = 0, lineNo = 0, skipped = 0, incomplete = false, macroBody = false;
  while (offset < text.length) {
    if (lineNo >= MAX_LINES) { incomplete = true; break; }
    let end = text.indexOf('\n', offset);
    if (end < 0) end = text.length;
    const raw = text.slice(offset, end);
    offset = end + 1;
    lineNo++;
    if (!(lineNo % 256)) { await pause(); checkCancelled(signal); }
    if (raw.length > 65536) { skipped++; context = ''; continue; }
    const s = raw.trim();
    // A macro definition is stored text, not active configuration. Cisco ends
    // it with @ on its own line; command-like text inside has no effect here.
    if (macroBody) { if (s === '@') macroBody = false; continue; }
    if (/^macro\s+name\s+\S+/i.test(s)) { macroBody = true; context = ''; continue; }
    if (!s || s.startsWith('!')) { if (s.startsWith('!')) context = ''; continue; }
    if (/^banner\s+/i.test(s)) {
      // Banner contents can imitate commands. Skip the delimited body entirely.
      const m = s.match(/^banner\s+\S+\s+(\^\S|\S)/i);
      if (m) {
        const delimiter = m[1];
        const rest = s.slice(m.index + m[0].length);
        if (!rest.includes(delimiter)) {
          const close = text.indexOf(delimiter, offset);
          const next = close < 0 ? text.length : close + delimiter.length;
          for (let p = offset; p < next; p++) {
            if (text.charCodeAt(p) === 10) lineNo++;
            if (!(p % 65536)) { await pause(); checkCancelled(signal); }
          }
          offset = next;
        }
      }
      context = ''; continue;
    }
    const vty = s.match(/^line\s+vty\s+(.+)$/i);
    if (vty) { context = 'vty'; contextKey = vty[1]; continue; }
    if (!/^\s/.test(raw)) context = '';
    if (context === 'vty' && /^transport input\s+/i.test(s)) transports.set(contextKey, { line: lineNo, unsafe: /\b(?:telnet|all)\b/i.test(s) });
    if (/^(?:no )?ip http server$/i.test(s)) http = { line: lineNo, enabled: !/^no /i.test(s) };
    if (/^(?:no )?feature telnet$/i.test(s)) telnetFeature = { line: lineNo, enabled: !/^no /i.test(s) };
    if (/^(?:no )?feature ssh$/i.test(s)) sshFeature = { line: lineNo, enabled: !/^no /i.test(s) };
    if (/^ip ssh version [12]$/i.test(s)) sshVersion = { line: lineNo, version: Number(s.at(-1)) };
    if (/^no ip ssh version\b/i.test(s)) sshVersion = undefined;
    if (/^(?:no )?aaa new-model$/i.test(s)) aaa = { line: lineNo, enabled: !/^no /i.test(s) };
    const userDelete = s.match(/^no username\s+(\S+)/i);
    if (userDelete) users.delete(userDelete[1]);
    const user = s.match(/^username\s+(\S+)\s+.*?\b(password|secret)\s+(.+)$/i);
    if (user) users.set(user[1], { line: lineNo, ...credentialType(user[2], user[3]) });
    const enable = s.match(/^(no )?enable\s+(password|secret)(?:\s+level\s+(\d+))?(?:\s+(.+))?$/i);
    if (enable) {
      const key = `${enable[2].toLowerCase()}:${enable[3] || '15'}`;
      if (enable[1]) enables.delete(key);
      else enables.set(key, { line: lineNo, ...credentialType(enable[2], enable[4] || '') });
    }
    const community = s.match(/^(no )?snmp-server community\s+(\S+)/i);
    if (community) {
      if (community[1]) communities.delete(community[2]);
      else communities.set(community[2], lineNo);
    }
    const snmp = s.match(/^(no )?snmp-server host\s+(\S+)\s+.*\bversion\s+(1|2c|3)\b/i);
    if (snmp) {
      if (snmp[1] || snmp[3] === '3') snmpHosts.delete(snmp[2]);
      else snmpHosts.set(snmp[2], lineNo);
    }
    if (/^(?:no )?logging (?:on|enable)$/i.test(s)) loggingEnabled = { line: lineNo, enabled: !/^no /i.test(s) };
    const log = s.match(/^(no )?logging (?:host |server )?(\S+)/i);
    if (log && !/^(?:on|enable|buffered|console|monitor|trap|source-interface|facility|origin-id|timestamp|history|rate-limit|discriminator|event)$/i.test(log[2])) {
      if (log[1]) logHosts.delete(log[2]); else logHosts.set(log[2], lineNo);
    }
    if (/^(?:no )?ntp authenticate$/i.test(s)) ntpAuth = { line: lineNo, enabled: !/^no /i.test(s) };
    const ntp = s.match(/^(no )?ntp (?:server|peer)\s+(\S+)/i);
    if (ntp) { if (ntp[1]) ntpHosts.delete(ntp[2]); else ntpHosts.set(ntp[2], lineNo); }
  }
  checkCancelled(signal);
  const checks = [];
  const add = (id, title, status, severity, evidence, remediation, confidence = 'high') => checks.push(finding({ id, title, status, severity, evidence, remediation, confidence }));
  add('config-family', 'Supported Cisco-style configuration identified', 'info', 'info', detected === 'explicit' ? 'Supported family supplied explicitly.' : 'Version/platform header and Cisco-style syntax identified.', 'Confirm the device software family before applying any suggested changes.', detected === 'syntax' ? 'medium' : 'high');
  const telnet = [...transports.values()].filter((v) => v.unsafe).map((v) => v.line);
  if (telnetFeature?.enabled) telnet.push(telnetFeature.line);
  add('config-telnet', 'Telnet management settings', telnet.length ? 'warning' : 'unknown', telnet.length ? 'high' : 'info', telnet.length ? `${refsText(telnet)}: Telnet or all inbound VTY transports explicitly enabled.` : 'No explicit Telnet-enabling setting identified; defaults and live exposure were not tested.', 'Use SSH-only management where supported; verify all VTY ranges, access controls and required fallback access.');
  add('config-http', 'Unencrypted HTTP management', http ? (http.enabled ? 'warning' : 'info') : 'unknown', http?.enabled ? 'medium' : 'info', http ? `Line ${http.line}: unencrypted HTTP management explicitly ${http.enabled ? 'enabled' : 'disabled'}.` : 'No explicit HTTP management setting identified.', 'Disable unencrypted management HTTP where appropriate and use HTTPS with trusted certificates.');
  for (const [id, name, values] of [['user', 'Local account', [...users.values()]], ['enable', 'Enable', [...enables.values()]]]) {
    const plain = values.filter((v) => v.plain), reversible = values.filter((v) => v.reversible);
    add(`config-${id}-cleartext`, `${name} cleartext credentials`, plain.length ? 'warning' : 'unknown', plain.length ? 'high' : 'info', plain.length ? `${refsText(plain.map((v) => v.line))}: explicit unencrypted credential setting (value omitted).` : 'No explicitly unencrypted credential setting identified; unrecognized encodings and defaults remain unknown.', 'Rotate exposed credentials and use supported strong secret hashes; do not share unredacted configurations.');
    if (reversible.length) add(`config-${id}-reversible`, `${name} reversible password encoding`, 'warning', 'high', `${refsText(reversible.map((v) => v.line))}: type 7 reversible credential encoding (value omitted).`, 'Rotate the credential and replace reversible encoding with a supported strong secret hash.');
  }
  const snmpLines = [...communities.values(), ...snmpHosts.values()];
  add('config-snmp', 'SNMP community or legacy protocol settings', snmpLines.length ? 'warning' : 'unknown', snmpLines.length ? 'medium' : 'info', snmpLines.length ? `${refsText(snmpLines)}: community-based SNMP or explicit SNMPv1/v2c destination configured (values omitted).` : 'No explicit SNMPv1/v2c or community setting identified; effective agent policy remains unknown.', 'Prefer SNMPv3 authPriv; restrict authorized managers and rotate community strings exposed in shared configurations.');
  add('config-aaa', 'AAA model observation', aaa ? (aaa.enabled ? 'info' : 'warning') : 'unknown', aaa && !aaa.enabled ? 'medium' : 'info', aaa ? `Line ${aaa.line}: aaa new-model explicitly ${aaa.enabled ? 'enabled' : 'disabled'}.` : 'No aaa new-model setting identified; NX-OS and other platform defaults may differ.', 'Review authentication, authorization, accounting, fallback and recovery access against the platform documentation.');
  add('config-logging', 'Remote logging observation', loggingEnabled && !loggingEnabled.enabled ? 'warning' : logHosts.size ? 'info' : 'unknown', loggingEnabled && !loggingEnabled.enabled ? 'low' : 'info', loggingEnabled && !loggingEnabled.enabled ? `Line ${loggingEnabled.line}: logging explicitly disabled.` : logHosts.size ? `${refsText([...logHosts.values()])}: remote logging destination settings identified (destinations omitted).` : 'No remote logging destination setting identified.', 'Verify logging is enabled, reaches a trusted collector and records useful authentication and configuration events.');
  add('config-ntp', 'Time synchronization observation', ntpAuth && !ntpAuth.enabled ? 'warning' : ntpHosts.size ? 'info' : 'unknown', ntpAuth && !ntpAuth.enabled ? 'low' : 'info', ntpAuth && !ntpAuth.enabled ? `Line ${ntpAuth.line}: NTP authentication explicitly disabled.` : ntpHosts.size ? `${refsText([...ntpHosts.values()])}: NTP server/peer settings identified; authentication and reachability not verified.` : 'No NTP server/peer setting identified.', 'Use trusted time sources and supported authentication; verify synchronized time for certificate and audit-log accuracy.');
  add('config-ssh', 'SSH version observation', sshVersion?.version === 1 ? 'warning' : sshVersion ? 'info' : 'unknown', sshVersion?.version === 1 ? 'high' : 'info', sshVersion ? `Line ${sshVersion.line}: SSH version ${sshVersion.version} explicitly configured; algorithms and reachability not tested.` : sshFeature ? `Line ${sshFeature.line}: SSH feature explicitly ${sshFeature.enabled ? 'enabled' : 'disabled'}; protocol version not identified.` : 'No explicit SSH version setting identified; this does not establish that SSH is disabled or insecure.', 'Use SSHv2 with current cryptographic algorithms and restrict management access.');
  if (macroBody) limitations.push(incomplete
    ? 'A macro definition did not end within the analyzed prefix. Its commands were not treated as active settings; the remaining text was not examined.'
    : 'An unterminated macro definition was skipped through the end of the supplied text. Its commands were not treated as active settings.');
  if (incomplete || skipped) {
    add('config-limits', 'Configuration review is incomplete', 'unknown', 'info', `${incomplete ? `Stopped at the ${MAX_LINES.toLocaleString('en-US')} line limit. ` : ''}${skipped} oversized lines omitted.`, 'Review the remaining configuration separately.');
    limitations.push('Only the bounded prefix and lines at most 64 KiB were analyzed. Later commands may override earlier observations.');
  }
  return makeReport({ kind: 'config', title: 'Configuration Security Review', target: 'Configuration text', checks, limitations });
}

function credentialType(kind, value) {
  const type = value.match(/^(\d+)\s+/)?.[1];
  // Cisco's secret keyword hashes a literal when the command is applied; it does
  // not protect that literal in a pasted provisioning/startup configuration.
  return { plain: type === '0' || (type === undefined && !!value.trim()), reversible: type === '7' };
}

let captureModules;
function loadCaptureModules() {
  if (!captureModules) captureModules = Promise.all(['pcapfile.mjs', 'decode.mjs', 'analyze.mjs'].map((name) => import(pathToFileURL(path.join(__dirname, '..', '..', 'renderer', 'js', 'capture', name)).href)));
  return captureModules;
}

// Preflight caps packets before the existing synchronous reader allocates packet
// objects. Header walks yield even for files containing millions of empty blocks.
async function capturePrefix(bytes, signal) {
  if (bytes.length < 24) throw new Error('File is too short to be a capture');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false), ng = magic === 0x0a0d0d0a;
  const little = ![0xa1b2c3d4, 0xa1b23c4d].includes(magic);
  if (!ng && ![0xa1b2c3d4, 0xa1b23c4d].includes(view.getUint32(0, little))) throw new Error('Unrecognized file format (expected .pcap or .pcapng)');
  let off = ng ? 0 : 24, count = 0, sectionsLittle = true, iterations = 0;
  while (off < bytes.length) {
    if (!(iterations++ % 256)) { await pause(); checkCancelled(signal); }
    let size, isPacket;
    if (ng) {
      if (off + 12 > bytes.length) throw new Error('Malformed pcapng: truncated block header');
      const type = view.getUint32(off, sectionsLittle);
      if (type === 0x0a0d0d0a) {
        const bom = view.getUint32(off + 8, true);
        if (![0x1a2b3c4d, 0x4d3c2b1a].includes(bom)) throw new Error('Malformed pcapng: invalid byte order');
        sectionsLittle = bom === 0x1a2b3c4d;
      }
      size = view.getUint32(off + 4, sectionsLittle);
      if (size < 12 || size % 4 || off + size > bytes.length || view.getUint32(off + size - 4, sectionsLittle) !== size) throw new Error('Malformed pcapng: invalid block length');
      isPacket = [2, 3, 6].includes(type);
    } else {
      if (off + 16 > bytes.length) throw new Error('Malformed pcap: truncated packet header');
      const caplen = view.getUint32(off + 8, little), original = view.getUint32(off + 12, little);
      if (caplen > original || off + 16 + caplen > bytes.length) throw new Error('Malformed pcap: invalid or truncated packet length');
      size = 16 + caplen;
      isPacket = true;
    }
    if (isPacket && count >= MAX_PACKETS) return { bytes: bytes.subarray(0, off), limited: true };
    if (isPacket) count++;
    off += size;
  }
  checkCancelled(signal);
  return { bytes, limited: false };
}

const INSECURE = new Map([
  ['Telnet', 'Telnet'], ['Telnet (unencrypted remote login)', 'Telnet'], ['FTP', 'FTP'],
  ['SNMP v1', 'SNMPv1'], ['SNMP v2c', 'SNMPv2c'], ['SMBv1', 'SMBv1'],
  ['HSRP clear-text auth', 'HSRP cleartext authentication'], ['HTTP (unencrypted web)', 'HTTP'],
  ['TACACS+ without encryption key', 'TACACS+ without encryption'],
  ['IKEv1 Aggressive Mode (exposes a crackable PSK hash)', 'IKEv1 Aggressive Mode'],
  ['PPP PAP (clear-text password)', 'PPP PAP'],
]);

/** Convert only recognized Analyzer insights into fixed, redacted findings. */
function mapCaptureFindings(analyzer, refs = {}) {
  const insights = analyzer.insights();
  const checks = [];
  const add = (id, title, severity, frames, text, remediation, confidence = 'high') => checks.push(finding({ id, title, status: 'warning', severity, evidence: `${text}${frames?.length ? ` ${refsText(frames, 'Frames')}.` : ''}`, remediation, confidence }));
  if (insights.some((i) => i.cat === 'Security' && /^frame\.number == \d+$/.test(i.filter))) add('capture-cleartext-credentials', 'Cleartext authentication material observed', 'high', refs.credentials || analyzer.creds.map((c) => c.no), 'The decoder identified cleartext authentication material. Account names and values are omitted.', 'Replace cleartext authentication with an encrypted protocol and rotate exposed credentials.');
  const known = new Set();
  for (const name of analyzer.insecure.keys()) {
    const label = INSECURE.get(name);
    if (!label || known.has(label)) continue;
    known.add(label);
    const frames = [...analyzer.insecure].filter(([key]) => INSECURE.get(key) === label).map(([, value]) => value.firstNo);
    add(`capture-protocol-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, `${label} traffic observed`, label === 'SMBv1' ? 'high' : 'medium', frames, 'An unencrypted or legacy protocol was observed; the content and any secret values are omitted.', 'Confirm whether the traffic is required, restrict its exposure and use a current encrypted alternative.');
  }
  if (insights.some((i) => i.cat === 'TLS' && i.filter === 'tls.handshake.version < 0x0303')) add('capture-old-tls', 'Legacy TLS negotiated', 'medium', refs.oldTls, 'A ServerHello negotiated TLS 1.1 or older.', 'Disable legacy protocol versions after checking application compatibility; use TLS 1.2 or TLS 1.3.');
  if (insights.some((i) => i.cat === 'ARP')) {
    const frames = [...analyzer.arp.values()].filter((a) => a.macs.size > 1).flatMap((a) => [...a.macs.values()]);
    add('capture-arp-conflict', 'Multiple MAC claims for one IP observed', 'medium', frames, 'Different hardware addresses claimed the same IPv4 address. This may reflect failover, an address conflict or spoofing; it is not proof of an attack.', 'Compare with the authorized topology, redundancy configuration and switch ARP inspection records.', 'medium');
  }
  if (insights.some((i) => i.cat === 'DHCP' && i.filter === 'dhcp.type == 2 or dhcp.type == 5')) add('capture-dhcp-servers', 'Multiple DHCP responders observed', 'medium', [...analyzer.dhcp.servers.values()].map((s) => s.firstNo), 'Multiple DHCP servers answered. Authorized redundant servers and relays can produce this observation; it is not proof of a rogue server.', 'Compare responder identities with authorized DHCP infrastructure and DHCP snooping records.', 'medium');
  if (insights.some((i) => i.cat === 'DHCP' && i.filter === 'dhcp.type == 6')) add('capture-dhcp-naks', 'DHCP negative acknowledgements observed', 'low', refs.dhcpNaks, 'DHCP negative acknowledgements were decoded; these can be normal after a client changes networks.', 'Investigate persistent failures against the expected scopes, leases and client subnets.', 'medium');
  return checks;
}

async function analyzeCapture(bytes, { signal } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Capture data must be bytes');
  if (bytes.length > MAX_BYTES) throw new Error('Capture exceeds the 32 MiB assessment limit');
  checkCancelled(signal);
  const prefix = await capturePrefix(bytes, signal);
  const [{ readCapture }, { decode }, { Analyzer }] = await loadCaptureModules();
  checkCancelled(signal);
  const { packets } = readCapture(prefix.bytes);
  const analyzer = new Analyzer(), refs = { credentials: [], oldTls: [], dhcpNaks: [] };
  let unsupported = 0, malformed = 0, oversized = 0;
  const supported = new Set([0, 1, 12, 101, 108, 113, 228, 229]);
  for (let i = 0; i < packets.length; i++) {
    if (!(i % 128)) { await pause(); checkCancelled(signal); }
    const packet = packets[i], no = i + 1;
    if (!supported.has(packet.linktype)) { unsupported++; continue; }
    // A malicious packet can advertise a multi-megabyte application message.
    // Limit individual decoder work rather than blocking the main process on it.
    if (packet.data.length > 262144) { oversized++; continue; }
    const d = decode(packet.linktype, packet.data);
    if (d.malformed) malformed++;
    if (d.cred) {
      refs.credentials.push(no);
      d.cred = { ...d.cred, proto: ['HTTP Basic', 'FTP', 'POP3', 'IMAP', 'SMTP', 'Telnet', 'PAP'].includes(d.cred.proto) ? d.cred.proto : 'authentication', user: '[redacted]', password: d.cred.password ? '[redacted]' : '', host: '[redacted]', src: '[redacted]' };
    }
    if (d.credPart) d.credPart = { ...d.credPart, user: '[redacted]' };
    if (d.snmp) d.snmp = { ...d.snmp, community: '[redacted]' };
    if (d.fhrp?.auth) d.fhrp = { ...d.fhrp, auth: '[redacted]' };
    if (d.insecure && !INSECURE.has(d.insecure)) d.insecure = '';
    if (d.tls?.hello === 2 && d.tls.version && d.tls.version < 0x0303) refs.oldTls.push(no);
    if (d.dhcp?.type === 6) refs.dhcpNaks.push(no);
    analyzer.ingest({ no, ts: Number.isFinite(packet.ts) ? packet.ts : 0, len: packet.len, d });
  }
  checkCancelled(signal);
  const checks = mapCaptureFindings(analyzer, refs);
  checks.unshift(finding({ id: 'capture-scope', title: 'Offline capture coverage', status: 'info', severity: 'info', evidence: `${packets.length} packet records read; ${analyzer.total.pkts} decoded and analyzed. ${unsupported} unsupported link-type packets and ${oversized} oversized packets omitted. ${malformed} decoded packets were malformed/truncated.`, remediation: 'Use the packet capture workspace to inspect the referenced frames and surrounding traffic.' }));
  if (checks.length === 1) checks.push(finding({ id: 'capture-no-indicators', title: 'No supported security indicators identified', status: 'unknown', severity: 'info', evidence: 'The bounded capture review found no matching indicators. This does not establish that the traffic or hosts are secure.', remediation: 'Review capture coverage and combine these observations with authenticated host and service assessments.' }));
  if (prefix.limited || unsupported || oversized || malformed) checks.push(finding({ id: 'capture-limits', title: 'Capture coverage is incomplete', status: 'unknown', severity: 'info', evidence: `${prefix.limited ? `Only the first ${MAX_PACKETS.toLocaleString('en-US')} packet records were considered. ` : ''}Unsupported, oversized or malformed packets may conceal additional observations.`, remediation: 'Use a supported capture format and link type, or inspect omitted traffic with a full protocol analyzer.' }));
  return makeReport({ kind: 'capture', title: 'Packet Security Review', target: 'Offline capture file', checks, limitations: [
    'Offline .pcap/.pcapng only; maximum 32 MiB and the first 50,000 packet records. Individual packets larger than 256 KiB are omitted. No live traffic is generated.',
    'Uses KonX packet decoder and Analyzer observations. Encrypted payloads are not decrypted, and credentials split across packets or unsupported protocols may be missed.',
    'ARP conflicts and multiple DHCP responders are observations with possible legitimate causes, not proof of compromise. Absence of indicators is not a clean bill of health.',
    'Exported findings contain fixed descriptions and frame numbers; account names, community strings, authentication values and packet payloads are excluded.',
  ] });
}

async function scanConfig(params = {}, signal) {
  checkCancelled(signal);
  const text = typeof params.text === 'string' && params.text.trim() ? params.text : (await readBoundedFile(params.filePath, signal)).toString('utf8');
  return analyzeConfig(text, { family: params.family, signal });
}

async function scanCapture(params = {}, signal) {
  return analyzeCapture(await readBoundedFile(params.filePath, signal), { signal });
}

module.exports = { scanConfig, scanCapture, analyzeConfig, analyzeCapture, mapCaptureFindings, MAX_BYTES, MAX_PACKETS };
