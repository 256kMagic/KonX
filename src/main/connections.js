'use strict';
// Live terminal connections (SSH, Telnet, raw TCP, serial) keyed by a tab-chosen id.
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');
const { TelnetConnection } = require('./telnet');
const { SerialConnection } = require('./serial');

const ANSI_RE = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=>78]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

/** Expand \r \n \t \e \xNN escapes used in button bar / logon action strings. */
function unescapeSend(s) {
  return String(s).replace(/\\(r|n|t|e|\\|x[0-9a-fA-F]{2})/g, (_, c) => {
    if (c === 'r') return '\r';
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'e') return '\x1b';
    if (c === '\\') return '\\';
    return String.fromCharCode(parseInt(c.slice(1), 16));
  });
}

function expandLogPath(template, s) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const safe = (v) => String(v || '').replace(/[\\/:*?"<>|]+/g, '_');
  return template
    .replace(/%S/g, safe(s.name || s.host))
    .replace(/%H/g, safe(s.host))
    .replace(/%Y/g, d.getFullYear())
    .replace(/%M/g, p2(d.getMonth() + 1))
    .replace(/%D/g, p2(d.getDate()))
    .replace(/%h/g, p2(d.getHours()))
    .replace(/%m/g, p2(d.getMinutes()))
    .replace(/%s/g, p2(d.getSeconds()));
}

class SessionLogger {
  constructor(file, timestamps) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    this.timestamps = timestamps;
    this.atLineStart = true;
    this.decoder = new TextDecoder('utf-8');
  }

  write(buf) {
    let text = stripAnsi(this.decoder.decode(buf, { stream: true })).replace(/\r\n?/g, '\n');
    if (this.timestamps) {
      let out = '';
      for (const ch of text) {
        if (this.atLineStart) {
          out += `[${new Date().toISOString().replace('T', ' ').slice(0, 23)}] `;
          this.atLineStart = false;
        }
        out += ch;
        if (ch === '\n') this.atLineStart = true;
      }
      text = out;
    }
    this.stream.write(text);
  }

  note(msg) {
    this.stream.write(`\n=== ${msg} at ${new Date().toLocaleString()} ===\n`);
  }

  close() {
    this.stream.end();
  }
}

/** Runs SecureCRT-style logon actions: wait for text, then send a reply. */
class LogonActions {
  constructor(steps, vars, send, log) {
    this.steps = (steps || []).filter((s) => s.expect || s.send);
    this.vars = vars;
    this.send = send;
    this.log = log;
    this.buf = '';
    this.cur = null;
  }

  start() {
    this._next();
  }

  feed(text) {
    if (!this.cur) return;
    this.buf = (this.buf + stripAnsi(text)).slice(-4096);
    if (this.cur.expect && this.buf.includes(this.cur.expect)) this._fire();
  }

  _fire() {
    clearTimeout(this.timer);
    const step = this.cur;
    this.cur = null;
    let text = String(step.send || '')
      .replace(/\{username\}/g, this.vars.username || '')
      .replace(/\{password\}/g, this.vars.password || '');
    text = unescapeSend(text);
    if (!step.noEnter) text += '\r';
    this.send(text);
    setTimeout(() => this._next(), 50);
  }

  _next() {
    this.cur = this.steps.shift() || null;
    this.buf = '';
    if (!this.cur) return;
    if (!this.cur.expect) {
      this.timer = setTimeout(() => this._fire(), 200);
      return;
    }
    this.timer = setTimeout(() => {
      this.log(`Logon action timed out waiting for "${this.cur.expect}"`);
      this.cur = null;
      this.steps = [];
    }, 30000);
  }

  stop() {
    clearTimeout(this.timer);
    this.cur = null;
    this.steps = [];
  }
}

/** Telnet auto-login: answers the first username and password prompts it sees. */
class TelnetAutoLogin {
  constructor(username, password, send) {
    this.username = username;
    this.password = password;
    this.send = send;
    this.buf = '';
    this.userSent = !username;
    this.passSent = !password;
    this.deadline = Date.now() + 30000;
  }

  feed(text) {
    if ((this.userSent && this.passSent) || Date.now() > this.deadline) return;
    this.buf = (this.buf + stripAnsi(text)).slice(-512);
    const tail = this.buf.trimEnd();
    if (!this.userSent && /(login|username|user name|user)\s*:$/i.test(tail)) {
      this.userSent = true;
      this.buf = '';
      this.send(this.username + '\r');
    } else if (!this.passSent && /password\s*:$/i.test(tail)) {
      this.passSent = true;
      this.userSent = true;
      this.buf = '';
      this.send(this.password + '\r');
    }
  }
}

class ConnectionManager {
  /**
   * @param {object} deps
   *   emit(channel, ...args)          send an event to the renderer
   *   ask(payload) -> Promise         interactive prompt in the renderer
   *   store                           Store instance
   *   defaultLogDir()                 folder for session logs
   */
  constructor(deps) {
    this.deps = deps;
    this.conns = new Map();
  }

