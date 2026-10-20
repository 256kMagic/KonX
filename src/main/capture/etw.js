'use strict';
// Minimal Event Tracing for Windows (ETW) bindings through koffi: start/stop/query a
// real-time session, enable a provider, and consume events (live, or from an .etl file).
// Starting sessions needs administrator rights; reading .etl files does not.
const crypto = require('crypto');

const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;
const ERROR_MORE_DATA = 234;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_CANCELLED = 1223;
const WNODE_FLAG_TRACED_GUID = 0x00020000;
const EVENT_TRACE_REAL_TIME_MODE = 0x00000100;
const EVENT_TRACE_CONTROL_QUERY = 0;
const EVENT_TRACE_CONTROL_STOP = 1;
const EVENT_CONTROL_CODE_ENABLE_PROVIDER = 1;
const PROCESS_TRACE_MODE_REAL_TIME = 0x00000100;
const PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000;
const PROPS_SIZE = 120; // sizeof(EVENT_TRACE_PROPERTIES) on x64
const NAME_ROOM = 1024; // bytes reserved after the structure for each name
const INVALID_HANDLE = 0xffffffffffffffffn;

let api = null;

function load() {
  if (api) return api;
  const koffi = require('koffi');
  const adv = koffi.load('advapi32.dll');
  const EventRecordCallback = koffi.proto('void __stdcall KonxEventRecordCallback(void *record)');
  const BufferCallback = koffi.proto('uint32_t __stdcall KonxBufferCallback(void *logfile)');
  // EVENT_TRACE_LOGFILEW (448 bytes on x64). The two embedded structs are kept opaque.
  const LOGFILE = koffi.struct('KONX_EVENT_TRACE_LOGFILEW', {
    LogFileName: 'void *',
    LoggerName: 'void *',
    CurrentTime: 'int64_t',
    BuffersRead: 'uint32_t',
    ProcessTraceMode: 'uint32_t',
    CurrentEvent: koffi.array('uint8_t', 88),
    LogfileHeader: koffi.array('uint8_t', 280),
    BufferCallback: koffi.pointer(BufferCallback),
    BufferSize: 'uint32_t',
    Filled: 'uint32_t',
    EventsLost: 'uint32_t',
    EventRecordCallback: koffi.pointer(EventRecordCallback),
    IsKernelTrace: 'uint32_t',
    Context: 'void *',
  });
  api = {
    koffi,
    LOGFILE,
    EventRecordCallback,
    BufferCallback,
    StartTraceW: adv.func('uint32_t __stdcall StartTraceW(_Out_ uint64_t *handle, str16 name, void *props)'),
    ControlTraceW: adv.func('uint32_t __stdcall ControlTraceW(uint64_t handle, str16 name, void *props, uint32_t code)'),
    QueryAllTracesW: adv.func('uint32_t __stdcall QueryAllTracesW(void *props, uint32_t count, _Out_ uint32_t *returned)'),
    EnableTraceEx2: adv.func('uint32_t __stdcall EnableTraceEx2(uint64_t handle, void *provider, uint32_t code, uint8_t level, uint64_t any, uint64_t all, uint32_t timeout, void *params)'),
    OpenTraceW: adv.func('uint64_t __stdcall OpenTraceW(void *logfile)'),
    ProcessTrace: adv.func('uint32_t __stdcall ProcessTrace(uint64_t *handles, uint32_t count, void *start, void *end)'),
    CloseTrace: adv.func('uint32_t __stdcall CloseTrace(uint64_t handle)'),
  };
  if (koffi.sizeof(LOGFILE) !== 448) throw new Error(`EVENT_TRACE_LOGFILEW layout mismatch (${koffi.sizeof(LOGFILE)})`);
  return api;
}

/** "{2ED6006E-4729-4609-B423-3EE7BCD678EF}" -> 16-byte GUID in memory order. */
function guidBytes(str) {
  const h = str.replace(/[{}-]/g, '');
  if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error(`Bad GUID ${str}`);
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), 'hex').copy(b, 8);
  return b;
}

function guidString(b, o = 0) {
  const hex = (n, w) => n.toString(16).padStart(w, '0');
  const d4 = b.subarray(o + 8, o + 16).toString('hex');
  return `{${hex(b.readUInt32LE(o), 8)}-${hex(b.readUInt16LE(o + 4), 4)}-${hex(b.readUInt16LE(o + 6), 4)}-${d4.slice(0, 4)}-${d4.slice(4)}}`.toUpperCase();
}

