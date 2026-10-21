'use strict';

const { generateKeyPairSync } = require('node:crypto');

// Disposable, in-memory host identity for local test peers. ssh2's Ed25519
// generator strips significant leading zero bytes from the fixed-width public
// key, occasionally producing a private key its own parser rejects. Let Node
// own the PKCS1 encoding instead; never retry generation until a key parses.
let hostKey;
function sshHostKey() {
  if (!hostKey) hostKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  return hostKey;
}

module.exports = { sshHostKey };
