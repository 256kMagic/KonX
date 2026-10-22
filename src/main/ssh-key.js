'use strict';
// Private-key loading is shared by terminal, SFTP and jump-host authentication.
// Conversion is in memory; the selected file is never rewritten. Expensive key
// derivation runs in a bounded worker, including ssh2's synchronous bcrypt path.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { utils } = require('ssh2');
const { supportsDsa } = require('./ssh-capabilities');

const LIMITS = Object.freeze({ fileBytes: 1024 * 1024, workers: 2, timeoutMs: 15000,
  argonMemoryKiB: 128 * 1024, argonPasses: 64, argonParallelism: 16,
  argonWorkKiB: 1024 * 1024, bcryptRounds: 1024, pbkdfIterations: 1000000 });
const TYPES = new Set(['ssh-rsa', 'ssh-dss', 'ssh-ed25519',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']);
const fail = (code, message) => Object.assign(new Error(message), { code: 'SSH_KEY_' + code });
const bad = () => fail('FORMAT', 'The private key is malformed or uses an unsupported format. Select an SSH-2 OpenSSH, PEM, PKCS#8, or PuTTY v2/v3 private key.');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const str = value => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([u32(b.length), b]); };
function mpint(value) {
  let b = Buffer.from(value);
  while (b.length && b[0] === 0) b = b.subarray(1);
  return str(b.length && (b[0] & 128) ? Buffer.concat([Buffer.from([0]), b]) : b);
}
function strings(buffer) {
  let offset = 0;
  return {
    string() {
      if (offset + 4 > buffer.length) throw bad();
      const length = buffer.readUInt32BE(offset); offset += 4;
      if (length > buffer.length - offset) throw bad();
      const value = buffer.subarray(offset, offset + length); offset += length; return value;
    },
    uint32() { if (offset + 4 > buffer.length) throw bad(); const n = buffer.readUInt32BE(offset); offset += 4; return n; },
    get remaining() { return buffer.length - offset; },
  };
}
function base64(value) {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw bad();
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw bad();
  return result;
}
function pem(label, bytes) {
  return `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
function openssh(type, publicFields, privateFields) {
  if (!TYPES.has(type)) throw fail('FORMAT', 'This SSH key algorithm is not supported. Use RSA, DSA, ECDSA NIST P-256/P-384/P-521, or Ed25519.');
  const pub = Buffer.concat([str(type), ...publicFields]);
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, str(type), ...privateFields, str('')]);
  const padding = Buffer.from(Array.from({ length: 8 - priv.length % 8 }, (_, i) => i + 1));
  priv = Buffer.concat([priv, padding]);
  return pem('OPENSSH PRIVATE KEY', Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(pub), str(priv)]));
}

// Minimal bounded DER fields for native-validated key conversion and preflight
// KDF cost checks. Native crypto remains responsible for validating key data.
function derReader(buffer) {
  let offset = 0;
  return {
    take(tag) {
      if (buffer[offset++] !== tag || offset >= buffer.length) throw bad();
      let length = buffer[offset++];
      if (length & 128) {
        const count = length & 127; length = 0;
        if (!count || count > 4 || offset + count > buffer.length) throw bad();
        for (let i = 0; i < count; i++) length = length * 256 + buffer[offset++];
      }
      if (length > buffer.length - offset) throw bad();
      const value = buffer.subarray(offset, offset + length); offset += length; return value;
    },
    get nextTag() { return buffer[offset]; },
  };
}
const DSA_OID = '2a8648ce380401';
function pemDer(text) {
  const match = /^-----BEGIN ([A-Z ]+)-----\s+([A-Za-z0-9+/=\s]+)\s+-----END \1-----$/.exec(text);
  if (!match) throw bad();
  return base64(match[2].replace(/\s/g, ''));
}
function positiveDerInt(value) {
  if (!value.length || value.length > 5 || value[0] & 128) throw bad();
  let result = 0;
  for (const byte of value) result = result * 256 + byte;
  if (!Number.isSafeInteger(result) || !result) throw bad();
  return result;
}
function inspectPkcs8(text, encrypted) {
  const root = derReader(derReader(pemDer(text)).take(0x30));
  if (!encrypted) {
    root.take(2);
    const oid = derReader(root.take(0x30)).take(6).toString('hex');
    if (oid === DSA_OID && !supportsDsa()) throw fail('UNSUPPORTED_RUNTIME', 'This KonX runtime cannot use DSA private keys. Use RSA, ECDSA, Ed25519, or a separate DSA-capable SSH client.');
    return;
  }
  // Native PKCS#8 decryption is synchronous even inside the worker. Bound its
  // advertised work before entering native crypto, where termination may wait.
  const algorithm = derReader(root.take(0x30));
  const oid = algorithm.take(6).toString('hex'), params = derReader(algorithm.take(0x30));
  if (oid === '2a864886f70d01050d') { // PBES2
    const kdf = derReader(params.take(0x30)), kdfOid = kdf.take(6).toString('hex');
    const options = derReader(kdf.take(0x30));
    if (kdfOid === '2a864886f70d01050c') { // PBKDF2
      if (options.take(4).length > 1024) throw bad();
      if (positiveDerInt(options.take(2)) > LIMITS.pbkdfIterations) throw fail('LIMIT', 'PKCS#8 key derivation exceeds 1,000,000 iterations. Re-export the key with standard parameters.');
    } else if (kdfOid === '2b06010401da47040b') { // scrypt
      if (options.take(4).length > 1024) throw bad();
      const n = positiveDerInt(options.take(2)), r = positiveDerInt(options.take(2)), p = positiveDerInt(options.take(2));
      if (n > 1048576 || r > 32 || p > 16 || n * r * 128 > 128 * 1024 * 1024 || n * r * p > 8388608) throw fail('LIMIT', 'PKCS#8 scrypt parameters exceed KonX memory or work limits. Re-export the key with standard parameters.');
    } else throw fail('FORMAT', 'The PKCS#8 key uses an unsupported derivation method. Re-export using PBKDF2 or scrypt.');
    if (options.nextTag === 2 && positiveDerInt(options.take(2)) > 64) throw fail('LIMIT', 'PKCS#8 requests an unusually large encryption key. Re-export using standard AES parameters.');
  } else if (/^2a864886f70d0105(?:01|03|04|06|0a|0b)$/.test(oid) || /^2a864886f70d010c010[1-6]$/.test(oid)) {
    if (params.take(4).length > 1024) throw bad();
    if (positiveDerInt(params.take(2)) > LIMITS.pbkdfIterations) throw fail('LIMIT', 'PKCS#8 key derivation exceeds 1,000,000 iterations. Re-export the key with standard parameters.');
  } else throw fail('FORMAT', 'The PKCS#8 encryption method is not supported. Re-export using PBES2 with AES.');
}
function nativeToOpenSsh(key) {
  const type = key.asymmetricKeyType;
  if (type === 'rsa') {
    const j = key.export({ format: 'jwk' }), b = name => Buffer.from(j[name], 'base64url');
    return openssh('ssh-rsa', [mpint(b('e')), mpint(b('n'))], ['n', 'e', 'd', 'qi', 'p', 'q'].map(name => mpint(b(name))));
  }
  if (type === 'ec') {
    const j = key.export({ format: 'jwk' });
    const curve = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[j.crv];
    if (!curve) throw fail('FORMAT', 'This elliptic curve is not supported by SSH. Use ECDSA NIST P-256, P-384, P-521, or Ed25519.');
    const q = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
    const pub = [str(curve), str(q)];
    return openssh('ecdsa-sha2-' + curve, pub, [...pub, mpint(Buffer.from(j.d, 'base64url'))]);
  }
  if (type === 'ed25519') {
    const j = key.export({ format: 'jwk' }), pub = Buffer.from(j.x, 'base64url'), seed = Buffer.from(j.d, 'base64url');
    return openssh('ssh-ed25519', [str(pub)], [str(pub), str(Buffer.concat([seed, pub]))]);
  }
  if (type === 'dsa') {
    const privateDer = derReader(derReader(key.export({ type: 'pkcs8', format: 'der' })).take(0x30));
    privateDer.take(2);
    const algorithm = derReader(privateDer.take(0x30)); algorithm.take(6);
    const parameters = derReader(algorithm.take(0x30));
    const pqg = [parameters.take(2), parameters.take(2), parameters.take(2)];
    const x = derReader(privateDer.take(4)).take(2);
    const publicDer = derReader(derReader(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })).take(0x30));
    publicDer.take(0x30);
    const bitString = publicDer.take(3); if (bitString[0] !== 0) throw bad();
    const y = derReader(bitString.subarray(1)).take(2);
    const pub = [...pqg, y].map(mpint);
    return openssh('ssh-dss', pub, [...pub, mpint(x)]);
  }
  throw fail('FORMAT', `The ${type || 'selected'} key algorithm is not supported by SSH-2 in KonX. Use RSA, DSA, ECDSA NIST, or Ed25519.`);
}

// PPK versions 2/3: https://www.puttyssh.org/0.85/htmldoc/AppendixC.html
function ppkEnvelope(data) {
  // PPK comments are arbitrary bytes: preserve them exactly for the MAC.
  const lines = data.toString('latin1').replace(/\r\n|\r/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  let line = 0;
  const header = /^PuTTY-User-Key-File-(2|3): (.+)$/.exec(lines[line++]);
  if (!header) throw fail('FORMAT', 'Unsupported PuTTY key version. Export the private key as OpenSSH using PuTTYgen.');
  const version = Number(header[1]), type = header[2];
  if (!TYPES.has(type)) throw fail('FORMAT', 'This PuTTY key type is not supported by KonX. Use RSA, DSA, ECDSA NIST, or Ed25519.');
  const field = name => {
    const text = lines[line++], prefix = name + ': ';
    if (typeof text !== 'string' || !text.startsWith(prefix)) throw bad();
    return text.slice(prefix.length);
  };
  const integer = name => { const v = field(name); if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw bad(); return Number(v); };
  const blob = name => {
    const count = integer(name);
    if (count > lines.length - line || count > LIMITS.fileBytes / 4) throw bad();
    const text = lines.slice(line, line + count).join(''); line += count;
    return base64(text);
  };
  const encryption = field('Encryption');
  if (!['none', 'aes256-cbc'].includes(encryption)) throw fail('FORMAT', 'The PuTTY key uses an unsupported encryption method. Export it as OpenSSH using PuTTYgen.');
  const comment = Buffer.from(field('Comment'), 'latin1'), pub = blob('Public-Lines');
  let argon;
  if (version === 3 && encryption !== 'none') {
    const algorithm = field('Key-Derivation');
    if (!['Argon2d', 'Argon2i', 'Argon2id'].includes(algorithm)) throw fail('FORMAT', 'Unsupported PuTTY key derivation method.');
    const memory = integer('Argon2-Memory'), passes = integer('Argon2-Passes'), parallelism = integer('Argon2-Parallelism');
    const salt = field('Argon2-Salt');
    if (!/^(?:[a-fA-F0-9]{2}){8,1024}$/.test(salt)) throw bad();
    if (memory < 8 * parallelism || memory > LIMITS.argonMemoryKiB || passes > LIMITS.argonPasses || parallelism > LIMITS.argonParallelism || memory * passes > LIMITS.argonWorkKiB) {
      throw fail('LIMIT', 'The PuTTY key exceeds KonX key-derivation limits (128 MiB memory, 64 passes, 16 lanes, and 1 GiB cumulative memory work). Re-export it with standard PuTTYgen parameters.');
    }
    argon = { algorithm: algorithm.toLowerCase(), memory, passes, parallelism, nonce: Buffer.from(salt, 'hex'), tagLength: 80 };
  }
  const priv = blob('Private-Lines'), macText = field('Private-MAC');
  const macLength = version === 3 ? 64 : 40;
  if (line !== lines.length || macText.length !== macLength || !/^[a-fA-F0-9]+$/.test(macText)) throw bad();
  if (encryption !== 'none' && priv.length % 16) throw bad();
  const reader = strings(pub);
  if (reader.string().toString('ascii') !== type) throw bad();
  return { version, type, encryption, comment, pub, priv, mac: Buffer.from(macText, 'hex'), argon };
}
async function decodePpk(envelope, passphrase) {
  const { version, type, encryption, comment, pub, argon } = envelope;
  const encrypted = encryption !== 'none';
  if (encrypted && passphrase === undefined) throw fail('PASSPHRASE', 'This private key needs a passphrase.');
  const password = Buffer.from(encrypted ? passphrase : '', 'utf8');
  let priv = envelope.priv, macKey;
  if (version === 2) {
    macKey = crypto.createHash('sha1').update('putty-private-key-file-mac-key').update(password).digest();
    if (encrypted) {
      const key = Buffer.concat([0, 1].map(n => crypto.createHash('sha1').update(u32(n)).update(password).digest())).subarray(0, 32);
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16)); decipher.setAutoPadding(false);
      priv = Buffer.concat([decipher.update(priv), decipher.final()]); key.fill(0);
    }
  } else if (encrypted) {
    // Electron exposes crypto.argon2 but BoringSSL cannot execute it. The same
    // portable implementation is used in both runtimes, inside this worker.
    const argon2 = await import('@noble/hashes/argon2.js');
    const material = argon2[argon.algorithm](password, argon.nonce, {
      m: argon.memory, t: argon.passes, p: argon.parallelism, dkLen: 80,
      version: 0x13, maxmem: LIMITS.argonMemoryKiB * 1024,
    });
    const decipher = crypto.createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48)); decipher.setAutoPadding(false);
    priv = Buffer.concat([decipher.update(priv), decipher.final()]); macKey = Buffer.from(material.subarray(48)); material.fill(0);
  } else macKey = Buffer.alloc(0);
  password.fill(0);
  const expected = crypto.createHmac(version === 3 ? 'sha256' : 'sha1', macKey)
    .update(Buffer.concat([str(type), str(encryption), str(comment), str(pub), str(priv)])).digest();
  macKey.fill(0);
  if (!crypto.timingSafeEqual(expected, envelope.mac)) {
    throw fail(encrypted ? 'PASSPHRASE' : 'FORMAT', encrypted ? 'Incorrect key passphrase or damaged PuTTY key (integrity check failed).' : 'PuTTY key integrity check failed. The file may be damaged or modified.');
  }
  const p = strings(pub), q = strings(priv); p.string();
  let publicFields, privateFields;
  if (type === 'ssh-rsa') {
    const e = p.string(), n = p.string(), d = q.string(), p1 = q.string(), q1 = q.string(), iqmp = q.string();
    publicFields = [str(e), str(n)]; privateFields = [n, e, d, iqmp, p1, q1].map(str);
  } else if (type === 'ssh-dss') {
    publicFields = Array.from({ length: 4 }, () => str(p.string())); privateFields = [...publicFields, str(q.string())];
  } else if (type === 'ssh-ed25519') {
    const publicKey = p.string(), seed = q.string();
    // PuTTY's eddsa_private_blob writes a fixed-width little-endian seed,
    // unlike RSA/DSA/ECDSA mpints. Preserve all 32 bytes, including zeroes.
    if (seed.length !== 32 || publicKey.length !== 32) throw bad();
    publicFields = [str(publicKey)]; privateFields = [str(publicKey), str(Buffer.concat([seed, publicKey]))];
  } else {
    const curve = p.string(), point = p.string();
    if ('ecdsa-sha2-' + curve.toString('ascii') !== type) throw bad();
    publicFields = [str(curve), str(point)]; privateFields = [...publicFields, str(q.string())];
  }
  if (p.remaining || (!encrypted && q.remaining) || (encrypted && q.remaining > 15)) throw bad();
  return openssh(type, publicFields, privateFields);
}
function inspectOpenSsh(text) {
  const match = /^-----BEGIN OPENSSH PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END OPENSSH PRIVATE KEY-----$/.exec(text);
  if (!match) throw bad();
  const bytes = base64(match[1].replace(/\s/g, ''));
  const magic = Buffer.from('openssh-key-v1\0');
  if (!bytes.subarray(0, magic.length).equals(magic)) throw bad();
  const r = strings(bytes.subarray(magic.length));
  const cipher = r.string().toString(), kdf = r.string().toString(), options = r.string();
  if (r.uint32() !== 1) throw fail('FORMAT', 'Select an OpenSSH file containing exactly one private key.');
  const pub = strings(r.string()), type = pub.string().toString();
  if (!TYPES.has(type)) throw fail('FORMAT', 'This OpenSSH key type is not supported. Hardware-backed FIDO, SSH certificates and SSH-1 keys require a compatible external SSH client.');
  r.string(); if (r.remaining) throw bad();
  if (cipher === 'none') { if (kdf !== 'none' || options.length) throw bad(); return false; }
  if (kdf !== 'bcrypt') throw fail('FORMAT', 'Unsupported OpenSSH key derivation method.');
  const k = strings(options), salt = k.string(), rounds = k.uint32();
  if (!rounds || rounds > LIMITS.bcryptRounds || salt.length > 1024 || k.remaining) throw fail('LIMIT', 'OpenSSH key derivation exceeds KonX limits. Re-export the key with standard ssh-keygen parameters.');
  return true;
}
function checkedKey(value) {
  if (value instanceof Error) throw value;
  const keys = Array.isArray(value) ? value : [value];
  if (keys.length !== 1 || !keys[0]?.isPrivateKey?.()) throw fail('FORMAT', 'Select a private key, not a public key or certificate file.');
  const key = keys[0], challenge = Buffer.from('KonX private-key validation');
  if (key.type === 'ssh-dss' && !supportsDsa()) throw fail('UNSUPPORTED_RUNTIME', 'This KonX runtime cannot sign with DSA keys. Use an RSA, ECDSA, or Ed25519 key, or a separate SSH client with DSA support for this device.');
  const fields = strings(key.getPublicSSH()); fields.string();
  if (key.type === 'ssh-rsa') {
    const exponent = fields.string(), modulus = fields.string();
    if (exponent.length > 9 || modulus.length > 2049) throw fail('LIMIT', 'RSA keys larger than 16384 bits or with unusually large exponents exceed KonX signing limits.');
  } else if (key.type === 'ssh-dss') {
    if (fields.string().length > 129 || fields.string().length > 21) throw fail('FORMAT', 'SSH DSA requires a 1024-bit key with a 160-bit subgroup.');
  }
  const signature = key.sign(challenge);
  if (signature instanceof Error || key.verify(challenge, signature) !== true) throw fail('FORMAT', 'The private and public parts of this key do not match, or its signing algorithm is unavailable.');
  return key;
}
async function decode(data, passphrase) {
  const text = data.toString('utf8').trim();
  if (data.subarray(0, 20).toString('ascii').startsWith('PuTTY-User-Key-File-')) {
    return checkedKey(utils.parseKey(await decodePpk(ppkEnvelope(data), passphrase))).getPrivatePEM();
  }
  if (text.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    const encrypted = inspectOpenSsh(text);
    if (encrypted && passphrase === undefined) throw fail('PASSPHRASE', 'This private key needs a passphrase.');
    const parsed = utils.parseKey(text, passphrase);
    if (parsed instanceof Error) throw fail(encrypted ? 'PASSPHRASE' : 'FORMAT', encrypted ? 'Incorrect key passphrase, unsupported encryption, or damaged OpenSSH key.' : 'The OpenSSH private key is malformed.');
    return checkedKey(parsed).getPrivatePEM();
  }
  if (/^(?:ssh-|ecdsa-|sk-|---- BEGIN SSH2 PUBLIC KEY|-----BEGIN (?:PUBLIC KEY|RSA PUBLIC KEY|CERTIFICATE))/.test(text)) {
    throw fail('FORMAT', 'Select the private key file, not its .pub public key or a certificate.');
  }
  if (!/^-----BEGIN (?:RSA |DSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(text)) throw bad();
  const encrypted = text.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----') || /^Proc-Type:\s*4,ENCRYPTED$/m.test(text.replace(/\r/g, ''));
  if (text.startsWith('-----BEGIN DSA PRIVATE KEY-----') && !supportsDsa()) throw fail('UNSUPPORTED_RUNTIME', 'This KonX runtime cannot use DSA private keys. Use RSA, ECDSA, Ed25519, or a separate DSA-capable SSH client.');
  if (/^-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(text)) inspectPkcs8(text, encrypted);
  if (encrypted && passphrase === undefined) throw fail('PASSPHRASE', 'This private key needs a passphrase.');
  let native;
  try { native = crypto.createPrivateKey({ key: text, passphrase }); }
  catch { throw fail(encrypted ? 'PASSPHRASE' : 'FORMAT', encrypted ? 'Incorrect key passphrase, unsupported encryption, or damaged PEM private key.' : 'The PEM private key is malformed or uses an unsupported algorithm.'); }
  return checkedKey(utils.parseKey(nativeToOpenSsh(native))).getPrivatePEM();
}

let activeWorkers = 0;
const cancelled = () => fail('CANCELLED', 'Private-key login cancelled.');
function checkCancelled(signal) { if (signal?.aborted) throw cancelled(); }
async function decodeInWorker(data, passphrase, signal) {
  checkCancelled(signal);
  if (activeWorkers >= LIMITS.workers) throw fail('BUSY', 'Two private keys are already being unlocked. Try this connection again after they finish.');
  activeWorkers++;
  let worker, timer, abort;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: { konxSshKey: true, data, passphrase }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
      abort = () => reject(cancelled()); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      timer = setTimeout(() => reject(fail('LIMIT', 'Unlocking this private key exceeded 15 seconds. Check its format and key-derivation settings.')), LIMITS.timeoutMs);
      worker.once('message', result => {
        if (result.error) reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
        else resolve(result.pem);
      });
      worker.once('error', () => reject(fail('FORMAT', 'The private-key decoder could not complete. Check the key format or update KonX.')));
      worker.once('exit', () => reject(fail('FORMAT', 'The private-key decoder stopped before completing.')));
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    try { if (worker) await worker.terminate(); }
    finally { activeWorkers--; }
  }
}
async function readKeyFile(keyPath, signal) {
  checkCancelled(signal);
  if (typeof keyPath !== 'string' || !keyPath) throw fail('READ', 'Choose a private key file on the Authentication page.');
  let handle;
  try {
    handle = await fs.open(keyPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail('READ', 'The selected private key path is not a file.');
    if (!stat.size || stat.size > LIMITS.fileBytes) throw fail('LIMIT', 'Private key files must be nonempty and no larger than 1 MiB.');
    const data = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < data.length) {
      checkCancelled(signal);
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset !== stat.size) throw fail('READ', 'The private key file changed while it was being read. Try again.');
    return data.subarray(0, offset);
  } catch (error) {
    if (error.code?.startsWith('SSH_KEY_')) throw error;
    throw fail('READ', `Could not read the selected private key file (${error.code || 'read failed'}). Check the path and file permissions.`);
  } finally { await handle?.close(); }
}
async function askPassphrase(ask, payload, signal) {
  checkCancelled(signal);
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(cancelled()); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      Promise.resolve().then(() => { checkCancelled(signal); return ask(payload); }).then(resolve, reject);
    });
  } finally { signal?.removeEventListener('abort', abort); }
}
async function loadPrivateKey(keyPath, passphrase, ask, signal) {
  if (passphrase !== undefined && passphrase !== null && typeof passphrase !== 'string') throw fail('FORMAT', 'The key passphrase must be text.');
  const data = await readKeyFile(keyPath, signal);
  let phrase = passphrase || undefined, prompts = 0;
  try {
    for (;;) {
      try {
        const decoded = await decodeInWorker(data, phrase, signal);
        checkCancelled(signal);
        // Ed25519's ssh2 representation is PKCS#8; convert it to OpenSSH once.
        const parsed = utils.parseKey(decoded);
        return checkedKey(parsed instanceof Error ? utils.parseKey(nativeToOpenSsh(crypto.createPrivateKey(decoded))) : parsed);
      } catch (error) {
        if (error.code !== 'SSH_KEY_PASSPHRASE' || typeof ask !== 'function' || prompts >= 3) throw error;
        const answer = await askPassphrase(ask, { kind: 'form', title: 'Key passphrase',
          message: `${phrase === undefined ? '' : 'The passphrase did not unlock the key. ' }Passphrase for ${keyPath}`,
          fields: [{ name: 'passphrase', label: 'Passphrase', type: 'password' }] }, signal);
        if (!answer || typeof answer.passphrase !== 'string') throw fail('CANCELLED', 'Private-key login cancelled.');
        phrase = answer.passphrase; prompts++;
      }
    }
  } finally { data.fill(0); }
}

if (!isMainThread && workerData?.konxSshKey === true) {
  const data = Buffer.from(workerData.data);
  decode(data, workerData.passphrase).then(pem => parentPort.postMessage({ pem }), error => parentPort.postMessage({ error: {
    code: error.code?.startsWith('SSH_KEY_') ? error.code : 'SSH_KEY_FORMAT',
    message: error.code?.startsWith('SSH_KEY_') ? error.message : 'The private key could not be decoded. Check its format and passphrase.',
  } })).finally(() => data.fill(0));
}

module.exports = { loadPrivateKey, LIMITS };
