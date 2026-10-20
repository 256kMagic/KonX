'use strict';
// Serial console support. serialport is an optional native dependency; when it is
// missing the rest of the app keeps working and serial sessions report why.
const { EventEmitter } = require('events');

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
  constructor(opts) {
    super();
    this.opts = opts;
  }

  connect() {
    if (!SerialPort) {
      return Promise.reject(new Error('Serial support is unavailable: ' + (loadError ? loadError.message : 'serialport not installed')));
    }
    const o = this.opts;
    return new Promise((resolve, reject) => {
      this.port = new SerialPort(
        {
          path: o.serialPort,
          baudRate: Number(o.baudRate) || 9600,
          dataBits: Number(o.dataBits) || 8,
          stopBits: Number(o.stopBits) || 1,
          parity: o.parity || 'none',
          rtscts: o.flowControl === 'rtscts',
          xon: o.flowControl === 'xonxoff',
          xoff: o.flowControl === 'xonxoff',
          autoOpen: false,
        },
      );
      this.port.open((err) => (err ? reject(err) : resolve()));
      this.port.on('data', (d) => this.emit('data', d));
      this.port.on('close', () => this.emit('close'));
      this.port.on('error', (e) => this.emit('error', e));
    });
  }

  write(data) {
    if (this.port && this.port.isOpen) this.port.write(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  }

  /** Send a serial BREAK (used for ROMMON / password recovery on network gear). */
  sendBreak() {
    if (!this.port || !this.port.isOpen) return;
    this.port.set({ brk: true }, () => setTimeout(() => this.port.set({ brk: false }, () => {}), 300));
  }

  resize() {}

  close() {
    if (this.port && this.port.isOpen) this.port.close(() => {});
  }
}

module.exports = { SerialConnection, listPorts, serialAvailable: () => !!SerialPort };
