'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const API = 'https://api.github.com/repos/256kMagic/KonX/releases';
const DOWNLOAD = 'https://github.com/256kMagic/KonX/releases/download';
const HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_JSON = 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
const MAX_EXE = 512 * 1024 * 1024;
const IDLE_MS = 30000;
const TOTAL_MS = 15 * 60 * 1000;

class UpdateError extends Error {
  constructor(message, code = 'update') { super(message); this.code = code; }
}
const cancelled = () => new UpdateError('Update cancelled.', 'cancelled');
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) throw new UpdateError('Updates require a stable application version.');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new UpdateError('GitHub returned an invalid download address.'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new UpdateError('GitHub redirected the update outside the allowed download service.');
  }
  return url;
}
function releaseInfo(value, current, mode) {
  if (!record(value) || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== 'string' ||
      typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at)) || Date.parse(value.published_at) > Date.now()) {
    throw new UpdateError('GitHub did not return a published stable release.');
  }
  const version = value.tag_name.replace(/^v/, '');
  if (!versionParts(version)) throw new UpdateError('The release has an unsupported version tag.');
  if (!newer(version, current)) return { version, current: true };
  if (!Array.isArray(value.assets) || value.assets.length > 2000) throw new UpdateError('The release asset list is invalid.');
  const filename = mode === 'installed' ? `KonX-Setup-${version}.exe` : `KonX-${version}-portable.exe`;
  const asset = (name, maximum) => {
    const found = value.assets.filter((entry) => record(entry) && entry.name === name);
    if (found.length !== 1) throw new UpdateError(`The release must contain exactly one ${name}.`);
    const item = found[0];
    if (item.state !== 'uploaded' || !Number.isSafeInteger(item.id) || item.id <= 0 || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > maximum ||
        item.browser_download_url !== `${DOWNLOAD}/${value.tag_name}/${name}`) throw new UpdateError(`The release asset ${name} is invalid.`);
    // Numeric asset IDs pin these requests even if the latest release or tag changes.
    return { name, size: item.size, url: `${API}/assets/${item.id}` };
  };
  return { version, executable: asset(filename, MAX_EXE), manifest: asset('SHA256SUMS.txt', MAX_MANIFEST) };
}
function manifestHash(bytes, filename) {
  const contents = bytes.toString('utf8').replace(/^\uFEFF/, '');
  let hash;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-fA-F]{64}) [ *]([^\r\n]+)$/.exec(line);
    if (!match) throw new UpdateError('The release checksum manifest is invalid.');
    if (match[2] !== filename) continue;
    if (hash) throw new UpdateError('The checksum manifest contains duplicate update entries.');
    hash = match[1].toLowerCase();
  }
  if (!hash) throw new UpdateError('The checksum manifest does not contain this update.');
  return hash;
}

class UpdateManager {
  constructor({ version, mode = 'unsupported', reason = '', cacheDir, onState = () => {}, request = https.request }) {
    if (!cacheDir || !path.isAbsolute(cacheDir) || typeof request !== 'function' || typeof onState !== 'function' || !['installed', 'portable', 'unsupported'].includes(mode)) {
      throw new TypeError('Valid update storage, mode, callback, and HTTPS transport are required');
    }
    this.version = version;
    this.mode = mode;
    this.supported = mode !== 'unsupported' && Boolean(versionParts(version));
    this.reason = reason || 'Updates are available in the Windows x64 installed and portable applications.';
    this.cacheDir = cacheDir;
    this.request = request;
    this.onState = onState;
    this.active = null;
    this.cancelling = null;
    this.operation = null;
    this.owned = null;
    this.ready = null;
    this.state = { status: 'idle', message: this.supported ? 'Check for a newer KonX release.' : this.reason };
  }

