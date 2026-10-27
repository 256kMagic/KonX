// Save/edit controls operate on the original connection's model-owned reference.
import { h, icon, api, toast, errMsg } from './ui.js';
import { editSessionDialog } from './sessions.js';
import { connectionSessionReference, newSessionDraft } from './connection-session-model.mjs';

function refreshControls(app, owner) {
  for (const tab of app.tabs || []) {
    if (tab.sessionReference !== owner || tab.disposed || !tab.saveSessionButton) continue;
    const label = owner.savedId ? 'Edit saved session' : 'Save session';
    tab.saveSessionButton.replaceChildren(icon(owner.savedId ? 'edit' : 'save'), label);
    tab.saveSessionButton.setAttribute('aria-label', label);
    tab.saveSessionButton.title = owner.available ? label : 'The original connection details are unavailable';
    tab.saveSessionButton.disabled = !owner.available || owner.dialogOpen || owner.saving;
  }
}

export function connectionSessionButton(tab) {
  const owner = connectionSessionReference(tab);
  const label = owner.savedId ? 'Edit saved session' : 'Save session';
  return h('button.btn.sm', { type: 'button', 'data-action': 'save-session', 'aria-label': label,
    title: owner.available ? label : 'The original connection details are unavailable', disabled: !owner.available || owner.dialogOpen || owner.saving,
    onclick: () => tab.app.saveConnectionSession(tab) }, icon(owner.savedId ? 'edit' : 'save'), label);
}

export function connectionSessionMenuItem(tab) {
  const owner = connectionSessionReference(tab);
  return { label: owner.savedId ? 'Edit saved session…' : 'Save session…', icon: owner.savedId ? 'edit' : 'save',
    disabled: !owner.available || owner.dialogOpen || owner.saving,
    action: () => tab.app.saveConnectionSession(tab) };
}

export async function saveConnectionSession(app, tab) {
  if (tab.disposed || !['terminal', 'sftp'].includes(tab.kind)) return;
  const owner = connectionSessionReference(tab);
  if (!owner.available || owner.dialogOpen || owner.saving) return;
  owner.dialogOpen = true;
  refreshControls(app, owner);
  try {
    let input;
    if (owner.savedId) {
      // Refresh before editing so deleting or editing a saved record elsewhere
      // cannot accidentally resurrect it or overwrite it with a stale snapshot.
      const listing = await api.invoke('sessions:list');
      if (tab.disposed) return;
      app.sessions.data = listing;
      app.sessions.render();
      input = listing.sessions.find(session => session.id === owner.savedId);
      if (!input) {
        if (owner.spec.sessionId) {
          toast('This saved session was deleted. Open a new connection to save a replacement.', 'err');
          return;
        }
        // An on-demand connection still owns its original configuration. Let
        // the user explicitly save that configuration again under a new ID.
        owner.savedId = null;
        input = newSessionDraft(owner, tab);
        refreshControls(app, owner);
      }
    } else input = newSessionDraft(owner, tab);
    const result = await editSessionDialog(app, input, {
      saveOnly: true,
      onSaving: saving => { owner.saving = saving; refreshControls(app, owner); },
      onSaved: saved => {
        // Persistence has already succeeded. Keep the association even when
        // the dialog/tab closed or the following sidebar refresh fails.
        owner.savedId = saved.id;
        refreshControls(app, owner);
      },
    });
    if (!result) return;
    try {
      await app.sessions.load();
      app.sessions.selected = 's:' + result.session.id;
      if (result.session.folder) {
        const parts = result.session.folder.split('/');
        for (let i = 1; i <= parts.length; i++) app.sessions.expanded.add(parts.slice(0, i).join('/'));
      }
      app.sessions.render();
      toast('Session saved. Your current connection is unchanged.', 'ok');
    } catch {
      toast('Session saved, but the session list could not refresh. Reopen Sessions or restart KonX to see it.', 'err');
    }
  } catch (error) {
    toast('Could not open the session editor: ' + errMsg(error), 'err');
  } finally {
    owner.dialogOpen = false;
    refreshControls(app, owner);
  }
}
