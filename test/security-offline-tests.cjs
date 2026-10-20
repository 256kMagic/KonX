'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const offline = require('../src/main/security/offline');
const HEADER = 'version 17.12\nhostname fixture-router\ninterface GigabitEthernet0/1\n!\n';
const check = (report, id) => report.checks.find((item) => item.id === id);

function pcap(records, linktype = 1, little = true) {
  const total = 24 + records.reduce((n, data) => n + 16 + data.length, 0);
  const out = Buffer.alloc(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0xa1b2c3d4, little);
  view.setUint16(4, 2, little); view.setUint16(6, 4, little);
  view.setUint32(16, 65535, little); view.setUint32(20, linktype, little);
  let offset = 24;
  for (let i = 0; i < records.length; i++) {
    const data = records[i];
    view.setUint32(offset, i + 1, little);
    view.setUint32(offset + 8, data.length, little); view.setUint32(offset + 12, data.length, little);
    out.set(data, offset + 16); offset += data.length + 16;
  }
  return out;
}

async function fixtureFiles(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-security-fixture-'));
  const created = [];
  try {
    await run(directory, async (name, bytes) => {
      const file = path.join(directory, name);
      assert.equal(path.dirname(file), directory);
      await fs.writeFile(file, bytes);
      created.push(file);
      return file;
    }, created);
  } finally {
    // Delete only the exact synthetic files created by this fixture.
    for (const file of created) await fs.unlink(file);
    await fs.rmdir(directory);
  }
}

