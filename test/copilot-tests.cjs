'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { AIClient } = require('../src/main/ai');
const { CopilotStore, LIMITS, normalizeSnapshot, emptyUsage, validateRecord } = require('../src/main/copilot-store');
const { CopilotService } = require('../src/main/copilot');
const { registerCopilot } = require('../src/main/copilot-ipc');
const KEY = 'Synthetic_Copilot_Key_Only_1234567890';
const secondKey = 'Second_Synthetic_Copilot_Key_1234567890';
const now = () => new Date().toISOString();
const tick = () => new Promise(resolve => setImmediate(resolve));
const stop = signal => { signal.stopped = true; signal.onStop?.(); };
const response = answer => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } });
const frame = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
function snapshot(overrides = {}) {
  return { schemaVersion: 1, kind: 'ping', title: 'Synthetic ping result', capturedAt: now(), source: { tabId: 'synthetic-tab', runId: 'owned-run', revision: 1 }, state: 'complete',
    scope: { inputs: { target: '127.0.0.1', count: 2 } }, selection: { mode: 'selected', ids: ['row:1'] }, facts: { rows: [{ id: 'row:1', latencyMs: 4, result: 'reply' }] },
    coverage: { observed: 1, total: 2, complete: false }, omissions: ['Only the selected reply was attached.'], ...overrides };
}
function crypt() {
  const key = crypto.randomBytes(32);
  return { available: () => true,
    encrypt(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    decrypt(value) { const data = Buffer.from(value, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString(); },
  };
}
async function fixture(fn, options = {}) {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'konx-copilot-test-'));
  const sockets = new Set(), calls = [], searches = [], refs = [{ id: 'synthetic-reference', title: 'Fixture guide', vendor: 'KonX', sourceUrl: 'https://example.test/guide', content: 'Original local reference excerpt.' }];
  let handler = options.handler || ((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response('Observed one selected reply. [K1]'))); });
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const raw = Buffer.concat(chunks).toString(); calls.push({ raw, body: JSON.parse(raw), headers: req.headers });
      Promise.resolve(handler(req, res, calls.at(-1))).catch(error => { res.destroy(error); });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (options, callback) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port }, callback);
  const ai = new AIClient({ dir, crypt: crypt(), request, knowledge: { search(query) { searches.push(query); return refs; } } }); ai.configure({ key: KEY });
  const store = new CopilotStore(dir, { fs: options.io || fsp, now: options.now });
  const service = new CopilotService({ store, ai, now: options.now });
  try { return await fn({ dir, ai, store, service, calls, searches, refs, sockets, setHandler: next => { handler = next; } }); }
  finally {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    try { await service.close(); } catch (error) { if (!options.allowRetained) throw error; }
    assert.equal(path.dirname(path.resolve(dir)), parent); assert.ok(path.basename(dir).startsWith('konx-copilot-test-'));
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
async function create(service) { return service.create({ name: 'Owned synthetic troubleshooting' }); }
function prepare(service, value, options = {}) { return service.prepare({ conversationId: value.id, revision: value.revision, question: 'What does this result show?', attachmentIds: [], historyTurnIds: [], includeKnowledge: false, stream: false, ...options }); }
async function send(service, preview, signal = {}) { const events = []; const report = await service.run({ preparationId: preview.preparationId, digest: preview.digest }, (type, data) => events.push({ type, data }), signal); return { report, events }; }
function pendingTurn(body = '{}') {
  return { id: crypto.randomUUID(), status: 'pending', createdAt: now(), completedAt: null, question: 'Synthetic question', attachmentIds: [], historyTurnIds: [],
    request: { digest: 'a'.repeat(64), provider: 'openai', model: 'synthetic', providerRevision: 'synthetic-revision', body, endpoint: 'https://example.test/v1', references: [], evidence: [] },
    answer: '', usage: emptyUsage(), limitations: [], error: '' };
}

async function runCopilotTests(test) {
  await test('Copilot sends exactly the reviewed redacted body after a durable pending turn, preserving immutable references', async () => fixture(async ({ service, store, calls, refs, searches, setHandler, dir }) => {
    let value = await create(service);
    value = await service.attach(value.id, value.revision, snapshot({ facts: { rows: [{ note: KEY, password: 'SyntheticPasswordThatMustBeRedacted' }] } }));
    const preview = await prepare(service, value, { question: `Explain ${KEY}`, attachmentIds: [value.attachments[0].id], includeKnowledge: true });
    assert.equal(calls.length, 0); assert.equal(searches.length, 1); assert.ok(!preview.body.includes(KEY));
    const original = preview.body; refs[0].content = 'Changed after review and must not be sent';
    setHandler((_req, res, call) => {
      const record = JSON.parse(fs.readFileSync(store.file(value.id), 'utf8')); assert.equal(record.turns[0].status, 'pending'); assert.equal(record.turns[0].request.body, original);
      assert.equal(call.raw, original); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response('Evidence explained. [K1]')));
    });
    preview.body = 'Renderer edits cannot replace the reviewed main-owned request';
    const { report } = await send(service, preview);
    assert.equal(report.turn.status, 'complete'); assert.equal(report.turn.request.body, original); assert.equal(report.turn.request.references[0].excerpt, 'Original local reference excerpt.');
    assert.equal(searches.length, 1); assert.equal(calls.length, 1); assert.equal(service.hasOwnership, false);
    const file = fs.readFileSync(store.file(value.id), 'utf8'); assert.ok(!file.includes(KEY)); assert.ok(!file.includes('SyntheticPasswordThatMustBeRedacted'));
    assert.ok(fs.existsSync(path.join(dir, 'ai.json')));
  }));

  await test('Copilot follow-ups include selected complete questions, answers and citations without recursive request bodies', async () => fixture(async ({ service }) => {
    let value = await create(service); const first = await send(service, await prepare(service, value, { includeKnowledge: true })); value = await service.get(value.id);
    const preview = await prepare(service, value, { historyTurnIds: [first.report.turn.id], question: 'Why is that uncertain?' });
    const envelope = JSON.parse(JSON.parse(preview.body).input[0].content[0].text);
    assert.equal(envelope.conversation.length, 1); assert.equal(envelope.conversation[0].answer, first.report.turn.answer); assert.equal(envelope.conversation[0].citations[0].citation, 'K1'); assert.ok(!Object.hasOwn(envelope.conversation[0], 'request'));
    await send(service, preview); value = await service.get(value.id); assert.equal(value.turns.length, 2);
    const noHistory = await prepare(service, value); assert.equal(JSON.parse(JSON.parse(noHistory.body).input[0].content[0].text).conversation.length, 0);
  }));

  await test('Copilot rejects stale, expired, replayed and changed-provider preparations without another POST', async () => {
    let clock = Date.now(); await fixture(async ({ service, ai, calls }) => {
      let value = await create(service), preview = await prepare(service, value); value = await service.rename(value.id, value.revision, 'Renamed');
      await assert.rejects(send(service, preview), /changed/); assert.equal(calls.length, 0);
      preview = await prepare(service, value); ai.configure({ model: ai.getConfig().model }); await assert.rejects(send(service, preview), /settings changed/);
      preview = await prepare(service, value); clock += LIMITS.preparationMs + 1; await assert.rejects(send(service, preview), /expired/);
      preview = await prepare(service, value); await send(service, preview); await assert.rejects(send(service, preview), /already used/); assert.equal(calls.length, 1);
    }, { now: () => clock });
  });

  await test('Copilot concurrent conversation writes cannot silently replace another revision', async () => fixture(async ({ service }) => {
    const value = await create(service), result = await Promise.allSettled([service.rename(value.id, value.revision, 'First'), service.rename(value.id, value.revision, 'Second')]);
    assert.equal(result.filter(v => v.status === 'fulfilled').length, 1); assert.equal(result.filter(v => v.status === 'rejected')[0].reason.code, 'COPILOT_CONFLICT');
  }));

  await test('Copilot refuses to POST when the pending turn cannot be saved', async () => {
    let failOpen = false; const io = Object.create(fsp); io.open = async (...args) => { if (failOpen && args[1] === 'wx') throw Object.assign(new Error('Owned synthetic disk failure'), { code: 'EACCES' }); return fsp.open(...args); };
    await fixture(async ({ service, calls }) => { const value = await create(service), preview = await prepare(service, value); failOpen = true;
      await assert.rejects(send(service, preview)); assert.equal(calls.length, 0); failOpen = false; assert.equal((await service.get(value.id)).turns.length, 0); }, { io });
  });

  await test('Copilot retains a failed final save for cleanup retry without billing a second request', async () => {
    let failRename = false; const io = Object.create(fsp); io.rename = async (...args) => { if (failRename) throw Object.assign(new Error('Owned synthetic disk failure'), { code: 'EACCES' }); return fsp.rename(...args); };
    await fixture(async ({ service, calls, setHandler }) => {
      const value = await create(service), preview = await prepare(service, value);
      setHandler((_req, res) => { failRename = true; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response('Preserved answer'))); });
      await assert.rejects(send(service, preview), /outcome could not be saved/); assert.equal(service.hasOwnership, true); assert.equal(service.hasPendingCleanup, true); assert.equal((await service.get(value.id)).turns[0].status, 'pending');
      failRename = false; await service.close(); assert.equal(service.hasOwnership, false); assert.equal(calls.length, 1); assert.equal((await service.get(value.id)).turns[0].answer, 'Preserved answer');
    }, { io });
  });

  await test('Windows atomic conversation replacement retries transient sharing errors but rejects changed ownership', async () => {
    if (process.platform !== 'win32') return;
    let failures = 2, attempts = 0; const io = Object.create(fsp);
    io.rename = async (...args) => { attempts++; if (failures-- > 0) throw Object.assign(new Error('Owned transient sharing failure'), { code: 'EPERM' }); return fsp.rename(...args); };
    await fixture(async ({ service, calls }) => { const value = await create(service); await send(service, await prepare(service, value)); assert.ok(attempts >= 4); assert.equal(calls.length, 1); assert.equal(service.hasOwnership, false); }, { io });
    for (const replace of ['target', 'temporary']) {
      let changed = false, foreign = null; const replacedIO = Object.create(fsp);
      replacedIO.rename = async (source, target) => {
        if (!changed) {
          changed = true; foreign = replace === 'target' ? target : source;
          await fsp.rename(foreign, foreign + '.fixture-original'); await fsp.writeFile(foreign, 'foreign fixture content');
          throw Object.assign(new Error('Owned replacement race fixture'), { code: 'EPERM' });
        }
        return fsp.rename(source, target);
      };
      await fixture(async ({ service }) => {
        const value = await create(service); await assert.rejects(service.rename(value.id, value.revision, 'Must not overwrite foreign file'), /changed during atomic replacement/);
        assert.equal(await fsp.readFile(foreign, 'utf8'), 'foreign fixture content');
        if (replace === 'temporary') { assert.equal(service.hasPendingCleanup, true); await assert.rejects(service.close(), /cleanup/); }
        await fsp.unlink(foreign); await fsp.rename(foreign + '.fixture-original', foreign); await service.close();
      }, { io: replacedIO });
    }
  });

  await test('Copilot restart marks pending requests interrupted and never resends them', async () => fixture(async ({ service, store, dir, calls }) => {
    const value = await create(service), pending = pendingTurn(); await store.beginTurn(value.id, value.revision, pending);
    const restarted = new CopilotStore(dir), recovered = await restarted.get(value.id);
    assert.equal(recovered.turns[0].status, 'interrupted'); assert.match(recovered.turns[0].error, /not sent again/); assert.equal(calls.length, 0); await restarted.close();
  }, { allowRetained: true }));

  await test('Copilot capacity reservation rejects an answer that could overflow after a billed request', async () => fixture(async ({ service, store, calls }) => {
    let value = await create(service);
    for (let i = 0; i < 15; i++) { const turn = pendingTurn('x'.repeat(250000)); turn.status = 'complete'; turn.completedAt = now(); value.turns.push(turn); }
    validateRecord(value); fs.writeFileSync(store.file(value.id), JSON.stringify(value));
    const preview = await prepare(service, value); await assert.rejects(send(service, preview), /capacity/); assert.equal(calls.length, 0); assert.equal((await service.get(value.id)).turns.length, 15);
  }));

  await test('Copilot typed evidence rejects unsupported, oversized and malformed facts without partial attachment', async () => fixture(async ({ service }) => {
    const value = await create(service);
    assert.throws(() => normalizeSnapshot(snapshot({ kind: 'terminal', command: 'must not execute' })), /unsupported/);
    assert.throws(() => normalizeSnapshot(snapshot({ facts: { text: 'x'.repeat(LIMITS.snapshotBytes) } })), /byte limit/);
    assert.throws(() => normalizeSnapshot(snapshot({ coverage: { observed: 2, total: 1, complete: true } })), /coverage/);
    assert.throws(() => service.attach(value.id, value.revision, snapshot({ facts: { invalid: Infinity } })), /finite/);
    assert.equal((await service.get(value.id)).attachments.length, 0);
  }));

  await test('Typed redaction handles known keys in JSON names and credential fields of every JSON type', async () => fixture(async ({ service, store }) => {
    const value = await create(service), attached = await service.attach(value.id, value.revision, snapshot({ facts: { [KEY]: 'synthetic field name', password: 123456789, token: { private: 'object-credential-sentinel' }, nested: [{ secret: ['array-credential-sentinel'] }], count: 17 } }));
    const saved = fs.readFileSync(store.file(value.id), 'utf8'); assert.ok(!saved.includes(KEY)); assert.ok(!saved.includes('123456789')); assert.ok(!saved.includes('object-credential-sentinel')); assert.ok(!saved.includes('array-credential-sentinel')); assert.equal(attached.attachments[0].snapshot.facts.count, 17);
    const preview = await prepare(service, attached, { attachmentIds: [attached.attachments[0].id] }); assert.ok(!preview.body.includes(KEY));
  }));

  await test('Copilot close waits for cancelled preparation and native request finalization, discarding unused previews', async () => fixture(async ({ service, ai, calls, setHandler }) => {
    const value = await create(service); let started;
    const began = new Promise(resolve => { started = resolve; }); ai.knowledge.search = () => { started(); return new Promise(() => {}); };
    const preparing = prepare(service, value, { includeKnowledge: true }); const rejected = assert.rejects(preparing, /cancelled/); await began; await service.close(); await rejected;
    assert.equal(service.hasOwnership, false); assert.equal(service.preparations.size, 0); assert.equal(calls.length, 0);
    let arrived; const waiting = new Promise(resolve => { arrived = resolve; });
    setHandler((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame({ type: 'response.output_text.delta', delta: 'Pending' })); arrived(); });
    const preview = await prepare(service, value, { stream: true }), events = [];
    const task = service.run({ preparationId: preview.preparationId, digest: preview.digest }, (type, data) => events.push({ type, data }), {}); const stopped = assert.rejects(task, /cancelled/);
    await waiting; await service.close(); await stopped; assert.equal(service.hasOwnership, false); assert.equal((await service.get(value.id)).turns[0].status, 'cancelled');
    const unused = await prepare(service, await service.get(value.id)); await service.close(); await assert.rejects(send(service, unused), /already used/);
  }));

  await test('Copilot storage rejects a real junction and retains failed owned temporary cleanup for retry', async () => {
    await fixture(async ({ dir }) => {
      const target = path.join(dir, 'owned-other-directory'); fs.mkdirSync(target); const profile = path.join(dir, 'junction-profile'); fs.mkdirSync(profile);
      fs.symlinkSync(target, path.join(profile, 'copilot-conversations'), 'junction'); const store = new CopilotStore(profile);
      await assert.rejects(store.create({ name: 'Must not write through a junction' }), /real directory/); assert.deepEqual(fs.readdirSync(target), []);
    });
    let failUnlink = true; const io = Object.create(fsp); io.unlink = async (...args) => { if (failUnlink && path.basename(args[0]).startsWith('.copilot-')) throw Object.assign(new Error('Owned cleanup failure'), { code: 'EACCES' }); return fsp.unlink(...args); };
    await fixture(async ({ service }) => { await create(service); assert.equal(service.hasPendingCleanup, true); await assert.rejects(service.close(), /cleanup/); failUnlink = false; await service.close(); assert.equal(service.hasOwnership, false); }, { io });
  });

  await test('OpenAI SSE handles byte-fragmented UTF-8 and split secrets without exposing raw deltas', async () => fixture(async ({ service, setHandler, ai }) => {
    ai.configure({ provider: 'custom', model: 'fixture', baseUrl: 'https://example.test/v1', key: secondKey }); ai.configure({ provider: 'openai' });
    let release, received; const waiting = new Promise(resolve => { received = resolve; }), proceed = new Promise(resolve => { release = resolve; });
    setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame({ type: 'response.output_text.delta', delta: KEY.slice(0, 10) })); received(); await proceed;
      const payload = frame({ type: 'response.output_text.delta', delta: KEY.slice(10) }) + frame({ type: 'response.completed', response: response(`é packet ${KEY} ${secondKey}\npassword: SyntheticHiddenPassword`) });
      const bytes = Buffer.from(payload); for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await tick(); } res.end();
    });
    const value = await create(service), preview = await prepare(service, value, { stream: true }), events = [];
    const job = service.run({ preparationId: preview.preparationId, digest: preview.digest }, (type, data) => events.push({ type, data }), {});
    await waiting; assert.equal(events.filter(e => e.type === 'delta').length, 0); release(); const report = await job;
    assert.ok(report.turn.answer.startsWith('é packet')); assert.ok(!JSON.stringify(events).includes(KEY)); assert.ok(!JSON.stringify(events).includes(secondKey)); assert.ok(!JSON.stringify(events).includes('SyntheticHiddenPassword')); assert.equal(report.turn.usage.totalTokens, 13);
  }));

  await test('Compatible SSE preserves content, final usage and explicit truncated-answer limitations', async () => fixture(async ({ service, ai, setHandler, calls }) => {
    ai.configure({ provider: 'custom', model: 'fixture/model', baseUrl: 'https://example.test/v1', key: KEY });
    setHandler((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(
      frame({ model: 'fixture/model', choices: [{ index: 0, delta: { role: 'assistant', content: 'A partial ' }, finish_reason: null }] }) +
      frame({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'length' }] }) +
      frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + frame('[DONE]')); });
    const value = await create(service), { report } = await send(service, await prepare(service, value, { stream: true }));
    assert.equal(report.turn.answer, 'A partial answer'); assert.equal(report.turn.usage.inputTokens, 10); assert.ok(report.turn.limitations.some(v => /incomplete/.test(v))); assert.equal(calls[0].body.stream_options.include_usage, true);
  }));

  await test('Cancelling an unfinished native SSE request closes transport and saves a cancelled turn with no raw output', async () => fixture(async ({ service, setHandler, sockets }) => {
    let arrived; const waiting = new Promise(resolve => { arrived = resolve; });
    setHandler((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame({ type: 'response.output_text.delta', delta: KEY })); arrived(); });
    const value = await create(service), preview = await prepare(service, value, { stream: true }), signal = {}, events = [];
    const task = service.run({ preparationId: preview.preparationId, digest: preview.digest }, (type, data) => events.push({ type, data }), signal);
    await waiting; stop(signal); await assert.rejects(task, /cancelled/);
    for (let i = 0; i < 20 && sockets.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sockets.size, 0); assert.equal(events.some(v => v.type === 'delta'), false); assert.equal((await service.get(value.id)).turns[0].status, 'cancelled'); assert.equal(service.hasOwnership, false);
  }));

  await test('Streaming rejects malformed frames, missing terminals, oversized events and errors without saving partial text', async () => {
    const cases = [frame('{broken'), frame({ type: 'response.output_text.delta', delta: 'unfinished' }), frame({ type: 'error', message: KEY }), 'data: ' + 'x'.repeat(513 * 1024)];
    for (const payload of cases) await fixture(async ({ service, setHandler }) => {
      setHandler((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload); });
      const value = await create(service), preview = await prepare(service, value, { stream: true }); await assert.rejects(send(service, preview), /event stream/);
      const saved = await service.get(value.id); assert.equal(saved.turns[0].status, 'failed'); assert.equal(saved.turns[0].answer, ''); assert.ok(!JSON.stringify(saved).includes(KEY));
    });
  });

  await test('Explicit provider test contains no history, evidence or library and records only the actual returned usage', async () => fixture(async ({ service, ai, searches, calls }) => {
    const value = await create(service); await service.attach(value.id, value.revision, snapshot({ facts: { private: 'Do not include this unselected evidence' } }));
    const preview = await service.prepareTest({ providerRevision: ai.getConfig().revision, stream: false }); assert.equal(calls.length, 0);
    const envelope = JSON.parse(JSON.parse(preview.body).input[0].content[0].text); assert.equal(envelope.question, 'Reply with OK.'); assert.deepEqual(envelope.conversation, []); assert.deepEqual(envelope.evidence, []); assert.deepEqual(envelope.references, []);
    const { report } = await send(service, preview); assert.equal(report.providerTest.ok, true); assert.equal(searches.length, 0); assert.equal(service.status().lastTest.usage.totalTokens, 13);
    assert.equal((await service.get(value.id)).turns.length, 0);
  }));

  await test('Buffered Anthropic and Gemini requests expose honest capabilities and unknown usage as null', async () => {
    for (const provider of ['anthropic', 'gemini']) await fixture(async ({ service, ai, setHandler }) => {
      ai.configure({ provider, key: KEY }); assert.equal(service.status().capabilities.streaming, false);
      setHandler((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(provider === 'anthropic' ? { content: [{ type: 'text', text: 'Known facts only.' }], stop_reason: 'end_turn' } : { candidates: [{ content: { parts: [{ text: 'Known facts only.' }] }, finishReason: 'STOP' }] })); });
      const value = await create(service), preview = await prepare(service, value, { stream: true }); assert.equal(preview.mode, 'buffered'); const { report } = await send(service, preview); assert.equal(report.turn.usage.totalTokens, null);
    });
  });

  await test('Copilot real IPC rejects shutdown mutations, guards provider testing and supports revision-safe CRUD', async () => fixture(async ({ service, ai, calls }) => {
    const handlers = new Map(); let closing = false; registerCopilot((name, handler) => handlers.set(name, handler), { copilot: service, isClosing: () => closing });
    const invoke = (name, ...args) => handlers.get('tools:copilot' + name)(...args);
    const value = await invoke('Create', { name: 'IPC fixture' }); assert.equal((await invoke('List')).conversations.length, 1);
    const renamed = await invoke('Rename', value.id, value.revision, 'Renamed IPC fixture'); await assert.rejects(invoke('Remove', value.id, value.revision), /changed/);
    closing = true; await assert.rejects(invoke('Create', { name: 'Blocked' }), /closing/); await assert.rejects(invoke('PrepareTest', { providerRevision: ai.getConfig().revision }), /closing/); assert.equal(calls.length, 0);
    closing = false; assert.deepEqual(await invoke('Remove', value.id, renamed.revision), { removed: value.id });
  }));

  await test('Copilot IPC reports a committed save honestly when shutdown begins during the write', async () => {
    let duringLink = () => {}, closing = false; const io = Object.create(fsp); io.link = async (...args) => { const value = await fsp.link(...args); duringLink(); return value; };
    await fixture(async ({ service }) => {
      const handlers = new Map(); registerCopilot((name, handler) => handlers.set(name, handler), { copilot: service, isClosing: () => closing });
      duringLink = () => { closing = true; }; const saved = await handlers.get('tools:copilotCreate')({ name: 'Committed before shutdown' }); assert.equal(saved.revision, 1);
      closing = false; assert.equal((await service.list()).conversations.length, 1);
    }, { io });
  });
}

module.exports = { runCopilotTests };
if (require.main === module) { let passed = 0; runCopilotTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); }).then(() => console.log(`${passed} Copilot tests passed`)).catch(error => { console.error(error); process.exitCode = 1; }); }
