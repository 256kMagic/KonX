'use strict';

// Native WLAN reads are isolated in a bounded child so a stalled driver cannot
// block Electron's main process. No profile keys or configuration APIs are used.
const childProcess = require('child_process');
const path = require('path');
const { checkCancelled, onCancel } = require('./security/common');

const MAX_ADAPTERS = 64;
const MAX_NETWORKS = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 25000;
const STATE = ['Not ready', 'Connected', 'Ad hoc network formed', 'Disconnecting', 'Disconnected', 'Associating', 'Discovering', 'Authenticating'];
const AUTH = { 1: 'Open', 2: 'Shared key', 3: 'WPA-Enterprise', 4: 'WPA-Personal', 5: 'WPA-None', 6: 'WPA2-Enterprise', 7: 'WPA2-Personal', 8: 'WPA3-Enterprise 192-bit', 9: 'WPA3-Personal', 10: 'Enhanced Open (OWE)', 11: 'WPA3-Enterprise' };
const CIPHER = { 0: 'None', 1: 'WEP-40', 2: 'TKIP', 4: 'CCMP-128', 5: 'WEP-104', 6: 'BIP', 8: 'GCMP-128', 9: 'GCMP-256', 10: 'CCMP-256', 256: 'Group cipher', 257: 'WEP' };
const text = (value, length = 500) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\ufffd').slice(0, length);
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

function errorText(code) {
  if (code === 5) return 'Windows denied Wi-Fi information access. Check Settings > Privacy & security > Location and your organization policy. KonX does not change these settings.';
  if (code === 1062) return 'Windows WLAN AutoConfig is not running.';
  if (code === 50) return 'The Windows WLAN service or adapter does not support this query.';
  if (code === 0x80342002) return 'The Wi-Fi radio is off; cached network information is unavailable.';
  return `Windows WLAN query was unavailable (code ${Number.isInteger(code) ? code : 'unknown'}).`;
}

function ssidAt(bytes, offset) {
  const length = bytes.readUInt32LE(offset);
  if (length > 32 || offset + 4 + length > bytes.length) throw new Error('Invalid Windows Wi-Fi SSID data');
  const raw = bytes.subarray(offset + 4, offset + 4 + length);
  return { ssid: text(raw.toString('utf8'), 128), ssidHex: raw.toString('hex'), hidden: length === 0 || raw.every((byte) => byte === 0) };
}
const macAt = (bytes, offset) => [...bytes.subarray(offset, offset + 6)].map((byte) => byte.toString(16).padStart(2, '0')).join(':');
function guidAt(bytes, offset) {
  return `${bytes.readUInt32LE(offset).toString(16).padStart(8, '0')}-${bytes.readUInt16LE(offset + 4).toString(16).padStart(4, '0')}-${bytes.readUInt16LE(offset + 6).toString(16).padStart(4, '0')}-${bytes.subarray(offset + 8, offset + 10).toString('hex')}-${bytes.subarray(offset + 10, offset + 16).toString('hex')}`;
}

function channelFromFrequency(khz, fallbackChannel = null) {
  const mhz = number(khz, 1, 100000000) === null ? null : khz / 1000;
  if (mhz === 2484) return { band: '2.4 GHz', channel: 14, frequencyMHz: mhz };
  if (mhz >= 2412 && mhz <= 2472 && (mhz - 2407) % 5 === 0) return { band: '2.4 GHz', channel: (mhz - 2407) / 5, frequencyMHz: mhz };
  if (mhz >= 5005 && mhz <= 5895 && (mhz - 5000) % 5 === 0) return { band: '5 GHz', channel: (mhz - 5000) / 5, frequencyMHz: mhz };
  if (mhz === 5935) return { band: '6 GHz', channel: 2, frequencyMHz: mhz };
  if (mhz >= 5955 && mhz <= 7115 && (mhz - 5950) % 5 === 0) return { band: '6 GHz', channel: (mhz - 5950) / 5, frequencyMHz: mhz };
  // Channel numbers overlap across bands; never guess a band from a channel.
  return { band: 'Unknown', channel: number(fallbackChannel, 1, 233), frequencyMHz: mhz };
}

