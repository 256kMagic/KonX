'use strict';

const assert = require('node:assert/strict');
const { mainLifecycleFixture, deferred, tick } = require('./update-lifecycle-tests.cjs');

async function runSerialLifecycleTests(test) {
  await test('Serial main lifecycle blocks an updater while native cleanup remains owned after tab removal', async () => {
    const f = mainLifecycleFixture();
    f.connections.hasSerialOwnership = true;
    assert.equal(f.connections.conns.size, 0);
    await assert.rejects(f.invoke('app:updateInstall'), /Serial ports are still in use/);
    assert.equal(f.calls.includes('verify-update'), false);
    assert.equal(f.calls.includes('launch-helper'), false);
  });

  await test('Serial main lifecycle Cancel preserves active connections before any quit cleanup starts', async () => {
    for (const native of [false, true]) {
      const f = mainLifecycleFixture();
      f.connections.hasSerialOwnership = true;
      f.connections.conns.set('serial', { protocol: 'serial' });
      f.setPromptChoice(1);
      if (native) assert.equal(f.nativeClose().defaultPrevented, true); else f.app.quit();
      await tick();
      assert.equal(f.window.destroyed, false);
      assert.equal(f.app.exited, false);
      assert.equal(f.connections.conns.size, 1);
      assert.equal(f.connections.hasSerialOwnership, true);
      assert.deepEqual(f.calls, ['connection-prompt']);
      assert.equal((await f.invoke('conn:open', 'allowed-after-cancel', { protocol: 'serial' })).ok, true);
    }
  });

  await test('Serial main lifecycle approved quit awaits cleanup, blocks new connections and prompts only once', async () => {
    const f = mainLifecycleFixture(), cleanup = deferred();
    f.connections.hasSerialOwnership = true;
    f.connections.conns.set('serial', { protocol: 'serial' });
    f.connections.conns.set('ssh', { protocol: 'ssh' });
    f.connections.waitForSerialCleanup = async () => {
      f.calls.push('close-serial');
      await cleanup.promise;
      f.connections.hasSerialOwnership = false;
      f.connections.conns.delete('serial');
    };
    f.app.quit(); await tick(); f.app.quit();
    assert.equal(f.app.exited, false);
    assert.equal(f.window.destroyed, false);
    assert.equal(f.calls.filter(call => call === 'connection-prompt').length, 1);
    assert.equal(f.calls.filter(call => call === 'close-serial').length, 1);
    for (const protocol of ['serial', 'ssh', 'raw']) await assert.rejects(async () => f.invoke('conn:open', protocol, { protocol }), /KonX is closing/);
    assert.equal(f.calls.includes('open-connection'), false);
    cleanup.resolve(); await tick();
    assert.equal(f.app.exited, true);
    assert.equal(f.window.destroyed, true);
    assert.equal(f.calls.filter(call => call === 'connection-prompt').length, 1, 'initial approval also covered the remaining SSH connection');
  });

  await test('Serial main lifecycle native-close cleanup failure retains the window and ownership for retry', async () => {
    const f = mainLifecycleFixture();
    f.connections.hasSerialOwnership = true;
    f.connections.conns.set('serial', { protocol: 'serial' });
    let attempts = 0;
    f.connections.waitForSerialCleanup = async () => {
      f.calls.push('close-serial'); f.connections.conns.clear();
      if (++attempts === 1) throw new Error('Synthetic serial native close timeout');
      f.connections.hasSerialOwnership = false;
    };
    assert.equal(f.nativeClose().defaultPrevented, true);
    await tick();
    assert.equal(f.app.exited, false);
    assert.equal(f.window.destroyed, false);
    assert.equal(f.connections.hasSerialOwnership, true);
    assert.equal(f.calls.filter(call => call === 'shutdown-error').length, 1);
    await assert.rejects(f.invoke('app:updateInstall'), /Serial ports are still in use/);
    f.app.quit(); await tick();
    assert.equal(attempts, 2);
    assert.equal(f.connections.hasSerialOwnership, false);
    assert.equal(f.app.exited, true);
    assert.equal(f.calls.filter(call => call === 'connection-prompt').length, 1, 'no active tab remains to confirm again');
  });

  await test('Serial main lifecycle a committed updater still waits for retained native ownership', async () => {
    const f = mainLifecycleFixture(), cleanup = deferred();
    await f.invoke('app:updateInstall');
    assert.equal(f.controller.committed, true);
    f.connections.hasSerialOwnership = true;
    f.connections.waitForSerialCleanup = async () => { f.calls.push('close-serial'); await cleanup.promise; f.connections.hasSerialOwnership = false; };
    await tick();
    assert.equal(f.app.exited, false);
    assert.equal(f.window.destroyed, false);
    assert.equal(f.calls.filter(call => call === 'close-serial').length, 1);
    cleanup.resolve(); await tick();
    assert.equal(f.app.exited, true);
    assert.equal(f.calls.filter(call => call === 'commit-helper').length, 1);
    assert.equal(f.calls.includes('cancel-helper'), false);
  });
}

module.exports = { runSerialLifecycleTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runSerialLifecycleTests(async (name, fn) => {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name, error); }
  });
  console.log(`${passed}/${passed + failed} serial main lifecycle tests passed`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
