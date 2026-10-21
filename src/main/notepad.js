'use strict';
// Notepad back end: file I/O with change detection, session + unsaved-document backups
// (so nothing is lost across restarts, like Notepad++), Find in Files and file hashing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_OPEN = 200 * 1024 * 1024;

class NotepadStore {
  constructor(userDir) {
    this.dir = path.join(userDir, 'notepad');
    this.backupDir = path.join(this.dir, 'backup');
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.sessionFile = path.join(this.dir, 'session.json');
  }

  getSession() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    } catch {
      return { docs: [], active: null };
    }
  }

  setSession(s) {
    atomicWrite(this.sessionFile, Buffer.from(JSON.stringify(s, null, 1)));
    // Drop backups that no open document refers to any more.
    const keep = new Set((s.docs || []).map((d) => d.id));
    for (const f of fs.readdirSync(this.backupDir)) {
      if (!keep.has(f.replace(/\.txt$/, ''))) fs.rmSync(path.join(this.backupDir, f), { force: true });
    }
  }

  backupPath(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Bad document id');
    return path.join(this.backupDir, id + '.txt');
  }

  writeBackup(id, text) {
    atomicWrite(this.backupPath(id), Buffer.from(text, 'utf8'));
  }

  readBackup(id) {
    try {
      return fs.readFileSync(this.backupPath(id), 'utf8');
    } catch {
      return null;
    }
  }

  deleteBackup(id) {
    fs.rmSync(this.backupPath(id), { force: true });
  }
}

function atomicWrite(file, bytes) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    // A locked destination or failed replacement must leave its original
    // contents intact. Writing directly as a fallback would truncate them.
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function readFile(file) {
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error(`${file} is a folder`);
  if (st.size > MAX_OPEN) throw new Error(`${path.basename(file)} is ${(st.size / 1048576).toFixed(0)} MB; the limit is 200 MB`);
  return { path: file, bytes: fs.readFileSync(file), mtime: st.mtimeMs, size: st.size };
}

/** Write a file, keeping the original if anything fails. Returns the new mtime. */
function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, Buffer.from(bytes));
  return { mtime: fs.statSync(file).mtimeMs };
}

/** Tell the editor when an open file changes on disk (edited by another program, or deleted). */
class FileWatcher {
  constructor(emit) {
    this.emit = emit;
    this.watched = new Map(); // path -> {mtime}
    this.timer = setInterval(() => this.poll(), 1500);
    this.timer.unref && this.timer.unref();
  }

  set(entries) {
    const next = new Map();
    for (const { path: p, mtime } of entries) next.set(p, { mtime: (this.watched.get(p) || {}).mtime ?? mtime });
    this.watched = next;
  }

  /** Our own saves update the known mtime so they do not look like outside changes. */
  saved(p, mtime) {
    if (this.watched.has(p)) this.watched.get(p).mtime = mtime;
  }

  poll() {
    for (const [p, w] of this.watched) {
      fs.stat(p, (err, st) => {
        if (err) {
          if (!w.deleted) {
            w.deleted = true;
            this.emit('np:changed', p, { deleted: true });
          }
          return;
        }
        if (w.deleted || Math.abs(st.mtimeMs - w.mtime) > 1) {
          w.deleted = false;
          w.mtime = st.mtimeMs;
          this.emit('np:changed', p, { mtime: st.mtimeMs });
        }
      });
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------- Find in Files

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', '$recycle.bin', 'system volume information']);

/**
 * Search files under dir. emit('np:found', jobId, [{file, line, col, len, text}]) in batches,
 * then emit('np:findDone', jobId, {files, hits, scanned, truncated, error}).
 */
async function findInFiles(jobId, opts, emit, signal) {
  const { dir, query, regex = false, caseSensitive = false, wholeWord = false, filters = '*', maxHits = 5000, recurse = true } = opts;
  if (!dir || !fs.existsSync(dir)) throw new Error('Choose a folder to search');
  if (!query) throw new Error('Enter text to find');
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `\\b${src}\\b`;
  const re = new RegExp(src, caseSensitive ? 'g' : 'gi');
  const globs = String(filters || '*').split(/[;,\s]+/).filter(Boolean).map(globToRegex);
  let hits = 0;
  let files = 0;
  let scanned = 0;
  let batch = [];
  let truncated = false;
  const flush = () => {
    if (batch.length) emit('np:found', jobId, batch);
    batch = [];
  };
  const walk = async (d, depth) => {
    if (signal.stopped || truncated || depth > 40) return;
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (signal.stopped || truncated) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (recurse && !SKIP_DIRS.has(e.name.toLowerCase())) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || !globs.some((g) => g.test(e.name))) continue;
      let buf;
      try {
        const st = await fs.promises.stat(full);
        if (st.size > 20 * 1024 * 1024) continue;
        buf = await fs.promises.readFile(full);
      } catch {
        continue;
      }
      scanned++;
      // Skip binaries (NUL bytes) unless the file is UTF-16 with a BOM.
      const utf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
      if (!utf16 && buf.subarray(0, 8000).includes(0)) continue;
      const text = utf16
        ? new TextDecoder(buf[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(buf.subarray(2))
        : buf.toString('utf8').replace(/^\uFEFF/, '');
      const lines = text.split(/\r\n|\n|\r/);
      let fileHits = 0;
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (!m) continue;
        fileHits++;
        hits++;
        batch.push({ file: full, line: i + 1, col: m.index + 1, len: m[0].length || 1, text: lines[i].length > 400 ? lines[i].slice(0, 400) + '…' : lines[i] });
        if (batch.length >= 200) flush();
        if (hits >= maxHits) {
          truncated = true;
          break;
        }
      }
      if (fileHits) files++;
    }
  };
  await walk(dir, 0);
  flush();
  emit('np:findDone', jobId, { files, hits, scanned, truncated, stopped: !!signal.stopped });
}

/** MD5 / SHA-1 / SHA-256 of a file, streamed (firmware images can be large). */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = { md5: crypto.createHash('md5'), sha1: crypto.createHash('sha1'), sha256: crypto.createHash('sha256'), sha512: crypto.createHash('sha512') };
    let size = 0;
    fs.createReadStream(file)
      .on('data', (d) => {
        size += d.length;
        for (const x of Object.values(h)) x.update(d);
      })
      .on('error', reject)
      .on('end', () => resolve({ file, size, ...Object.fromEntries(Object.entries(h).map(([k, x]) => [k, x.digest('hex')])) }));
  });
}

function hashText(text) {
  const b = Buffer.from(text, 'utf8');
  return { size: b.length, md5: crypto.createHash('md5').update(b).digest('hex'), sha1: crypto.createHash('sha1').update(b).digest('hex'), sha256: crypto.createHash('sha256').update(b).digest('hex'), sha512: crypto.createHash('sha512').update(b).digest('hex') };
}

module.exports = { NotepadStore, FileWatcher, readFile, writeFile, findInFiles, hashFile, hashText, globToRegex };
