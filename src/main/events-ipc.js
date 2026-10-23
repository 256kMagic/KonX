'use strict';

function registerEvents(handle, { events, isClosing = () => false }) {
  const requireReady = () => {
    if (isClosing()) throw new Error('KonX is closing. Wait before changing event history.');
  };
  // Inspection and cleanup remain available while application shutdown waits
  // for socket ownership to be released. EventConsole owns input validation.
  handle('tools:eventsList', () => events.list());
  handle('tools:eventsSnapshot', (id, options) => events.snapshot(id, options));
  handle('tools:eventsStop', id => events.stop(id));
  handle('tools:eventsClear', id => { requireReady(); return events.clear(id); });
  handle('tools:eventsRemove', id => { requireReady(); return events.remove(id); });
}

module.exports = { registerEvents };