async function runSecurityOfflineTests(test) {
  console.log('security: offline config and packet observations');
  await test('config flags explicit management and credential settings without leaking values', async () => {
    const report = await offline.analyzeConfig(HEADER + [
      'username never-export-this-user privilege 15 password 0 NEVER_EXPORT_PASSWORD',
      'enable password 0 NEVER_EXPORT_ENABLE', 'snmp-server community NEVER_EXPORT_COMMUNITY RO',
      'line vty 0 4', ' transport input ssh telnet', '!', 'ip http server', 'ip ssh version 1',
      'no aaa new-model', 'no logging on', 'no ntp authenticate',
    ].join('\n'));
    for (const id of ['config-telnet', 'config-http', 'config-user-cleartext', 'config-enable-cleartext', 'config-snmp', 'config-ssh', 'config-aaa', 'config-logging', 'config-ntp']) assert.equal(check(report, id).status, 'warning', id);
    assert.match(check(report, 'config-user-cleartext').evidence, /Lines 5:/);
    assert.doesNotMatch(JSON.stringify(report), /NEVER_EXPORT|never-export-this-user|fixture-router|GigabitEthernet/);
  });
  await test('config recognizes reversible type 7 but does not call strong hashes cleartext', async () => {
    const report = await offline.analyzeConfig(HEADER + 'username alice secret 9 FAKE_HASH\nusername bob password 7 FAKE_REVERSIBLE\nenable secret 8 FAKE_HASH2');
    assert.equal(check(report, 'config-user-cleartext').status, 'unknown');
    assert.equal(check(report, 'config-enable-cleartext').status, 'unknown');
    assert.equal(check(report, 'config-user-reversible').status, 'warning');
    assert.doesNotMatch(JSON.stringify(report), /FAKE_|alice|bob/);
  });
  await test('config flags untyped secret literals in provisioning configs as exposed text', async () => {
    const report = await offline.analyzeConfig(HEADER + 'username provisioned secret NEVER_EXPORT_LITERAL\nenable secret NEVER_EXPORT_ENABLE_LITERAL');
    assert.equal(check(report, 'config-user-cleartext').status, 'warning');
    assert.equal(check(report, 'config-enable-cleartext').status, 'warning');
    assert.doesNotMatch(JSON.stringify(report), /NEVER_EXPORT|provisioned/);
  });
  await test('config handles explicit no commands and VTY-specific overrides', async () => {
    const report = await offline.analyzeConfig(HEADER + [
      'ip http server', 'no ip http server', 'feature telnet', 'no feature telnet',
      'line vty 0 4', ' transport input telnet', ' transport input ssh', '!',
      'snmp-server community REMOVE_ME RO', 'no snmp-server community REMOVE_ME',
      'username deleted password REMOVE_ME', 'no username deleted',
      'enable password REMOVE_ME', 'no enable password', 'ip ssh version 2',
    ].join('\n'));
    for (const id of ['config-telnet', 'config-user-cleartext', 'config-enable-cleartext', 'config-snmp']) assert.equal(check(report, id).status, 'unknown', id);
    assert.equal(check(report, 'config-http').status, 'info');
    assert.equal(check(report, 'config-ssh').status, 'info');
  });
  await test('config keeps separate VTY ranges and ignores command-like banners', async () => {
    const report = await offline.analyzeConfig(HEADER + [
      'banner motd ^C', 'ip http server', 'username hidden password SECRET_BANNER', '^C',
      'line vty 0 4', ' transport input telnet', '!', 'line vty 5 15', ' transport input ssh',
    ].join('\n'));
    assert.equal(check(report, 'config-http').status, 'unknown');
    assert.equal(check(report, 'config-user-cleartext').status, 'unknown');
    assert.equal(check(report, 'config-telnet').status, 'warning');
    assert.match(check(report, 'config-telnet').evidence, /Lines 10:/);
  });
  await test('unsupported config families and omissions never produce false all-pass reports', async () => {
    const report = await offline.analyzeConfig('set system host-name fixture\nset system services telnet');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].status, 'unknown');
    const missing = await offline.analyzeConfig(HEADER);
    assert.ok(missing.checks.some((c) => c.status === 'unknown'));
    assert.ok(!missing.checks.some((c) => c.status === 'pass'));
    const wrongFamily = await offline.analyzeConfig(HEADER, { family: 'junos' });
    assert.equal(wrongFamily.checks.length, 1);
  });
  await test('explicit NX-OS family supports settings and reports NTP/logging as observations', async () => {
    const report = await offline.analyzeConfig('feature telnet\nlogging server 192.0.2.5\nntp server 192.0.2.123\naaa new-model', { family: 'nx-os' });
    assert.equal(check(report, 'config-telnet').status, 'warning');
    for (const id of ['config-logging', 'config-ntp', 'config-aaa']) assert.equal(check(report, id).status, 'info');
    assert.doesNotMatch(JSON.stringify(report), /192\.0\.2/);
  });
  await test('configuration work yields to cancellation and bounds oversized lines', async () => {
    const signal = { stopped: false };
    const pending = offline.analyzeConfig(HEADER + '! fixture\n'.repeat(3000), { signal });
    setImmediate(() => { signal.stopped = true; });
    await assert.rejects(pending, /cancelled/);
    const report = await offline.analyzeConfig(HEADER + 'username ' + 'x'.repeat(70000) + '\n');
    assert.equal(check(report, 'config-limits').status, 'unknown');
    await assert.rejects(offline.analyzeConfig(HEADER + '\0binary'), /NUL/);
  });

  const moduleUrl = (file) => pathToFileURL(path.join(__dirname, file)).href;
  const P = await import(moduleUrl('lib/packets.mjs'));
  const { writePcapng } = await import(moduleUrl('../src/renderer/js/capture/pcapfile.mjs'));
  const m1 = '02:00:00:00:00:01', m2 = '02:00:00:00:00:02';
  const tcp = (payload, dport, sport = 50123) => P.frame.tcp(m1, m2, '192.0.2.1', '192.0.2.2', { sport, dport, seq: 1, flags: 'PA' }, P.str(payload));
  const httpCredentials = tcp('GET / HTTP/1.1\r\nHost: never-export-host\r\nAuthorization: Basic ' + Buffer.from('NEVER_EXPORT_USER:NEVER_EXPORT_PASS').toString('base64') + '\r\n\r\n', 80);
  await test('offline capture detects cleartext HTTP credentials and redacts every credential value', async () => {
    const report = await offline.analyzeCapture(writePcapng([{ ts: 1, linktype: 1, data: httpCredentials }]));
    assert.equal(check(report, 'capture-cleartext-credentials').severity, 'high');
    assert.match(check(report, 'capture-cleartext-credentials').evidence, /Frames 1/);
    assert.doesNotMatch(JSON.stringify(report), /NEVER_EXPORT|never-export-host|Authorization|192\.0\.2/);
  });
  await test('capture detects SNMP communities and FTP passwords without publishing them', async () => {
    const snmp = P.frame.udp(m1, m2, '192.0.2.1', '192.0.2.2', { sport: 50123, dport: 161 }, P.snmpGet('NEVER_EXPORT_COMMUNITY', '1.3.6.1.2.1.1.1.0'));
    const report = await offline.analyzeCapture(pcap([snmp, tcp('USER NEVER_EXPORT_FTP_USER\r\n', 21), tcp('PASS NEVER_EXPORT_FTP_PASS\r\n', 21)]));
    assert.ok(check(report, 'capture-protocol-snmpv2c'));
    assert.ok(check(report, 'capture-cleartext-credentials'));
    assert.doesNotMatch(JSON.stringify(report), /NEVER_EXPORT|community \"|FTP_USER/);
  });
  await test('capture maps old TLS only from negotiated ServerHello evidence', async () => {
    const hello = P.tlsServerHello();
    // Legacy version TLS 1.0, with TLS 1.3 supported_versions extension removed.
    const legacy = hello.slice(0, 49);
    legacy[4] = 44; legacy[8] = 40; legacy[10] = 1; legacy[47] = 0; legacy[48] = 0;
    const frame = P.frame.tcp(m2, m1, '192.0.2.2', '192.0.2.1', { sport: 443, dport: 50123, seq: 1, flags: 'PA' }, legacy);
    const report = await offline.analyzeCapture(pcap([frame], 1, false));
    assert.ok(check(report, 'capture-old-tls'));
    assert.match(check(report, 'capture-old-tls').evidence, /Frames 1/);
  });
  await test('ARP and DHCP findings describe observations rather than proven attacks', async () => {
    const broadcast = 'ff:ff:ff:ff:ff:ff';
    const frames = [
      P.eth(broadcast, m1, 0x0806, P.arp(1, m1, '192.0.2.20', '00:00:00:00:00:00', '192.0.2.2')),
      P.eth(broadcast, m2, 0x0806, P.arp(1, m2, '192.0.2.20', '00:00:00:00:00:00', '192.0.2.2')),
      ...[1, 2].map((n) => P.frame.udp(n === 1 ? m1 : m2, broadcast, `192.0.2.${n}`, '255.255.255.255', { sport: 67, dport: 68 }, P.dhcp({ op: 2, type: 2, xid: 1, chaddr: m1, server: `192.0.2.${n}`, yiaddr: '192.0.2.50' }))),
    ];
    const report = await offline.analyzeCapture(pcap(frames));
    for (const id of ['capture-arp-conflict', 'capture-dhcp-servers']) {
      assert.equal(check(report, id).confidence, 'medium');
      assert.match(check(report, id).evidence, /not proof/);
      assert.match(check(report, id).evidence, /Frames/);
    }
  });
  await test('no-indicator and unsupported captures remain unknown, never clean or all-pass', async () => {
    const empty = await offline.analyzeCapture(pcap([]));
    assert.equal(check(empty, 'capture-no-indicators').status, 'unknown');
    const unsupported = await offline.analyzeCapture(pcap([Buffer.alloc(12)], 999));
    assert.equal(check(unsupported, 'capture-limits').status, 'unknown');
    assert.match(check(unsupported, 'capture-scope').evidence, /1 unsupported/);
    assert.ok(!unsupported.checks.some((item) => item.status === 'pass'));
  });
  await test('capture rejects malformed record lengths and bytes beyond the size bound', async () => {
    const bad = pcap([Buffer.alloc(2)]);
    bad.writeUInt32LE(1000, 32);
    await assert.rejects(offline.analyzeCapture(bad), /truncated packet length/);
    const badNg = writePcapng([{ ts: 1, data: Buffer.from([1, 2]) }]);
    badNg[badNg.length - 4] ^= 4;
    await assert.rejects(offline.analyzeCapture(badNg), /block length/);
    await assert.rejects(offline.analyzeCapture(new Uint8Array(offline.MAX_BYTES + 1)), /32 MiB/);
  });
  await test('capture caps packet allocation at 50,000 and yields during preflight', async () => {
    const input = pcap(new Array(offline.MAX_PACKETS + 2).fill(Buffer.alloc(0)), 999);
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const report = await offline.analyzeCapture(input);
    assert.equal(yielded, true);
    assert.match(check(report, 'capture-scope').evidence, /^50000 packet records/);
    assert.match(check(report, 'capture-limits').evidence, /50,000/);
    const signal = { stopped: false };
    const pending = offline.analyzeCapture(input, { signal });
    setImmediate(() => { signal.stopped = true; });
    await assert.rejects(pending, /cancelled/);
  });
  await test('capture omits very large individual packets and reports incomplete coverage', async () => {
    const report = await offline.analyzeCapture(pcap([Buffer.alloc(262145)]));
    assert.match(check(report, 'capture-scope').evidence, /1 oversized/);
    assert.equal(check(report, 'capture-limits').status, 'unknown');
  });
  await test('file wrappers accept only bounded synthetic regular files and redact IO paths', async () => {
    await fixtureFiles(async (directory, write, created) => {
      const config = await write('fixture.cfg', HEADER + 'ip http server');
      const capture = await write('fixture.pcap', pcap([httpCredentials]));
      assert.equal(check(await offline.scanConfig({ filePath: config }), 'config-http').status, 'warning');
      assert.ok(check(await offline.scanCapture({ filePath: capture }), 'capture-cleartext-credentials'));
      await assert.rejects(offline.scanCapture({ filePath: directory }), /regular file/);
      const absent = path.join(directory, 'DO_NOT_ECHO_THIS_PATH');
      await assert.rejects(offline.scanCapture({ filePath: absent }), (error) => /ENOENT/.test(error.message) && !error.message.includes('DO_NOT_ECHO'));
      const large = path.join(directory, 'large-synthetic.bin'); created.push(large);
      const handle = await fs.open(large, 'w');
      try { await handle.write(Buffer.from([0]), 0, 1, offline.MAX_BYTES); } finally { await handle.close(); }
      await assert.rejects(offline.scanCapture({ filePath: large }), /32 MiB/);
      await assert.rejects(offline.scanConfig({ filePath: config }, { stopped: true }), /cancelled/);
    });
  });
}

module.exports = { runSecurityOfflineTests };