function parseInterfaces(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw new Error('Invalid Windows Wi-Fi adapter list');
  const count = bytes.readUInt32LE(0);
  if (count > MAX_ADAPTERS || bytes.length < 8 + count * 532) throw new Error('Windows Wi-Fi adapter list exceeds bounds');
  return Array.from({ length: count }, (_, index) => {
    const offset = 8 + index * 532;
    return { id: guidAt(bytes, offset), guidBytes: bytes.subarray(offset, offset + 16), name: text(bytes.subarray(offset + 16, offset + 528).toString('utf16le').split('\0')[0]), state: STATE[bytes.readUInt32LE(offset + 528)] || 'Unknown', connection: null, issues: [] };
  });
}

function parseConnection(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 604) throw new Error('Invalid Windows Wi-Fi connection data');
  const ssid = ssidAt(bytes, 520);
  return { ssid: ssid.hidden ? '(hidden)' : ssid.ssid, bssid: macAt(bytes, 560), signalPercent: number(bytes.readUInt32LE(576), 0, 100), rxMbps: bytes.readUInt32LE(580) / 1000, txMbps: bytes.readUInt32LE(584) / 1000, authentication: AUTH[bytes.readUInt32LE(596)] || 'Unknown', encryption: CIPHER[bytes.readUInt32LE(600)] || 'Unknown' };
}

function parseAvailable(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw new Error('Invalid Windows Wi-Fi network list');
  const count = bytes.readUInt32LE(0);
  if (count > MAX_NETWORKS || bytes.length < 8 + count * 628) throw new Error('Windows Wi-Fi network list exceeds bounds');
  return Array.from({ length: count }, (_, index) => {
    const offset = 8 + index * 628;
    return { ...ssidAt(bytes, offset + 512), bssType: bytes.readUInt32LE(offset + 548), securityEnabled: bytes.readUInt32LE(offset + 608) !== 0, authentication: AUTH[bytes.readUInt32LE(offset + 612)] || 'Unknown', encryption: CIPHER[bytes.readUInt32LE(offset + 616)] || 'Unknown' };
  });
}

function parseSecurityIe(bytes, privacy) {
  let rsn = null; let wpa = null; let malformed = false;
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 2 > bytes.length || offset + 2 + bytes[offset + 1] > bytes.length) { malformed = true; break; }
    const body = bytes.subarray(offset + 2, offset + 2 + bytes[offset + 1]);
    if (bytes[offset] === 48) rsn = body;
    if (bytes[offset] === 221 && body.subarray(0, 4).equals(Buffer.from([0x00, 0x50, 0xf2, 0x01]))) wpa = body.subarray(4);
    offset += 2 + bytes[offset + 1];
  }
  function decode(body, legacy) {
    if (!body || body.length < 8 || body.readUInt16LE(0) !== 1) return null;
    const oui = legacy ? '0050f2' : '000fac';
    let offset = 6;
    const pairCount = body.readUInt16LE(offset); offset += 2;
    if (pairCount < 1 || pairCount > 32 || offset + pairCount * 4 + 2 > body.length) return null;
    const ciphers = [];
    for (let i = 0; i < pairCount; i++, offset += 4) ciphers.push(body.subarray(offset, offset + 3).toString('hex') === oui ? CIPHER[body[offset + 3]] || 'Unknown' : 'Unknown');
    const akmCount = body.readUInt16LE(offset); offset += 2;
    if (akmCount < 1 || akmCount > 32 || offset + akmCount * 4 > body.length) return null;
    const auths = [];
    const akm = legacy ? { 1: 'WPA-Enterprise', 2: 'WPA-Personal' } : { 1: 'WPA2-Enterprise', 2: 'WPA2-Personal', 3: 'WPA2-Enterprise (FT)', 4: 'WPA2-Personal (FT)', 5: 'WPA2-Enterprise (SHA256)', 6: 'WPA2-Personal (SHA256)', 8: 'WPA3-Personal', 9: 'WPA3-Personal (FT)', 11: 'WPA3-Enterprise', 12: 'WPA3-Enterprise 192-bit', 13: 'WPA3-Enterprise 192-bit (FT)', 18: 'Enhanced Open (OWE)' };
    for (let i = 0; i < akmCount; i++, offset += 4) auths.push(body.subarray(offset, offset + 3).toString('hex') === oui ? akm[body[offset + 3]] || 'Unknown' : 'Unknown');
    return { authentication: [...new Set(auths)].join(' / '), encryption: [...new Set(ciphers)].join(' / '), securityEnabled: true };
  }
  const security = decode(rsn, false) || decode(wpa, true);
  if (security) return security;
  if (!privacy && !rsn && !wpa && !malformed) return { authentication: 'Open', encryption: 'None', securityEnabled: false };
  return { authentication: 'Unknown', encryption: 'Unknown', securityEnabled: privacy ? true : null };
}

