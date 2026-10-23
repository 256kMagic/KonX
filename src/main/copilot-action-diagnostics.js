'use strict';
const net = require('node:net');

// Reuse cancellable network primitives. No shell strings, open-ended monitor,
// range expansion, tool factory or renderer auto-start path is invoked here.
function createActionDiagnostics({ nettools = require('./nettools') } = {}) {
  const aborted = signal => { if (signal.aborted) throw new Error('Reviewed diagnostic cancelled'); };
  async function address(host, signal, emit) {
    if (net.isIP(host)) return host;
    for (const type of ['A', 'AAAA']) {
      aborted(signal); const result = await nettools.dnsLookup({ name: host, type, signal, timeout: 3000, tries: 1 }); aborted(signal);
      const addresses = result.records.filter(r => net.isIP(r.value)).map(r => r.value);
      emit('resolution', { host, type, addresses, server: result.server, errors: result.errors || [] });
      if (addresses.length) return addresses[0];
    }
    throw new Error('The reviewed host did not resolve to an address');
  }
  const pause = (ms, signal) => new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
  });
  return {
    async ping(params, emit, signal) {
      const ip = await address(params.host, signal, emit);
      for (let seq = 1; seq <= params.count; seq++) {
        aborted(signal); const result = await nettools.pingOnce(ip, { timeout: params.timeout, size: params.size, signal });
        emit('reply', { host: params.host, ip, seq, ...result }); aborted(signal);
        if (seq < params.count) await pause(params.interval, signal);
      }
    },
    async dns(params, emit, signal) {
      aborted(signal); const result = await nettools.dnsLookup({ ...params, signal, timeout: 4000, tries: 1 });
      for (const record of result.records) emit('record', record);
      emit('resolver', { server: result.server, ms: result.ms, errors: result.errors || [] }); aborted(signal);
    },
    async traceroute(params, emit, signal) {
      const ip = await address(params.host, signal, emit); aborted(signal);
      const legacy = { stopped: false, onStop: null }, cancel = () => { legacy.stopped = true; legacy.onStop?.(); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        // The existing collector resolves after the native child closes.
        const task = nettools.traceroute({ host: ip, maxHops: params.maxHops, timeout: params.timeout, resolveNames: false }, (type, data) => { if (type === 'hop') emit(type, data); }, legacy);
        if (signal.aborted) cancel(); await task; aborted(signal);
      } finally { signal.removeEventListener('abort', cancel); }
    },
  };
}
module.exports = { createActionDiagnostics };
