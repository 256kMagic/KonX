'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');
const ssh = require('../src/main/ssh');
const { sshHostKey } = require('./lib/ssh-host-key.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error('Timed out: ' + description); await pause(10); }
}

async function withPeer(authentication, run, ready = () => {}) {
  const clients = new Set();
  const observed = { connections: 0, authentications: 0, ready: 0, answers: 0 };
  const server = new Server({ hostKeys: [sshHostKey()] }, client => {
    observed.connections++; clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', context => { observed.authentications++; authentication(context, observed); });
    client.on('ready', () => { observed.ready++; ready(client, observed); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const fixture = { clients, observed, session: { host: '127.0.0.1', port: server.address().port,
    protocol: 'ssh', username: 'fixture', auth: 'password', password: 'synthetic-password', connectTimeout: 2 } };
  try { await run(fixture); }
  finally { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); }
}

function hooks(overrides = {}) {
  return { knownHost: () => null, saveHost: () => {}, ask: async () => 'once', log: () => {}, ...overrides };
}
function passwordAuth(context) {
  if (context.method === 'password' && context.password === 'synthetic-password') context.accept();
  else context.reject(['password']);
}
function keyboardAuth(context, observed) {
  if (context.method !== 'keyboard-interactive') return context.reject(['keyboard-interactive']);
  context.prompt([{ prompt: 'Synthetic challenge:', echo: false }, { prompt: 'Synthetic second factor:', echo: false }], () => { observed.answers++; context.accept(); });
}

async function runSshLoginTests(test) {
  await test('SSH login: a late host-key answer after timeout cannot save trust or resume authentication', async () => withPeer(passwordAuth, async fixture => {
    let answer, saved = 0;
    const pending = ssh.connect({ ...fixture.session, connectTimeout: 0.2 }, hooks({
      saveHost: () => saved++, ask: payload => { assert.equal(payload.kind, 'hostkey'); return new Promise(resolve => { answer = resolve; }); },
    }));
    await assert.rejects(pending, /Timed out while waiting for handshake/);
    assert.equal(typeof answer, 'function');
    await until(() => fixture.clients.size === 0, 'timed-out peer disconnected');
    answer('save'); await pause(35);
    assert.equal(saved, 0); assert.equal(fixture.observed.authentications, 0); assert.equal(fixture.observed.ready, 0);
  }));

  await test('SSH login: a rejected keyboard-interactive prompt rejects login and closes its peer', async () => withPeer(keyboardAuth, async fixture => {
    let prompted = 0;
    await assert.rejects(ssh.connect({ ...fixture.session, password: '' }, hooks({ ask: async payload => {
      if (payload.kind === 'hostkey') return 'once';
      // Let the initial password attempt reach the peer, which advertises only
      // keyboard-interactive after rejection. Two challenges require a prompt.
      if (payload.fields?.some(field => field.name === 'password')) return { password: 'synthetic-password' };
      prompted++; throw new Error('Synthetic keyboard prompt rejected');
    } })), /Synthetic keyboard prompt rejected/);
    assert.equal(prompted, 1);
    await until(() => fixture.clients.size === 0, 'rejected-prompt peer disconnected');
    assert.equal(fixture.observed.answers, 0); assert.equal(fixture.observed.ready, 0);
  }));

  await test('SSH login: a late keyboard-interactive answer cannot authenticate a timed-out connection', async () => withPeer(keyboardAuth, async fixture => {
    let answer;
    const pending = ssh.connect({ ...fixture.session, password: '', connectTimeout: 0.2 }, hooks({ ask: payload => {
      if (payload.kind === 'hostkey') return Promise.resolve('once');
      if (payload.fields?.some(field => field.name === 'password')) return Promise.resolve({ password: 'synthetic-password' });
      return new Promise(resolve => { answer = resolve; });
    } }));
    await assert.rejects(pending, /Timed out while waiting for handshake/);
    assert.equal(typeof answer, 'function');
    await until(() => fixture.clients.size === 0, 'timed-out interactive peer disconnected');
    answer({ f0: 'late synthetic reply' }); await pause(35);
    assert.equal(fixture.observed.answers, 0); assert.equal(fixture.observed.ready, 0);
  }));

  await test('SSH login: abort while the peer holds authentication promptly disconnects the owned transport', async () => withPeer(() => {}, async fixture => {
    const abort = new AbortController();
    const pending = ssh.connect(fixture.session, hooks({ signal: abort.signal }));
    const rejected = assert.rejects(pending, /Synthetic login cancelled/);
    await until(() => fixture.observed.authentications > 0, 'peer received authentication');
    abort.abort(new Error('Synthetic login cancelled')); await rejected;
    await until(() => fixture.clients.size === 0, 'aborted peer disconnected');
    assert.equal(fixture.observed.ready, 0);
  }));

  await test('SSH login: abort during the username prompt settles before a reply and a late reply opens no socket', async () => withPeer(passwordAuth, async fixture => {
    const abort = new AbortController();
    let answer, settled = false;
    const pending = ssh.connect({ ...fixture.session, username: '' }, hooks({ signal: abort.signal, ask: payload => {
      assert.equal(payload.fields?.[0]?.name, 'username');
      return new Promise(resolve => { answer = resolve; });
    } }));
    const rejected = assert.rejects(pending, /Synthetic username cancelled/).then(() => { settled = true; });
    try {
      await until(() => typeof answer === 'function', 'username prompt');
      abort.abort(new Error('Synthetic username cancelled'));
      await until(() => settled, 'username cancellation settles without a prompt reply', 1000);
      await rejected;
      assert.equal(fixture.observed.connections, 0);
      answer({ username: 'late-fixture-user' }); await pause(35);
      assert.equal(fixture.observed.connections, 0); assert.equal(fixture.observed.authentications, 0);
    } finally { answer?.(null); await rejected; }
  }));

  await test('SSH login: abort during a held jump forwarding reply settles and closes the jump before any late reply', async () => {
    let acceptForward, lateChannel, forwardedBytes = 0;
    await withPeer(passwordAuth, async fixture => {
      const abort = new AbortController(); let settled = false;
      const pending = ssh.connectChain({ ...fixture.session, jumpId: 'owned-jump' }, hooks({ signal: abort.signal }), id => {
        assert.equal(id, 'owned-jump'); return fixture.session;
      });
      const rejected = assert.rejects(pending, /Synthetic forwarding cancelled/).then(() => { settled = true; });
      try {
        await until(() => typeof acceptForward === 'function', 'jump received forwarding request');
        abort.abort(new Error('Synthetic forwarding cancelled'));
        await until(() => settled, 'forward cancellation settles without a channel reply', 1000);
        await rejected;
        await until(() => fixture.clients.size === 0, 'cancelled jump disconnected');
        // ssh2 can still construct a server-side Channel after disconnection,
        // but its confirmation cannot reopen the client's closed transport.
        lateChannel = acceptForward();
        if (lateChannel) { lateChannel.on('error', () => {}); lateChannel.on('data', data => { forwardedBytes += data.length; }); }
        await pause(35);
        assert.equal(forwardedBytes, 0); assert.equal(fixture.clients.size, 0);
        assert.equal(fixture.observed.connections, 1); assert.equal(fixture.observed.ready, 1);
      } finally {
        lateChannel?.destroy();
        // Keep a failing cancellation regression from retaining its fixture.
        for (const client of fixture.clients) client.end();
        await rejected;
      }
    }, client => client.on('tcpip', accept => { acceptForward = accept; }));
  });

  await test('SSH login: encrypted key prompting occurs before the network timeout and then authenticates with a real signature', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-ssh-login-'));
    const phrase = 'synthetic key passphrase';
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const identity = utils.parseKey(pair.privateKey.export({ type: 'pkcs1', format: 'pem' }));
    assert.ok(!(identity instanceof Error));
    const file = path.join(root, 'synthetic-encrypted.pem');
    fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: phrase }));
    let client;
    try {
      await withPeer((context, observed) => {
        if (context.method !== 'publickey' || !context.key.data.equals(identity.getPublicSSH())) return context.reject(['publickey']);
        if (context.signature) {
          if (identity.verify(context.blob, context.signature, context.hashAlgo) !== true) return context.reject(['publickey']);
          observed.verifiedSignature = true;
        }
        context.accept();
      }, async fixture => {
        let prompts = 0;
        const result = await ssh.connect({ ...fixture.session, auth: 'key', password: '', keyPath: file, connectTimeout: 0.3 }, hooks({ ask: async payload => {
          if (payload.kind === 'hostkey') return 'once';
          assert.equal(payload.title, 'Key passphrase'); prompts++;
          await pause(450);
          assert.equal(fixture.observed.connections, 0, 'human passphrase entry must occur before opening a socket');
          return { passphrase: phrase };
        } }));
        client = result.client; client.on('error', () => {});
        assert.equal(prompts, 1); assert.equal(fixture.observed.verifiedSignature, true);
        assert.equal(fixture.observed.ready, 1);
        client.end(); await until(() => fixture.clients.size === 0, 'authenticated fixture disconnected');
      });
    } finally {
      client?.destroy();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-ssh-login-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

module.exports = { runSshLoginTests };
if (require.main === module) (async () => {
  let passed = 0, failed = 0;
  await runSshLoginTests(async (name, run) => { try { await run(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } });
  console.log(`${passed}/${passed + failed} SSH login tests passed`); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