function parseBssList(bytes, adapterId, available = []) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw new Error('Invalid Windows Wi-Fi BSSID list');
  const size = bytes.readUInt32LE(0); const count = bytes.readUInt32LE(4);
  if (size < 8 || size > MAX_BYTES || size > bytes.length || count > MAX_NETWORKS || 8 + count * 360 > size) throw new Error('Windows Wi-Fi BSSID list exceeds bounds');
  return Array.from({ length: count }, (_, index) => {
    const offset = 8 + index * 360;
    const ssid = ssidAt(bytes, offset);
    const privacy = Boolean(bytes.readUInt16LE(offset + 88) & 0x10);
    const ieOffset = bytes.readUInt32LE(offset + 352); const ieSize = bytes.readUInt32LE(offset + 356);
    let security = { authentication: 'Unknown', encryption: 'Unknown', securityEnabled: privacy ? true : null };
    if (ieSize === 0 || (ieSize <= 2324 && ieOffset >= 360 && offset + ieOffset >= 8 + count * 360 && offset + ieOffset + ieSize <= size)) security = parseSecurityIe(bytes.subarray(offset + ieOffset, offset + ieOffset + ieSize), privacy);
    // A unique OS network default can fill in unavailable beacon fields. An SSID
    // with several security variants remains unknown rather than borrowing one.
    if (security.authentication === 'Unknown' && privacy) {
      const candidates = available.filter((item) => item.ssidHex === ssid.ssidHex && item.securityEnabled === privacy && item.bssType === bytes.readUInt32LE(offset + 48));
      const variants = new Map(candidates.map((item) => [`${item.authentication}|${item.encryption}`, item]));
      if (variants.size === 1) { const candidate = [...variants.values()][0]; security = { authentication: candidate.authentication, encryption: candidate.encryption, securityEnabled: candidate.securityEnabled }; }
    }
    // ullHostTimestamp is a Windows FILETIME from the last received beacon.
    const filetime = bytes.readBigUInt64LE(offset + 80);
    const hostMs = Number(filetime / 10000n - 11644473600000n);
    const observedAt = hostMs > 0 && hostMs <= Date.now() + 86400000 ? new Date(hostMs).toISOString() : null;
    return { adapterId, ssid: ssid.hidden ? '(hidden)' : ssid.ssid, hidden: ssid.hidden, bssid: macAt(bytes, offset + 40), ...channelFromFrequency(bytes.readUInt32LE(offset + 92)), signalPercent: number(bytes.readUInt32LE(offset + 60), 0, 100), rssiDbm: number(bytes.readInt32LE(offset + 56), -127, 0), ...security, observedAt };
  });
}

