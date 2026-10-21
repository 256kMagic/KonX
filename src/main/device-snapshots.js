'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { analyzeDevices, configSections } = require('./device-analysis');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SNAPSHOTS = 500;
const MAX_LIST_BYTES = 64 * 1024 * 1024;
const MAX_CHANGES = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = message => { throw new Error(message); };
const validId = id => typeof id === 'string' && UUID.test(id) || fail('Invalid snapshot identifier');
const labelOf = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : fail('Enter a snapshot label of 1–256 characters');
const validDate = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));

class SnapshotStore {
  constructor(userDataDir, options = {}) {
    if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) throw new Error('Snapshot storage requires an absolute profile directory');
    this.directory = path.join(userDataDir, 'device-snapshots');
    this.io = options.fs || fs;
    this.queue = Promise.resolve();
  }
  async ready() {
    try { await this.io.mkdir(this.directory, { recursive: true }); }
    catch (error) { throw new Error('Cannot create snapshot directory: ' + error.message); }
    const stat = await this.io.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Snapshot directory must be a real local directory');
  }
  file(id) { validId(id); return path.join(this.directory, id + '.json'); }
  async read(id) {
    const file = this.file(id), stat = await this.io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Snapshot is not a regular file');
    if (stat.size > MAX_FILE_BYTES) throw new Error('Snapshot exceeds the 20 MiB file limit');
    const handle = await this.io.open(file, 'r');
    let data;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== stat.size || (opened.ino && stat.ino && opened.ino !== stat.ino) || opened.dev !== stat.dev) throw new Error('Snapshot changed while opening');
      const buffer = Buffer.alloc(stat.size + 1);
      let read = 0;
      while (read < buffer.length) { const part = await handle.read(buffer, read, buffer.length - read, null); if (!part.bytesRead) break; read += part.bytesRead; }
      if (read !== stat.size) throw new Error('Snapshot changed while reading');
      data = buffer.subarray(0, read).toString('utf8');
    } finally { await handle.close(); }
    let value;
    try { value = JSON.parse(data); } catch { throw new Error('Snapshot JSON is malformed'); }
    if (value?.schemaVersion !== 1 || value.id !== id || !validDate(value.savedAt)) throw new Error('Snapshot identity or schema is invalid');
    const label = labelOf(value.label), report = analyzeDevices(value.report);
    return { id, label, savedAt: value.savedAt, report, bytes: stat.size };
  }
  summary(record) {
    return { id: record.id, label: record.label, savedAt: record.savedAt, collectedAt: record.report.collectedAt, deviceCount: record.report.devices.length,
      includesConfiguration: record.report.devices.some(d => d.commands.some(c => c.id === 'runningConfig' && c.output)), bytes: record.bytes };
  }
  async list() {
    await this.ready();
    const entries = await this.io.readdir(this.directory), snapshots = [], issues = [];
    let examinedBytes = 0, examined = 0;
    for (const name of entries.sort()) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) { issues.push({ file: name, message: 'Unrecognized file was not loaded.' }); continue; }
      const id = name.slice(0, -5);
      if (++examined > MAX_SNAPSHOTS) { issues.push({ id, file: name, message: 'Snapshot listing exceeds the 500-file limit.' }); continue; }
      try {
        const stat = await this.io.lstat(this.file(id));
        if (examinedBytes + stat.size > MAX_LIST_BYTES) { issues.push({ id, file: name, message: 'Listing byte budget reached. This snapshot was not validated; load it individually.' }); continue; }
        examinedBytes += stat.size;
        snapshots.push(this.summary(await this.read(id)));
      } catch (error) { issues.push({ id, file: name, message: error.message }); }
    }
    snapshots.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
    return { snapshots, issues };
  }
  async get(id) { await this.ready(); const { bytes, ...record } = await this.read(id); return record; }
  save(input) {
    const operation = this.queue.then(() => this.saveOnce(input));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async saveOnce(input) {
    await this.ready();
    const label = labelOf(input?.label), report = analyzeDevices(input?.report);
    const entries = await this.io.readdir(this.directory);
    if (entries.filter(n => n.endsWith('.json') && UUID.test(n.slice(0, -5))).length >= MAX_SNAPSHOTS) throw new Error('Snapshot store has reached its 500-file limit');
    const id = crypto.randomUUID(), savedAt = new Date().toISOString();
    const record = { schemaVersion: 1, id, label, savedAt, report };
    const data = JSON.stringify(record, null, 2) + '\n';
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_FILE_BYTES) throw new Error('Serialized snapshot exceeds the 20 MiB file limit');
    const file = this.file(id), temp = path.join(this.directory, id + '.tmp');
    let handle, created = false;
    try {
      handle = await this.io.open(temp, 'wx', 0o600); created = true;
      await handle.writeFile(data, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      // Linking a fully flushed owned temporary file publishes atomically and
      // fails if a destination exists; immutable snapshots are never replaced.
      await this.io.link(temp, file);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) await this.io.unlink(temp).catch(() => {});
    }
    return this.summary({ ...record, bytes });
  }
  async remove(id) {
    await this.ready(); const file = this.file(id), stat = await this.io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Snapshot is not a regular file');
    await this.io.unlink(file); return { removed: id };
  }
}

