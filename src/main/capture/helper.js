'use strict';
// The elevated half of Windows' built-in capture. KonX starts it with administrator rights
// (one UAC prompt per capture):  KonX.exe --konx-capture-helper <pipe> <token>
// It connects back to KonX over a named pipe, proves itself with the token, starts an ETW
// session for the NDIS capture provider and streams frames until it is told to stop or KonX
// goes away. It accepts only "start" (adapter, snap length) and "stop": no commands, no files.
const net = require('net');
const path = require('path');
const { Worker } = require('worker_threads');
const etw = require('./etw');
const ndiscap = require('./ndiscap');
const { KIND_JSON, encodeJson, encodeBatch, FrameReader } = require('./pipe');

const FLAG = '--konx-capture-helper';
const SESSION_PREFIX = 'KonX-Capture-';
const MAX_BACKLOG = 64 * 1024 * 1024; // drop batches rather than buffer without limit
const START_TIMEOUT = 30000;

function parseArgs(argv) {
  const i = argv.indexOf(FLAG);
  if (i < 0) return null;
  const [pipe, token] = [argv[i + 1], argv[i + 2]];
  if (!/^konx-cap-[0-9a-f]{32}$/.test(pipe || '') || !/^[0-9a-f]{64}$/.test(token || '')) return null;
  return { pipe, token };
}

// Worker threads cannot load scripts from inside app.asar (see capture/index.js).
function workerPath(file) {
  const p = path.join(__dirname, file);
  const packed = 'app.asar' + path.sep;
  return p.includes(packed) ? p.replace(packed, 'app.asar.unpacked' + path.sep) : p;
}

/** Stop sessions left behind by helpers that ended without cleaning up (crash, power loss). */
function cleanupStale() {
  let names;
  try {
    names = etw.listSessions();
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^KonX-Capture-(\d+)$/.exec(n);
    if (!m || Number(m[1]) === process.pid) continue;
    let alive = true;
    try {
      process.kill(Number(m[1]), 0);
    } catch (e) {
      alive = e.code === 'EPERM';
    }
    if (!alive) etw.stopSession(n);
  }
}

/**
 * opts.exit(code) ends the process. opts.source replaces the live session with a recorded
 * trace ({file}); tests use it, and it cannot be reached from the command line.
 */
function run(argv, { exit = (code) => process.exit(code), source = null } = {}) {
  const args = parseArgs(argv);
  if (!args) return exit(2);
  let session = null;
  let worker = null;
  let frames = 0;
  let dropped = 0;
  let statsTimer = null;
  let ending = false;

  const sock = net.connect(`\\\\.\\pipe\\${args.pipe}`);
  const send = (obj) => {
    if (!sock.destroyed) sock.write(encodeJson(obj));
  };
  const startTimer = setTimeout(() => finish(3), START_TIMEOUT);

  function stats() {
    const q = session && etw.querySession(session.name);
    return { received: frames, dropped: dropped + (q ? q.eventsLost : 0), ifdropped: q ? q.realTimeBuffersLost : 0 };
  }

  // Stop the session; the worker then drains what is left, and we leave once it is gone.
  function finish(code = 0) {
    if (ending) return;
    ending = true;
    clearTimeout(startTimer);
    clearInterval(statsTimer);
    const leave = () => {
      if (!sock.destroyed) {
        send({ type: 'stats', ...stats() });
        send({ type: 'stopped' });
        sock.end();
      }
      setTimeout(() => exit(code), 250);
    };
    if (session) {
      try {
        session.stop();
      } catch {}
    }
    if (!worker) return leave();
    const kill = setTimeout(() => worker.terminate(), 5000);
    worker.once('exit', () => {
      clearTimeout(kill);
      leave();
    });
  }

  function start(msg) {
    if (session || ending) return;
    clearTimeout(startTimer);
    const ifIndex = Number.isInteger(msg.ifIndex) && msg.ifIndex >= 0 ? msg.ifIndex : null;
    const snaplen = Math.max(64, Math.min(262144, Number(msg.snaplen) || 262144));
    const name = SESSION_PREFIX + process.pid;
    if (!source) {
      cleanupStale();
      try {
        session = etw.startSession(name, [{ guid: ndiscap.PROVIDER, level: 5 }]);
      } catch (e) {
        send({ type: 'error', message: e.message, code: e.code });
        return finish(1);
      }
    }
    worker = new Worker(workerPath('etw-worker.js'), { workerData: { source: source || { session: name }, mode: 'stream', ifIndex, snaplen } });
    worker.on('message', (m) => {
      if (m.type === 'packets') {
        frames = m.total;
        if (sock.writableLength > MAX_BACKLOG) dropped += m.meta.byteLength / 32;
        else if (!sock.destroyed) sock.write(encodeBatch(m));
      } else if (m.type === 'error') {
        send({ type: 'error', message: m.message, code: m.code });
        finish(1);
      } else if (m.type === 'done') finish(0);
    });
    worker.on('error', (e) => {
      send({ type: 'error', message: e.message });
      finish(1);
    });
    statsTimer = setInterval(() => send({ type: 'stats', ...stats() }), 1000);
    send({ type: 'started', session: name });
  }

  const reader = new FrameReader((kind, body) => {
    if (kind !== KIND_JSON) return;
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      return;
    }
    if (msg.cmd === 'start') start(msg);
    else if (msg.cmd === 'stop') finish(0);
  });
  sock.on('connect', () => send({ type: 'hello', token: args.token, pid: process.pid }));
  sock.on('data', (d) => {
    try {
      reader.push(d);
    } catch {
      sock.destroy();
    }
  });
  // KonX closed or crashed: never leave a capture running behind it.
  sock.on('close', () => finish(0));
  sock.on('error', () => {});
}

module.exports = { run, parseArgs, cleanupStale, FLAG, SESSION_PREFIX };

if (require.main === module) run(process.argv);
