'use strict';
// Reads NDIS packet-capture events on its own thread (ProcessTrace blocks until the trace
// ends) and turns them into frames.
//   mode 'stream':  batches of packets are posted as they arrive (live capture)
//   mode 'collect': the whole trace becomes one pcapng file (opening .etl files)
const { parentPort, workerData } = require('worker_threads');
const etw = require('./etw');
const { FrameAssembler, toPcapng } = require('./ndiscap');

const { source, mode = 'stream', ifIndex = null, snaplen = 262144, maxFrames = 1000000 } = workerData;
const asm = new FrameAssembler({ ifIndex, snaplen });

let batch = [];
let bytes = 0;
let sent = 0;
const frames = [];

function flush() {
  if (!batch.length) return;
  const buf = new Uint8Array(bytes);
  const meta = new Float64Array(batch.length * 4);
  const lts = new Uint16Array(batch.length);
  let off = 0;
  batch.forEach((p, i) => {
    buf.set(p.data, off);
    meta[i * 4] = p.ts;
    meta[i * 4 + 1] = p.caplen;
    meta[i * 4 + 2] = p.len;
    meta[i * 4 + 3] = off;
    lts[i] = p.linktype;
    off += p.caplen;
  });
  sent += batch.length;
  parentPort.postMessage({ type: 'packets', buf: buf.buffer, meta: meta.buffer, lts: lts.buffer, total: sent }, [buf.buffer, meta.buffer, lts.buffer]);
  batch = [];
  bytes = 0;
}

try {
  const r = etw.consume(
    source,
    (ev) => {
      const f = asm.push(ev);
      if (!f) return;
      if (mode === 'collect') {
        if (frames.length < maxFrames) frames.push(f);
        return;
      }
      batch.push(f);
      bytes += f.caplen;
      if (batch.length >= 2000 || bytes > 4 * 1024 * 1024) flush();
    },
    () => {
      // ETW hands events over a buffer at a time (at least once a second): flush per buffer.
      if (mode === 'stream') flush();
      return mode !== 'collect' || frames.length < maxFrames;
    }
  );
  flush();
  const stats = { ...asm.stats, events: r.events };
  if (mode === 'collect') {
    const bytesOut = toPcapng(frames);
    const ab = bytesOut.buffer.slice(bytesOut.byteOffset, bytesOut.byteOffset + bytesOut.length);
    parentPort.postMessage({ type: 'pcapng', bytes: ab, stats, truncated: frames.length >= maxFrames }, [ab]);
  } else parentPort.postMessage({ type: 'done', stats });
} catch (e) {
  flush();
  parentPort.postMessage({ type: 'error', message: e.message, code: e.code });
}
