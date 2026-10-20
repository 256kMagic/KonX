'use strict';
// Capture loop on its own thread: blocking pcap_next_ex calls never stall the app.
// Packets are batched (every 50 ms or 2000 packets) into one transferable buffer.
const { parentPort, workerData } = require('worker_threads');

// Diagnostics: prove the FFI layer loads on a capture thread (used to check packaged builds).
if (workerData.selftest) {
  try {
    const koffi = require('koffi');
    const pid = koffi.load('kernel32.dll').func('uint32_t __stdcall GetCurrentProcessId()')();
    parentPort.postMessage({ type: 'selftest', pid });
  } catch (e) {
    parentPort.postMessage({ type: 'selftest', error: e.message });
  }
  return;
}

const npcap = require('./npcap');

const { device, opts, stopFlag } = workerData;
const stop = new Int32Array(stopFlag);

function post(msg, transfer) {
  parentPort.postMessage(msg, transfer);
}

let handle;
try {
  handle = npcap.open(device, { ...opts, timeoutMs: 100 });
  post({ type: 'started', linktype: handle.linktype });

  let batch = [];
  let bytes = 0;
  let lastFlush = Date.now();
  let lastStats = Date.now();
  const flush = () => {
    if (!batch.length) return;
    const buf = new Uint8Array(bytes);
    const meta = new Float64Array(batch.length * 4);
    let off = 0;
    batch.forEach((p, i) => {
      buf.set(p.data, off);
      meta[i * 4] = p.ts;
      meta[i * 4 + 1] = p.caplen;
      meta[i * 4 + 2] = p.len;
      meta[i * 4 + 3] = off;
      off += p.caplen;
    });
    post({ type: 'packets', buf: buf.buffer, meta: meta.buffer }, [buf.buffer, meta.buffer]);
    batch = [];
    bytes = 0;
  };

  while (!Atomics.load(stop, 0)) {
    const p = handle.next();
    if (p === undefined) break;
    if (p) {
      batch.push(p);
      bytes += p.caplen;
    }
    const now = Date.now();
    if (batch.length >= 2000 || bytes > 4 * 1024 * 1024 || (batch.length && now - lastFlush >= 50)) {
      flush();
      lastFlush = now;
    }
    if (now - lastStats >= 1000) {
      lastStats = now;
      const s = handle.stats();
      if (s) post({ type: 'stats', ...s });
    }
  }
  flush();
  const s = handle.stats();
  if (s) post({ type: 'stats', ...s });
  handle.close();
  post({ type: 'stopped' });
} catch (e) {
  if (handle) handle.close();
  post({ type: 'error', message: e.message, code: e.code });
}
