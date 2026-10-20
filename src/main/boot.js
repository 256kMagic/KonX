'use strict';
// Entry point. KonX.exe doubles as its own elevated capture helper for Windows' built-in
// capture engine (see capture/helper.js); everything else is the normal app in main.js.
if (process.argv.includes('--konx-capture-helper')) {
  const path = require('path');
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  // Keep the elevated process out of the user's profile data.
  app.setPath('userData', path.join(app.getPath('temp'), 'konx-capture-helper'));
  require('./capture/helper').run(process.argv, { exit: (code) => app.exit(code) });
} else {
  const path = require('node:path');
  const { app } = require('electron');
  let diagnostics;
  try {
    const profile = process.env.KONX_USERDATA && path.isAbsolute(process.env.KONX_USERDATA) ? process.env.KONX_USERDATA : app.getPath('userData');
    diagnostics = require('./diagnostics').installDiagnostics({ logDir: path.join(profile, 'diagnostics') });
  } catch { /* Diagnostic setup must not prevent the app from starting. */ }
  try { require('./main'); }
  catch (error) {
    // Electron may display module-load failures without emitting a process event.
    diagnostics?.record(error, 'startup');
    throw error;
  }
}
