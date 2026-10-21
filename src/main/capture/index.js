'use strict';
// Live capture sessions keyed by the capture tab's id. Two engines:
//   npcap   - Npcap's driver through wpcap.dll, one worker thread per capture
//   builtin - Windows' own NDIS capture driver through an elevated helper (no Npcap needed)
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const npcap = require('./npcap');
const { BuiltinCapture } = require('./builtin');

// Worker threads cannot load scripts from inside app.asar, so the capture folder
// (and koffi) are unpacked in packaged builds; start the worker from there.
function workerPath() {
  const p = path.join(__dirname, 'worker.js');
  const packed = 'app.asar' + path.sep;
  return p.includes(packed) ? p.replace(packed, 'app.asar.unpacked' + path.sep) : p;
}

class CaptureManager {
  /** deps: emit(channel, ...args), launch(args) for the elevated helper, elevated() */
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Map();
    this.startRequests = new Map();
    this.builtin = new BuiltinCapture(deps);
  }

  /** Npcap is preferred when installed; otherwise Windows' built-in capture. */
  status() {
    const np = npcap.status();
    const bi = this.builtin.status();
    const engine = np.available ? 'npcap' : bi.available ? 'builtin' : null;
    return {
      available: !!engine,
      engine,
      version: np.available ? np.version : bi.available ? bi.version : '',
      missing: !np.available && !!np.missing, // Npcap is not installed
      error: engine ? undefined : np.error,
      npcap: np,
      builtin: bi,
    };
  }

  resetStatus() {
    npcap.resetStatus();
  }

  async devices() {
    const out = [];
    if (npcap.status().available) out.push(...npcap.listDevices().map((d) => ({ ...d, engine: 'npcap' })));
    if (this.builtin.status().available) out.push(...(await this.builtin.listDevices()));
    return out;
  }

  async start(id, opts) {
    const stopped = this.stop(id);
    const request = {};
    this.startRequests.set(id, request);
    await stopped;
    if (this.startRequests.get(id) !== request) throw new Error('Capture cancelled');
    this.startRequests.delete(id);
    if (String(opts.device).startsWith('ndis:')) return this.builtin.start(id, opts);
    const { device, snaplen, promisc, filter, bufferMB } = opts;
    const stopFlag = new SharedArrayBuffer(4);
    const worker = new Worker(workerPath(), {
      workerData: { device, opts: { snaplen, promisc, filter, bufferMB }, stopFlag },
    });
    const s = { worker, stopFlag: new Int32Array(stopFlag), count: 0 };
    s.done = new Promise((resolve) => (s.finish = resolve));
    this.sessions.set(id, s);
    return new Promise((resolve, reject) => {
      let started = false;
      worker.on('message', (m) => {
        if (this.sessions.get(id) !== s) return;
        if (m.type === 'packets') {
          this.deps.emit('cap:packets', id, { buf: m.buf, meta: m.meta });
        } else if (m.type === 'started') {
          if (s.stopping) return;
          started = true;
          this.deps.emit('cap:state', id, { state: 'running', linktype: m.linktype });
          resolve({ linktype: m.linktype, engine: 'npcap' });
        } else if (m.type === 'stats') {
          this.deps.emit('cap:state', id, { state: 'running', stats: { received: m.received, dropped: m.dropped, ifdropped: m.ifdropped } });
        } else if (m.type === 'error') {
          if (!started) reject(Object.assign(new Error(m.message), { code: m.code }));
          else this.deps.emit('cap:state', id, { state: 'stopped', error: m.message });
        } else if (m.type === 'stopped') {
          this.deps.emit('cap:state', id, { state: 'stopped' });
        }
      });
      worker.on('error', (e) => {
        if (!started) reject(e);
        else if (this.sessions.get(id) === s) this.deps.emit('cap:state', id, { state: 'stopped', error: e.message });
      });
      worker.on('exit', () => {
        clearTimeout(s.killTimer);
        if (this.sessions.get(id) === s) this.sessions.delete(id);
        if (!started) reject(new Error(s.stopping ? 'Capture cancelled' : 'Capture worker exited'));
        s.finish();
      });
    });
  }

  /** Load koffi on a capture thread and call into kernel32: {ok, pid} or {ok:false, error}. */
  selfTest() {
    return new Promise((resolve) => {
      const w = new Worker(workerPath(), { workerData: { selftest: true } });
      w.once('message', (m) => {
        resolve(m.error ? { ok: false, error: m.error } : { ok: m.pid === process.pid, pid: m.pid });
        w.terminate();
      });
      w.once('error', (e) => resolve({ ok: false, error: e.message }));
    });
  }

  async stop(id) {
    this.startRequests.delete(id);
    const builtinDone = this.builtin.stop(id);
    const s = this.sessions.get(id);
    if (s && !s.stopping) {
      s.stopping = true;
      Atomics.store(s.stopFlag, 0, 1);
      // Resolve only after the final batch has drained and the worker has exited.
      s.killTimer = setTimeout(() => s.worker.terminate(), 3000);
      s.killTimer.unref();
    }
    await Promise.all([builtinDone, s && s.done]);
  }

  stopAll() {
    this.startRequests.clear();
    this.builtin.stopAll();
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  /** Capture files, including Windows .etl traces (converted to pcapng). */
  async readFile(file) {
    if (/\.etl$/i.test(file)) {
      if (fs.statSync(file).size > 1024 * 1024 * 1024) throw new Error('File is larger than 1 GB');
      return this.builtin.readEtl(file);
    }
    return readCaptureFile(file);
  }
}

/** Only capture files may be read through the capture IPC. */
function readCaptureFile(file, { maxBytes = 1024 * 1024 * 1024 } = {}) {
  if (!/\.(pcap|pcapng|cap|dmp)$/i.test(file)) throw new Error('Not a capture file (.pcap, .pcapng, .cap, .etl)');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new RangeError('Invalid capture file byte limit');
  const tooLarge = () => new Error(maxBytes === 1024 * 1024 * 1024 ? 'File is larger than 1 GB' : `Capture file exceeds the ${maxBytes}-byte limit`);
  // The open descriptor owns the object read. Nonblocking avoids waiting on a
  // special file before fstat can reject it (a no-op for regular disk files).
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('Capture input must be a regular file');
    if (st.size > maxBytes) throw tooLarge();
    // Normal files need only their validated size plus one overflow-probe byte.
    // Return the same owned allocation instead of retaining chunks and copying
    // the whole file into a second concatenated buffer.
    let bytes = Buffer.allocUnsafe(st.size + 1), total = 0;
    while (true) {
      // A size check alone is stale if the file grows. At most maxBytes + 1
      // bytes are read, and every allocation is bounded before reading.
      if (total === bytes.length) {
        // Only a growing file needs another allocation. Geometric growth bounds
        // repeated copying while the maximum still includes just one probe byte.
        const grown = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(64 * 1024, bytes.length * 2)));
        bytes.copy(grown, 0, 0, total);
        bytes = grown;
      }
      const read = fs.readSync(fd, bytes, total, Math.min(64 * 1024, bytes.length - total), total);
      if (!read) break;
      total += read;
      if (total > maxBytes) throw tooLarge();
    }
    return bytes.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { CaptureManager, readCaptureFile };
