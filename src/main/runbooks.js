'use strict';
const net = require('node:net');
const dns = require('node:dns');
const nettools = require('./nettools');
const deviceCollector = require('./device-collector');
const LIMITS = Object.freeze({ steps: 24, inputs: 12, bytes: 65536, runMs: 300000, stepMs: 30000, deviceMs: 180000, records: 256 });
const KINDS = new Set(['dns', 'ping', 'tcp', 'device', 'checklist', 'capture']);
const fail = message => { throw Error(message); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, allowed, label) { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid ${label} fields`); }
function text(value, label, limit = 256, empty = false) { if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`Invalid ${label}`); return value; }
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || fail('Invalid runbook step/input identifier');
function host(value) {
  text(value, 'target host', 253);
  if (net.isIP(value)) return value;
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value || !value.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) || /^[0-9.]+$/.test(value)) fail('Use one IP address or DNS hostname, not a range, URL, or command');
  return value;
}
function valueForKind(value, kind) {
  if (kind === 'host') return host(value);
  if (kind === 'port') { if (!Number.isInteger(value) || value < 1 || value > 65535) fail('TCP port must be a number from 1 to 65535'); return value; }
  return text(value, 'SSH connection identifier', 128);
}
function serverValue(value) {
  if (value === undefined || value === '') return '';
  text(value, 'DNS server', 128);
  const resolver = new dns.promises.Resolver();
  try { resolver.setServers([value]); } catch { fail('DNS server must be an IP address, optionally with a port'); }
  return value;
}
function validateDefinition(value) {
  keys(value, ['schemaVersion', 'name', 'description', 'inputs', 'steps', 'timeoutMs'], 'runbook');
  if (value.schemaVersion !== 1) fail('Unsupported runbook schema version');
  const name = text(value.name, 'runbook name', 120), description = text(value.description ?? '', 'runbook description', 2000, true);
  const timeoutMs = value.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > LIMITS.runMs) fail('Runbook deadline must be 100–300000 ms');
  if (!Array.isArray(value.inputs ?? []) || (value.inputs ?? []).length > LIMITS.inputs) fail('Runbook supports at most 12 inputs');
  const seenInputs = new Map();
  const inputs = (value.inputs ?? []).map(input => {
    keys(input, ['id', 'label', 'kind', 'required'], 'runbook input'); identifier(input.id);
    if (seenInputs.has(input.id) || !['host', 'port', 'connection'].includes(input.kind) || (input.required !== undefined && typeof input.required !== 'boolean')) fail('Invalid or duplicate runbook input');
    const result = { id: input.id, label: text(input.label, 'input label', 120), kind: input.kind, required: input.required !== false }; seenInputs.set(input.id, result); return result;
  });
  function parameter(parameter, kind) {
    if (plain(parameter)) { keys(parameter, ['input'], 'input reference'); const declared = seenInputs.get(parameter.input); if (!declared || declared.kind !== kind) fail('Input reference must name a declared input with matching kind'); return { input: parameter.input }; }
    return valueForKind(parameter, kind);
  }
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > LIMITS.steps) fail('Runbook must contain 1–24 steps');
  const ids = new Set(); let devices = 0;
  const steps = value.steps.map(step => {
    if (!plain(step) || !KINDS.has(step.kind)) fail('Unsupported runbook step kind; scripts and commands are not allowed');
    const fields = ['id', 'title', 'kind', 'timeoutMs'];
    if (['dns', 'ping', 'tcp'].includes(step.kind)) fields.push('target', 'server');
    if (step.kind === 'dns') fields.push('recordType');
    if (step.kind === 'tcp') fields.push('port');
    if (step.kind === 'device') fields.push('connectionId');
    if (['checklist', 'capture'].includes(step.kind)) fields.push('instructions');
    if (step.kind === 'capture') fields.push('view');
    keys(step, fields, 'runbook step'); identifier(step.id); if (ids.has(step.id)) fail('Runbook step identifiers must be unique'); ids.add(step.id);
    const stepTimeout = step.timeoutMs ?? (step.kind === 'device' ? 120000 : 5000), maximum = step.kind === 'device' ? LIMITS.deviceMs : LIMITS.stepMs;
    if (!Number.isInteger(stepTimeout) || stepTimeout < 100 || stepTimeout > maximum) fail(`Invalid ${step.kind} step deadline`);
    const output = { id: step.id, title: text(step.title, 'step title', 200), kind: step.kind, timeoutMs: stepTimeout };
    if (['dns', 'ping', 'tcp'].includes(step.kind)) { output.target = parameter(step.target, 'host'); output.server = serverValue(step.server); }
    if (step.kind === 'dns') { output.recordType = step.recordType ?? 'A'; if (!['A', 'AAAA'].includes(output.recordType)) fail('Runbook DNS record type must be A or AAAA'); }
    if (step.kind === 'tcp') output.port = parameter(step.port, 'port');
    if (step.kind === 'device') { if (++devices > 2) fail('Runbook supports at most two device collection steps'); output.connectionId = parameter(step.connectionId, 'connection'); }
    if (['checklist', 'capture'].includes(step.kind)) output.instructions = text(step.instructions, 'manual instructions', 4000);
    if (step.kind === 'capture') { if (!['sip', 'rtp'].includes(step.view)) fail('Capture step must open SIP or RTP analysis'); output.view = step.view; }
    return output;
  });
  const result = { schemaVersion: 1, name, description, timeoutMs, inputs, steps };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.bytes) fail('Runbook exceeds the 64 KiB definition limit');
  return result;
}
function validateInputs(definition, supplied = {}) {
  if (!plain(supplied) || Object.keys(supplied).some(key => !definition.inputs.some(input => input.id === key))) fail('Runbook input values do not match its declared inputs');
  const inputs = Object.create(null);
  for (const input of definition.inputs) {
    const value = Object.hasOwn(supplied, input.id) ? supplied[input.id] : undefined;
    if (value === undefined || value === null || value === '') { if (input.required) fail(`Enter ${input.label}`); continue; }
    inputs[input.id] = valueForKind(value, input.kind);
  }
  return inputs;
}
const ref = input => ({ input });
function getTemplates() {
  return [
    { id: 'gateway', definition: { schemaVersion: 1, name: 'Client cannot reach gateway', description: 'Check reachability from this KonX computer, then inspect client addressing and optional switch evidence.', inputs: [{ id: 'gateway', label: 'Gateway IP or hostname', kind: 'host' }, { id: 'connection', label: 'Optional connected Cisco SSH session', kind: 'connection', required: false }], steps: [
      { id: 'gateway-ping', title: 'Observe an ICMP reply from the gateway', kind: 'ping', target: ref('gateway') },
      { id: 'client-addressing', title: 'Check the affected client addressing', kind: 'checklist', instructions: 'On the affected client, compare its IP address, mask, gateway, VLAN and link state with the intended network. A probe from KonX does not establish what the client can reach.' },
      { id: 'switch-inventory', title: 'Collect read-only switch evidence', kind: 'device', connectionId: ref('connection') }
    ] } },
    { id: 'application-slow', definition: { schemaVersion: 1, name: 'Application is slow', description: 'Separate name resolution and TCP reachability observations from application response time.', inputs: [{ id: 'application', label: 'Application host', kind: 'host' }, { id: 'port', label: 'Application TCP port', kind: 'port' }], steps: [
      { id: 'dns', title: 'Observe application A records', kind: 'dns', target: ref('application'), recordType: 'A' },
      { id: 'tcp', title: 'Test the selected TCP listener', kind: 'tcp', target: ref('application'), port: ref('port') },
      { id: 'ping', title: 'Observe an ICMP reply', kind: 'ping', target: ref('application') },
      { id: 'timing', title: 'Compare request timing and server evidence', kind: 'checklist', instructions: 'Use a capture of the affected request and application logs to compare DNS, connection, request and response timing. An open TCP port does not prove the application is healthy or fast.' }
    ] } },
    { id: 'phone-no-audio', definition: { schemaVersion: 1, name: 'Phone has no audio', description: 'Collect reachability observations and inspect a user-selected SIP/RTP capture. No audio diagnosis is inferred automatically.', inputs: [{ id: 'phone', label: 'Phone IP or hostname', kind: 'host' }], steps: [
      { id: 'phone-ping', title: 'Observe an ICMP reply from the phone', kind: 'ping', target: ref('phone') },
      { id: 'phone-checks', title: 'Check call and endpoint context', kind: 'checklist', instructions: 'Confirm the affected call, handset/speaker state and capture vantage point. Compare the advertised media addresses and ports with routing, NAT and firewall policy.' },
      { id: 'sip', title: 'Inspect the call ladder and SDP', kind: 'capture', view: 'sip', instructions: 'Open a capture from the affected call and inspect INVITE/answer/SDP. Record the advertised receive addresses, ports, codecs and any failures.' },
      { id: 'rtp', title: 'Inspect RTP directions and source packets', kind: 'capture', view: 'rtp', instructions: 'Inspect mapped RTP streams, capture sequence gaps and jitter; listen only to supported unencrypted media when appropriate. A single observed direction does not establish one-way audio.' }
    ] } }
  ].map(template => ({ id: template.id, definition: validateDefinition(template.definition) }));
}
async function queryDns(target, type, server, signal, timeoutMs) {
  const resolver = new dns.promises.Resolver({ timeout: Math.min(timeoutMs, 4000), tries: 1 });
  const result = await nettools.dnsLookup({ name: target, type, server, resolver, signal, timeout: Math.min(timeoutMs, 4000), tries: 1 });
  return { ...result, records: result.records.slice(0, LIMITS.records), limited: result.records.length > LIMITS.records };
}
async function resolvedTarget(target, server, signal, timeoutMs) {
  if (net.isIP(target)) return { address: target, literal: true, lookups: [] };
  const lookups = [];
  for (const type of ['A', 'AAAA']) {
    if (signal.aborted) break;
    const result = await queryDns(target, type, server, signal, timeoutMs); lookups.push(result);
    const address = result.records.find(record => net.isIP(record.value))?.value;
    if (address) return { address, literal: false, lookups };
  }
  return { address: null, literal: false, lookups };
}
async function execute(step, inputs, signal, connections) {
  const read = value => { if (plain(value)) { if (!Object.hasOwn(inputs, value.input)) fail(`Optional input ${value.input} was not provided; step skipped`); return inputs[value.input]; } return value; };
  for (const field of ['target', 'port', 'connectionId']) if (Object.hasOwn(step, field)) read(step[field]);
  if (signal.aborted) return { status: 'unknown', summary: 'Step cancelled before execution.', evidence: {} };
  if (step.kind === 'checklist') return { status: 'unknown', summary: 'Manual evidence is required.', evidence: { instructions: step.instructions } };
  if (step.kind === 'capture') return { status: 'unknown', summary: 'Inspect an existing capture; this step has not analyzed it.', evidence: { instructions: step.instructions }, action: { type: 'capture', view: step.view } };
  if (step.kind === 'device') {
    const connectionId = read(step.connectionId), childSignal = { stopped: signal.aborted, onStop: null };
    const cancel = () => { childSignal.stopped = true; childSignal.onStop?.(); };
    signal.addEventListener('abort', cancel, { once: true });
    let report;
    try { await deviceCollector.run({ connectionIds: [connectionId], profile: 'inventory' }, (kind, value) => { if (kind === 'report') report = value; }, childSignal, connections); }
    finally { signal.removeEventListener('abort', cancel); }
    const devices = (report?.devices ?? []).map(device => ({ id: device.id, label: device.label, host: device.host, collectedAt: device.collectedAt, coverage: device.coverage, warnings: device.warnings.slice(0, 32), interfaceCount: device.facts.interfaces.length, vlanCount: device.facts.vlans.length,
      commands: device.commands.map(command => ({ id: command.id, status: command.status, ...(command.error ? { error: command.error } : {}) })) }));
    const complete = devices.length > 0 && devices.every(device => device.coverage.length && device.coverage.every(row => row.complete));
    return { status: complete ? 'pass' : 'unknown', summary: complete ? 'Read-only inventory was collected; this is not a device health verdict.' : 'Device collection was unavailable or incomplete.', evidence: { connectionId, devices, rawOutputIncluded: false } };
  }
  const target = read(step.target);
  if (step.kind === 'dns') {
    if (net.isIP(target)) return { status: 'unknown', summary: 'The target is a literal IP address; no DNS query was needed.', evidence: { target, literal: true } };
    const result = await queryDns(target, step.recordType, step.server, signal, step.timeoutMs);
    const status = result.records.length ? 'pass' : result.errors?.some(error => /ENOTFOUND|ENODATA/.test(error)) ? 'fail' : 'unknown';
    return { status, summary: result.records.length ? `Observed ${result.records.length} ${step.recordType} record(s).` : 'No requested DNS records were observed.', evidence: { target, recordType: step.recordType, ...result } };
  }
  const resolution = await resolvedTarget(target, step.server, signal, step.timeoutMs);
  if (!resolution.address) return { status: 'unknown', summary: 'No IP address was resolved; the probe was not started.', evidence: { target, resolution } };
  if (signal.aborted) return { status: 'unknown', summary: 'Probe cancelled before execution.', evidence: { target, resolution } };
  if (step.kind === 'ping') {
    const result = await nettools.pingOnce(resolution.address, { timeout: Math.min(step.timeoutMs, 5000), signal });
    return { status: result.ok ? 'pass' : 'unknown', summary: result.ok ? 'An ICMP echo reply was observed from this KonX computer.' : 'No ICMP echo reply was observed; this does not prove the host is down.', evidence: { target, resolution, ...result } };
  }
  const port = read(step.port), result = await nettools.probePort(resolution.address, port, { timeout: Math.min(step.timeoutMs, 10000), banner: false, signal });
  return { status: result.state === 'open' ? 'pass' : result.state === 'closed' ? 'fail' : 'unknown', summary: result.state === 'open' ? 'The selected TCP listener accepted a connection; application health is unknown.' : result.state === 'closed' ? 'The selected TCP connection was refused.' : 'TCP reachability was not established.', evidence: { target, port, resolution, ...result } };
}
async function run(params, emit, signal, connections) {
  keys(params, ['definition', 'inputs'], 'runbook request');
  const definition = validateDefinition(params.definition), inputs = validateInputs(definition, params.inputs);
  const startedAt = new Date().toISOString(), steps = [];
  let controller, expired = false;
  const stop = () => controller?.abort();
  signal.onStop = stop;
  const overall = setTimeout(() => { expired = true; stop(); }, definition.timeoutMs);
  try {
    for (const [index, step] of definition.steps.entries()) {
      if (signal.stopped || expired) {
        steps.push({ id: step.id, title: step.title, kind: step.kind, status: 'unknown', summary: signal.stopped ? 'Not run: runbook was stopped.' : 'Not run: runbook deadline reached.', evidence: {}, startedAt: null, finishedAt: null, durationMs: 0, skipped: true }); continue;
      }
      emit('progress', { phase: step.title, stepId: step.id, index, total: definition.steps.length });
      controller = new AbortController();
      if (signal.stopped || expired) controller.abort();
      const start = Date.now(); let timedOut = false, outcome;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, step.timeoutMs);
      try { outcome = await execute(step, inputs, controller.signal, connections); }
      catch (error) { outcome = { status: 'unknown', summary: error.message, evidence: { error: error.message } }; }
      finally { clearTimeout(timer); }
      if (controller.signal.aborted) outcome = { ...outcome, status: 'unknown', summary: signal.stopped ? 'Step stopped by the user.' : expired ? 'Runbook deadline reached.' : timedOut ? 'Step deadline reached.' : 'Step cancelled.', incomplete: true };
      const result = { id: step.id, title: step.title, kind: step.kind, ...outcome, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - start };
      steps.push(result); emit('step', result); controller = null;
    }
  } finally { clearTimeout(overall); if (signal.onStop === stop) signal.onStop = null; }
  const report = { schemaVersion: 1, kind: 'runbook', name: definition.name, startedAt, finishedAt: new Date().toISOString(), steps, stopped: !!signal.stopped, complete: !signal.stopped && !expired && !steps.some(step => step.incomplete || step.skipped),
    warnings: ['Probes originate from this KonX computer. Results do not establish the affected client path or diagnose the root cause.', 'Manual and capture steps require user observations. DNS uses a dedicated DNS resolver; OS hosts-file/SYSTEM lookup is not used.', 'Device evidence is a bounded coverage summary; raw CLI output is not included in this runbook report.', ...(expired ? ['Runbook deadline reached.'] : [])] };
  emit('report', report); return report;
}
module.exports = { LIMITS, validateDefinition, validateInputs, getTemplates, run };
