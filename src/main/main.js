'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

if (process.env.KONX_USERDATA) app.setPath('userData', process.env.KONX_USERDATA);

const { Store } = require('./store');
const { ConnectionManager } = require('./connections');
const { WorkspaceWindows, isPrimaryFrame } = require('./workspace-windows');
const { collectSupportReport, validateSupportExport } = require('./support-report');
const { SftpManager } = require('./sftp');
const localfs = require('./localfs');
const nettools = require('./nettools');
const security = require('./security');
const wifi = require('./wifi');
const deviceAnalysis = require('./device-analysis');
const deviceCollector = require('./device-collector');
const remoteCapture = require('./remote-capture');
const { RemoteCaptureResults } = require('./remote-results');
const runbooks = require('./runbooks');
const { RunbookStore } = require('./runbook-store');
const { SnapshotStore, compareSnapshots } = require('./device-snapshots');
const { IncidentStore } = require('./incidents');
const { SiteWorkspaceStore } = require('./site-workspaces');
const { registerSiteWorkspaces } = require('./site-workspace-ipc');
const { registerTopology } = require('./topology-ipc');
const { EventConsole } = require('./events');
const { registerEvents } = require('./events-ipc');
const { ChangeValidationStore } = require('./change-validation');
const { registerChangeValidation } = require('./change-validation-ipc');
const { MistClient } = require('./mist');
const { AIClient } = require('./ai');
const { CopilotStore } = require('./copilot-store');
const { CopilotService } = require('./copilot');
const { registerCopilot } = require('./copilot-ipc');
const { CopilotActions } = require('./copilot-actions');
const { createActionDiagnostics } = require('./copilot-action-diagnostics');
const { registerCopilotActions } = require('./copilot-actions-ipc');
const { KnowledgeLibrary } = require('./knowledge');
const { UpdateManager } = require('./updater');
const { getInstallTarget, launchUpdate } = require('./update-install');
const { UpdateController } = require('./update-controller');
const importers = require('./importers');
const serial = require('./serial');
const { CaptureManager, readCaptureFile } = require('./capture');
const { saveCaptureBody, saveSipExport } = require('./capture/export');
const elevate = require('./capture/elevate');
const notepad = require('./notepad');

const { productName: PRODUCT, version: VERSION } = require('../../package.json');
const CAPTURE = process.env.KONX_CAPTURE;
const MAX_DEVICE_REPORT_BYTES = 20 * 1024 * 1024;

let win = null;
let store;
let connections;
let sftp;
let capture;
let npStore;
let npWatcher;
let mist;
let ai;
let copilot;
let copilotActions;
let knowledge;
let snapshots;
let incidents;
let sites;
let remoteResults;
let runbookStore;
let events;
let changes;
let updates;
let workspaceWindows;
const toolJobs = new Map();
let remoteReservations = 0;
let toolsShuttingDown = false;
let ownedConnectionQuitApproved = false;

