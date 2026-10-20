'use strict';
// Writes .etl traces holding NDIS packet-capture events in the layout ndiscap.sys uses
// (event 1001: MiniportIfIndex, LowerIfIndex, FragmentSize, Fragment). It uses a private
// in-process ETW session, which needs no administrator rights. Test fixtures only.
const path = require('path');
const koffi = require('koffi');
const etw = require('../../src/main/capture/etw');
const { PROVIDER, KW } = require('../../src/main/capture/ndiscap');

let fns = null;
function load() {
  if (fns) return fns;
  const adv = koffi.load('advapi32.dll');
  const k32 = koffi.load('kernel32.dll');
  fns = {
    StartTraceW: adv.func('uint32_t __stdcall StartTraceW(_Out_ uint64_t *h, str16 name, void *props)'),
    ControlTraceW: adv.func('uint32_t __stdcall ControlTraceW(uint64_t h, str16 name, void *props, uint32_t code)'),
    EnableTraceEx2: adv.func('uint32_t __stdcall EnableTraceEx2(uint64_t h, void *g, uint32_t code, uint8_t lvl, uint64_t any, uint64_t all, uint32_t t, void *p)'),
    EventRegister: adv.func('uint32_t __stdcall EventRegister(void *guid, void *cb, void *ctx, _Out_ uint64_t *h)'),
    EventWrite: adv.func('uint32_t __stdcall EventWrite(uint64_t h, void *desc, uint32_t n, void *data)'),
    EventUnregister: adv.func('uint32_t __stdcall EventUnregister(uint64_t h)'),
    GetCurrentThread: k32.func('void * __stdcall GetCurrentThread()'),
    SetThreadAffinityMask: k32.func('uintptr_t __stdcall SetThreadAffinityMask(void *thread, uintptr_t mask)'),
  };
  return fns;
}

/**
 * frames: [{data: Uint8Array, ifIndex = 20, fragment = whole, keyword = 0n (extra bits), send = false}]
 * extra: [{id, payload}] other events written first (ignored by the reader).
 */
function writeNdisEtl(file, frames, { extra = [] } = {}) {
  const f = load();
  const name = `KonX-Test-${process.pid}-${Date.now()}`;
  const props = Buffer.alloc(120 + 2048);
  props.writeUInt32LE(props.length, 0);
  etw.guidBytes(PROVIDER).copy(props, 24); // private sessions are named by their provider
  props.writeUInt32LE(1, 40);
  props.writeUInt32LE(0x20000, 44);
  props.writeUInt32LE(64, 48);
  props.writeUInt32LE(0x1 | 0x800 | 0x20000, 64); // sequential file | private | in-process
  props.writeUInt32LE(120 + 1024, 112);
  props.writeUInt32LE(120, 116);
  props.write(name, 120, 'utf16le');
  props.write(path.resolve(file), 120 + 1024, 'utf16le');
  const h = [0n];
  let rc = f.StartTraceW(h, name, props);
  if (rc) throw new Error(`StartTrace (private) failed: ${rc}`);
  const reg = [0n];
  // Fragments of one frame must come from one processor, as they do in the driver.
  const prevMask = f.SetThreadAffinityMask(f.GetCurrentThread(), 1);
  try {
    rc = f.EnableTraceEx2(h[0], etw.guidBytes(PROVIDER), 1, 5, 0xffffffffffffffffn, 0n, 0, null);
    if (rc) throw new Error(`EnableTraceEx2 failed: ${rc}`);
    if (f.EventRegister(etw.guidBytes(PROVIDER), null, null, reg)) throw new Error('EventRegister failed');
    const write = (id, keyword, payload) => {
      const desc = Buffer.alloc(16);
      desc.writeUInt16LE(id, 0);
      desc[4] = 4; // level: informational
      desc.writeBigUInt64LE(keyword, 8);
      const dd = Buffer.alloc(16);
      dd.writeBigUInt64LE(BigInt(koffi.address(payload)), 0);
      dd.writeUInt32LE(payload.length, 8);
      if (f.EventWrite(reg[0], desc, 1, dd)) throw new Error('EventWrite failed');
    };
    for (const e of extra) write(e.id, 0n, Buffer.from(e.payload));
    for (const fr of frames) {
      const data = Buffer.from(fr.data);
      const step = fr.fragment || data.length || 1;
      for (let off = 0; off < Math.max(1, data.length); off += step) {
        const part = data.subarray(off, off + step);
        let kw = (fr.keyword || 0n) | (fr.send ? KW.SEND : KW.RECEIVE);
        if (off === 0) kw |= KW.PACKET_START;
        if (off + step >= data.length) kw |= KW.PACKET_END;
        const payload = Buffer.alloc(12 + part.length);
        payload.writeUInt32LE(fr.ifIndex ?? 20, 0);
        payload.writeUInt32LE(fr.ifIndex ?? 20, 4);
        payload.writeUInt32LE(part.length, 8);
        part.copy(payload, 12);
        write(1001, kw, payload);
      }
    }
  } finally {
    if (reg[0]) f.EventUnregister(reg[0]);
    f.SetThreadAffinityMask(f.GetCurrentThread(), prevMask);
    f.ControlTraceW(0n, name, Buffer.from(props), 1);
  }
}

module.exports = { writeNdisEtl };
