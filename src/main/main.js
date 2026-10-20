'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

if (process.env.KONX_USERDATA) app.setPath('userData', process.env.KONX_USERDATA);

const { Store } = require('./store');
const { ConnectionManager } = require('./connections');
const { SftpManager } = require('./sftp');
const localfs = require('./localfs');
const nettools = require('./nettools');
const importers = require('./importers');
const serial = require('./serial');
const { CaptureManager, readCaptureFile } = require('./capture');
const { saveCaptureBody, saveSipExport } = require('./capture/export');
const elevate = require('./capture/elevate');
const notepad = require('./notepad');

const { productName: PRODUCT, version: VERSION } = require('../../package.json');
const CAPTURE = process.env.KONX_CAPTURE;

let win = null;
let store;
let connections;
let sftp;
let capture;
let npStore;
let npWatcher;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---- prompts shown by the renderer on behalf of the main process ----
let promptSeq = 0;
const pendingPrompts = new Map();
function ask(payload) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const id = ++promptSeq;
    pendingPrompts.set(id, resolve);
    send('ui:prompt', { id, ...payload });
  });
}
ipcMain.handle('ui:promptResponse', (_e, id, value) => {
  const r = pendingPrompts.get(id);
  pendingPrompts.delete(id);
  if (r) r(value);
});

function defaultLogDir() {
  return store.getSettings().logDir || path.join(app.getPath('documents'), PRODUCT, 'Logs');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: PRODUCT,
    backgroundColor: '#15181d',
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !CAPTURE,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (!CAPTURE) win.once('ready-to-show', () => win.show());
  else runCapture();

  // Links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (connections.conns.size && !CAPTURE) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Disconnect and quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `You have ${connections.conns.size} active connection(s).`,
        detail: 'Close them and exit?',
      });
      if (choice === 1) e.preventDefault();
    }
  });
  win.on('closed', () => (win = null));
}

/** Dev/test hook: run a demo script in the page, then save a screenshot and quit. */
function runCapture() {
  // Hidden windows stop painting, so show it fully transparent and unfocusable instead.
  win.setOpacity(0);
  win.setFocusable(false);
  win.setSkipTaskbar(true);
  win.showInactive();
  win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  win.webContents.once('did-finish-load', async () => {
    try {
      if (process.env.KONX_DEMO) {
        const code = fs.readFileSync(process.env.KONX_DEMO, 'utf8');
        await win.webContents.executeJavaScript(code);
      }
      await new Promise((r) => setTimeout(r, Number(process.env.KONX_CAPTURE_DELAY) || 1500));
      const img = await win.webContents.capturePage(undefined, { stayHidden: true });
      fs.writeFileSync(CAPTURE, img.toPNG());
      console.log('captured', CAPTURE, img.getSize());
    } catch (e) {
      console.error('capture failed', e);
    }
    app.exit(0);
  });
}

/**
 * Get Npcap's official installer (downloaded and signature-checked by assets/get-npcap.ps1,
 * the same script the KonX installer uses) and open it. Windows asks for admin rights and
 * the user goes through Npcap's own setup and license.
 */
async function installNpcap() {
  if (process.platform !== 'win32') throw new Error('Npcap is for Windows');
  const script = path.join(__dirname, '../../assets/get-npcap.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const out = path.join(app.getPath('temp'), 'konx-npcap-setup.exe');
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await new Promise((resolve) =>
    execFile(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out], { windowsHide: true, timeout: 300000 }, (err, stdout) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, text: String(stdout || (err && err.message) || '').trim() })
    )
  );
  if (result.code !== 0 || !result.text.startsWith('OK')) throw new Error(result.text.replace(/^ERROR:\s*/, '') || 'Download failed');
  const openErr = await shell.openPath(out);
  if (openErr) throw new Error(openErr);
  return { message: result.text };
}

/**
 * Start KonX itself as the capture helper with administrator rights (Windows shows its UAC
 * prompt) for the built-in capture engine. KONX_CAPTURE_NO_ELEVATE starts it without the
 * prompt instead, for testing.
 */
