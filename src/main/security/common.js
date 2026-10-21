'use strict';

const STATUSES = new Set(['pass', 'warning', 'fail', 'unknown', 'info']);
const SEVERITIES = new Set(['high', 'medium', 'low', 'info']);
const bounded = (value, max = 4000) => String(value ?? '').slice(0, max);

function finding({ id, title, status = 'unknown', severity = 'medium', evidence = '', remediation = '', confidence = 'high', reference = '' }) {
  if (!id || !title || !STATUSES.has(status) || !SEVERITIES.has(severity)) throw new TypeError('Invalid security finding');
  return {
    id: bounded(id, 120), title: bounded(title, 200), status, severity,
    evidence: bounded(evidence), remediation: bounded(remediation),
    confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
    reference: /^https:\/\//i.test(reference) ? bounded(reference, 1000) : '',
  };
}

function makeReport({ kind, title, target, checks, limitations = [] }) {
  if (!Array.isArray(checks) || checks.length > 500) throw new TypeError('Invalid security check collection');
  return {
    schemaVersion: 1, kind: bounded(kind, 50), title: bounded(title, 200), target: bounded(target, 500),
    scannedAt: new Date().toISOString(), checks: checks.map(finding),
    limitations: limitations.map((item) => bounded(item, 2000)).slice(0, 30),
  };
}

function checkCancelled(signal) {
  if (signal?.stopped) throw new Error('Assessment cancelled');
}

const cancellationGroups = new WeakMap();
// Concurrent sockets remove their own hook, in any order.
function onCancel(signal, cancel) {
  if (!signal) return () => {};
  let group = cancellationGroups.get(signal);
  if (!group) {
    group = { previous: signal.onStop, callbacks: new Set() };
    group.handler = () => {
      for (const callback of [group.previous, ...group.callbacks]) {
        try { if (typeof callback === 'function') callback(); } catch { /* All resources must be cancelled. */ }
      }
    };
    cancellationGroups.set(signal, group);
    signal.onStop = group.handler;
  }
  group.callbacks.add(cancel);
  if (signal.stopped) cancel();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    group.callbacks.delete(cancel);
    if (group.callbacks.size === 0) {
      if (signal.onStop === group.handler) signal.onStop = group.previous;
      cancellationGroups.delete(signal);
    }
  };
}

module.exports = { finding, makeReport, checkCancelled, onCancel };
