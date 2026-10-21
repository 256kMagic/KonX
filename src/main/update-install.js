'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Electron's patched fs presents app.asar as a virtual directory. Target
// validation needs physical files; reads of our packaged helper still use fs.
const physicalFs = process.versions.electron ? require('original-fs') : fs;
const regular = (file) => { try { return physicalFs.lstatSync(file).isFile(); } catch { return false; } };
const safePath = (file) => typeof file === 'string' && path.isAbsolute(file) && !/[\0\r\n"]/.test(file);
const cleanEnvironment = (env) => Object.fromEntries(Object.entries(env).filter(([key]) =>
  !/^PORTABLE_EXECUTABLE_/i.test(key) && !/^(?:ELECTRON_RUN_AS_NODE|KONX_CAPTURE|KONX_DEMO)(?:_|$)/i.test(key)));

/** Identify only a packaged Windows x64 installation, never a development checkout. */
function getInstallTarget({ isPackaged, platform = process.platform, arch = process.arch, execPath = process.execPath, portablePath = process.env.PORTABLE_EXECUTABLE_FILE } = {}) {
  const unsupported = (reason) => ({ mode: 'unsupported', targetPath: '', reason });
  if (!isPackaged) return unsupported('Updates can be installed only by a packaged KonX application.');
  if (platform !== 'win32' || arch !== 'x64') return unsupported('Integrated updates support Windows x64 only.');
  if (portablePath) {
    if (!safePath(portablePath) || path.extname(portablePath).toLowerCase() !== '.exe' || !regular(portablePath)) return unsupported('The original portable executable could not be identified.');
    return { mode: 'portable', targetPath: path.resolve(portablePath), reason: '' };
  }
  if (!safePath(execPath) || path.basename(execPath).toLowerCase() !== 'konx.exe' || !regular(execPath)) return unsupported('The installed KonX executable could not be identified.');
  const directory = path.dirname(execPath);
  if (!regular(path.join(directory, 'resources', 'app.asar')) || !regular(path.join(directory, 'Uninstall KonX.exe'))) return unsupported('This unpacked application is not a registered KonX installation. Use the installer or portable release.');
  return { mode: 'installed', targetPath: path.resolve(execPath), reason: '' };
}

async function readJson(file) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size > 16384) throw new Error('Update helper response exceeds its size limit.');
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

