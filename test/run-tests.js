'use strict';
// End-to-end tests for the main-process modules (no Electron needed):
//   node test/run-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const nettools = require('../src/main/nettools');
const { TelnetConnection } = require('../src/main/telnet');
const { ConnectionManager, stripAnsi, unescapeSend, expandLogPath } = require('../src/main/connections');
const { SftpManager } = require('../src/main/sftp');
const { Store } = require('../src/main/store');
const importers = require('../src/main/importers');
const { startServer } = require('./ssh-test-server');

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([true, name, Date.now() - t0]);
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push([false, name, Date.now() - t0, e]);
    console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 4).join('\n       ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error('Timed out waiting for ' + what);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-test-'));
// Reversible stand-in for safeStorage so the secret round-trip is exercised.
const fakeCrypt = {
  available: () => true,
  encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
  decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString(),
};

(async () => {
  console.log('nettools');
  await test('parseTargets expands CIDR, ranges, wildcards and names', () => {
    assert.strictEqual(nettools.parseTargets('192.168.1.0/24').length, 254);
    assert.deepStrictEqual(nettools.parseTargets('10.0.0.1-3'), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    assert.deepStrictEqual(nettools.parseTargets('10.0.0.254-10.0.1.1'), ['10.0.0.254', '10.0.0.255', '10.0.1.0', '10.0.1.1']);
    assert.strictEqual(nettools.parseTargets('172.16.5.*').length, 254);
    assert.deepStrictEqual(nettools.parseTargets('10.1.1.1/32, router.lan'), ['10.1.1.1', 'router.lan']);
    assert.deepStrictEqual(nettools.parseTargets('10.1.1.0/31'), ['10.1.1.0', '10.1.1.1']);
    assert.throws(() => nettools.parseTargets('10.0.0.0/8'), /limit/);
    assert.throws(() => nettools.parseTargets('300.1.1.1'));
  });
  await test('parsePorts handles lists, ranges and presets', () => {
    assert.deepStrictEqual(nettools.parsePorts('22, 80,443 8000-8002'), [22, 80, 443, 8000, 8001, 8002]);
    assert.strictEqual(nettools.parsePorts('top100').length, 100);
    assert.ok(nettools.parsePorts('network').includes(830));
    assert.throws(() => nettools.parsePorts('70000'));
  });
  await test('pingOnce gets a reply from 127.0.0.1', async () => {
    const r = await nettools.pingOnce('127.0.0.1', { timeout: 1000 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.ms >= 0 && r.ms < 1000);
    assert.ok(r.ttl > 0);
  });
  await test('pingOnce reports failure for an unroutable address', async () => {
    const r = await nettools.pingOnce('192.0.2.254', { timeout: 500 });
    assert.strictEqual(r.ok, false);
  });

  const listener = net.createServer((s) => {
    s.write('SSH-2.0-TestBanner_1.0\r\n');
    s.on('error', () => {});
  });
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const openPort = listener.address().port;
  const closedServer = net.createServer();
  await new Promise((r) => closedServer.listen(0, '127.0.0.1', r));
  const closedPort = closedServer.address().port;
  await new Promise((r) => closedServer.close(r));

  await test('probePort: open with banner, closed, filtered', async () => {
    const open = await nettools.probePort('127.0.0.1', openPort, { timeout: 1000, banner: true });
    assert.strictEqual(open.state, 'open');
    assert.strictEqual(open.banner, 'SSH-2.0-TestBanner_1.0');
    const closed = await nettools.probePort('127.0.0.1', closedPort, { timeout: 1000 });
    assert.strictEqual(closed.state, 'closed');
    const filtered = await nettools.probePort('192.0.2.1', 81, { timeout: 300 });
    assert.ok(['filtered', 'unreachable'].includes(filtered.state), filtered.state);
  });
  await test('portScan reports only the open port and accurate counts', async () => {
    const events = [];
    await nettools.portScan({ targets: '127.0.0.1', ports: `${openPort},${closedPort}`, timeout: 800, banner: true }, (t, d) => events.push([t, d]), { stopped: false });
    const res = events.filter(([t]) => t === 'result').map(([, d]) => d);
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].port, openPort);
    const last = events.filter(([t]) => t === 'progress').pop()[1];
    assert.deepStrictEqual([last.done, last.total, last.open, last.closed], [2, 2, 1, 1]);
  });
  await test('sweep finds loopback hosts and can be stopped', async () => {
    const found = [];
    await nettools.sweep({ targets: '127.0.0.1-3', timeout: 800, resolveNames: false, macs: false, tcpFallback: false }, (t, d) => t === 'result' && found.push(d.ip), { stopped: false });
    assert.deepStrictEqual(found.sort(), ['127.0.0.1', '127.0.0.2', '127.0.0.3']);
    const sig = { stopped: true };
    const none = [];
    await nettools.sweep({ targets: '127.0.0.0/24', resolveNames: false, macs: false }, (t, d) => t === 'result' && none.push(d), sig);
    assert.strictEqual(none.length, 0);
  });
  await test('pingMonitor emits resolved + replies for each host', async () => {
    const ev = [];
    await nettools.pingMonitor({ hosts: '127.0.0.1 localhost', count: 2, interval: 100, timeout: 800 }, (t, d) => ev.push([t, d]), { stopped: false });
    const replies = ev.filter(([t]) => t === 'reply').map(([, d]) => d);
    assert.strictEqual(replies.length, 4);
    assert.ok(replies.every((r) => r.ok));
    assert.strictEqual(ev.filter(([t]) => t === 'resolved').length, 2);
  });
  await test('parseTraceLine understands Windows tracert output', () => {
    if (process.platform !== 'win32') return;
    assert.deepStrictEqual(nettools.parseTraceLine('  1    <1 ms    <1 ms    <1 ms  192.168.1.1'), { hop: 1, rtts: [0.5, 0.5, 0.5], host: '192.168.1.1', ip: '192.168.1.1' });
    const t = nettools.parseTraceLine('  2    12 ms     *       14 ms  core.isp.net [203.0.113.9]');
    assert.deepStrictEqual(t, { hop: 2, rtts: [12, null, 14], host: 'core.isp.net', ip: '203.0.113.9' });
    const to = nettools.parseTraceLine('  3     *        *        *     Request timed out.');
    assert.deepStrictEqual(to.rtts, [null, null, null]);
  });
  await test('traceroute to 127.0.0.1 reaches the target in one hop', async () => {
    const hops = [];
    await nettools.traceroute({ host: '127.0.0.1', maxHops: 3, timeout: 500 }, (t, d) => t === 'hop' && hops.push(d), { stopped: false });
    assert.ok(hops.length >= 1, 'no hops');
    assert.strictEqual(hops[0].ip, '127.0.0.1');
  });
  await test('dnsLookup via the OS resolver and reverse IP', async () => {
    const r = await nettools.dnsLookup({ name: 'localhost', type: 'SYSTEM' });
    assert.ok(r.records.some((x) => x.value === '127.0.0.1' || x.value === '::1'), JSON.stringify(r.records));
  });
  await test('wakeOnLan builds a 102-byte packet and validates MACs', async () => {
    const recv = require('dgram').createSocket('udp4');
    await new Promise((r) => recv.bind(0, '127.0.0.1', r));
    const got = new Promise((r) => recv.once('message', r));
    const res = await nettools.wakeOnLan({ mac: '00-11-22-aa-bb-cc', broadcast: '127.0.0.1', port: recv.address().port });
    const msg = await got;
    recv.close();
    assert.strictEqual(res.bytes, 102);
    assert.strictEqual(msg.subarray(0, 6).toString('hex'), 'ffffffffffff');
    assert.strictEqual(msg.subarray(6, 12).toString('hex'), '001122aabbcc');
    assert.throws(() => nettools.wakeOnLan({ mac: 'zz' }));
  });
  await test('interfaces and default sweep target', () => {
    const ifs = nettools.interfaces();
    assert.ok(ifs.some((i) => i.address === '127.0.0.1'));
    assert.match(nettools.defaultSweepTarget(), /^\d+\.\d+\.\d+\.\d+\/\d+$/);
  });

  console.log('helpers');
  await test('stripAnsi / unescapeSend / expandLogPath', () => {
    assert.strictEqual(stripAnsi('\x1b[1;32mhello\x1b[0m \x1b]0;title\x07world'), 'hello world');
    assert.strictEqual(unescapeSend('show run\\r\\x03\\t'), 'show run\r\x03\t');
    assert.match(expandLogPath('C:/logs/%S_%Y.log', { name: 'core/sw1' }), /^C:\/logs\/core_sw1_\d{4}\.log$/);
  });

  console.log('store + importers');
  await test('store keeps secrets out of the renderer view', () => {
    const st = new Store(path.join(tmp, 'store'), fakeCrypt);
    const saved = st.saveSession({ name: 'r1', host: '10.0.0.1', folder: 'Lab/Core', password: 'hunter2' });
    assert.strictEqual(saved.hasPassword, true);
    assert.strictEqual(saved.password, undefined);
    assert.strictEqual(saved.passwordEnc, undefined);
    assert.deepStrictEqual(st.listSessions().folders.sort(), ['Lab', 'Lab/Core']);
    assert.strictEqual(st.getSessionSecret(saved.id).password, 'hunter2');
    st.saveSession({ id: saved.id, name: 'r1b' }); // password untouched
    assert.strictEqual(st.getSessionSecret(saved.id).password, 'hunter2');
    st.saveSession({ id: saved.id, password: null }); // cleared
    assert.strictEqual(st.getSessionSecret(saved.id).password, undefined);
    st.renameFolder('Lab', 'Datacenter');
    assert.strictEqual(st.listSessions().sessions[0].folder, 'Datacenter/Core');
    const raw = fs.readFileSync(path.join(tmp, 'store', 'sessions.json'), 'utf8');
    assert.ok(!raw.includes('hunter2'));
  });
  await test('SecureCRT .ini and ssh_config import', () => {
    const dir = path.join(tmp, 'crt', 'Sessions', 'Branch');
    fs.mkdirSync(dir, { recursive: true });
    const ini = '\ufeffS:"Protocol Name"=SSH2\r\nS:"Hostname"=10.20.30.40\r\nS:"Username"=netops\r\nD:"[SSH2] Port"=00000016\r\n';
    fs.writeFileSync(path.join(dir, 'edge-rtr.ini'), ini);
    fs.writeFileSync(path.join(dir, '__FolderData__.ini'), 'S:"Folder List"=\r\n');
    fs.writeFileSync(path.join(dir, 'console.ini'), 'S:"Protocol Name"=Serial\r\nS:"Com Port"=COM4\r\nD:"Baud Rate"=00002580\r\n');
    const items = importers.importSecureCrt(path.join(tmp, 'crt', 'Sessions'));
    const edge = items.find((i) => i.name === 'edge-rtr');
    assert.deepStrictEqual([edge.host, edge.username, edge.port, edge.protocol, edge.folder], ['10.20.30.40', 'netops', 22, 'ssh', 'SecureCRT/Branch']);
    const con = items.find((i) => i.name === 'console');
    assert.deepStrictEqual([con.protocol, con.serialPort, con.baudRate], ['serial', 'COM4', 9600]);
    assert.strictEqual(items.length, 2);
    const cfg = path.join(tmp, 'ssh_config');
    fs.writeFileSync(cfg, 'Host bastion\n  HostName 203.0.113.10\n  User ops\nHost web01 web01.lan\n  HostName 10.0.0.21\n  Port 2222\n  ProxyJump bastion\nHost *\n  ServerAliveInterval 30\n');
    const s = importers.importSshConfig(cfg);
    assert.strictEqual(s.length, 2);
    assert.deepStrictEqual([s[1].host, s[1].port, s[1].jumpName], ['10.0.0.21', 2222, 'bastion']);
  });

  console.log('telnet');
  await test('telnet negotiates TTYPE/NAWS, echoes, and auto-login answers prompts', async () => {
    const IAC = 255;
    const seen = [];
    let gotUser = '';
    let gotPass = '';
    const srv = net.createServer((s) => {
      s.write(Buffer.from([IAC, 253, 24, IAC, 253, 31, IAC, 251, 1]));
      s.write(Buffer.from([IAC, 250, 24, 1, IAC, 240]));
      s.write('User Access Verification\r\n\r\nUsername: ');
      let buf = '';
      s.on('data', (d) => {
        seen.push(...d);
        buf += d.toString('latin1').replace(/\xff[\xfb-\xfe]./g, '').replace(/\xff\xfa[\s\S]*?\xff\xf0/g, '');
        if (!gotUser && buf.includes('\r\n')) {
          gotUser = buf.split('\r\n')[0];
          buf = buf.slice(buf.indexOf('\r\n') + 2);
          s.write('Password: ');
        } else if (gotUser && !gotPass && buf.includes('\r\n')) {
          gotPass = buf.split('\r\n')[0];
          s.write('\r\nrouter>');
        }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const store = new Store(path.join(tmp, 'tstore'), fakeCrypt);
    const out = [];
    const cm = new ConnectionManager({ emit: (ch, id, d) => ch === 'conn:data' && out.push(Buffer.from(d).toString()), ask: async () => null, store, defaultLogDir: () => tmp });
    const r = await cm.open('tel1', { protocol: 'telnet', host: '127.0.0.1', port: srv.address().port, username: 'admin', password: 's3cret' }, { cols: 132, rows: 40 });
    assert.ok(r.ok, r.error);
    await waitFor(() => out.join('').includes('router>'), 4000, 'router prompt');
    assert.strictEqual(gotUser, 'admin');
    assert.strictEqual(gotPass, 's3cret');
    const hex = Buffer.from(seen).toString('hex');
    assert.ok(hex.includes('fffb18'), 'WILL TTYPE');
    assert.ok(hex.includes('fffa1800787465726d2d323536636f6c6f72fff0'), 'TTYPE IS xterm-256color');
    assert.ok(hex.includes('fffa1f00840028fff0'), 'NAWS 132x40');
    assert.ok(hex.includes('fffd01'), 'DO ECHO');
    cm.close('tel1');
    srv.close();
  });

  console.log('ssh + sftp');
  const { server, root, port } = await startServer({ port: 0 });
  const store = new Store(path.join(tmp, 'sstore'), fakeCrypt);
  const session = store.saveSession({ name: 'lab', protocol: 'ssh', host: '127.0.0.1', port, username: 'test', password: 'test', auth: 'password', logging: { enabled: true, timestamps: true, path: path.join(tmp, 'logs', '%S.log') } });
  const asks = [];
  let answers = [];
  const ask = async (p) => {
    asks.push(p);
    return answers.length ? answers.shift() : null;
  };
  const out = [];
  const statuses = [];
  const emit = (ch, id, d) => {
    if (ch === 'conn:data') out.push(Buffer.from(d).toString());
    if (ch === 'conn:status') statuses.push(d);
  };
  const cm = new ConnectionManager({ emit, ask, store, defaultLogDir: () => tmp });

  await test('ssh: unknown host key is prompted, saved, and the shell works', async () => {
    answers = ['save'];
    const r = await cm.open('s1', { sessionId: session.id }, { cols: 100, rows: 30 });
    assert.ok(r.ok, r.error);
    assert.strictEqual(asks[0].kind, 'hostkey');
    assert.strictEqual(asks[0].keyType, 'ssh-ed25519');
    assert.match(asks[0].fingerprint, /^SHA256:/);
    assert.ok(store.hostKeyFor('127.0.0.1', port));
    assert.ok(r.info.cipher, 'cipher reported');
    await waitFor(() => out.join('').includes('lab-sw1#'), 4000, 'prompt');
    cm.write('s1', 'show version\r');
    await waitFor(() => out.join('').includes('TL-9300-48P'), 4000, 'show version output');
    cm.resize('s1', 120, 40);
    out.length = 0;
    cm.write('s1', 'cols\r');
    await waitFor(() => /\b120\b/.test(out.join('')), 4000, 'window-change');
  });
  await test('ssh: session log is written without escape codes', async () => {
    cm.close('s1');
    await sleep(200);
    const log = fs.readFileSync(path.join(tmp, 'logs', 'lab.log'), 'utf8');
    assert.ok(log.includes('Model Number'), 'log has output');
    assert.ok(!log.includes('\x1b['), 'no ANSI escapes');
    assert.match(log, /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\] /m);
  });
  await test('ssh: known host connects silently; wrong password re-prompts', async () => {
    asks.length = 0;
    const bad = store.saveSession({ name: 'bad', protocol: 'ssh', host: '127.0.0.1', port, username: 'test', password: 'wrong' });
    answers = [{ password: 'test' }];
    const r = await cm.open('s2', { sessionId: bad.id }, {});
    assert.ok(r.ok, r.error);
    assert.ok(!asks.some((a) => a.kind === 'hostkey'), 'no host key prompt the second time');
    assert.ok(asks.some((a) => a.kind === 'form' && /Access denied/.test(a.message || '')), 'retry prompt shown');
    cm.close('s2');
  });
  await test('ssh: a changed host key is flagged and rejected on cancel', async () => {
    asks.length = 0;
    store.saveHostKey('127.0.0.1', port, { keyType: 'ssh-ed25519', fingerprint: 'SHA256:not-the-real-key' });
    answers = ['reject'];
    const r = await cm.open('s3', { sessionId: session.id }, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(asks[0].kind, 'hostkey');
    assert.strictEqual(asks[0].changed, true);
    answers = ['save'];
    const r2 = await cm.open('s3', { sessionId: session.id }, {});
    assert.ok(r2.ok);
    cm.close('s3');
  });

  await test('ssh: local port forward tunnels a TCP connection', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    // The test server does not implement direct-tcpip, so add it for this test.
    server.once('connection', (client) => {
      client.on('tcpip', (accept, reject, info) => {
        const ch = accept();
        const sock = net.connect(info.destPort, info.destIP, () => sock.pipe(ch).pipe(sock));
      });
    });
    const fwdPort = 40000 + Math.floor(Math.random() * 20000);
    const fs2 = store.saveSession({ name: 'fwd', protocol: 'ssh', host: '127.0.0.1', port, username: 'test', password: 'test', forwards: [{ type: 'L', listenHost: '127.0.0.1', listenPort: fwdPort, destHost: '127.0.0.1', destPort: echo.address().port }] });
    const r = await cm.open('s4', { sessionId: fs2.id }, {});
    assert.ok(r.ok, r.error);
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect(fwdPort, '127.0.0.1', () => c.write('ping-through-tunnel'));
      c.on('data', (d) => {
        resolve(d.toString());
        c.end();
      });
      c.on('error', reject);
    });
    assert.strictEqual(reply, 'ping-through-tunnel');
    cm.close('s4');
    echo.close();
  });

  const sm = new SftpManager({ emit: () => {}, ask, store, connections: cm, openExternal: async () => {}, tempDir: () => path.join(tmp, 'edit') });
  await test('sftp: open, list, mkdir, upload, download, rename, chmod, delete', async () => {
    fs.writeFileSync(path.join(root, 'hello.txt'), 'hi there');
    const info = await sm.open('f1', { sessionId: session.id });
    assert.strictEqual(info.home, '/');
    let list = await sm.list('f1', '/');
    assert.ok(list.some((e) => e.name === 'hello.txt' && e.size === 8 && !e.isDir));
    await sm.mkdir('f1', '/uploads');
    // upload a folder tree
    const src = path.join(tmp, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.bin'), Buffer.alloc(300000, 7));
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'nested');
    const n = await sm.upload('f1', [src], '/uploads', { conflict: 'overwrite' });
    assert.strictEqual(n, 2);
    await waitFor(() => sm.queue.jobs.every((j) => j.status === 'done'), 8000, 'uploads');
    assert.strictEqual(fs.readFileSync(path.join(root, 'uploads', 'src', 'sub', 'b.txt'), 'utf8'), 'nested');
    assert.strictEqual(fs.statSync(path.join(root, 'uploads', 'src', 'a.bin')).size, 300000);
    // download it back
    const dst = path.join(tmp, 'dst');
    fs.mkdirSync(dst);
    await sm.download('f1', ['/uploads/src'], dst, { conflict: 'overwrite' });
    await waitFor(() => sm.queue.jobs.every((j) => j.status === 'done'), 8000, 'downloads');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'src', 'sub', 'b.txt'), 'utf8'), 'nested');
    // skip policy leaves existing files alone
    fs.writeFileSync(path.join(dst, 'src', 'sub', 'b.txt'), 'local edit');
    await sm.download('f1', ['/uploads/src/sub/b.txt'], path.join(dst, 'src', 'sub'), { conflict: 'skip' });
    await waitFor(() => sm.queue.jobs.every((j) => ['done', 'skipped'].includes(j.status)), 4000, 'skip');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'src', 'sub', 'b.txt'), 'utf8'), 'local edit');
    // "ask" policy routes through the prompt
    answers = [{ action: 'overwrite', all: true }];
    await sm.download('f1', ['/uploads/src/sub/b.txt'], path.join(dst, 'src', 'sub'), { conflict: 'ask' });
    await waitFor(() => sm.queue.jobs.every((j) => ['done', 'skipped'].includes(j.status)), 4000, 'ask');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'src', 'sub', 'b.txt'), 'utf8'), 'nested');
    assert.strictEqual(asks[asks.length - 1].kind, 'conflict');
    await sm.rename('f1', '/hello.txt', '/renamed.txt');
    await sm.chmod('f1', ['/renamed.txt'], 0o600);
    await sm.remove('f1', ['/uploads']);
    list = await sm.list('f1', '/');
    assert.ok(list.some((e) => e.name === 'renamed.txt'));
    assert.ok(!list.some((e) => e.name === 'uploads'));
    sm.close('f1');
  });
  await test('sftp: reuse the SSH connection of an open terminal tab', async () => {
    answers = [];
    const r = await cm.open('s5', { sessionId: session.id }, {});
    assert.ok(r.ok, r.error);
    const info = await sm.open('f2', { fromConn: 's5' });
    assert.strictEqual(info.home, '/');
    assert.ok((await sm.list('f2', '/')).length >= 1);
    sm.close('f2');
    // closing the SFTP tab must not drop the terminal
    await sleep(100);
    assert.ok(cm.sshClient('s5'), 'terminal still connected');
    cm.close('s5');
  });
  await test('sftp: cancelling a transfer stops it', async () => {
    fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(30 * 1024 * 1024, 1));
    await sm.open('f3', { sessionId: session.id });
    await sm.download('f3', ['/big.bin'], tmp, { conflict: 'overwrite' });
    const job = sm.queue.jobs[sm.queue.jobs.length - 1];
    await waitFor(() => job.status === 'running', 3000, 'running');
    sm.queue.cancel(job.id);
    await waitFor(() => !sm.queue.active.has(job.id), 5000, 'cancel to settle');
    assert.strictEqual(job.status, 'cancelled');
    sm.close('f3');
  });

  server.close();
  listener.close();

  const { runCaptureTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'capture-tests.mjs')).href);
  await runCaptureTests(test);

  const { runReassemblyTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'reassembly-tests.mjs')).href);
  await runReassemblyTests(test);
  const { runHttpTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'http-tests.mjs')).href);
  await runHttpTests(test);
  const { runStreamPreviewTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'stream-preview-tests.mjs')).href);
  await runStreamPreviewTests(test);
  await require('./capture-export-tests.cjs').runCaptureExportTests(test);
  await require('./traffic-ui-tests.cjs').runTrafficUiTests(test);
  await require('./capture-auto-scroll-tests.cjs').runCaptureAutoScrollTests(test);

  const { runSdpTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'sdp-tests.mjs')).href);
  await runSdpTests(test);
  const { runSipTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'sip-tests.mjs')).href);
  await runSipTests(test);
  const { runSipIntegrationTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'sip-integration-tests.mjs')).href);
  await runSipIntegrationTests(test);
  await require('./sip-navigation-tests.cjs').runSipNavigationTests(test);

  const { runBuiltinCaptureTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'builtin-capture-tests.mjs')).href);
  await runBuiltinCaptureTests(test);

  const { runNotepadTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'notepad-tests.mjs')).href);
  await runNotepadTests(test);

  await require('./sftp-regression-tests.cjs').runSftpRegressionTests(test);
  await require('./prompt-connection-regression-tests.cjs').runPromptConnectionRegressionTests(test);
  await require('./notepad-save-regression-tests.cjs').runNotepadSaveRegressionTests(test);
  await require('./capture-lifecycle-regression-tests.cjs').runCaptureLifecycleRegressionTests(test);
  await require('./ssh-close-regression-tests.cjs').runSshCloseRegressionTests(test);
  await require('./tab-close-ui-regression-tests.cjs').runTabCloseUiRegressionTests(test);
  await require('./connection-review-regression-tests.cjs').runConnectionReviewRegressionTests(test);
  await require('./file-review-regression-tests.cjs').runFileReviewRegressionTests(test);
  const { runCaptureReviewRegressionTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'capture-review-regression-tests.mjs')).href);
  await runCaptureReviewRegressionTests(test);
  await require('./tool-review-regression-tests.cjs').runToolReviewRegressionTests(test);
  const { runStreamReviewRegressionTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'stream-review-regression-tests.mjs')).href);
  await runStreamReviewRegressionTests(test);
  const { runSipReviewRegressionTests } = await import(require('url').pathToFileURL(path.join(__dirname, 'sip-review-regression-tests.mjs')).href);
  await runSipReviewRegressionTests(test);
  await require('./ui-v020-review-regression-tests.cjs').runUiV020ReviewRegressionTests(test);
  await require('./security-core-tests.cjs').runSecurityCoreTests(test);
  await require('./security-windows-tests.cjs').runSecurityWindowsTests(test);
  await require('./security-network-tests.cjs').runSecurityNetworkTests(test);
  await require('./security-offline-tests.cjs').runSecurityOfflineTests(test);
  await require('./security-ui-tests.cjs').runSecurityUiTests(test);
  await require('./diagnostics-tests.cjs').runDiagnosticsTests(test);
  await require('./diagnostics-electron-tests.cjs').runDiagnosticsElectronTests(test);

  const failed = results.filter((r) => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
