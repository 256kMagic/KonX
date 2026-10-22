'use strict';

// ssh2 1.17.0 assumes every crypto provider exposes named modp2. Electron's
// BoringSSL omits that name but supports native DH with the standard parameters.
// Patch only that missing-name case, preserving native key generation, shared
// secret arithmetic, SSH signatures, and host identity verification.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SSH2_VERSION = '1.17.0';
const ORIGINAL_SHA256 = '054ba4b81801596350f0e2e939746d2966297cffd4303b342c25b2fd5d295755';
const PATCHED_SHA256 = '5ba284da91bb2d98037fa2e334a4a8fdf3b791dd261f2ec14a63a57580c41cad';
const TARGET = '        this._dh = createDiffieHellmanGroup(this.groupName);';
const REPLACEMENT = `        try {
          this._dh = createDiffieHellmanGroup(this.groupName);
        } catch (error) {
          // KonX: BoringSSL omits named modp2; retain native DH with the exact
          // RFC 2409 section 6.2 prime and generator for SSH group1.
          // https://datatracker.ietf.org/doc/html/rfc2409#section-6.2
          if (this.groupName !== 'modp2'
              || error.code !== 'ERR_CRYPTO_UNKNOWN_DH_GROUP') throw error;
          this._dh = createDiffieHellman(Buffer.from(
            'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA6'
            + '3B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245'
            + 'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F2411'
            + '7C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF', 'hex'), 2);
        }`;
const digest = source => crypto.createHash('sha256').update(source).digest('hex');

/** Verify extracted packaged bytes, or the installed dependency, without writes. */
function verifySsh2Patch(source, version) {
  if (version !== SSH2_VERSION) throw new Error(`Unsupported ssh2 version ${version}; review the KonX compatibility patch before upgrading.`);
  const sha256 = digest(source);
  if (sha256 !== PATCHED_SHA256) throw new Error(`ssh2 compatibility patch is missing or differs: ${sha256}`);
  return { version, sha256, patched: true };
}

function patchSsh2({ check = false, directory } = {}) {
  const root = directory || path.dirname(require.resolve('ssh2/package.json', { paths: [path.join(__dirname, '..')] }));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'ssh2' || metadata.version !== SSH2_VERSION) throw new Error('The KonX SSH compatibility patch requires exactly ssh2 ' + SSH2_VERSION + '.');
  const filename = path.join(root, 'lib/protocol/kex.js');
  const original = fs.readFileSync(filename);
  if (check || digest(original) === PATCHED_SHA256) return verifySsh2Patch(original, metadata.version);
  if (digest(original) !== ORIGINAL_SHA256) throw new Error('Refusing to patch unknown ssh2 source; restore the locked dependency and review any upstream changes.');
  const text = original.toString('utf8');
  if (text.split(TARGET).length !== 2) throw new Error('Expected one ssh2 DHExchange patch location.');
  const updated = Buffer.from(text.replace(TARGET, REPLACEMENT));
  const result = verifySsh2Patch(updated, metadata.version);
  const temporary = filename + '.konx-' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, updated, { flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  verifySsh2Patch(fs.readFileSync(filename), metadata.version);
  return result;
}

module.exports = { patchSsh2, verifySsh2Patch, SSH2_VERSION, ORIGINAL_SHA256, PATCHED_SHA256 };
if (require.main === module) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/patch-ssh2.cjs [--check]');
    console.log('Verified KonX ssh2 compatibility patch: ' + JSON.stringify(patchSsh2({ check: process.argv.includes('--check') })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
