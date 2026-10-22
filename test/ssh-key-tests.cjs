'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { Ber } = require('asn1');
const artifactRoot = process.versions.electron && process.env.KONX_TEST_ASAR || path.resolve(__dirname, '..');
if (process.versions.electron && process.env.KONX_TEST_ASAR) {
  assert.ok(path.isAbsolute(artifactRoot) && artifactRoot.endsWith('.asar'));
  assert.ok(require('original-fs').statSync(artifactRoot).isFile(), 'packaged ASAR must exist');
}
const { loadPrivateKey, LIMITS } = require(path.join(artifactRoot, 'src/main/ssh-key'));
const { supportsDsa } = require(path.join(artifactRoot, 'src/main/ssh-capabilities'));
const PASS = 'KonX synthetic key fixture passphrase';
const uint = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const string = value => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([uint(b.length), b]); };
const integer = value => { let b = Buffer.from(value); while (b[0] === 0) b = b.subarray(1); return string(b[0] & 128 ? Buffer.concat([Buffer.from([0]), b]) : b); };
function fixtureFields(key) {
  if (key.asymmetricKeyType === 'dsa') {
    const d = new Ber.Reader(key.export({ type: 'pkcs8', format: 'der' })); d.readSequence(); d.readInt(); d.readSequence(); d.readOID(); d.readSequence();
    const p = d.readString(Ber.Integer, true), q = d.readString(Ber.Integer, true), g = d.readString(Ber.Integer, true);
    const x = new Ber.Reader(d.readString(Ber.OctetString, true)).readString(Ber.Integer, true);
    const pub = new Ber.Reader(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })); pub.readSequence(); pub.readSequence(); pub.readOID(); pub.readSequence(); pub.readString(Ber.Integer, true); pub.readString(Ber.Integer, true); pub.readString(Ber.Integer, true);
    const y = new Ber.Reader(pub.readString(Ber.BitString, true).subarray(1)).readString(Ber.Integer, true);
    return { type: 'ssh-dss', pub: Buffer.concat([string('ssh-dss'), ...[p, q, g, y].map(integer)]), priv: integer(x) };
  }
  const j = key.export({ format: 'jwk' }), b = name => Buffer.from(j[name], 'base64url');
  if (j.kty === 'RSA') return { type: 'ssh-rsa', pub: Buffer.concat([string('ssh-rsa'), integer(b('e')), integer(b('n'))]), priv: Buffer.concat(['d', 'p', 'q', 'qi'].map(n => integer(b(n)))) };
  if (j.kty === 'OKP') return { type: 'ssh-ed25519', pub: Buffer.concat([string('ssh-ed25519'), string(b('x'))]), priv: string(b('d')) };
  const curve = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[j.crv], type = 'ecdsa-sha2-' + curve;
  return { type, pub: Buffer.concat([string(type), string(curve), string(Buffer.concat([Buffer.from([4]), b('x'), b('y')]))]), priv: integer(b('d')) };
}
function ppk(key, version, passphrase, options = {}) {
  const { type, pub } = fixtureFields(key); let { priv } = fixtureFields(key);
  const encryption = passphrase === undefined ? 'none' : 'aes256-cbc', comment = Buffer.from('Synthetic \xFF comment', 'latin1');
  const lines = [`PuTTY-User-Key-File-${version}: ${type}`, `Encryption: ${encryption}`, 'Comment: ' + comment.toString('latin1')];
  const addBlob = (name, bytes) => { const chunks = bytes.toString('base64').match(/.{1,64}/g); lines.push(`${name}-Lines: ${chunks.length}`, ...chunks); };
  addBlob('Public', pub);
  let aes, iv, macKey;
  if (version === 3 && passphrase !== undefined) {
    const memory = options.memory || 8192, passes = options.passes || 2, parallelism = options.parallelism || 1;
    const algorithm = options.algorithm || 'Argon2id', nonce = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const material = crypto.argon2Sync(algorithm.toLowerCase(), { memory, passes, parallelism, nonce, tagLength: 80, message: passphrase });
    [aes, iv, macKey] = [material.subarray(0, 32), material.subarray(32, 48), material.subarray(48)];
    lines.push('Key-Derivation: ' + algorithm, 'Argon2-Memory: ' + memory, 'Argon2-Passes: ' + passes, 'Argon2-Parallelism: ' + parallelism, 'Argon2-Salt: ' + nonce.toString('hex'));
  } else if (version === 2) {
    const phrase = passphrase || '';
    aes = Buffer.concat([0, 1].map(n => crypto.createHash('sha1').update(uint(n)).update(phrase).digest())).subarray(0, 32);
    iv = Buffer.alloc(16); macKey = crypto.createHash('sha1').update('putty-private-key-file-mac-key').update(phrase).digest();
  } else macKey = Buffer.alloc(0);
  if (passphrase !== undefined) priv = Buffer.concat([priv, Buffer.alloc((16 - priv.length % 16) % 16, 0x37)]);
  const mac = crypto.createHmac(version === 3 ? 'sha256' : 'sha1', macKey).update(Buffer.concat([string(type), string(encryption), string(comment), string(pub), string(priv)])).digest('hex');
  if (passphrase !== undefined) { const cipher = crypto.createCipheriv('aes-256-cbc', aes, iv); cipher.setAutoPadding(false); priv = Buffer.concat([cipher.update(priv), cipher.final()]); }
  addBlob('Private', priv); lines.push('Private-MAC: ' + mac);
  return Buffer.from(lines.join(options.eol || '\n') + '\n', 'latin1');
}
async function inDirectory(fn) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'konx-ssh-key-'));
  try { return await fn(directory); }
  finally { assert.equal(path.dirname(fs.realpathSync(directory)), parent); assert.ok(path.basename(directory).startsWith('konx-ssh-key-')); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
function write(directory, name, data) { const file = path.join(directory, name); fs.writeFileSync(file, data); return file; }
function verifyIdentity(parsed, native) {
  assert.equal(parsed.isPrivateKey(), true);
  const publicKey = native.type === 'public' ? native : crypto.createPublicKey(native);
  const expected = publicKey.export({ type: 'spki', format: 'der' });
  assert.deepEqual(crypto.createPublicKey(parsed.getPublicPEM()).export({ type: 'spki', format: 'der' }), expected);
  const message = Buffer.from('KonX independent native signature verification'), algorithm = publicKey.asymmetricKeyType === 'ed25519' ? null : 'sha256';
  const signature = crypto.sign(algorithm, message, parsed.getPrivatePEM());
  assert.equal(crypto.verify(algorithm, message, publicKey, signature), true);
}
async function authenticate(parsed, hostKey, legacyRsa = false) {
  const { Server, Client, utils } = require(path.join(artifactRoot, 'node_modules/ssh2'));
  const connections = new Set(); let signed = 0, signedAlgorithm;
  const server = new Server({ hostKeys: [hostKey] }, connection => {
    connections.add(connection); connection.on('close', () => connections.delete(connection)); connection.on('error', () => {});
    if (legacyRsa) {
      // Model an older server that predates EXT_INFO. ssh2's modern server
      // otherwise always advertises rsa-sha2 support, contrary to this fixture.
      const protocol = connection._protocol, complete = protocol._onHandshakeComplete;
      protocol._onHandshakeComplete = (...args) => { protocol._kex.remoteExtInfoEnabled = false; return complete(...args); };
    }
    connection.on('authentication', context => {
      if (context.method !== 'publickey' || !context.key.data.equals(parsed.getPublicSSH())) return context.reject(['publickey']);
      // ssh2 normalizes the public key blob's algorithm to ssh-rsa even when
      // the requested user-auth signature is rsa-sha2; hashAlgo distinguishes it.
      if (legacyRsa && (context.key.algo !== 'ssh-rsa' || context.hashAlgo !== undefined)) return context.reject(['publickey']);
      if (context.signature) {
        if (parsed.verify(context.blob, context.signature, context.hashAlgo) !== true) return context.reject(['publickey']);
        if (legacyRsa && !crypto.verify('sha1', context.blob, parsed.getPublicPEM(), context.signature)) return context.reject(['publickey']);
        signed++; signedAlgorithm = context.hashAlgo || (context.key.algo === 'ssh-rsa' ? 'sha1' : undefined);
      }
      context.accept();
    });
  });
  const client = new Client(); client.on('error', () => {});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const expectedHost = utils.parseKey(hostKey).getPublicSSH();
    await new Promise((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject);
      client.connect({ host: '127.0.0.1', port: server.address().port, username: 'synthetic-key-fixture',
        authHandler: [{ type: 'publickey', username: 'synthetic-key-fixture', key: parsed }],
        readyTimeout: 5000, hostVerifier: presented => presented.equals(expectedHost) });
    });
    assert.equal(signed, 1, 'real server must verify a signed authentication request');
    if (legacyRsa) assert.equal(signedAlgorithm, 'sha1', 'legacy server must verify SHA1 user authentication, separately from the host signature');
  } finally {
    client.destroy(); for (const connection of connections) connection.end();
    await new Promise(resolve => server.close(resolve));
  }
}
function excessivePkcs8(kdf) {
  const writer = new Ber.Writer(); writer.startSequence(); writer.startSequence();
  writer.writeOID('1.2.840.113549.1.5.13'); writer.startSequence(); writer.startSequence();
  writer.writeOID(kdf === 'scrypt' ? '1.3.6.1.4.1.11591.4.11' : '1.2.840.113549.1.5.12');
  writer.startSequence(); writer.writeBuffer(Buffer.alloc(16), Ber.OctetString);
  if (kdf === 'scrypt') { writer.writeInt(1048576); writer.writeInt(32); writer.writeInt(1); }
  else writer.writeInt(1000001);
  writer.endSequence(); writer.endSequence(); writer.startSequence(); writer.writeOID('2.16.840.1.101.3.4.1.42');
  writer.writeBuffer(Buffer.alloc(16), Ber.OctetString); writer.endSequence(); writer.endSequence(); writer.endSequence();
  writer.writeBuffer(Buffer.alloc(16), Ber.OctetString); writer.endSequence();
  return '-----BEGIN ENCRYPTED PRIVATE KEY-----\n' + writer.buffer.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END ENCRYPTED PRIVATE KEY-----\n';
}
const keyKinds = [
  ['rsa', { modulusLength: 1024 }, 'pkcs1'],
  ['rsa', { modulusLength: 2048 }, 'pkcs1'],
  ['ec', { namedCurve: 'prime256v1' }, 'sec1'],
  ['ec', { namedCurve: 'secp384r1' }, 'sec1'],
  ['ec', { namedCurve: 'secp521r1' }, 'sec1'],
  ['ed25519', {}, null],
  ['dsa', { modulusLength: 1024, divisorLength: 160 }, null],
];
async function runSshKeyTests(test) {
  const keys = keyKinds.map(([type, options]) => crypto.generateKeyPairSync(type, options).privateKey);
  await test('SSH keys: native PEM and PKCS8 identities survive plain/encrypted loading without changing files', () => inDirectory(async directory => {
    for (let i = 0; i < keys.length; i++) for (const encoding of [keyKinds[i][2], 'pkcs8'].filter(Boolean)) for (const encrypted of [false, true]) {
      const original = keys[i].export({ type: encoding, format: 'pem', ...(encrypted ? { cipher: 'aes-256-cbc', passphrase: PASS } : {}) });
      const file = write(directory, `${i}-${encoding}-${encrypted}.pem`, original);
      verifyIdentity(await loadPrivateKey(file, encrypted ? PASS : undefined), keys[i]);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
  }));
  for (let i = 0; i < keys.length; i++) await test(`SSH keys: PuTTY v2/v3 ${fixtureFields(keys[i]).type} verifies MAC and identity for plain/encrypted files`, () => inDirectory(async directory => {
    for (const version of [2, 3]) for (const encrypted of [false, true]) {
      const original = ppk(keys[i], version, encrypted ? PASS : undefined, { eol: i % 2 ? '\r\n' : '\n' });
      const file = write(directory, 'fixture.ppk', original);
      verifyIdentity(await loadPrivateKey(file, encrypted ? PASS : undefined), keys[i]);
      assert.deepEqual(fs.readFileSync(file), original);
      const tampered = Buffer.from(original); const at = tampered.indexOf(Buffer.from('Synthetic')); tampered[at] ^= 1;
      fs.writeFileSync(file, tampered);
      await assert.rejects(loadPrivateKey(file, encrypted ? PASS : undefined), { code: encrypted ? 'SSH_KEY_PASSPHRASE' : 'SSH_KEY_FORMAT' });
    }
  }));
  await test('SSH keys: PuTTY v3 Argon2 variants and parameter validation precede expensive derivation', () => inDirectory(async directory => {
    for (const algorithm of ['Argon2d', 'Argon2i', 'Argon2id']) verifyIdentity(await loadPrivateKey(write(directory, algorithm, ppk(keys[0], 3, PASS, { algorithm, parallelism: 3 })), PASS), keys[0]);
    const normal = ppk(keys[0], 3, PASS).toString('latin1');
    for (const [field, value] of [['Memory', '2147483647'], ['Passes', '2147483647'], ['Parallelism', '128']]) {
      const file = write(directory, field, Buffer.from(normal.replace(new RegExp('Argon2-' + field + ': \\d+'), 'Argon2-' + field + ': ' + value), 'latin1'));
      await assert.rejects(loadPrivateKey(file, PASS), { code: 'SSH_KEY_LIMIT' });
    }
  }));
  await test('SSH keys: PKCS8 PBKDF2 and scrypt costs are bounded before native decryption', () => inDirectory(async directory => {
    for (const kdf of ['pbkdf2', 'scrypt']) await assert.rejects(loadPrivateKey(write(directory, kdf, excessivePkcs8(kdf)), PASS), { code: 'SSH_KEY_LIMIT' });
  }));
  await test('SSH keys: native ssh-keygen OpenSSH RSA, ECDSA and Ed25519 encrypted files retain their identities', () => inDirectory(async directory => {
    for (const type of ['rsa', 'ecdsa', 'ed25519']) {
      const file = path.join(directory, type);
      cp.execFileSync('ssh-keygen', ['-q', '-t', type, ...(type === 'rsa' ? ['-b', '2048'] : []), '-N', PASS, '-f', file], { stdio: 'pipe', windowsHide: true });
      const before = fs.readFileSync(file), parsed = await loadPrivateKey(file, PASS);
      const publicLine = fs.readFileSync(file + '.pub', 'utf8').split(' ');
      assert.equal(parsed.type, publicLine[0]); assert.deepEqual(parsed.getPublicSSH(), Buffer.from(publicLine[1], 'base64'));
      assert.deepEqual(fs.readFileSync(file), before);
    }
  }));
  await test('SSH keys: incorrect saved passphrase can be corrected, prompts are bounded, and Cancel stops authentication', () => inDirectory(async directory => {
    const file = write(directory, 'encrypted.pem', keys[0].export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASS }));
    let prompts = 0;
    verifyIdentity(await loadPrivateKey(file, 'wrong', async payload => { prompts++; assert.equal(payload.fields[0].type, 'password'); assert.equal(payload.message.includes('wrong'), false); return { passphrase: PASS }; }), keys[0]);
    assert.equal(prompts, 1); prompts = 0;
    await assert.rejects(loadPrivateKey(file, undefined, async () => { prompts++; return { passphrase: 'wrong' }; }), { code: 'SSH_KEY_PASSPHRASE' }); assert.equal(prompts, 3);
    await assert.rejects(loadPrivateKey(file, undefined, async () => null), { code: 'SSH_KEY_CANCELLED' });
  }));
  await test('SSH keys: missing, public-only, corrupted, oversized and unsupported files produce explicit private-data-safe errors', () => inDirectory(async directory => {
    await assert.rejects(loadPrivateKey(path.join(directory, 'missing')), { code: 'SSH_KEY_READ' });
    await assert.rejects(loadPrivateKey(directory), { code: 'SSH_KEY_READ' });
    await assert.rejects(loadPrivateKey(write(directory, 'empty', '')), { code: 'SSH_KEY_LIMIT' });
    await assert.rejects(loadPrivateKey(write(directory, 'oversized', Buffer.alloc(LIMITS.fileBytes + 1))), { code: 'SSH_KEY_LIMIT' });
    await assert.rejects(loadPrivateKey(write(directory, 'public', crypto.createPublicKey(keys[0]).export({ type: 'spki', format: 'pem' }))), { code: 'SSH_KEY_FORMAT' });
    for (const text of ['broken-private-data-do-not-display', 'PuTTY-User-Key-File-3: private-data-do-not-display\n']) {
      await assert.rejects(loadPrivateKey(write(directory, 'malformed', text)), error => { assert.equal(error.code, 'SSH_KEY_FORMAT'); assert.equal(error.message.includes('private-data-do-not-display'), false); return true; });
    }
  }));
  await test('SSH keys: abort stops pending prompts and decoding and releases capacity for subsequent connections', () => inDirectory(async directory => {
    const file = write(directory, 'encrypted.ppk', ppk(keys[0], 3, PASS));
    const abort = new AbortController(); let entered, answer;
    const waiting = new Promise(resolve => { entered = resolve; });
    const load = loadPrivateKey(file, undefined, () => { entered(); return new Promise(resolve => { answer = resolve; }); }, abort.signal);
    await waiting; abort.abort(); await assert.rejects(load, { code: 'SSH_KEY_CANCELLED' }); answer({ passphrase: PASS });
    const workerAbort = new AbortController(), pending = loadPrivateKey(file, PASS, undefined, workerAbort.signal); workerAbort.abort();
    await assert.rejects(pending, { code: 'SSH_KEY_CANCELLED' });
    verifyIdentity(await loadPrivateKey(file, PASS), keys[0]);
  }));
  await test('SSH keys: active Argon2 workers stay bounded and cancellation releases their capacity', () => inDirectory(async directory => {
    const original = ppk(keys[0], 3, PASS);
    const slow = Buffer.from(original.toString('latin1').replace('Argon2-Memory: 8192', 'Argon2-Memory: 65536').replace('Argon2-Passes: 2', 'Argon2-Passes: 16'), 'latin1');
    const file = write(directory, 'slow.ppk', slow), abort = new AbortController();
    const pending = [0, 1].map(() => loadPrivateKey(file, PASS, undefined, abort.signal).then(() => null, error => error));
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      await assert.rejects(loadPrivateKey(file, PASS), { code: 'SSH_KEY_BUSY' });
    } finally { abort.abort(); }
    for (const error of await Promise.all(pending)) assert.equal(error?.code, 'SSH_KEY_CANCELLED');
    verifyIdentity(await loadPrivateKey(write(directory, 'normal.ppk', original), PASS), keys[0]);
  }));
  await test('SSH keys: actual Electron authenticates RSA1024/2048, ECDSA and Ed25519 from all formats and reports unavailable DSA crypto', () => inDirectory(async directory => {
    const entries = [];
    for (let i = 0; i < keys.length; i++) {
      const add = (name, data) => entries.push({ file: write(directory, `${i}-${name}`, data), dsa: keys[i].asymmetricKeyType === 'dsa', publicKey: crypto.createPublicKey(keys[i]).export({ type: 'spki', format: 'pem' }) });
      for (const type of [keyKinds[i][2], 'pkcs8'].filter(Boolean)) for (const encrypted of [false, true]) {
        add(`${type}-${encrypted}`, keys[i].export({ type, format: 'pem', ...(encrypted ? { cipher: 'aes-256-cbc', passphrase: PASS } : {}) }));
      }
      for (const version of [2, 3]) for (const encrypted of [false, true]) add(`ppk${version}-${encrypted}`, ppk(keys[i], version, encrypted ? PASS : undefined));
    }
    for (const algorithm of ['Argon2d', 'Argon2i', 'Argon2id']) entries.push({ file: write(directory, algorithm, ppk(keys[0], 3, PASS, { algorithm, parallelism: 3 })), publicKey: crypto.createPublicKey(keys[0]).export({ type: 'spki', format: 'pem' }) });
    for (const [type, bits] of [['rsa', '1024'], ['rsa', '2048'], ['ecdsa', '256'], ['ed25519', null]]) {
      const file = path.join(directory, `openssh-${type}-${bits || ''}`);
      cp.execFileSync('ssh-keygen', ['-q', '-t', type, ...(bits ? ['-b', bits] : []), '-N', PASS, '-f', file], { stdio: 'pipe', windowsHide: true });
      const parsed = await loadPrivateKey(file, PASS);
      const publicLine = fs.readFileSync(file + '.pub', 'utf8').split(' ');
      assert.deepEqual(parsed.getPublicSSH(), Buffer.from(publicLine[1], 'base64'));
      entries.push({ file, publicKey: parsed.getPublicPEM() });
    }
    const hostKey = keys[1].export({ type: 'pkcs1', format: 'pem' });
    const file = write(directory, 'manifest.json', JSON.stringify({ entries, hostKey }));
    const output = cp.execFileSync(process.env.KONX_TEST_EXECUTABLE || require('electron'), [__filename, '--electron-key-fixture', file], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120000 });
    assert.match(output, /ELECTRON_KEY_FORMATS_PASS/);
  }));
}
module.exports = { runSshKeyTests };
if (process.argv.includes('--electron-key-fixture')) (async () => {
  const { entries, hostKey } = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
  assert.equal(supportsDsa(), false, 'known packaged runtime limitation must remain explicit');
  for (const entry of entries) {
    if (entry.dsa) await assert.rejects(loadPrivateKey(entry.file, PASS), { code: 'SSH_KEY_UNSUPPORTED_RUNTIME' });
    else {
      const parsed = await loadPrivateKey(entry.file, PASS);
      verifyIdentity(parsed, crypto.createPublicKey(entry.publicKey));
      try { await authenticate(parsed, hostKey); } catch (error) { throw new Error(path.basename(entry.file) + ': ' + error.message); }
      if (path.basename(entry.file) === '0-pkcs1-false') await authenticate(parsed, hostKey, true);
    }
  }
  console.log('ELECTRON_KEY_FORMATS_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
else if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runSshKeyTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} SSH key tests passed`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
