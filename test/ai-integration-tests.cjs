'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function runAiIntegrationTests(test) {
  await test('AI IPC keeps keys in the provider, cancels obsolete jobs, and exposes the offline library independently', async () => {
    const filename = path.join(__dirname, '../src/main/main.js');
    const load = createRequire(filename), handlers = new Map(), appEvents = new Map(), events = [];
    let stops = 0, closed = 0, quit = 0;
    const calls = [], key = 'Synthetic_Key_Never_Leave_The_Main_Process';
    const client = {
      getConfig: () => ({ provider: 'nyquest', model: 'nyquest/auto', revision: 'r1', hasKey: true }),
      configure: (input) => { calls.push(input); return client.getConfig(); },
      preview: (context) => ({ context: context.replaceAll(key, '[Redacted]') }),
      run: (_params, _emit, signal) => new Promise((resolve) => { signal.onStop = () => { stops++; resolve(); }; }),
    };
    const article = { id: 'builtin-wifi', title: 'Wi-Fi evidence', sourceUrl: 'https://learn.microsoft.com/' };
    const library = {
      status: async () => ({ state: 'ready', documents: 30 }), list: async () => [article], get: async () => article,
      save: async (input) => ({ ...input, id: 'custom-1' }), remove: async (id) => ({ removed: true, id }), rebuild: async () => ({ state: 'ready' }),
      close: () => { closed++; },
    };
    const context = {
      process, Buffer, URL, console, setTimeout, clearTimeout, client, library, receive: (...args) => events.push(args),
      require(name) {
        if (name === 'electron') return { app: { whenReady: () => ({ then() {} }), on: (name, callback) => appEvents.set(name, callback), quit: () => quit++ },
          shell: { openExternal: async (url) => calls.push(url) }, ipcMain: { handle: (name, callback) => handlers.set(name, callback), on() {} } };
        if (['./workspace-windows', './site-workspace-ipc', './topology-ipc', './events-ipc', './change-validation-ipc'].includes(name)) return load(name);
        if (name.startsWith('./')) return {};
        return load(name);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nwin={isDestroyed:()=>false,webContents:{send:receive,mainFrame:{}}}; globalThis.ipcEvent={sender:win.webContents,senderFrame:win.webContents.mainFrame}; ai=client; knowledge=library; registerIpc();', context, { filename });
    const invoke = (name, ...args) => handlers.get(name)(context.ipcEvent, ...args);
    assert.equal((await invoke('tools:knowledgeStatus')).documents, 30);
    assert.equal((await invoke('tools:knowledgeList', {}))[0].id, article.id);
    assert.equal((await invoke('tools:knowledgeGet', article.id)).title, article.title);
    assert.equal((await invoke('tools:aiPreview', { context: key })).context, '[Redacted]');
    await invoke('tools:start', 'ai', { question: 'Explain RSSI' }, 'ai-1');
    await new Promise((resolve) => setImmediate(resolve));
    const config = await invoke('tools:aiConfigure', { provider: 'nyquest', key });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stops, 1);
    assert.equal(config.hasKey, true);
    assert.ok(!JSON.stringify(config).includes(key));
    assert.ok(!JSON.stringify(await invoke('tools:aiConfig')).includes(key));
    assert.equal(calls[0].key, key);
    await invoke('tools:knowledgeOpenSource', article.id);
    assert.equal(calls[1], article.sourceUrl);
    article.sourceUrl = 'https://username:password@example.invalid/';
    await assert.rejects(invoke('tools:knowledgeOpenSource', article.id), /without embedded credentials/);
    article.sourceUrl = 'file:///C:/private';
    await assert.rejects(invoke('tools:knowledgeOpenSource', article.id), /HTTPS/);
    await invoke('tools:start', 'ai', { question: 'Explain TLS' }, 'ai-2');
    await new Promise((resolve) => setImmediate(resolve));
    appEvents.get('window-all-closed')();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stops, 2); assert.equal(closed, 1); assert.equal(quit, 1);
    assert.ok(!JSON.stringify(events).includes(key));
  });

  await test('explain-tool context excludes credentials and packet bytes while retaining useful result evidence', async () => {
    const { toolContext } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/renderer/js/tool-context.mjs')).href);
    const report = { kind: 'mist', data: [{ channel: 36, rssi: -67, password: 'synthetic-password', token: 'synthetic-token', bytes: new Uint8Array([1, 2]) }], limitations: ['Cached observations'] };
    const text = toolContext({ title: 'Mist', report });
    assert.match(text, /channel/); assert.match(text, /Cached observations/);
    assert.ok(!text.includes('synthetic-')); assert.ok(!text.includes('"bytes"'));
    const capture = toolContext({ title: 'Capture', kind: 'capture', packets: [{ data: 'DO_NOT_COLLECT' }], statsEl: { innerText: '10 packets' }, sideBody: { innerText: 'Retransmissions observed' } });
    assert.match(capture, /Retransmissions/); assert.ok(!capture.includes('DO_NOT_COLLECT'));
    const long = toolContext({ title: 'DNS', el: { innerText: 'x'.repeat(50000), password: { value: 'never' } } });
    assert.ok(long.length < 24000); assert.match(long, /Context truncated/);
  });
}
module.exports = { runAiIntegrationTests };
