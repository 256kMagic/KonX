'use strict';

/** Register behind main's primary-frame handler. This boundary owns native
 * export choice and shutdown/revision checks, not collection or interpretation. */
function registerChangeValidation(handle, { changes, dialog, dialogOwner, isClosing }) {
  const ready = () => { if (isClosing()) throw new Error('KonX is closing or preparing an update. Wait before using change validation.'); };
  const guarded = fn => async (...args) => { ready(); return fn(...args); };
  const expected = value => { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Reopen and review the saved validation first; its revision is required.'); return value; };
  const operations = { List: 'list', Get: 'get', Create: 'create', SavePlan: 'savePlan', Advance: 'advance', SetSnapshots: 'setSnapshots', Compare: 'compare', AddEvidence: 'addEvidence', Decide: 'decide', Remove: 'remove', AddToIncident: 'addToIncident' };
  for (const [name, method] of Object.entries(operations)) handle('tools:change' + name, guarded((...args) => changes[method](...args)));
  handle('tools:changePreview', guarded(async (id, revision) => ({ revision: expected(revision), text: await changes.exportJson(id, revision) })));
  handle('tools:changeExport', guarded(async (id, revision, format) => {
    expected(revision); if (!['json', 'html'].includes(format)) throw new Error('Choose JSON or HTML report export.');
    const record = await changes.get(id);
    if (record.revision !== revision) throw new Error('The workflow changed. Review its current report before exporting.');
    ready();
    const choice = await dialog.showSaveDialog(dialogOwner(), { title: 'Export reviewed change validation report', defaultPath: `konx-change-validation-${record.id.slice(0, 8)}.${format}`,
      filters: [{ name: format === 'json' ? 'JSON report' : 'HTML report', extensions: [format] }] });
    ready(); if (choice.canceled || !choice.filePath) return null;
    // Storage rechecks the revision inside its serialized operation. Changes in
    // another window during the native dialog cannot silently alter the export.
    return changes.exportFile(id, format, choice.filePath, revision);
  }));
}
module.exports = { registerChangeValidation };