  _hooks(id) {
    const { store, ask } = this.deps;
    return {
      knownHost: (h, p) => store.hostKeyFor(h, p),
      saveHost: (h, p, rec) => store.saveHostKey(h, p, rec),
      ask,
      log: (m) => this._local(id, m),
    };
  }

  _local(id, msg, color = '90') {
    this.deps.emit('conn:data', id, Buffer.from(`\x1b[${color}m${msg.replace(/\n/g, '\r\n')}\x1b[0m\r\n`));
  }

  _status(id, state, extra = {}) {
    this.deps.emit('conn:status', id, { state, ...extra });
  }

  /** Resolve what the tab asked for into a full session object (secrets included). */
  resolveSession(spec) {
    if (spec.sessionId) {
      const s = this.deps.store.getSessionSecret(spec.sessionId);
      if (!s) throw new Error('Session not found');
      return { ...s, ...(spec.override || {}) };
    }
    return { ...spec };
  }

  async open(id, spec, size = {}) {
    if (this.conns.has(id)) this.close(id);
    const s = this.resolveSession(spec);
    const protocol = s.protocol || 'ssh';
    const c = {
      id,
      protocol,
      session: s,
      size: { cols: size.cols || 80, rows: size.rows || 24 },
      pending: [],
      flushScheduled: false,
      closed: false,
      decoder: new TextDecoder('utf-8'),
      watchers: [],
    };
    this.conns.set(id, c);
    const target = protocol === 'serial' ? s.serialPort : `${s.host}:${s.port || defaultPort(protocol)}`;
    this._status(id, 'connecting', { message: `Connecting to ${target}...` });
    this._local(id, `Connecting to ${target} (${protocol.toUpperCase()})...`);

    try {
      if (protocol === 'ssh') await this._openSsh(c);
      else if (protocol === 'telnet' || protocol === 'raw') await this._openTelnet(c, protocol === 'raw');
      else if (protocol === 'serial') await this._openSerial(c);
      else throw new Error('Unknown protocol ' + protocol);
      if (c.closed || this.conns.get(id) !== c) throw new Error('Cancelled');
    } catch (e) {
      if (this.conns.get(id) === c) {
        this._local(id, `Connection failed: ${e.message}`, '31');
        this._teardown(c, `Connection failed: ${e.message}`);
      }
      return { ok: false, error: e.message };
    }

    if (s.logging && s.logging.enabled) this.startLog(id);
    const info = this.info(id);
    this._status(id, 'connected', { info });
    if (s.logonActions && s.logonActions.length) {
      const la = new LogonActions(s.logonActions, s, (t) => c.write(t), (m) => this._local(id, m, '33'));
      c.watchers.push(la);
      la.start();
    }
    if (protocol === 'telnet' && (s.username || s.password) && s.autoLogin !== false) {
      c.watchers.push(new TelnetAutoLogin(s.username, s.password, (t) => c.write(t)));
    }
    return { ok: true, info };
  }

  async _openSsh(c) {
    const { store } = this.deps;
    const resolveJump = (jid) => store.getSessionSecret(jid);
    const { client, info } = await ssh.connectChain(c.session, this._hooks(c.id), resolveJump);
    let ended = false;
    const endClient = () => {
      if (ended) return;
      ended = true;
      client.end();
    };
    // The tab can close while shell() is still pending. Keep its authenticated
    // client reachable by close() throughout that interval.
    c.end = endClient;
    const cancelled = () => c.closed || this.conns.get(c.id) !== c;
    client.on('close', () => {
      ended = true;
      this._teardown(c, 'Disconnected');
    });
    client.on('error', (e) => { if (!c.closed) this._local(c.id, `SSH error: ${e.message}`, '31'); });
    c.client = client;
    c.sshInfo = info;
    try {
      if (cancelled()) throw new Error('Cancelled');
      const stream = await ssh.openShell(client, {
        term: c.session.termType || 'xterm-256color',
        cols: c.size.cols,
        rows: c.size.rows,
      });
      if (cancelled()) {
        stream.close();
        throw new Error('Cancelled');
      }
      c.stream = stream;
      c.write = (d) => stream.write(d);
      c.resize = (cols, rows) => stream.setWindow(rows, cols, 0, 0);
      stream.on('data', (d) => { if (!c.closed) this._data(c, d); });
      stream.stderr.on('data', (d) => { if (!c.closed) this._data(c, d); });
      stream.on('close', endClient);
      if (c.session.forwards && c.session.forwards.length) {
        const stopForwards = await ssh.startForwards(client, c.session.forwards, (m) => this._local(c.id, m, '36'));
        if (cancelled()) {
          stopForwards();
          throw new Error('Cancelled');
        }
        c.stopForwards = stopForwards;
      }
    } catch (e) {
      endClient();
      throw e;
    }
  }

