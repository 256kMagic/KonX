'use strict';

// Register behind main's primary-main-frame handler. The existing tools:start
// runner owns job registration, cancellation and final done/error events.
function registerCopilot(handle, { copilot, isClosing }) {
  const ready = () => { if (isClosing()) throw new Error('KonX is closing or preparing an update. Wait before using Copilot.'); };
  const methods = { List: 'list', Get: 'get', Create: 'create', Rename: 'rename', Remove: 'remove', Attach: 'attach', Detach: 'detach', Prepare: 'prepare', PrepareTest: 'prepareTest', DiscardPrepared: 'discardPrepared', Status: 'status' };
  // A successful atomic save remains successful if shutdown starts while it is
  // finishing. Reporting failure after commit would invite duplicate creation.
  for (const [name, method] of Object.entries(methods)) handle('tools:copilot' + name, async (...args) => { ready(); return copilot[method](...args); });
}
module.exports = { registerCopilot };
