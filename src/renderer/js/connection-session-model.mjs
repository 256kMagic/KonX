// A saved-session reference belongs to a connection's original configuration.
// Sharing this owner never rewrites the live connection or its reconnect spec.
export function connectionSessionReference(tab) {
  if (tab.sessionReference) return tab.sessionReference;
  let owner;
  if (tab.spec.fromConn) {
    const source = tab.app.byId?.get(tab.spec.fromConn);
    if (source) owner = connectionSessionReference(source);
  }
  if (!owner) owner = { savedId: tab.spec.sessionId || null, spec: tab.spec, meta: { ...tab.meta }, info: {},
    available: !tab.spec.fromConn, dialogOpen: false, saving: false };
  tab.sessionReference = owner;
  return owner;
}

export const savedSessionId = tab => tab.sessionReference?.savedId || tab.spec?.sessionId || null;

export function observeConnectionSession(tab, info) {
  if (!info) return;
  const owner = connectionSessionReference(tab);
  // Structured connection metadata only; never infer login details from text.
  if (typeof info.username === 'string' && info.username) owner.info.username = info.username;
}

export function newSessionDraft(owner, tab) {
  const source = owner.spec.sessionId ? {} : owner.spec;
  const appearance = { ...owner.meta, ...(tab.kind === 'terminal' ? tab.meta : {}) };
  const draft = { ...source, name: owner.meta.name || source.name || source.host || source.serialPort,
    protocol: source.protocol || 'ssh', ...owner.info };
  if (draft.protocol !== 'serial') draft.port = source.port || (draft.protocol === 'ssh' ? 22 : 23);
  for (const key of ['colorScheme', 'fontSize', 'terminalHighlighting']) {
    if (appearance[key] !== undefined) draft[key] = appearance[key];
  }
  // Only the store chooses durable identity; transport references are not data.
  for (const key of ['id', 'sessionId', 'override', 'fromConn', 'hasPassword', 'hasPassphrase']) delete draft[key];
  return draft;
}