  snapshot() { return { supported: this.supported, mode: this.mode, currentVersion: this.version, ...this.state }; }
  _state(status, message, extra = {}) {
    this.state = { status, message, ...extra };
    try { this.onState(this.snapshot()); } catch { /* UI listeners do not own download lifecycle. */ }
  }
  _check(op) { if (op.controller.signal.aborted) throw op.controller.signal.reason; }
  _operation(work, kind = 'download') {
    const op = { controller: new AbortController(), resources: new Set(), kind };
    op.controller.signal.addEventListener('abort', () => {
      for (const resource of op.resources) resource.destroy?.(op.controller.signal.reason);
    });
    const timer = setTimeout(() => op.controller.abort(new UpdateError('The update exceeded the 15 minute time limit.')), TOTAL_MS);
    this.operation = op;
    this.active = Promise.resolve().then(() => work(op)).finally(() => {
      clearTimeout(timer);
      for (const resource of op.resources) resource.destroy?.();
      if (this.operation === op) { this.operation = null; this.active = null; }
    });
    return this.active;
  }

  start() {
    if (this.cancelling) return this.cancelling;
    if (this.active) return this.operation.kind === 'download' ? this.active : this.active.then(() => this.snapshot(), () => this.snapshot());
    if (!this.supported) { this._state('error', this.reason); return Promise.resolve(this.snapshot()); }
    if (this.ready) return Promise.resolve(this.snapshot());
    return this._operation(async (op) => {
      try {
        await this._cleanup();
        this._check(op);
        this._state('checking', 'Checking the latest published KonX release…');
        const raw = await this._transfer(`${API}/latest`, { limit: MAX_JSON, accept: 'application/vnd.github+json' }, op);
        let value;
        try { value = JSON.parse(raw.toString('utf8')); } catch { throw new UpdateError('GitHub returned invalid release information.'); }
        const release = releaseInfo(value, this.version, this.mode);
        this._check(op);
        if (release.current) {
          this._state('current', 'This KonX version is current.');
          this._check(op);
          return this.snapshot();
        }
        const bytes = await this._transfer(release.manifest.url, { limit: MAX_MANIFEST, expectedSize: release.manifest.size }, op);
        const sha256 = manifestHash(bytes, release.executable.name);
        this._check(op);
        await fs.promises.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
        const root = await fs.promises.realpath(this.cacheDir);
        const dir = await fs.promises.mkdtemp(path.join(root, 'konx-update-'));
        // Cleanup is restricted to these two files and this exact directory.
        this.owned = { dir, partial: path.join(dir, 'download.part'), file: path.join(dir, release.executable.name) };
        const directory = await fs.promises.lstat(dir);
        this.owned.identity = { dev: directory.dev, ino: directory.ino };
        this._check(op);
        let lastPercent = -1;
        const progress = (downloaded) => {
          const percent = Math.floor(downloaded * 100 / release.executable.size);
          if (percent === lastPercent) return;
          lastPercent = percent;
          this._state('downloading', `Downloading KonX ${release.version}…`, { version: release.version, downloaded, total: release.executable.size, percent });
        };
        progress(0);
        await this._transfer(release.executable.url, { limit: MAX_EXE, expectedSize: release.executable.size, file: this.owned.partial, progress }, op);
        this._check(op);
        this._state('verifying', 'Verifying the downloaded update…', { version: release.version });
        const candidate = { file: this.owned.partial, sha256, size: release.executable.size, version: release.version, mode: this.mode };
        await this._verify(candidate, op);
        this._check(op);
        await fs.promises.rename(this.owned.partial, this.owned.file);
        this._check(op);
        this.ready = { ...candidate, file: this.owned.file };
        this._state('ready', `KonX ${release.version} is downloaded and verified.`, { version: release.version, total: candidate.size, downloaded: candidate.size, percent: 100 });
        this._check(op);
      } catch (error) { await this._failed(error, op); }
      return this.snapshot();
    });
  }

