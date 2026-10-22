'use strict';
// Serial console support. serialport is an optional native dependency; when it is
// missing the rest of the app keeps working and serial sessions report why.
const { EventEmitter } = require('events');
const { BAUD_RATES, MAX_SAMPLE_BYTES, TIMING, detectBaud } = require('./serial-autobaud');

let SerialPort = null;
let loadError = null;
try {
  ({ SerialPort } = require('serialport'));
} catch (e) {
  loadError = e;
}

async function listPorts() {
  if (!SerialPort) return [];
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    path: p.path,
    label: [p.path, p.friendlyName || p.manufacturer].filter(Boolean).join(' - '),
  }));
}

class SerialConnection extends EventEmitter {
  constructor(opts, { SerialPort: Port = SerialPort, timing = {} } = {}) {
    super();
    this.opts = { ...opts };
    this.Port = Port;
    // Dependency-only timing overrides keep owned test ports fast. Session data
    // cannot alter resource limits or timings.
    this.timing = Object.fromEntries(Object.entries(TIMING).map(([key, value]) => [key,
      Number.isFinite(timing[key]) ? Math.max(1, Math.min(value, timing[key])) : value]));
    this.state = 'idle';
    this.baudRate = null;
    this.autoBaud = null;
    this.abort = new AbortController();
    this.closeEmitted = false;
  }

  connect() {
    if (this.abort.signal.aborted) return Promise.reject(this.abort.signal.reason);
    if (!this.connectPromise) this.connectPromise = this._connect();
    return this.connectPromise;
  }

  _check() {
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
  }

  async _connect() {
    try {
      this._check();
      if (!this.Port) throw new Error('Serial support is unavailable: ' + (loadError ? loadError.message : 'serialport not installed'));
      const o = this.opts, automatic = o.baudRate === 'auto';
      const manualRate = o.baudRate === undefined || o.baudRate === '' ? 9600 : Number(o.baudRate);
      if (!automatic && ((typeof o.baudRate !== 'number' && o.baudRate !== undefined && (typeof o.baudRate !== 'string' || !/^[0-9]*$/.test(o.baudRate))) || !Number.isSafeInteger(manualRate) || manualRate <= 0)) {
        throw new Error('Serial baud rate must be Auto detect or a positive whole number.');
      }
      this.state = 'opening';
      this.port = new this.Port({ path: o.serialPort, baudRate: automatic ? BAUD_RATES[0] : manualRate,
        dataBits: Number(o.dataBits) || 8, stopBits: Number(o.stopBits) || 1, parity: o.parity || 'none',
        rtscts: o.flowControl === 'rtscts', xon: o.flowControl === 'xonxoff', xoff: o.flowControl === 'xonxoff', autoOpen: false });
      // Keep the owner and its error listener reachable until native callbacks
      // finish. Cancelling an open cannot abort the operating-system request.
      this.port.on('open', () => { if (this.abort.signal.aborted) this._closePort(); });
      this.port.on('data', data => {
        if (this.abort.signal.aborted) return;
        if (this.sampleWindow) {
          const window = this.sampleWindow, count = Math.min(data.length, MAX_SAMPLE_BYTES - window.used);
          if (count > 0) { data.copy(window.buffer, window.used, 0, count); window.used += count; }
          if (count < data.length) window.truncated = true;
        } else if (!automatic || this.state === 'connected') this.emit('data', data);
      });
      this.port.on('error', error => {
        if (this.abort.signal.aborted) return;
        this.abort.abort(error);
        this._reportError(error);
        this._closePort();
      });
      this.port.on('close', error => {
        if (!this.abort.signal.aborted) this.abort.abort(error || new Error('Serial port closed.'));
        this._closed();
      });
      await this._call('open');
      this._check();
      let result;
      if (automatic) {
        this.state = 'detecting';
        result = await detectBaud({
          setBaudRate: async baudRate => { if (this.port.baudRate !== baudRate) await this._call('update', { baudRate }); },
          sample: confirmation => this._sample(confirmation),
          progress: value => { this._check(); this.emit('baud-detect', value); },
          check: () => this._check(), probe: o.serialAutoBaudProbe === true,
        });
      }
      this._check();
      if (!this.port.isOpen) throw new Error('Serial port closed before connecting.');
      this.baudRate = result?.baudRate || this.port.baudRate;
      this.autoBaud = result?.summary || null;
      this.state = 'connected';
      if (result) {
        this.emit('baud-detect', { phase: 'complete', baudRate: this.baudRate, index: BAUD_RATES.indexOf(this.baudRate) + 1,
          total: BAUD_RATES.length, message: `Connected at likely ${this.baudRate} baud, confirmed with fresh readable output.` });
        this._check();
        this.emit('data', result.sample);
      }
      this._check();
    } catch (error) {
      if (!this.abort.signal.aborted) this.abort.abort(error);
      this._closePort();
      throw error;
    }
  }

