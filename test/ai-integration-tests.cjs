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
        if (['./workspace-windows', './site-workspace-ipc', './topology-ipc', './events-ipc', './change-validation-ipc', './copilot-ipc'].includes(name)) return load(name);
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
    assert.ok(long.length > 24000 && Buffer.byteLength(long) < 256 * 1024, 'Keep the complete bounded source for main-process redaction');
    assert.ok(long.endsWith('x'.repeat(50000)));
  });

  await test('explain-tool context reports whole-field, label, array, property, node, depth and serialization omissions without slicing raw evidence', async () => {
    const { toolContext, MAX_CONTEXT_INPUT_BYTES } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/renderer/js/tool-context.mjs')).href);
    const whole = 'UNIQUE_WHOLE_FIELD_' + 'x'.repeat(64 * 1024), title = 'UNIQUE_WHOLE_LABEL_' + 'x'.repeat(4096);
    const field = toolContext({ title, report: { oversized: whole, retained: 'Retained observation', multibyte: '測'.repeat(22000) } });
    assert.match(field, /Coverage: partial/); assert.match(field, /whole field exceeds 64 KiB/); assert.match(field, /whole tool label/);
    assert.ok(!field.includes('UNIQUE_WHOLE')); assert.ok(!field.includes('測')); assert.match(field, /Retained observation/);
    const labels = toolContext({ title: 'Labels', report: { ['x'.repeat(513)]: 'UNEXAMINED_LABEL_VALUE', safe: true } });
    assert.match(labels, /whole property label/); assert.ok(!labels.includes('UNEXAMINED_LABEL_VALUE'));
    const array = toolContext({ title: 'Array', report: { rows: Array.from({ length: 101 }, (_, i) => 'row-' + i) } });
    assert.match(array, /array limit/); assert.ok(array.includes('row-99')); assert.ok(!array.includes('row-100'));
    const properties = toolContext({ title: 'Properties', report: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['entry' + i, i])) });
    assert.match(properties, /property limit/); assert.ok(!properties.includes('entry100'));
    const nodes = toolContext({ title: 'Nodes', report: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => true)) });
    assert.match(nodes, /node limit/);
    let deep = { value: 'UNEXAMINED_DEEP_VALUE' }; for (let i = 0; i < 10; i++) deep = { child: deep };
    const depth = toolContext({ title: 'Depth', report: deep }); assert.match(depth, /depth limit/); assert.ok(!depth.includes('UNEXAMINED_DEEP_VALUE'));
    const cyclic = {}; cyclic.self = cyclic; assert.match(toolContext({ title: 'Cycle', report: cyclic }), /cyclic value/);
    const aggregate = toolContext({ title: 'Aggregate', report: Array.from({ length: 100 }, (_, i) => ({ value: String(i).padStart(3, '0') + 'x'.repeat(60000) })) });
    assert.match(aggregate, /serialized output limit/); assert.ok(Buffer.byteLength(aggregate) <= MAX_CONTEXT_INPUT_BYTES);
    const expanded = toolContext({ title: 'Escaping', report: { value: '\u0001'.repeat(64000), retained: true } });
    assert.match(expanded, /serialized output limit/); assert.ok(Buffer.byteLength(expanded) <= MAX_CONTEXT_INPUT_BYTES);
    const device = toolContext({ title: 'Device', toolKind: 'device', report: { devices: [{ host: '192.0.2.1', commands: [{ output: 'NEVER_INCLUDE_TRANSCRIPT' }] }] } });
    assert.match(device, /192\.0\.2\.1/); assert.ok(!device.includes('NEVER_INCLUDE_TRANSCRIPT')); assert.match(device, /device transcripts excluded/);
    const summary = toolContext({ title: 'Events', toolKind: 'events', report: { data: 'NEVER_INCLUDE_FULL_REPORT' }, aiContext: { kind: 'counts', received: 4 } });
    assert.match(summary, /counts/); assert.ok(!summary.includes('NEVER_INCLUDE_FULL_REPORT'));
  });
}
module.exports = { runAiIntegrationTests };
