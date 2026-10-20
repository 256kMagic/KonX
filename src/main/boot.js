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
  require('./main');
}
