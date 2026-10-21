'use strict';
// SSH2 client connection with host-key verification, interactive auth, jump hosts
// and port forwarding. Independent of Electron so it can be exercised from tests.
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { Client, utils } = require('ssh2');

/** Read the key type (e.g. "ssh-ed25519") from a raw SSH wire-format public key. */
function keyTypeOf(buf) {
  try {
    const len = buf.readUInt32BE(0);
    return buf.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

function fingerprintOf(buf) {
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function defaultAgent() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return undefined;
}

/**
 * Open an authenticated ssh2 Client.
 *
 * @param {object} s  session: host, port, username, auth ('password'|'key'|'agent'),
 *                    password, keyPath, passphrase, keepalive, readyTimeout, agentPath
 * @param {object} hooks
 *   knownHost(host, port) -> {keyType, fingerprint} | null
 *   saveHost(host, port, {keyType, fingerprint})
 *   ask(payload) -> Promise<any>   interactive prompt shown by the UI
 *   log(msg)                        status messages for the terminal
 * @param {object} [sock] pre-connected stream (jump host channel)
 * @returns {Promise<{client: Client, info: object}>}
 */
async function connect(s, hooks, sock) {
  const host = s.host;
  const port = Number(s.port) || 22;
  let username = s.username;
  if (!username) {
    const r = await hooks.ask({
      kind: 'form',
      title: `Login to ${host}`,
      fields: [{ name: 'username', label: 'Username', type: 'text' }],
    });
    if (!r || !r.username) throw new Error('Login cancelled');
    username = r.username;
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    const info = { host, port, username, hostKey: null };
    let password = s.password || '';
    let pwFailed = 0;
    let kbdFailed = 0;
    let lastMethod = null;
    const tried = new Set();
    let keyData = null;

    if (s.auth === 'key' && s.keyPath) {
      try {
        keyData = fs.readFileSync(s.keyPath);
      } catch (e) {
        hooks.log?.(`Could not read key file ${s.keyPath}: ${e.message}`);
      }
    }

    const askPassword = async (message) => {
      const r = await hooks.ask({
        kind: 'form',
        title: `Password for ${username}@${host}`,
        message,
        fields: [{ name: 'password', label: 'Password', type: 'password' }],
      });
      return r ? r.password : null;
    };

    const authHandler = (methodsLeft, partialSuccess, cb) => {
      (async () => {
        const allowed = (m) => !methodsLeft || methodsLeft.includes(m);

        // Retry a failed password / keyboard-interactive attempt a few times.
        if (lastMethod === 'password' && allowed('password') && !partialSuccess) {
          pwFailed++;
          if (pwFailed < 3) {
            const pw = await askPassword('Access denied. Try again.');
            if (pw === null) return cb(false);
            password = pw;
            return cb({ type: 'password', username, password });
          }
        }
        if (lastMethod === 'keyboard-interactive' && allowed('keyboard-interactive') && !partialSuccess) {
          kbdFailed++;
          if (kbdFailed < 3) {
            password = '';
            return cb(kbdInteractive('Access denied. Try again.'));
          }
        }

        const order = [];
        if (s.auth === 'agent') order.push('agent');
        if (s.auth === 'key' && keyData) order.push('publickey');
        order.push('password', 'keyboard-interactive');

        for (const m of order) {
          if (tried.has(m)) continue;
          if (m === 'agent' && !allowed('publickey')) continue;
          if (m !== 'agent' && !allowed(m)) continue;
          tried.add(m);
          lastMethod = m;
          if (m === 'agent') {
            return cb({ type: 'agent', username, agent: s.agentPath || defaultAgent() });
          }
          if (m === 'publickey') {
            let passphrase = s.passphrase || undefined;
            const parsed = utils.parseKey(keyData, passphrase);
            if (parsed instanceof Error && /encrypted|passphrase/i.test(parsed.message)) {
              const r = await hooks.ask({
                kind: 'form',
                title: 'Key passphrase',
                message: `Passphrase for ${s.keyPath}`,
                fields: [{ name: 'passphrase', label: 'Passphrase', type: 'password' }],
              });
              if (!r) continue;
              passphrase = r.passphrase;
            }
            return cb({ type: 'publickey', username, key: keyData, passphrase });
          }
          if (m === 'password') {
            if (!password) {
              // Servers that also offer keyboard-interactive will prompt there instead.
              if (allowed('keyboard-interactive') && s.auth !== 'password') continue;
              const pw = await askPassword();
              if (pw === null) return cb(false);
              password = pw;
            }
            return cb({ type: 'password', username, password });
          }
          if (m === 'keyboard-interactive') {
            return cb(kbdInteractive());
          }
        }
        cb(false);
      })().catch((e) => {
        hooks.log?.(`Authentication error: ${e.message}`);
        cb(false);
      });
    };

    const kbdInteractive = (message) => ({
      type: 'keyboard-interactive',
      username,
      prompt: (name, instructions, lang, prompts, finish) => {
        if (!prompts.length) return finish([]);
        // A single password prompt with a password on hand: answer it without asking.
        if (password && prompts.length === 1 && !prompts[0].echo && !message) {
          const pw = password;
          password = '';
          return finish([pw]);
        }
        hooks
          .ask({
            kind: 'form',
            title: name || `Login to ${host}`,
            message: [message, instructions].filter(Boolean).join('\n'),
            fields: prompts.map((p, i) => ({
              name: 'f' + i,
              label: p.prompt.trim(),
              type: p.echo ? 'text' : 'password',
            })),
          })
          .then((r) => finish(r ? prompts.map((_, i) => r['f' + i] || '') : []));
      },
    });

    const hostVerifier = (key, verify) => {
      const keyType = keyTypeOf(key);
      const fingerprint = fingerprintOf(key);
      info.hostKey = { keyType, fingerprint };
      const known = hooks.knownHost(host, port);
      if (known && known.fingerprint === fingerprint) return verify(true);
      hooks
        .ask({
          kind: 'hostkey',
          host,
          port,
          keyType,
          fingerprint,
          changed: !!known,
          previous: known,
        })
        .then((answer) => {
          if (answer === 'save') hooks.saveHost(host, port, { keyType, fingerprint });
          verify(answer === 'save' || answer === 'once');
        })
        .catch(() => verify(false));
      // Returning undefined tells ssh2 the verification is asynchronous.
      return undefined;
    };

    client.on('banner', (msg) => hooks.log?.(msg.replace(/\r?\n/g, '\r\n')));
    client.once('ready', () => {
      cleanup();
      resolve({ client, info });
    });
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Connection closed during login'));
    };
    const cleanup = () => {
      client.removeListener('error', onError);
      client.removeListener('close', onClose);
    };
    client.on('error', onError);
    client.on('close', onClose);
    client.on('handshake', (neg) => {
      info.algorithms = neg;
    });

    client.connect({
      host: sock ? undefined : host,
      port: sock ? undefined : port,
      sock,
      username,
      authHandler,
      hostVerifier,
      readyTimeout: (Number(s.connectTimeout) || 20) * 1000,
      keepaliveInterval: (Number(s.keepalive) || 30) * 1000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
    });
  });
}

