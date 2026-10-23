'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redactText } = require('./ai-redaction');

const ALGORITHM = 'Local TF-IDF cosine vectors';
const INDEX_VERSION = 'tfidf-hash1024-redacted-v2';
const DIMENSIONS = 1024;
const MAX_CUSTOM = 200;
const MAX_CONTENT = 32000;
const MAX_CHUNKS = 10000;
const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 160;
const STOP = new Set('a an and are as at be been by can for from has have how i if in into is it its may of on or our should so than that the their them there these they this to use was we were what when where which while will with you your'.split(' '));
const EXPANSIONS = {
  wifi: ['wireless', 'wlan'], wlan: ['wifi', 'wireless'], wireless: ['wifi', 'wlan'],
  rssi: ['signal', 'strength'], snr: ['signal', 'noise'], marvis: ['mist'],
  latency: ['delay'], jitter: ['variation'], loss: ['dropped'], voip: ['sip', 'rtp', 'voice'],
  dns: ['resolver', 'hostname'], sftp: ['ssh', 'transfer'], certificate: ['tls'],
};

let db;
let idf;
let searchRows = [];

function text(value, label, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) {
    throw new Error(`${label} must be ${allowEmpty ? 'text of' : 'nonempty text of'} at most ${max} characters`);
  }
  return value.trim();
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || !/^(?:builtin:[a-z0-9-]{1,80}|custom:[a-f0-9-]{36})$/.test(value)) throw new Error('Invalid article ID');
  return value;
}

