'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CopilotStore, LIMITS, emptyUsage } = require('../src/main/copilot-store');
const { CopilotActions } = require('../src/main/copilot-actions');
const { ACTION_LIMITS, normalizeParams, parseActionCandidates, digest } = require('../src/main/copilot-action-schema');
const { createActionDiagnostics } = require('../src/main/copilot-action-diagnostics');
const { registerCopilotActions } = require('../src/main/copilot-actions-ipc');
const repo = path.resolve(__dirname, '..');
const stop = signal => { signal.stopped = true; signal.onStop?.(); };
const tick = () => new Promise(resolve => setImmediate(resolve));
function pending() { return { id: crypto.randomUUID(), status: 'pending', createdAt: new Date().toISOString(), completedAt: null,
  question: 'Explain this owned fixture', attachmentIds: [], historyTurnIds: [], request: { digest: 'a'.repeat(64), provider: 'openai', model: 'synthetic', providerRevision: 'fixture', body: '{}', endpoint: 'https://example.test/v1', references: [], evidence: [] }, answer: '', usage: emptyUsage(), limitations: [], error: '' }; }
async function seed(store, answer = 'This is a synthetic answer. Check its evidence.') {
  const value = await store.create({ name: 'Owned action fixture' }), turn = pending(); await store.beginTurn(value.id, value.revision, turn);
  return store.finishTurn(value.id, turn.id, { status: 'complete', answer, usage: emptyUsage(), limitations: [], error: '' });
}
const source = value => ({ conversationId: value.id, revision: value.revision, turnId: value.turns[0].id });
const editorTarget = () => ({ tabId: 'owned-notepad', documentId: 'owned-document', modelId: crypto.randomUUID(), versionId: 5, selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 }, beforeText: 'before', beforeDigest: digest('before'), readOnly: false, savePending: false, textFormat: 'lf' });
const review = (actions, value, extra = {}) => actions.prepare({ ...source(value), kind: 'diagnostic.ping', params: { host: '127.0.0.1', count: 1 }, ...extra });
const run = (actions, preview, signal = {}, emit = () => {}) => actions.run({ preparationId: preview.preparationId, digest: preview.digest }, emit, signal);
async function fixture(fn, options = {}) {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'konx-reviewed-actions-'));
  const store = new CopilotStore(dir, { fs: options.io || fsp }), calls = [], notes = [];
  const defaultRunner = async (params, emit) => { calls.push(params); const disk = JSON.parse(fs.readFileSync(store.file(value.id), 'utf8')); assert.equal(disk.actions.at(-1).status, 'pending'); emit('reply', { ip: params.host, ok: true, ms: 1 }); };
  const actions = new CopilotActions({ store, knowledge: options.knowledge || { prepareArticle: async article => ({ ...article, title: article.title.trim(), content: article.content.trim() }), save: async article => { notes.push(article); return { id: 'custom:' + crypto.randomUUID(), ...article }; } },
    diagnostics: options.diagnostics || { ping: defaultRunner, dns: defaultRunner, traceroute: defaultRunner }, requestEditor: options.requestEditor || (() => false), now: options.now, editorTimeoutMs: options.editorTimeoutMs || 30 });
  let value;
  try { value = await seed(store, options.answer); return await fn({ dir, store, actions, value, calls, notes }); }
  finally {
    options.restore?.(); await actions.close(); await store.close();
    assert.equal(path.dirname(path.resolve(dir)), parent); assert.ok(path.basename(dir).startsWith('konx-reviewed-actions-'));
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runCopilotActionsTests(test) {
  await test('AI action suggestions are present only in contextual Copilot preparation, never standalone or minimal provider tests', async () => fixture(async ({ dir }) => {
    const { AIClient } = require('../src/main/ai'), ai = new AIClient({ dir, crypt: { available: () => true, encrypt: value => 'owned:' + value, decrypt: value => value.slice(6) }, knowledge: { search: async () => [] } });
    ai.configure({ key: 'Synthetic_Reviewed_Action_Key_1234567890' }); const revision = ai.getConfig().revision;
    const normal = await ai.prepareConversation({ revision, question: 'What diagnostic would help?', includeKnowledge: false, stream: false });
    assert.match(JSON.parse(normal.body).instructions, /konx-action/); assert.match(JSON.parse(normal.body).instructions, /untrusted proposals/);
    const providerTest = await ai.prepareConversation({ revision, question: 'Reply OK', test: true, stream: false }); assert.ok(!JSON.parse(providerTest.body).instructions.includes('konx-action'));
    let standalone;
    ai._request = async spec => { standalone = spec.body; return { data: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic explanation' }] }] } }; };
    await ai.run({ revision, question: 'Standalone explanation' }, () => {}); assert.ok(!standalone.instructions.includes('konx-action'));
  }));
  await test('Reviewed actions admit only a bounded typed catalog; untrusted suggestions never start work', async () => {
    const answer = '```konx-action\n{"kind":"diagnostic.ping","params":{"host":"127.0.0.1","count":2}}\n```\n```konx-action\n{"kind":"terminal.command","params":{"command":"anything"}}\n```\n```konx-action\n{"kind":"diagnostic.dns","params":{"name":"example.test"},"execute":true}\n```';
    const parsed = parseActionCandidates(answer); assert.equal(parsed.candidates.length, 1); assert.equal(parsed.issues.length, 2);
    for (const host of ['-n', 'a & b', 'https://example.test', '127.0.0.1:22', '10.0.0.0/24', '999.0.0.1', 'x\ny']) assert.throws(() => normalizeParams('diagnostic.ping', { host }));
    assert.throws(() => normalizeParams('diagnostic.ping', { host: '127.0.0.1', count: 11 }));
    assert.throws(() => normalizeParams('diagnostic.dns', { name: 'example.test', type: 'ALL' }));
    assert.throws(() => normalizeParams('diagnostic.dns', { name: '127.0.0.1', type: 'A' }));
    assert.equal(normalizeParams('diagnostic.dns', { name: '_sip._tcp.example.test', type: 'SRV' }).name, '_sip._tcp.example.test');
    await fixture(async ({ actions, value, calls }) => { assert.equal((await actions.candidates(source(value))).candidates.length, 1); await review(actions, value); assert.equal(calls.length, 0); }, { answer });
  });
  await test('Reviewed diagnostic persists pending before execution and retains an immutable result, source and exact parameters', async () => fixture(async ({ actions, store, value, calls }) => {
    value.turns[0].request.references = [{ id: 'owned-reference', citation: 'K1', excerpt: 'Original reviewed source.' }]; fs.writeFileSync(store.file(value.id), JSON.stringify(value));
    const preview = await review(actions, value); preview.params.host = '198.51.100.1'; preview.preview.params.count = 100;
    value.turns[0].request.references[0].excerpt = 'Later caller edit';
    const report = await run(actions, preview); assert.equal(calls.length, 1); assert.equal(calls[0].host, '127.0.0.1'); assert.equal(calls[0].count, 1);
    assert.equal(report.action.status, 'succeeded'); assert.equal(report.action.result.observations[0].data.ip, '127.0.0.1'); assert.equal(report.action.source.turnId, value.turns[0].id);
    assert.equal(report.action.source.citations[0].excerpt, 'Original reviewed source.');
    assert.equal(actions.hasOwnership, false); assert.equal(store.hasOwnership, false); assert.deepEqual((await store.get(value.id)).actions[0], report.action);
    await assert.rejects(run(actions, preview), /already used/); assert.equal(calls.length, 1);
  }));
  await test('Stale revision, source mutation, changed digest, expiry and cancelled admission cause no effect', async () => {
    let clock = Date.now(); await fixture(async ({ actions, store, value, calls }) => {
      let preview = await review(actions, value); value = await store.rename(value.id, value.revision, 'New name'); await assert.rejects(run(actions, preview), /changed/);
      preview = await review(actions, value); const disk = JSON.parse(fs.readFileSync(store.file(value.id))); disk.turns[0].answer = 'Changed owned fixture answer'; fs.writeFileSync(store.file(value.id), JSON.stringify(disk));
      await assert.rejects(run(actions, preview), /source answer changed/i); value = await store.get(value.id);
      preview = await review(actions, value); await assert.rejects(run(actions, { ...preview, digest: 'b'.repeat(64) }), /changed/);
      preview = await review(actions, value); clock += ACTION_LIMITS.preparationMs + 1; await assert.rejects(run(actions, preview), /expired/);
      preview = await review(actions, value); await assert.rejects(run(actions, preview, { stopped: true }), /cancelled/);
      assert.equal(calls.length, 0); assert.equal((await store.get(value.id)).actions.length, 0);
      for (let i = 0; i < ACTION_LIMITS.preparations; i++) await review(actions, value);
      await assert.rejects(review(actions, value), /unused action/); clock += ACTION_LIMITS.preparationMs + 1; assert.ok((await review(actions, value)).digest);
    }, { now: () => clock });
  });
  await test('Admission storage failure or reserved completion capacity prevents every side effect', async () => {
    let denied = false; const io = Object.create(fsp); io.open = async (...args) => { if (denied && args[1] === 'wx') throw Object.assign(new Error('Owned fixture denies write'), { code: 'EACCES' }); return fsp.open(...args); };
    await fixture(async ({ actions, store, value, calls }) => {
      const preview = await review(actions, value); denied = true; await assert.rejects(run(actions, preview), /write|EACCES|denies/); denied = false; assert.equal(calls.length, 0); assert.equal((await store.get(value.id)).actions.length, 0);
      const savedCapacity = store.capacity.bind(store); let reserve;
      store.capacity = async (id, bytes, requested) => { reserve = requested; throw new Error('Owned capacity full'); };
      try { await assert.rejects(run(actions, await review(actions, value)), /capacity/); assert.equal(reserve, ACTION_LIMITS.outcomeReserve); assert.equal(calls.length, 0); } finally { store.capacity = savedCapacity; }
    }, { io, restore: () => { denied = false; } });
  });
  await test('Partial diagnostic cancellation waits for its owner and preserves observations without a health verdict', async () => {
    let started, closeAcknowledged = false; const ready = new Promise(resolve => { started = resolve; });
    await fixture(async ({ actions, store, value }) => {
      const signal = {}, task = run(actions, await review(actions, value), signal); await ready; assert.equal(actions.hasOwnership, true);
      stop(signal); assert.equal(closeAcknowledged, false); const report = await task;
      assert.equal(closeAcknowledged, true); assert.equal(report.action.status, 'cancelled'); assert.equal(report.action.result.observations.length, 1); assert.equal(report.action.result.coverage.complete, false); assert.match(report.action.result.limitations.join(' '), /unknown/);
      assert.equal((await store.get(value.id)).actions.length, 1);
    }, { diagnostics: { ping: async (_params, emit, signal) => { emit('reply', { ok: true }); started(); await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(() => { closeAcknowledged = true; resolve(); }, 10), { once: true })); } } });
  });
  await test('Oversized diagnostic observations are omitted whole with explicit incomplete coverage', async () => fixture(async ({ actions, value }) => {
    const report = await run(actions, await review(actions, value)); assert.equal(report.action.status, 'succeeded'); assert.equal(report.action.result.coverage.complete, false);
    assert.equal(report.action.result.coverage.observed, 302); assert.equal(report.action.result.observations.length, 256); assert.ok(!JSON.stringify(report).includes('PRIVATE_LARGE_SENTINEL'));
  }, { diagnostics: { ping: async (_params, emit) => { emit('huge', { text: 'PRIVATE_LARGE_SENTINEL' + 'x'.repeat(16001) }); emit('bad', new Date()); for (let i = 0; i < 300; i++) emit('reply', { seq: i }); } } }));
  await test('Final outcome save failure retains ownership and cleanup retries persistence without repeating the action', async () => fixture(async ({ actions, store, value, calls }) => {
    const original = store.finishAction.bind(store); let denied = true; store.finishAction = (...args) => denied ? Promise.reject(new Error('Owned final save failure')) : original(...args);
    await assert.rejects(run(actions, await review(actions, value)), error => error.code === 'COPILOT_ACTION_CLEANUP');
    assert.equal(calls.length, 1); assert.equal(actions.hasPendingCleanup, true); assert.equal(store.hasOwnership, true); await assert.rejects(actions.close(), /could not be saved/);
    denied = false; await actions.close(); assert.equal(calls.length, 1); assert.equal(actions.hasOwnership, false); assert.equal(store.hasOwnership, false); assert.equal((await store.get(value.id)).actions[0].status, 'succeeded');
  }));
  await test('A progress delivery failure cannot orphan a durably admitted action or dispatch work', async () => fixture(async ({ actions, value, calls, store }) => {
    const report = await run(actions, await review(actions, value), {}, type => { if (type === 'progress') throw new Error('Owned consumer closed'); });
    assert.equal(report.action.status, 'failed'); assert.equal(calls.length, 0); assert.equal(store.hasOwnership, false); assert.equal(actions.hasOwnership, false);
  }));
  await test('Shutdown during durable admission waits for the actual write then records cancellation without dispatch', async () => {
    let reached, release; const waiting = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; }), io = Object.create(fsp);
    io.rename = async (from, to) => { const value = JSON.parse(await fsp.readFile(from, 'utf8')); if (value.actions?.at(-1)?.status === 'pending') { reached(); await gate; } return fsp.rename(from, to); };
    await fixture(async ({ actions, value, store, calls }) => {
      const task = run(actions, await review(actions, value)); await waiting;
      let closed = false; const closing = actions.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false); assert.equal(actions.hasOwnership, true);
      release(); const report = await task; await closing; assert.equal(report.action.status, 'cancelled'); assert.equal(calls.length, 0); assert.equal(actions.hasOwnership, false); assert.equal(store.hasOwnership, false);
      assert.equal((await store.get(value.id)).actions[0].status, 'cancelled');
    }, { io, restore: () => release() });
  });
  await test('Editor review enforces permission and ack correlation; saved provenance excludes original and replacement plaintext', async () => {
    let request, dispatch; const ready = new Promise(resolve => { dispatch = resolve; });
    await fixture(async ({ actions, store, value }) => {
      const target = editorTarget(); await assert.rejects(review(actions, value, { kind: 'editor.replaceSelection', params: { replacement: 'after' }, target: { ...target, readOnly: true } }), /read-only/);
      const preview = await review(actions, value, { kind: 'editor.replaceSelection', params: { replacement: 'AFTER_PRIVATE_SENTINEL' }, target: { ...target, beforeText: 'BEFORE_PRIVATE_SENTINEL', beforeDigest: digest('BEFORE_PRIVATE_SENTINEL') } });
      const task = run(actions, preview); await ready;
      assert.equal(actions.acknowledgeEditor({ operationId: request.operationId, nonce: crypto.randomUUID(), status: 'applied', afterVersion: 6, afterDigest: digest(request.replacement) }).accepted, false);
      assert.equal(actions.acknowledgeEditor({ operationId: request.operationId, nonce: request.nonce, status: 'applied', afterVersion: 6, afterDigest: digest(request.replacement) }).accepted, true);
      const report = await task; assert.equal(report.action.status, 'succeeded'); assert.equal(report.action.result.provenance, 'renderer-reported'); assert.equal(report.action.result.saved, false); assert.equal(report.action.result.uploaded, false);
      assert.equal(actions.acknowledgeEditor({ operationId: request.operationId, nonce: request.nonce, status: 'rejected' }).accepted, false);
      const disk = fs.readFileSync(store.file(value.id), 'utf8'); assert.ok(!disk.includes('BEFORE_PRIVATE_SENTINEL')); assert.ok(!disk.includes('AFTER_PRIVATE_SENTINEL'));
    }, { requestEditor: value => { request = value; dispatch(); return true; }, editorTimeoutMs: 1000 });
  });
  await test('Lost editor acknowledgments, cancellation and dispatch rejection preserve unknown effects without replay', async () => {
    let dispatches = 0, request;
    await fixture(async ({ actions, value, store }) => {
      const preview = await review(actions, value, { kind: 'editor.replaceSelection', params: { replacement: 'after' }, target: editorTarget() });
      const report = await run(actions, preview); assert.equal(report.action.status, 'unknown'); assert.equal(dispatches, 1); await assert.rejects(run(actions, preview), /already used/);
      value = await store.get(value.id); const signal = {}, task = run(actions, await review(actions, value, { kind: 'editor.replaceSelection', params: { replacement: 'after' }, target: editorTarget() }), signal);
      while (dispatches < 2) await tick(); stop(signal); assert.equal((await task).action.status, 'unknown'); assert.equal(actions.acknowledgeEditor({ operationId: request.operationId, nonce: request.nonce, status: 'rejected' }).accepted, false);
    }, { requestEditor: value => { dispatches++; request = value; return true; } });
    await fixture(async ({ actions, value }) => { const report = await run(actions, await review(actions, value, { kind: 'editor.replaceSelection', params: { replacement: 'after' }, target: editorTarget() })); assert.equal(report.action.status, 'failed'); });
    await fixture(async ({ actions, value }) => { const report = await run(actions, await review(actions, value, { kind: 'editor.replaceSelection', params: { replacement: 'after' }, target: editorTarget() })); assert.equal(report.action.status, 'unknown'); }, { requestEditor: () => Promise.reject(new Error('Owned bridge failure')) });
  });
  await test('Reviewed answer note is a new exact local article with provenance; ambiguous save is not repeated', async () => fixture(async ({ actions, value, notes, store }) => {
    const preview = await review(actions, value, { kind: 'note.saveAnswer', params: { title: 'Fixture note', start: 0, end: 9 } }); assert.equal(notes.length, 0); const exact = preview.preview.article.content;
    const report = await run(actions, preview); assert.equal(notes.length, 1); assert.equal(notes[0].content, exact); assert.ok(!Object.hasOwn(notes[0], 'id')); assert.match(exact, new RegExp(value.turns[0].id)); assert.equal(report.action.status, 'succeeded');
    value = await store.get(value.id); actions.knowledge.save = async article => { notes.push(article); throw new Error('Committed but ack lost'); };
    const unknown = await run(actions, await review(actions, value, { kind: 'note.saveAnswer', params: { title: 'Uncertain note' } })); assert.equal(unknown.action.status, 'unknown'); await actions.close(); assert.equal(notes.length, 2);
  }));
  await test('Old conversations migrate lazily and an interrupted pending action is unknown after restart without re-execution', async () => fixture(async ({ dir, actions, store, value, calls }) => {
    const disk = JSON.parse(fs.readFileSync(store.file(value.id))); delete disk.actions; fs.writeFileSync(store.file(value.id), JSON.stringify(disk)); value = await store.get(value.id); assert.deepEqual(value.actions, []);
    const report = await run(actions, await review(actions, value)); const record = JSON.parse(fs.readFileSync(store.file(value.id))); record.actions[0].status = 'pending'; record.actions[0].completedAt = null; record.actions[0].result = null; record.actions[0].error = ''; fs.writeFileSync(store.file(value.id), JSON.stringify(record));
    const reopened = new CopilotStore(dir); const recovered = await reopened.get(value.id); assert.equal(recovered.actions[0].status, 'unknown'); assert.match(recovered.actions[0].error, /not repeated/); assert.equal(calls.length, 1); assert.equal(recovered.actions[0].source.turnId, report.action.source.turnId); await reopened.close();
  }));
  await test('Real IPC boundary blocks new reviews during shutdown while accepting disposal and final editor acknowledgments', async () => fixture(async ({ actions, value }) => {
    const handlers = new Map(); let closing = false; registerCopilotActions((name, fn) => handlers.set(name, fn), { actions, isClosing: () => closing });
    const preview = await handlers.get('tools:copilotActionPrepare')({ ...source(value), kind: 'diagnostic.ping', params: { host: '127.0.0.1' } }); closing = true;
    assert.throws(() => handlers.get('tools:copilotActionPrepare')({}), /closing/); assert.throws(() => handlers.get('tools:copilotActionCandidates')(source(value)), /closing/);
    assert.deepEqual(handlers.get('tools:copilotActionDiscard')(preview.preparationId), { discarded: true }); assert.deepEqual(handlers.get('tools:copilotActionEditorAck')({ operationId: crypto.randomUUID(), nonce: crypto.randomUUID(), status: 'rejected' }), { accepted: false });
  }));
  await test('Reviewed runner uses actual finite loopback ping and traceroute; cancellation reaches owned collectors', async () => {
    const real = require(path.join(repo, 'src/main/nettools')), diagnostics = createActionDiagnostics({ nettools: real }); const observed = [];
    await diagnostics.ping({ host: '127.0.0.1', count: 1, interval: 250, timeout: 1000, size: 0 }, (type, data) => observed.push({ type, data }), new AbortController().signal);
    assert.equal(observed.length, 1); assert.equal(observed[0].data.ip, '127.0.0.1'); assert.equal(typeof observed[0].data.ok, 'boolean');
    const hops = []; await diagnostics.traceroute({ host: '127.0.0.1', maxHops: 1, timeout: 250 }, (type, data) => hops.push({ type, data }), new AbortController().signal); assert.ok(hops.length >= 1);
    const controller = new AbortController(), params = []; let ownerClosed = false;
    const wrapped = createActionDiagnostics({ nettools: { traceroute: async (value, _emit, signal) => { params.push(value); await new Promise(resolve => { signal.onStop = () => setTimeout(() => { ownerClosed = true; resolve(); }, 5); }); } } });
    const task = wrapped.traceroute({ host: '127.0.0.1', maxHops: 2, timeout: 250 }, () => {}, controller.signal); await tick(); controller.abort(); await assert.rejects(task, /cancelled/); assert.equal(ownerClosed, true); assert.equal(params[0].resolveNames, false);
  });
  await test('Reviewed DNS runner uses real cancellable resolver against an owned local UDP fixture', async () => {
    const socket = require('node:dgram').createSocket('udp4'), real = require(path.join(repo, 'src/main/nettools')); let queries = 0;
    socket.on('message', (query, remote) => {
      queries++; let end = 12; while (query[end]) end += 1 + query[end]; end += 5;
      const head = Buffer.from(query.subarray(0, 12)); head.writeUInt16BE(0x8180, 2); head.writeUInt16BE(1, 6); head.writeUInt16BE(0, 8); head.writeUInt16BE(0, 10);
      const answer = Buffer.from('c00c000100010000001e00047f000001', 'hex'); socket.send(Buffer.concat([head, query.subarray(12, end), answer]), remote.port, remote.address);
    });
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    try {
      const diagnostics = createActionDiagnostics({ nettools: { dnsLookup: params => { const resolver = new (require('node:dns').promises.Resolver)({ timeout: 1000, tries: 1 }); resolver.setServers(['127.0.0.1:' + socket.address().port]); return real.dnsLookup({ ...params, server: '', resolver }); } } });
      const observations = []; await diagnostics.dns(normalizeParams('diagnostic.dns', { name: 'fixture.example.test' }), (type, data) => observations.push({ type, data }), new AbortController().signal);
      assert.equal(queries, 1); assert.equal(observations.find(item => item.type === 'record').data.value, '127.0.0.1');
    } finally { await new Promise(resolve => socket.close(resolve)); }
  });
}
module.exports = { runCopilotActionsTests };
if (require.main === module) { let passed = 0; runCopilotActionsTests(async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); }).then(() => console.log(`${passed} reviewed-action tests passed`)).catch(error => { console.error(error); process.exitCode = 1; }); }