  _reportError(error) {
    if (this.listenerCount('error')) this.emit('error', error);
  }

  _call(method, ...args) {
    this._check();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = error => {
        if (done) { if (this.abort.signal.aborted) this._closePort(); return; }
        done = true; clearTimeout(timer); this.abort.signal.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve();
      };
      const cancelled = () => finish(this.abort.signal.reason);
      const timer = setTimeout(() => finish(new Error(`Serial ${method} timed out. Check the adapter and choose a fixed baud rate.`)), this.timing.operationMs);
      this.abort.signal.addEventListener('abort', cancelled, { once: true });
      try { this.port[method](...args, finish); } catch (error) { finish(error); }
    });
  }

  _wait(ms) {
    this._check();
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(this.abort.signal.reason); };
      const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', cancel); resolve(); }, ms);
      this.abort.signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async _sample(confirmation) {
    await this._wait(this.timing.settleMs);
    await this._call('flush');
    this._check();
    const window = { buffer: Buffer.alloc(MAX_SAMPLE_BYTES), used: 0, truncated: false };
    this.sampleWindow = window;
    try {
      if (this.opts.serialAutoBaudProbe === true) {
        await this._call('write', Buffer.from('\r'));
        await this._call('drain');
      }
      await this._wait(confirmation ? this.timing.confirmationMs : this.timing.sampleMs);
      return { bytes: Buffer.from(window.buffer.subarray(0, window.used)), truncated: window.truncated };
    } finally { if (this.sampleWindow === window) this.sampleWindow = null; }
  }

  write(data) {
    if (this.state === 'connected' && !this.abort.signal.aborted && this.port?.isOpen) this.port.write(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  }

  /** Send a serial BREAK only after a normal connection is ready. */
  sendBreak() {
    if (this.state !== 'connected' || this.abort.signal.aborted || !this.port?.isOpen || this.breakTimer) return;
    this.port.set({ brk: true }, error => {
      if (error || !this.port.isOpen) return;
      // If closing failed while the SET callback was pending, release BREAK
      // on the still-owned open handle instead of leaving it asserted.
      if (this.abort.signal.aborted) { this.port.set({ brk: false }, () => {}); return; }
      this.breakTimer = setTimeout(() => {
        this.breakTimer = null;
        if (!this.abort.signal.aborted && this.port.isOpen) this.port.set({ brk: false }, () => {});
      }, 300);
    });
  }

  resize() {}

  get hasOwnership() {
    return !!this.port && (this.port.isOpen || this.port.opening || this.port.closing || !!this.closingNative);
  }

  _closed() {
    this.state = 'closed';
    if (!this.closeEmitted) { this.closeEmitted = true; this.emit('close'); }
  }

  _closePort() {
    if (this.breakTimer && this.port?.isOpen) this.port.set({ brk: false }, () => {});
    clearTimeout(this.breakTimer); this.breakTimer = null;
    this.sampleWindow = null;
    if (!this.port) { this._closed(); return; }
    if (this.port.opening || this.port.closing || this.closingNative) return;
    if (!this.port.isOpen) { this._closed(); return; }
    this.state = 'closing'; this.closingNative = true;
    const finished = error => {
      this.closingNative = false;
      if (error) {
        // Retain this.port and the owner: close() can retry failed cleanup.
        this.cleanupError = error; this._reportError(error);
      } else { this.cleanupError = null; this._closed(); }
    };
    try { this.port.close(finished); } catch (error) { finished(error); }
  }

  close() {
    if (!this.abort.signal.aborted) this.abort.abort(Object.assign(new Error('Serial connection cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' }));
    this._closePort();
  }
}

module.exports = { SerialConnection, listPorts, serialAvailable: () => !!SerialPort };
