'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 16 * 1024;
const MAX_DISPLAYS = 8;
const LOG_FILES = Object.freeze([
  { source: 'current', name: 'javascript-errors.log' },
  { source: 'previous', name: 'javascript-errors.previous.log' },
]);
const FEATURE_NAMES = Object.freeze(['serial', 'encryption', 'capture', 'portableUpdater', 'installedUpdater']);
const LOG_NOTICE = 'Error logs are optional. Path and credential redaction is best effort, not a guarantee. Review and edit all included text before saving or sharing.';

function prefix(text, limit) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only log text reaches this heuristic scrubber; no ambient environment is read. */
function sanitizeSupportLog(text, redactPaths = []) {
  if (typeof text !== 'string') return '';
  let result = prefix(text.slice(0, MAX_LOG_BYTES * 2), MAX_LOG_BYTES);
  const paths = Array.isArray(redactPaths) ? redactPaths.slice(0, 16).filter(value => typeof value === 'string' && value.length >= 3 &&
    value.length <= 4096 && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value))).sort((a, b) => b.length - a.length) : [];
  for (const source of paths) {
    // Stacks may contain native paths, file URLs, or JSON-escaped backslashes.
    const variants = new Set([source, source.replace(/\\/g, '/'), source.replace(/\\/g, '\\\\')]);
    for (const variant of variants) result = result.replace(new RegExp(escapeRegex(variant), 'gi'), '[private-path]');
  }
  result = result
    .replace(/-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----|$)/g, '[private-key redacted]')
    .replace(/\b(?:https?|ssh|sftp):\/\/[^\s/@]+:[^\s/@]*@/gi, match => match.slice(0, match.indexOf('://') + 3) + '[credentials]@')
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*/gi, '[authorization redacted]')
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[authorization redacted]')
    .replace(/(["']?(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[token redacted]');
  return prefix(result, MAX_LOG_BYTES);
}

function fail(code) { const error = new Error(code); error.supportCode = code; return error; }
function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}
function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }

async function readLog(io, logDir, canonicalDirectory, record, redactPaths) {
  let handle;
  try {
    const filename = path.join(logDir, record.name);
    const before = await io.lstat(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw fail('LOG_UNSAFE_PATH');
    if (typeof before.size !== 'bigint' || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('LOG_INVALID_SIZE');
    const size = Number(before.size);
    const canonicalFile = await io.realpath(filename);
    if (!samePath(path.dirname(canonicalFile), canonicalDirectory)) throw fail('LOG_UNSAFE_PATH');
    handle = await io.open(filename, 'r');
    const opened = await handle.stat({ bigint: true });
    const current = await io.lstat(filename, { bigint: true });
    if (current.isSymbolicLink() || !sameFile(before, opened) || !sameFile(before, current)) throw fail('LOG_CHANGED');
    const length = Math.min(size, MAX_LOG_BYTES), bytes = Buffer.alloc(length);
    // Read the beginning so a truncated secret/private-key entry keeps its label
    // available to redaction. Coverage explicitly says prefix, never full log.
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > length - offset) throw fail('LOG_CHANGED');
      offset += bytesRead;
    }
    if (!sameFile(opened, await handle.stat({ bigint: true }))) throw fail('LOG_CHANGED');
    // stream:true omits an incomplete UTF-8 sequence at the bounded prefix.
    const text = new TextDecoder('utf-8').decode(bytes, { stream: length < size });
    return { source: record.source, status: 'included', coverage: length < size ? 'prefix' : 'complete',
      bytesRead: length, text: sanitizeSupportLog(text, redactPaths) };
  } catch (error) {
    return { source: record.source, status: error?.supportCode || (error?.code === 'ENOENT' ? 'LOG_NOT_FOUND' : 'LOG_READ_FAILED') };
  } finally { if (handle) await handle.close(); }
}

