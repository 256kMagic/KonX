import { h, icon, api, modal, errMsg, fmtBytes } from './ui.js';

const activeDialogs = new WeakMap();
const working = new Set(['checking', 'downloading', 'verifying']);
const statuses = new Set(['idle', ...working, 'ready', 'current', 'error', 'cancelled', 'installing']);
const modeLabel = (mode) => mode === 'portable' ? 'Portable application' : mode === 'installed' ? 'Installed application' : 'Development or unsupported build';

export function updateBlockers(app) {
  const reasons = [];
  for (const tab of app.tabs || []) {
    if (typeof tab.updateBlockers === 'function') reasons.push(...tab.updateBlockers());
    if (tab.kind === 'notepad') {
      if (!tab.monaco) reasons.push('Wait for Notepad to finish loading.');
      if (tab.sending) reasons.push('Stop sending Notepad text to the terminal.');
      for (const doc of tab.docs || []) {
        if (doc.savePending) reasons.push(`Wait for “${doc.title || 'Notepad document'}” to finish saving.`);
        else if (tab.isDirty(doc)) reasons.push(`Save “${doc.title || 'Notepad document'}” in Notepad.`);
      }
    }
    if (tab.toolKind === 'ai') {
      if (tab.libraryBusy) reasons.push('Wait for the Knowledge library operation to finish.');
      // A new note has no editingId. Keep every open editor until the user
      // explicitly saves or cancels it; no note snapshot is discarded here.
      if (tab.noteEditor && !tab.noteEditor.classList.contains('hidden')) reasons.push('Save or cancel the open Knowledge note.');
    }
  }
  return [...new Set(reasons)];
}