function normalizeArticle(value, builtin = false) {
  object(value, 'article');
  const article = {
    id: value.id === undefined ? `custom:${crypto.randomUUID()}` : identifier(value.id),
    title: text(value.title, 'Article title', 160),
    vendor: text(value.vendor === undefined ? '' : value.vendor, 'Article vendor', 80, true),
    sourceUrl: text(value.sourceUrl === undefined ? '' : value.sourceUrl, 'Source URL', 2048, true),
    content: text(value.content, 'Article content', MAX_CONTENT),
    tags: value.tags === undefined ? [] : value.tags,
    builtin,
  };
  if (builtin !== article.id.startsWith('builtin:')) throw new Error('Built-in articles cannot be changed; save a new custom article instead');
  if (!Array.isArray(article.tags) || article.tags.length > 20) throw new Error('Article tags must be an array of at most 20 items');
  article.tags = [...new Set(article.tags.map((tag) => text(tag, 'Article tag', 48)))];
  if (article.sourceUrl) {
    let url;
    try { url = new URL(article.sourceUrl); } catch { throw new Error('Source URL must be an HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Source URL must be an HTTPS URL without credentials');
  }
  return article;
}

function checksum(article) {
  return crypto.createHash('sha256').update(JSON.stringify([article.id, article.title, article.vendor, article.sourceUrl, article.content, article.tags])).digest('hex');
}

function meta(key) { return db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value; }
function setMeta(key, value) { db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }

function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = callback(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

function fromRow(row, full = true) {
  if (!row) return null;
  const value = { id: row.id, title: row.title, vendor: row.vendor, sourceUrl: row.source_url, tags: JSON.parse(row.tags), builtin: !!row.builtin, updatedAt: row.updated_at };
  if (full) value.content = row.content;
  return value;
}

function put(article) {
  db.prepare(`INSERT INTO documents(id,title,vendor,source_url,tags,content,builtin,checksum,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,vendor=excluded.vendor,
    source_url=excluded.source_url,tags=excluded.tags,content=excluded.content,checksum=excluded.checksum,updated_at=excluded.updated_at`)
    .run(article.id, article.title, article.vendor, article.sourceUrl, JSON.stringify(article.tags), article.content, article.builtin ? 1 : 0, checksum(article), new Date().toISOString());
}

function tokens(value) {
  const words = String(value).normalize('NFKC').toLowerCase().replace(/wi-fi/g, 'wifi').match(/[\p{L}\p{N}][\p{L}\p{N}.-]{0,63}/gu) || [];
  const result = [];
  for (const word of words) {
    if (STOP.has(word) || word.length < 2) continue;
    result.push(word);
    if (EXPANSIONS[word]) result.push(...EXPANSIONS[word]);
  }
  return result;
}

function feature(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) { hash ^= token.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % DIMENSIONS;
}

function counts(value) {
  const result = new Map();
  for (const token of tokens(value)) {
    const index = feature(token);
    result.set(index, (result.get(index) || 0) + 1);
  }
  return result;
}

function vector(frequencies, weights) {
  const result = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (const [index, frequency] of frequencies) {
    const weight = (1 + Math.log(frequency)) * weights[index];
    result[index] = weight;
    norm += weight * weight;
  }
  norm = Math.sqrt(norm);
  if (norm) for (let index = 0; index < DIMENSIONS; index++) result[index] /= norm;
  return result;
}

function split(content) {
  const result = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + CHUNK_SIZE, content.length);
    if (end < content.length) {
      const boundary = Math.max(content.lastIndexOf('\n', end), content.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(CHUNK_SIZE / 2)) end = boundary;
    }
    result.push(content.slice(start, end).trim());
    if (end === content.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return result;
}

// Recompute IDF for the complete bounded corpus after a mutation. Documents,
// chunks, normalized vectors, and index metadata commit in one transaction.
function buildIndex() {
  const docs = db.prepare('SELECT * FROM documents ORDER BY id').all();
  if (docs.length > MAX_CUSTOM + 100 || docs.filter((doc) => !doc.builtin).length > MAX_CUSTOM) throw new Error('Knowledge library exceeds the article limit');
  const rows = [];
  const documentFrequency = new Uint32Array(DIMENSIONS);
  for (const doc of docs) {
    const article = normalizeArticle(fromRow(doc), !!doc.builtin);
    // Keep source documents intact. Derived chunks must never begin inside a
    // credential value or private-key block whose label was in a prior chunk.
    for (const [ordinal, content] of split(redactText(article.content)).entries()) {
      if (rows.length >= MAX_CHUNKS) throw new Error('Knowledge library exceeds the chunk limit');
      const frequencies = counts(`${article.title} ${article.title} ${article.vendor} ${article.tags.join(' ')} ${content}`);
      for (const index of frequencies.keys()) documentFrequency[index]++;
      rows.push({ id: `${article.id}#${ordinal}`, docId: article.id, ordinal, content, frequencies });
    }
  }
  const weights = Array.from(documentFrequency, (frequency) => Math.log((rows.length + 1) / (frequency + 1)) + 1);
  db.exec('DELETE FROM chunks');
  const insert = db.prepare('INSERT INTO chunks(id,document_id,ordinal,content,vector) VALUES (?,?,?,?,?)');
  for (const row of rows) {
    const embedding = vector(row.frequencies, weights);
    insert.run(row.id, row.docId, row.ordinal, row.content, Buffer.from(embedding.buffer));
  }
  setMeta('idf', JSON.stringify(weights));
  setMeta('indexVersion', INDEX_VERSION);
  setMeta('algorithm', ALGORITHM);
  setMeta('updatedAt', new Date().toISOString());
  setMeta('documentChecksum', crypto.createHash('sha256').update(docs.map((doc) => doc.checksum).join('|')).digest('hex'));
}

function loadIndex() {
  const weights = JSON.parse(meta('idf') || 'null');
  if (!Array.isArray(weights) || weights.length !== DIMENSIONS || weights.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error('Knowledge vector metadata is invalid; rebuild the index');
  const rows = db.prepare('SELECT c.id AS chunk_id,c.content,c.vector,d.id,d.title,d.vendor,d.tags,d.source_url FROM chunks c JOIN documents d ON d.id=c.document_id ORDER BY c.id').all();
  if (rows.length > MAX_CHUNKS) throw new Error('Knowledge library exceeds the chunk limit');
  const loaded = rows.map((row) => {
    if (!(row.vector instanceof Uint8Array) || row.vector.byteLength !== DIMENSIONS * 4) throw new Error('Knowledge vector data is invalid; rebuild the index');
    // SQLite Uint8Array byte offsets are not guaranteed to be float aligned.
    const bytes = Buffer.from(row.vector);
    const embedding = new Float32Array(DIMENSIONS);
    for (let i = 0; i < DIMENSIONS; i++) {
      embedding[i] = bytes.readFloatLE(i * 4);
      if (!Number.isFinite(embedding[i])) throw new Error('Knowledge vector data is invalid; rebuild the index');
    }
    return { ...row, vector: embedding, tokenSet: new Set(tokens(`${row.title} ${row.vendor} ${JSON.parse(row.tags).join(' ')} ${row.content}`)) };
  });
  idf = weights;
  searchRows = loaded;
}

function reconcileBuiltins() {
  const data = require('../knowledge/articles.json');
  if (!data || !Number.isInteger(data.version) || !Array.isArray(data.articles) || !data.articles.length || data.articles.length > 100) throw new Error('Bundled knowledge library is invalid');
  const builtins = data.articles.map((article) => normalizeArticle(article, true));
  const ids = new Set(builtins.map((article) => article.id));
  if (ids.size !== builtins.length) throw new Error('Bundled knowledge library has duplicate IDs');
  const bundleChecksum = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  let changed = meta('bundleChecksum') !== bundleChecksum;
  for (const article of builtins) {
    const current = db.prepare('SELECT * FROM documents WHERE id=?').get(article.id);
    if (current && !current.builtin) throw new Error('Knowledge article ownership is invalid');
    if (!current || current.checksum !== checksum(article) || checksum(fromRow(current)) !== checksum(article)) { put(article); changed = true; }
  }
  for (const current of db.prepare('SELECT id FROM documents WHERE builtin=1').all()) {
    if (!ids.has(current.id)) { db.prepare('DELETE FROM documents WHERE id=? AND builtin=1').run(current.id); changed = true; }
  }
  // Never silently overwrite damaged user-authored content. Built-ins can be
  // reconciled from this app, but custom records must remain recoverable.
  const docs = db.prepare('SELECT * FROM documents ORDER BY id').all();
  if (docs.length > MAX_CUSTOM + 100 || docs.filter((doc) => !doc.builtin).length > MAX_CUSTOM) throw new Error('Knowledge library exceeds the article limit');
  for (const row of docs) {
    const article = normalizeArticle(fromRow(row), !!row.builtin);
    if (!row.builtin && checksum(article) !== row.checksum) throw new Error('Custom knowledge article integrity check failed; keep the database for recovery');
  }
  const documentChecksum = crypto.createHash('sha256').update(docs.map((doc) => doc.checksum).join('|')).digest('hex');
  if (changed || meta('indexVersion') !== INDEX_VERSION || meta('documentChecksum') !== documentChecksum) buildIndex();
  setMeta('bundleChecksum', bundleChecksum);
  setMeta('bundleVersion', data.version);
}

function initialize() {
  const directory = path.join(workerData.dir, 'knowledge');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Knowledge directory cannot be a symbolic link');
  const filename = path.join(directory, 'library.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (fs.existsSync(filename + suffix) && fs.lstatSync(filename + suffix).isSymbolicLink()) throw new Error('Knowledge database cannot be a symbolic link');
  }
  db = new DatabaseSync(filename, { allowExtension: false });
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== 0 && version !== 1) throw new Error('Knowledge database schema is newer than this app; keep the database and update KonX');
  if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Knowledge database has an unsupported schema');
  const check = db.prepare('PRAGMA quick_check').all();
  if (check.some((row) => row.quick_check !== 'ok')) throw new Error('Knowledge database is damaged; keep it for recovery');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,vendor TEXT NOT NULL,
        source_url TEXT NOT NULL,tags TEXT NOT NULL,content TEXT NOT NULL,builtin INTEGER NOT NULL CHECK(builtin IN (0,1)),
        checksum TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,content TEXT NOT NULL,vector BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id); PRAGMA user_version=1;`);
    reconcileBuiltins();
  });
  loadIndex();
}

function rank(query) {
  const words = tokens(query);
  const frequencies = counts(query);
  if (!frequencies.size) return [];
  const queryVector = vector(frequencies, idf);
  const ranked = [];
  for (const row of searchRows) {
    // Hash collisions must never be the sole reason an excerpt is treated as
    // grounding. Require a real term (or declared synonym) in the source text.
    if (!words.some((word) => row.tokenSet.has(word))) continue;
    let score = 0;
    for (const index of frequencies.keys()) score += queryVector[index] * row.vector[index];
    if (score >= 0.035) ranked.push({ row, score });
  }
  return ranked.sort((a, b) => b.score - a.score || a.row.chunk_id.localeCompare(b.row.chunk_id));
}

function excerpt(content, query) {
  const limit = 900;
  if (content.length <= limit) return content;
  const wanted = new Set(tokens(query));
  const matches = [];
  for (const match of content.matchAll(/[\p{L}\p{N}][\p{L}\p{N}.-]{0,63}/gu)) {
    if (tokens(match[0]).some(token => wanted.has(token))) matches.push({ start: match.index, end: match.index + match[0].length });
  }
  // Center the strongest bounded cluster of query terms, preserving nearby
  // context instead of returning an unrelated first 900 characters.
  let best = 0, right = 0, count = 0;
  for (let left = 0; left < matches.length; left++) {
    const start = Math.max(0, Math.min(content.length - limit, matches[left].start - 180));
    while (right < matches.length && matches[right].end <= start + limit) right++;
    if (right - left > count) { count = right - left; best = start; }
  }
  if (best && /[\uDC00-\uDFFF]/.test(content[best])) best++;
  let end = Math.min(content.length, best + limit);
  if (end < content.length && /[\uDC00-\uDFFF]/.test(content[end])) end--;
  return content.slice(best, end);
}

function search(query, options = {}, secrets = []) {
  const value = text(query, 'Search query', 4000, true);
  if (!value) return [];
  object(options, 'search options');
  const limit = options.limit === undefined ? 5 : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('Search limit must be an integer from 1 to 5');
  const ranked = rank(value), seen = new Set(), result = [];
  const document = db.prepare('SELECT content FROM documents WHERE id=?');
  for (const { row, score } of ranked) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    // Sanitize the complete bounded source before locating or cutting any
    // excerpt, including exact configured keys that cross stored chunk edges.
    const content = redactText(document.get(row.id).content, secrets);
    result.push({ id: row.id, chunkId: row.chunk_id, title: row.title, vendor: row.vendor, content: excerpt(content, value), sourceUrl: row.source_url, score: Math.round(score * 1000000) / 1000000 });
    if (result.length === limit) break;
  }
  return result;
}

const actions = {
  status() {
    const values = db.prepare('SELECT COUNT(*) AS documents,SUM(CASE WHEN builtin=0 THEN 1 ELSE 0 END) AS customDocuments FROM documents').get();
    return { state: 'ready', documents: values.documents, chunks: searchRows.length, customDocuments: values.customDocuments || 0, algorithm: ALGORITHM, updatedAt: meta('updatedAt') };
  },
  search(query, options = {}) {
    return search(query, options);
  },
  searchForAI(query, options, secrets) {
    if (!Array.isArray(secrets) || secrets.length > 5 || secrets.some(secret => typeof secret !== 'string' || !secret.length || secret.length > 1024)) throw new Error('Invalid internal redaction values');
    return search(query, options, secrets);
  },
  list(options = {}) {
    object(options, 'library filters');
    const query = text(options.query === undefined ? '' : options.query, 'Library query', 4000, true).toLowerCase();
    const vendor = text(options.vendor === undefined ? '' : options.vendor, 'Vendor filter', 80, true).toLowerCase();
    const scores = new Map();
    if (query) for (const match of rank(query)) if (!scores.has(match.row.id)) scores.set(match.row.id, match.score);
    return db.prepare('SELECT id,title,vendor,source_url,tags,content,builtin,updated_at FROM documents ORDER BY title COLLATE NOCASE,id').all()
      .filter((row) => (!vendor || row.vendor.toLowerCase() === vendor) && (!query || scores.has(row.id) || `${row.title} ${row.vendor} ${row.tags} ${row.content}`.toLowerCase().includes(query)))
      .map((row) => fromRow(row, false))
      .sort((a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0) || a.title.localeCompare(b.title));
  },
  get(id) { return fromRow(db.prepare('SELECT * FROM documents WHERE id=?').get(identifier(id))); },
  save(value) {
    const article = normalizeArticle(value);
    const existing = db.prepare('SELECT builtin FROM documents WHERE id=?').get(article.id);
    if (value.id && !existing) throw new Error('Custom article was not found');
    if (existing?.builtin) throw new Error('Built-in articles cannot be changed');
    if (!existing && db.prepare('SELECT COUNT(*) AS count FROM documents WHERE builtin=0').get().count >= MAX_CUSTOM) throw new Error(`Knowledge library supports at most ${MAX_CUSTOM} custom articles`);
    transaction(() => { put(article); buildIndex(); });
    loadIndex();
    return actions.get(article.id);
  },
  remove(id) {
    identifier(id);
    if (!id.startsWith('custom:')) throw new Error('Built-in articles cannot be removed');
    const existing = db.prepare('SELECT builtin FROM documents WHERE id=?').get(id);
    if (!existing || existing.builtin) throw new Error('Custom article was not found');
    transaction(() => { db.prepare('DELETE FROM documents WHERE id=? AND builtin=0').run(id); buildIndex(); });
    loadIndex();
    return { removed: true, id };
  },
  rebuild() { transaction(() => { reconcileBuiltins(); buildIndex(); }); loadIndex(); return actions.status(); },
};

try {
  initialize();
  parentPort.on('message', (message) => {
    if (!message || !Number.isSafeInteger(message.id) || !Object.hasOwn(actions, message.method) || !Array.isArray(message.args)) return;
    try { parentPort.postMessage({ id: message.id, result: actions[message.method](...message.args) }); }
    catch (error) { parentPort.postMessage({ id: message.id, error: String(error.message || error).slice(0, 800) }); }
  });
  parentPort.postMessage({ ready: true });
} catch (error) {
  try { db?.close(); } catch {}
  parentPort.postMessage({ fatal: true, error: String(error.message || error).slice(0, 800) });
}
