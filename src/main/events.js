'use strict';

const dgram = require('node:dgram');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { onCancel } = require('./security/common');
const { MAX_DATAGRAM_BYTES, parseSyslog, parseSnmp } = require('./event-parsers');

const LIMITS = Object.freeze({ histories: 8, listeners: 4, records: 1000, historyBytes: 1024 * 1024,
  datagramBytes: MAX_DATAGRAM_BYTES, datagramsPerSecond: 200, batchRecords: 100, batchBytes: 128 * 1024, batchMs: 100, recordBytes: 64 * 1024 });
const error = (message, code = 'EVENTS_INVALID') => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);
const listenerId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw error('Choose a valid event listener identifier.'); return value; };
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['listenerId', 'protocol', 'bindAddress', 'port'].includes(key))) throw error('Invalid event listener settings.');
  const id = listenerId(input.listenerId), protocol = input.protocol;
  if (!['syslog', 'snmp'].includes(protocol)) throw error('Choose Syslog or SNMP traps.');
  const bindAddress = input.bindAddress === undefined ? '127.0.0.1' : input.bindAddress;
  if (typeof bindAddress !== 'string' || bindAddress.includes('%') || !net.isIP(bindAddress)) throw error('Bind address must be a literal local IPv4 or IPv6 address. DNS names are not resolved.');
  const port = input.port === undefined ? protocol === 'syslog' ? 5514 : 5162 : input.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw error('UDP port must be a number from 1 to 65535.');
  return { listenerId: id, protocol, bindAddress, port };
}
const counters = () => ({ received: 0, accepted: 0, parseErrors: 0, unsupported: 0, oversized: 0, rateDropped: 0, deliveryDropped: 0, historyEvicted: 0, recordDropped: 0 });