/**
 * Connect, going through a chain of jump hosts first when the session names one.
 * resolveJump(id) returns the full jump session (with secrets).
 */
async function connectChain(s, hooks, resolveJump, depth = 0) {
  if (depth > 5) throw new Error('Too many nested jump hosts');
  if (!s.jumpId) return connect(s, hooks);
  const jumpSession = resolveJump(s.jumpId);
  if (!jumpSession) throw new Error('Jump host session not found');
  hooks.log?.(`Connecting via jump host ${jumpSession.host}...`);
  const jump = await connectChain(jumpSession, hooks, resolveJump, depth + 1);
  let stream;
  try {
    stream = await new Promise((res, rej) =>
      jump.client.forwardOut('127.0.0.1', 0, s.host, Number(s.port) || 22, (err, ch) => (err ? rej(err) : res(ch)))
    );
    const target = await connect(s, hooks, stream);
    target.client.once('close', () => jump.client.end());
    target.info.via = jump.info;
    return target;
  } catch (error) {
    // A failed target login never reaches the target's close handler. Close its
    // channel and jump connection here, including any earlier hops in the chain.
    stream?.destroy();
    jump.client.end();
    throw error;
  }
}

function openShell(client, { term = 'xterm-256color', cols = 80, rows = 24 } = {}) {
  return new Promise((res, rej) =>
    client.shell({ term, cols, rows }, (err, stream) => (err ? rej(err) : res(stream)))
  );
}

