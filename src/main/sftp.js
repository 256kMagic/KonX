'use strict';
// SFTP browsing and a transfer queue (SecureFX-style). Electron-free for testability.
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const ssh = require('./ssh');

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

function permString(mode, type) {
  const t = type === 'd' ? 'd' : type === 'l' ? 'l' : '-';
  const bits = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-';
  return t + s;
}

function p(fn) {
  return new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));
}

// A POSIX server can return names that Windows interprets as paths, streams or
// device aliases. Reject those names instead of silently changing the download.
function localDownloadName(name) {
  const invalidWindowsName = typeof name === 'string' && process.platform === 'win32' &&
    (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)/i.test(name));
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name) || invalidWindowsName) {
    throw new Error(`Remote filename cannot be saved safely on this system: ${JSON.stringify(name)}`);
  }
  return name;
}

async function checkDownloadDestination(root, destination) {
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Download destination is outside the selected local directory');
  }
  // Existing local links/junctions must not redirect a remote download elsewhere.
  // Check again just before fastGet because transfers can wait in the queue.
  let current = root;
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    try {
      const st = await fs.promises.lstat(current);
      if (st.isSymbolicLink()) throw new Error(`Download destination contains a symbolic link or junction: ${current}`);
    } catch (e) {
      if (e.code === 'ENOENT') break;
      throw e;
    }
  }
}

class SftpSession {
  constructor(id, client, sftp, session, owned, dispose) {
    this.id = id;
    this.client = client;
    this.sftp = sftp;
    this.session = session;
    this.owned = owned; // we opened the SSH connection ourselves and must close it
    this.dispose = dispose;
    this.home = '/';
  }

  async list(dir) {
    const entries = await p((cb) => this.sftp.readdir(dir, cb));
    const out = [];
    for (const e of entries) {
      if (e.filename === '.' || e.filename === '..') continue;
      const mode = e.attrs.mode || 0;
      const fmt = mode & S_IFMT;
      let type = fmt === S_IFDIR ? 'd' : fmt === S_IFLNK ? 'l' : 'f';
      let linkDir = false;
      if (type === 'l') {
        try {
          const st = await p((cb) => this.sftp.stat(posix.join(dir, e.filename), cb));
          linkDir = ((st.mode || 0) & S_IFMT) === S_IFDIR;
        } catch {}
      }
      // longname: "drwxr-xr-x    2 user  group  4096 Jan  1 00:00 name"
      const parts = (e.longname || '').split(/\s+/);
      out.push({
        name: e.filename,
        type,
        isDir: type === 'd' || linkDir,
        size: e.attrs.size || 0,
        mtime: (e.attrs.mtime || 0) * 1000,
        mode: mode & 0o7777,
        perms: permString(mode, type),
        owner: parts[2] || String(e.attrs.uid ?? ''),
        group: parts[3] || String(e.attrs.gid ?? ''),
      });
    }
    return out;
  }

  realpath(p0) {
    return p((cb) => this.sftp.realpath(p0, cb));
  }

  stat(p0) {
    return p((cb) => this.sftp.stat(p0, cb));
  }

  mkdir(dir) {
    return p((cb) => this.sftp.mkdir(dir, cb));
  }

  rename(from, to) {
    return p((cb) => this.sftp.rename(from, to, cb));
  }

  chmod(target, mode) {
    return p((cb) => this.sftp.chmod(target, mode, cb));
  }

  async remove(target) {
    const st = await p((cb) => this.sftp.lstat(target, cb));
    if (((st.mode || 0) & S_IFMT) === S_IFDIR) {
      const entries = await p((cb) => this.sftp.readdir(target, cb));
      for (const e of entries) {
        if (e.filename === '.' || e.filename === '..') continue;
        await this.remove(posix.join(target, e.filename));
      }
      await p((cb) => this.sftp.rmdir(target, cb));
    } else {
      await p((cb) => this.sftp.unlink(target, cb));
    }
  }

  async mkdirp(dir) {
    const parts = dir.split('/').filter(Boolean);
    let cur = dir.startsWith('/') ? '/' : '';
    for (const part of parts) {
      cur = cur ? posix.join(cur, part) : part;
      try {
        await this.stat(cur);
      } catch {
        await this.mkdir(cur).catch(() => {});
      }
    }
  }