class EventConsole {
  constructor(options = {}) {
    this.histories = new Map(); this.owners = new Set(); this.closing = null;
    this.createSocket = options.createSocket || (type => dgram.createSocket({ type, reuseAddr: false }));
    this.closeTimeoutMs = options.closeTimeoutMs ?? 1500;
  }
  get hasOwnership() { return this.owners.size > 0; }
  get(id) {
    const state = this.histories.get(listenerId(id)); if (!state) throw error('Event listener was not found.', 'EVENTS_NOT_FOUND'); return state;
  }
  status(state) { return { ...state.status, listenerId: state.id, settings: { ...state.settings }, counters: { ...state.counters },
    retainedRecords: state.records.length, retainedBytes: state.bytes, firstSequence: state.records[0]?.record.sequence ?? null,
    lastSequence: state.sequence, hasOwnership: !!state.owner }; }
  list() { return { listeners: [...this.histories.values()].map(state => this.status(state)), limits: { ...LIMITS } }; }
  snapshot(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['afterSequence', 'limit'].includes(key))) throw error('Invalid event history options.');
    const afterSequence = options.afterSequence ?? 0, limit = options.limit ?? 200;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.records) throw error('Invalid event history cursor or limit.');
    const state = this.get(id), available = state.records.filter(item => item.record.sequence > afterSequence), selected = available.slice(0, limit);
    return { ...this.status(state), records: selected.map(item => clone(item.record)), hasMore: available.length > selected.length,
      nextSequence: selected.at(-1)?.record.sequence ?? afterSequence,
      gap: afterSequence > 0 && !!state.records.length && afterSequence < state.records[0].record.sequence - 1 };
  }
  clear(id) {
    const state = this.get(id); state.records.length = 0; state.bytes = 0;
    if (state.owner) { state.owner.pending.length = 0; state.owner.pendingBytes = 0; this.notify(state.owner, 'cleared', this.status(state)); }
    return this.status(state);
  }
  remove(id) {
    const state = this.get(id); if (state.owner) throw error('Stop the event listener and finish cleanup before removing it.', 'EVENTS_BUSY');
    this.histories.delete(id); return { removed: id };
  }
  notify(owner, type, data) {
    try { owner.emit(type, clone(data)); }
    catch {
      owner.problem ||= error('Event delivery failed.', 'EVENTS_DELIVERY');
      if (owner.closed) { owner.state.status.state = 'error'; owner.state.status.message = owner.problem.message; }
      this.requestClose(owner);
    }
  }
  flush(owner) {
    if (!owner.pending.length && !owner.dirty) return;
    const records = owner.pending; owner.pending = []; owner.pendingBytes = 0; owner.dirty = false;
    this.notify(owner, 'events', { records, status: this.status(owner.state) });
  }
  message(owner, bytes, remote) {
    if (owner.stopRequested || !owner.listening || owner.closed) return;
    const state = owner.state, count = state.counters; count.received++; owner.dirty = true;
    const now = performance.now();
    if (now - owner.rateStart >= 1000) { owner.rateStart = now; owner.rateCount = 0; }
    if (++owner.rateCount > LIMITS.datagramsPerSecond) { count.rateDropped++; return; }
    if (bytes.length > LIMITS.datagramBytes) { count.oversized++; return; }
    const parsed = (state.settings.protocol === 'syslog' ? parseSyslog : parseSnmp)(bytes);
    const record = { sequence: state.sequence + 1, listenerId: state.id, receivedAt: new Date().toISOString(),
      source: { address: remote.address, port: remote.port, family: remote.family }, ...parsed };
    const size = Buffer.byteLength(JSON.stringify(record));
    if (size > LIMITS.recordBytes) { count.recordDropped++; return; }
    state.sequence++; count.accepted++;
    if (parsed.parseStatus === 'invalid') count.parseErrors++;
    if (parsed.parseStatus === 'unsupported') count.unsupported++;
    state.records.push({ record, size }); state.bytes += size;
    while (state.records.length > LIMITS.records || state.bytes > LIMITS.historyBytes) { state.bytes -= state.records.shift().size; count.historyEvicted++; }
    if (owner.pending.length >= LIMITS.batchRecords || owner.pendingBytes + size > LIMITS.batchBytes) count.deliveryDropped++;
    else { owner.pending.push(record); owner.pendingBytes += size; }
  }
  run(params, emit, signal = {}) {
    const settings = validate(params);
    if (typeof emit !== 'function') throw error('Event listener needs an event consumer.');
    if (this.closing) throw error('Event receivers are closing.', 'EVENTS_CLOSING');
    if (signal.stopped) return Promise.resolve();
    let state = this.histories.get(settings.listenerId);
    if (state?.owner) throw error('This event listener is still running or awaiting cleanup.', 'EVENTS_BUSY');
    if (state && state.settings.protocol !== settings.protocol) throw error('Remove the stopped listener before changing its protocol.');
    if (this.owners.size >= LIMITS.listeners) throw error('Stop a listener before starting another (limit 4).', 'EVENTS_LIMIT');
    if (!state && this.histories.size >= LIMITS.histories) throw error('Remove an unused listener history before adding another (limit 8).', 'EVENTS_LIMIT');
    const socket = this.createSocket(net.isIP(settings.bindAddress) === 6 ? 'udp6' : 'udp4');
    state ||= { id: settings.listenerId, settings, records: [], bytes: 0, sequence: 0, counters: counters() };
    state.settings = settings; state.status = { state: 'starting', message: 'Binding UDP listener…', startedAt: new Date().toISOString(), stoppedAt: null };
    this.histories.set(state.id, state);
    const owner = { state, socket, emit, listening: false, closed: false, stopRequested: false, closing: false, problem: null,
      pending: [], pendingBytes: 0, dirty: false, rateStart: performance.now(), rateCount: 0, closeTimer: null, closeWaiters: new Set(), removeCancel: () => {} };
    state.owner = owner; this.owners.add(owner);
    owner.task = new Promise((resolve, reject) => { owner.finish = problem => { if (owner.settled) return; owner.settled = true; if (problem) reject(problem); else resolve(); }; });
    socket.on('error', err => {
      // Native socket errors do not contain packet contents. Preserve useful
      // OS codes without ever forwarding untrusted datagram/parser text.
      owner.problem ||= error('UDP listener failed' + (typeof err.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? ' (' + err.code + ')' : '') + '.', 'EVENTS_SOCKET');
      this.requestClose(owner);
    });
    socket.on('message', (bytes, remote) => this.message(owner, bytes, remote));
    socket.on('listening', () => {
      owner.listening = true;
      if (owner.stopRequested) { owner.closing = false; this.requestClose(owner); return; }
      state.status.state = 'listening'; state.status.message = 'Listening for ' + (settings.protocol === 'syslog' ? 'syslog' : 'SNMP traps') + ' on ' + settings.bindAddress + ':' + settings.port + '.';
      this.notify(owner, 'status', this.status(state));
    });
    socket.once('close', () => {
      owner.closed = true; clearInterval(owner.flushTimer); clearTimeout(owner.closeTimer); owner.removeCancel();
      this.owners.delete(owner); state.owner = null;
      state.status.state = owner.problem ? 'error' : 'stopped'; state.status.message = owner.problem?.message || 'UDP listener stopped.'; state.status.stoppedAt = new Date().toISOString();
      this.flush(owner); this.notify(owner, 'status', this.status(state));
      for (const finish of owner.closeWaiters) finish(); owner.finish(owner.problem);
    });
    owner.flushTimer = setInterval(() => this.flush(owner), LIMITS.batchMs); owner.flushTimer.unref?.();
    this.notify(owner, 'status', this.status(state));
    owner.removeCancel = onCancel(signal, () => this.requestClose(owner));
    if (!owner.stopRequested) {
      try { socket.bind({ address: settings.bindAddress, port: settings.port, exclusive: true }); }
      catch { owner.problem ||= error('UDP listener could not bind.', 'EVENTS_SOCKET'); this.requestClose(owner); }
    }
    return owner.task;
  }
  requestClose(owner) {
    if (owner.closed) return;
    owner.stopRequested = true;
    if (owner.closing) return;
    owner.closing = true; clearTimeout(owner.closeTimer);
    owner.state.status.state = 'stopping'; owner.state.status.message = 'Closing UDP listener…';
    // Keep the timer and exact owner after an exception or missing close event.
    // Neither an exception nor the fact that bind failed proves resource release.
    owner.closeTimer = setTimeout(() => {
      owner.closing = false; clearInterval(owner.flushTimer);
      owner.state.status.state = 'cleanup-pending'; owner.state.status.message = 'UDP socket closure was not confirmed. Retry cleanup before restarting.';
      this.flush(owner); this.notify(owner, 'status', this.status(owner.state));
      owner.finish(error(owner.state.status.message, 'EVENTS_CLEANUP'));
    }, this.closeTimeoutMs);
    try { owner.socket.close(); } catch { /* Retain for close() retry and late listening/close events. */ }
  }
  waitClosed(owner) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); owner.closeWaiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, this.closeTimeoutMs + 10);
      owner.closeWaiters.add(finish); if (owner.closed) finish();
    });
  }
  async stop(id) {
    const state = this.get(id), owner = state.owner;
    if (owner) {
      owner.closing = false; this.requestClose(owner); await this.waitClosed(owner);
      if (!owner.closed) throw error('UDP socket cleanup remains pending. Retry Stop before closing this panel.', 'EVENTS_CLEANUP');
    }
    return this.status(state);
  }
  close() {
    if (this.closing) return this.closing;
    const owners = [...this.owners];
    this.closing = (async () => {
      for (const owner of owners) { owner.closing = false; this.requestClose(owner); }
      await Promise.all(owners.map(owner => this.waitClosed(owner)));
      if (this.hasOwnership) throw error('UDP socket cleanup remains pending. Retry closing KonX.', 'EVENTS_CLEANUP');
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
}

module.exports = { EventConsole, LIMITS, validate };
