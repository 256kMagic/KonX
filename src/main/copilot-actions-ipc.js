'use strict';
function registerCopilotActions(handle, { actions, isClosing }) {
  const ready = () => { if (isClosing()) throw new Error('KonX is closing or preparing an update. Wait before reviewing actions.'); };
  handle('tools:copilotActionCandidates', input => { ready(); return actions.candidates(input); });
  handle('tools:copilotActionPrepare', input => { ready(); return actions.prepare(input); });
  handle('tools:copilotActionDiscard', id => actions.discard(id));
  // Completion acknowledgments must remain admissible while closing; otherwise
  // a successful edit would become unknown solely because shutdown began.
  handle('tools:copilotActionEditorAck', input => actions.acknowledgeEditor(input));
}
module.exports = { registerCopilotActions };