/** EVENT_TRACE_PROPERTIES followed by room for the session and log file names. */
function propsBuffer(name, { bufferKB = 512, minBuffers = 16, maxBuffers = 64, flushSeconds = 1 } = {}) {
  const size = PROPS_SIZE + NAME_ROOM * 2;
  const b = Buffer.alloc(size);
  b.writeUInt32LE(size, 0); // Wnode.BufferSize
  crypto.randomFillSync(b, 24, 16); // Wnode.Guid (session id)
  b.writeUInt32LE(1, 40); // Wnode.ClientContext: QPC timestamps (high resolution)
  b.writeUInt32LE(WNODE_FLAG_TRACED_GUID, 44);
  b.writeUInt32LE(bufferKB, 48);
  b.writeUInt32LE(minBuffers, 52);
  b.writeUInt32LE(maxBuffers, 56);
  b.writeUInt32LE(EVENT_TRACE_REAL_TIME_MODE, 64);
  b.writeUInt32LE(flushSeconds, 68); // deliver buffers at least once a second
  b.writeUInt32LE(PROPS_SIZE + NAME_ROOM, 112); // LogFileNameOffset
  b.writeUInt32LE(PROPS_SIZE, 116); // LoggerNameOffset
  b.write(name, PROPS_SIZE, 'utf16le');
  return b;
}

class EtwError extends Error {
  constructor(what, code) {
    const hint = code === ERROR_ACCESS_DENIED ? ' (administrator rights are required)' : '';
    super(`${what} failed with Windows error ${code}${hint}`);
    this.code = code;
  }
}

function stopSession(name) {
  const a = load();
  return a.ControlTraceW(0, name, propsBuffer(name), EVENT_TRACE_CONTROL_STOP);
}

/** Counters of a running session, or null if it does not exist. */
function querySession(name) {
  const a = load();
  const p = propsBuffer(name);
  if (a.ControlTraceW(0, name, p, EVENT_TRACE_CONTROL_QUERY) !== ERROR_SUCCESS) return null;
  return {
    buffers: p.readUInt32LE(80),
    freeBuffers: p.readUInt32LE(84),
    eventsLost: p.readUInt32LE(88),
    buffersWritten: p.readUInt32LE(92),
    realTimeBuffersLost: p.readUInt32LE(100),
  };
}

/** Names of the trace sessions running on this PC (those the caller may see). */
function listSessions(max = 64) {
  const a = load();
  const k = a.koffi;
  const stride = PROPS_SIZE + NAME_ROOM * 2;
  const block = k.alloc('uint8_t', stride * max);
  try {
    const init = Buffer.alloc(stride * max);
    const base = BigInt(k.address(block));
    const ptrs = new BigUint64Array(max);
    for (let i = 0; i < max; i++) {
      const o = i * stride;
      init.writeUInt32LE(stride, o);
      init.writeUInt32LE(PROPS_SIZE + NAME_ROOM, o + 112);
      init.writeUInt32LE(PROPS_SIZE, o + 116);
      ptrs[i] = base + BigInt(o);
    }
    k.encode(block, k.array('uint8_t', init.length), init);
    const count = [0];
    const rc = a.QueryAllTracesW(ptrs, max, count);
    if (rc !== ERROR_SUCCESS && rc !== ERROR_MORE_DATA) throw new EtwError('QueryAllTraces', rc);
    const mem = bytesAt(k, block, stride * max);
    const names = [];
    for (let i = 0; i < count[0]; i++) {
      const o = i * stride;
      const off = mem.readUInt32LE(o + 116);
      if (!off || off >= stride) continue;
      const raw = mem.subarray(o + off, o + stride).toString('utf16le');
      names.push(raw.slice(0, raw.indexOf('\0') < 0 ? raw.length : raw.indexOf('\0')));
    }
    return names;
  } finally {
    k.free(block);
  }
}

/** Start a real-time session and enable providers on it. Returns {name, stop()}. */
function startSession(name, providers, opts) {
  const a = load();
  const handle = [0n];
  let rc = a.StartTraceW(handle, name, propsBuffer(name, opts));
  if (rc === ERROR_ALREADY_EXISTS) {
    // Left over from a capture that did not shut down: stop it and start fresh.
    stopSession(name);
    rc = a.StartTraceW(handle, name, propsBuffer(name, opts));
  }
  if (rc !== ERROR_SUCCESS) throw new EtwError('StartTrace', rc);
  for (const p of providers) {
    const r = a.EnableTraceEx2(handle[0], guidBytes(p.guid), EVENT_CONTROL_CODE_ENABLE_PROVIDER, p.level ?? 5, p.anyKeyword ?? 0xffffffffffffffffn, p.allKeyword ?? 0n, 0, null);
    if (r !== ERROR_SUCCESS) {
      stopSession(name);
      throw new EtwError(`EnableTraceEx2 ${p.guid}`, r);
    }
  }
  let stopped = false;
  return {
    name,
    stop() {
      if (stopped) return;
      stopped = true;
      stopSession(name);
    },
  };
}