  /** Open an extra SFTP channel on the same SSH connection (one per transfer worker). */
  channel() {
    return p((cb) => this.client.sftp(cb));
  }

  close() {
    if (this.dispose) return this.dispose();
    try {
      this.sftp.end();
    } catch {}
    if (this.owned) this.client.end();
  }
}

/**
 * Transfer queue. Each worker gets its own SFTP channel so a cancel can tear down
 * just that channel (fastGet/fastPut have no abort of their own).
 */
class TransferQueue {
  constructor(emit) {
    this.emit = emit;
    this.jobs = [];
    this.seq = 0;
    this.active = new Map(); // jobId -> {channel}
    this.concurrency = 2;
    this.conflictAnswers = new Map(); // batchId -> 'overwrite' | 'skip'
  }

  _update(job) {
    this.emit('xfer:update', {
      id: job.id,
      sftpId: job.sftpId,
      direction: job.direction,
      name: job.name,
      src: job.src,
      dst: job.dst,
      size: job.size,
      done: job.done,
      status: job.status,
      error: job.error,
      speed: job.speed,
    });
  }

  add(job) {
    job.id = ++this.seq;
    job.done = 0;
    job.status = 'queued';
    this.jobs.push(job);
    this._update(job);
    this._pump();
    return job.id;
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      this._update(job);
    } else if (job.status === 'running') {
      job.status = 'cancelled';
      const a = this.active.get(id);
      if (a && a.channel) {
        try {
          a.channel.end();
        } catch {}
      }
      this._update(job);
    }
  }

  cancelForSession(sftpId) {
    for (const j of this.jobs) if (j.sftpId === sftpId) this.cancel(j.id);
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  }

  _pump() {
    while (this.active.size < this.concurrency) {
      const job = this.jobs.find((j) => j.status === 'queued');
      if (!job) return;
      job.status = 'running';
      this.active.set(job.id, {});
      this._update(job);
      this._run(job).finally(() => {
        this.active.delete(job.id);
        this._pump();
      });
    }
  }

  async _run(job) {
    const started = Date.now();
    let channel;
    let stagingDir;
    let stagingFile;
    try {
      // Conflict handling happens just before the transfer so batch answers apply.
      const proceed = await job.checkConflict();
      if (job.status === 'cancelled') return;
      if (!proceed) {
        job.status = 'skipped';
        this._update(job);
        return;
      }
      channel = await job.sess.channel();
      this.active.get(job.id).channel = channel;
      // A cancel can arrive while SSH is opening the worker's channel.
      if (job.status === 'cancelled') return;
      let lastEmit = 0;
      const step = (transferred, _chunk, total) => {
        if (job.status === 'cancelled') return;
        job.done = transferred;
        job.size = total;
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          job.speed = transferred / Math.max(0.001, (now - started) / 1000);
          this._update(job);
        }
      };
      if (job.direction === 'up') {
        await p((cb) => channel.fastPut(job.src, job.dst, { step, concurrency: 32 }, cb));
        if (job.preserveTime && job.mtime) {
          const t = Math.floor(job.mtime / 1000);
          await p((cb) => channel.utimes(job.dst, t, t, cb)).catch(() => {});
        }
      } else {
        if (job.checkDestination) await job.checkDestination();
        if (job.status === 'cancelled') return;
        // fastGet truncates its local destination immediately. Keep the original
        // file intact until every byte has arrived, including on cancellation.
        stagingDir = await fs.promises.mkdtemp(path.join(path.dirname(job.dst), '.konx-download-'));
        stagingFile = path.join(stagingDir, 'download');
        if (job.status === 'cancelled') return;
        await p((cb) => channel.fastGet(job.src, stagingFile, { step, concurrency: 32 }, cb));
        if (job.status === 'cancelled') return;
        if (job.preserveTime && job.mtime) {
          const t = new Date(job.mtime);
          await fs.promises.utimes(stagingFile, t, t).catch(() => {});
        }
        if (job.checkDestination) await job.checkDestination();
        if (job.status === 'cancelled') return;
        // Commit synchronously after the final cancellation/path checks: an IPC
        // cancel must not race an already-dispatched asynchronous replacement.
        fs.renameSync(stagingFile, job.dst);
      }
      if (job.status === 'cancelled') return;
      job.done = job.size;
      job.status = 'done';
      job.speed = job.size / Math.max(0.001, (Date.now() - started) / 1000);
      this._update(job);
      job.onDone && job.onDone();
    } catch (e) {
      if (job.status !== 'cancelled') {
        job.status = 'error';
        job.error = e.message;
        this._update(job);
      }
    } finally {
      if (channel) {
        try {
          channel.end();
        } catch {}
      }
      if (stagingFile) await fs.promises.unlink(stagingFile).catch(() => {});
      if (stagingDir) await fs.promises.rmdir(stagingDir).catch(() => {});
    }
  }
}