  cancel() {
    if (this.cancelling) return this.cancelling;
    const active = this.active;
    this.operation?.controller.abort(cancelled());
    const stop = async () => {
      if (active) try { await active; } catch { /* getReady rejects after updating public state. */ }
      // Cancellation can arrive after the work resolves but before its finalizer.
      // Clear any just-published candidate as well as an in-progress download.
      this.ready = null;
      try { await this._cleanup(); if (this.state.status !== 'cancelled') this._state('cancelled', 'Update cancelled.'); }
      catch { this._state('error', 'Update cancelled, but temporary files could not be removed. Retry to clean them up.'); }
      return this.snapshot();
    };
    const work = active ? Promise.resolve().then(stop) : this._operation(stop, 'cancel');
    const done = work.finally(() => { if (this.cancelling === done) this.cancelling = null; });
    this.cancelling = done;
    return done;
  }

  async getReady() {
    if (this.active || this.cancelling) throw new UpdateError('An update operation is still running.');
    if (!this.ready) throw new UpdateError('Download and verify an update first.');
    const candidate = { ...this.ready };
    return this._operation(async (op) => {
      try {
        this._state('verifying', 'Rechecking the update before installation…', { version: candidate.version });
        await this._verify(candidate, op);
        this._check(op);
        this._state('ready', `KonX ${candidate.version} is downloaded and verified.`, { version: candidate.version, total: candidate.size, downloaded: candidate.size, percent: 100 });
        this._check(op);
        return candidate;
      } catch (error) {
        await this._failed(error, op);
        throw new UpdateError(this.state.message, this.state.status === 'cancelled' ? 'cancelled' : 'update');
      }
    }, 'verify');
  }

  async _failed(error, op) {
    this.ready = null;
    try { await this._cleanup(); }
    catch { this._state('error', 'The update stopped, but temporary files could not be removed. Retry to clean them up.'); return; }
    if (op?.controller.signal.aborted) error = op.controller.signal.reason;
    this._state(error?.code === 'cancelled' ? 'cancelled' : 'error', error instanceof UpdateError ? error.message : 'The update could not be saved or verified. Check available disk space and retry.');
  }

