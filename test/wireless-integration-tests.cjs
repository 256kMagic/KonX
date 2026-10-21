'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function runWirelessIntegrationTests(test) {
  await test('wireless main IPC keeps credentials in the Mist client and cancels jobs on application shutdown', async () => {
    const filename = path.join(__dirname, '../src/main/main.js');
    const load = createRequire(filename), handlers = new Map(), appEvents = new Map(), calls = [], events = [];
    let stopCalls = 0, quitCalls = 0;
    const secret = 'synthetic-api-token-for-ipc-test';
    const client = { getConfig: () => ({ region: 'global01', hasToken: true }), configure: (value) => { calls.push(value); return { region: value.region, hasToken: !!value.token }; },
      run: (_params, _emit, signal) => new Promise((resolve) => { signal.onStop = () => { stopCalls++; resolve(); }; }) };
    const context = {
      process, Buffer, console, setTimeout, clearTimeout,
      receive: (...args) => events.push(args), client,
      require(name) {
        if (name === 'electron') return { app: { whenReady: () => ({ then() {} }), on: (name, callback) => appEvents.set(name, callback), quit: () => quitCalls++ },
          ipcMain: { handle: (name, callback) => handlers.set(name, callback), on() {} } };
        if (name === './wifi') return { run: client.run };
        if (name.startsWith('./')) return {};
        return load(name);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nwin={isDestroyed:()=>false,webContents:{send:receive}}; mist=client; registerIpc();', context, { filename });
    const config = await handlers.get('tools:mistConfigure')({}, { region: 'global01', token: secret });
    assert.equal(config.hasToken, true);
    assert.equal(calls[0].token, secret);
    assert.ok(!JSON.stringify(config).includes(secret));
    assert.ok(!JSON.stringify(await handlers.get('tools:mistConfig')({})).includes(secret));
    await handlers.get('tools:start')({}, 'wifi', { action: 'survey' }, 'wifi-fixture');
    await handlers.get('tools:start')({}, 'mist', { action: 'self' }, 'mist-fixture');
    await new Promise((resolve) => setImmediate(resolve));
    appEvents.get('window-all-closed')();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopCalls, 2); assert.equal(quitCalls, 1);
    assert.equal(events.filter((item) => item[2] === 'done' && item[3].stopped === true).length, 2);
    assert.ok(!JSON.stringify(events).includes(secret));
  });
}
module.exports = { runWirelessIntegrationTests };
