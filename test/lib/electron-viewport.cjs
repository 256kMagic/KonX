'use strict';

/** Resize a fixture without assuming integral Windows display scaling. */
async function setViewport(win, run, width, height) {
  win.setContentSize(width, height);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const actual = await run('({ width: innerWidth, height: innerHeight })');
    // Electron's DIP/native-pixel round trip can add 1–3 CSS pixels at a
    // fractional scale. Geometry assertions still use the actual viewport.
    if (Math.abs(actual.width - width) <= 3 && Math.abs(actual.height - height) <= 3) return actual;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out resizing fixture viewport to ${width}x${height}`);
}

module.exports = { setViewport };