function launchCaptureHelper(args) {
  const full = app.isPackaged ? args : [app.getAppPath(), ...args];
  if (process.env.KONX_CAPTURE_NO_ELEVATE) {
    spawn(process.execPath, full, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return Promise.resolve();
  }
  const hwnd = win && !win.isDestroyed() ? Number(win.getNativeWindowHandle().readBigUInt64LE(0)) : 0;
  return elevate.shellExecute(process.execPath, full, { verb: 'runas', hwnd });
}

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));

  // app
  handle('app:info', () => ({
    name: PRODUCT,
    version: VERSION,
    platform: process.platform,
    serial: serial.serialAvailable(),
    encryption: safeStorage.isEncryptionAvailable(),
    defaultSweep: nettools.defaultSweepTarget(),
    logDir: defaultLogDir(),
    secureCrtDir: importers.defaultSecureCrtDir(),
  }));
  handle('app:openExternal', (url) => {
    if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url);
  });
  handle('app:openPath', (p) => shell.openPath(p));
  handle('app:showItem', (p) => shell.showItemInFolder(p));
  handle('app:devtools', () => win && win.webContents.toggleDevTools());
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', (t) => clipboard.writeText(String(t)));
  handle('dialog:openFile', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])], ...opts });
    return r.canceled ? null : opts.multi ? r.filePaths : r.filePaths[0];
  });
  handle('dialog:openDir', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], ...opts });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:saveText', async (defaultName, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, text);
    return r.filePath;
  });

  // settings
  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => {
    const s = store.setSettings(patch);
    if (patch.sftpConcurrency) sftp.queue.concurrency = Number(patch.sftpConcurrency) || 2;
    return s;
  });

  // sessions
  handle('sessions:list', () => store.listSessions());
  handle('sessions:save', (s) => store.saveSession(s));
  handle('sessions:delete', (id) => store.deleteSession(id));
  handle('sessions:addFolder', (f) => store.addFolder(f));
  handle('sessions:renameFolder', (a, b) => store.renameFolder(a, b));
  handle('sessions:deleteFolder', (f) => store.deleteFolder(f));
  handle('sessions:import', async (kind) => {
    let items;
    if (kind === 'securecrt') {
      const def = importers.defaultSecureCrtDir();
      const r = await dialog.showOpenDialog(win, {
        title: 'Select your SecureCRT "Sessions" folder',
        defaultPath: fs.existsSync(def) ? def : undefined,
        properties: ['openDirectory'],
      });
      if (r.canceled) return null;
      items = importers.importSecureCrt(r.filePaths[0]);
    } else {
      const def = path.join(app.getPath('home'), '.ssh', 'config');
      const r = await dialog.showOpenDialog(win, { title: 'Select an OpenSSH config file', defaultPath: def, properties: ['openFile'] });
      if (r.canceled) return null;
      items = importers.importSshConfig(r.filePaths[0]);
    }
    const saved = items.map((it) => {
      const { jumpName, ...rest } = it;
      return { saved: store.saveSession(rest), jumpName };
    });
    for (const { saved: s, jumpName } of saved) {
      if (!jumpName) continue;
      const j = saved.find((x) => x.saved.name === jumpName);
      if (j) store.saveSession({ id: s.id, jumpId: j.saved.id });
    }
    return saved.length;
  });
  handle('hostkeys:list', () => store.listHostKeys());
  handle('hostkeys:delete', (k) => store.deleteHostKey(k));

  // terminal connections
  handle('conn:open', (id, spec, size) => connections.open(id, spec, size));
  ipcMain.on('conn:write', (_e, id, data, binary) => connections.write(id, data, binary));
  ipcMain.on('conn:resize', (_e, id, cols, rows) => connections.resize(id, cols, rows));
  handle('conn:close', (id) => connections.close(id));
  handle('conn:break', (id) => connections.sendBreak(id));
  handle('conn:startLog', (id) => connections.startLog(id));
  handle('conn:stopLog', (id) => connections.stopLog(id));
  handle('conn:info', (id) => connections.info(id));
  handle('serial:list', () => serial.listPorts());

  // sftp
  handle('sftp:open', (id, spec) => sftp.open(id, spec));
  handle('sftp:list', (id, dir) => sftp.list(id, dir));
  handle('sftp:realpath', (id, p) => sftp.realpath(id, p));
  handle('sftp:mkdir', (id, dir) => sftp.mkdir(id, dir));
  handle('sftp:rename', (id, a, b) => sftp.rename(id, a, b));
  handle('sftp:remove', (id, paths) => sftp.remove(id, paths));
  handle('sftp:chmod', (id, paths, mode) => sftp.chmod(id, paths, mode));
  handle('sftp:upload', (id, local, remoteDir, opts) =>
    sftp.upload(id, local, remoteDir, { ...opts, onDone: () => send('sftp:changed', id, 'remote', remoteDir) })
  );
  handle('sftp:download', (id, remote, localDir, opts) =>
    sftp.download(id, remote, localDir, { ...opts, onDone: () => send('sftp:changed', id, 'local', localDir) })
  );
  handle('sftp:edit', (id, remotePath) => sftp.edit(id, remotePath));
  handle('sftp:readFile', (id, remotePath) => sftp.readFile(id, remotePath));
  handle('sftp:writeFile', (id, remotePath, bytes) => sftp.writeFile(id, remotePath, bytes));
  handle('sftp:close', (id) => sftp.close(id));
  handle('xfer:cancel', (jid) => sftp.queue.cancel(jid));
  handle('xfer:clear', () => sftp.queue.clearFinished());

  // local files
  handle('local:list', (dir) => localfs.list(dir));
  handle('local:home', () => localfs.home());
  handle('local:parent', (dir) => localfs.parent(dir));
  handle('local:mkdir', (dir) => localfs.mkdir(dir));
  handle('local:rename', (a, b) => localfs.rename(a, b));
  handle('local:trash', async (paths) => {
    for (const p of paths) await shell.trashItem(p);
  });

  // network tools
  const jobs = new Map();
  let jobSeq = 0;
  const runners = {
    ping: nettools.pingMonitor,
    sweep: nettools.sweep,
    portscan: nettools.portScan,
    traceroute: nettools.traceroute,
  };
  handle('tools:start', (kind, params) => {
    const fn = runners[kind];
    if (!fn) throw new Error('Unknown tool ' + kind);
    const id = ++jobSeq;
    const signal = { stopped: false, onStop: null };
    jobs.set(id, signal);
    const emit = (type, data) => send('tools:event', id, type, data);
    Promise.resolve()
      .then(() => fn(params, emit, signal))
      .then(
        () => emit('done', { stopped: signal.stopped }),
        (err) => emit('error', { message: err.message })
      )
      .finally(() => jobs.delete(id));
    return id;
  });
  handle('tools:stop', (id) => {
    const s = jobs.get(id);
    if (!s) return;
    s.stopped = true;
    if (s.onStop) s.onStop();
  });
  handle('tools:dns', (params) => nettools.dnsLookup(params));
  handle('tools:whois', (params) => nettools.whois(params));
  handle('tools:wol', (params) => nettools.wakeOnLan(params));
  handle('tools:interfaces', () => nettools.interfaces());
  handle('tools:arp', async () => [...(await nettools.arpTable())].map(([ip, mac]) => ({ ip, mac })));
  handle('tools:presets', () => ({ presets: nettools.PORT_PRESETS, services: nettools.SERVICES }));
  handle('tools:parseTargets', (t) => nettools.parseTargets(t).length);

  // notepad
  handle('np:open', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, { title: 'Open', defaultPath: opts.defaultPath, properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return r.filePaths.map((f) => {
      try {
        return notepad.readFile(f);
      } catch (e) {
        return { path: f, error: e.message };
      }
    });
  });
  handle('np:read', (p) => notepad.readFile(p));
  handle('np:write', (p, bytes) => {
    const r = notepad.writeFile(p, bytes);
    npWatcher.saved(p, r.mtime);
    return r;
  });
  handle('np:saveAs', async (defaultPath, bytes) => {
    const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'All files', extensions: ['*'] }, { name: 'Text', extensions: ['txt', 'cfg', 'conf', 'log'] }] });
    if (r.canceled || !r.filePath) return null;
    const w = notepad.writeFile(r.filePath, bytes);
    return { path: r.filePath, mtime: w.mtime };
  });
  handle('np:watch', (entries) => npWatcher.set(entries));
  handle('np:session:get', () => npStore.getSession());
  handle('np:session:set', (s) => npStore.setSession(s));
  ipcMain.on('np:backup', (_e, id, text) => {
    try {
      if (text == null) npStore.deleteBackup(id);
      else npStore.writeBackup(id, text);
    } catch {}
  });
  handle('np:backup:read', (id) => npStore.readBackup(id));
  handle('np:pickDir', async (defaultPath) => {
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('np:pickFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  const npFinds = new Map();
  handle('np:find:start', (jobId, opts) => {
    const signal = { stopped: false };
    npFinds.set(jobId, signal);
    notepad
      .findInFiles(jobId, opts, send, signal)
      .catch((e) => send('np:findDone', jobId, { error: e.message }))
      .finally(() => npFinds.delete(jobId));
  });
  handle('np:find:stop', (jobId) => {
    const s = npFinds.get(jobId);
    if (s) s.stopped = true;
  });
  handle('np:hashText', (text) => notepad.hashText(text));
  handle('np:hashFile', (p) => notepad.hashFile(p));

  // packet capture
  handle('cap:status', () => capture.status());
  handle('cap:resetStatus', () => capture.resetStatus());
  handle('cap:selftest', () => capture.selfTest());
  handle('cap:installNpcap', () => installNpcap());
  handle('cap:devices', () => capture.devices());
  handle('cap:start', (id, opts) => capture.start(id, opts));
  handle('cap:stop', (id) => capture.stop(id));
  handle('cap:readFile', (p) => capture.readFile(p));
  handle('cap:sample', () => readCaptureFile(path.join(__dirname, '../../assets/samples/branch-office.pcapng')));
  handle('cap:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open capture file', filters: [{ name: 'Captures', extensions: ['pcapng', 'pcap', 'cap', 'dmp', 'etl'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    return { name: path.basename(r.filePaths[0]), bytes: await capture.readFile(r.filePaths[0]) };
  });
  handle('cap:save', async (defaultName, bytes) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'pcapng', extensions: ['pcapng'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, Buffer.from(bytes));
    return r.filePath;
  });
  handle('cap:saveBody', (defaultName, bytes) => saveCaptureBody(defaultName, bytes, {
    chooseFile: (options) => dialog.showSaveDialog(win, options),
    writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
  }));
  handle('cap:saveSip', (format, bytes) => saveSipExport(format, bytes, {
    chooseFile: (options) => dialog.showSaveDialog(win, options),
    writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
  }));
}

app.whenReady().then(() => {
  const crypt = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  };
  store = new Store(app.getPath('userData'), crypt);
  connections = new ConnectionManager({ emit: send, ask, store, defaultLogDir });
  sftp = new SftpManager({
    emit: send,
    ask,
    store,
    connections,
    openExternal: (p) => shell.openPath(p),
    tempDir: () => path.join(app.getPath('temp'), PRODUCT.toLowerCase() + '-edit'),
  });
  sftp.queue.concurrency = Number(store.getSettings().sftpConcurrency) || 2;
  let elevated = null;
  capture = new CaptureManager({ emit: send, launch: launchCaptureHelper, elevated: () => (elevated ??= elevate.isElevated()) });
  npStore = new notepad.NotepadStore(app.getPath('userData'));
  npWatcher = new notepad.FileWatcher(send);
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  connections && connections.closeAll();
  sftp && sftp.closeAll();
  capture && capture.stopAll();
  app.quit();
});
