'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Exercise the real main IPC handlers and renderer job routing together. An IPC
// event is allowed to reach the renderer before its invocation promise resolves.
function tools(runner, replyGate) {
  const jobs = new Map(), handlers = new Map(), messages = [], events = [], calls = [];
  const filename = path.join(__dirname, '../src/main/main.js');
  const localRequire = createRequire(filename);
  const nettools = { pingMonitor: runner, sweep: runner, portScan: runner, traceroute: runner };
  const context = {
    process, Buffer, console, setTimeout, clearTimeout,
    receive(channel, id, type, data) {
      if (channel !== 'tools:event') return;
      const tab = jobs.get(id);
      if (tab) tab.onJobEvent(type, data);
    },
    require(name) {
      if (name === 'electron') return {
        app: { whenReady: () => ({ then() {} }), on() {} },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
      };
      if (name === './nettools') return nettools;
      if (['./workspace-windows', './site-workspace-ipc', './topology-ipc'].includes(name)) return localRequire(name);
      if (name.startsWith('./')) return {};
      return localRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    win = { isDestroyed: () => false, webContents: { send: receive, mainFrame: {} } };
    globalThis.ipcEvent = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    registerIpc();
  `, context, { filename });

  const api = { async invoke(channel, ...args) {
    calls.push([channel, ...args]);
    const answer = await handlers.get(channel)(context.ipcEvent, ...args);
    if (channel === 'tools:start' && replyGate) await replyGate.promise;
    return answer;
  } };
  const renderer = path.join(__dirname, '../src/renderer/js/tools.js');
  const source = fs.readFileSync(renderer, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports = { ToolView, PingTool, SweepTool, PortScanTool, TraceTool };', {
    module, api, CaptureTab: class {}, h: (tag, ...children) => ({ tag, children }),
    toast: (message) => messages.push(message), errMsg: (error) => error.message,
  }, { filename: renderer });
  const app = {
    registerJob: (id, tab) => jobs.set(id, tab),
    unregisterJob: (id) => jobs.delete(id), tabStateChanged() {}, setTabTitle() {},
  };
  const tab = new module.exports.ToolView(app, { kind: 'ping', label: 'Ping', icon: 'activity' });
  tab.onEvent = (type, data) => events.push([type, data]);
  return { tab, jobs, messages, events, calls, api, classes: module.exports };
}

async function runToolReviewRegressionTests(test) {
  console.log('network tools: lifecycle and large scans');
  await test('tool validation errors arriving before the start reply leave the tab idle', async () => {
    const { tab, jobs, messages } = tools(() => { throw new Error('No targets'); });
    await tab.runJob('sweep', {});
    await turn();
    assert.equal(tab.state, 'idle');
    assert.equal(tab.jobId, null);
    assert.equal(jobs.size, 0);
    assert.deepEqual(messages, ['No targets']);
  });

  await test('short tool results and completion are delivered before the IPC reply', async () => {
    const { tab, jobs, events } = tools((_params, emit) => emit('result', { host: '127.0.0.1' }));
    await tab.runJob('ping', {});
    await turn();
    assert.equal(events[0][0], 'result');
    assert.equal(events[0][1].host, '127.0.0.1');
    assert.equal(events.at(-1)[0], 'done');
    assert.equal(tab.state, 'idle');
    assert.equal(jobs.size, 0);
  });

  await test('closing a tool while its start reply is pending cancels the actual job', async () => {
    const gate = deferred();
    let stopped = false;
    const { tab, jobs } = tools((_params, _emit, signal) => new Promise((resolve) => {
      signal.onStop = () => { stopped = true; resolve(); };
    }), gate);
    const starting = tab.runJob('ping', {});
    await turn();
    tab.dispose();
    gate.resolve();
    await starting;
    await turn();
    assert.equal(stopped, true);
    assert.equal(tab.jobId, null);
    assert.equal(jobs.size, 0);
  });

  await test('a rejected tool start unregisters the job and allows a retry', async () => {
    const { tab, jobs, messages } = tools(() => {});
    await tab.runJob('unknown', {});
    assert.equal(tab.state, 'idle');
    assert.equal(tab.jobId, null);
    assert.equal(jobs.size, 0);
    assert.match(messages[0], /Unknown tool/);
    await tab.runJob('ping', {});
    await turn();
    assert.equal(tab.state, 'idle');
    assert.equal(jobs.size, 0);
  });

  await test('repeated starts while a tool reply is pending do not create duplicate jobs', async () => {
    const gate = deferred();
    const { tab, calls } = tools((_p, _e, signal) => new Promise((resolve) => { signal.onStop = resolve; }), gate);
    const first = tab.runJob('ping', {});
    const second = tab.runJob('ping', {});
    await turn();
    assert.equal(calls.filter(([channel]) => channel === 'tools:start').length, 1);
    tab.dispose();
    gate.resolve();
    await Promise.all([first, second]);
  });

  await test('Enter or deferred autostart cannot reset an active or closed tool', async () => {
    const { classes } = tools(() => {});
    for (const name of ['PingTool', 'SweepTool', 'PortScanTool', 'TraceTool']) {
      for (const state of [{ jobId: 'running', disposed: false }, { jobId: null, disposed: true }]) {
        const tab = Object.assign(Object.create(classes[name].prototype), state);
        // No inputs/results are accessible: an ignored start must leave them
        // untouched rather than resetting the current job's display or targets.
        await tab.start();
        assert.equal(tab.jobId, state.jobId);
      }
    }
  });

  await test('a traceroute finishing before its IPC reply keeps its completed summary', async () => {
    const { tab, classes } = tools(() => {});
    Object.setPrototypeOf(tab, classes.TraceTool.prototype);
    delete tab.onEvent;
    const summaries = [];
    Object.assign(tab, {
      host: { value: '127.0.0.1' }, maxHops: { value: 1 }, timeout: { value: 100 }, names: { checked: false },
      table: { setRows() {} }, log: { replaceChildren() {} },
      summary: { replaceChildren(...nodes) { summaries.push(JSON.stringify(nodes)); } },
    });
    await tab.start();
    await turn();
    assert.match(summaries[0], /Tracing route/);
    assert.match(summaries.at(-1), /Complete/);
    assert.doesNotMatch(summaries.at(-1), /Tracing route/);
  });

  await test('a subnet scan of all ports starts and cancels with bounded memory', () => {
    // A separate bounded process prevents a regressed eager task matrix from
    // exhausting the test runner. The socket stand-in never opens a network.
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const vm = require('node:vm');
      const net = require('node:net');
      const { EventEmitter } = require('node:events');
      const filename = process.argv[1];
      const localRequire = require('node:module').createRequire(filename);
      class Socket extends EventEmitter {
        setTimeout() {}
        destroy() {}
        connect() { queueMicrotask(() => this.emit('error', { code: 'ECONNREFUSED' })); }
      }
      const module = { exports: {} };
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, process, Buffer, setTimeout, clearTimeout,
        require: (name) => name === 'net' ? { ...net, Socket } : localRequire(name),
      }, { filename });
      const signal = { stopped: false };
      let results = 0, progress;
      module.exports.portScan({ targets: '192.0.2.0/24', ports: '1-65535', concurrency: 4, showAll: true }, (type, data) => {
        if (type === 'result') { results++; signal.stopped = true; }
        if (type === 'progress') progress = data;
      }, signal).then(() => {
        assert.ok(results > 0 && results <= 4);
        assert.equal(progress.total, 254 * 65535);
        assert.equal(progress.done, results);
      }).catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['--max-old-space-size=48', '-e', script, path.join(__dirname, '../src/main/nettools.js')], {
      timeout: 15000, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.slice(-2500));
  });
}

module.exports = { runToolReviewRegressionTests };