function buildReport(facts, now = new Date().toISOString()) {
  if (!facts || typeof facts !== 'object' || !Array.isArray(facts.adapters) || !Array.isArray(facts.networks) || facts.adapters.length > MAX_ADAPTERS || facts.networks.length > MAX_NETWORKS) throw new Error('Invalid Wi-Fi inventory response');
  const adapters = facts.adapters.map((item) => ({ id: text(item.id, 64), name: text(item.name), state: text(item.state, 60), connection: item.connection ? { ssid: text(item.connection.ssid, 128), bssid: text(item.connection.bssid, 17), signalPercent: number(item.connection.signalPercent, 0, 100), rxMbps: number(item.connection.rxMbps, 0, 1000000), txMbps: number(item.connection.txMbps, 0, 1000000), authentication: text(item.connection.authentication, 200), encryption: text(item.connection.encryption, 150) } : null, issues: Array.isArray(item.issues) ? item.issues.slice(0, 10).map((issue) => text(issue, 1000)) : [] }));
  const networksByAdapter = new Map();
  for (const item of facts.networks) {
    if (!item || typeof item !== 'object' || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(item.bssid)) continue;
    const adapterId = text(item.adapterId, 64); const bssid = item.bssid.toLowerCase();
    const freq = channelFromFrequency(typeof item.frequencyMHz === 'number' ? item.frequencyMHz * 1000 : null, item.channel);
    const normalized = { adapterId, ssid: item.hidden ? '(hidden)' : text(item.ssid, 128), hidden: item.hidden === true, bssid, ...freq, signalPercent: number(item.signalPercent, 0, 100), rssiDbm: number(item.rssiDbm, -127, 0), authentication: text(item.authentication || 'Unknown', 200), encryption: text(item.encryption || 'Unknown', 150), securityEnabled: typeof item.securityEnabled === 'boolean' ? item.securityEnabled : null, connected: adapters.some((adapter) => adapter.id === adapterId && adapter.connection?.bssid.toLowerCase() === bssid), observedAt: typeof item.observedAt === 'string' && Number.isFinite(Date.parse(item.observedAt)) ? new Date(item.observedAt).toISOString() : null };
    const key = `${adapterId}|${bssid}|${freq.frequencyMHz}`;
    const previous = networksByAdapter.get(key);
    if (!previous || (normalized.rssiDbm ?? -999) > (previous.rssiDbm ?? -999)) networksByAdapter.set(key, normalized);
  }
  const networks = [...networksByAdapter.values()].sort((a, b) => (b.rssiDbm ?? -999) - (a.rssiDbm ?? -999));
  const buckets = new Map();
  for (const network of networks) {
    if (network.band === 'Unknown' || network.channel === null) continue;
    const key = `${network.band}|${network.channel}`;
    if (!buckets.has(key)) buckets.set(key, { band: network.band, channel: network.channel, bssids: new Set(), strongestRssiDbm: null });
    const bucket = buckets.get(key); bucket.bssids.add(network.bssid);
    if (network.rssiDbm !== null) bucket.strongestRssiDbm = Math.max(bucket.strongestRssiDbm ?? -999, network.rssiDbm);
  }
  const channels = [...buckets.values()].map(({ bssids, ...bucket }) => ({ ...bucket, bssidCount: bssids.size })).sort((a, b) => a.band.localeCompare(b.band) || a.channel - b.channel);
  const findings = [];
  const add = (id, title, status, severity, evidence, remediation = '') => findings.push({ id, title, status, severity, evidence, remediation });
  if (adapters.length === 0) add('wifi-no-adapters', 'No Windows Wi-Fi adapters found', 'unknown', 'info', 'Windows returned no WLAN interfaces. Ethernet adapters and remote access points are not local Wi-Fi adapters.');
  const failures = adapters.flatMap((adapter) => adapter.issues);
  if (failures.length) add('wifi-unavailable', 'Some Wi-Fi evidence is unavailable', 'unknown', 'info', [...new Set(failures)].join(' ').slice(0, 4000));
  const open = new Set(networks.filter((network) => network.securityEnabled === false).map((network) => network.bssid));
  if (open.size) add('wifi-open', 'Unencrypted Wi-Fi networks observed', 'warning', 'medium', `${open.size} BSSID(s) advertise open authentication without link encryption. A captive portal does not establish Wi-Fi link encryption.`, 'Prefer WPA2/WPA3 or Enhanced Open where appropriate; verify the access point configuration before connecting.');
  const legacy = new Set(networks.filter((network) => /WEP|TKIP/.test(network.encryption) || /\bWPA-(?:Personal|Enterprise|None)/.test(network.authentication)).map((network) => network.bssid));
  if (legacy.size) add('wifi-legacy', 'Legacy Wi-Fi security advertised', 'warning', 'high', `${legacy.size} BSSID(s) advertise WEP, TKIP, or original WPA. Advertised options do not prove a client used them.`, 'Review compatibility and configure approved WPA2/WPA3 authentication with modern ciphers.');
  const weak = adapters.filter((adapter) => adapter.connection?.signalPercent !== null && adapter.connection?.signalPercent < 40);
  if (weak.length) add('wifi-low-signal', 'Low current connection signal', 'warning', 'low', `${weak.length} connected adapter(s) report signal quality below KonX's 40% review threshold. This is a snapshot, not a throughput test.`, 'Compare signal while moving near the access point; review placement, band selection, and roaming behavior.');
  const shared = channels.filter((channel) => channel.bssidCount >= 4);
  if (shared.length) add('wifi-shared-channels', 'Several BSSIDs share a primary channel', 'info', 'low', `${shared.length} primary channel(s) have at least four observed BSSIDs. Counts do not measure airtime utilization, interference, channel width, or client load.`, 'Compare channel use with a controller or spectrum analysis before changing radio settings.');
  const unknown = networks.filter((network) => network.authentication === 'Unknown' || network.encryption === 'Unknown' || network.band === 'Unknown').length;
  if (unknown) add('wifi-unknown', 'Some advertised attributes are unknown', 'unknown', 'info', `${unknown} network observation(s) have unknown security or radio attributes. Unknown values do not mean secure.`);
  if (!networks.length) add('wifi-no-networks', 'No cached nearby networks returned', 'unknown', 'info', 'An empty cache does not establish that no access points are present. Check the adapter, radio state, location permission, and Windows WLAN service.');
  return { schemaVersion: 1, kind: 'wifi', collectedAt: now, adapters, networks, channels, findings, limitations: ['This is a read-only snapshot of the Windows WLAN cache. KonX does not request an active radio scan; collection time does not establish when each access point was last seen.', 'Channel counts include unique observed BSSIDs, not airtime, spectrum interference, non-Wi-Fi devices, or guaranteed access-point counts. One access point can advertise several BSSIDs.', 'Security is inferred from beacon information or Windows network defaults. No credentials, saved profile keys, association attempts, throughput tests, or configuration changes are performed.', 'SSID/BSSID information can identify nearby networks. Reports stay local unless you choose to export or share them.'] };
}

