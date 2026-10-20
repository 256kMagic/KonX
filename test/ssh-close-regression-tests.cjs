'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function client() {
  const result = new EventEmitter();
  result.ends = 0;
  result.end = () => {
    result.ends++;
    result.emit('close');
  };
  return result;
}

function channel() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closes = 0;
  stream.close = () => { stream.closes++; stream.emit('close'); };
  stream.write = () => {};
  stream.setWindow = () => {};
  return stream;
}

function harness(ssh) {
  const filename = path.join(__dirname, '..', 'src', 'main', 'connections.js');
  const module = { exports: {} };
  const dependencies = { fs: {}, path, './ssh': ssh, './telnet': {}, './serial': {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, TextDecoder, setTimeout, clearTimeout, setImmediate,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename });
  const events = [];
  const manager = new module.exports.ConnectionManager({ store: {}, emit: (...args) => events.push(args) });
  return { manager, events };
}

const tick = () => new Promise(setImmediate);
const connectedEvents = (events) => events.filter(([name, , value]) => name === 'conn:status' && value.state === 'connected');

async function runSshCloseRegressionTests(test) {
  await test('Closing established SSH ends its client once even when the shell also closes', async () => {
    const sshClient = client();
    const stream = channel();
    const { manager } = harness({
      connectChain: async () => ({ client: sshClient, info: {} }),
      openShell: async () => stream,
    });
    assert.equal((await manager.open('connected', { host: 'local-test' })).ok, true);
    manager.close('connected');
    stream.close();
    manager.close('connected');
    assert.equal(sshClient.ends, 1);
    assert.equal(manager.conns.size, 0);
  });

  await test('Closing SSH while its shell opens immediately ends the client and discards the late channel', async () => {
    const sshClient = client();
    const shell = deferred();
    const stream = channel();
    const { manager, events } = harness({
      connectChain: async () => ({ client: sshClient, info: {} }),
      openShell: () => shell.promise,
    });
    const attempt = manager.open('pending-shell', { host: 'local-test' });
    await tick();
    manager.close('pending-shell');
    assert.equal(sshClient.ends, 1, 'close must reach the authenticated client before shell() completes');
    shell.resolve(stream);
    assert.equal((await attempt).ok, false);
    assert.equal(stream.closes, 1);
    assert.equal(stream.listenerCount('data'), 0);
    assert.equal(stream.stderr.listenerCount('data'), 0);
    assert.equal(sshClient.ends, 1);
    assert.equal(manager.conns.size, 0);
    assert.equal(connectedEvents(events).length, 0);
    const count = events.length;
    assert.doesNotThrow(() => sshClient.emit('error', new Error('late close error')));
    stream.emit('data', Buffer.from('late shell output'));
    await tick();
    assert.equal(events.length, count, 'a removed tab must not receive late events');
  });

  await test('Rejected SSH shell opening closes the authenticated client', async () => {
    const sshClient = client();
    const { manager, events } = harness({
      connectChain: async () => ({ client: sshClient, info: {} }),
      openShell: async () => { throw new Error('shell denied'); },
    });
    const result = await manager.open('denied', { host: 'local-test' });
    assert.equal(result.ok, false);
    assert.match(result.error, /shell denied/);
    assert.equal(sshClient.ends, 1);
    assert.equal(manager.conns.size, 0);
    assert.equal(connectedEvents(events).length, 0);
  });

  await test('Closing before SSH authentication completes ends the returned client without opening a shell', async () => {
    const login = deferred();
    const sshClient = client();
    let shellCalls = 0;
    const { manager, events } = harness({
      connectChain: () => login.promise,
      openShell: async () => { shellCalls++; return channel(); },
    });
    const attempt = manager.open('pending-login', { host: 'local-test' });
    manager.close('pending-login');
    login.resolve({ client: sshClient, info: {} });
    assert.equal((await attempt).ok, false);
    assert.equal(sshClient.ends, 1);
    assert.equal(shellCalls, 0);
    assert.equal(manager.conns.size, 0);
    assert.equal(connectedEvents(events).length, 0);
  });

  await test('A replaced SSH attempt cannot close or send data to its replacement', async () => {
    const oldClient = client();
    const newClient = client();
    const oldShell = deferred();
    const lateStream = channel();
    const currentStream = channel();
    let connections = 0;
    const { manager, events } = harness({
      connectChain: async () => ({ client: connections++ ? newClient : oldClient, info: {} }),
      openShell: async (sshClient) => sshClient === oldClient ? oldShell.promise : currentStream,
    });
    const oldAttempt = manager.open('reused-id', { host: 'old-test' });
    await tick();
    assert.equal((await manager.open('reused-id', { host: 'new-test' })).ok, true);
    oldShell.resolve(lateStream);
    assert.equal((await oldAttempt).ok, false);
    assert.equal(oldClient.ends, 1);
    assert.equal(lateStream.closes, 1);
    assert.equal(newClient.ends, 0);
    assert.equal(manager.conns.get('reused-id').client, newClient);
    const count = events.length;
    lateStream.emit('data', Buffer.from('stale'));
    oldClient.emit('error', new Error('old error'));
    await tick();
    assert.equal(events.length, count);
    manager.close('reused-id');
    assert.equal(newClient.ends, 1);
  });

  await test('Closing while SSH forwards start stops any listeners returned after cancellation', async () => {
    const sshClient = client();
    const forwards = deferred();
    let stopped = 0;
    const { manager, events } = harness({
      connectChain: async () => ({ client: sshClient, info: {} }),
      openShell: async () => channel(),
      startForwards: () => forwards.promise,
    });
    const attempt = manager.open('pending-forwards', { host: 'local-test', forwards: [{ type: 'L' }] });
    await tick();
    manager.close('pending-forwards');
    assert.equal(sshClient.ends, 1);
    forwards.resolve(() => { stopped++; });
    assert.equal((await attempt).ok, false);
    assert.equal(stopped, 1);
    assert.equal(sshClient.ends, 1);
    assert.equal(manager.conns.size, 0);
    assert.equal(connectedEvents(events).length, 0);
  });
}

module.exports = { runSshCloseRegressionTests };
