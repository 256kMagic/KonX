'use strict';

// A diagnostic shell belongs to this collector; the authenticated SSH client
// belongs to the terminal tab. Never send commands to, or close, that terminal.
const { StringDecoder } = require('node:string_decoder');
const { commandsForProfile, LIMITS, analyzeDevices } = require('./device-analysis');

const DEFAULTS = Object.freeze({ openTimeoutMs: 20000, commandTimeoutMs: 15000, settleMs: 80,
  commandBytes: LIMITS.commandBytes, totalBytes: LIMITS.totalBytes });
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const clean = (text) => text.replace(ANSI, '').replace(/\r\n?/g, '\n');
const CLI_ERROR = /^\s*%\s*(?:Invalid|Incomplete|Ambiguous|Unrecognized|Unknown command|Error|Authorization|Access denied|Permission denied)|^(?:[^\n]{0,120}:\s*)?(?:command not found|command authorization failed|permission denied|not authorized)\b/im;
const PAGER = /--\s*More\s*--|\bPress (?:any key|SPACE|space bar|<space>) to continue/i;
function utf8Prefix(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = Math.max(0, limit);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function listConnections(connections) {
  return [...connections.conns.values()].filter((c) => c.protocol === 'ssh' && !c.closed && c.stream && c.client)
    .map((c) => ({ id: c.id, label: String(c.session.name || c.session.host || c.id), host: String(c.session.host || ''), port: Number(c.session.port) || 22 }));
}

function failure(message, status = 'error', output = '') {
  return Object.assign(new Error(String(message).slice(0, 2048)), { status, output });
}

class DiagnosticShell {
  constructor(client, options, budget) {
    this.client = client; this.options = options; this.budget = budget;
    this.channel = null; this.waiter = null; this.prompt = null; this.closed = false; this.fatal = null;
    this.onClientClose = () => this.abort(failure('The SSH connection closed during collection.'));
    this.onClientError = (error) => this.abort(failure('SSH transport failed: ' + error.message));
    client.on('close', this.onClientClose); client.on('error', this.onClientError);
  }

  async open() {
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return; finished = true; clearTimeout(timer); this.openReject = null;
        error ? reject(error) : resolve();
      };
      this.openReject = (error) => finish(error);
      const timer = setTimeout(() => { const error = failure('Timed out opening a diagnostic SSH shell.', 'timeout'); this.fatal = error; finish(error); }, this.options.openTimeoutMs);
      try {
        this.client.shell({ term: 'vt100', cols: 512, rows: 1000 }, (error, channel) => {
          // Cancellation, timeout, or a disconnected client can precede the
          // asynchronous shell callback. Close only the newly returned channel.
          if (finished || this.closed || this.fatal) { if (channel) this.releaseChannel(channel); return; }
          if (error) { finish(failure('Cannot open a diagnostic shell: ' + error.message)); return; }
          this.channel = channel;
          channel.on('data', (bytes) => this.data(bytes));
          channel.stderr?.on('data', (bytes) => this.data(bytes));
          channel.on('error', (e) => this.abort(failure('Diagnostic shell failed: ' + e.message)));
          channel.on('close', () => { this.channelClosed = true; if (!this.closed) this.abort(failure('Diagnostic shell closed before collection completed.')); });
          // Install the reader before resolving: initial prompt bytes may arrive
          // immediately after the channel callback.
          this.initialPrompt = this.wait(null, this.options.openTimeoutMs);
          this.initialPrompt.catch(() => {});
          finish();
        });
      } catch (error) { finish(failure('Cannot open a diagnostic shell: ' + error.message)); }
    });
    await this.initialPrompt;
  }

  wait(command, timeoutMs) {
    if (this.closed || this.fatal) return Promise.reject(this.fatal || failure('Collection cancelled.', 'cancelled'));
    return new Promise((resolve, reject) => {
      const w = { command, resolve, reject, text: '', bytes: 0, decoder: new StringDecoder('utf8'), quiet: null };
      w.timer = setTimeout(() => this.abort(failure(command ? 'Timed out waiting for the command prompt.' : 'No supported Cisco EXEC prompt was received.', 'timeout')), timeoutMs);
      this.waiter = w;
    });
  }

  data(value) {
    const w = this.waiter;
    if (!w || this.closed) return;
    clearTimeout(w.quiet);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = Math.min(this.options.commandBytes - w.bytes, this.budget.remaining);
    const accepted = bytes.subarray(0, Math.max(0, remaining));
    const decoded = w.decoder.write(accepted);
    // Invalid UTF-8 can expand to replacement characters. Charge the larger of
    // wire and retained UTF-8 size, so imported-report limits still hold.
    const cost = Math.max(accepted.length, Buffer.byteLength(decoded));
    const retained = utf8Prefix(decoded, Math.max(0, remaining));
    w.bytes += Math.min(cost, Math.max(0, remaining)); this.budget.remaining -= Math.min(cost, Math.max(0, remaining));
    w.text += retained;
    if (accepted.length < bytes.length || cost > remaining) return this.abort(failure('Collection output limit reached; remaining output was not read.', 'truncated'));
    const tail = clean(w.text.slice(-2048));
    if (PAGER.test(tail)) return this.abort(failure('The device paged command output; collection stopped before the missing pages.', 'truncated'));
    const last = tail.split('\n').at(-1).trim();
    if (!this.prompt) {
      if (!/^[A-Za-z0-9_.:/-]{1,100}[#>]$/.test(last)) return;
    } else if (last !== this.prompt) return;
    w.quiet = setTimeout(() => {
      if (this.waiter !== w || this.closed) return;
      const text = clean(w.text + w.decoder.end());
      const lines = text.split('\n');
      if (lines.at(-1).trim() !== last) return;
      lines.pop();
      if (!this.prompt) this.prompt = last;
      // A shell may echo the command directly, with the prompt prefixed, or not
      // at all. Strip only an exact command echo, never arbitrary first lines.
      while (lines.length && !lines[0].trim()) lines.shift();
      if (w.command && [w.command, this.prompt + w.command, this.prompt + ' ' + w.command].includes(lines[0]?.trim())) lines.shift();
      clearTimeout(w.timer); this.waiter = null;
      w.resolve(lines.join('\n').replace(/^\n|\n$/g, ''));
    }, this.options.settleMs);
  }

  async command(command) {
    const result = this.wait(command, this.options.commandTimeoutMs);
    if (!this.waiter) return result;
    try { this.channel.write(command + '\r'); }
    catch (error) { this.abort(failure('Could not send the diagnostic command: ' + error.message)); }
    return result;
  }

  abort(error) {
    if (!this.fatal) this.fatal = error;
    this.openReject?.(this.fatal);
    const w = this.waiter;
    if (w) {
      this.waiter = null; clearTimeout(w.timer); clearTimeout(w.quiet);
      this.fatal.output = clean(utf8Prefix(w.text + w.decoder.end(), this.options.commandBytes));
      w.reject(this.fatal);
    }
    this.close();
  }

  releaseChannel(channel) {
    // ssh2's destroy() requests EOF + CLOSE for this channel, not its client.
    channel.on('error', () => {});
    try { channel.destroy(); } catch { try { channel.close(); } catch {} }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.client.removeListener('close', this.onClientClose);
    this.client.removeListener('error', this.onClientError);
    if (this.channel) this.releaseChannel(this.channel);
  }
}

/** Internal collection boundary, shared by the tool runner and local fixtures. */
async function collectDevice(borrowed, metadata, signal, budget, options = DEFAULTS) {
  const shell = new DiagnosticShell(borrowed.client, { ...DEFAULTS, ...options }, budget);
  const commands = [];
  const selectedCommands = commandsForProfile(metadata.profile, metadata.includeRunningConfig);
  let problem = null;
  const stop = () => shell.abort(failure('Collection cancelled.', 'cancelled'));
  signal.onStop = stop;
  try {
    if (signal.stopped) stop();
    if (signal.stopped) throw failure('Collection cancelled.', 'cancelled');
    await shell.open();
    const setup = await shell.command('terminal length 0');
    if (CLI_ERROR.test(setup)) throw failure('The device did not accept session-local paging control: ' + setup.slice(0, 500));
    for (const item of selectedCommands) {
      if (signal.stopped) throw failure('Collection cancelled.', 'cancelled');
      try {
        const output = await shell.command(item.command);
        commands.push({ ...item, output, status: CLI_ERROR.test(output) ? 'error' : 'ok', ...(CLI_ERROR.test(output) ? { error: 'The device rejected this command.' } : {}) });
      } catch (error) {
        commands.push({ ...item, output: error.output || '', status: error.status || 'error', error: error.message });
        throw error;
      }
    }
  } catch (error) { problem = error; }
  finally { if (signal.onStop === stop) signal.onStop = null; shell.close(); }
  if (problem) {
    for (const item of selectedCommands.slice(commands.length)) commands.push({ ...item, output: '', status: problem.status || 'error', error: 'Not collected: ' + problem.message });
  }
  return { ...metadata, commands };
}

async function run(params, emit, signal, connections) {
  const profile = params?.profile || 'inventory';
  const includeRunningConfig = params?.includeRunningConfig === true;
  const selectedCommands = commandsForProfile(profile, includeRunningConfig);
  const ids = params?.connectionIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.devices || ids.some((id) => typeof id !== 'string' || !id || id.length > 128) || new Set(ids).size !== ids.length) {
    throw new Error(`Choose between one and ${LIMITS.devices} distinct connected SSH sessions.`);
  }
  const available = listConnections(connections);
  const selected = ids.map((id) => {
    const metadata = available.find((c) => c.id === id);
    const borrowed = connections.sshClient(id);
    if (!metadata || !borrowed) throw new Error('A selected SSH terminal is no longer connected. Refresh the connection list.');
    return { metadata: { ...metadata, profile, includeRunningConfig }, borrowed };
  });
  // Validate the selected public metadata at the report's owning boundary
  // before starting any remote commands, including unusually long saved names.
  try { analyzeDevices({ devices: selected.map(({ metadata }) => ({ ...metadata, connectionId: metadata.id, commands: [] })) }); }
  catch (error) { throw new Error('A selected session cannot be represented in Device Inspector: ' + error.message); }
  const devices = [];
  const budget = { remaining: DEFAULTS.totalBytes };
  for (const { metadata, borrowed } of selected) {
    if (signal.stopped) break;
    emit('progress', { phase: `Collecting ${metadata.label} (${devices.length + 1}/${selected.length})…` });
    const observedAt = new Date().toISOString();
    if (connections.sshClient(metadata.id)?.client !== borrowed.client) {
      devices.push({ ...metadata, connectionId: metadata.id, collectedAt: observedAt,
        commands: selectedCommands.map((item) => ({ ...item, output: '', status: 'error', error: 'The original SSH connection is no longer available.' })) });
      continue;
    }
    devices.push(await collectDevice(borrowed, { ...metadata, connectionId: metadata.id, collectedAt: observedAt }, signal, budget));
  }
  if (devices.length) emit('report', analyzeDevices({ devices }));
}

module.exports = { listConnections, run, collectDevice };
