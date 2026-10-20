'use strict';
// Telnet client (RFC 854) with the option negotiation a terminal needs:
// ECHO, SUPPRESS-GO-AHEAD, TERMINAL-TYPE and NAWS. Also used for raw TCP sessions.
const net = require('net');
const { EventEmitter } = require('events');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;
const TTYPE_IS = 0, TTYPE_SEND = 1;

class TelnetConnection extends EventEmitter {
  /**
   * @param {{host:string, port:number, termType?:string, raw?:boolean, connectTimeout?:number}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.raw = !!opts.raw;
    this.termType = opts.termType || 'xterm-256color';
    this.cols = 80;
    this.rows = 24;
    this.nawsEnabled = false;
    this.state = 'data';
    this.sbBuf = [];
    this.sbOpt = 0;
    this.verb = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const port = Number(this.opts.port) || (this.raw ? 23 : 23);
      const sock = net.connect({ host: this.opts.host, port });
      this.sock = sock;
      let settled = false;
      let connected = false;
      const timer = setTimeout(() => {
        sock.destroy(new Error('Connection timed out'));
      }, (Number(this.opts.connectTimeout) || 20) * 1000);
      sock.once('connect', () => {
        if (settled) return;
        settled = connected = true;
        clearTimeout(timer);
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 30000);
        resolve();
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(e);
        } else if (connected) {
          this.emit('error', e);
        }
      });
      sock.on('data', (d) => this._onData(d));
      sock.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('Connection closed before it was established'));
        }
        this.emit('close');
      });
    });
  }

  _send(bytes) {
    if (this.sock && !this.sock.destroyed) this.sock.write(Buffer.from(bytes));
  }

  _onData(chunk) {
    if (this.raw) return this.emit('data', chunk);
    const out = [];
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else out.push(b);
          break;
        case 'iac':
          if (b === IAC) {
            out.push(IAC);
            this.state = 'data';
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.verb = b;
            this.state = 'opt';
          } else if (b === SB) {
            this.state = 'sbopt';
          } else {
            this.state = 'data'; // NOP, GA, etc.
          }
          break;
        case 'opt':
          this._negotiate(this.verb, b);
          this.state = 'data';
          break;
        case 'sbopt':
          this.sbOpt = b;
          this.sbBuf = [];
          this.state = 'sb';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sbiac';
          else this.sbBuf.push(b);
          break;
        case 'sbiac':
          if (b === SE) {
            this._subnegotiation(this.sbOpt, this.sbBuf);
            this.state = 'data';
          } else {
            this.sbBuf.push(b);
            this.state = 'sb';
          }
          break;
      }
    }
    if (out.length) this.emit('data', Buffer.from(out));
  }

  _negotiate(verb, opt) {
    if (verb === DO) {
      if (opt === OPT_TTYPE) this._send([IAC, WILL, OPT_TTYPE]);
      else if (opt === OPT_NAWS) {
        this._send([IAC, WILL, OPT_NAWS]);
        this.nawsEnabled = true;
        this._sendNaws();
      } else if (opt === OPT_SGA) this._send([IAC, WILL, OPT_SGA]);
      else this._send([IAC, WONT, opt]);
    } else if (verb === WILL) {
      if (opt === OPT_ECHO || opt === OPT_SGA) this._send([IAC, DO, opt]);
      else this._send([IAC, DONT, opt]);
    } else if (verb === DONT) {
      if (opt === OPT_NAWS) this.nawsEnabled = false;
      this._send([IAC, WONT, opt]);
    }
    // WONT needs no reply.
  }

  _subnegotiation(opt, data) {
    if (opt === OPT_TTYPE && data[0] === TTYPE_SEND) {
      this._send([IAC, SB, OPT_TTYPE, TTYPE_IS, ...Buffer.from(this.termType), IAC, SE]);
    }
  }

  _sendNaws() {
    if (!this.nawsEnabled) return;
    const v = [this.cols >> 8, this.cols & 255, this.rows >> 8, this.rows & 255];
    const esc = [];
    for (const b of v) {
      esc.push(b);
      if (b === IAC) esc.push(IAC);
    }
    this._send([IAC, SB, OPT_NAWS, ...esc, IAC, SE]);
  }

  write(data) {
    if (!this.sock || this.sock.destroyed) return;
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (this.raw) return this.sock.write(buf);
    // NVT newline: a bare CR from the Enter key goes out as CR LF.
    if (buf.includes(13)) {
      const out = [];
      for (let i = 0; i < buf.length; i++) {
        out.push(buf[i]);
        if (buf[i] === 13 && buf[i + 1] !== 10) out.push(10);
      }
      buf = Buffer.from(out);
    }
    // Escape IAC bytes in user data.
    if (!buf.includes(IAC)) return this.sock.write(buf);
    const out = [];
    for (const b of buf) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    this.sock.write(Buffer.from(out));
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (!this.raw) this._sendNaws();
  }

  sendBreak() {
    if (!this.raw) this._send([IAC, 243]);
  }

  close() {
    if (this.sock) this.sock.destroy();
  }
}

module.exports = { TelnetConnection };
