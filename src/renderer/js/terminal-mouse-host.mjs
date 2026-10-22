// xterm 6 open() follows a moved element's window, but its remote mouse-report
// drag listeners retain the document used at first open. Forward only that
// gesture to the original document; ordinary selection follows ownerDocument.
// No xterm internals or transport encoders are changed here.
export function bridgeTerminalMouse(term, originalDocument, hostWindow) {
  const element = term.element;
  if (!element || !originalDocument || hostWindow.document === originalDocument) return () => {};
  const document = hostWindow.document;
  let dragging = false, last = null, disposed = false;
  const fields = event => ({
    view: hostWindow, bubbles: false, cancelable: true,
    clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
    button: event.button, buttons: event.buttons, detail: event.detail,
    ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
  });
  const report = (type, init) => {
    originalDocument.dispatchEvent(new originalDocument.defaultView.MouseEvent(type, init));
  };
  const release = () => {
    if (!dragging) return;
    dragging = false;
    // mousemove.button does not identify the held button. Release the actual
    // mask, including a multi-button gesture, before removing xterm's listeners.
    let buttons = last.buttons;
    for (const [mask, button] of [[1, 0], [4, 1], [2, 2]]) {
      if (!(buttons & mask)) continue;
      buttons &= ~mask;
      report('mouseup', { ...last, button, buttons });
    }
  };
  const begin = event => {
    const mac = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(hostWindow.navigator.platform);
    const forceSelection = mac ? event.altKey && term.options.macOptionClickForcesSelection : event.shiftKey;
    if (disposed || forceSelection || event.button > 2 || !['vt200', 'drag', 'any'].includes(term.modes.mouseTrackingMode)) return;
    dragging = true;
    last = fields(event);
  };
  const forward = event => {
    if (!dragging || disposed) return;
    if (event.type === 'mousemove' && !event.buttons) { release(); return; }
    last = fields(event);
    report(event.type, last);
    if (event.type === 'mouseup' && !event.buttons) dragging = false;
  };
  element.addEventListener('mousedown', begin, true);
  document.addEventListener('mousemove', forward, true);
  document.addEventListener('mouseup', forward, true);
  hostWindow.addEventListener('blur', release);
  return () => {
    if (disposed) return;
    release();
    disposed = true;
    element.removeEventListener('mousedown', begin, true);
    document.removeEventListener('mousemove', forward, true);
    document.removeEventListener('mouseup', forward, true);
    hostWindow.removeEventListener('blur', release);
  };
}