/**
 * Start port forwards on an authenticated client. Returns a stop() function.
 * forward: {type:'L'|'R'|'D', listenHost, listenPort, destHost, destPort}
 */
async function startForwards(client, forwards, log) {
  const servers = [];
  const remote = [];
  for (const f of forwards || []) {
    const lh = f.listenHost || '127.0.0.1';
    const lp = Number(f.listenPort);
    try {
      if (f.type === 'L') {
        const srv = net.createServer((sock) => {
          client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, f.destHost, Number(f.destPort), (err, ch) => {
            if (err) return sock.destroy();
            sock.pipe(ch).pipe(sock);
            ch.on('error', () => sock.destroy());
            sock.on('error', () => ch.close());
          });
        });
        await listen(srv, lp, lh);
        servers.push(srv);
        log(`Forwarding ${lh}:${lp} -> ${f.destHost}:${f.destPort}`);
      } else if (f.type === 'D') {
        const srv = net.createServer((sock) => socks5(sock, client));
        await listen(srv, lp, lh);
        servers.push(srv);
        log(`SOCKS5 proxy listening on ${lh}:${lp}`);
      } else if (f.type === 'R') {
        await new Promise((res, rej) => client.forwardIn(lh, lp, (err) => (err ? rej(err) : res())));
        remote.push(f);
        log(`Remote forward ${lh}:${lp} (server side) -> ${f.destHost}:${f.destPort}`);
      }
    } catch (e) {
      log(`Port forward ${f.type} ${lh}:${lp} failed: ${e.message}`);
    }
  }
  if (remote.length) {
    client.on('tcp connection', (details, accept, reject) => {
      const f = remote.find((r) => Number(r.listenPort) === details.destPort);
      if (!f) return reject();
      const ch = accept();
      const sock = net.connect(Number(f.destPort), f.destHost);
      sock.on('connect', () => sock.pipe(ch).pipe(sock));
      sock.on('error', () => ch.close());
    });
  }
  return () => servers.forEach((s) => s.close());
}

function listen(srv, port, host) {
  return new Promise((res, rej) => {
    srv.once('error', rej);
    srv.listen(port, host, () => {
      srv.removeListener('error', rej);
      res();
    });
  });
}

/** Minimal SOCKS5 (no auth, CONNECT only) tunnelled through the SSH connection. */
function socks5(sock, client) {
  let stage = 0;
  let buf = Buffer.alloc(0);
  sock.on('error', () => {});
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0) {
      if (buf.length < 2 || buf.length < 2 + buf[1]) return;
      if (buf[0] !== 5) return sock.destroy();
      buf = buf.subarray(2 + buf[1]);
      sock.write(Buffer.from([5, 0]));
      stage = 1;
    }
    if (stage === 1) {
      if (buf.length < 7) return;
      const atyp = buf[3];
      let host;
      let off;
      if (atyp === 1) {
        if (buf.length < 10) return;
        host = Array.from(buf.subarray(4, 8)).join('.');
        off = 8;
      } else if (atyp === 3) {
        const l = buf[4];
        if (buf.length < 5 + l + 2) return;
        host = buf.subarray(5, 5 + l).toString();
        off = 5 + l;
      } else if (atyp === 4) {
        if (buf.length < 22) return;
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
        host = parts.join(':');
        off = 20;
      } else return sock.destroy();
      const port = buf.readUInt16BE(off);
      stage = 2;
      sock.removeListener('data', onData);
      const rest = buf.subarray(off + 2);
      client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
        if (err) {
          sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) ch.write(rest);
        sock.pipe(ch).pipe(sock);
        ch.on('error', () => sock.destroy());
      });
    }
  };
  sock.on('data', onData);
}

module.exports = { connect, connectChain, openShell, startForwards, fingerprintOf, keyTypeOf };
