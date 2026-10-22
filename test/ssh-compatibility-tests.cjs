'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { Ber } = require('asn1');
const { Server, utils } = require('ssh2');
const { SUPPORTED_CIPHER } = require('ssh2/lib/protocol/constants');
const sourceRoot = path.resolve(__dirname, '..');
const artifactRoot = process.env.KONX_TEST_ASAR || sourceRoot;
if (process.env.KONX_TEST_ASAR) {
  assert.ok(path.isAbsolute(artifactRoot) && artifactRoot.endsWith('.asar'));
  assert.ok(require('original-fs').statSync(artifactRoot).isFile(), 'packaged ASAR must exist');
}
const ssh = require(path.join(artifactRoot, 'src/main/ssh'));
const { sshAlgorithms } = require(path.join(artifactRoot, 'src/main/ssh-policy'));
const { supportsDsa } = require(path.join(artifactRoot, 'src/main/ssh-capabilities'));
const { scanSsh } = require(path.join(artifactRoot, 'src/main/security/network'));
const { SftpManager } = require(path.join(artifactRoot, 'src/main/sftp'));
const { sshHostKey } = require('./lib/ssh-host-key.cjs');

const USER = 'konx-compatibility-fixture';
const PASSWORD = 'synthetic-loopback-password';
const LEGACY = { kex: ['diffie-hellman-group1-sha1'], serverHostKey: ['ssh-rsa'], cipher: ['3des-cbc'], hmac: ['hmac-sha1'] };
const MODERN = { kex: ['ecdh-sha2-nistp256'], serverHostKey: ['rsa-sha2-512'], cipher: ['aes128-ctr'], hmac: ['hmac-sha2-256'] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error(message); await pause(10); }
}

// Generate a disposable identity with native crypto. PKCS8 carries p/q/g/x,
// SPKI carries p/q/g/y; traditional DSA PEM carries version,p,q,g,y,x.
// This fixture conversion never reads a user's private key or shells out.
let dsaKey;
function legacyDsaKey() {
  if (dsaKey) return dsaKey;
  const pair = crypto.generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 });
  const privateReader = new Ber.Reader(pair.privateKey.export({ type: 'pkcs8', format: 'der' }));
  privateReader.readSequence(); assert.equal(privateReader.readInt(), 0);
  privateReader.readSequence(); assert.equal(privateReader.readOID(), '1.2.840.10040.4.1');
  privateReader.readSequence();
  const parameters = [0, 1, 2].map(() => privateReader.readString(Ber.Integer, true));
  const x = new Ber.Reader(privateReader.readString(Ber.OctetString, true)).readString(Ber.Integer, true);
  const publicReader = new Ber.Reader(pair.publicKey.export({ type: 'spki', format: 'der' }));
  publicReader.readSequence(); publicReader.readSequence(); assert.equal(publicReader.readOID(), '1.2.840.10040.4.1');
  publicReader.readSequence();
  for (const parameter of parameters) assert.deepEqual(publicReader.readString(Ber.Integer, true), parameter);
  const publicBits = publicReader.readString(Ber.BitString, true); assert.equal(publicBits[0], 0);
  const y = new Ber.Reader(publicBits.subarray(1)).readString(Ber.Integer, true);
  const writer = new Ber.Writer(); writer.startSequence(); writer.writeInt(0);
  for (const value of [...parameters, y, x]) writer.writeBuffer(value, Ber.Integer);
  writer.endSequence();
  dsaKey = '-----BEGIN DSA PRIVATE KEY-----\n' + writer.buffer.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END DSA PRIVATE KEY-----\n';
  const parsed = utils.parseKey(dsaKey); assert.ok(!(parsed instanceof Error));
  assert.equal(parsed.type, 'ssh-dss');
  const challenge = Buffer.from('KonX owned DSA host identity');
  assert.equal(parsed.verify(challenge, crypto.sign('sha1', challenge, pair.privateKey)), true);
  return dsaKey;
}

