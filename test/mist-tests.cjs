'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { MistClient, REGIONS, requestPath, safeClone } = require('../src/main/mist');

// Disposable synthetic credentials; no live Mist calls are made by this suite.
const TOKEN = 'synthetic_mist_key_for_tests_1234567890';
const OTHER_TOKEN = 'replacement_mist_test_key_0987654321';
const ORG = '11111111-2222-3333-4444-555555555555';
const SITE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const stop = (signal) => { signal.stopped = true; signal.onStop?.(); };

function fixtureCrypt() {
  const key = crypto.randomBytes(32);
  return {
    enabled: true,
    available() { return this.enabled; },
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function withClient(fn, transport) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'konx-mist-test-'));
  const crypt = fixtureCrypt();
  const client = new MistClient({ dir, crypt, request: transport || (() => { throw new Error('Unexpected network request'); }) });
  try { return await fn(client, dir, crypt); }
  finally {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('konx-mist-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function mockTransport(handler) {
  const calls = [];
  const transport = (options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => queueMicrotask(() => handler({ options, req, respond }));
    const respond = (status, data, headers = {}) => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = headers;
      res.destroyed = false;
      res.destroy = () => { res.destroyed = true; };
      callback(res);
      if (!res.destroyed) {
        res.emit('data', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)));
        res.emit('end');
      }
      return res;
    };
    calls.push({ options, req });
    return req;
  };
  transport.calls = calls;
  return transport;
}

