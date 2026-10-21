'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { UpdateManager } = require('../src/main/updater');

const API_PATH = '/repos/256kMagic/KonX/releases';
const BODY = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(130000, 42)]);
const HASH = crypto.createHash('sha256').update(BODY).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(mode = 'installed', version = '0.6.0') {
  const name = mode === 'installed' ? `KonX-Setup-${version}.exe` : `KonX-${version}-portable.exe`;
  const manifest = Buffer.from(`${HASH}  ${name}\r\n`);
  const asset = (id, filename, size) => ({ id, name: filename, state: 'uploaded', size,
    browser_download_url: `https://github.com/256kMagic/KonX/releases/download/v${version}/${filename}` });
  return { name, manifest, body: BODY, release: { tag_name: `v${version}`, published_at: '2025-01-01T00:00:00Z', draft: false, prerelease: false,
    assets: [asset(101, 'SHA256SUMS.txt', manifest.length), asset(102, name, BODY.length)] } };
}
function transport(handler) {
  const calls = [];
  const request = (options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    const respond = (status, value, headers = {}) => {
      const res = value instanceof Readable ? value : Readable.from([Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);
      res.statusCode = status; res.headers = headers;
      callback(res);
      return res;
    };
    const call = { options, req, respond }; calls.push(call);
    req.end = () => queueMicrotask(() => handler(call));
    return req;
  };
  request.calls = calls;
  return request;
}
function serve(data, override) {
  return transport((call) => {
    if (override?.(call)) return;
    if (call.options.path === `${API_PATH}/latest`) call.respond(200, data.release);
    else if (call.options.path === `${API_PATH}/assets/101`) call.respond(200, data.manifest, { 'content-length': String(data.manifest.length) });
    else if (call.options.path === `${API_PATH}/assets/102`) call.respond(200, data.body, { 'content-length': String(data.release.assets[1].size) });
    else throw new Error('Unexpected synthetic URL: ' + call.options.path);
  });
}
async function withManager(fn, options = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'konx-updater-test-'));
  const states = [];
  const manager = new UpdateManager({ version: '0.5.0', mode: 'installed', cacheDir: dir,
    request: () => { throw new Error('No live network requests are permitted'); }, onState: (state) => states.push(state), ...options });
  try { await fn(manager, dir, states); }
  finally {
    await manager.cancel();
    assert.equal(path.dirname(path.resolve(dir)), parent);
    assert.ok(path.basename(dir).startsWith('konx-updater-test-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function runUpdaterTests(test) {
  await test('updater starts locally, coalesces checks, verifies installed and portable assets, and exposes no download paths', async () => {
    for (const mode of ['installed', 'portable']) {
      const data = fixture(mode), request = serve(data);
      await withManager(async (manager, dir, states) => {
        assert.equal(manager.snapshot().status, 'idle'); assert.equal(request.calls.length, 0);
        const first = manager.start(), duplicate = manager.start();
        assert.equal(first, duplicate);
        const result = await first;
        assert.equal(result.status, 'ready', JSON.stringify(result));
        assert.equal(result.version, '0.6.0'); assert.equal(result.currentVersion, '0.5.0');
        const ready = await manager.getReady();
        assert.deepEqual({ ...ready, file: path.basename(ready.file) }, { file: data.name, sha256: HASH, size: BODY.length, version: '0.6.0', mode });
        assert.equal(path.dirname(path.dirname(ready.file)), dir);
        assert.deepEqual(fs.readFileSync(ready.file), BODY);
        assert.ok(states.some((state) => state.status === 'downloading'));
        assert.ok(states.some((state) => state.status === 'verifying'));
        assert.ok(!JSON.stringify(states).includes(dir)); assert.ok(!JSON.stringify(states).includes('https:'));
        assert.equal(request.calls.length, 3);
        for (const { options } of request.calls) {
          assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, 'api.github.com');
          assert.equal(options.rejectUnauthorized, true); assert.equal(options.method, 'GET');
          assert.equal(options.headers.Authorization, undefined);
        }
        assert.equal(request.calls[1].options.headers.Accept, 'application/octet-stream');
        await manager.start(); assert.equal(request.calls.length, 3);
      }, { mode, request });
    }
  });

  await test('updater refuses downgrades, equal versions, prereleases, malformed tags and unpublished releases', async () => {
    for (const version of ['0.4.99', '0.5.0']) {
      const data = fixture('installed', version), request = serve(data);
      await withManager(async (manager) => {
        assert.equal((await manager.start()).status, 'current'); assert.equal(request.calls.length, 1);
      }, { request });
    }
    for (const change of [{ draft: true }, { prerelease: true }, { published_at: null }, { published_at: '2999-01-01T00:00:00Z' }, { tag_name: 'v0.6.0-beta.1' }, { tag_name: 'v00.6.0' }, { tag_name: 'v0.6.0+build' }]) {
      const data = fixture(); Object.assign(data.release, change); const request = serve(data);
      await withManager(async (manager, dir) => {
        assert.equal((await manager.start()).status, 'error'); assert.equal(request.calls.length, 1); assert.deepEqual(fs.readdirSync(dir), []);
      }, { request });
    }
    const data = fixture('installed', '0.10.0');
    await withManager(async (manager) => assert.equal((await manager.start()).status, 'ready'), { request: serve(data), version: '0.9.9' });
  });

  await test('updater validates unique asset identities, upload state, exact tagged URLs, and sizes before downloading', async () => {
    const changes = [
      (data) => { data.release.assets.push({ ...data.release.assets[1] }); },
      (data) => { data.release.assets[1].browser_download_url = 'https://github.com/other/project/releases/download/v0.6.0/' + data.name; },
      (data) => { data.release.assets[1].browser_download_url = 'https://github.com/256kMagic/KonX/releases/latest/download/' + data.name; },
      (data) => { data.release.assets[1].state = 'new'; },
      (data) => { data.release.assets[1].id = '../other'; },
      (data) => { data.release.assets[1].size = 512 * 1024 * 1024 + 1; },
      (data) => { data.release.assets[0].size = 64 * 1024 + 1; },
      (data) => { data.release.assets = []; },
    ];
    for (const change of changes) {
      const data = fixture(); change(data); const request = serve(data);
      await withManager(async (manager) => { assert.equal((await manager.start()).status, 'error'); assert.equal(request.calls.length, 1); }, { request });
    }
  });

  await test('updater accepts GitHub asset redirects and refuses foreign, insecure, credentialed, or looping redirects', async () => {
    const data = fixture();
    const request = serve(data, ({ options, respond }) => {
      if (options.path === `${API_PATH}/assets/102`) { respond(302, '', { location: 'https://release-assets.githubusercontent.com/asset/test?signature=synthetic' }); return true; }
      if (options.hostname === 'release-assets.githubusercontent.com') { respond(200, BODY); return true; }
      return false;
    });
    await withManager(async (manager) => assert.equal((await manager.start()).status, 'ready'), { request });
    for (const location of ['https://evil.example/update.exe', 'http://github.com/update.exe', 'https://github.com.evil.example/update.exe', 'https://user:pass@github.com/update.exe', 'https://github.com:444/update.exe', 'https://api.github.com/loop']) {
      const blocked = transport(({ respond }) => respond(302, '', { location }));
      await withManager(async (manager) => {
        assert.equal((await manager.start()).status, 'error'); assert.ok(blocked.calls.length <= 6);
        assert.ok(blocked.calls.every(({ options }) => options.hostname === 'api.github.com'));
      }, { request: blocked });
    }
  });

  await test('updater bounds metadata and manifest responses and rejects invalid JSON or checksum records', async () => {
    for (const body of ['not JSON', 'x'.repeat(1024 * 1024 + 1)]) {
      await withManager(async (manager) => assert.equal((await manager.start()).status, 'error'), { request: transport(({ respond }) => respond(200, body)) });
    }
    for (const manifest of ['bad manifest', `${HASH}  other.exe\n`, `${HASH}  KonX-Setup-0.6.0.exe\n${HASH}  KonX-Setup-0.6.0.exe\n`]) {
      const data = fixture(); data.manifest = Buffer.from(manifest); data.release.assets[0].size = data.manifest.length;
      const request = serve(data);
      await withManager(async (manager, dir) => { assert.equal((await manager.start()).status, 'error'); assert.equal(request.calls.length, 2); assert.deepEqual(fs.readdirSync(dir), []); }, { request });
    }
  });

  await test('updater removes failed downloads, supports explicit retry, and rechecks files before installation', async () => {
    const data = fixture(); data.body = Buffer.alloc(BODY.length, 43);
    await withManager(async (manager, dir) => {
      const failed = await manager.start(); assert.equal(failed.status, 'error'); assert.match(failed.message, /checksum/); assert.deepEqual(fs.readdirSync(dir), []);
      data.body = BODY;
      assert.equal((await manager.start()).status, 'ready');
      const ready = await manager.getReady();
      fs.writeFileSync(ready.file, Buffer.alloc(BODY.length, 44));
      await assert.rejects(manager.getReady(), /checksum/);
      assert.equal(manager.snapshot().status, 'error'); assert.deepEqual(fs.readdirSync(dir), []);
      assert.equal((await manager.start()).status, 'ready');
    }, { request: serve(data) });
  });

  await test('updater rejects short, oversized, encoded and interrupted executable responses and cleans partial files', async () => {
    for (const variant of ['short', 'long', 'encoding', 'content-length', 'interrupted']) {
      const data = fixture();
      const request = serve(data, ({ options, respond }) => {
        if (options.path !== `${API_PATH}/assets/102`) return false;
        if (variant === 'short') respond(200, BODY.subarray(0, BODY.length - 1));
        if (variant === 'long') respond(200, Buffer.concat([BODY, Buffer.from('x')]));
        if (variant === 'encoding') respond(200, BODY, { 'content-encoding': 'gzip' });
        if (variant === 'content-length') respond(200, BODY, { 'content-length': String(BODY.length + 1) });
        if (variant === 'interrupted') {
          const res = new PassThrough(); respond(200, res); res.write(BODY.subarray(0, 200)); setImmediate(() => res.destroy(new Error('Synthetic interruption')));
        }
        return true;
      });
      await withManager(async (manager, dir) => { assert.equal((await manager.start()).status, 'error'); assert.deepEqual(fs.readdirSync(dir), []); }, { request });
    }
  });

  await test('updater cancellation owns pending headers, streaming download and late responses without publishing ready', async () => {
    for (const phase of ['headers', 'download', 'verifying']) {
      const data = fixture(); let delayed, response, managerRef;
      const request = serve(data, (call) => {
        if (phase === 'headers' && call.options.path === `${API_PATH}/latest`) { delayed = call; return true; }
        if (phase === 'download' && call.options.path === `${API_PATH}/assets/102`) {
          delayed = call; response = new PassThrough(); call.respond(200, response); response.write(BODY.subarray(0, 50)); return true;
        }
        return false;
      });
      await withManager(async (manager, dir, states) => {
        managerRef = manager;
        const running = manager.start();
        if (phase !== 'verifying') { while (!delayed) await tick(); await manager.cancel(); }
        assert.equal((await running).status, 'cancelled', phase);
        assert.deepEqual(fs.readdirSync(dir), []); assert.ok(!states.some((state) => state.status === 'ready'));
        if (phase === 'headers') { const late = delayed.respond(200, data.release); await tick(); assert.equal(late.destroyed, true); }
        if (response) assert.equal(response.destroyed, true);
      }, { request, ...(phase === 'verifying' ? { onState: (state) => { if (state.status === 'verifying') void managerRef.cancel(); } } : {}) });
    }
  });

  await test('updater retains failed cleanup ownership for retry and never removes unrelated files', async () => {
    const data = fixture(); data.body = Buffer.alloc(BODY.length, 43);
    await withManager(async (manager, dir) => {
      const unrelated = path.join(dir, 'keep.txt'); fs.writeFileSync(unrelated, 'keep');
      const unlink = fs.promises.unlink;
      fs.promises.unlink = async (file) => {
        if (path.basename(file) === 'download.part') { const error = new Error('Synthetic locked file'); error.code = 'EPERM'; throw error; }
        return unlink(file);
      };
      try { assert.match((await manager.start()).message, /could not be removed/); }
      finally { fs.promises.unlink = unlink; }
      assert.equal(fs.readdirSync(dir).length, 2);
      data.body = BODY;
      assert.equal((await manager.start()).status, 'ready');
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
      await manager.cancel(); assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
    }, { request: serve(data) });
  });

  await test('updater serializes cancellation during final cleanup before allowing another download', async () => {
    const data = fixture(); data.body = Buffer.alloc(BODY.length, 43);
    await withManager(async (manager, dir) => {
      const unlink = fs.promises.unlink;
      let release, entered = false;
      const gate = new Promise((resolve) => { release = resolve; });
      fs.promises.unlink = async (file) => {
        if (path.basename(file) === 'download.part' && !entered) { entered = true; await gate; }
        return unlink(file);
      };
      try {
        const running = manager.start();
        while (!entered) await tick();
        const stopping = manager.cancel();
        assert.equal(manager.start(), stopping);
        await assert.rejects(manager.getReady(), /still running/);
        release();
        assert.equal((await running).status, 'cancelled');
        assert.equal((await stopping).status, 'cancelled');
      } finally { release(); fs.promises.unlink = unlink; }
      assert.deepEqual(fs.readdirSync(dir), []);
      data.body = BODY;
      assert.equal((await manager.start()).status, 'ready');
    }, { request: serve(data) });
  });

  await test('updater cleanup refuses a substituted temporary directory and preserves the destination files', async () => {
    await withManager(async (manager, dir) => {
      assert.equal((await manager.start()).status, 'ready');
      const ready = await manager.getReady();
      const owned = path.dirname(ready.file), moved = owned + '-moved', outside = path.join(dir, 'outside');
      assert.equal(path.dirname(owned), dir); assert.equal(path.dirname(moved), dir); assert.equal(path.dirname(outside), dir);
      fs.mkdirSync(outside);
      const protectedFile = path.join(outside, path.basename(ready.file)); fs.writeFileSync(protectedFile, 'keep');
      fs.renameSync(owned, moved);
      let linked = false;
      try {
        fs.symlinkSync(outside, owned, process.platform === 'win32' ? 'junction' : 'dir'); linked = true;
        assert.equal((await manager.cancel()).status, 'error');
        assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep');
      } finally {
        if (linked) fs.unlinkSync(owned);
        fs.renameSync(moved, owned);
      }
      assert.equal((await manager.cancel()).status, 'cancelled');
      assert.deepEqual(fs.readdirSync(dir), ['outside']);
    }, { request: serve(fixture()) });
  });

  await test('updater unsupported environments do not contact GitHub', async () => {
    await withManager(async (manager) => {
      assert.equal(manager.snapshot().supported, false);
      assert.equal((await manager.start()).status, 'error');
      await assert.rejects(manager.getReady(), /Download and verify/);
    }, { mode: 'unsupported', reason: 'Development builds are not updatable.' });
  });
}

module.exports = { runUpdaterTests };
if (require.main === module) {
  let passed = 0;
  runUpdaterTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); })
    .then(() => console.log(`${passed} updater tests passed`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