  async _openTelnet(c, raw) {
    const t = new TelnetConnection({
      host: c.session.host,
      port: c.session.port || (raw ? 23 : 23),
      termType: c.session.termType,
      raw,
      connectTimeout: c.session.connectTimeout,
    });
    c.telnet = t;
    c.write = (d) => t.write(d);
    c.resize = (cols, rows) => t.resize(cols, rows);
    c.end = () => t.close();
    t.on('data', (d) => { if (!c.closed) this._data(c, d); });
    t.on('close', () => this._teardown(c, 'Disconnected'));
    t.on('error', (e) => { if (!c.closed) this._local(c.id, `Socket error: ${e.message}`, '31'); });
    await t.connect();
    if (c.closed) {
      t.close();
      throw new Error('Cancelled');
    }
    t.resize(c.size.cols, c.size.rows);
  }

  async _openSerial(c) {
    const p = new SerialConnection(c.session);
    c.serial = p;
    c.write = (d) => p.write(d);
    c.resize = () => {};
    c.end = () => p.close();
    p.on('data', (d) => { if (!c.closed) this._data(c, d); });
    p.on('close', () => this._teardown(c, 'Serial port closed'));
    p.on('error', (e) => { if (!c.closed) this._local(c.id, `Serial error: ${e.message}`, '31'); });
    await p.connect();
    if (c.closed) {
      p.close();
      throw new Error('Cancelled');
    }
  }

  _data(c, buf) {
    if (c.logger) c.logger.write(buf);
    if (c.watchers.length) {
      const text = c.decoder.decode(buf, { stream: true });
      for (const w of c.watchers) w.feed(text);
    }
    c.pending.push(buf);
    if (!c.flushScheduled) {
      c.flushScheduled = true;
      setImmediate(() => {
        c.flushScheduled = false;
        if (!c.pending.length) return;
        const out = c.pending.length === 1 ? c.pending[0] : Buffer.concat(c.pending);
        c.pending = [];
        this.deps.emit('conn:data', c.id, out);
      });
    }
  }

  _teardown(c, reason) {
    if (c.closed) return;
    c.closed = true;
    for (const w of c.watchers) w.stop && w.stop();
    if (c.stopForwards) c.stopForwards();
    if (c.logger) {
      c.logger.note('Session closed');
      c.logger.close();
      c.logger = null;
    }
    if (this.conns.get(c.id) === c) this.conns.delete(c.id);
    this._status(c.id, 'disconnected', { message: reason });
  }

  info(id) {
    const c = this.conns.get(id);
    if (!c) return null;
    const s = c.session;
    const out = {
      protocol: c.protocol,
      host: s.host,
      port: s.port || defaultPort(c.protocol),
      username: c.sshInfo ? c.sshInfo.username : s.username,
      serialPort: s.serialPort,
      baudRate: s.baudRate,
      logging: c.logger ? c.logger.file : null,
    };
    if (c.sshInfo) {
      const a = c.sshInfo.algorithms || {};
      out.cipher = a.cs && a.cs.cipher;
      out.kex = a.kex;
      out.hostKey = c.sshInfo.hostKey;
      out.via = c.sshInfo.via ? c.sshInfo.via.host : null;
    }
    return out;
  }

  write(id, data, binary) {
    const c = this.conns.get(id);
    if (!c || c.closed || !c.write) return;
    c.write(binary ? Buffer.from(data, 'binary') : Buffer.from(data, 'utf8'));
  }

  resize(id, cols, rows) {
    const c = this.conns.get(id);
    if (!c) return;
    c.size = { cols, rows };
    if (c.resize && !c.closed) c.resize(cols, rows);
  }

  sendBreak(id) {
    const c = this.conns.get(id);
    if (c && c.serial) c.serial.sendBreak();
    else if (c && c.telnet) c.telnet.sendBreak();
  }

  startLog(id) {
    const c = this.conns.get(id);
    if (!c || c.logger) return c && c.logger ? c.logger.file : null;
    const s = c.session;
    const dir = this.deps.defaultLogDir();
    const template = (s.logging && s.logging.path) || path.join(dir, '%S_%Y-%M-%D_%h%m%s.log');
    const file = expandLogPath(template, s);
    c.logger = new SessionLogger(file, !!(s.logging && s.logging.timestamps));
    c.logger.note(`Log opened for ${s.name || s.host}`);
    this._local(id, `Logging to ${file}`, '36');
    this._status(id, 'connected', { info: this.info(id) });
    return file;
  }

  stopLog(id) {
    const c = this.conns.get(id);
    if (!c || !c.logger) return;
    c.logger.note('Log closed');
    c.logger.close();
    c.logger = null;
    this._local(id, 'Logging stopped', '36');
    this._status(id, 'connected', { info: this.info(id) });
  }

  /** The ssh2 Client behind an open SSH tab, so SFTP can ride the same connection. */
  sshClient(id) {
    const c = this.conns.get(id);
    return c && c.client && !c.closed ? { client: c.client, session: c.session } : null;
  }

  close(id) {
    const c = this.conns.get(id);
    if (!c) return;
    try {
      c.end && c.end();
    } catch {}
    this._teardown(c, 'Disconnected');
  }

  closeAll() {
    for (const id of [...this.conns.keys()]) this.close(id);
  }
}

function defaultPort(protocol) {
  return protocol === 'ssh' ? 22 : protocol === 'telnet' || protocol === 'raw' ? 23 : '';
}

module.exports = { ConnectionManager, stripAnsi, unescapeSend, expandLogPath };