export function updateKonx(app, { blockers = () => [] } = {}) {
  const existing = activeDialogs.get(app);
  if (existing) return existing;
  let state = { status: 'idle', currentVersion: app.info?.version || '', message: 'Reading update status…' };
  let closed = false, automatic = true, attempted = false, busy = false, starting = false, installing = false, issue = '', eventSequence = 0;
  let unsubscribe = () => {};
  const detail = h('p.hint');
  const status = h('p.update-status', { role: 'status', 'aria-live': 'polite' });
  const progress = h('progress.update-progress', { max: 100, 'aria-label': 'Update download progress' });
  const problems = h('div.update-problems', { role: 'status' });
  const install = h('button.btn.primary', { onclick: () => { automatic = false; void installReady(); } }, icon('download'), 'Install and restart');
  const retry = h('button.btn', { onclick: () => { automatic = true; attempted = false; void start(); } }, 'Try again');
  const cancel = h('button.btn', { onclick: () => { void cancelUpdate(); } }, 'Cancel update');
  const body = h('div.update-panel', detail, status, progress, problems,
    h('p.hint', 'KonX checks the public release, downloads and verifies the update, then restarts when your work is safe. No account or API key is required.'),
    h('div.update-actions', install, retry, cancel));

  function render() {
    detail.textContent = `KonX ${state.currentVersion || app.info?.version || ''} · ${modeLabel(state.mode)}${state.version ? ` · Update ${state.version}` : ''}`;
    status.textContent = busy && state.status === 'ready' ? 'Preparing to restart…' : state.message || ({ ready: 'Update verified and ready to install.', current: 'KonX is up to date.', cancelled: 'Update cancelled.' }[state.status] || 'Update KonX');
    progress.classList.toggle('hidden', !working.has(state.status));
    if (Number.isFinite(state.percent)) progress.value = Math.max(0, Math.min(100, state.percent));
    else progress.removeAttribute('value');
    if (state.status === 'downloading' && Number.isFinite(state.downloaded)) status.textContent += ` ${fmtBytes(state.downloaded)}${Number.isFinite(state.total) ? ` / ${fmtBytes(state.total)}` : ''}`;
    problems.textContent = issue;
    problems.classList.toggle('hidden', !issue);
    install.classList.toggle('hidden', state.status !== 'ready');
    install.disabled = busy || installing;
    retry.classList.toggle('hidden', !['error', 'cancelled'].includes(state.status) || state.supported === false);
    retry.disabled = busy || starting;
    cancel.classList.toggle('hidden', !working.has(state.status));
    cancel.disabled = busy;
    const box = body.closest('.modal');
    for (const button of box?.querySelectorAll('header .x, footer button') || []) button.disabled = installing;
    if (installing) status.textContent = 'Installing KonX. The application will restart shortly; please wait.';
  }

  function accept(next) {
    if (closed || !next || !statuses.has(next.status)) return;
    state = next; render();
    if (state.status === 'ready' && automatic && !attempted) {
      attempted = true;
      void installReady();
    }
  }

  async function installReady() {
    if (closed || busy || installing || state.status !== 'ready') return;
    busy = true; issue = ''; render();
    try {
      for (const tab of app.tabs || []) if (tab.kind === 'notepad' && tab.ready) {
        await tab.ready;
        if (closed) return;
      }
      let reasons = [...updateBlockers(app), ...blockers()];
      if (reasons.length) { issue = 'Update is ready. Before restarting:\n' + reasons.join('\n'); return; }
      for (const tab of app.tabs || []) if (tab.kind === 'notepad') {
        // Existing flush() is fire-and-forget. Require the main process to
        // acknowledge clean session state before requesting application exit.
        await api.invoke('np:session:set', tab.sessionData());
        if (closed) return;
      }
      if (closed || state.status !== 'ready') return;
      reasons = [...updateBlockers(app), ...blockers()];
      if (reasons.length) { issue = 'Update is ready. Before restarting:\n' + reasons.join('\n'); return; }
      installing = true; render();
      await api.invoke('app:updateInstall');
    } catch (error) {
      // Keep the verified package available for retry after a main-process
      // blocker, failed session write, or helper-start failure.
      issue = errMsg(error);
      automatic = false; installing = false;
      const sequence = eventSequence;
      try { const next = await api.invoke('app:updateState'); if (sequence === eventSequence) accept(next); }
      catch { /* Keep the last observed state and original failure visible. */ }
    } finally {
      automatic = false; busy = false;
      if (!closed) render();
    }
  }

  async function start() {
    if (closed || busy || starting) return;
    starting = true;
    issue = ''; render();
    const sequence = eventSequence;
    try {
      const next = await api.invoke('app:updateStart');
      if (sequence === eventSequence) accept(next);
    } catch (error) {
      if (!closed) { issue = errMsg(error); state = { ...state, status: 'error' }; render(); }
    } finally {
      starting = false;
      if (!closed) render();
    }
  }

  async function cancelUpdate() {
    automatic = false; attempted = true;
    try { const next = await api.invoke('app:updateCancel'); if (!closed) accept(next); }
    catch (error) { if (!closed) { issue = errMsg(error); render(); } }
  }

  render();
  // Once the install IPC starts, it may already have armed the restart helper.
  // Disable dismissal then; before that point closing always prevents install.
  const preventDismiss = (event) => {
    if (!installing) return;
    if (event.type === 'keydown' ? event.key === 'Escape' : event.target === body.closest('.modal-back')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  addEventListener('keydown', preventDismiss, true);
  const dialog = modal({ title: 'Update KonX', icon: 'download', width: 530, body,
    buttons: [{ label: 'Close', value: null }], submitOnEnter: false });
  body.closest('.modal-back').addEventListener('mousedown', preventDismiss, true);
  const completion = dialog.finally(() => {
    closed = true; automatic = false; unsubscribe(); activeDialogs.delete(app);
    removeEventListener('keydown', preventDismiss, true);
    if (starting || working.has(state.status)) void api.invoke('app:updateCancel').catch(() => {});
  });
  activeDialogs.set(app, completion);
  // Subscribe before either request, so fast/local downloads cannot outrun
  // the progress listener. A late status read must not replace newer events.
  try {
    unsubscribe = api.on('app:updateState', (next) => { eventSequence++; accept(next); });
    const sequence = eventSequence;
    void api.invoke('app:updateState').then((next) => {
      if (closed) return;
      if (sequence === eventSequence) accept(next);
      if (state.supported === false || state.status === 'ready' || state.status === 'installing' || working.has(state.status)) return;
      void start();
    }).catch((error) => { if (!closed) { issue = errMsg(error); state = { ...state, status: 'error' }; render(); } });
  } catch (error) { issue = errMsg(error); state = { ...state, status: 'error' }; render(); }
  return completion;
}

export function createUpdatesPane(app, options) {
  let disposed = false, sequence = 0;
  const version = h('p', `Current version: ${app.info?.version || 'Unknown'}`);
  const mode = h('p.hint', 'Reading local update support…');
  const button = h('button.btn.primary', { onclick: () => updateKonx(app, options) }, icon('download'), 'Update KonX');
  const el = h('div.mpane.update-settings', h('h3', 'Application updates'), version, mode,
    h('p.hint', 'Check for a public release only when you choose Update KonX. Installed and portable builds update in place. No account, authentication, or API key is needed.'), button);
  const show = (state) => {
    if (disposed || !state) return;
    version.textContent = `Current version: ${state.currentVersion || app.info?.version || 'Unknown'}`;
    mode.textContent = modeLabel(state.mode) + (state.supported === false ? ' · ' + (state.message || 'Updates are unavailable for this build.') : '');
    button.disabled = state.supported === false;
  };
  const off = api.on('app:updateState', (state) => { sequence++; show(state); });
  const initial = sequence;
  void api.invoke('app:updateState').then((state) => { if (sequence === initial) show(state); }).catch((error) => { if (!disposed) mode.textContent = errMsg(error); });
  return { el, dispose() { disposed = true; off(); } };
}