function modernEd25519Key() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const jwk = pair.privateKey.export({ format: 'jwk' });
  const publicBytes = Buffer.from(jwk.x, 'base64url'), privateBytes = Buffer.from(jwk.d, 'base64url');
  assert.equal(publicBytes.length, 32); assert.equal(privateBytes.length, 32);
  const integer = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
  const string = value => { const buffer = Buffer.from(value); return Buffer.concat([integer(buffer.length), buffer]); };
  const publicKey = Buffer.concat([string('ssh-ed25519'), string(publicBytes)]);
  let privateKey = Buffer.concat([integer(0x31415926), integer(0x31415926), publicKey,
    string(Buffer.concat([privateBytes, publicBytes])), string('KonX synthetic host fixture')]);
  const padding = Buffer.from(Array.from({ length: 8 - privateKey.length % 8 }, (_, i) => i + 1));
  privateKey = Buffer.concat([privateKey, padding]);
  const encoded = Buffer.concat([Buffer.from('openssh-key-v1\0'), string('none'), string('none'), string(''), integer(1), string(publicKey), string(privateKey)]);
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + encoded.toString('base64').match(/.{1,70}/g).join('\n') + '\n-----END OPENSSH PRIVATE KEY-----\n';
  const parsed = utils.parseKey(pem); assert.ok(!(parsed instanceof Error));
  const challenge = Buffer.from('KonX fixed-width Ed25519 host identity');
  assert.equal(parsed.verify(challenge, crypto.sign(null, challenge, pair.privateKey)), true);
  return pem;
}

