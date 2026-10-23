// The live editor owns identity and applicability. A historical Copilot excerpt
// or model-supplied document ID is never permission to edit a document.
const models = new WeakMap();
const fields = ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn'];
const equalRange = (a, b) => !!a && !!b && fields.every(key => a[key] === b[key]);
const rangeOf = value => Object.fromEntries(fields.map(key => [key, value[key]]));
const hash = async value => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const modelId = model => { if (!models.has(model)) models.set(model, globalThis.crypto.randomUUID()); return models.get(model); };
function editable(owner, doc) {
  return !owner.disposed && !doc.readOnly && !doc.savePending && !owner.editor.getOption?.(owner.monaco.editor.EditorOption.readOnly);
}
function current(owner) {
  const doc = owner?.current, model = doc?.model, editor = owner?.editor;
  if (!doc || !model || model.isDisposed?.() || !editor || editor.getModel() !== model || !owner.docs.includes(doc)) throw new Error('Select a live editor document first.');
  const selection = editor.getSelection(); if (!selection || selection.isEmpty?.() || !equalRange(selection, model.validateRange(selection))) throw new Error('Select the exact nonempty text to replace.');
  return { doc, model, selection: rangeOf(selection) };
}
const selectedText = (owner, model, selection) => model.getValueInRange(selection, owner.monaco.editor.EndOfLinePreference.LF);
function matches(owner, target) {
  const value = current(owner);
  if (owner.id !== target.tabId || value.doc.id !== target.documentId || modelId(value.model) !== target.modelId || value.model.getVersionId() !== target.versionId || !equalRange(value.selection, target.selection) || !editable(owner, value.doc)) throw new Error('The selected editor identity, version, range or permission changed.');
  if (selectedText(owner, value.model, value.selection) !== target.beforeText) throw new Error('The selected editor text changed.');
  return value;
}
export async function captureEditorActionTarget(owner) {
  const { doc, model, selection } = current(owner), beforeText = selectedText(owner, model, selection);
  if (!beforeText.length || beforeText.length > 48 * 1024) throw new Error('Select between 1 and 49,152 characters.');
  const target = { tabId: owner.id, documentId: doc.id, modelId: modelId(model), versionId: model.getVersionId(), selection, beforeText,
    beforeDigest: await hash(beforeText), readOnly: !editable(owner, doc), savePending: !!doc.savePending, textFormat: 'lf' };
  matches(owner, target); return target;
}
export async function applyReviewedEditorAction(owner, request) {
  const ack = { operationId: request.operationId, nonce: request.nonce };
  let applied = false;
  try {
    if (typeof request.replacement !== 'string' || request.replacement.length > 48 * 1024 || request.replacement.includes('\r') || request.target?.textFormat !== 'lf' || Date.now() >= Date.parse(request.expiresAt) || !Number.isFinite(Date.parse(request.expiresAt))) throw new Error('The editor action expired or is malformed.');
    const first = matches(owner, request.target);
    if (await hash(request.target.beforeText) !== request.target.beforeDigest) throw new Error('The editor review digest changed.');
    // Hashing yields; recheck every live identity and permission after it. There
    // is no asynchronous gap between this check and the undoable edit.
    const { model, selection } = matches(owner, request.target);
    if (first.model !== model || Date.now() >= Date.parse(request.expiresAt)) throw new Error('The editor action became stale.');
    const offset = model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn });
    owner.editor.pushUndoStop();
    try { if (!owner.editor.executeEdits('konx-copilot-reviewed', [{ range: selection, text: request.replacement, forceMoveMarkers: true }])) throw new Error('The editor rejected the edit.'); applied = true; }
    finally { owner.editor.pushUndoStop(); }
    // Monaco retains the document's EOL format. Compare and hash the inserted
    // text in the same explicit LF representation used by the review.
    const end = model.getPositionAt(offset + request.replacement.replace(/\n/g, model.getEOL()).length);
    const afterRange = { startLineNumber: selection.startLineNumber, startColumn: selection.startColumn, endLineNumber: end.lineNumber, endColumn: end.column };
    const inserted = selectedText(owner, model, afterRange), afterVersion = model.getVersionId();
    if (inserted !== request.replacement) return { ...ack, status: 'applied', afterVersion, afterDigest: 'unexpected-editor-result' };
    return { ...ack, status: 'applied', afterVersion, afterDigest: await hash(inserted) };
  } catch {
    // If an exception followed the edit, do not claim that nothing happened.
    return applied ? { ...ack, status: 'applied', afterDigest: 'unconfirmed-editor-result' } : { ...ack, status: 'rejected' };
  }
}
