'use strict';

// ssh2 owns algorithm support and filters it for the running crypto provider.
// Electron/BoringSSL and source Node/OpenSSL do not expose identical ciphers.
const {
  DEFAULT_KEX, SUPPORTED_KEX, DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY,
  DEFAULT_CIPHER, SUPPORTED_CIPHER, DEFAULT_MAC, SUPPORTED_MAC,
} = require('ssh2/lib/protocol/constants');
const { supportsDsa } = require('./ssh-capabilities');

function isLegacy(name) {
  return typeof name === 'string' && /(?:^ssh-rsa$|^ssh-dss$|sha1|md5|ripemd160|96$|-cbc$|^arcfour)/i.test(name);
}

function sshAlgorithms(mode = 'auto') {
  if (mode !== 'auto' && mode !== 'modern') {
    throw new Error('Unknown SSH transport compatibility setting. Edit the session and choose Automatic or Modern transport only.');
  }
  const ordered = (defaults, supported) => {
    const all = [...new Set([...defaults, ...supported])];
    const modern = all.filter(name => !isLegacy(name));
    return mode === 'modern' ? modern : [...modern, ...all.filter(isLegacy)];
  };
  return {
    kex: ordered(DEFAULT_KEX, SUPPORTED_KEX),
    serverHostKey: ordered(DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY).filter(name => name !== 'ssh-dss' || supportsDsa()),
    cipher: ordered(DEFAULT_CIPHER, SUPPORTED_CIPHER),
    hmac: ordered(DEFAULT_MAC, SUPPORTED_MAC),
  };
}

function legacyAlgorithms(negotiated = {}) {
  return [...new Set([
    negotiated.kex, negotiated.serverHostKey,
    negotiated.cs?.cipher, negotiated.sc?.cipher,
    negotiated.cs?.mac, negotiated.sc?.mac,
  ].filter(isLegacy))];
}

function negotiationError(error, mode = 'auto') {
  if (!/no matching (?:key exchange algorithm|host key format|.*cipher|.*mac)/i.test(error.message || '')) return error;
  const hint = mode === 'modern'
    ? 'This session uses Modern transport only. For an older device, choose Automatic under Connection → SSH transport compatibility.'
    : 'No mutually supported SSH 2 algorithm was found. Check the device SSH configuration; SSH 1 is not supported.';
  return Object.assign(new Error(`${error.message}. ${hint}`), { code: 'SSH_NEGOTIATION', level: error.level });
}

module.exports = { sshAlgorithms, legacyAlgorithms, negotiationError };