function ownedToolJobs() { return [...toolJobs.values()].filter(signal => ['remote-capture', 'runbook', 'events', 'copilot', 'copilot-action'].includes(signal.kind)); }
function hasToolOwnership() { return remoteReservations > 0 || ownedToolJobs().length > 0 || !!remoteResults?.hasOpenHandles || !!remoteCapture.hasPendingCleanup || !!runbookStore?.hasOwnership || !!sites?.hasOwnership || !!events?.hasOwnership || !!changes?.hasOwnership || !!incidents?.hasOwnership || !!copilot?.hasOwnership || !!copilotActions?.hasOwnership || !!ai?.hasOwnership; }
function hasSerialOwnership() { return !!connections?.hasSerialOwnership; }
function hasPopoutOwnership() { return !!workspaceWindows?.hasOwnership; }
function dialogOwner() { return workspaceWindows?.dialogOwner() || (win && !win.isDestroyed() ? win : undefined); }
function confirmConnectionQuit() {
  return dialog.showMessageBoxSync(dialogOwner(), {
    type: 'question', buttons: ['Disconnect and quit', 'Cancel'], defaultId: 0, cancelId: 1,
    message: `You have ${connections.conns.size} active connection(s).`, detail: 'Close them and exit?',
  }) === 0;
}

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
ipcMain.handle('ui:promptResponse', (event, id, value) => {
  if (!isPrimaryFrame(event, win)) throw new Error('Only the primary KonX window may answer connection prompts.');
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
  workspaceWindows = new WorkspaceWindows({ primary: win, BrowserWindow, emit: send, openExternal: url => shell.openExternal(url) });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (updates?.installing && !updates.committed) {
      e.preventDefault();
      return;
    }
    // Native close must retain the window and SSH transport until capture jobs
    // and their registered file handles have finished cleanup. A failed close
    // can then be shown to the user instead of silently exiting headlessly.
    if (hasToolOwnership() || hasSerialOwnership() || hasPopoutOwnership()) {
      e.preventDefault();
      app.quit();
      return;
    }
    if (connections.conns.size && !CAPTURE && !ownedConnectionQuitApproved && !confirmConnectionQuit()) e.preventDefault();
    ownedConnectionQuitApproved = false;
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
  const handle = (ch, fn) => ipcMain.handle(ch, (event, ...args) => {
    if (!isPrimaryFrame(event, win)) throw new Error('Only the primary KonX window may use application IPC.');
    // Completion acknowledgments release owned work even while an updater has
    // frozen new starts. The primary-frame check above still applies.
    if (['app:popoutClose', 'tools:copilotActionEditorAck', 'tools:copilotActionDiscard'].includes(ch)) return fn(...args);
    return updates ? updates.invoke(ch, () => fn(...args)) : fn(...args);
  });
  registerSiteWorkspaces(handle, { sites, dialog, dialogOwner, isClosing: () => toolsShuttingDown || updateShutdownPending });
  registerTopology(handle, { dialog, dialogOwner, isClosing: () => toolsShuttingDown || updateShutdownPending });
  registerEvents(handle, { events, isClosing: () => toolsShuttingDown || updateShutdownPending });
  registerChangeValidation(handle, { changes, dialog, dialogOwner, isClosing: () => toolsShuttingDown || updateShutdownPending });
  registerCopilot(handle, { copilot, isClosing: () => toolsShuttingDown || updateShutdownPending });
  registerCopilotActions(handle, { actions: copilotActions, isClosing: () => toolsShuttingDown || updateShutdownPending });
  handle('app:popoutPrepare', () => {
    if (toolsShuttingDown || updateShutdownPending) throw new Error('KonX is closing. Wait before opening another window.');
    return workspaceWindows.prepare();
  });
  handle('app:popoutClose', id => workspaceWindows.close(id));
  handle('app:windowVisibility', () => workspaceWindows.visibilityState());
  handle('app:supportPreview', (options = {}) => collectSupportReport({
    info: { version: VERSION, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node,
      mode: app.isPackaged ? updates?.target?.mode || 'unknown' : 'development',
      features: { serial: serial.serialAvailable(), encryption: safeStorage.isEncryptionAvailable() } },
    screens: screen.getAllDisplays(), counts: { tabs: options?.tabs, connections: connections.conns.size, jobs: toolJobs.size },
    includeLogs: options?.includeLogs === true, logDir: path.join(app.getPath('userData'), 'diagnostics'),
    redactPaths: [app.getPath('home'), app.getPath('userData')],
  }));
  handle('app:supportExport', async text => {
    const content = validateSupportExport(text);
    const result = await dialog.showSaveDialog(dialogOwner(), { title: 'Save reviewed diagnostic report',
      defaultPath: `KonX-${VERSION}-support.json`, filters: [{ name: 'JSON report', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 });
    return result.filePath;
  });

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
  handle('app:updateState', () => updates.snapshot());
  handle('app:updateStart', () => {
    if (updateShutdownPending) throw new Error('KonX is closing. Wait for it to finish before starting another update.');
    return updates.start();
  });
  handle('app:updateCancel', () => updates.cancel());
  handle('app:updateInstall', () => updates.install());
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', (t) => clipboard.writeText(String(t)));
  handle('dialog:openFile', async (opts = {}) => {
    const r = await dialog.showOpenDialog(dialogOwner(), { properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])], ...opts });
    return r.canceled ? null : opts.multi ? r.filePaths : r.filePaths[0];
  });
  handle('dialog:openDir', async (opts = {}) => {
    const r = await dialog.showOpenDialog(dialogOwner(), { properties: ['openDirectory'], ...opts });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:saveText', async (defaultName, text) => {
    const r = await dialog.showSaveDialog(dialogOwner(), { defaultPath: defaultName });
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
      const r = await dialog.showOpenDialog(dialogOwner(), {
        title: 'Select your SecureCRT "Sessions" folder',
        defaultPath: fs.existsSync(def) ? def : undefined,
        properties: ['openDirectory'],
      });
      if (r.canceled) return null;
      items = importers.importSecureCrt(r.filePaths[0]);
    } else {
      const def = path.join(app.getPath('home'), '.ssh', 'config');
      const r = await dialog.showOpenDialog(dialogOwner(), { title: 'Select an OpenSSH config file', defaultPath: def, properties: ['openFile'] });
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
  handle('conn:open', (id, spec, size) => {
    if (toolsShuttingDown || updateShutdownPending) throw new Error('KonX is closing. Wait before opening another connection.');
    return connections.open(id, spec, size);
  });
  ipcMain.on('conn:write', (event, id, data, binary) => { if (isPrimaryFrame(event, win)) connections.write(id, data, binary); });
  ipcMain.on('conn:resize', (event, id, cols, rows) => { if (isPrimaryFrame(event, win)) connections.resize(id, cols, rows); });
  handle('conn:close', (id) => connections.close(id));
  handle('conn:break', (id) => connections.sendBreak(id));
  handle('conn:startLog', (id) => {
    const file = connections.startLog(id);
    if (!file) throw new Error('Could not start logging. Check the console message and the log folder permissions.');
    return file;
  });
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
  const jobs = toolJobs;
  let jobSeq = 0;
  const runners = {
    events: (params, emit, signal) => events.run(params, emit, signal),
    device: (params, emit, signal) => deviceCollector.run(params, emit, signal, connections),
    runbook: (params, emit, signal) => runbooks.run(params, emit, signal, connections),
    'remote-capture': async (params, emit, signal) => {
      const report = await remoteCapture.run(params, (type, data) => { if (type !== 'report') emit(type, data); }, signal, connections, app.getPath('userData'));
      if (report) emit('report', await remoteResults.remember(report));
    },
    security: security.run,
    wifi: wifi.run,
    mist: (params, emit, signal) => mist.run(params, emit, signal),
    ai: (params, emit, signal) => ai.run(params, emit, signal),
    copilot: (params, emit, signal) => copilot.run(params, emit, signal),
    'copilot-action': (params, emit, signal) => copilotActions.run(params, emit, signal),
    ping: nettools.pingMonitor,
    sweep: nettools.sweep,
    portscan: nettools.portScan,
    traceroute: nettools.traceroute,
  };
  handle('tools:start', (kind, params, requestedId) => {
    const fn = runners[kind];
    if (!fn) throw new Error('Unknown tool ' + kind);
    if (requestedId !== undefined && (typeof requestedId !== 'string' || !requestedId || requestedId.length > 128)) throw new Error('Invalid tool job ID');
    const id = requestedId ?? ++jobSeq;
    if (jobs.has(id)) throw new Error('Tool job is already running');
    if (['remote-capture', 'runbook', 'events', 'copilot', 'copilot-action'].includes(kind) && (toolsShuttingDown || updateShutdownPending)) throw new Error('KonX is closing. Wait before starting another tool.');
    if (kind === 'remote-capture') {
      if (remoteCapture.hasPendingCleanup) throw new Error('Remote capture cleanup is pending. Quit KonX to retry cleanup before starting another capture.');
      remoteResults.assertCapacity(remoteReservations);
      remoteReservations++;
    }
    const signal = { stopped: false, onStop: null, kind };
    jobs.set(id, signal);
    const emit = (type, data) => send('tools:event', id, type, data);
    signal.task = Promise.resolve()
      .then(() => fn(params, emit, signal))
      .then(
        () => emit('done', { stopped: signal.stopped }),
        (err) => emit('error', { message: err.message })
      )
      .finally(() => { jobs.delete(id); if (kind === 'remote-capture') remoteReservations--; });
    return id;
  });
  handle('tools:stop', (id) => {
    const s = jobs.get(id);
    if (!s) return;
    s.stopped = true;
    if (s.onStop) s.onStop();
  });
  handle('tools:deviceConnections', () => deviceCollector.listConnections(connections));
  handle('tools:comparisonOpen', async () => {
    const result = await dialog.showOpenDialog(dialogOwner(), { title: 'Select capture for comparison', properties: ['openFile'],
      filters: [{ name: 'Packet captures', extensions: ['pcap', 'pcapng', 'cap', 'dmp'] }] });
    if (result.canceled || !result.filePaths[0] || !win || win.isDestroyed()) return null;
    const file = result.filePaths[0];
    return { name: path.basename(file), bytes: readCaptureFile(file, { maxBytes: 64 * 1024 * 1024 }) };
  });
  handle('tools:remoteCaptureRead', (id) => remoteResults.read(id));
  handle('tools:remoteCaptureRemove', (id) => remoteResults.remove(id));
  const requireRunbookReady = () => {
    if (toolsShuttingDown || updateShutdownPending || !win || win.isDestroyed()) throw new Error('KonX is closing. Wait before using saved procedures.');
  };
  const runbookOperation = operation => (...args) => { requireRunbookReady(); return operation(...args); };
  handle('tools:runbookTemplates', () => runbooks.getTemplates());
  handle('tools:runbookList', runbookOperation(() => runbookStore.list()));
  handle('tools:runbookGet', runbookOperation(id => runbookStore.get(id)));
  handle('tools:runbookSave', runbookOperation(params => runbookStore.save(params)));
  handle('tools:runbookRemove', runbookOperation(id => runbookStore.remove(id)));
  handle('tools:runbookImport', runbookOperation(async () => {
    const result = await dialog.showOpenDialog(dialogOwner(), { title: 'Import diagnostic runbook', properties: ['openFile'], filters: [{ name: 'Runbook JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    requireRunbookReady();
    return runbookStore.importFile(result.filePaths[0]);
  }));
  handle('tools:runbookExport', runbookOperation(async id => {
    await runbookStore.get(id);
    const result = await dialog.showSaveDialog(dialogOwner(), { title: 'Export saved diagnostic runbook', defaultPath: 'konx-runbook.json', filters: [{ name: 'Runbook JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    requireRunbookReady();
    return runbookStore.exportFile(id, result.filePath);
  }));
  handle('tools:snapshotSave', (params) => snapshots.save(params));
  const requireIncidentReady = () => {
    if (toolsShuttingDown || updateShutdownPending || !win || win.isDestroyed()) throw new Error('KonX is closing. Wait before using incident evidence.');
  };
  const incidentOperation = operation => (...args) => { requireIncidentReady(); return operation(...args); };
  handle('tools:incidentCreate', incidentOperation((params) => incidents.create(params)));
  handle('tools:incidentList', incidentOperation(() => incidents.list()));
  handle('tools:incidentGet', incidentOperation((id) => incidents.get(id)));
  handle('tools:incidentRemove', incidentOperation((id) => incidents.remove(id)));
  handle('tools:incidentAddText', incidentOperation((id, params) => incidents.addText(id, params)));
  handle('tools:incidentAddCapture', incidentOperation((id, params) => incidents.addBytes(id, { ...params, kind: 'capture' })));
  handle('tools:incidentCapture', incidentOperation((id, evidenceId) => incidents.readCapture(id, evidenceId)));
  handle('tools:incidentImport', incidentOperation(async (id, params) => {
    if (!['capture', 'terminal', 'tool', 'syslog', 'other'].includes(params?.kind)) throw new Error('Choose a supported evidence type.');
    await incidents.get(id);
    requireIncidentReady();
    const result = await dialog.showOpenDialog(dialogOwner(), { title: 'Add incident evidence', properties: ['openFile'],
      filters: params.kind === 'capture' ? [{ name: 'Packet captures', extensions: ['pcap', 'pcapng', 'cap'] }] : [{ name: 'Evidence files', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    requireIncidentReady();
    return incidents.addFile(id, { ...params, sourcePath: result.filePaths[0] });
  }));
  handle('tools:incidentExport', incidentOperation(async (id, format) => {
    if (!['html', 'json'].includes(format)) throw new Error('Choose HTML or JSON incident export.');
    const content = format === 'html' ? await incidents.exportHtml(id) : await incidents.exportJson(id);
    requireIncidentReady();
    const result = await dialog.showSaveDialog(dialogOwner(), { title: 'Export incident report', defaultPath: `konx-incident.${format}`,
      filters: [{ name: format === 'html' ? 'HTML report' : 'JSON report', extensions: [format] }] });
    if (result.canceled || !result.filePath) return null;
    requireIncidentReady();
    return incidents.writeExport(result.filePath, content);
  }));
  handle('tools:snapshotList', () => snapshots.list());
  handle('tools:snapshotGet', (id) => snapshots.get(id));
  handle('tools:snapshotRemove', (id) => snapshots.remove(id));
  handle('tools:snapshotCompare', async (params) => compareSnapshots(await snapshots.get(params?.beforeId), await snapshots.get(params?.afterId), params?.devicePairs));
  handle('tools:snapshotDemo', async () => {
    const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '../../assets/device-snapshot-demo.json'), 'utf8'));
    const before = await snapshots.save({ label: 'Demo before change', report: demo.before });
    try {
      const after = await snapshots.save({ label: 'Demo after change', report: demo.after });
      return { beforeId: before.id, afterId: after.id };
    } catch (error) {
      try { await snapshots.remove(before.id); } catch (cleanupError) { throw new Error(`${error.message} The first demo snapshot could not be removed: ${cleanupError.message}`); }
      throw error;
    }
  });
  handle('tools:deviceCommands', () => deviceAnalysis.COMMANDS);
  handle('tools:deviceDemo', () => deviceAnalysis.analyzeDevices(JSON.parse(fs.readFileSync(path.join(__dirname, '../../assets/device-inspector-demo.json'), 'utf8'))));
  handle('tools:deviceImport', async () => {
    const result = await dialog.showOpenDialog(dialogOwner(), { title: 'Open Device Inspector report', properties: ['openFile'], filters: [{ name: 'Device report', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = await fs.promises.open(result.filePaths[0], 'r');
    try {
      if ((await file.stat()).size > MAX_DEVICE_REPORT_BYTES) throw new Error('Device report exceeds the 20 MiB file limit.');
      const buffer = Buffer.alloc(MAX_DEVICE_REPORT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_DEVICE_REPORT_BYTES) throw new Error('Device report exceeds the 20 MiB file limit.');
      const input = buffer.subarray(0, length).toString('utf8');
      return deviceAnalysis.analyzeDevices(JSON.parse(input.replace(/^\uFEFF/, '')));
    } finally { await file.close(); }
  });
  handle('tools:deviceTrace', (devices, query) => deviceAnalysis.traceEndpoint(deviceAnalysis.analyzeDevices({ devices }).devices, query));
  handle('tools:deviceExport', async (input) => {
    const report = deviceAnalysis.analyzeDevices(input);
    const serialized = JSON.stringify(report, null, 2);
    if (Buffer.byteLength(serialized) > MAX_DEVICE_REPORT_BYTES) throw new Error('Serialized device report exceeds the 20 MiB file limit.');
    const result = await dialog.showSaveDialog(dialogOwner(), { defaultPath: `konx-device-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Device report', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, serialized);
    return result.filePath;
  });
  handle('tools:mistConfig', () => mist.getConfig());
  handle('tools:mistConfigure', (params) => mist.configure(params));
  handle('tools:aiConfig', () => ai.getConfig());
  handle('tools:aiConfigure', (params) => {
    if (toolsShuttingDown || updateShutdownPending) throw new Error('KonX is closing; wait before changing AI connection settings.');
    const config = ai.configure(params);
    for (const signal of jobs.values()) {
      if (!['ai', 'copilot'].includes(signal.kind)) continue;
      signal.stopped = true;
      try { signal.onStop?.(); } catch { /* Cancel the other AI jobs too. */ }
    }
    return config;
  });
  handle('tools:aiPreview', (params) => ai.preview(params?.context));
  handle('tools:knowledgeStatus', () => knowledge.status());
  handle('tools:knowledgeList', (params) => knowledge.list(params));
  handle('tools:knowledgeGet', (id) => knowledge.get(id));
  handle('tools:knowledgeSave', (article) => knowledge.save(article));
  handle('tools:knowledgeRemove', (id) => knowledge.remove(id));
  handle('tools:knowledgeRebuild', () => knowledge.rebuild());
  handle('tools:knowledgeOpenSource', async (id) => {
    const article = await knowledge.get(id);
    if (!article?.sourceUrl) throw new Error('This article has no source link.');
    let url;
    try { url = new URL(article.sourceUrl); } catch { throw new Error('This article has no source link.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Article sources must use HTTPS without embedded credentials.');
    await shell.openExternal(url.href);
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
    const r = await dialog.showOpenDialog(dialogOwner(), { title: 'Open', defaultPath: opts.defaultPath, properties: ['openFile', 'multiSelections'] });
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
    const r = await dialog.showSaveDialog(dialogOwner(), { defaultPath, filters: [{ name: 'All files', extensions: ['*'] }, { name: 'Text', extensions: ['txt', 'cfg', 'conf', 'log'] }] });
    if (r.canceled || !r.filePath) return null;
    const w = notepad.writeFile(r.filePath, bytes);
    return { path: r.filePath, mtime: w.mtime };
  });
  handle('np:watch', (entries) => npWatcher.set(entries));
  handle('np:session:get', () => npStore.getSession());
  handle('np:session:set', (s) => npStore.setSession(s));
  ipcMain.on('np:backup', (event, id, text) => {
    if (!isPrimaryFrame(event, win)) return;
    try {
      if (text == null) npStore.deleteBackup(id);
      else npStore.writeBackup(id, text);
    } catch {}
  });
  handle('np:backup:read', (id) => npStore.readBackup(id));
  handle('np:pickDir', async (defaultPath) => {
    const r = await dialog.showOpenDialog(dialogOwner(), { defaultPath, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('np:pickFile', async () => {
    const r = await dialog.showOpenDialog(dialogOwner(), { properties: ['openFile'] });
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
    const r = await dialog.showOpenDialog(dialogOwner(), { title: 'Open capture file', filters: [{ name: 'Captures', extensions: ['pcapng', 'pcap', 'cap', 'dmp', 'etl'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    return { name: path.basename(r.filePaths[0]), bytes: await capture.readFile(r.filePaths[0]) };
  });
  handle('cap:save', async (defaultName, bytes) => {
    const r = await dialog.showSaveDialog(dialogOwner(), { defaultPath: defaultName, filters: [{ name: 'pcapng', extensions: ['pcapng'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, Buffer.from(bytes));
    return r.filePath;
  });
  handle('cap:saveBody', (defaultName, bytes) => saveCaptureBody(defaultName, bytes, {
    chooseFile: (options) => dialog.showSaveDialog(dialogOwner(), options),
    writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
  }));
  handle('cap:saveSip', (format, bytes) => saveSipExport(format, bytes, {
    chooseFile: (options) => dialog.showSaveDialog(dialogOwner(), options),
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
  snapshots = new SnapshotStore(app.getPath('userData'));
  incidents = new IncidentStore(app.getPath('userData'));
  sites = new SiteWorkspaceStore(app.getPath('userData'));
  events = new EventConsole();
  changes = new ChangeValidationStore(app.getPath('userData'), { snapshots, incidents });
  remoteResults = new RemoteCaptureResults(app.getPath('userData'));
  runbookStore = new RunbookStore(app.getPath('userData'));
  mist = new MistClient({ dir: app.getPath('userData'), crypt });
  knowledge = new KnowledgeLibrary({ dir: app.getPath('userData') });
  ai = new AIClient({ dir: app.getPath('userData'), crypt, knowledge });
  const copilotStore = new CopilotStore(app.getPath('userData'));
  copilot = new CopilotService({ store: copilotStore, ai });
  copilotActions = new CopilotActions({ store: copilotStore, knowledge, diagnostics: createActionDiagnostics(), requestEditor: request => {
    if (toolsShuttingDown || updateShutdownPending || !win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    win.webContents.send('copilot:editorAction', request); return true;
  } });
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
  const updateTarget = getInstallTarget({ isPackaged: app.isPackaged });
  const updateCache = path.join(app.getPath('userData'), 'updates');
  const updateManager = new UpdateManager({
    version: VERSION,
    mode: updateTarget.mode || 'unsupported',
    reason: updateTarget.reason,
    cacheDir: updateCache,
    onState: () => updates?.changed(),
  });
  updates = new UpdateController({
    manager: updateManager, target: updateTarget, cacheDir: updateCache,
    busyReasons: () => {
      const reasons = [];
      if (connections.conns.size) reasons.push('Disconnect active terminal connections before updating.');
      if (hasSerialOwnership()) reasons.push('Serial ports are still in use. Close serial connections or quit KonX to retry pending cleanup before updating.');
      if (sftp.sessions.size || sftp.pending.size) reasons.push('Close SFTP sessions before updating.');
      if (sftp.queue.active.size || sftp.queue.jobs.some((job) => ['queued', 'running'].includes(job.status))) reasons.push('Finish or cancel file transfers before updating.');
      if (capture.sessions.size || capture.startRequests.size || capture.builtin.sessions.size || capture.builtin.startRequests.size) reasons.push('Stop packet capture before updating.');
      if (toolJobs.size) reasons.push('Stop running tools and AI requests before updating.');
      if (copilot.hasOwnership) reasons.push('Wait for KonX-AI to save its work or quit KonX to retry pending cleanup before updating.');
      if (copilotActions.hasOwnership) reasons.push('Wait for reviewed KonX-AI actions to finish or quit KonX to retry saving their outcomes before updating.');
      if (remoteCapture.hasPendingCleanup) reasons.push('Quit KonX to retry pending remote capture file cleanup before updating.');
      if (remoteResults.hasPendingCleanup) reasons.push('Quit KonX to retry pending remote capture result cleanup before updating.');
      if (runbookStore.hasPendingCleanup) reasons.push('Quit KonX to retry pending runbook file cleanup before updating.');
      if (events.hasOwnership) reasons.push('Stop event listeners and retry pending socket cleanup before updating.');
      if (changes.hasOwnership) reasons.push('Wait for change validation operations or quit KonX to retry pending file cleanup before updating.');
      if (incidents.hasOwnership) reasons.push('Wait for incident evidence operations or quit KonX to retry pending file cleanup before updating.');
      if (sites.hasOwnership) reasons.push('Wait for saved workspace operations or quit KonX to retry pending file cleanup before updating.');
      if (ai.hasOwnership) reasons.push('Quit KonX to retry encrypted AI settings cleanup before updating.');
      if (pendingPrompts.size) reasons.push('Finish the open connection prompts before updating.');
      if (knowledge.busy) reasons.push('Wait for the knowledge library to finish its current operation.');
      return reasons;
    },
    launch: launchUpdate,
    quit: () => setImmediate(() => app.quit()),
    onState: (state) => send('app:updateState', state),
  });
  registerIpc();
  createWindow();
});

// Let downloads and owned tools finish before Electron exits. A
// committed installer retains its payload, but still waits for owned resources.
let updateShutdownPending = false;
let updateShutdownComplete = false;
app.on('before-quit', (event) => {
  if (!updates && !hasToolOwnership() && !hasSerialOwnership() && !hasPopoutOwnership()) return;
  if (updateShutdownComplete) {
    // Consume this single retry. If a close prompt cancels it, a future quit
    // still has to cancel any downloads started in the meantime.
    updateShutdownComplete = false;
    toolsShuttingDown = false;
    return;
  }
  if (updates?.committed && !hasToolOwnership() && !hasSerialOwnership() && !hasPopoutOwnership()) return;
  event.preventDefault();
  if ((updates?.installing && !updates.committed) || updateShutdownPending) return;
  // Serial shutdown must release its handles before the window can close, so
  // obtain the existing disconnect consent before starting that cleanup.
  if ((hasSerialOwnership() || hasPopoutOwnership()) && connections.conns.size && !CAPTURE && !ownedConnectionQuitApproved) {
    if (!confirmConnectionQuit()) return;
    ownedConnectionQuitApproved = true;
  }
  updateShutdownPending = true;
  toolsShuttingDown = true;
  const finishOwners = async () => {
    const jobs = ownedToolJobs();
    for (const signal of jobs) {
      signal.stopped = true;
      try { signal.onStop?.(); } catch { /* The task remains owned and awaited. */ }
    }
    // Preserve the existing ordinary updater cleanup behavior; only failures
    // from owned capture/runbook resources block exit and require retry.
    let updateCleanup;
    try { updateCleanup = updates && !updates.committed ? Promise.resolve(updates.shutdown()).catch(() => {}) : Promise.resolve(); }
    catch { updateCleanup = Promise.resolve(); }
    const popoutCleanup = workspaceWindows ? workspaceWindows.redockAll().then(() => null, error => error.message) : Promise.resolve(null);
    await Promise.allSettled(jobs.map(signal => signal.task));
    const cleanupErrors = [];
    const popoutError = await popoutCleanup;
    if (popoutError) cleanupErrors.push(popoutError);
    for (const cleanup of [() => remoteCapture.closePending(), () => remoteResults?.close(), () => runbookStore?.close(), () => sites?.close(), () => events?.close(), () => changes?.close(), () => incidents?.close(), () => copilotActions?.close(), () => copilot?.close(), () => ai?.close?.(),
      () => hasSerialOwnership() ? connections.waitForSerialCleanup() : undefined]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error.message); }
    }
    if (remoteResults?.hasOpenHandles || remoteCapture.hasPendingCleanup || runbookStore?.hasOwnership) cleanupErrors.push('Capture or runbook resources still require cleanup.');
    if (events?.hasOwnership) cleanupErrors.push('Event listener sockets still require cleanup.');
    if (changes?.hasOwnership) cleanupErrors.push('Change validation resources still require cleanup.');
    if (incidents?.hasOwnership) cleanupErrors.push('Incident evidence resources still require cleanup.');
    if (sites?.hasOwnership) cleanupErrors.push('Saved workspace resources still require cleanup.');
    if (copilot?.hasOwnership) cleanupErrors.push('KonX-AI resources still require cleanup.');
    if (copilotActions?.hasOwnership) cleanupErrors.push('Reviewed KonX-AI action outcomes still require cleanup.');
    if (ai?.hasOwnership) cleanupErrors.push('Encrypted AI settings temporary files still require cleanup.');
    if (hasSerialOwnership()) cleanupErrors.push('Serial port resources still require cleanup.');
    await updateCleanup;
    if (cleanupErrors.length) throw new Error(cleanupErrors.join('\n'));
  };
  finishOwners().then(() => {
    updateShutdownPending = false;
    updateShutdownComplete = true;
    app.quit();
  }, error => {
    updateShutdownPending = false;
    toolsShuttingDown = false;
    ownedConnectionQuitApproved = false;
    dialog.showMessageBoxSync(dialogOwner(), {
      type: 'error', buttons: ['OK'], title: 'KonX could not finish closing',
      message: 'Connection or tool cleanup did not finish. KonX has stayed open.',
      detail: `${error.message}\nTry quitting again to retry cleanup.`,
    });
  });
});

app.on('window-all-closed', () => {
  for (const signal of toolJobs.values()) {
    signal.stopped = true;
    try { signal.onStop?.(); } catch { /* Finish shutting down other jobs too. */ }
  }
  connections && connections.closeAll();
  sftp && sftp.closeAll();
  capture && capture.stopAll();
  knowledge && knowledge.close()?.catch?.(() => {});
  app.quit();
});