async function peer({ algorithms = MODERN, hostKey = sshHostKey(), forwardTo = null } = {}) {
  const clients = new Set(), forwarded = new Set();
  const observed = { authentications: 0, ready: 0, sftp: 0, forwards: 0, negotiations: [] };
  const server = new Server({ hostKeys: [hostKey], algorithms }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {}); // Expected for rejected transport/trust tests.
    client.on('handshake', negotiated => observed.negotiations.push(negotiated));
    client.on('authentication', context => {
      observed.authentications++;
      if (context.method === 'password' && context.username === USER && context.password === PASSWORD) context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () => {
      observed.ready++;
      client.on('tcpip', (accept, reject, details) => {
        if (!forwardTo || details.destIP !== '127.0.0.1' || details.destPort !== forwardTo.port) return reject();
        observed.forwards++;
        const socket = net.connect(forwardTo.port, '127.0.0.1');
        forwarded.add(socket); socket.on('close', () => forwarded.delete(socket));
        socket.once('error', () => { socket.destroy(); reject(); });
        socket.once('connect', () => {
          const channel = accept(); socket.pipe(channel).pipe(socket);
          channel.on('error', () => socket.destroy()); channel.on('close', () => socket.destroy());
          socket.on('error', () => channel.destroy());
        });
      });
      client.on('session', accept => {
        const session = accept();
        session.on('sftp', acceptSftp => {
          observed.sftp++;
          const stream = acceptSftp(); let listed = false;
          stream.on('REALPATH', id => stream.name(id, [{ filename: '/fixture', longname: '/fixture', attrs: {} }]));
          stream.on('OPENDIR', id => stream.handle(id, Buffer.from('owned-directory')));
          stream.on('READDIR', id => {
            if (listed) return stream.status(id, utils.sftp.STATUS_CODE.EOF);
            listed = true;
            stream.name(id, [{ filename: 'legacy-readable.txt', longname: '-rw-r--r-- 1 fixture fixture 7 Jan 1 00:00 legacy-readable.txt', attrs: { mode: 0o100644, size: 7, mtime: 1 } }]);
          });
          stream.on('CLOSE', id => stream.status(id, utils.sftp.STATUS_CODE.OK));
          stream.on('error', () => {});
        });
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return {
    port, clients, observed,
    session: { host: '127.0.0.1', port, protocol: 'ssh', username: USER, password: PASSWORD, auth: 'password', connectTimeout: 4 },
    close: async () => {
      for (const socket of forwarded) socket.destroy();
      for (const client of clients) client.end();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function hooks({ known = null, answer = 'once' } = {}) {
  const prompts = [], saved = [], logs = [];
  return {
    prompts, saved, logs,
    knownHost: () => known,
    saveHost: (...args) => saved.push(args),
    ask: async payload => { prompts.push(payload); assert.equal(payload.kind, 'hostkey', 'no unexpected credential prompt'); return answer; },
    log: value => logs.push(value),
  };
}

async function withPeer(options, run) {
  const fixture = await peer(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

async function login(fixture, session = {}, prompts = hooks()) {
  const result = await ssh.connect({ ...fixture.session, ...session }, prompts);
  result.client.on('error', () => {});
  try { return result.info; } finally { result.client.end(); }
}

function knownFixtureHost() {
  return { keyType: 'ssh-rsa', fingerprint: ssh.fingerprintOf(utils.parseKey(sshHostKey()).getPublicSSH()) };
}

function rotatePeerHostKey(fixture) {
  const client = [...fixture.clients][0];
  const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const key = utils.parseKey(pem); assert.ok(!(key instanceof Error));
  // ssh2 has no public API for live server identity rotation. Change only the
  // owned test peer's key; the real KEX, native signatures, and client host
  // verification remain untouched. The fixture negotiates this exact type.
  assert.equal(client._protocol._hostKeys[MODERN.serverHostKey[0]].type, 'ssh-rsa');
  client._protocol._hostKeys[MODERN.serverHostKey[0]] = key;
  return { client, fingerprint: ssh.fingerprintOf(key.getPublicSSH()) };
}

async function runSshCompatibilityTests(test) {
  await test('SSH compatibility: the dependency patch accepts only the reviewed version and exact source hash', () => {
    const { verifySsh2Patch, patchSsh2, PATCHED_SHA256 } = require('../scripts/patch-ssh2.cjs');
    const source = fs.readFileSync(require.resolve('ssh2/lib/protocol/kex'));
    assert.equal(verifySsh2Patch(source, '1.17.0').sha256, PATCHED_SHA256);
    assert.equal(patchSsh2({ check: true }).patched, true);
    assert.throws(() => verifySsh2Patch(source, '1.18.0'), /Unsupported ssh2 version/);
    assert.throws(() => verifySsh2Patch(Buffer.concat([source, Buffer.from('\n')]), '1.17.0'), /missing or differs/);
  });

  await test('SSH compatibility: automatic mode prefers modern algorithms even when server advertises legacy first', async () => withPeer({ algorithms: {
    kex: ['diffie-hellman-group1-sha1', ...MODERN.kex], serverHostKey: ['ssh-rsa', ...MODERN.serverHostKey],
    cipher: ['3des-cbc', ...MODERN.cipher], hmac: ['hmac-md5', 'hmac-sha1', ...MODERN.hmac],
  } }, async fixture => {
    const result = await login(fixture);
    assert.equal(result.algorithms.kex, MODERN.kex[0]); assert.equal(result.algorithms.serverHostKey, MODERN.serverHostKey[0]);
    for (const direction of ['cs', 'sc']) { assert.equal(result.algorithms[direction].cipher, MODERN.cipher[0]); assert.equal(result.algorithms[direction].mac, MODERN.hmac[0]); }
  }));

  const cases = [
    ['RSA/SHA1 host signature', { serverHostKey: ['ssh-rsa'] }, result => result.serverHostKey === 'ssh-rsa'],
    ['group14/SHA1 exchange', { kex: ['diffie-hellman-group14-sha1'] }, result => result.kex === 'diffie-hellman-group14-sha1'],
    ['group1/SHA1 exchange', { kex: ['diffie-hellman-group1-sha1'] }, result => result.kex === 'diffie-hellman-group1-sha1'],
    ['AES-CBC encryption', { cipher: ['aes128-cbc'] }, result => result.cs.cipher === 'aes128-cbc' && result.sc.cipher === 'aes128-cbc'],
    ['3DES-CBC encryption', { cipher: ['3des-cbc'] }, result => result.cs.cipher === '3des-cbc' && result.sc.cipher === '3des-cbc'],
    ['HMAC-SHA1 authentication', { hmac: ['hmac-sha1'] }, result => result.cs.mac === 'hmac-sha1' && result.sc.mac === 'hmac-sha1'],
    ['HMAC-MD5 authentication', { hmac: ['hmac-md5'] }, result => result.cs.mac === 'hmac-md5' && result.sc.mac === 'hmac-md5'],
    ['HMAC-SHA1-96 authentication', { hmac: ['hmac-sha1-96'] }, result => result.cs.mac === 'hmac-sha1-96' && result.sc.mac === 'hmac-sha1-96'],
  ];
  if (supportsDsa()) cases.push(['DSA host signature', { serverHostKey: ['ssh-dss'] }, result => result.serverHostKey === 'ssh-dss', legacyDsaKey]);
  else await test('SSH compatibility: a runtime without native DSA omits ssh-dss from automatic and modern transport', () => {
    for (const mode of ['auto', 'modern']) assert.equal(sshAlgorithms(mode).serverHostKey.includes('ssh-dss'), false);
  });
  for (const cipher of ['blowfish-cbc', 'arcfour', 'arcfour128', 'arcfour256', 'cast128-cbc']) {
    if (SUPPORTED_CIPHER.includes(cipher)) cases.push([cipher + ' encryption in this runtime', { cipher: [cipher] }, result => result.cs.cipher === cipher && result.sc.cipher === cipher]);
    else assert.equal(sshAlgorithms().cipher.includes(cipher), false, 'unsupported runtime cipher must not be advertised: ' + cipher);
  }
  for (const [label, algorithms, check, key] of cases) await test('SSH compatibility: automatic mode authenticates a real peer requiring ' + label, async () => withPeer({ algorithms: { ...MODERN, ...algorithms }, ...(key ? { hostKey: key() } : {}) }, async fixture => {
    const prompts = hooks();
    const result = await login(fixture, { sshCompatibility: 'auto' }, prompts);
    assert.ok(check(result.algorithms)); assert.equal(fixture.observed.ready, 1);
    assert.equal(prompts.prompts.length, 1); assert.match(prompts.prompts[0].fingerprint, /^SHA256:/);
    assert.equal(prompts.saved.length, 0, 'accept once must not save host identity');
  }));

  for (const [type, makeKey] of [
    ['ssh-ed25519', modernEd25519Key],
    ...[['ecdsa-sha2-nistp256', 'prime256v1'], ['ecdsa-sha2-nistp384', 'secp384r1'], ['ecdsa-sha2-nistp521', 'secp521r1']]
      .map(([type, namedCurve]) => [type, () => crypto.generateKeyPairSync('ec', { namedCurve, privateKeyEncoding: { type: 'sec1', format: 'pem' } }).privateKey]),
  ]) await test('SSH compatibility: modern transport authenticates a peer with ' + type + ' host identity', async () => withPeer({ hostKey: makeKey(), algorithms: { ...MODERN, serverHostKey: [type] } }, async fixture => {
    const result = await login(fixture, { sshCompatibility: 'modern' });
    assert.equal(result.algorithms.serverHostKey, type); assert.equal(result.hostKey.keyType, type);
  }));

  await test('SSH compatibility: automatic mode authenticates a legacy peer with a 1024-bit RSA host key', async () => {
    const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
    await withPeer({ hostKey, algorithms: LEGACY }, async fixture => {
      const result = await login(fixture);
      assert.equal(result.algorithms.serverHostKey, 'ssh-rsa'); assert.equal(result.algorithms.kex, LEGACY.kex[0]);
      assert.equal(result.hostKey.fingerprint, ssh.fingerprintOf(utils.parseKey(hostKey).getPublicSSH()));
    });
  });

  await test('SSH compatibility: modern transport mode works with modern peers and rejects legacy before authentication', async () => {
    await withPeer({}, async fixture => { const result = await login(fixture, { sshCompatibility: 'modern' }); assert.equal(result.algorithms.kex, MODERN.kex[0]); });
    for (const algorithms of [{ kex: LEGACY.kex }, { serverHostKey: LEGACY.serverHostKey }, { cipher: LEGACY.cipher }, { hmac: LEGACY.hmac }, { hmac: ['hmac-md5'] }]) await withPeer({ algorithms: { ...MODERN, ...algorithms } }, async fixture => {
      const prompts = hooks();
      await assert.rejects(ssh.connect({ ...fixture.session, sshCompatibility: 'modern' }, prompts), /no matching|modern transport/i);
      assert.equal(fixture.observed.authentications, 0); assert.equal(prompts.prompts.length, 0);
    });
  });

  await test('SSH compatibility: legacy negotiation never bypasses unknown or changed host-key rejection', async () => withPeer({ algorithms: LEGACY }, async fixture => {
    for (const known of [null, { keyType: 'ssh-rsa', fingerprint: 'SHA256:deliberately-not-the-peer' }]) {
      const prompts = hooks({ known, answer: null });
      await assert.rejects(ssh.connect(fixture.session, prompts), /verification|denied|closed/i);
      assert.equal(prompts.prompts.length, 1); assert.equal(prompts.prompts[0].changed, !!known);
      assert.deepEqual(prompts.prompts[0].previous, known); assert.equal(prompts.saved.length, 0);
    }
    assert.equal(fixture.observed.authentications, 0);
    const expected = { keyType: 'ssh-rsa', fingerprint: ssh.fingerprintOf(utils.parseKey(sshHostKey()).getPublicSSH()) };
    const prompts = hooks({ known: expected }); await login(fixture, {}, prompts);
    assert.equal(prompts.prompts.length, 0, 'matching known identity remains trusted');
  }));

  await test('SSH compatibility: an authenticated connection survives same-key rekey and still opens SFTP', async () => withPeer({}, async fixture => {
    const prompts = hooks({ known: knownFixtureHost() });
    const { client } = await ssh.connect(fixture.session, prompts);
    const errors = []; let closed = false, handshakes = 0, sftp;
    client.on('error', error => errors.push(error.message));
    client.once('close', () => { closed = true; });
    client.on('handshake', () => handshakes++);
    try {
      [...fixture.clients][0].rekey();
      await until(() => handshakes > 0 || closed, 'same-key rekey did not finish');
      assert.equal(closed, false, errors.join('; ')); assert.deepEqual(errors, []);
      assert.equal(handshakes, 1); assert.equal(prompts.prompts.length, 0);
      sftp = await new Promise((resolve, reject) => client.sftp((error, channel) => error ? reject(error) : resolve(channel)));
      sftp.on('error', () => {});
      const resolved = await new Promise((resolve, reject) => sftp.realpath('.', (error, value) => error ? reject(error) : resolve(value)));
      assert.equal(resolved, '/fixture'); assert.equal(fixture.observed.ready, 1);
    } finally { sftp?.end(); client.destroy(); }
  }));

  await test('SSH compatibility: a changed host key during rekey requires a decision and rejection closes the connection', async () => withPeer({}, async fixture => {
    const known = knownFixtureHost(), prompts = hooks({ known, answer: null });
    const { client } = await ssh.connect(fixture.session, prompts);
    const errors = []; let closed = false;
    client.on('error', error => errors.push(error.message));
    client.once('close', () => { closed = true; });
    try {
      const changed = rotatePeerHostKey(fixture); changed.client.rekey();
      await until(() => closed, 'rejected rekey did not close its connection');
      assert.equal(prompts.prompts.length, 1); assert.equal(prompts.prompts[0].changed, true);
      assert.deepEqual(prompts.prompts[0].previous, known);
      assert.equal(prompts.prompts[0].fingerprint, changed.fingerprint);
      assert.equal(prompts.saved.length, 0); assert.match(errors.join('; '), /verification failed/);
      assert.equal(fixture.observed.ready, 1, 'rekey must not reauthenticate');
    } finally { client.destroy(); }
  }));

  await test('SSH compatibility: a late rekey trust answer after transport closure cannot save the changed identity', async () => withPeer({}, async fixture => {
    const known = knownFixtureHost(), prompts = hooks({ known });
    let answer, closed = false, handshakes = 0;
    prompts.ask = payload => { prompts.prompts.push(payload); return new Promise(resolve => { answer = resolve; }); };
    const { client } = await ssh.connect(fixture.session, prompts);
    client.on('error', () => {}); client.once('close', () => { closed = true; });
    client.on('handshake', () => handshakes++);
    try {
      const changed = rotatePeerHostKey(fixture); changed.client.rekey();
      await until(() => typeof answer === 'function', 'changed rekey identity was not presented');
      assert.equal(prompts.prompts[0].fingerprint, changed.fingerprint);
      assert.equal(prompts.prompts[0].changed, true); assert.deepEqual(prompts.prompts[0].previous, known);
      client.destroy();
      await until(() => closed && fixture.clients.size === 0, 'closed rekey retained its transport');
      answer('save'); await pause(35);
      assert.equal(prompts.saved.length, 0); assert.equal(handshakes, 0);
      assert.equal(fixture.observed.ready, 1); assert.equal(fixture.clients.size, 0);
    } finally { client.destroy(); answer?.(null); }
  }));

  await test('SSH compatibility: each jump-chain hop uses its own transport setting and cleans up after target rejection', async () => withPeer({ algorithms: LEGACY }, async target => withPeer({ forwardTo: target }, async jump => {
    const prompts = hooks();
    const jumpSession = { ...jump.session, sshCompatibility: 'modern' };
    const result = await ssh.connectChain({ ...target.session, jumpId: 'owned-jump', sshCompatibility: 'auto' }, prompts, id => { assert.equal(id, 'owned-jump'); return jumpSession; });
    result.client.on('error', () => {});
    assert.equal(result.info.algorithms.kex, LEGACY.kex[0]); assert.equal(result.info.via.algorithms.kex, MODERN.kex[0]);
    assert.deepEqual(prompts.prompts.map(p => p.port), [jump.port, target.port]); result.client.end();
    await until(() => jump.clients.size === 0 && target.clients.size === 0, 'completed jump connection was not released');
    const rejectTarget = hooks(); rejectTarget.ask = async prompt => { rejectTarget.prompts.push(prompt); return prompt.port === jump.port ? 'once' : null; };
    await assert.rejects(ssh.connectChain({ ...target.session, jumpId: 'owned-jump' }, rejectTarget, () => jumpSession), /verification|denied|closed/i);
    await until(() => jump.clients.size === 0 && target.clients.size === 0, 'rejected target retained an owned jump connection');
    assert.equal(jump.observed.forwards, 2);
  })));

  await test('SSH compatibility: standalone SFTP uses legacy negotiation and retrieves a real directory listing', async () => withPeer({ algorithms: LEGACY }, async fixture => {
    const prompts = hooks();
    const manager = new SftpManager({ emit: () => {}, ask: prompts.ask,
      store: { hostKeyFor: prompts.knownHost, saveHostKey: prompts.saveHost, getSessionSecret: () => null },
      connections: { resolveSession: session => ({ ...session }), sshClient: () => null },
    });
    try {
      const opened = await manager.open('owned-legacy-sftp', { ...fixture.session, sshCompatibility: 'auto' });
      assert.equal(opened.home, '/fixture');
      const listed = await manager.list('owned-legacy-sftp', '/fixture');
      assert.equal(listed[0].name, 'legacy-readable.txt'); assert.equal(listed[0].size, 7);
      assert.equal(fixture.observed.sftp, 1); assert.equal(prompts.prompts[0].kind, 'hostkey');
      assert.equal(fixture.observed.negotiations[0].kex, LEGACY.kex[0]);
    } finally { manager.closeAll(); }
    await until(() => fixture.clients.size === 0, 'SFTP did not release its owned SSH connection');
  }));

  await test('SSH compatibility: security audit reports legacy transport and RSA/SHA1 host signatures without authentication', async () => {
    for (const algorithms of [LEGACY, { ...MODERN, serverHostKey: ['ssh-rsa'] }]) await withPeer({ algorithms }, async fixture => {
      const report = await scanSsh({ host: '127.0.0.1', port: fixture.port });
      const negotiated = report.checks.find(item => item.id === 'ssh-algorithms');
      assert.ok(negotiated, JSON.stringify(report)); assert.equal(negotiated.status, 'warning');
      assert.match(negotiated.evidence, /host signature: ssh-rsa/);
      assert.match(negotiated.evidence, /Legacy selections:.*ssh-rsa/);
      assert.match(report.checks.find(item => item.id === 'ssh-hostkey').evidence, /not been authenticated/);
      await until(() => fixture.clients.size === 0, 'audit did not close its pre-authentication connection');
      assert.equal(fixture.observed.authentications, 0); assert.equal(fixture.observed.sftp, 0); assert.equal(fixture.observed.forwards, 0);
    });
  });
}

module.exports = { runSshCompatibilityTests };
if (require.main === module) {
  let failed = 0, passed = 0;
  runSshCompatibilityTests(async (name, fn) => {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }).then(() => { console.log(`${passed}/${passed + failed} SSH compatibility tests passed`); process.exitCode = failed ? 1 : 0; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