async function runMistTests(test) {
  await test('Mist stores only encrypted API keys and exposes presence rather than credentials', async () => {
    await withClient(async (client, dir, crypt) => {
      assert.equal(client.getConfig().hasToken, false);
      const saved = client.configure({ region: 'emea01', token: TOKEN });
      assert.equal(saved.region, 'emea01');
      assert.equal(saved.hasToken, true);
      const raw = fs.readFileSync(path.join(dir, 'mist.json'), 'utf8');
      assert.ok(!raw.includes(TOKEN));
      assert.ok(!JSON.stringify(saved).includes(TOKEN));
      assert.equal(crypt.decrypt(JSON.parse(raw).tokenEnc), TOKEN);
      const reloaded = new MistClient({ dir, crypt });
      assert.equal(reloaded.getConfig().hasToken, true);
      reloaded.configure({ token: '' });
      assert.equal(reloaded._token(), TOKEN);
      reloaded.configure({ token: null });
      assert.equal(reloaded.getConfig().hasToken, false);
      assert.ok(!fs.readFileSync(path.join(dir, 'mist.json'), 'utf8').includes('tokenEnc'));
    });
  });

  await test('Mist refuses plaintext fallback and preserves saved credentials on encryption failure', async () => {
    await withClient(async (client, dir, crypt) => {
      crypt.enabled = false;
      assert.throws(() => client.configure({ token: TOKEN }), /encryption is unavailable/);
      assert.ok(!fs.existsSync(path.join(dir, 'mist.json')));
      crypt.enabled = true;
      client.configure({ token: TOKEN });
      const before = fs.readFileSync(client.file, 'utf8');
      crypt.encrypt = () => { throw new Error(OTHER_TOKEN); };
      assert.throws(() => client.configure({ token: OTHER_TOKEN }), (error) => /could not be encrypted/.test(error.message) && !error.message.includes(OTHER_TOKEN));
      assert.equal(fs.readFileSync(client.file, 'utf8'), before);
      assert.equal(client._token(), TOKEN);
      crypt.enabled = false;
      await assert.rejects(client.request('self'), /encryption is unavailable/);
    });
  });

  await test('Mist atomic-save failure keeps the previous key and removes its temporary file', async () => {
    await withClient(async (client, dir) => {
      client.configure({ token: TOKEN });
      const before = fs.readFileSync(client.file, 'utf8');
      const rename = fs.renameSync;
      fs.renameSync = () => { throw new Error('Synthetic failed replace'); };
      try { assert.throws(() => client.configure({ token: OTHER_TOKEN }), /previous configuration is unchanged/); }
      finally { fs.renameSync = rename; }
      assert.equal(fs.readFileSync(client.file, 'utf8'), before);
      assert.equal(client._token(), TOKEN);
      assert.deepEqual(fs.readdirSync(dir), ['mist.json']);
    });
  });

  await test('Mist binds saved API keys to an allowlisted cloud region', async () => {
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      assert.throws(() => client.configure({ region: 'https://attacker.example' }), /supported Mist cloud/);
      assert.throws(() => client.configure({ region: 'global03' }), /Re-enter the API key/);
      assert.equal(client.getConfig().region, 'global01');
      client.configure({ region: 'global03', token: OTHER_TOKEN });
      assert.equal(client.getConfig().region, 'global03');
      assert.equal(client._token(), OTHER_TOKEN);
      client.configure({ region: 'apac03', forget: true });
      assert.equal(client.getConfig().hasToken, false);
      assert.equal(REGIONS.length, 12);
      assert.equal(new Set(REGIONS.map((entry) => entry.origin)).size, 12);
      assert.ok(REGIONS.every((entry) => /^https:\/\/api(?:\.[a-z]+\d?|)\.mist\.com$|^https:\/\/api\.mist\.com$/.test(entry.origin)));
    });
  });

  await test('Mist rejects stale connection revisions before decrypting or sending requests', async () => {
    const transport = mockTransport(({ respond }) => respond(200, { privileges: [] }));
    await withClient(async (client, dir, crypt) => {
      const original = client.configure({ token: TOKEN });
      assert.match(original.revision, /^[0-9a-f-]{36}$/);
      const changedKey = client.configure({ token: OTHER_TOKEN });
      assert.notEqual(changedKey.revision, original.revision);
      let decryptions = 0;
      const decrypt = crypt.decrypt.bind(crypt);
      crypt.decrypt = (value) => { decryptions++; return decrypt(value); };
      await assert.rejects(client.request('self', { configRevision: original.revision }), /connection settings changed/);
      assert.equal(decryptions, 0);
      assert.equal(transport.calls.length, 0);
      await client.request('self', { configRevision: changedKey.revision });
      assert.equal(transport.calls.length, 1);
      const changedRegion = client.configure({ region: 'emea01', token: OTHER_TOKEN });
      assert.notEqual(changedRegion.revision, changedKey.revision);
      await assert.rejects(client.request('self', { configRevision: changedKey.revision }), /connection settings changed/);
      assert.equal(decryptions, 1);
      assert.equal(transport.calls.length, 1);
      await client.request('self', { configRevision: changedRegion.revision });
      assert.equal(transport.calls.length, 2);
      assert.equal(transport.calls[1].options.hostname, 'api.eu.mist.com');
      assert.ok(!JSON.stringify(client.getConfig()).includes(TOKEN));
      assert.ok(!JSON.stringify(client.getConfig()).includes(OTHER_TOKEN));
    }, transport);
  });

  await test('Mist rejects arbitrary actions, injected identifiers, malformed MACs, and invalid time ranges', async () => {
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      for (const [action, params] of [
        ['https://example.com', {}], ['restart', { siteId: SITE }], ['sites', { orgId: '../self' }],
        ['aps', { siteId: SITE + '?secret=x' }], ['clients', { siteId: '' }],
        ['marvis', { orgId: ORG }], ['marvis', { orgId: ORG, mac: 'aa:bb:cc;dd:ee:ff' }],
        ['marvis', { orgId: ORG, siteId: SITE, type: 'POST' }], ['marvis', { orgId: ORG, siteId: SITE, duration: '100y' }],
        ['marvis', { orgId: ORG, siteId: SITE, duration: 'constructor' }], ['marvis', { orgId: ORG, siteId: SITE, duration: '__proto__' }],
      ]) await assert.rejects(client.request(action, params));
      for (const token of ['Token ' + TOKEN, TOKEN + '\r\nHost: attacker', 'short']) assert.throws(() => client.configure({ token }), /API key only/);
    });
  });

  await test('Mist account discovery uses verified HTTPS and returns compact explicit privileges', async () => {
    const transport = mockTransport(({ options, respond }) => {
      assert.equal(options.hostname, 'api.mist.com');
      assert.equal(options.protocol, 'https:');
      assert.equal(options.port, 443);
      assert.equal(options.method, 'GET');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.minVersion, 'TLSv1.2');
      assert.equal(options.path, '/api/v1/self');
      assert.equal(options.headers.Authorization, 'Token ' + TOKEN);
      respond(200, { first_name: 'Synthetic', last_name: 'Operator', email: 'private@example.invalid', api_token: TOKEN, privileges: [
        { scope: 'org', org_id: ORG, name: 'Demo org', role: 'observer' },
        { scope: 'site', org_id: ORG, site_id: SITE, name: 'Demo site', role: 'observer' },
      ] });
    });
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      const report = await client.request('self');
      assert.equal(report.data.name, 'Synthetic Operator');
      assert.equal(report.data.orgs[0].id, ORG);
      assert.equal(report.data.orgs[0].name, 'Demo org');
      assert.equal(report.data.sites[0].id, SITE);
      assert.deepEqual(report.scope, {});
      assert.ok(!JSON.stringify(report).includes(TOKEN));
      assert.ok(!JSON.stringify(report).includes('private@example.invalid'));
      assert.ok(report.limitations.some((entry) => /privileges/.test(entry)));
    }, transport);
  });

  await test('Mist AP and client snapshots strip configuration secrets and bound inventory', async () => {
    const transport = mockTransport(({ options, respond }) => {
      if (options.path.includes('/stats/devices')) return respond(200, [{
        id: SITE, mac: 'aabbccddeeff', name: 'Lab AP', status: 'connected', num_clients: 7, radio_stat: { band_5: { channel: 36, power: 12, util_all: 32 } },
        wlan: { passphrase: 'NEVER_RETURN_THIS' }, secret: TOKEN,
      }]);
      if (options.path.includes('/stats/clients')) return respond(200, Array.from({ length: 205 }, (_, index) => ({ mac: '112233445566', hostname: `Client ${index}`, ssid: 'Lab', rssi: -64, snr: 30, password: TOKEN })));
      respond(200, [{ id: SITE, org_id: ORG, name: 'Lab', timezone: 'UTC', password: TOKEN }]);
    });
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      const aps = await client.request('aps', { siteId: SITE });
      assert.deepEqual(aps.scope, { siteId: SITE });
      assert.equal(aps.data[0].numClients, 7);
      assert.equal(aps.data[0].radios[0].channel, 36);
      assert.equal(aps.data[0].radios[0].band, '5');
      assert.equal(aps.data[0].radios[0].utilization, 32);
      assert.ok(!JSON.stringify(aps).includes('NEVER_RETURN_THIS'));
      const clients = await client.request('clients', { siteId: SITE });
      assert.deepEqual(clients.scope, { siteId: SITE });
      assert.equal(clients.data.length, 200);
      assert.equal(clients.limited, true);
      assert.equal(clients.data[0].rssi, -64);
      const sites = await client.request('sites', { orgId: ORG });
      assert.deepEqual(sites.scope, { orgId: ORG });
      assert.equal(sites.data[0].id, SITE);
      assert.equal(sites.data[0].orgId, ORG);
      assert.ok(!JSON.stringify([aps, clients, sites]).includes(TOKEN));
    }, transport);
  });

  await test('Mist Marvis uses the documented site/device troubleshooting API and redacts echoed secrets', async () => {
    const transport = mockTransport(({ options, respond }) => {
      const url = new URL(options.path, 'https://api.mist.com');
      assert.equal(url.pathname, `/api/v1/orgs/${ORG}/troubleshoot`);
      assert.equal(url.searchParams.get('mac'), 'aabbccddeeff');
      assert.equal(url.searchParams.get('site_id'), SITE);
      assert.equal(url.searchParams.get('type'), 'wireless');
      assert.equal(Number(url.searchParams.get('end')) - Number(url.searchParams.get('start')), 3600);
      respond(200, { results: [{ category: 'Connectivity', reason: 'DHCP', text: `Investigate DHCP. Synthetic echo ${TOKEN}`, recommendation: 'Check the configured DHCP service', token: TOKEN, password: 'Never return' }] });
    });
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      const report = await client.request('marvis', { orgId: ORG, siteId: SITE, mac: 'AA:BB:CC:DD:EE:FF', type: 'wireless', duration: '1h', token: 'IGNORE_EXTRA_SECRET', endpoint: 'IGNORE_EXTRA_ENDPOINT' });
      assert.equal(report.scope.orgId, ORG);
      assert.equal(report.scope.siteId, SITE);
      assert.equal(report.scope.mac, 'aabbccddeeff');
      assert.equal(report.scope.type, 'wireless');
      assert.equal(report.scope.duration, '1h');
      assert.equal(report.scope.end - report.scope.start, 3600);
      assert.ok(!JSON.stringify(report).includes('IGNORE_EXTRA'));
      assert.equal(report.data.results[0].reason, 'DHCP');
      assert.ok(report.data.results[0].text.includes('[Redacted]'));
      assert.ok(!JSON.stringify(report).includes(TOKEN));
      assert.ok(!JSON.stringify(report).includes('Never return'));
      assert.ok(report.limitations.some((entry) => /subscription/.test(entry)));
      assert.ok(!requestPath('marvis', { orgId: ORG, siteId: SITE }).includes('undefined'));
    }, transport);
  });

  await test('Mist rejects redirects without forwarding credentials and hides error response bodies', async () => {
    for (const status of [301, 302, 307, 401, 403, 404, 500]) {
      const transport = mockTransport(({ respond }) => respond(status, { error: TOKEN }, { location: 'https://attacker.example/' }));
      await withClient(async (client) => {
        client.configure({ token: TOKEN });
        await assert.rejects(client.request('self'), (error) => !error.message.includes(TOKEN) && /Mist/.test(error.message));
        assert.equal(transport.calls.length, 1);
        assert.equal(transport.calls[0].req.destroyed, true);
      }, transport);
    }
  });

  await test('Mist honors rate-limit cooldown without automatic retries', async () => {
    const transport = mockTransport(({ respond }) => respond(429, { detail: TOKEN }, { 'retry-after': '120' }));
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      await assert.rejects(client.request('self'), /120 seconds/);
      await assert.rejects(client.request('self'), /rate limit/);
      assert.equal(transport.calls.length, 1);
    }, transport);
  });

  await test('Mist rejects malformed, oversized, encoded, and unexpected responses', async () => {
    for (const [body, headers, expected] of [
      ['not JSON ' + TOKEN, {}, /invalid JSON/],
      [{ privileges: [] }, { 'content-length': String(2 * 1024 * 1024 + 1) }, /2 MiB/],
      ['x'.repeat(2 * 1024 * 1024 + 1), {}, /2 MiB/],
      [{ privileges: [] }, { 'content-encoding': 'gzip' }, /unsupported response encoding/],
      [{ not_an_account: true }, {}, /unexpected account/],
    ]) {
      const transport = mockTransport(({ respond }) => respond(200, body, headers));
      await withClient(async (client) => {
        client.configure({ token: TOKEN });
        await assert.rejects(client.request('self'), expected);
      }, transport);
    }
  });

  await test('Mist transport and decryption errors do not expose credential-bearing exceptions', async () => {
    const transport = mockTransport(({ req }) => req.emit('error', new Error('Synthetic network error ' + TOKEN)));
    await withClient(async (client, dir, crypt) => {
      client.configure({ token: TOKEN });
      await assert.rejects(client.request('self'), (error) => /connect securely/.test(error.message) && !error.message.includes(TOKEN));
      crypt.decrypt = () => { throw new Error(TOKEN); };
      await assert.rejects(client.request('self'), (error) => /could not be decrypted/.test(error.message) && !error.message.includes(TOKEN));
    }, transport);
  });

  await test('Mist cancellation destroys its own request and prevents late cloud reports', async () => {
    let active;
    const transport = mockTransport((value) => { active = value; });
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      const signal = { stopped: false };
      const events = [];
      const promise = client.run({ action: 'self' }, (event, data) => events.push({ event, data }), signal);
      await new Promise((resolve) => setImmediate(resolve));
      stop(signal);
      await assert.rejects(promise, /cancelled/);
      assert.equal(active.req.destroyed, true);
      assert.ok(!signal.onStop);
      active.respond(200, { privileges: [] });
      assert.ok(!events.some((entry) => entry.event === 'report'));
      await assert.rejects(client.request('self', {}, { stopped: true }), /cancelled/);
      assert.equal(transport.calls.length, 1);
    }, transport);
  });

  await test('Mist damaged credential storage requires explicit repair and never makes an unauthenticated call', async () => {
    await withClient(async (client, dir, crypt) => {
      fs.writeFileSync(client.file, '{broken');
      const damaged = new MistClient({ dir, crypt });
      assert.ok(damaged.getConfig().warning);
      assert.throws(() => damaged.configure({}), /could not be read/);
      await assert.rejects(damaged.request('self'), /could not be read/);
      damaged.configure({ forget: true });
      assert.ok(!damaged.getConfig().warning);
      assert.equal(damaged.getConfig().hasToken, false);
      damaged.configure({ token: TOKEN });
      assert.equal(damaged._token(), TOKEN);
    });
  });

  await test('Mist generic Marvis response sanitizing excludes prototype keys and bounds nested cloud data', async () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"results":[{"reason":"Lab","api_key":"hidden","message":"' + TOKEN + '"}]}');
    value[TOKEN] = 'Credential echoed as a property name';
    Object.assign(value.results[0], { psk: 'hidden', psk_name: 'hidden', community: 'hidden', shared_key: 'hidden', private_key: 'hidden', auth_key: 'hidden' });
    const clean = safeClone(value, TOKEN);
    assert.equal(Object.getPrototypeOf(clean), null);
    assert.ok(!Object.hasOwn(clean, '__proto__'));
    assert.ok(!Object.hasOwn(clean, 'constructor'));
    assert.ok(!Object.hasOwn(clean.results[0], 'api_key'));
    assert.ok(!Object.hasOwn(clean, TOKEN));
    for (const key of ['psk', 'psk_name', 'community', 'shared_key', 'private_key', 'auth_key']) assert.ok(!Object.hasOwn(clean.results[0], key));
    assert.equal(clean.results[0].message, '[Redacted]');
    const nested = {}; let current = nested;
    for (let index = 0; index < 30; index++) { current.child = {}; current = current.child; }
    assert.ok(JSON.stringify(safeClone(nested)).includes('[Truncated]'));
  });

  await test('Mist labels large Marvis responses and privilege discovery as incomplete', async () => {
    const transport = mockTransport(({ options, respond }) => {
      if (options.path === '/api/v1/self') return respond(200, { privileges: Array.from({ length: 201 }, () => ({ scope: 'org', org_id: ORG, name: 'Lab', role: 'read' })) });
      respond(200, { results: Array.from({ length: 501 }, () => ({ text: 'Recommendation' })), description: 'x'.repeat(10001) });
    });
    await withClient(async (client) => {
      client.configure({ token: TOKEN });
      const report = await client.request('marvis', { orgId: ORG, siteId: SITE });
      assert.equal(report.limited, true);
      assert.equal(report.data.results.length, 500);
      assert.equal(report.data.description.length, 10000);
      assert.ok(report.limitations.some((entry) => /response truncated/.test(entry)));
      const self = await client.request('self');
      assert.equal(self.limited, true);
      assert.ok(self.limitations.some((entry) => /discovery was limited/.test(entry)));
    }, transport);
  });
}

module.exports = { runMistTests };

if (require.main === module) {
  let passed = 0;
  runMistTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); })
    .then(() => console.log(`${passed} Mist tests passed`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