/** Collect only named facts supplied by main; never traverse sessions or process.env. */
async function collectSupportReport(input = {}, { fs: io = fs } = {}) {
  const info = input?.info && typeof input.info === 'object' ? input.info : {};
  const omissions = new Set();
  const version = value => typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][A-Za-z0-9.-]{1,40})?$/.test(value) ? value : null;
  const choice = (value, values) => values.includes(value) ? value : 'unknown';
  const runtime = { version: version(info.version), platform: choice(info.platform, ['win32', 'darwin', 'linux', 'aix', 'freebsd', 'openbsd', 'sunos', 'android']),
    arch: choice(info.arch, ['x64', 'arm64', 'ia32', 'arm', 'ppc64', 's390x', 'riscv64', 'mips64el', 'loong64']),
    electron: version(info.electron), node: version(info.node), mode: choice(info.mode, ['installed', 'portable', 'development']) };
  if (Object.values(runtime).some(value => value === null || value === 'unknown')) omissions.add('RUNTIME_FACTS_UNAVAILABLE');
  const features = Object.fromEntries(FEATURE_NAMES.map(name => [name, typeof info.features?.[name] === 'boolean' ? info.features[name] : null]));
  if (Object.values(features).some(value => value === null)) omissions.add('FEATURE_FACTS_UNAVAILABLE');
  const counts = Object.fromEntries(['tabs', 'connections', 'jobs'].map(name => {
    const value = input?.counts?.[name];
    return [name, Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : null];
  }));
  if (Object.values(counts).some(value => value === null)) omissions.add('COUNTS_UNAVAILABLE');
  const screens = Array.isArray(input?.screens) ? input.screens : [];
  if (!Array.isArray(input?.screens)) omissions.add('DISPLAYS_UNAVAILABLE');
  if (screens.length > MAX_DISPLAYS) omissions.add('DISPLAYS_TRUNCATED');
  const displays = screens.slice(0, MAX_DISPLAYS).map(screen => {
    const width = screen?.bounds?.width ?? screen?.width, height = screen?.bounds?.height ?? screen?.height, scale = screen?.scaleFactor;
    const validSize = value => Number.isInteger(value) && value > 0 && value <= 65536 ? value : null;
    const display = { width: validSize(width), height: validSize(height), scaleFactor: typeof scale === 'number' && Number.isFinite(scale) && scale >= 0.25 && scale <= 8 ? Math.round(scale * 1000) / 1000 : null };
    if (Object.values(display).some(value => value === null)) omissions.add('DISPLAY_FACTS_UNAVAILABLE');
    return display;
  });
  const logs = { requested: input?.includeLogs === true, notice: LOG_NOTICE, entries: [] };
  if (!logs.requested) omissions.add('LOGS_NOT_REQUESTED');
  else {
    try {
      if (typeof input.logDir !== 'string' || !path.isAbsolute(input.logDir)) throw fail('LOG_DIRECTORY_UNAVAILABLE');
      const stat = await io.lstat(input.logDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('LOG_UNSAFE_PATH');
      const directory = await io.realpath(input.logDir);
      for (const record of LOG_FILES) logs.entries.push(await readLog(io, input.logDir, directory, record, input.redactPaths));
    } catch (error) { omissions.add(error?.supportCode || (error?.code === 'ENOENT' ? 'LOG_DIRECTORY_NOT_FOUND' : 'LOG_READ_FAILED')); }
  }
  const report = { schemaVersion: 1, kind: 'konx-support-report', runtime, displays, features, counts, logs,
    privacy: { automaticContents: 'Runtime versions, display sizes/scales, feature support and aggregate counts only.',
      excluded: ['environment', 'profile paths', 'session identities', 'hostnames', 'credentials', 'captured traffic', 'console and document content'],
      logRedaction: 'best-effort; review required', uploaded: false }, omissions: [...omissions] };
  if (Buffer.byteLength(JSON.stringify(report, null, 2), 'utf8') > MAX_REPORT_BYTES) throw fail('REPORT_TOO_LARGE');
  return report;
}

/** Validate the user's edited preview before opening a save dialog; do not rewrite it. */
function validateSupportExport(text) {
  if (typeof text !== 'string' || text.length > MAX_REPORT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) throw new Error('Support report must be JSON text no larger than 256 KiB.');
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('Support report is not valid JSON. Correct the preview before saving.'); }
  if (!report || Array.isArray(report) || report.schemaVersion !== 1 || report.kind !== 'konx-support-report') throw new Error('Support report must retain its kind and schemaVersion fields.');
  return text;
}

module.exports = { collectSupportReport, sanitizeSupportLog, validateSupportExport, MAX_REPORT_BYTES, MAX_LOG_BYTES, MAX_DISPLAYS };
