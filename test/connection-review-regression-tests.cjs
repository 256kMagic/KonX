'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const tick = () => new Promise(setImmediate);

function load(name, dependencies, globals = {}) {
  const filename = path.join(__dirname, '..', 'src', 'main', name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, TextDecoder, setTimeout, clearTimeout, setImmediate,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

function sshHarness() {
  const clients = [];
  const executorErrors = [];
  class Client extends EventEmitter {
    constructor() { super(); this.ends = 0; clients.push(this); }
    connect(options) {
      this.options = options;
      if (options.host === 'bad-sync') throw new Error('Invalid SSH connection options');
      queueMicrotask(() => {
        if (options.sock?.denyAuth) this.emit('error', new Error('Target authentication denied'));
        else this.emit('ready');
      });
    }
    forwardOut(source, sourcePort, host, port, callback) {
      if (host === 'forward-denied') return callback(new Error('Forward denied'));
      const channel = new EventEmitter();
      channel.denyAuth = host === 'auth-denied';
      channel.destroy = () => { channel.destroyed = true; };
      this.forward = channel;
      callback(null, channel);
    }
    end() { this.ends++; this.emit('close'); }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  // Observe an accidentally asynchronous Promise executor without letting its
  // detached rejection terminate the main test runner.
  function ObservedPromise(executor) {
    return new Promise((resolve, reject) => {
      const returned = executor(resolve, reject);
      if (returned?.catch) returned.catch((error) => executorErrors.push(error));
    });
  }
  Object.setPrototypeOf(ObservedPromise, Promise);
  const ssh = load('ssh.js', {
    net: {}, crypto: require('node:crypto'), ssh2: { Client },
    './ssh-policy': require('../src/main/ssh-policy'),
  }, { Promise: ObservedPromise, process });
  return { ssh, clients, executorErrors };
}

const hooks = { ask: async () => null, knownHost: () => null, log() {}, saveHost() {} };

function connectionHarness(fileSystem) {
  const events = [];
  class Transport extends EventEmitter {
    async connect() {}
    write() {}
    resize() {}
    close() { this.emit('close'); }
  }
  const { ConnectionManager } = load('connections.js', {
    fs: fileSystem, path, './ssh': {}, './telnet': { TelnetConnection: Transport }, './serial': {},
  });
  const manager = new ConnectionManager({
    store: {}, emit: (...args) => events.push(args), defaultLogDir: () => 'logs',
  });
  return { manager, events };
}

async function runConnectionReviewRegressionTests(test) {
  await test('SSH username prompt rejection settles the connection attempt', async () => {
    const { ssh, executorErrors, clients } = sshHarness();
    let result;
    ssh.connect({ host: 'test' }, { ...hooks, ask: async () => { throw new Error('Prompt unavailable'); } })
      .then(() => { result = 'connected'; }, (error) => { result = error.message; });
    await tick();
    assert.equal(result, 'Prompt unavailable');
    assert.equal(executorErrors.length, 0);
    assert.equal(clients.length, 0);
  });

  await test('Synchronous SSH connection-option errors reject instead of hanging', async () => {
    const { ssh, executorErrors } = sshHarness();
    let result;
    ssh.connect({ host: 'bad-sync', username: 'test' }, hooks)
      .then(() => { result = 'connected'; }, (error) => { result = error.message; });
    await tick();
    assert.equal(result, 'Invalid SSH connection options');
    assert.equal(executorErrors.length, 0);
  });

  await test('Failed SSH jump forwarding and target authentication close every jump client', async () => {
    for (const host of ['forward-denied', 'auth-denied']) {
      const { ssh, clients } = sshHarness();
      await assert.rejects(ssh.connectChain({ host, username: 'test', jumpId: 'jump' }, hooks,
        () => ({ host: 'jump', username: 'test' })), /denied/i);
      assert.equal(clients[0].ends, 1, 'the authenticated jump session must be closed');
      if (clients[0].forward) assert.equal(clients[0].forward.destroyed, true);
    }
  });

  await test('A successful SSH jump stays open until its target closes', async () => {
    const { ssh, clients } = sshHarness();
    const target = await ssh.connectChain({ host: 'target', username: 'test', jumpId: 'jump' }, hooks,
      () => ({ host: 'jump', username: 'test' }));
    assert.equal(clients[0].ends, 0);
    target.client.end();
    assert.equal(clients[0].ends, 1);
  });

  await test('OpenSSH imports accept equals syntax and preserve quoted path comments', () => {
    const { importSshConfig } = require('../src/main/importers');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'konx-config-review-'));
    try {
      const file = path.join(folder, 'config');
      fs.writeFileSync(file, 'Host=router\n HostName = 192.0.2.10\n User=operator\n Port=2202\n IdentityFile "C:/Keys/operator #1" # comment\n');
      const imported = importSshConfig(file);
      assert.equal(imported.length, 1);
      assert.equal(imported[0].name, 'router');
      assert.equal(imported[0].host, '192.0.2.10');
      assert.equal(imported[0].username, 'operator');
      assert.equal(imported[0].port, 2202);
      assert.equal(imported[0].keyPath, 'C:/Keys/operator #1');
    } finally {
      assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(folder).startsWith('konx-config-review-'));
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  await test('OpenSSH Match blocks cannot overwrite the preceding imported Host', () => {
    const { importSshConfig } = require('../src/main/importers');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'konx-config-review-'));
    try {
      const file = path.join(folder, 'config');
      fs.writeFileSync(file, 'Host router\n HostName 192.0.2.10\n User operator\nMatch host other\n HostName 198.51.100.10\n User wrong\n Port 9999\nHost next\n HostName 203.0.113.10\n');
      const imported = importSshConfig(file);
      assert.equal(imported.length, 2);
      assert.deepEqual([imported[0].host, imported[0].username, imported[0].port], ['192.0.2.10', 'operator', 22]);
      assert.equal(imported[1].host, '203.0.113.10');
    } finally {
      assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(folder).startsWith('konx-config-review-'));
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  await test('An invalid automatic log folder reports an error while keeping the session usable', async () => {
    const { manager, events } = connectionHarness({ mkdirSync() { throw new Error('Access denied'); } });
    try {
      const result = await manager.open('log-failed', { protocol: 'raw', host: 'test', logging: { enabled: true } });
      assert.equal(result.ok, true);
      assert.equal(manager.info('log-failed').logging, null);
      assert.ok(events.some(([name, , data]) => name === 'conn:data' && data.toString().includes('Access denied')));
    } finally {
      manager.closeAll();
    }
  });

  await test('Asynchronous log-file errors stop logging without an unhandled process error', async () => {
    let stream;
    const { manager, events } = connectionHarness({
      mkdirSync() {},
      openSync() { return 123; },
      fstatSync() { return { isFile: () => true }; },
      closeSync() {},
      createWriteStream() {
        stream = new EventEmitter();
        stream.write = () => {};
        stream.end = () => {};
        stream.destroy = () => { stream.destroyed = true; };
        return stream;
      },
    });
    try {
      assert.equal((await manager.open('log-failed', { protocol: 'raw', host: 'test', logging: { enabled: true } })).ok, true);
      assert.doesNotThrow(() => stream.emit('error', new Error('Disk full')));
      assert.equal(manager.info('log-failed').logging, null);
      assert.equal(stream.destroyed, true);
      assert.ok(events.some(([name, , data]) => name === 'conn:data' && data.toString().includes('Disk full')));
    } finally {
      manager.closeAll();
    }
  });
}

module.exports = { runConnectionReviewRegressionTests };
