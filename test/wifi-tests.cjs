'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const wifi = require('../src/main/wifi');

function interfaceFixture(state = 1, name = 'Intel Wi-Fi – 日本語') {
  const bytes = Buffer.alloc(540);
  bytes.writeUInt32LE(1, 0);
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(bytes, 8);
  bytes.write(name, 24, 'utf16le');
  bytes.writeUInt32LE(state, 536);
  return bytes;
}
function connectionFixture() {
  const bytes = Buffer.alloc(604);
  bytes.writeUInt32LE(1, 0);
  writeSsid(bytes, 520, '測試 Lab');
  Buffer.from('aabbccddeeff', 'hex').copy(bytes, 560);
  bytes.writeUInt32LE(72, 576); bytes.writeUInt32LE(866700, 580); bytes.writeUInt32LE(433300, 584);
  bytes.writeUInt32LE(7, 596); bytes.writeUInt32LE(4, 600);
  return bytes;
}
function writeSsid(bytes, offset, value) { const raw = Buffer.from(value); bytes.writeUInt32LE(raw.length, offset); raw.copy(bytes, offset + 4); }
function availableFixture() {
  const bytes = Buffer.alloc(636); bytes.writeUInt32LE(1, 0);
  // Profile name is never returned by the parser.
  bytes.write('PRIVATE_PROFILE_NAME', 8, 'utf16le');
  writeSsid(bytes, 520, 'Lab');
  bytes.writeUInt32LE(1, 556); bytes.writeUInt32LE(1, 616);
  bytes.writeUInt32LE(7, 620); bytes.writeUInt32LE(4, 624);
  return bytes;
}
function rsnIe(akms = [2], cipher = 4) {
  const body = Buffer.alloc(8 + 4 + 2 + akms.length * 4);
  body.writeUInt16LE(1, 0); Buffer.from([0, 15, 172, cipher]).copy(body, 2);
  body.writeUInt16LE(1, 6); Buffer.from([0, 15, 172, cipher]).copy(body, 8);
  body.writeUInt16LE(akms.length, 12);
  akms.forEach((akm, index) => Buffer.from([0, 15, 172, akm]).copy(body, 14 + index * 4));
  return Buffer.concat([Buffer.from([48, body.length]), body]);
}
function bssFixture({ ssid = 'Lab', freq = 5180000, privacy = true, ies = rsnIe(), bssid = 'aabbccddeeff' } = {}) {
  const bytes = Buffer.alloc(368 + ies.length); bytes.writeUInt32LE(bytes.length, 0); bytes.writeUInt32LE(1, 4);
  writeSsid(bytes, 8, ssid); Buffer.from(bssid, 'hex').copy(bytes, 48);
  bytes.writeUInt32LE(1, 56); bytes.writeUInt32LE(7, 60); bytes.writeInt32LE(-57, 64); bytes.writeUInt32LE(86, 68);
  bytes.writeUInt16LE(privacy ? 0x10 : 0, 96); bytes.writeUInt32LE(freq, 100);
  bytes.writeUInt32LE(360, 360); bytes.writeUInt32LE(ies.length, 364); ies.copy(bytes, 368);
  return bytes;
}
function goodFacts() {
  const adapter = wifi.parseInterfaces(interfaceFixture())[0];
  adapter.connection = wifi.parseConnection(connectionFixture());
  return { adapters: [adapter], networks: wifi.parseBssList(bssFixture(), adapter.id) };
}
function fakeNativeModule(overrides = {}) {
  const calls = []; const freed = []; const handle = {};
  const native = {
    WlanOpenHandle(version, reserved, negotiated, output) { output[0] = handle; negotiated[0] = 2; return 0; },
    WlanCloseHandle() { calls.push('closed'); return 0; },
    WlanFreeMemory(memory) { freed.push(memory); },
    WlanEnumInterfaces(h, reserved, output) { output[0] = interfaceFixture(); return 0; },
    WlanQueryInterface(h, guid, opcode, reserved, size, output) { calls.push(['query', opcode]); output[0] = connectionFixture(); size[0] = 604; return 0; },
    WlanGetAvailableNetworkList(h, guid, flags, reserved, output) { calls.push(['available', flags]); output[0] = availableFixture(); return 0; },
    WlanGetNetworkBssList(h, guid, ssid, type, security, reserved, output) { calls.push(['bss', ssid, type, security]); output[0] = bssFixture(); return 0; },
    ...overrides,
  };
  const k = { load() { return { func(declaration) { const name = /\b(Wlan\w+)\(/.exec(declaration)?.[1]; assert.ok(native[name], declaration); return native[name]; } }; }, decode(ptr, type, size) { assert.strictEqual(type, 'uint8_t'); assert.ok(size <= ptr.length, 'must not overread native allocation'); return [...ptr.subarray(0, size)]; } };
  const context = { module: { exports: {} }, exports: {}, Buffer, console, process: { platform: 'win32', env: {}, execPath: 'electron.exe' }, __filename: path.resolve(__dirname, '../src/main/wifi.js'), require(name) { if (name === 'koffi') return k; if (name === './security/common') return require('../src/main/security/common'); return require(name); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/wifi.js'), 'utf8'), context);
  return { wifi: context.module.exports, calls, freed };
}

async function runWifiTests(test) {
  await test('Wi-Fi binary layouts match the native Windows ABI and WLAN signatures bind without querying adapters', () => {
    if (process.platform !== 'win32') return;
    const k = require('koffi');
    const ssid = k.struct({ length: 'uint32_t', bytes: k.array('uint8_t', 32) });
    const assoc = k.struct({ ssid, bss: 'uint32_t', bssid: k.array('uint8_t', 6), phy: 'uint32_t', phyIndex: 'uint32_t', quality: 'uint32_t', rx: 'uint32_t', tx: 'uint32_t' });
    const conn = k.struct({ state: 'uint32_t', mode: 'uint32_t', profile: k.array('uint16_t', 256), association: assoc, security: k.array('uint32_t', 4) });
    const rateSet = k.struct({ length: 'uint32_t', rates: k.array('uint16_t', 126) });
    const bss = k.struct({ ssid, phyId: 'uint32_t', bssid: k.array('uint8_t', 6), type: 'uint32_t', phy: 'uint32_t', rssi: 'int32_t', quality: 'uint32_t', inDomain: 'uint8_t', beacon: 'uint16_t', timestamp: 'uint64_t', hostTimestamp: 'uint64_t', capability: 'uint16_t', frequency: 'uint32_t', rateSet, ieOffset: 'uint32_t', ieSize: 'uint32_t' });
    assert.strictEqual(k.sizeof(conn), 604); assert.strictEqual(k.offsetof(conn, 'association'), 520); assert.strictEqual(k.offsetof(conn, 'security'), 588);
    assert.strictEqual(k.offsetof(assoc, 'bssid'), 40); assert.strictEqual(k.offsetof(assoc, 'quality'), 56);
    assert.strictEqual(k.sizeof(bss), 360); assert.strictEqual(k.offsetof(bss, 'rssi'), 56); assert.strictEqual(k.offsetof(bss, 'frequency'), 92); assert.strictEqual(k.offsetof(bss, 'ieOffset'), 352);
    const lib = k.load(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wlanapi.dll'));
    const declarations = [...fs.readFileSync(path.join(__dirname, '../src/main/wifi.js'), 'utf8').matchAll(/lib\.func\('([^']+)'\)/g)].map((match) => match[1]);
    assert.strictEqual(declarations.length, 7);
    for (const declaration of declarations) lib.func(declaration);
  });
  await test('Wi-Fi native adapter and connection fields are locale independent without profile names or keys', () => {
    const adapters = wifi.parseInterfaces(interfaceFixture());
    assert.strictEqual(adapters[0].state, 'Connected');
    assert.strictEqual(adapters[0].name, 'Intel Wi-Fi – 日本語');
    assert.strictEqual(adapters[0].id, '33221100-5544-7766-8899-aabbccddeeff');
    const connection = wifi.parseConnection(connectionFixture());
    assert.strictEqual(connection.ssid, '測試 Lab'); assert.strictEqual(connection.bssid, 'aa:bb:cc:dd:ee:ff');
    assert.strictEqual(connection.signalPercent, 72); assert.strictEqual(connection.rxMbps, 866.7); assert.strictEqual(connection.txMbps, 433.3);
    assert.strictEqual(connection.authentication, 'WPA2-Personal'); assert.strictEqual(connection.encryption, 'CCMP-128');
    assert.ok(!JSON.stringify(wifi.parseAvailable(availableFixture())).includes('PRIVATE_PROFILE_NAME'));
  });
  await test('Wi-Fi channel calculations distinguish overlapping 2.4, 5, and 6 GHz channel numbers', () => {
    assert.deepStrictEqual(wifi.channelFromFrequency(2412000), { band: '2.4 GHz', channel: 1, frequencyMHz: 2412 });
    assert.strictEqual(wifi.channelFromFrequency(2484000).channel, 14);
    assert.deepStrictEqual(wifi.channelFromFrequency(5180000), { band: '5 GHz', channel: 36, frequencyMHz: 5180 });
    assert.deepStrictEqual(wifi.channelFromFrequency(5955000), { band: '6 GHz', channel: 1, frequencyMHz: 5955 });
    assert.strictEqual(wifi.channelFromFrequency(5935000).channel, 2);
    assert.strictEqual(wifi.channelFromFrequency(7115000).channel, 233);
    assert.deepStrictEqual(wifi.channelFromFrequency(null, 1), { band: 'Unknown', channel: 1, frequencyMHz: null });
    assert.strictEqual(wifi.channelFromFrequency(2413000, 1).band, 'Unknown');
  });
  await test('Wi-Fi BSS parser reads RSSI and per-BSSID WPA2 and WPA3 advertisements', () => {
    const [network] = wifi.parseBssList(bssFixture({ ies: rsnIe([2, 8]) }), 'adapter');
    assert.strictEqual(network.rssiDbm, -57); assert.strictEqual(network.signalPercent, 86);
    assert.strictEqual(network.channel, 36); assert.strictEqual(network.band, '5 GHz');
    assert.strictEqual(network.authentication, 'WPA2-Personal / WPA3-Personal');
    assert.strictEqual(network.encryption, 'CCMP-128'); assert.strictEqual(network.securityEnabled, true);
  });
  await test('Wi-Fi hidden SSIDs stay distinct by BSSID and Enhanced Open is not labeled unencrypted', () => {
    const facts = goodFacts();
    facts.networks = [...wifi.parseBssList(bssFixture({ ssid: '', bssid: '010203040506', ies: rsnIe([18]) }), facts.adapters[0].id), ...wifi.parseBssList(bssFixture({ ssid: '', bssid: '010203040507', ies: rsnIe([18]) }), facts.adapters[0].id)];
    const report = wifi.buildReport(facts);
    assert.strictEqual(report.networks.length, 2);
    assert.ok(report.networks.every((network) => network.hidden && network.ssid === '(hidden)'));
    assert.ok(report.networks.every((network) => network.authentication === 'Enhanced Open (OWE)'));
    assert.ok(!report.findings.some((finding) => finding.id === 'wifi-open'));
  });
  await test('Wi-Fi observations deduplicate one BSSID across adapters in channel counts', () => {
    const facts = goodFacts();
    facts.networks.push({ ...facts.networks[0] }, { ...facts.networks[0], adapterId: 'another' }, ...wifi.parseBssList(bssFixture({ bssid: '010203040506' }), facts.adapters[0].id));
    const report = wifi.buildReport(facts);
    assert.strictEqual(report.networks.length, 3); assert.strictEqual(report.channels.length, 1); assert.strictEqual(report.channels[0].bssidCount, 2);
    assert.strictEqual(report.channels[0].strongestRssiDbm, -57);
    assert.ok(report.limitations.some((line) => /not airtime/.test(line)));
    assert.ok(report.limitations.some((line) => /collection time does not establish/.test(line)));
  });
  await test('Wi-Fi security observations flag open, WEP, TKIP, original WPA, and low signal without claiming compromise', () => {
    const facts = goodFacts(); facts.adapters[0].connection.signalPercent = 25;
    facts.networks = [
      ...wifi.parseBssList(bssFixture({ privacy: false, ies: Buffer.alloc(0) }), facts.adapters[0].id),
      { ...facts.networks[0], bssid: '01:02:03:04:05:06', authentication: 'WPA-Personal', encryption: 'TKIP' },
      { ...facts.networks[0], bssid: '01:02:03:04:05:07', authentication: 'Shared key', encryption: 'WEP' },
    ];
    const findings = wifi.buildReport(facts).findings;
    assert.strictEqual(findings.find((finding) => finding.id === 'wifi-open').status, 'warning');
    assert.match(findings.find((finding) => finding.id === 'wifi-legacy').evidence, /2 BSSID/);
    assert.strictEqual(findings.find((finding) => finding.id === 'wifi-low-signal').status, 'warning');
  });
  await test('Wi-Fi missing permissions and empty evidence remain unknown with a location explanation', () => {
    const facts = goodFacts(); facts.adapters[0].connection = null; facts.adapters[0].issues = [wifi.errorText(5)]; facts.networks = [];
    const report = wifi.buildReport(facts);
    assert.strictEqual(report.findings.find((finding) => finding.id === 'wifi-unavailable').status, 'unknown');
    assert.match(report.findings[0].evidence, /Privacy & security > Location/);
    assert.ok(!report.findings.some((finding) => finding.status === 'pass'));
    assert.ok(wifi.buildReport({ adapters: [], networks: [] }).findings.some((finding) => finding.id === 'wifi-no-adapters'));
  });
  await test('Wi-Fi malformed beacon IEs and conflicting SSID defaults do not become secure or open defaults', () => {
    const malformed = Buffer.from([48, 200, 1]);
    const parsed = wifi.parseBssList(bssFixture({ ies: malformed }), 'adapter');
    assert.strictEqual(parsed[0].authentication, 'Unknown'); assert.strictEqual(parsed[0].securityEnabled, true);
    const choices = wifi.parseAvailable(availableFixture());
    assert.strictEqual(wifi.parseBssList(bssFixture({ ies: Buffer.alloc(0) }), 'adapter', choices)[0].authentication, 'WPA2-Personal');
    choices.push({ ...choices[0], authentication: 'Shared key', encryption: 'WEP' });
    assert.strictEqual(wifi.parseBssList(bssFixture({ ies: Buffer.alloc(0) }), 'adapter', choices)[0].authentication, 'Unknown');
    assert.strictEqual(wifi.parseSecurityIe(malformed, false).securityEnabled, null);
  });
  await test('Wi-Fi native buffers reject truncation, oversized counts, oversized SSIDs, and malicious IE offsets', () => {
    assert.throws(() => wifi.parseInterfaces(Buffer.alloc(3)), /Invalid/);
    const interfaces = interfaceFixture(); interfaces.writeUInt32LE(65, 0); assert.throws(() => wifi.parseInterfaces(interfaces), /bounds/);
    assert.throws(() => wifi.parseConnection(Buffer.alloc(603)), /Invalid/);
    const available = availableFixture(); available.writeUInt32LE(4097, 0); assert.throws(() => wifi.parseAvailable(available), /bounds/);
    const hugeSsid = bssFixture(); hugeSsid.writeUInt32LE(33, 8); assert.throws(() => wifi.parseBssList(hugeSsid, 'a'), /SSID/);
    const outOfBounds = bssFixture(); outOfBounds.writeUInt32LE(0xfffffff0, 360);
    assert.strictEqual(wifi.parseBssList(outOfBounds, 'a')[0].authentication, 'Unknown');
    const badCount = bssFixture(); badCount.writeUInt32LE(5000, 4); assert.throws(() => wifi.parseBssList(badCount, 'a'), /bounds/);
    assert.throws(() => wifi.buildReport({ adapters: [], networks: Array(4097).fill({}) }), /Invalid/);
  });
  await test('Wi-Fi report normalizes untrusted text and rejects impossible signal readings', () => {
    const facts = goodFacts(); facts.networks[0].ssid = '<img onerror=alert(1)>\0'; facts.networks[0].rssiDbm = 500; facts.networks[0].signalPercent = 101;
    const report = wifi.buildReport(facts);
    assert.strictEqual(report.networks[0].ssid, '<img onerror=alert(1)>\ufffd');
    assert.strictEqual(report.networks[0].rssiDbm, null); assert.strictEqual(report.networks[0].signalPercent, null);
    assert.strictEqual(report.networks[0].connected, true);
    assert.ok(!('guidBytes' in report.adapters[0]));
  });
  await test('Wi-Fi native query uses cache-only WLAN functions and frees each returned allocation', () => {
    const fixture = fakeNativeModule(); const facts = fixture.wifi.collectNative();
    assert.strictEqual(facts.adapters.length, 1); assert.strictEqual(facts.networks.length, 1);
    assert.strictEqual(fixture.freed.length, 4);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fixture.calls)), [['query', 7], ['available', 0], ['bss', null, 3, 0], 'closed']);
    assert.strictEqual(facts.adapters[0].guidBytes, undefined);
  });
  await test('Wi-Fi native denied queries preserve adapter data and release the client handle', () => {
    const fixture = fakeNativeModule({ WlanQueryInterface() { return 5; }, WlanGetAvailableNetworkList() { return 5; }, WlanGetNetworkBssList() { return 5; } });
    const facts = fixture.wifi.collectNative();
    assert.strictEqual(facts.adapters[0].connection, null); assert.strictEqual(facts.adapters[0].issues.length, 3);
    assert.strictEqual(fixture.calls.at(-1), 'closed'); assert.strictEqual(fixture.freed.length, 1);
    const broken = fakeNativeModule({ WlanEnumInterfaces(h, reserved, output) { output[0] = Buffer.alloc(8); output[0].writeUInt32LE(100, 0); return 0; } });
    assert.throws(() => broken.wifi.collectNative(), /bounds/); assert.strictEqual(broken.calls.at(-1), 'closed'); assert.strictEqual(broken.freed.length, 1);
  });
  await test('Wi-Fi child query is bounded, hidden, shell-free, and returns only normalized report fields', async () => {
    let invoked;
    const report = await wifi.collectInventory('survey', {}, (executable, args, options, callback) => {
      invoked = { executable, args, options };
      callback(null, JSON.stringify(goodFacts())); return { kill() { throw new Error('already finished'); } };
    });
    assert.strictEqual(report.kind, 'wifi'); assert.strictEqual(invoked.options.windowsHide, true); assert.strictEqual(invoked.options.timeout, 25000); assert.strictEqual(invoked.options.maxBuffer, 4 * 1024 * 1024);
    assert.strictEqual(invoked.options.env.ELECTRON_RUN_AS_NODE, '1'); assert.strictEqual(invoked.options.shell, undefined);
    assert.deepStrictEqual(invoked.args.slice(0, 1), ['-e']); assert.match(invoked.args[1], /collectNative\("survey"\)/);
  });
  await test('Wi-Fi cancellation kills only its own child and cannot emit a stale report', async () => {
    const signal = {}; let callback; let killed = 0;
    const pending = wifi.collectInventory('survey', signal, (executable, args, options, done) => { callback = done; return { kill() { killed++; callback(new Error('killed')); } }; });
    signal.stopped = true; signal.onStop();
    await assert.rejects(pending, /cancelled/); assert.strictEqual(killed, 1); assert.strictEqual(signal.onStop, undefined);
    callback(null, JSON.stringify(goodFacts()));
    assert.throws(() => wifi.collectInventory('survey', { stopped: true }, () => { throw new Error('must not spawn'); }), /cancelled/);
  });
  await test('Wi-Fi child failures, timeouts, invalid JSON, and unsupported actions fail clearly', async () => {
    await assert.rejects(wifi.collectInventory('survey', {}, (exe, args, options, done) => { done({ killed: true }, ''); return {}; }), /time or output limit/);
    await assert.rejects(wifi.collectInventory('survey', {}, (exe, args, options, done) => { done(null, 'garbled'); return {}; }), /invalid data/);
    await assert.rejects(wifi.collectInventory('survey', {}, (exe, args, options, done) => { done(null, JSON.stringify({ error: wifi.errorText(5) })); return {}; }), /Privacy & security > Location/);
    await assert.rejects(wifi.run({ action: 'connect' }, () => {}), /supported/);
    await assert.rejects(wifi.run({ activeScan: true }, () => {}), /not supported/);
    await assert.rejects(wifi.run([], () => {}), /supported/);
  });
}

module.exports = { runWifiTests };