class SftpManager {
  /**
   * deps: emit, ask, store, connections (ConnectionManager), openExternal(path), tempDir()
   */
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Map();
    this.pending = new Map();
    this.queue = new TransferQueue(deps.emit);
    this.watchers = new Map();
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('SFTP session is not open');
    return s;
  }

  /** spec: {sessionId} | {fromConn: terminalTabId} | inline session */
  async open(id, spec) {
    this.close(id);
    let client;
    let sftp;
    let sess;
    let session;
    let username;
    const owned = !spec.fromConn;
    let clientEnded = false;
    let channelEnded = false;
    let cancelled = false;
    const login = new AbortController();
    let rejectClosed;
    const closed = new Promise((_resolve, reject) => { rejectClosed = reject; });
    // A close can precede the first asynchronous operation (for example, a
    // failed session lookup). Retain a rejection handler until races attach.
    closed.catch(() => {});
    const dispose = () => {
      if (sftp && !channelEnded) {
        channelEnded = true;
        try { sftp.end(); } catch {}
      }
      if (client && owned && !clientEnded) {
        clientEnded = true;
        try { client.end(); } catch {}
      }
      if (client && !owned) {
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
      }
    };
    const cancel = (error = new Error('SFTP connection cancelled')) => {
      cancelled = true;
      login.abort(error);
      rejectClosed(error);
      dispose();
    };
    const onClose = () => {
      cancel(new Error('SFTP connection closed'));
      if (this.sessions.get(id) === sess && sess) {
        this.close(id);
        this.deps.emit('sftp:closed', id);
      }
      client?.removeListener('error', onError);
      client?.removeListener('close', onClose);
    };
    const onError = (error) => {
      cancel(error);
      if (this.sessions.get(id) === sess && sess) {
        this.close(id);
        this.deps.emit('sftp:closed', id);
      }
    };
    const token = { cancel };
    this.pending.set(id, token);
    const wait = (operation) => Promise.race([operation, closed]);
    const connected = (value) => {
      client = value;
      client.on('error', onError);
      client.once('close', onClose);
      if (cancelled) {
        dispose();
        throw new Error('SFTP connection cancelled');
      }
    };
    try {
      if (spec.fromConn) {
        const shared = this.deps.connections.sshClient(spec.fromConn);
        if (!shared) throw new Error('That terminal tab is not connected over SSH');
        connected(shared.client);
        session = shared.session;
        username = shared.username;
      } else {
        session = this.deps.connections.resolveSession(spec);
        if ((session.protocol || 'ssh') !== 'ssh') throw new Error('SFTP needs an SSH session');
        const hooks = {
          signal: login.signal,
          knownHost: (h, pt) => this.deps.store.hostKeyFor(h, pt),
          saveHost: (h, pt, rec) => this.deps.store.saveHostKey(h, pt, rec),
          ask: async (payload) => {
            if (cancelled) return null;
            const result = await this.deps.ask(payload);
            return cancelled ? null : result;
          },
          log: () => {},
        };
        await wait(ssh.connectChain(session, hooks, (jid) => this.deps.store.getSessionSecret(jid)).then((r) => {
          username = r.info?.username;
          return connected(r.client);
        }));
      }
      sftp = await wait(p((cb) => client.sftp(cb)).then((channel) => {
        sftp = channel;
        if (cancelled) {
          dispose();
          throw new Error('SFTP connection cancelled');
        }
        return channel;
      }));
      sess = new SftpSession(id, client, sftp, session, owned, dispose);
      sess.home = await wait(sess.realpath('.').catch(() => '/'));
      if (cancelled || this.pending.get(id) !== token) throw new Error('SFTP connection cancelled');
      this.sessions.set(id, sess);
      return {
        home: sess.home,
        title: `${username || session.username || ''}@${session.host}`,
        username: username || session.username || '',
        name: session.name || session.host,
      };
    } catch (error) {
      cancel(error);
      throw error;
    } finally {
      if (this.pending.get(id) === token) this.pending.delete(id);
    }
  }

  list(id, dir) {
    return this.get(id).list(dir);
  }

  realpath(id, p0) {
    return this.get(id).realpath(p0);
  }

  mkdir(id, dir) {
    return this.get(id).mkdir(dir);
  }

  rename(id, a, b) {
    return this.get(id).rename(a, b);
  }

  async remove(id, paths) {
    const s = this.get(id);
    for (const t of paths) await s.remove(t);
  }

  async chmod(id, paths, mode) {
    const s = this.get(id);
    for (const t of paths) await s.chmod(t, mode);
  }

  _conflictChecker(batch, exists) {
    return async () => {
      const ex = await exists();
      if (!ex) return true;
      const policy = batch.policy;
      if (policy === 'overwrite') return true;
      if (policy === 'skip') return false;
      if (policy === 'newer') return batch.srcMtime() > ex.mtime;
      if (batch.answer) return batch.answer === 'overwrite';
      // 'ask': one prompt at a time; "apply to all" answers the rest of the batch.
      batch.prompt = (batch.prompt || Promise.resolve()).then(async () => {
        if (batch.answer) return batch.answer;
        const r = await this.deps.ask({
          kind: 'conflict',
          name: batch.currentName(),
          srcSize: batch.srcSize(),
          dstSize: ex.size,
          srcMtime: batch.srcMtime(),
          dstMtime: ex.mtime,
        });
        const action = (r && r.action) || 'skip';
        if (r && r.all) batch.answer = action;
        return action;
      });
      return (await batch.prompt) === 'overwrite';
    };
  }

  /** Upload local files/folders into a remote directory. */
  async upload(id, localPaths, remoteDir, opts = {}) {
    const s = this.get(id);
    const checkSession = () => {
      if (this.sessions.get(id) !== s) throw new Error('SFTP session is closed');
    };
    const batch = { policy: opts.conflict || 'ask' };
    let count = 0;
    const addFile = (src, dst, st) => {
      this.queue.add({
        sftpId: id,
        sess: s,
        direction: 'up',
        name: path.basename(src),
        src,
        dst,
        size: st.size,
        mtime: st.mtimeMs,
        preserveTime: opts.preserveTime !== false,
        checkConflict: this._conflictChecker(makeBatchView(batch, path.basename(src), st.size, st.mtimeMs), async () => {
          try {
            const r = await s.stat(dst);
            return { size: r.size, mtime: r.mtime * 1000 };
          } catch {
            return null;
          }
        }),
        onDone: opts.onDone,
      });
      count++;
    };
    const walk = async (src, dst) => {
      checkSession();
      const st = await fs.promises.stat(src);
      checkSession();
      if (st.isDirectory()) {
        await s.mkdirp(dst);
        for (const name of await fs.promises.readdir(src)) await walk(path.join(src, name), posix.join(dst, name));
      } else if (st.isFile()) {
        addFile(src, dst, st);
      }
    };
    for (const lp of localPaths) await walk(lp, posix.join(remoteDir, path.basename(lp)));
    return count;
  }

  /** Download remote files/folders into a local directory. */
  async download(id, remotePaths, localDir, opts = {}) {
    const s = this.get(id);
    const checkSession = () => {
      if (this.sessions.get(id) !== s) throw new Error('SFTP session is closed');
    };
    const batch = { policy: opts.conflict || 'ask' };
    await fs.promises.mkdir(localDir, { recursive: true });
    // A user-selected linked directory is allowed; its resolved target is the root.
    const root = await fs.promises.realpath(localDir);
    let count = 0;
    const walk = async (src, dst) => {
      checkSession();
      await checkDownloadDestination(root, dst);
      const st = await s.stat(src);
      checkSession();
      if (((st.mode || 0) & S_IFMT) === S_IFDIR) {
        await fs.promises.mkdir(dst, { recursive: true });
        const entries = await p((cb) => s.sftp.readdir(src, cb));
        for (const e of entries) {
          if (e.filename === '.' || e.filename === '..') continue;
          const name = localDownloadName(e.filename);
          await walk(posix.join(src, name), path.join(dst, name));
        }
      } else {
        const size = st.size || 0;
        const mtime = (st.mtime || 0) * 1000;
        this.queue.add({
          sftpId: id,
          sess: s,
          direction: 'down',
          name: posix.basename(src),
          src,
          dst,
          size,
          mtime,
          preserveTime: opts.preserveTime !== false,
          checkDestination: () => checkDownloadDestination(root, dst),
          checkConflict: this._conflictChecker(makeBatchView(batch, posix.basename(src), size, mtime), async () => {
            try {
              const r = await fs.promises.stat(dst);
              return { size: r.size, mtime: r.mtimeMs };
            } catch {
              return null;
            }
          }),
          onDone: opts.onDone,
        });
        count++;
      }
    };
    for (const rp of remotePaths) await walk(rp, path.join(root, localDownloadName(posix.basename(rp))));
    return count;
  }

  /** Read a whole remote file (for the built-in editor). */
  async readFile(id, remotePath) {
    const s = this.get(id);
    const st = await s.stat(remotePath);
    if (st.size > 50 * 1024 * 1024) throw new Error('Remote file is larger than 50 MB');
    return p((cb) => s.sftp.readFile(remotePath, cb));
  }

  /** Replace a remote file's contents (for the built-in editor). */
  async writeFile(id, remotePath, bytes) {
    const s = this.get(id);
    await p((cb) => s.sftp.writeFile(remotePath, Buffer.from(bytes), cb));
    const st = await s.stat(remotePath);
    return { mtime: st.mtime * 1000, size: st.size };
  }

  /**
   * Edit a remote file with the local default app: download to a temp folder, open it,
   * and upload it again whenever it is saved.
   */
  async edit(id, remotePath) {
    const s = this.get(id);
    const name = localDownloadName(posix.basename(remotePath));
    const tempRoot = this.deps.tempDir();
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const dir = await fs.promises.mkdtemp(path.join(tempRoot, 'konx-'));
    const local = path.join(dir, name);
    await p((cb) => s.sftp.fastGet(remotePath, local, cb));
    let lastMtime = (await fs.promises.stat(local)).mtimeMs;
    let uploading = false;
    let retryAt = 0;
    let retryDelay = 1000;
    let reportedError = false;
    const key = `${id}:${remotePath}`;
    const watcher = setInterval(async () => {
      if (uploading || Date.now() < retryAt) return;
      uploading = true;
      try {
        const st = await fs.promises.stat(local);
        if (st.mtimeMs !== lastMtime) {
          await p((cb) => s.sftp.fastPut(local, remotePath, cb));
          // A failed upload leaves this save pending, even if the editor never
          // saves again. A newer save during fastPut is picked up next time.
          lastMtime = st.mtimeMs;
          this.deps.emit('sftp:edited', id, remotePath);
        }
        retryAt = 0;
        retryDelay = 1000;
        reportedError = false;
      } catch (e) {
        retryAt = Date.now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, 30000);
        if (!reportedError) {
          reportedError = true;
          this.deps.emit('sftp:edit-error', id, remotePath,
            `${e.message}. Retrying automatically. Local copy: ${local}`);
        }
      } finally {
        uploading = false;
      }
    }, 1000);
    if (this.watchers.has(key)) clearInterval(this.watchers.get(key));
    this.watchers.set(key, watcher);
    await this.deps.openExternal(local);
    return local;
  }

  close(id) {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      pending.cancel();
    }
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.queue.cancelForSession(id);
    for (const [k, w] of this.watchers) {
      if (k.startsWith(id + ':')) {
        clearInterval(w);
        this.watchers.delete(k);
      }
    }
    s.close();
  }

  closeAll() {
    for (const id of new Set([...this.pending.keys(), ...this.sessions.keys()])) this.close(id);
  }
}

/** Per-file view onto a shared batch so conflict prompts show the right file. */
function makeBatchView(batch, name, size, mtime) {
  const view = Object.create(batch);
  view.currentName = () => name;
  view.srcSize = () => size;
  view.srcMtime = () => mtime;
  // Writes of answer/prompt must land on the shared batch, not the view.
  Object.defineProperty(view, 'answer', {
    get: () => batch.answer,
    set: (v) => (batch.answer = v),
  });
  Object.defineProperty(view, 'prompt', {
    get: () => batch.prompt,
    set: (v) => (batch.prompt = v),
  });
  return view;
}

module.exports = { SftpManager, permString };