function collectNative(action = 'survey') {
  if (process.platform !== 'win32') throw new Error('Local Wi-Fi diagnostics are available only on Windows');
  const k = require('koffi');
  const lib = k.load(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wlanapi.dll'));
  const api = {
    open: lib.func('uint32_t __stdcall WlanOpenHandle(uint32_t version, void *reserved, _Out_ uint32_t *negotiated, _Out_ void **handle)'),
    close: lib.func('uint32_t __stdcall WlanCloseHandle(void *handle, void *reserved)'),
    free: lib.func('void __stdcall WlanFreeMemory(void *memory)'),
    interfaces: lib.func('uint32_t __stdcall WlanEnumInterfaces(void *handle, void *reserved, _Out_ void **list)'),
    connection: lib.func('uint32_t __stdcall WlanQueryInterface(void *handle, const uint8_t *guid, uint32_t opcode, void *reserved, _Out_ uint32_t *size, _Out_ void **data, _Out_ uint32_t *valueType)'),
    available: lib.func('uint32_t __stdcall WlanGetAvailableNetworkList(void *handle, const uint8_t *guid, uint32_t flags, void *reserved, _Out_ void **list)'),
    bss: lib.func('uint32_t __stdcall WlanGetNetworkBssList(void *handle, const uint8_t *guid, void *ssid, uint32_t type, int32_t security, void *reserved, _Out_ void **list)'),
  };
  const copy = (ptr, size) => { if (!ptr || size < 0 || size > MAX_BYTES) throw new Error('Invalid native Wi-Fi buffer'); return Buffer.from(k.decode(ptr, 'uint8_t', size)); };
  const handle = [null]; const version = [0]; const result = api.open(2, null, version, handle);
  if (result !== 0) throw new Error(errorText(result));
  const facts = { adapters: [], networks: [] };
  try {
    const output = [null];
    const status = api.interfaces(handle[0], null, output);
    if (status !== 0) throw new Error(errorText(status));
    try {
      const header = copy(output[0], 8); const count = header.readUInt32LE(0);
      if (count > MAX_ADAPTERS) throw new Error('Windows Wi-Fi adapter list exceeds bounds');
      facts.adapters = parseInterfaces(copy(output[0], 8 + count * 532));
    } finally { if (output[0]) api.free(output[0]); }
    for (const adapter of facts.adapters) {
      if (adapter.state === 'Connected' || adapter.state === 'Ad hoc network formed') {
        const data = [null]; const size = [0]; const valueType = [0];
        const code = api.connection(handle[0], adapter.guidBytes, 7, null, size, data, valueType);
        try { if (code === 0) adapter.connection = parseConnection(copy(data[0], size[0])); else adapter.issues.push(errorText(code)); } finally { if (data[0]) api.free(data[0]); }
      }
      if (action === 'survey') {
        let available = [];
        const listed = [null]; const availableCode = api.available(handle[0], adapter.guidBytes, 0, null, listed);
        try {
          if (availableCode === 0) {
            const count = copy(listed[0], 8).readUInt32LE(0);
            if (count > MAX_NETWORKS) throw new Error('Windows Wi-Fi network list exceeds bounds');
            available = parseAvailable(copy(listed[0], 8 + count * 628));
          } else adapter.issues.push(errorText(availableCode));
        } finally { if (listed[0]) api.free(listed[0]); }
        const bss = [null]; const code = api.bss(handle[0], adapter.guidBytes, null, 3, 0, null, bss);
        try {
          if (code === 0) {
            const size = copy(bss[0], 8).readUInt32LE(0);
            facts.networks.push(...parseBssList(copy(bss[0], size), adapter.id, available));
            if (facts.networks.length > MAX_NETWORKS) throw new Error('Windows Wi-Fi network observations exceed bounds');
          } else adapter.issues.push(errorText(code));
        } finally { if (bss[0]) api.free(bss[0]); }
      }
      delete adapter.guidBytes;
    }
    return facts;
  } finally { api.close(handle[0], null); }
}

function collectInventory(action, signal, execFile = childProcess.execFile) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let child; let settled = false; let cancelled = false; let unsubscribe = () => {};
    const finish = (error, stdout) => {
      if (settled) return;
      settled = true; unsubscribe();
      if (cancelled || signal?.stopped) return reject(new Error('Wi-Fi diagnostics cancelled'));
      if (error) return reject(new Error(error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Wi-Fi diagnostics exceeded the time or output limit' : 'Windows Wi-Fi diagnostics could not start or complete'));
      try {
        const result = JSON.parse(String(stdout));
        if (result?.error) throw new Error(text(result.error, 1000));
        resolve(buildReport(result));
      } catch (error) { reject(new Error(error.message === 'Unexpected end of JSON input' || error instanceof SyntaxError ? 'Wi-Fi diagnostics returned invalid data' : error.message)); }
    };
    // The source and action are fixed by this module, never a renderer command.
    const source = `try{process.stdout.write(JSON.stringify(require(${JSON.stringify(__filename)}).collectNative(${JSON.stringify(action)})))}catch(e){process.stdout.write(JSON.stringify({error:String(e.message).slice(0,1000)}))}`;
    try {
      child = execFile(process.execPath, ['-e', source], { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, finish);
      if (!settled) unsubscribe = onCancel(signal, () => { cancelled = true; child?.kill(); });
    } catch { finish(new Error('spawn failed')); }
  });
}

async function run(params = {}, emit, signal = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || !['survey', 'adapters'].includes(params.action ?? 'survey')) throw new Error('Choose a supported Wi-Fi diagnostics action');
  if (Object.hasOwn(params, 'activeScan') && params.activeScan !== false) throw new Error('Active Wi-Fi scans are not supported; use the cached survey');
  checkCancelled(signal);
  if (process.platform !== 'win32') throw new Error('Local Wi-Fi diagnostics are available only on Windows');
  emit('progress', { phase: 'Reading the Windows Wi-Fi cache…' });
  const report = await collectInventory(params.action ?? 'survey', signal);
  checkCancelled(signal);
  emit('report', report);
}

module.exports = { run, collectInventory, collectNative, buildReport, channelFromFrequency, parseInterfaces, parseConnection, parseAvailable, parseBssList, parseSecurityIe, errorText };
