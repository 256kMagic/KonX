'use strict';
// Windows' built-in packet capture, used when Npcap is not installed. Windows ships an NDIS
// capture driver (ndiscap.sys, the one behind "netsh trace capture=yes"); reading from it
// needs administrator rights, so each capture runs in a short-lived elevated helper
// (capture/helper.js) that streams frames back over a private named pipe.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const { KIND_JSON, KIND_BATCH, encodeJson, decodeBatch, FrameReader } = require('./pipe');

const DRIVER = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'ndiscap.sys');
const CONNECT_TIMEOUT = 20000; // after the helper process has started
const START_TIMEOUT = 15000;

function workerPath(file) {
  const p = path.join(__dirname, file);
  const packed = 'app.asar' + path.sep;
  return p.includes(packed) ? p.replace(packed, 'app.asar.unpacked' + path.sep) : p;
}

function powershellJson(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.trim() || '[]'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Wait for a connection that opens with {type:'hello', token}; anything else is dropped. */
function acceptHelper(server, token, s) {
  return new Promise((resolve, reject) => {
    const want = Buffer.from(token);
    s.fail = reject;
    server.on('connection', (c) => {
      if (s.sock) return c.destroy();
      if (s.ended) return c.destroy();
      let done = false;
      const reader = new FrameReader((kind, body) => {
        if (done) return;
        done = true;
        let msg = null;
        try {
          msg = kind === KIND_JSON ? JSON.parse(body.toString('utf8')) : null;
        } catch {}
        const got = Buffer.from(String((msg && msg.token) || ''));
        if (msg && msg.type === 'hello' && got.length === want.length && crypto.timingSafeEqual(got, want)) {
          c.removeAllListeners('data');
          resolve({ sock: c, reader });
        } else c.destroy();
      });
      c.on('data', (d) => {
        try {
          reader.push(d);
        } catch {
          c.destroy();
        }
      });
      c.on('error', () => {});
      setTimeout(() => !done && c.destroy(), 5000).unref();
    });
  });
}

class BuiltinCapture {
  /**
   * deps.emit(channel, ...args)
   * deps.launch(args): starts KonX as the helper with administrator rights; resolves once it runs
   * deps.elevated(): true if KonX itself runs as administrator
   */
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Map();
    this.startRequests = new Map();
  }

  status() {
    if (process.platform !== 'win32') return { available: false, error: 'Built-in capture is Windows-only' };
    if (!fs.existsSync(DRIVER)) return { available: false, error: 'This Windows installation has no NDIS capture driver (ndiscap.sys).' };
    return { available: true, version: 'Windows built-in capture (NDIS)', elevated: !!(this.deps.elevated && this.deps.elevated()) };
  }

  /** Adapters by Windows interface index, plus "All adapters". */
  async listDevices() {
    let adapters = [];
    try {
      adapters = await powershellJson('ConvertTo-Json -Compress -InputObject @(Get-NetAdapter | Select-Object ifIndex,Name,InterfaceDescription,Status,MediaType,MacAddress)');
    } catch {}
    const ifs = os.networkInterfaces();
    const devices = adapters
      .filter((a) => Number.isInteger(a.ifIndex) && a.Status !== 'Not Present')
      .map((a) => ({
        name: `ndis:${a.ifIndex}`,
        engine: 'builtin',
        ifIndex: a.ifIndex,
        friendly: a.Name,
        description: a.InterfaceDescription || '',
        addresses: (ifs[a.Name] || []).filter((x) => !x.internal).map((x) => ({ family: x.family === 'IPv6' || x.family === 6 ? 6 : 4, ip: x.address })),
        up: a.Status === 'Up',
        wireless: /802\.11/.test(a.MediaType || ''),
        mac: a.MacAddress || '',
      }));
    const score = (d) => (d.up ? 2 : 0) + (d.addresses.some((x) => x.family === 4) ? 1 : 0);
    devices.sort((x, y) => score(y) - score(x));
    devices.push({ name: 'ndis:all', engine: 'builtin', ifIndex: null, friendly: 'All adapters', description: 'Every adapter the Windows capture driver is attached to', addresses: [], up: true });
    return devices;
  }

  async start(id, { device, snaplen }) {
    const stopped = this.stop(id);
    const request = {};
    this.startRequests.set(id, request);
    await stopped;
    if (this.startRequests.get(id) !== request) throw new Error('Capture cancelled');
    this.startRequests.delete(id);
    const m = /^ndis:(\d+|all)$/.exec(String(device));
    if (!m) throw new Error('Unknown capture adapter');
    const ifIndex = m[1] === 'all' ? null : Number(m[1]);
    const pipeName = 'konx-cap-' + crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    const server = net.createServer();
    const s = { server, sock: null, started: false, ended: false };
    s.done = new Promise((resolve) => (s.finish = resolve));
    this.sessions.set(id, s);
    let conn;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
      });
      if (s.ended) throw new Error('Capture cancelled');
      const accepted = acceptHelper(server, token, s);
      accepted.catch(() => {}); // may be cancelled while the UAC prompt is still up
      await this.deps.launch(['--konx-capture-helper', pipeName, token]);
      if (s.ended) throw new Error('Capture cancelled');
      let timer;
      conn = await Promise.race([accepted, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('The capture helper did not start (no connection from it).')), CONNECT_TIMEOUT)))]).finally(() => clearTimeout(timer));
    } catch (e) {
      s.ended = true;
      server.close(() => {});
      if (this.sessions.get(id) === s) this.sessions.delete(id);
      s.finish();
      throw e;
    }
    server.close(); // one helper per capture; the accepted pipe stays open
    s.sock = conn.sock;
    const send = (obj) => !s.sock.destroyed && s.sock.write(encodeJson(obj));
    const end = (error) => {
      if (s.ended) return;
      s.ended = true;
      clearTimeout(s.killTimer);
      if (this.sessions.get(id) === s) this.sessions.delete(id);
      if (s.started) this.deps.emit('cap:state', id, error ? { state: 'stopped', error } : { state: 'stopped' });
      s.finish();
    };
    return new Promise((resolve, reject) => {
      const startTimer = setTimeout(() => {
        end();
        reject(new Error('The capture helper did not respond.'));
        s.sock.destroy();
      }, START_TIMEOUT);
      conn.reader.onFrame = (kind, body) => {
        if (s.ended || this.sessions.get(id) !== s) return;
        if (kind === KIND_BATCH) {
          let batch;
          try {
            batch = decodeBatch(body);
          } catch {
            return s.sock.destroy();
          }
          return this.deps.emit('cap:packets', id, batch);
        }
        let msg;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          return;
        }
        if (msg.type === 'started') {
          s.started = true;
          clearTimeout(startTimer);
          this.deps.emit('cap:state', id, { state: 'running', linktype: 1 });
          resolve({ linktype: 1, engine: 'builtin' });
        } else if (msg.type === 'stats') {
          if (s.started) this.deps.emit('cap:state', id, { state: 'running', stats: { received: msg.received, dropped: msg.dropped, ifdropped: msg.ifdropped } });
        } else if (msg.type === 'error') {
          if (!s.started) {
            clearTimeout(startTimer);
            end();
            reject(Object.assign(new Error(msg.message), { code: msg.code }));
          } else end(msg.message);
        } else if (msg.type === 'stopped') end();
      };
      s.sock.on('data', (d) => {
        try {
          conn.reader.push(d);
        } catch {
          s.sock.destroy();
        }
      });
      s.sock.on('error', () => {});
      s.sock.on('close', () => {
        clearTimeout(startTimer);
        if (!s.started) reject(new Error('The capture helper stopped before the capture began.'));
        end(s.stopping ? undefined : 'The capture helper stopped unexpectedly.');
      });
      send({ cmd: 'start', ifIndex, snaplen: snaplen || 262144 });
    });
  }

  async stop(id) {
    this.startRequests.delete(id);
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.stopping) return s.done;
    s.stopping = true;
    if (!s.sock) {
      // Still waiting for the prompt or the helper.
      s.ended = true;
      this.sessions.delete(id);
      s.server.close(() => {});
      if (s.fail) s.fail(new Error('Capture cancelled'));
      s.finish();
      return s.done;
    }
    if (!s.sock.destroyed) s.sock.write(encodeJson({ cmd: 'stop' }));
    s.killTimer = setTimeout(() => s.sock.destroy(), 5000);
    return s.done;
  }

  stopAll() {
    this.startRequests.clear();
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  /** Packets of an .etl trace (netsh trace capture=yes, pktmon is not supported) as pcapng bytes. */
  readEtl(file) {
    return new Promise((resolve, reject) => {
      const w = new Worker(workerPath('etw-worker.js'), { workerData: { source: { file }, mode: 'collect' } });
      w.once('message', (m) => {
        if (m.type === 'error') return reject(new Error(m.message));
        if (!m.stats.frames) return reject(new Error('This .etl trace has no captured packets. Record one with: netsh trace start capture=yes'));
        resolve(Buffer.from(m.bytes));
      });
      w.once('error', reject);
      w.once('exit', (code) => code && reject(new Error('Could not read the trace')));
    });
  }
}

module.exports = { BuiltinCapture };