function hostIdentity(device) {
  if (!device.host || !Number.isInteger(device.port)) return null;
  let host = device.host.trim().replace(/\.$/, '').toLowerCase();
  if (!host || /\s/.test(host)) return null;
  if (net.isIP(host) === 6) host = new URL('http://[' + host + ']').hostname.slice(1, -1);
  return `${host}|${device.port}`;
}
function source(device, row) { return row?.source ? { deviceId: device.id, ...row.source } : null; }
function stableRows(rows, key) {
  const groups = new Map();
  for (const row of rows) { const id = key(row); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
  return groups;
}
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key] ?? null]));
const coverage = (device, commands) => commands.every(id => device.coverage.some(c => c.commandId === id && c.complete));
const compareValue = value => JSON.stringify(value);

function compareSnapshots(before, after, devicePairs = []) {
  if (!before || !after) throw new Error('Choose two snapshots');
  const b = analyzeDevices(before.report), a = analyzeDevices(after.report);
  if (!Array.isArray(devicePairs) || devicePairs.length > 16) throw new Error('Invalid explicit device pairs');
  const result = { schemaVersion: 1, kind: 'device-snapshot-comparison', before: pick(before, ['id', 'label', 'savedAt']), after: pick(after, ['id', 'label', 'savedAt']), devices: [], changes: [], unmatched: [], warnings: [], sensitive: false, summary: { added: 0, removed: 0, changed: 0, unknown: 0, comparedDevices: 0 } };
  const usedBefore = new Set(), usedAfter = new Set(), pairs = [];
  for (const pair of devicePairs) {
    const bd = b.devices.find(d => d.id === pair?.beforeDeviceId), ad = a.devices.find(d => d.id === pair?.afterDeviceId);
    if (!bd || !ad || usedBefore.has(bd.id) || usedAfter.has(ad.id)) throw new Error('Explicit device pairs must identify distinct devices in each snapshot');
    usedBefore.add(bd.id); usedAfter.add(ad.id); pairs.push({ bd, ad, pairing: 'manual' });
  }
  const beforeGroups = stableRows(b.devices.filter(d => !usedBefore.has(d.id)), hostIdentity), afterGroups = stableRows(a.devices.filter(d => !usedAfter.has(d.id)), hostIdentity);
  for (const [identity, rows] of beforeGroups) {
    const other = afterGroups.get(identity) || [];
    if (identity && rows.length === 1 && other.length === 1) { pairs.push({ bd: rows[0], ad: other[0], pairing: 'identity' }); usedBefore.add(rows[0].id); usedAfter.add(other[0].id); }
  }
  for (const [side, devices, used] of [['before', b.devices, usedBefore], ['after', a.devices, usedAfter]]) for (const d of devices) if (!used.has(d.id)) result.unmatched.push({ side, deviceId: d.id, deviceLabel: d.label, reason: hostIdentity(d) ? 'No unique matching host and SSH port. Choose an explicit pair to compare this device.' : 'Host or SSH port identity is unknown. Choose an explicit pair to compare this device.' });
  const add = change => {
    if (result.changes.length >= MAX_CHANGES) { if (!result.warnings.includes('Change display limited to 10,000 entries.')) result.warnings.push('Change display limited to 10,000 entries.'); return; }
    result.changes.push(change); result.summary[change.status]++;
  };
  const categories = [
    { name: 'interfaces', commands: ['interfaces', 'interfaceStatus'], key: r => r.name, value: r => pick(r, ['name', 'status', 'protocol', 'description', 'vlan', 'duplex', 'speed', 'inputErrors', 'crc', 'outputErrors']) },
    { name: 'vlans', commands: ['vlans'], key: r => String(r.id), value: r => ({ ...pick(r, ['id', 'name', 'status']), ports: [...r.ports].sort() }) },
    { name: 'neighbors', commands: ['cdp', 'lldp'], key: r => [r.protocol, r.localInterface, r.deviceId || r.managementAddress].join('|'), value: r => pick(r, ['protocol', 'deviceId', 'managementAddress', 'localInterface', 'remoteInterface', 'capabilities']) },
    { name: 'routes', commands: ['routes'], key: r => [r.prefix, r.protocol, r.nextHop, r.interface].join('|'), value: r => pick(r, ['prefix', 'protocol', 'distance', 'metric', 'nextHop', 'interface']) },
    { name: 'configuration', commands: ['runningConfig'], key: r => r.key, value: r => ({ heading: r.heading, lines: r.lines }) },
  ];
  for (const { bd, ad, pairing } of pairs) {
    const detail = { beforeDeviceId: bd.id, afterDeviceId: ad.id, deviceLabel: ad.label, host: ad.host, port: ad.port, pairing, status: 'compared', warnings: [] };
    result.devices.push(detail); result.summary.comparedDevices++;
    if (pairing === 'manual' && hostIdentity(bd) !== hostIdentity(ad)) detail.warnings.push('This explicit pair has different or incomplete connection identities.');
    if (bd.collectedAt && ad.collectedAt && Date.parse(bd.collectedAt) > Date.parse(ad.collectedAt)) detail.warnings.push('The selected after observation is older than the before observation.');
    for (const category of categories) {
      const base = { deviceId: ad.id, deviceLabel: ad.label, category: category.name };
      if (!coverage(bd, category.commands) || !coverage(ad, category.commands)) {
        detail.status = 'partial';
        add({ ...base, status: 'unknown', identity: category.name, before: null, after: null, beforeSource: null, afterSource: null, reason: 'Required command output is missing, incomplete, rejected, or unrecognized. No removals are inferred.' }); continue;
      }
      const rows = d => category.name === 'configuration'
        ? configSections(d.commands.find(c => c.id === 'runningConfig').output).map(r => ({ ...r, source: { commandId: 'runningConfig', line: r.line } }))
        : d.facts[category.name];
      const bg = stableRows(rows(bd), category.key), ag = stableRows(rows(ad), category.key);
      if (category.name === 'configuration') result.sensitive = true;
      for (const identity of new Set([...bg.keys(), ...ag.keys()])) {
        const br = bg.get(identity) || [], ar = ag.get(identity) || [];
        if (br.length > 1 || ar.length > 1) { detail.status = 'partial'; add({ ...base, status: 'unknown', identity, before: null, after: null, beforeSource: source(bd, br[0]), afterSource: source(ad, ar[0]), reason: 'Duplicate row or section identity prevents a unique comparison.' }); continue; }
        const bv = br[0] ? category.value(br[0]) : null, av = ar[0] ? category.value(ar[0]) : null;
        if (compareValue(bv) === compareValue(av)) continue;
        const change = { ...base, identity, status: !br.length ? 'added' : !ar.length ? 'removed' : 'changed', before: bv, after: av, beforeSource: source(bd, br[0]), afterSource: source(ad, ar[0]) };
        if (category.name === 'interfaces' && bv && av) {
          change.counterDeltas = {};
          for (const key of ['inputErrors', 'crc', 'outputErrors']) if (String(bv[key]) !== String(av[key])) {
            const valid = v => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v));
            if (!valid(bv[key]) || !valid(av[key])) change.counterDeltas[key] = { delta: null, reason: 'A counter value is unknown.' };
            else {
              const difference = BigInt(av[key]) - BigInt(bv[key]);
              change.counterDeltas[key] = difference < 0n ? { delta: null, reason: 'Counter decreased; reset or wrap is possible.' } : { delta: difference <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(difference) : String(difference), reason: 'Observed counter increase between samples; interval continuity is not established.' };
            }
          }
        }
        add(change);
      }
    }
  }
  if (result.unmatched.length) result.warnings.push('Unmatched or ambiguous devices are unverified, not counted as added or removed.');
  result.warnings.push('Comparisons describe captured observations. They do not validate forwarding behavior or infer the effects of configuration changes.');
  return result;
}

module.exports = { SnapshotStore, compareSnapshots, hostIdentity, MAX_FILE_BYTES, MAX_SNAPSHOTS };