/**
 * Copy native memory into a Buffer. (koffi.view would map it without copying, but Electron's
 * V8 memory cage does not allow buffers outside the cage and aborts the process.)
 */
function bytesAt(k, ptr, len) {
  const u8 = k.decode(ptr, 'uint8_t', len);
  return Buffer.from(u8.buffer, u8.byteOffset, u8.length);
}

/** Read an EVENT_RECORD into a plain object; userData is a copy of the payload. */
function readRecord(a, recordPtr) {
  const hdr = bytesAt(a.koffi, recordPtr, 112);
  const len = hdr.readUInt16LE(86);
  let userData = Buffer.alloc(0);
  if (len) userData = bytesAt(a.koffi, a.koffi.decode(recordPtr, 96, 'void *'), len);
  const ts = hdr.readBigInt64LE(16); // FILETIME (ProcessTrace converts QPC for us)
  return {
    provider: guidString(hdr, 24),
    id: hdr.readUInt16LE(40),
    version: hdr[42],
    level: hdr[44],
    opcode: hdr[45],
    keyword: hdr.readBigUInt64LE(48),
    pid: hdr.readUInt32LE(12),
    tid: hdr.readUInt32LE(8),
    processor: hdr[80],
    time: Number(ts) / 1e7 - 11644473600, // Unix seconds
    userData,
  };
}

/**
 * Consume events until the session stops (live) or the file ends. Blocks the calling
 * thread, so run it on a worker thread. source: {session: name} | {file: path}.
 * onBuffer() runs after each delivered buffer of events; returning false stops reading.
 */
function consume(source, onEvent, onBuffer) {
  const a = load();
  const k = a.koffi;
  // OpenTrace keeps pointers into the structure and its strings until CloseTrace, so all
  // of it lives in memory koffi allocated rather than in JS-owned buffers.
  const allocs = [];
  const wstr = (s) => {
    const units = Uint16Array.from(s + '\0', (c) => c.charCodeAt(0));
    const p = k.alloc('uint16_t', units.length);
    k.encode(p, k.array('uint16_t', units.length), units);
    allocs.push(p);
    return p;
  };
  let error = null;
  let count = 0;
  const cb = k.register((rec) => {
    try {
      count++;
      onEvent(readRecord(a, rec));
    } catch (e) {
      error = error || e;
    }
  }, k.pointer(a.EventRecordCallback));
  const bufCb = k.register(() => {
    if (error) return 0;
    try {
      return onBuffer && onBuffer() === false ? 0 : 1;
    } catch (e) {
      error = error || e;
      return 0;
    }
  }, k.pointer(a.BufferCallback));
  const mem = k.alloc(a.LOGFILE, 1);
  allocs.push(mem);
  try {
    k.encode(mem, a.LOGFILE, {
      LogFileName: source.file ? wstr(source.file) : null,
      LoggerName: source.session ? wstr(source.session) : null,
      CurrentTime: 0,
      BuffersRead: 0,
      ProcessTraceMode: PROCESS_TRACE_MODE_EVENT_RECORD | (source.session ? PROCESS_TRACE_MODE_REAL_TIME : 0),
      CurrentEvent: new Array(88).fill(0),
      LogfileHeader: new Array(280).fill(0),
      BufferCallback: bufCb,
      BufferSize: 0,
      Filled: 0,
      EventsLost: 0,
      EventRecordCallback: cb,
      IsKernelTrace: 0,
      Context: null,
    });
    const h = BigInt(a.OpenTraceW(mem));
    if (h === INVALID_HANDLE) throw new Error(`Could not open the trace ${source.session || source.file}`);
    try {
      const rc = a.ProcessTrace([h], 1, null, null);
      if (rc !== ERROR_SUCCESS && rc !== ERROR_CANCELLED) throw new EtwError('ProcessTrace', rc);
    } finally {
      a.CloseTrace(h);
    }
  } finally {
    for (const p of allocs) k.free(p);
    k.unregister(cb);
    k.unregister(bufCb);
  }
  if (error) throw error;
  return { events: count };
}

module.exports = { startSession, stopSession, querySession, listSessions, consume, guidBytes, guidString, load, ERROR_ACCESS_DENIED };