/** Stage a fixed helper and verified payload; readiness is acknowledged before quitting. */
async function launchUpdate({ update, target, cacheDir, parentPid = process.pid, spawnImpl = spawn,
  readyTimeoutMs = 30000, exitTimeoutMs = 120000, replaceTimeoutMs = 30000, showFailure = true } = {}) {
  if (process.platform !== 'win32') throw new Error('Integrated update installation requires Windows.');
  if (!target || !['installed', 'portable'].includes(target.mode) || !safePath(target.targetPath) || !regular(target.targetPath)) throw new Error('The update installation target is unavailable.');
  if (!update || update.mode !== target.mode || !safePath(update.file) || !regular(update.file) || !/^[a-f0-9]{64}$/i.test(update.sha256) || !Number.isSafeInteger(update.size) || update.size <= 0 || update.size > 2 * 1024 ** 3 || typeof update.version !== 'string' || update.version.length > 100) throw new Error('The verified update download is invalid.');
  if (!safePath(cacheDir) || !Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('The update handoff configuration is invalid.');
  if (path.resolve(update.file).toLowerCase() === path.resolve(target.targetPath).toLowerCase()) throw new Error('The update download must be separate from the current application.');
  await fsp.mkdir(cacheDir, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(cacheDir, 'handoff-'));
  const scriptPath = path.join(directory, 'update-helper.ps1');
  const planPath = path.join(directory, 'plan.json');
  const statusPath = path.join(directory, 'status.json');
  const logPath = path.join(directory, 'helper.log');
  const readyPath = path.join(directory, 'ready.json');
  const startedPath = path.join(directory, 'started.json');
  const payload = path.join(directory, 'payload.exe');
  const token = crypto.randomBytes(24).toString('hex');
  const boundedTime = (value, fallback, maximum) => Number.isFinite(value) ? Math.min(maximum, Math.max(500, Math.floor(value))) : fallback;
  const plan = { schemaVersion: 1, token, parentPid, mode: target.mode, targetPath: path.resolve(target.targetPath),
    file: payload, sha256: update.sha256.toLowerCase(), size: update.size, version: update.version,
    exitTimeoutMs: boundedTime(exitTimeoutMs, 120000, 300000), replaceTimeoutMs: boundedTime(replaceTimeoutMs, 30000, 120000),
    commitTimeoutMs: 120000, showFailure: showFailure !== false };
  let helper;
  let exited = false;
  let exitCode;
  let helperPid;
  let spawnError;
  let state = 'preparing';
  const failure = (message) => Object.assign(new Error(`${message} Update diagnostics: ${statusPath}`), { statusPath });
  const signal = async (action) => {
    const controlPath = path.join(directory, `${action}.json`);
    if (await readJson(controlPath)) return;
    const temporary = path.join(directory, `control-${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.writeFile(temporary, JSON.stringify({ token, action }), { flag: 'wx' });
    await fsp.rename(temporary, controlPath);
  };
  const waitFor = async (predicate, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    let readError;
    while (Date.now() < until) {
      try {
        const status = await readJson(statusPath);
        const result = await predicate(status);
        readError = undefined;
        if (result) return result;
        if (status?.phase === 'failed') throw failure(status.message || 'The update helper failed.');
      } catch (error) {
        // ReplaceFile can briefly exclude readers on Windows. Only polling the
        // helper's state retries these failures, under the existing deadline;
        // writing commit/cancel signals still reports errors to the caller.
        if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        readError = error;
      }
      if (spawnError || (exited && exitCode !== 0)) throw failure(spawnError?.message || 'The update helper could not start.');
      await delay(50);
    }
    throw failure(`The update helper did not acknowledge the handoff in time.${readError ? ` Reading its state failed (${readError.code}).` : ''}`);
  };
  try {
    await fsp.copyFile(update.file, payload, fs.constants.COPYFILE_EXCL);
    await fsp.writeFile(scriptPath, await fsp.readFile(path.join(__dirname, 'update-helper.ps1')), { flag: 'wx' });
    await fsp.writeFile(planPath, JSON.stringify(plan), { flag: 'wx' });
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const log = await fsp.open(logPath, 'wx');
    try {
      helper = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PlanPath', planPath, '-Launch'],
        // This short bootstrap launches the independently hidden helper. A true
        // spawning-parent-exits regression covers its lifetime on Windows.
        { stdio: ['ignore', log.fd, log.fd], windowsHide: true, env: cleanEnvironment(process.env) });
    } finally { await log.close(); }
    helper.once('error', (error) => { spawnError = error; });
    helper.once('exit', (code) => { exited = true; exitCode = code; });
    helper.unref();
    await waitFor(async () => {
      const ready = await readJson(readyPath);
      const started = await readJson(startedPath);
      const valid = ready?.token === token && ready.parentPid === parentPid && /^\d+$/.test(ready.parentStartTicks)
        && started?.token === token && Number.isSafeInteger(started.helperPid) && started.helperPid > 0 && ready.helperPid === started.helperPid;
      if (valid) helperPid = ready.helperPid;
      return valid;
    }, boundedTime(readyTimeoutMs, 30000, 60000));
    state = 'ready';
  } catch (error) {
    // A helper that starts late still sees cancellation before it can install.
    await signal('cancel').catch(() => {});
    if (!helper || spawnError || (exited && exitCode !== 0)) await fsp.unlink(payload).catch(() => {});
    if (!error.statusPath) throw failure(error.message);
    throw error;
  }
  return {
    statusPath, helperPid,
    async commit() {
      if (state !== 'ready') throw failure('This update handoff is no longer ready to commit.');
      state = 'committing';
      try {
        await signal('commit');
        await waitFor((status) => status?.phase === 'waiting-for-exit', 10000);
        state = 'committed';
      } catch (error) { await signal('cancel').catch(() => {}); state = 'cancel-pending'; throw error; }
    },
    async cancel() {
      if (state === 'cancelled') return;
      state = 'cancelling';
      await signal('cancel');
      // Acknowledge while the parent remains alive; never kill a process to cancel.
      await waitFor((status) => ['cancelled', 'failed'].includes(status?.phase), 10000);
      state = 'cancelled';
    },
  };
}

module.exports = { getInstallTarget, launchUpdate };
