'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const ALGORITHM = 'Local TF-IDF cosine vectors';
const RPC_TIMEOUT_MS = 30000;

// SQLite and vector work run in a dedicated thread. An eval bootstrap lets
// Electron's ASAR-aware require load the worker from a packaged app as well.
class KnowledgeLibrary {
  constructor({ dir } = {}) {
    if (typeof dir !== 'string' || !dir.trim() || dir.length > 4096) throw new Error('Knowledge profile directory is required');
    this._state = 'indexing';
    this._error = '';
    this._pending = new Map();
    this._nextId = 0;
    this._closed = false;
    this._closePromise = null;
    this._ready = new Promise((resolve) => { this._resolveReady = resolve; });
    this._startupTimer = setTimeout(() => this._fail(new Error('Knowledge library startup timed out')), RPC_TIMEOUT_MS);
    this._startupTimer.unref?.();
    try {
      this._worker = new Worker('require(require("node:worker_threads").workerData.workerPath)', {
        eval: true,
        workerData: { workerPath: path.join(__dirname, 'knowledge-worker.js'), dir: path.resolve(dir) },
      });
      this._worker.on('message', (message) => this._message(message));
      this._worker.on('error', (error) => this._fail(error));
      this._worker.on('exit', (code) => {
        if (!this._closed) this._fail(new Error(`Knowledge library worker exited (${code})`));
      });
      this._worker.unref();
    } catch (error) {
      this._fail(error);
    }
  }

  _message(message) {
    if (!message || typeof message !== 'object' || this._closed || this._state === 'error') return;
    if (message.ready) {
      clearTimeout(this._startupTimer);
      this._state = 'ready';
      this._resolveReady();
      return;
    }
    if (message.fatal) return this._fail(new Error(message.error || 'Knowledge library initialization failed'));
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!this._pending.size) this._worker?.unref();
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  _fail(error) {
    if (this._closed || this._state === 'error') return;
    clearTimeout(this._startupTimer);
    this._state = 'error';
    this._error = `Knowledge library unavailable: ${String(error?.message || error).slice(0, 600)}`;
    this._resolveReady();
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this._error));
    }
    this._pending.clear();
    this._worker?.terminate().catch(() => {});
  }

  async _rpc(method, args = []) {
    // Keep a pending startup request alive even when the host has no other work.
    this._worker?.ref();
    await this._ready;
    if (this._closed) throw new Error('Knowledge library is closed');
    if (this._state === 'error') throw new Error(this._error);
    return new Promise((resolve, reject) => {
      const id = ++this._nextId;
      const timer = setTimeout(() => {
        this._fail(new Error(`Knowledge library ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try { this._worker.postMessage({ id, method, args }); }
      catch (error) { this._fail(error); }
    });
  }

  async status() {
    if (this._closed) return { state: 'closed', algorithm: ALGORITHM };
    try { return await this._rpc('status'); }
    catch (error) { return { state: this._closed ? 'closed' : 'error', error: error.message, algorithm: ALGORITHM }; }
  }

  search(query, options) { return this._rpc('search', [query, options]); }
  // Only the main-process AI client supplies exact keys. Public search options
  // never select this route; keys are not stored in SQLite or returned.
  searchForAI(query, options, secrets) { return this._rpc('searchForAI', [query, options, secrets]); }
  get busy() { return this._state === 'indexing' || this._pending.size > 0; }
  list(options) { return this._rpc('list', [options]); }
  get(id) { return this._rpc('get', [id]); }
  // Pure canonicalization by the same worker owner that will save the article.
  // Reviewed notes preview and hash these exact bytes before requesting a write.
  prepareArticle(article) { return this._rpc('prepareArticle', [article]); }
  save(article) { return this._rpc('save', [article]); }
  remove(id) { return this._rpc('remove', [id]); }
  rebuild() { return this._rpc('rebuild'); }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._state = 'closed';
    clearTimeout(this._startupTimer);
    this._resolveReady();
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Knowledge library is closed'));
    }
    this._pending.clear();
    // Termination is bounded by worker_threads; SQLite transactions roll back if
    // interrupted. No journal or user documents are deleted on shutdown.
    this._closePromise = this._worker ? this._worker.terminate().then(() => undefined) : Promise.resolve();
    return this._closePromise;
  }
}

module.exports = { KnowledgeLibrary, ALGORITHM };
