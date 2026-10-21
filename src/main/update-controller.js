'use strict';

// The application owns the shutdown boundary; downloads never quit the app.
class UpdateController {
  constructor({ manager, target, cacheDir, busyReasons, launch, quit, onState }) {
    Object.assign(this, { manager, target, cacheDir, busyReasons, launch, quit, onState });
    this.pendingOperations = 0;
    this.installing = false;
    this.committed = false;
    this.installPromise = null;
    this.handoff = null;
  }

  snapshot() {
    const state = this.manager.snapshot();
    return this.installing ? { ...state, status: 'installing', message: 'Preparing to update and restart KonX…' } : state;
  }

  changed() { this.onState?.(this.snapshot()); }

  // Track in-flight dialogs, reads, writes, and starts, including work that has
  // not yet appeared in its owner's active-session collection. Freeze new work
  // across all asynchronous verification and helper-handshake boundaries.
  invoke(channel, fn) {
    if (channel.startsWith('app:update')) return fn();
    if (this.installing) throw new Error('KonX is preparing to restart for an update.');
    this.pendingOperations++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => { this.pendingOperations--; });
      }
      this.pendingOperations--;
      return result;
    } catch (error) {
      this.pendingOperations--;
      throw error;
    }
  }

  assertIdle() {
    const reasons = this.busyReasons();
    if (this.pendingOperations) reasons.push('Wait for pending file operations or dialogs to finish.');
    if (reasons.length) throw new Error(reasons.join('\n'));
  }

  start() {
    if (this.installing) return Promise.resolve(this.snapshot());
    return this.manager.start();
  }

  cancel() {
    if (this.installing) throw new Error('The update is preparing to restart.');
    return this.manager.cancel();
  }

  install() {
    if (this.installPromise) return this.installPromise;
    this.installPromise = this._install().finally(() => {
      if (!this.installing) this.installPromise = null;
    });
    return this.installPromise;
  }

  async _install() {
    this.assertIdle();
    this.installing = true;
    this.changed();
    try {
      if (this.handoff) {
        await this.handoff.cancel();
        this.handoff = null;
      }
      const update = await this.manager.getReady();
      this.assertIdle();
      this.handoff = await this.launch({ update, target: this.target, cacheDir: this.cacheDir });
      this.assertIdle();
      // The ready helper now owns a separately verified payload. Remove our
      // original while this process can still finish and report cleanup errors;
      // otherwise every successful update would strand a full EXE in the cache.
      const cleaned = await this.manager.cancel();
      if (cleaned?.status === 'error') throw new Error(cleaned.message);
      this.assertIdle();
      await this.handoff.commit();
      this.committed = true;
      this.quit();
      return this.snapshot();
    } catch (error) {
      if (this.handoff) {
        try { await this.handoff.cancel(); this.handoff = null; }
        catch (cancelError) {
          error = new Error(`${error.message}\nUpdate helper cleanup failed: ${cancelError.message}`);
        }
      }
      this.installing = false;
      this.committed = false;
      this.changed();
      throw error;
    }
  }

  shutdown() {
    // A committed helper must survive normal application shutdown. An ordinary
    // quit only cancels the download; it never installs a staged update.
    if (!this.installing) return this.manager.cancel();
  }
}

module.exports = { UpdateController };
