'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { domainToASCII } = require('url');
const { Client, utils } = require('ssh2');
const { sshAlgorithms, legacyAlgorithms } = require('../ssh-policy');
const { finding, makeReport, checkCancelled, onCancel } = require('./common');

const TLS_REF = 'https://nodejs.org/api/tls.html';
const WEB_REF = 'https://owasp.org/projects/secure-headers-project';
const SSH_REF = 'https://github.com/mscdex/ssh2#client';
const clean = (value, max = 500) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
const cancelled = () => new Error('Assessment cancelled');
const timeout = (params, fallback = 6000) => Math.min(10000, Math.max(250, Number(params?.timeoutMs) || fallback));
const endpoint = (host, port) => `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;

function hostValue(value) {
  let host = String(value ?? '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host)) return host;
  if (/[\s\/?#@:\[\]\\,%*]/.test(host)) throw new Error('Enter one hostname or IP address without a port, range, or URL.');
  host = domainToASCII(host);
  if (!host || host.length > 253 || !host.split('.').every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) {
    throw new Error('Enter one valid hostname or IP address; ranges and subnets are not supported.');
  }
  return host;
}

function portValue(value, fallback) {
  const port = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  return port;
}

function unknown(id, title, error) {
  return finding({ id, title, status: 'unknown', severity: 'info', evidence: clean(error?.message || error),
    remediation: 'Confirm the target, service, network route, and firewall settings, then retry. No security conclusion can be drawn from an incomplete connection.' });
}

function certificateChecks(socket, host, prefix = 'tls') {
  const certificate = socket.getPeerCertificate();
  if (!certificate?.raw) return [unknown(`${prefix}-certificate`, 'Certificate inspection', 'The peer did not provide an inspectable certificate.')];
  const now = Date.now();
  const start = Date.parse(certificate.valid_from);
  const end = Date.parse(certificate.valid_to);
  const validDates = Number.isFinite(start) && Number.isFinite(end);
  const valid = validDates && now >= start && now <= end;
  const expiresSoon = valid && end - now < 30 * 86400000;
  let identityError;
  try { identityError = tls.checkServerIdentity(host, certificate); } catch (error) { identityError = error; }
  const checks = [
    finding({ id: `${prefix}-trust`, title: 'Certificate chain trust', status: socket.authorized ? 'pass' : 'warning', severity: 'high',
      evidence: socket.authorized ? 'The certificate chain is accepted by this KonX runtime trust store.' : `The runtime did not validate the chain: ${clean(socket.authorizationError || 'untrusted certificate')}.`,
      remediation: 'Install a complete certificate chain issued by an appropriate trusted authority. Private PKI must be trusted by the client. Runtime trust may differ from the Windows/browser trust store.', reference: TLS_REF }),
    finding({ id: `${prefix}-identity`, title: 'Certificate matches target', status: identityError ? 'fail' : 'pass', severity: 'high',
      evidence: identityError ? 'The certificate does not match the requested hostname or IP address.' : `The certificate matches ${host}.`,
      remediation: 'Use the intended service hostname and a certificate with matching subject alternative names.', reference: TLS_REF }),
    finding({ id: `${prefix}-validity`, title: 'Certificate validity dates', status: !validDates ? 'unknown' : !valid ? 'fail' : expiresSoon ? 'warning' : 'pass', severity: !valid ? 'high' : 'medium',
      evidence: `Valid from ${clean(certificate.valid_from)} until ${clean(certificate.valid_to)}.${expiresSoon ? ' Expires within 30 days.' : ''}`,
      remediation: 'Renew certificates before expiry and check both client and server clocks.', reference: TLS_REF }),
    finding({ id: `${prefix}-fingerprint`, title: 'Certificate fingerprint', status: 'info', severity: 'info',
      evidence: `SHA-256: ${clean(certificate.fingerprint256 || new crypto.X509Certificate(certificate.raw).fingerprint256)}`,
      remediation: 'Compare with a fingerprint obtained through a trusted channel when investigating a certificate change.', reference: TLS_REF }),
  ];
  try {
    const key = new crypto.X509Certificate(certificate.raw).publicKey;
    const details = key.asymmetricKeyDetails || {};
    const weak = ['rsa', 'rsa-pss'].includes(key.asymmetricKeyType) && details.modulusLength < 2048;
    checks.push(finding({ id: `${prefix}-key`, title: 'Certificate public key', status: weak ? 'warning' : 'info', severity: weak ? 'high' : 'info',
      evidence: `Type: ${clean(key.asymmetricKeyType)}${details.modulusLength ? `; bits: ${details.modulusLength}` : ''}${details.namedCurve ? `; curve: ${clean(details.namedCurve)}` : ''}.`,
      remediation: 'Use supported key types and an RSA modulus of at least 2048 bits. This metadata check is not a complete cryptographic assessment.', reference: TLS_REF }));
  } catch { checks.push(unknown(`${prefix}-key`, 'Certificate public key', 'The runtime could not inspect public-key metadata.')); }
  const protocol = socket.getProtocol();
  const cipher = socket.getCipher() || {};
  const weakProtocol = ['TLSv1', 'TLSv1.1', 'SSLv2', 'SSLv3'].includes(protocol);
  const weakCipher = /(?:RC4|(?:^|[_-])(?:3?DES|NULL|EXPORT|anon)(?:[_-]|$)|_CBC_)/i.test(cipher.standardName || cipher.name || '');
  checks.push(finding({ id: `${prefix}-negotiated`, title: 'Negotiated TLS connection', status: weakProtocol || weakCipher ? 'warning' : 'info', severity: weakProtocol || weakCipher ? 'high' : 'info',
    evidence: `Protocol: ${clean(protocol || 'unknown')}; cipher: ${clean(cipher.standardName || cipher.name || 'unknown')}.`,
    remediation: 'Prefer TLS 1.2 or TLS 1.3 with modern cipher suites. One successful negotiation does not show which other protocols or ciphers the server accepts.', reference: TLS_REF }));
  return checks;
}

function inspectTls(host, port, signal, budget) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let socket;
    let done = false;
    let remove = () => {};
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      remove();
      socket?.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('TLS handshake timed out.')), budget);
    try {
      socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false,
        // Keep chain verification separate from identity. The explicit hostname
        // check below runs even when the runtime rejects the certificate chain.
        checkServerIdentity: () => undefined });
      socket.once('secureConnect', () => {
        try { finish(null, certificateChecks(socket, host)); } catch (error) { finish(error); }
      });
      socket.once('error', (error) => finish(error));
      socket.once('close', () => finish(new Error('TLS connection closed before inspection completed.')));
      remove = onCancel(signal, () => finish(cancelled()));
    } catch (error) { finish(error); }
  });
}

async function scanTls(params = {}, signal) {
  const host = hostValue(params.host);
  const port = portValue(params.port, 443);
  let checks;
  try { checks = await inspectTls(host, port, signal, timeout(params)); }
  catch (error) { checkCancelled(signal); checks = [unknown('tls-connection', 'TLS connection', error)]; }
  return makeReport({ kind: 'tls', title: 'TLS and certificate audit', target: endpoint(host, port), checks,
    limitations: ['One TLS handshake using the KonX runtime defaults. This does not enumerate all supported protocol versions, cipher suites, revocation status, or vulnerabilities.', 'Untrusted TLS connections are inspected without sending credentials or application data. Certificate trust is evaluated with the runtime trust store.'] });
}

async function scanSsh(params = {}, signal) {
  const host = hostValue(params.host);
  const port = portValue(params.port, 22);
  checkCancelled(signal);
  let observations;
  try {
    observations = await new Promise((resolve, reject) => {
      const client = new Client();
      let hostKey;
      let banner = '';
      let done = false;
      let remove = () => {};
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        remove();
        client.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('SSH handshake timed out.')), timeout(params));
      client.once('handshake', (negotiated) => finish(null, { hostKey, banner, negotiated }));
      client.on('error', (error) => finish(error));
      client.once('close', () => finish(new Error('SSH connection closed before the handshake completed.')));
      remove = onCancel(signal, () => finish(cancelled()));
      if (done) return;
      try {
        client.connect({ host, port, username: 'konx-audit', readyTimeout: timeout(params),
          algorithms: sshAlgorithms(params.sshCompatibility),
          authHandler: () => false,
          hostVerifier: (key) => { hostKey = Buffer.from(key); return true; },
          debug: (message) => { if (message.startsWith('Remote ident: ')) banner = clean(message.slice(14), 260); },
        });
      } catch (error) { finish(error); }
    });
  } catch (error) {
    checkCancelled(signal);
    return makeReport({ kind: 'ssh', title: 'SSH security audit', target: endpoint(host, port), checks: [unknown('ssh-connection', 'SSH handshake', error)],
      limitations: ['No authentication, credentials, shell, or remote commands. A handshake failure does not prove that the SSH service is insecure.'] });
  }
  const { hostKey, negotiated: n, banner } = observations;
  const weak = legacyAlgorithms(n);
  let parsed;
  try { parsed = hostKey && utils.parseKey(hostKey); } catch {}
  let keyBits;
  try { keyBits = crypto.createPublicKey(parsed.getPublicPEM()).asymmetricKeyDetails?.modulusLength; } catch {}
  const weakKey = parsed?.type === 'ssh-dss' || (keyBits && keyBits < 2048);
  const checks = [
    finding({ id: 'ssh-banner', title: 'SSH identification', status: 'info', severity: 'info', evidence: banner || 'The SSH 2 handshake completed; the identification string was not available.',
      remediation: 'Treat banners as unverified service metadata; do not infer patch status or CVEs from a version string.', reference: SSH_REF }),
    finding({ id: 'ssh-algorithms', title: 'Negotiated SSH algorithms', status: weak.length ? 'warning' : 'info', severity: weak.length ? 'high' : 'info',
      evidence: `Key exchange: ${clean(n.kex)}; host signature: ${clean(n.serverHostKey)}; client → server cipher/MAC: ${clean(n.cs?.cipher)}/${clean(n.cs?.mac || 'integrated')}; server → client cipher/MAC: ${clean(n.sc?.cipher)}/${clean(n.sc?.mac || 'integrated')}.${weak.length ? ` Legacy selections: ${weak.map((a) => clean(a)).join(', ')}.` : ''}`,
      remediation: 'Prefer current SSH 2 key exchange, signatures, and authenticated encryption. This shows one negotiated selection, not the server’s full offered algorithm list.', reference: SSH_REF }),
    finding({ id: 'ssh-hostkey', title: 'Observed SSH host key', status: weakKey ? 'warning' : hostKey ? 'info' : 'unknown', severity: weakKey ? 'high' : 'info',
      evidence: hostKey ? `Type: ${clean(parsed?.type || 'unknown')}${keyBits ? `; bits: ${keyBits}` : ''}; SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}. This key has not been authenticated against a trusted baseline.` : 'The peer host key was not available.',
      remediation: 'Verify this fingerprint through a trusted channel. Compare saved reports to investigate changes before trusting a new key.', reference: SSH_REF }),
  ];
  return makeReport({ kind: 'ssh', title: 'SSH security audit', target: endpoint(host, port), checks,
    limitations: ['One pre-authentication SSH 2 handshake. No credentials, shell, commands, or host-key persistence.', 'Algorithms reflect the client and server intersection; this does not inventory every algorithm offered by the server or prove that legacy algorithms are disabled. Host-key identity is unverified.'] });
}

function validatedUrl(value) {
  let url;
  if (String(value || '').length > 4096) throw new Error('The URL is too long (maximum 4096 characters).');
  try { url = new URL(String(value || '')); } catch { throw new Error('Enter a complete HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use HTTP or HTTPS without embedded credentials.');
  hostValue(url.hostname);
  if (url.port) portValue(url.port);
  url.hash = '';
  // Header audits are unauthenticated. URL queries often carry credentials and
  // are therefore omitted even on redirects, especially when inspecting a
  // service with an untrusted certificate.
  url.search = '';
  return url;
}

function publicUrl(url) {
  // Defense in depth: validatedUrl strips queries before requests are made.
  return `${url.origin}${url.pathname}${url.search ? '?[query redacted]' : ''}`;
}

function requestHeaders(url, method, signal, budget) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let request;
    let done = false;
    let remove = () => {};
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      remove();
      request?.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('HTTP headers timed out.')), budget);
    try {
      request = (url.protocol === 'https:' ? https : http).request(url, { method, agent: false, rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        maxHeaderSize: 32768, headers: { 'User-Agent': 'KonX-Security-Audit', Connection: 'close' } }, (response) => {
        let tlsChecks = [];
        try { if (url.protocol === 'https:') tlsChecks = certificateChecks(response.socket, hostValue(url.hostname), 'web-tls'); }
        catch (error) { tlsChecks = [unknown('web-tls', 'HTTPS certificate', error)]; }
        const headers = { ...response.headers };
        // RFC 6797 section 8.1: only the first STS field is processed. Node's
        // joined header map otherwise loses that field boundary.
        const firstSts = response.rawHeaders.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === 'strict-transport-security');
        if (firstSts >= 0) headers['strict-transport-security'] = response.rawHeaders[firstSts + 1];
        const result = { status: response.statusCode, headers, tlsChecks };
        // No body buffering, browser rendering, scripts, or subresource requests.
        response.on('error', () => {});
        response.destroy();
        finish(null, result);
      });
      request.on('error', (error) => finish(error));
      remove = onCancel(signal, () => finish(cancelled()));
      if (!done) request.end();
    } catch (error) { finish(error); }
  });
}

function positiveHsts(value) {
  // RFC 6797 sections 6.1/6.1.1 permit quoted values and require every
  // directive to occur only once. Split outside quoted extension values.
  if (typeof value !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return false;
  const parts = []; let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && c === '\\') { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted || escaped) return false;
  parts.push(value.slice(start));
  const token = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/;
  const trimLws = part => part.replace(/^[ \t]+|[ \t]+$/g, '');
  const directives = new Map();
  for (const part of parts) {
    if (!trimLws(part)) continue;
    const equals = part.indexOf('='), name = trimLws(equals < 0 ? part : part.slice(0, equals)).toLowerCase();
    if (!token.test(name) || directives.has(name)) return false;
    let v = equals < 0 ? null : trimLws(part.slice(equals + 1));
    if (v !== null) {
      if (v.startsWith('"')) {
        if (!/^"(?:[^"\\]|\\[\x00-\x7f])*"$/.test(v)) return false;
        v = v.slice(1, -1).replace(/\\([\x00-\x7f])/g, '$1');
      } else if (!token.test(v)) return false;
    }
    directives.set(name, v);
  }
  if (directives.has('includesubdomains') && directives.get('includesubdomains') !== null) return false;
  const age = directives.get('max-age');
  return typeof age === 'string' && /^\d+$/.test(age) && /[1-9]/.test(age);
}

function webHeaderChecks(headers, url) {
  const checks = [];
  const contentType = String(headers['content-type'] || '');
  const html = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
  const hsts = String(headers['strict-transport-security'] || '');
  const hasPositiveHsts = positiveHsts(hsts);
  checks.push(finding({ id: 'web-hsts', title: 'HTTP Strict Transport Security',
    status: url.protocol !== 'https:' ? 'unknown' : hasPositiveHsts ? 'pass' : 'warning', severity: 'medium',
    evidence: url.protocol !== 'https:' ? 'HSTS only protects responses received over trusted HTTPS.' : hasPositiveHsts ? 'A valid positive HSTS max-age is present in the first header field.' : 'No valid positive HSTS max-age was observed in the first header field.',
    remediation: 'After validating HTTPS deployment and affected subdomains, configure an appropriate HSTS policy.', reference: WEB_REF }));
  const nosniff = String(headers['x-content-type-options'] || '').toLowerCase() === 'nosniff';
  checks.push(finding({ id: 'web-nosniff', title: 'MIME type sniffing protection', status: nosniff ? 'pass' : 'warning', severity: 'low',
    evidence: nosniff ? 'X-Content-Type-Options: nosniff is present.' : 'X-Content-Type-Options: nosniff was not observed.', remediation: 'Serve correct Content-Type values and set X-Content-Type-Options: nosniff.', reference: WEB_REF }));
  const referrer = String(headers['referrer-policy'] || '').split(',').map((token) => token.trim().toLowerCase());
  const recognized = new Set(['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url']);
  const effective = referrer.filter((token) => recognized.has(token)).pop();
  const privateReferrer = ['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'].includes(effective);
  checks.push(finding({ id: 'web-referrer', title: 'Referrer disclosure policy', status: privateReferrer ? 'info' : effective ? 'warning' : 'info', severity: effective && !privateReferrer ? 'low' : 'info', confidence: 'medium',
    evidence: effective ? `Effective recognized Referrer-Policy: ${effective}.` : 'No recognized explicit Referrer-Policy header was observed; browser defaults and document-level settings may apply.',
    remediation: 'Use an explicit policy such as strict-origin-when-cross-origin or no-referrer where appropriate. Never place secrets in URLs.', reference: WEB_REF }));
  const csp = String(headers['content-security-policy'] || '');
  const cspUnsafe = /(?:'unsafe-inline'|'unsafe-eval'|(?:^|[;\s])\*(?:[;\s]|$))/i.test(csp);
  checks.push(finding({ id: 'web-csp', title: 'Content Security Policy', status: !html ? 'info' : !csp || cspUnsafe ? 'warning' : 'info', severity: html ? 'medium' : 'info', confidence: 'medium',
    evidence: !html ? 'The response was not identified as HTML; CSP relevance depends on how this resource is used.' : !csp ? 'No enforced Content-Security-Policy header was observed.' : cspUnsafe ? 'An enforced CSP is present with a wildcard or unsafe directive token; review its effective scope.' : 'An enforced CSP header is present. Policy effectiveness requires application context and is not validated here.',
    remediation: 'For browser documents, develop and test a restrictive CSP with nonces or hashes. Report-only policies do not enforce restrictions.', reference: WEB_REF }));
  const frameAncestors = /(?:^|;)\s*frame-ancestors\s+[^;]+/i.test(csp);
  const xfo = /^(?:deny|sameorigin)$/i.test(String(headers['x-frame-options'] || '').trim());
  checks.push(finding({ id: 'web-framing', title: 'Browser framing policy', status: !html ? 'info' : frameAncestors || xfo ? 'info' : 'warning', severity: html ? 'low' : 'info', confidence: 'medium',
    evidence: !html ? 'Framing policy is context-dependent for this content type.' : frameAncestors || xfo ? 'A framing control header is present; permitted origins still require review.' : 'No frame-ancestors CSP directive or recognized X-Frame-Options value was observed.', remediation: 'Set a frame-ancestors policy suitable for the application, with X-Frame-Options where compatible.', reference: WEB_REF }));
  const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : headers['set-cookie'] ? [headers['set-cookie']] : [];
  if (cookies.length) {
    const missing = { secure: 0, httpOnly: 0, sameSite: 0, sameSiteNoneWithoutSecure: 0 };
    for (const cookie of cookies) {
      // Ignore the cookie name/value entirely; retain aggregate attributes only.
      const attributes = String(cookie).split(';').slice(1).map((part) => part.trim());
      const secure = attributes.some((part) => /^secure$/i.test(part));
      if (!secure) missing.secure++;
      if (!attributes.some((part) => /^httponly$/i.test(part))) missing.httpOnly++;
      if (!attributes.some((part) => /^samesite=(?:strict|lax|none)$/i.test(part))) missing.sameSite++;
      if (!secure && attributes.some((part) => /^samesite=none$/i.test(part))) missing.sameSiteNoneWithoutSecure++;
    }
    const gaps = Object.values(missing).some(Boolean);
    checks.push(finding({ id: 'web-cookies', title: 'Cookie protection attributes', status: gaps ? 'warning' : 'info', severity: gaps ? 'medium' : 'info', confidence: 'medium',
      evidence: `${cookies.length} cookie(s). Missing Secure: ${missing.secure}; missing HttpOnly: ${missing.httpOnly}; missing/invalid SameSite: ${missing.sameSite}; SameSite=None without Secure: ${missing.sameSiteNoneWithoutSecure}. Cookie names and values are omitted.`,
      remediation: 'Apply Secure, HttpOnly, and an appropriate SameSite policy to sensitive session cookies. Some non-sensitive cookies intentionally need script access.', reference: WEB_REF }));
  } else checks.push(finding({ id: 'web-cookies', title: 'Cookie protection attributes', status: 'info', severity: 'info', evidence: 'No Set-Cookie headers were received in this unauthenticated response.', remediation: 'Review authenticated session cookies separately.', reference: WEB_REF }));
  return checks;
}

async function scanWeb(params = {}, signal) {
  const start = validatedUrl(params.url);
  let current = start;
  const checks = [];
  const deadline = Date.now() + Math.min(15000, timeout(params) * 3);
  const seen = new Set();
  let final;
  for (let hop = 0; hop <= 3; hop++) {
    checkCancelled(signal);
    if (seen.has(current.href)) { checks.push(unknown('web-redirect-loop', 'Redirect chain', 'A redirect loop was observed.')); final = undefined; break; }
    seen.add(current.href);
    try {
      const remaining = () => Math.min(timeout(params), Math.max(1, deadline - Date.now()));
      if (Date.now() >= deadline) throw new Error('The web assessment time budget was reached.');
      let response = await requestHeaders(current, 'HEAD', signal, remaining());
      if ([405, 501].includes(response.status)) {
        if (Date.now() >= deadline) throw new Error('The web assessment time budget was reached.');
        response = await requestHeaders(current, 'GET', signal, remaining());
      }
      final = { response, url: current };
      checks.push(finding({ id: `web-response-${hop}`, title: `HTTP response ${hop + 1}`, status: 'info', severity: 'info', evidence: `${publicUrl(current)} returned HTTP ${response.status}.`, remediation: 'Header findings describe this unauthenticated response only.' }));
      if (current.protocol === 'https:') checks.push(...response.tlsChecks.map((c) => ({ ...c, id: `${c.id}-${hop}` })));
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) break;
      let next;
      try { next = validatedUrl(new URL(response.headers.location, current).href); }
      catch { checks.push(unknown('web-redirect-invalid', 'Redirect destination', 'The redirect did not point to an HTTP(S) URL without credentials.')); final = undefined; break; }
      if (current.protocol === 'https:' && next.protocol === 'http:') {
        checks.push(finding({ id: `web-downgrade-${hop}`, title: 'HTTPS redirect downgrade', status: 'fail', severity: 'high', evidence: 'The HTTPS response redirects to plaintext HTTP. The destination was not followed.', remediation: 'Keep every redirect hop on HTTPS.', reference: WEB_REF }));
        final = undefined; break;
      }
      if (hostValue(next.hostname) !== hostValue(start.hostname)) {
        checks.push(finding({ id: 'web-redirect-scope', title: 'Redirect leaves selected host', status: 'info', severity: 'info', evidence: `Redirect target host: ${clean(next.hostname)}. It was not followed.`, remediation: 'Assess that host separately if it is in scope.' }));
        final = undefined; break;
      }
      if (hop === 3) { checks.push(unknown('web-redirect-limit', 'Redirect chain', 'The limit of three followed redirects was reached.')); final = undefined; break; }
      current = next;
    } catch (error) { checkCancelled(signal); checks.push(unknown('web-connection', 'HTTP connection', error)); final = undefined; break; }
  }
  const secureFinal = final?.url.protocol === 'https:';
  checks.push(finding({ id: 'web-transport', title: 'HTTPS transport', status: secureFinal ? 'info' : final ? 'warning' : 'unknown', severity: secureFinal ? 'info' : 'medium',
    evidence: secureFinal ? 'The final inspected response used HTTPS; certificate findings above describe its trust.' : final ? 'The final inspected response used plaintext HTTP.' : 'A final in-scope response could not be inspected.',
    remediation: 'Serve sensitive traffic over trusted HTTPS and redirect HTTP requests to HTTPS.', reference: WEB_REF }));
  if (final) checks.push(...webHeaderChecks(final.response.headers, final.url));
  return makeReport({ kind: 'web', title: 'Web security headers', target: publicUrl(start), checks,
    limitations: ['Unauthenticated HEAD requests, with a header-only GET fallback for HTTP 405/501. No scripts, subresources, submitted forms, login credentials, or persisted cookies. URL queries are removed before requests, including redirects.', 'At most three same-host redirects. HTTPS downgrades and cross-host redirects are reported without following. Response bodies are discarded; headers are capped at 32 KiB.', 'Headers are configuration observations, not proof of exploitability. CSP, framing, and cookie requirements depend on application context. Queries and cookie names/values are not retained.'] });
}

const PORTS = [[21, 'FTP'], [22, 'SSH'], [23, 'Telnet'], [80, 'HTTP'], [135, 'RPC endpoint mapper'], [139, 'NetBIOS session'], [443, 'HTTPS'], [445, 'SMB'], [1433, 'SQL Server'], [3306, 'MySQL'], [3389, 'RDP'], [5432, 'PostgreSQL'], [5900, 'VNC'], [5985, 'WinRM HTTP'], [5986, 'WinRM HTTPS'], [8080, 'HTTP alternate']];
const WINDOWS_PORTS = new Set([135, 139, 445, 3389, 5985, 5986, 1433]);

function probe(host, port, signal, budget) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    let remove = () => {};
    const socket = new net.Socket();
    const finish = (error, state, detail = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      remove();
      socket.destroy();
      if (error) reject(error); else resolve({ state, detail });
    };
    const timer = setTimeout(() => finish(null, 'unknown', 'Connection timed out; filtering or network loss is possible.'), budget);
    socket.once('connect', () => finish(null, 'open'));
    socket.once('error', (error) => finish(null, error.code === 'ECONNREFUSED' ? 'closed' : 'unknown', clean(error.code || error.message)));
    remove = onCancel(signal, () => finish(cancelled()));
    if (!done) { try { socket.connect(port, host); } catch (error) { finish(null, 'unknown', clean(error.message)); } }
  });
}

async function scanExposure(params = {}, signal) {
  const host = hostValue(params.host);
  const windows = params.profile === 'windows' || params.windowsOnly === true;
  let ports = PORTS.filter(([port]) => !windows || WINDOWS_PORTS.has(port));
  if (params.ports !== undefined) {
    if (!Array.isArray(params.ports) || !params.ports.length || params.ports.length > 20) throw new Error('Provide between 1 and 20 individual ports.');
    ports = [...new Set(params.ports.map((port) => portValue(port)))].map((port) => [port, PORTS.find(([p]) => p === port)?.[1] || 'unidentified service']);
  }
  const checks = new Array(ports.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ports.length) }, async () => {
    while (next < ports.length) {
      checkCancelled(signal);
      const index = next++;
      const [port, label] = ports[index];
      const result = await probe(host, port, signal, Math.min(3000, timeout(params, 1000)));
      const legacy = [21, 23, 139, 5900].includes(port);
      checks[index] = finding({ id: `port-${port}`, title: `TCP ${port} (${label})`, status: result.state === 'open' ? 'warning' : result.state === 'closed' ? 'info' : 'unknown', severity: result.state === 'open' ? legacy ? 'medium' : 'low' : 'info',
        evidence: result.state === 'open' ? `TCP ${port} is reachable from this PC. The conventional port label is ${label}; the actual service and configuration were not identified.` : result.state === 'closed' ? 'The target refused this TCP connection from this PC.' : `Reachability is unknown. ${result.detail}`,
        remediation: result.state === 'open' ? 'Confirm that this exposure is intended. Restrict management and database services to trusted networks and verify authentication and encryption separately.' : 'Results describe this source PC and time only; firewalls and routing may produce different results elsewhere.',
        confidence: 'high', reference: windows ? 'https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/service-overview-and-network-port-requirements' : '' });
    }
  }));
  checkCancelled(signal);
  return makeReport({ kind: windows ? 'windows-remote' : 'exposure', title: windows ? 'Windows remote exposure review' : 'Service exposure review', target: host, checks,
    limitations: ['Single-host TCP connection checks, at most 20 ports and four concurrent sockets. No UDP, login attempts, protocol exploitation, or remote commands.', 'An open conventional Windows port does not identify Windows, prove a vulnerability, reveal SMB signing, or determine patch status. Refused/timeout results do not establish that the host is secure.'] });
}

module.exports = { scanTls, scanSsh, scanWeb, scanExposure };
