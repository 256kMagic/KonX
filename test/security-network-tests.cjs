'use strict';

const assert = require('assert');
const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { Server, utils } = require('ssh2');
const { scanTls, scanSsh, scanWeb, scanExposure } = require('../src/main/security/network');

// Public, disposable, localhost-only TLS fixture. Never use this key outside tests.
const TEST_KEY = "-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCjM5jQTU1q3PTB\r\nzaHKZFA0a29wgWE5zRqZQu/Wf8REkmT+AQmrhHWR1E2Y6grQS0IEXVIx00FOOyNg\r\ntEOYroGL0XbfuOzuNQzoyRI9do0hK+Mr7vJ7s8qhC7FNRPxOxgifxzsuMktrY0qQ\r\nJdLY234ckwtMOwPVviYT7ltBVp0G2kvM5MNgIJzbqn1rhE3EI+hgegt2+5AN6uQv\r\n3TrRQTidzNmPyPi17Mlr0Yx1ErBrlzdHi1vaHj2Urk968UCAqHJeBGJzCt046y7N\r\nNT4B5ZpWvabTM5ovsfRp62mX5te7+WxyelVZg8YHDN6sO4nA2H1Q/cySj3PX1SVq\r\nkzfp4+uBAgMBAAECggEAGuR7c6WtUmTnCxF2rdpiUgT7F8umCQeIcMVULqEepxsF\r\ne8qRfJsm4XkdsUstrX2dOwlirDWuvvSlQ3/o3J2y2KaTQ1HebvE8d5Z8hDbHEjaA\r\naGKnP+WUR/3cgUpTFirxTFzg3l+oyGET7hVhfV0L1qsPU0gtPVkoPqQKEwXx+akX\r\nM+L2lU4oe0/hRmdcI7QOMG09JIc1OWTEr2d8BB+cLXAOC7ZHTneeESTX0sl7JkZL\r\nnt/keadl3GsCXgMkRoKooJVTKg+9c7tfHJFc/YCWWIQdrlIBJFNad36Zr303/3lx\r\nn6XmvyM+KOlKSQJ7E/FlkKHrzV+FOXp2r/X0OV6eXQKBgQDMw+ni976Wm8RptX3X\r\neA200aXvyxw3JYs6NbwZLqEdVklGJN0xWCE5mVta9+bDotHmNMGAdhiqldwkGadm\r\nTLPTvFhVihXfiRjusTTqw3FfBxFY37O56T0gaQc1IUP4T/4YHss9KbmljmhEnUdI\r\nBmO1JkIHaWJcYyD7nNG4bOdmpQKBgQDMCVlzJju7xKJay/GNjnyZZYMHOaDIa9Nx\r\n6OpSEZNH37hzdmL/m4CChezYZS4zwIRFjfMH4/ZqDgBbxiSHAuehvLQG/4niSj37\r\nrGivxOWnTe5/PHFBttNkyZpgU/s0gfCx+ocNfqC8de4N2JRg3fw0VvTFbrI/iSUp\r\nq1IK/I32rQKBgHBCsIWowaqcd5Bk2js5LHqHveu7dRqe0Lf3IcrEj7wfxEhaiZI1\r\n+PE1LKqw4qk7KMyG+9dL57YONwTrs6UYRDa/Ocabz+YfqbWjHZnf0NYCb/ZDnqs8\r\nPjD4o+Ty+eq3IF1k9JPxvkAP1QZZG+1W4287LFQX6L8x8bFAhpIP0sWpAoGAMWCB\r\n2TADfKlVcQux5UP6O1UppHH5ywbtIL/xFPNT5SzrAmZABwOm0e9/Jc82oyeP2xVD\r\nH0G3vGqvA4asCFBXpfh4yMjGoZC9903996t6uEZP1VLXRcPs3JM9XNp2DHr1uNyc\r\nGlPuqi0P8yHapqaSBkiU68KiOGYELFVdgXMlF/ECgYEAu5/+sOjmbcK4kUGWdzEg\r\nQmG5EdaQd/NjCaaa+wRhxB314y7Hk8656/W8l8wZR6dFcZgseQcEljb/3TUwqwp8\r\nnHFnLeTmrjL4Qh1JuMwhgEP3uFJxrQj/c+wmYZ+whP8YIRokmuq6mkZgrRCIphX8\r\n4P6waL3QW/jSzm7O6SDlOHs=\r\n-----END PRIVATE KEY-----\r\n";
const TEST_CERT = "-----BEGIN CERTIFICATE-----\r\nMIIDJTCCAg2gAwIBAgIUTuccv4FauhymEfp22OR5EirvZi0wDQYJKoZIhvcNAQEL\r\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyMDIyNTkwOVoXDTM2MTAx\r\nNzIyNTkwOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\r\nAAOCAQ8AMIIBCgKCAQEAozOY0E1Natz0wc2hymRQNGtvcIFhOc0amULv1n/ERJJk\r\n/gEJq4R1kdRNmOoK0EtCBF1SMdNBTjsjYLRDmK6Bi9F237js7jUM6MkSPXaNISvj\r\nK+7ye7PKoQuxTUT8TsYIn8c7LjJLa2NKkCXS2Nt+HJMLTDsD1b4mE+5bQVadBtpL\r\nzOTDYCCc26p9a4RNxCPoYHoLdvuQDerkL9060UE4nczZj8j4tezJa9GMdRKwa5c3\r\nR4tb2h49lK5PevFAgKhyXgRicwrdOOsuzTU+AeWaVr2m0zOaL7H0aetpl+bXu/ls\r\ncnpVWYPGBwzerDuJwNh9UP3Mko9z19UlapM36ePrgQIDAQABo28wbTAdBgNVHQ4E\r\nFgQUXzzlNP3/wsLJi0EaWcqja3C+vHQwHwYDVR0jBBgwFoAUXzzlNP3/wsLJi0Ea\r\nWcqja3C+vHQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH\r\nBH8AAAEwDQYJKoZIhvcNAQELBQADggEBADY6OJt7rsMPr0OwhdhaPKJ8Mqg2uElK\r\nWHr5oIC2XhcMGS6KhNaF6PbAKUGJRZuHNg8u83PYvYHpS/syGnZl+usnXru4aZRk\r\n6YN2Cjq4FIMgG6Wl4q1akOYyXTN+iqOIsInyWuto6ioAl2bcuSLlvU3T1jXKRf6q\r\n0YKOqNnVxSj/on4QQgB/NRj8lhRjP5dL2e7yUjcDSEEJRO5K9+JSzj/PDcfVeN6S\r\nUJRwzwJEZ9lzWpG5AenmEjd7LcaRJxqhvfFy3AYasbO5KJ49dmf/zxzofJUKJBog\r\nBlZ/m5TNtwEuKNf7n4NHeCXpW+a/OSzaGu4rdjL/+v0aZ31P3C8tYjc=\r\n-----END CERTIFICATE-----\r\n";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (report, id) => report.checks.find((item) => item.id === id);
const stop = (signal) => { signal.stopped = true; signal.onStop?.(); };