  async _cleanup() {
    const owned = this.owned;
    if (!owned) return;
    const directory = await this._directory(owned);
    if (!directory) { if (this.owned === owned) this.owned = null; return; }
    for (const file of [owned.partial, owned.file]) {
      if (path.dirname(file) !== owned.dir) throw new UpdateError('Invalid update storage ownership.');
      try { await fs.promises.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { await fs.promises.rmdir(owned.dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.owned === owned) this.owned = null;
  }

  async _directory(owned) {
    let stat;
    try { stat = await fs.promises.lstat(owned.dir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(owned.dir) !== owned.dir ||
        (owned.identity && (stat.dev !== owned.identity.dev || stat.ino !== owned.identity.ino))) {
      throw new UpdateError('The temporary update directory was replaced. Its files were not removed.');
    }
    return stat;
  }

  async _verify(candidate, op) {
    this._check(op);
    if (!this.owned || ![this.owned.partial, this.owned.file].includes(candidate.file) || !await this._directory(this.owned)) {
      throw new UpdateError('The downloaded update is no longer in its original directory.');
    }
    const before = await fs.promises.lstat(candidate.file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== candidate.size) throw new UpdateError('The downloaded update has an invalid file size or type. Download it again.');
    const handle = await fs.promises.open(candidate.file, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== candidate.size) throw new UpdateError('The downloaded update changed during verification.');
      const hash = crypto.createHash('sha256');
      let size = 0;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        this._check(op);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > candidate.size) throw new UpdateError('The downloaded update changed during verification.');
        hash.update(buffer.subarray(0, bytesRead));
      }
      this._check(op);
      const after = await handle.stat();
      const current = await fs.promises.lstat(candidate.file);
      if (size !== candidate.size || hash.digest('hex') !== candidate.sha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || !current.isFile() || current.isSymbolicLink()) {
        throw new UpdateError('The update checksum did not match the release. Download it again.');
      }
    } finally { await handle.close(); }
  }

  _response(url, accept, op) {
    this._check(op);
    return new Promise((resolve, reject) => {
      let settled = false;
      const signal = op.controller.signal;
      const finish = (error, response) => {
        if (settled) { response?.destroy(); return; }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(response);
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => {
        const error = new UpdateError('GitHub did not respond within 30 seconds. Retry the update.');
        finish(error);
        req?.destroy();
      }, IDLE_MS);
      let req;
      signal.addEventListener('abort', abort, { once: true });
      try {
        req = this.request({ protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'GET',
          headers: { Accept: accept, 'Accept-Encoding': 'identity', 'User-Agent': 'KonX-Updater', 'X-GitHub-Api-Version': '2022-11-28' },
          rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
        }, (res) => {
          res.on('error', () => {});
          op.resources.add(res);
          if (signal.aborted) { res.destroy(signal.reason); finish(signal.reason); return; }
          finish(null, res);
        });
        op.resources.add(req);
        req.on('error', () => finish(signal.aborted ? signal.reason : new UpdateError('Unable to connect securely to GitHub. Check network access and retry.')));
        if (signal.aborted) { req.destroy(signal.reason); finish(signal.reason); }
        else req.end();
      } catch { finish(new UpdateError('Unable to connect securely to GitHub. Check network access and retry.')); }
    });
  }

  async _transfer(initial, { limit, expectedSize, file, progress, accept = 'application/octet-stream' }, op) {
    let url = allowedUrl(initial);
    let res;
    for (let redirects = 0; ; redirects++) {
      this._check(op);
      res = await this._response(url, accept, op);
      this._check(op);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers?.location;
        res.destroy(); op.resources.delete(res);
        if (redirects >= 5 || typeof location !== 'string' || location.length > 16384) throw new UpdateError('GitHub returned too many or invalid download redirects.');
        let next;
        try { next = new URL(location, url).href; } catch { throw new UpdateError('GitHub returned an invalid download redirect.'); }
        url = allowedUrl(next);
        continue;
      }
      if (res.statusCode !== 200) {
        res.destroy();
        if (res.statusCode === 403 || res.statusCode === 429) throw new UpdateError('GitHub denied or rate-limited the update request. Try again later.');
        if (res.statusCode === 404) throw new UpdateError('The published release or update file is unavailable. Try again later.');
        throw new UpdateError('GitHub could not complete the update download. Try again later.');
      }
      break;
    }
    const encoding = String(res.headers?.['content-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'identity') throw new UpdateError('GitHub returned an unsupported download encoding.');
    const length = res.headers?.['content-length'];
    if (length !== undefined && (!/^\d+$/.test(String(length)) || !Number.isSafeInteger(Number(length)) || Number(length) > limit || (expectedSize !== undefined && Number(length) !== expectedSize))) {
      throw new UpdateError('The update response has an invalid size.');
    }
    let handle, timer;
    const chunks = [];
    let bytes = 0;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => res.destroy(new UpdateError('The update download stalled for 30 seconds. Retry the update.')), IDLE_MS);
    };
    try {
      if (file) handle = await fs.promises.open(file, 'wx', 0o600);
      this._check(op);
      arm();
      for await (const chunk of res) {
        this._check(op);
        arm();
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > limit || (expectedSize !== undefined && bytes > expectedSize)) throw new UpdateError('The update download exceeded its expected size.');
        if (handle) {
          let offset = 0;
          while (offset < data.length) {
            this._check(op);
            const result = await handle.write(data, offset, data.length - offset);
            if (!result.bytesWritten) throw new UpdateError('The update could not be written to disk.');
            offset += result.bytesWritten;
          }
        } else chunks.push(data);
        progress?.(bytes);
      }
      this._check(op);
      if ((expectedSize !== undefined && bytes !== expectedSize) || (length !== undefined && bytes !== Number(length))) throw new UpdateError('The update download was incomplete. Retry the update.');
      if (handle) await handle.sync();
      return file ? undefined : Buffer.concat(chunks, bytes);
    } catch (error) {
      this._check(op);
      if (error instanceof UpdateError) throw error;
      throw new UpdateError('The update download was interrupted. Check the network and available disk space, then retry.');
    } finally {
      clearTimeout(timer);
      res.destroy(); op.resources.delete(res);
      if (handle) await handle.close();
    }
  }
}

module.exports = { UpdateManager };
