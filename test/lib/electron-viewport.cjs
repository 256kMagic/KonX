'use strict';

/** Resize a fixture without assuming integral Windows display scaling. */
async function setViewport(win, run, width, height) {
  win.setContentSize(width, height);
  const deadline = Date.now() + 10000;
  let actual;
  while (Date.now() < deadline) {
    actual = await run('({ width: innerWidth, height: innerHeight, outerWidth, outerHeight, devicePixelRatio, visualScale: visualViewport?.scale })');
    // Electron's DIP/native-pixel round trip can add 1–3 CSS pixels at a
    // fractional scale. Geometry assertions still use the actual viewport.
    if (Math.abs(actual.width - width) <= 3 && Math.abs(actual.height - height) <= 3) return { width: actual.width, height: actual.height };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const diagnostics = { requested: { width, height }, renderer: actual };
  try {
    Object.assign(diagnostics, {
      bounds: win.getBounds(), contentBounds: win.getContentBounds(), contentSize: win.getContentSize(),
      minimumSize: win.getMinimumSize(), maximumSize: win.getMaximumSize(),
      maximized: win.isMaximized(), minimized: win.isMinimized(), fullScreen: win.isFullScreen(),
      zoomFactor: win.webContents.getZoomFactor(),
    });
    const display = require('electron').screen.getDisplayMatching(diagnostics.bounds);
    diagnostics.display = { scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: display.workArea };
  } catch (error) { diagnostics.nativeError = error.message; }
  throw new Error(`Timed out resizing fixture viewport to ${width}x${height}: ${JSON.stringify(diagnostics)}`);
}

module.exports = { setViewport };