async function withServer(server, fn, host = '127.0.0.1') {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  try { return await fn(server.address().port, sockets); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runSecurityNetworkTests(test) {
  await test('Security network targets reject ranges, URLs, invalid ports and credentials before connecting', async () => {
    for (const host of ['10.0.0.0/24', 'localhost/path', 'localhost?token=x', 'host:22', 'a,b', '*', 'x y', '']) {
      await assert.rejects(scanTls({ host }), /hostname|IP|port|range|URL/i);
    }
    await assert.rejects(scanSsh({ host: 'localhost', port: 70000 }), /Port/);
    await assert.rejects(scanWeb({ url: 'file:///tmp/test' }), /HTTP/);
    await assert.rejects(scanWeb({ url: 'https://user:secret@localhost/' }), /credentials/);
    await assert.rejects(scanExposure({ host: 'localhost', ports: Array.from({ length: 21 }, (_, i) => i + 1) }), /20/);
  });

  await test('TLS audit separates local certificate trust from matching identity and records negotiation', async () => {
    await withServer(tls.createServer({ key: TEST_KEY, cert: TEST_CERT }), async (port) => {
      const report = await scanTls({ host: '127.0.0.1', port });
      assert.equal(report.kind, 'tls');
      assert.equal(check(report, 'tls-trust').status, 'warning');
      assert.equal(check(report, 'tls-identity').status, 'pass');
      assert.match(check(report, 'tls-fingerprint').evidence, /SHA-256/);
      assert.match(check(report, 'tls-key').evidence, /2048/);
      assert.match(check(report, 'tls-negotiated').evidence, /TLSv1\.[23]/);
      assert.ok(report.limitations.some((text) => /does not enumerate/.test(text)));
    });
  });

  await test('TLS cancellation closes a stalled handshake and releases the cancellation hook', async () => {
    await withServer(net.createServer((socket) => socket.resume()), async (port, sockets) => {
      const signal = { stopped: false };
      const assessment = scanTls({ host: '127.0.0.1', port, timeoutMs: 3000 }, signal);
      await sleep(40);
      stop(signal);
      await assert.rejects(assessment, /cancelled/);
      await sleep(40);
      assert.equal(sockets.size, 0);
      assert.ok(!signal.onStop);
    });
  });

  await test('TLS IPv6 bracket handling keeps the requested identity and reports a certificate mismatch', async () => {
    try {
      await withServer(tls.createServer({ key: TEST_KEY, cert: TEST_CERT }), async (port) => {
        const report = await scanTls({ host: '[::1]', port });
        assert.equal(report.target, `[::1]:${port}`);
        assert.equal(check(report, 'tls-identity').status, 'fail');
      }, '::1');
    } catch (error) {
      if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error;
      // Some CI environments disable IPv6 entirely; the IPv4 paths remain tested.
    }
  });

  await test('TLS and HTTPS distinguish a trusted certificate chain from a mismatching hostname', async () => {
    const originalConnect = tls.connect;
    // Trust only the disposable fixture for these local clients. Production
    // APIs do not accept a CA override and still use the runtime trust store.
    tls.connect = function (options, ...args) { return originalConnect.call(this, { ...options, ca: TEST_CERT }, ...args); };
    try {
      await withServer(tls.createServer({ key: TEST_KEY, cert: TEST_CERT }), async (port) => {
        const report = await scanTls({ host: '[::1]', port });
        assert.equal(check(report, 'tls-trust').status, 'pass');
        assert.equal(check(report, 'tls-identity').status, 'fail');
      }, '::1');
      await withServer(https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end();
      }), async (port) => {
        const report = await scanWeb({ url: `https://[::1]:${port}/` });
        assert.equal(check(report, 'web-tls-trust-0').status, 'pass');
        assert.equal(check(report, 'web-tls-identity-0').status, 'fail');
      }, '::1');
    } catch (error) {
      if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    } finally { tls.connect = originalConnect; }
  });

  await test('TLS inability to negotiate is unknown rather than a claim that the endpoint is secure', async () => {
    await withServer(net.createServer((socket) => socket.end()), async (port) => {
      const report = await scanTls({ host: '127.0.0.1', port });
      assert.equal(check(report, 'tls-connection').status, 'unknown');
      assert.equal(report.checks.some((item) => item.status === 'pass'), false);
    });
  });

  await test('SSH audit reports the key and negotiated algorithms without any authentication attempt', async () => {
    let authentications = 0;
    const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private], ident: 'KonX_Local_Test' }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => { authentications++; ctx.reject(); });
    });
    await withServer(server, async (port) => {
      const report = await scanSsh({ host: '127.0.0.1', port });
      assert.equal(report.kind, 'ssh');
      assert.match(check(report, 'ssh-hostkey').evidence, /SHA256:/);
      assert.match(check(report, 'ssh-hostkey').evidence, /not been authenticated/);
      assert.match(check(report, 'ssh-banner').evidence, /KonX_Local_Test/);
      assert.match(check(report, 'ssh-algorithms').evidence, /Key exchange:/);
      await sleep(30);
      assert.equal(authentications, 0);
    });
  });

  await test('SSH cancellation closes a stalled identification exchange', async () => {
    await withServer(net.createServer((socket) => socket.resume()), async (port, sockets) => {
      const signal = {};
      const assessment = scanSsh({ host: '127.0.0.1', port }, signal);
      await sleep(30);
      stop(signal);
      await assert.rejects(assessment, /cancelled/);
      await sleep(30);
      assert.equal(sockets.size, 0);
      assert.ok(!signal.onStop);
    });
  });

  await test('Web audit uses GET fallback only for unsupported HEAD and keeps queries and cookie contents out of reports', async () => {
    const requests = [];
    const urls = [];
    await withServer(http.createServer((request, response) => {
      requests.push(request.method);
      urls.push(request.url);
      if (request.method === 'HEAD') { response.writeHead(405); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/html', 'X-Content-Type-Options': 'nosniff',
        'Set-Cookie': ['session=SECRET-COOKIE; HttpOnly; SameSite=Lax', 'privateName=ALSO-SECRET; Secure; HttpOnly; SameSite=Strict'] });
      response.write('<script>this is not rendered or fetched</script>');
      response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `http://127.0.0.1:${port}/?token=SECRET-QUERY` });
      assert.deepEqual(requests, ['HEAD', 'GET']);
      assert.deepEqual(urls, ['/', '/']);
      assert.equal(check(report, 'web-nosniff').status, 'pass');
      assert.equal(check(report, 'web-csp').status, 'warning');
      assert.equal(check(report, 'web-transport').status, 'warning');
      assert.match(check(report, 'web-cookies').evidence, /Missing Secure: 1/);
      assert.doesNotMatch(JSON.stringify(report), /SECRET|privateName/);
      assert.doesNotMatch(report.target, /\?/);
    });
  });

  await test('Web audit evaluates the final same-host redirect response and reports untrusted HTTPS', async () => {
    const requests = [];
    await withServer(https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (request, response) => {
      requests.push(request.url);
      if (request.url === '/') { response.writeHead(302, { Location: '/final' }); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Strict-Transport-Security': 'max-age=31536000',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
      response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `https://127.0.0.1:${port}/` });
      assert.deepEqual(requests, ['/', '/final']);
      assert.equal(check(report, 'web-hsts').status, 'pass');
      assert.equal(check(report, 'web-tls-trust-0').status, 'warning');
      assert.equal(check(report, 'web-tls-trust-1').status, 'warning');
      assert.equal(check(report, 'web-transport').status, 'info');
    });
  });

  await test('Web audit does not follow cross-host redirects, credentialed redirects or HTTPS downgrades', async () => {
    let hits = 0;
    await withServer(http.createServer((request, response) => {
      hits++;
      response.writeHead(302, { Location: 'http://localhost:1/private' }); response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `http://127.0.0.1:${port}/` });
      assert.ok(check(report, 'web-redirect-scope'));
      assert.equal(hits, 1);
    });
    await withServer(http.createServer((request, response) => {
      response.writeHead(302, { Location: 'http://user:secret@127.0.0.1/private' }); response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `http://127.0.0.1:${port}/` });
      assert.equal(check(report, 'web-redirect-invalid').status, 'unknown');
      assert.doesNotMatch(JSON.stringify(report), /secret/);
    });
    await withServer(https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (request, response) => {
      response.writeHead(302, { Location: 'http://127.0.0.1:1/' }); response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `https://127.0.0.1:${port}/` });
      assert.equal(check(report, 'web-downgrade-0').status, 'fail');
      assert.ok(!check(report, 'web-connection'));
    });
  });

  await test('Web audit bounds redirect chains, detects loops and rejects oversized response headers', async () => {
    let hits = 0;
    await withServer(http.createServer((request, response) => {
      hits++;
      response.writeHead(302, { Location: `/step-${hits}` }); response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `http://127.0.0.1:${port}/` });
      assert.equal(hits, 4);
      assert.equal(check(report, 'web-redirect-limit').status, 'unknown');
    });
    await withServer(http.createServer((request, response) => {
      response.writeHead(302, { Location: '/' }); response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `http://127.0.0.1:${port}/` });
      assert.ok(check(report, 'web-redirect-loop'));
    });
    await withServer(http.createServer((request, response) => {
      response.writeHead(200, { 'X-Enormous': 'x'.repeat(40000) }); response.end();
    }), async (port) => {
      const report = await scanWeb({ url: `http://127.0.0.1:${port}/` });
      assert.equal(check(report, 'web-connection').status, 'unknown');
    });
  });

  await test('Web cancellation closes a server that never returns headers', async () => {
    await withServer(http.createServer(() => {}), async (port, sockets) => {
      const signal = {};
      const assessment = scanWeb({ url: `http://127.0.0.1:${port}/` }, signal);
      await sleep(30);
      stop(signal);
      await assert.rejects(assessment, /cancelled/);
      await sleep(30);
      assert.equal(sockets.size, 0);
      assert.ok(!signal.onStop);
    });
  });

  await test('Exposure results describe TCP reachability without treating closed ports as proof of security', async () => {
    await withServer(net.createServer(), async (port) => {
      const report = await scanExposure({ host: '127.0.0.1', ports: [port], profile: 'windows' });
      assert.equal(report.kind, 'windows-remote');
      assert.equal(check(report, `port-${port}`).status, 'warning');
      assert.match(check(report, `port-${port}`).evidence, /reachable from this PC/);
      assert.ok(report.limitations.some((text) => /does not identify Windows/.test(text)));
    });
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const report = await scanExposure({ host: '127.0.0.1', ports: [port] });
    assert.equal(check(report, `port-${port}`).status, 'info');
    assert.match(check(report, `port-${port}`).evidence, /refused/);
  });

  await test('Exposure cancellation stops concurrent probes and restores the prior cancellation callback', async () => {
    let priorCalls = 0;
    const prior = () => { priorCalls++; };
    const signal = { onStop: prior };
    const assessment = scanExposure({ host: '127.0.0.1', ports: Array.from({ length: 20 }, (_, i) => 64000 + i) }, signal);
    stop(signal);
    await assert.rejects(assessment, /cancelled/);
    assert.equal(priorCalls, 1);
    assert.equal(signal.onStop, prior);
  });

  await test('Exposure limits simultaneous sockets to four and releases hooks after successful probes', async () => {
    const { EventEmitter } = require('events');
    const OriginalSocket = net.Socket;
    let active = 0;
    let maximum = 0;
    let created = 0;
    class ProbeSocket extends EventEmitter {
      constructor() { super(); this.closed = false; created++; active++; maximum = Math.max(maximum, active); }
      connect() { this.timer = setTimeout(() => this.emit('connect'), 5); }
      destroy() { if (!this.closed) { this.closed = true; clearTimeout(this.timer); active--; } }
    }
    const signal = {};
    try {
      net.Socket = ProbeSocket;
      const report = await scanExposure({ host: '127.0.0.1', ports: Array.from({ length: 20 }, (_, i) => 64000 + i) }, signal);
      assert.equal(report.checks.length, 20);
      assert.equal(created, 20);
      assert.equal(maximum, 4);
      assert.equal(active, 0);
      assert.ok(!signal.onStop);
    } finally { net.Socket = OriginalSocket; }
  });
}

module.exports = { runSecurityNetworkTests };
