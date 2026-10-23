'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { IncidentStore, LIMITS, parseTimestamp, parseSyslog } = require('../src/main/incidents');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const missing = error => error.code === 'ENOENT';
const withStore = fn => async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-incidents-test-'));
  try { await fn(new IncidentStore(directory), directory); }
  finally {
    const resolved = path.resolve(directory), temp = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temp) && path.basename(resolved).startsWith('konx-incidents-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
};
const manifestFile = (store, id) => path.join(store.directory, id, 'manifest.json');
const rawManifest = async (store, id) => JSON.parse(await fs.readFile(manifestFile(store, id), 'utf8'));
const rewrite = async (store, id, mutate) => { const value = await rawManifest(store, id); mutate(value); await fs.writeFile(manifestFile(store, id), JSON.stringify(value)); };
const failingFs = overrides => new Proxy(fs, { get(target, property) { return property in overrides ? overrides[property] : target[property]; } });

function defineIncidentTests(test) {
  test('incident times require a valid complete source date and timezone', () => {
    assert.equal(parseTimestamp('2026-10-21T13:14:15.123456-04:00'), '2026-10-21T17:14:15.123Z');
    assert.equal(parseTimestamp('2000-02-29T23:59:59Z'), '2000-02-29T23:59:59.000Z');
    for (const value of [null, 8, '', 'Oct 21 13:14:15', '2026-10-21T13:14:15', '2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-01-00T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-21T24:00:00Z', '2026-10-21T13:14:60Z', '2026-10-21T13:14:15+24:00']) assert.equal(parseTimestamp(value), null);
  });

  test('syslog keeps source lines and missing-year or missing-zone times unknown', () => {
    const result = parseSyslog('<34>1 2026-10-21T13:14:15-04:00 switch app - - - changed\r\n' +
      '<34>2026-10-21T17:14:16Z direct ISO\n\n<13>Oct 21 13:14:16 host old syslog\n' +
      '2026-02-30T13:14:17Z invalid calendar\n2026-10-21T13:14:17 no zone\n<34>1 - host app - - - nil timestamp');
    assert.equal(result.events[0].observedAt, '2026-10-21T17:14:15.000Z');
    assert.equal(result.events[0].timeText, '2026-10-21T13:14:15-04:00');
    assert.equal(result.events[1].observedAt, '2026-10-21T17:14:16.000Z');
    assert.deepEqual(result.events.slice(2).map(e => [e.line, e.observedAt, e.timeText]), [
      [4, null, 'Oct 21 13:14:16'], [5, null, '2026-02-30T13:14:17Z'], [6, null, '2026-10-21T13:14:17'], [7, null, '-'],
    ]);
    assert.equal(result.explicitTimestamps, 2); assert.equal(result.unknownTimestamps, 4);
    assert.equal(result.examinedLines, 7); assert.equal(result.limited, false);
  });

  test('syslog scans complete bounded input while retaining only a bounded timeline', () => {
    const result = parseSyslog('message\n'.repeat(LIMITS.timeline + 3) + '\n'.repeat(20000));
    assert.equal(result.events.length, LIMITS.timeline); assert.equal(result.nonemptyLines, LIMITS.timeline + 3);
    assert.equal(result.examinedLines, LIMITS.timeline + 20004); assert.equal(result.limited, true);
    const zero = parseSyslog('one\ntwo', { limit: 0 });
    assert.equal(zero.events.length, 0); assert.equal(zero.nonemptyLines, 2); assert.equal(zero.limited, true);
    assert.throws(() => parseSyslog('x', { limit: -1 }), /limit/);
    assert.throws(() => parseSyslog('x'.repeat(LIMITS.textBytes + 1)), /8 MiB/);
  });

  test('incident create, append-only notes, list and removal round trip', withStore(async store => {
    const created = await store.create({ title: '  Link outage  ', description: 'Investigate floor 2' });
    assert.equal(created.title, 'Link outage'); assert.equal(created.evidenceCount, 0);
    const first = await store.addText(created.id, { kind: 'note', text: 'Saw a link flap', label: 'Observation' });
    assert.equal(first.evidence[0].textPreview, 'Saw a link flap'); assert.equal(first.evidence[0].observedAt, null);
    assert.equal(first.timeline[0].observedAt, null); assert.equal(first.timeline[0].timestampStatus, 'unknown');
    const firstPath = await store.evidencePath(created.id, first.evidence[0].id), firstBytes = await fs.readFile(firstPath);
    const second = await store.addText(created.id, { kind: 'note', text: 'Then it recovered', observedAt: '2026-10-21T10:00:00-04:00' });
    assert.equal(second.evidence.length, 2); assert.equal(second.timeline[0].observedAt, '2026-10-21T14:00:00.000Z');
    assert.equal(second.evidence[1].timeText, '2026-10-21T10:00:00-04:00');
    assert.deepEqual(await fs.readFile(firstPath), firstBytes);
    const listing = await store.list(); assert.equal(listing.incidents[0].evidenceCount, 2); assert.deepEqual(listing.issues, []);
    assert.deepEqual(await store.remove(created.id), { removed: created.id }); assert.deepEqual((await store.list()).incidents, []);
  }));

  test('capture import copies original bytes with a SHA-256 and UUID asset name', withStore(async (store, directory) => {
    const source = path.join(directory, 'capture & original.pcap'), bytes = Buffer.from([0xd4, 0xc3, 0xb2, 0xa1, 0, 255]);
    await fs.writeFile(source, bytes); const oldTime = new Date('2020-01-02T03:04:05Z'); await fs.utimes(source, oldTime, oldTime);
    const created = await store.create({ title: 'Capture' });
    const incident = await store.addFile(created.id, { kind: 'capture', sourcePath: source, label: '../../outside.html' });
    const item = incident.evidence[0], asset = await store.evidencePath(created.id, item.id);
    assert.equal(item.sha256, digest(bytes)); assert.equal(item.sourceName, 'capture & original.pcap');
    assert.equal(item.originalPath, source); assert.equal(item.observedAt, null); assert.equal(item.sourceModifiedAt, oldTime.toISOString());
    assert.equal(item.textPreview, undefined); assert.match(path.basename(asset), /^[0-9a-f-]{36}\.bin$/);
    assert.equal(path.dirname(asset), path.join(store.directory, created.id, 'evidence'));
    await fs.writeFile(source, 'changed after import'); assert.deepEqual(await fs.readFile(asset), bytes);
    await store.remove(created.id); assert.equal(await fs.readFile(source, 'utf8'), 'changed after import');
  }));

  test('current capture bytes are copied before awaiting the store queue', withStore(async store => {
    const created = await store.create({ title: 'Current capture' }), source = Uint8Array.from([1, 2, 3]);
    const pending = store.addBytes(created.id, { kind: 'capture', bytes: source, sourceName: '../selected.pcapng', label: 'Current capture' });
    source.fill(9);
    const result = await pending, asset = await store.evidencePath(created.id, result.evidence[0].id);
    assert.deepEqual(await fs.readFile(asset), Buffer.from([1, 2, 3]));
    assert.equal(result.evidence[0].sourceName, '../selected.pcapng'); assert.equal(result.evidence[0].originalPath, null);
    assert.throws(() => store.addBytes(created.id, { kind: 'note', bytes: source }), /Capture/);
    assert.throws(() => store.addBytes(created.id, { kind: 'capture', bytes: [1, 2] }), /byte array/);
  }));

  test('syslog import preserves unknown source times and exact line provenance', withStore(async (store, directory) => {
    const source = path.join(directory, 'switch.log'), text = 'Oct 21 13:00:00 sw link down\n2026-10-20T12:00:00Z sw earlier\n\n2026-10-21T14:00:00+02:00 sw later\n';
    await fs.writeFile(source, text); const created = await store.create({ title: 'Syslog' });
    const result = await store.addFile(created.id, { kind: 'syslog', sourcePath: source });
    assert.equal(result.evidence[0].observedAt, null); assert.equal(result.evidence[0].textPreview, text);
    assert.deepEqual(result.timeline.map(e => e.line), [2, 4, 1]);
    assert.equal(result.timeline[2].observedAt, null); assert.equal(result.timeline[2].timeText, 'Oct 21 13:00:00');
    assert.equal(result.evidence[0].timelineCoverage.explicitTimestamps, 2); assert.equal(result.evidence[0].timelineCoverage.unknownTimestamps, 1);
    assert.equal(result.evidence[0].timelineCoverage.totalLines, 5);
  }));

  test('portable reports include escaped note, terminal and tool text, with no binary payload', withStore(async store => {
    const created = await store.create({ title: '<script>alert(1)</script>', description: '<img src=x onerror=alert(2)>' });
    await store.addText(created.id, { kind: 'note', label: '" onclick="evil()', text: '<script>evil()</script> & "notes"' });
    await store.addText(created.id, { kind: 'terminal', text: 'show version\nCisco output' });
    await store.addText(created.id, { kind: 'tool', text: '{"packets":42}' });
    await store.addBytes(created.id, { kind: 'capture', bytes: Buffer.from('BINARY-PRIVATE-PAYLOAD'), label: '</details><script>evil()</script>' });
    const json = await store.exportJson(created.id), report = JSON.parse(json), html = await store.exportHtml(created.id);
    assert.equal(report.kind, 'konx-incident-report'); assert.equal(report.incident.evidence[0].text, '<script>evil()</script> & "notes"');
    assert.equal(report.incident.evidence[1].text, 'show version\nCisco output'); assert.equal(report.incident.evidence[2].text, '{"packets":42}');
    assert.equal(report.incident.evidence[3].text, undefined); assert.equal(report.incident.evidence[3].integrity, 'not-checked');
    assert.equal(json.includes('BINARY-PRIVATE-PAYLOAD'), false); assert.equal(html.includes('BINARY-PRIVATE-PAYLOAD'), false);
    assert.equal(html.includes('<script>'), false); assert.equal(html.includes('<img src='), false);
    assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;')); assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes('show version')); assert.ok(html.includes('Cisco output'));
  }));

  test('text export and display bounds expose truncation without changing source evidence', withStore(async (store, directory) => {
    const text = 'é'.repeat(LIMITS.exportTextBytes / 2 + 7), source = path.join(directory, 'large.txt');
    await fs.writeFile(source, text); const created = await store.create({ title: 'Large text' });
    const result = await store.addFile(created.id, { kind: 'tool', sourcePath: source });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.responseBytes);
    assert.equal(result.evidence[0].textPreviewTruncated, true); assert.equal(Buffer.byteLength(result.evidence[0].textPreview), LIMITS.previewBytes);
    const report = JSON.parse(await store.exportJson(created.id)), item = report.incident.evidence[0];
    assert.equal(item.textTruncated, true); assert.equal(item.embeddedTextBytes, LIMITS.exportTextBytes); assert.equal(item.text.endsWith('�'), false);
    assert.equal(await fs.readFile(await store.evidencePath(created.id, item.id), 'utf8'), text);
    assert.ok((await store.exportHtml(created.id)).includes('Embedded text truncated'));
  }));

  test('hash verification detects same-size evidence mutation and exports mark it explicitly', withStore(async store => {
    const created = await store.create({ title: 'Integrity' }); const result = await store.addText(created.id, { kind: 'note', text: 'original' });
    const item = result.evidence[0], asset = await store.evidencePath(created.id, item.id); await fs.writeFile(asset, 'modified');
    await assert.rejects(store.evidencePath(created.id, item.id), /checksum/);
    const read = await store.get(created.id); assert.equal(read.evidence[0].integrity, 'error'); assert.equal(read.evidence[0].textPreview, undefined);
    const exported = JSON.parse(await store.exportJson(created.id)); assert.equal(exported.incident.evidence[0].integrity, 'error'); assert.match(exported.incident.evidence[0].textOmitted, /checksum/);
    assert.equal(exported.incident.evidence[0].sha256, digest(Buffer.from('original')));
  }));

  test('malformed UTF-8 stays available as original bytes without invented text or events', withStore(async (store, directory) => {
    const source = path.join(directory, 'nonutf8.log'), bytes = Buffer.from([0xff, 0xfe, 0x41, 0]); await fs.writeFile(source, bytes);
    const created = await store.create({ title: 'Invalid text' }); const result = await store.addFile(created.id, { kind: 'syslog', sourcePath: source });
    assert.equal(result.evidence[0].integrity, 'verified'); assert.match(result.evidence[0].analysisError, /UTF-8/); assert.match(result.evidence[0].previewError, /UTF-8/); assert.equal(result.timeline.length, 0);
    assert.deepEqual(await fs.readFile(await store.evidencePath(created.id, result.evidence[0].id)), bytes);
    assert.equal(JSON.parse(await store.exportJson(created.id)).incident.evidence[0].text, undefined);
  }));

  test('corrupt manifests remain visible and removable using independent ownership', withStore(async store => {
    const created = await store.create({ title: 'Corrupt' }); await fs.writeFile(manifestFile(store, created.id), '{broken');
    const listed = await store.list(); assert.equal(listed.incidents.length, 0); assert.equal(listed.issues[0].id, created.id); assert.match(listed.issues[0].message, /malformed/);
    await assert.rejects(store.get(created.id), /malformed/); assert.deepEqual(await store.remove(created.id), { removed: created.id });
  }));

  test('manifest validation rejects contradictory timestamps and duplicate evidence identities', withStore(async store => {
    const created = await store.create({ title: 'Schema' }); await store.addText(created.id, { kind: 'note', text: 'evidence' });
    const original = await fs.readFile(manifestFile(store, created.id));
    await rewrite(store, created.id, v => { v.timeline[0].timestampStatus = 'explicit'; });
    await assert.rejects(store.get(created.id), /time/); await fs.writeFile(manifestFile(store, created.id), original);
    await rewrite(store, created.id, v => { v.evidence.push({ ...v.evidence[0] }); v.totalBytes *= 2; });
    await assert.rejects(store.get(created.id), /Duplicate/); await fs.writeFile(manifestFile(store, created.id), original);
    await rewrite(store, created.id, v => { v.evidence[0].relativePath = '../../elsewhere'; });
    await assert.rejects(store.get(created.id), /Invalid evidence/);
  }));

  test('unrecognized fields from edited manifests cannot inject report content', withStore(async store => {
    const created = await store.create({ title: 'Whitelist' }); await store.addText(created.id, { kind: 'note', text: 'original' });
    await rewrite(store, created.id, v => { v.extra = '<script>untrusted</script>'; v.evidence[0].text = 'forged'; v.timeline[0].extra = 'forged'; });
    const result = await store.get(created.id); assert.equal(result.extra, undefined); assert.equal(result.evidence[0].text, undefined); assert.equal(result.timeline[0].extra, undefined);
    assert.equal(JSON.parse(await store.exportJson(created.id)).incident.evidence[0].text, 'original');
  }));

  test('invalid IDs and foreign files never authorize deletion', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Paths' });
    for (const id of ['../outside', directory, created.id.toUpperCase(), 'not-an-id']) {
      await assert.rejects(store.get(id), /identifier/); await assert.rejects(store.remove(id), /identifier/);
    }
    const foreign = path.join(store.directory, created.id, 'important.txt'); await fs.writeFile(foreign, 'keep');
    await assert.rejects(store.remove(created.id), /unrecognized/); assert.equal(await fs.readFile(foreign, 'utf8'), 'keep');
    const owner = path.join(store.directory, created.id, 'owner.json'); const record = JSON.parse(await fs.readFile(owner, 'utf8')); record.id = crypto.randomUUID(); await fs.writeFile(owner, JSON.stringify(record));
    await assert.rejects(store.get(created.id), /ownership/); await assert.rejects(store.remove(created.id), /ownership/);
    await fs.writeFile(path.join(store.directory, 'foreign.txt'), 'leave alone'); assert.ok((await store.list()).issues.some(i => i.file === 'foreign.txt'));
  }));

  test('store refuses directory junctions and leaves the target files intact', withStore(async (store, directory) => {
    const created = await store.create({ title: 'No links' }), evidenceDir = path.join(store.directory, created.id, 'evidence');
    const target = path.join(directory, 'elsewhere'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'keep'); await fs.rmdir(evidenceDir);
    await fs.symlink(target, evidenceDir, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.get(created.id), /symbolic links/); await assert.rejects(store.remove(created.id), /symbolic links/);
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  }));

  test('text, source file and timestamp limits fail without appending any evidence', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Bounds' });
    await assert.rejects(store.addText(created.id, { kind: 'note', text: 'x'.repeat(LIMITS.noteBytes + 1) }), /256 KiB/);
    await assert.rejects(store.addText(created.id, { kind: 'note', text: 'x', observedAt: '2026-10-21T12:00:00' }), /UTC offset/);
    await assert.rejects(store.addFile(created.id, { kind: 'capture', sourcePath: path.join(directory, 'missing.pcap') }), missing);
    await assert.rejects(store.addFile(created.id, { kind: 'capture', sourcePath: '../relative' }), /absolute/);
    const large = path.join(directory, 'large.pcap'), handle = await fs.open(large, 'wx'); await handle.truncate(LIMITS.fileBytes + 1); await handle.close();
    await assert.rejects(store.addFile(created.id, { kind: 'capture', sourcePath: large }), /byte limit/);
    const tooLargeText = path.join(directory, 'large.txt'), textHandle = await fs.open(tooLargeText, 'wx'); await textHandle.truncate(LIMITS.textBytes + 1); await textHandle.close();
    await assert.rejects(store.addFile(created.id, { kind: 'syslog', sourcePath: tooLargeText }), /byte limit/);
    assert.equal((await store.get(created.id)).evidence.length, 0); assert.deepEqual(await fs.readdir(path.join(store.directory, created.id, 'evidence')), []);
  }));

  test('failed manifest publication preserves previous evidence and cleans its unpublished asset', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Atomic append' }); await store.addText(created.id, { kind: 'note', text: 'saved' });
    const previous = await fs.readFile(manifestFile(store, created.id)), previousAssets = await fs.readdir(path.join(store.directory, created.id, 'evidence'));
    const failed = new IncidentStore(directory, { fs: failingFs({ rename: async () => { throw new Error('Injected rename failure'); } }) });
    await assert.rejects(failed.addText(created.id, { kind: 'note', text: 'not saved' }), /Injected rename/);
    assert.deepEqual(await fs.readFile(manifestFile(store, created.id)), previous);
    assert.deepEqual(await fs.readdir(path.join(store.directory, created.id, 'evidence')), previousAssets);
    assert.equal((await store.get(created.id)).evidence.length, 1);
  }));

  test('a committed note returns its saved report without reopening the published manifest', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Committed note' });
    let published = false, blockedReads = 0;
    const guarded = new IncidentStore(directory, { fs: failingFs({
      rename: async (from, to) => { await fs.rename(from, to); if (to === manifestFile(store, created.id)) published = true; },
      open: async (file, ...options) => {
        if (published && file === manifestFile(store, created.id)) {
          blockedReads++; throw Object.assign(new Error('Injected post-commit manifest read failure'), { code: 'EACCES' });
        }
        return fs.open(file, ...options);
      },
    }) });
    const result = await guarded.addText(created.id, { kind: 'note', text: 'Saved exactly once', label: 'Saved note' });
    assert.equal(published, true); assert.equal(blockedReads, 0, 'Save confirmation must use the manifest it committed');
    assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].textPreview, 'Saved exactly once');
    const reopened = await new IncidentStore(directory).get(created.id);
    assert.equal(reopened.evidence.length, 1); assert.equal(reopened.evidence[0].id, result.evidence[0].id);
  }));

  test('a saved note with a failed preview stays committed and exposes the preview failure', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Preview unavailable' });
    const guarded = new IncidentStore(directory, { fs: failingFs({ open: async (file, ...options) => {
      if (options[0] === 'r' && path.extname(file) === '.bin') throw Object.assign(new Error('Injected evidence preview read failure'), { code: 'EACCES' });
      return fs.open(file, ...options);
    } }) });
    const result = await guarded.addText(created.id, { kind: 'note', text: 'Saved despite unavailable preview' });
    assert.equal(result.evidence.length, 1); assert.match(result.evidence[0].previewError, /preview read failure/);
    assert.equal(result.evidence[0].textPreview, undefined);
    const reopened = await store.get(created.id);
    assert.equal(reopened.evidence.length, 1); assert.equal(reopened.evidence[0].integrity, 'verified');
    assert.equal(reopened.evidence[0].textPreview, 'Saved despite unavailable preview');
  }));

  test('failed initial publication removes its incomplete owned workspace', withStore(async (store, directory) => {
    const failed = new IncidentStore(directory, { fs: failingFs({ link: async (from, to) => {
      if (path.basename(to) === 'manifest.json') throw new Error('Injected link failure'); return fs.link(from, to);
    } }) });
    await assert.rejects(failed.create({ title: 'Not published' }), /Injected link/);
    assert.deepEqual(await fs.readdir(store.directory), []);
  }));

  test('cleanup failure keeps independent incident ownership so deletion can be retried', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Retry delete' }); await store.addText(created.id, { kind: 'note', text: 'saved' });
    const target = path.join(store.directory, created.id);
    const failed = new IncidentStore(directory, { fs: failingFs({ rmdir: async folder => {
      if (folder === target) throw new Error('Injected final directory failure'); return fs.rmdir(folder);
    } }) });
    await assert.rejects(failed.remove(created.id), /Injected final/);
    const owner = JSON.parse(await fs.readFile(path.join(target, 'owner.json'), 'utf8')); assert.equal(owner.id, created.id);
    const list = await store.list(); assert.equal(list.issues[0].id, created.id);
    assert.deepEqual(await store.remove(created.id), { removed: created.id });
  }));

  test('serialized concurrent appends retain every independently owned item', withStore(async store => {
    const created = await store.create({ title: 'Concurrent notes' });
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.addText(created.id, { kind: 'note', text: 'Note ' + index })));
    const result = await store.get(created.id); assert.equal(result.evidence.length, 8); assert.equal(result.timeline.length, 8);
    assert.deepEqual(result.evidence.map(e => e.textPreview), Array.from({ length: 8 }, (_, index) => 'Note ' + index));
  }));

  test('timeline and manifest limits preserve raw syslog and display explicit coverage', withStore(async (store, directory) => {
    const text = ('2026-10-21T00:00:00Z ' + '\u0001'.repeat(500) + '\n').repeat(1600), source = path.join(directory, 'escaped.log');
    await fs.writeFile(source, text); const created = await store.create({ title: 'Timeline bounds' });
    const result = await store.addFile(created.id, { kind: 'syslog', sourcePath: source });
    const item = result.evidence[0], raw = await fs.readFile(manifestFile(store, created.id));
    assert.ok(raw.length <= LIMITS.manifestBytes); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.responseBytes);
    assert.equal(result.timelineLimited, true); assert.equal(item.timelineCoverage.nonemptyLines, 1600);
    assert.equal(item.timelineCoverage.retainedEvents, result.timeline.length); assert.equal(item.timelineCoverage.limited, true);
    assert.ok(result.timeline.length < 1500); assert.equal(item.sha256, digest(Buffer.from(text)));
    assert.equal(await fs.readFile(await store.evidencePath(created.id, item.id), 'utf8'), text);
  }));

  test('manifest evidence and store-count bounds are enforced before mutation', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Count bounds' });
    await rewrite(store, created.id, value => {
      value.evidence = Array.from({ length: LIMITS.evidence }, () => {
        const id = crypto.randomUUID(); return { id, kind: 'capture', label: 'metadata', addedAt: value.createdAt, observedAt: null, timeText: null,
          sourceName: 'capture.pcap', originalPath: null, sourceModifiedAt: null, relativePath: 'evidence/' + id + '.bin', bytes: 0, sha256: digest(Buffer.alloc(0)) };
      });
    });
    await assert.rejects(store.addText(created.id, { kind: 'note', text: 'extra' }), /128-evidence/);
    const full = new IncidentStore(directory, { fs: failingFs({ readdir: async target => target === store.directory ? Array.from({ length: LIMITS.incidents }, () => crypto.randomUUID()) : fs.readdir(target) }) });
    await assert.rejects(full.create({ title: 'One too many' }), /200-workspace/);
    assert.equal((await store.get(created.id)).evidence.length, LIMITS.evidence);
  }));

  test('capture reopen returns verified owned bytes and rejects noncapture or mutated evidence', withStore(async store => {
    const created = await store.create({ title: 'Capture reopen' });
    const capture = await store.addBytes(created.id, { kind: 'capture', bytes: Buffer.from([1, 2, 3, 4]), sourceName: 'selected.pcapng' });
    const item = capture.evidence[0], opened = await store.readCapture(created.id, item.id);
    assert.equal(opened.name, 'selected.pcapng'); assert.deepEqual(opened.bytes, Buffer.from([1, 2, 3, 4]));
    const withNote = await store.addText(created.id, { kind: 'note', text: 'not capture data' });
    await assert.rejects(store.readCapture(created.id, withNote.evidence[1].id), /capture evidence/);
    await assert.rejects(store.readCapture(created.id, '../escape'), /identifier/);
    const file = await store.evidencePath(created.id, item.id); await fs.writeFile(file, Buffer.from([4, 3, 2, 1]));
    await assert.rejects(store.readCapture(created.id, item.id), /checksum/);
    assert.deepEqual(opened.bytes, Buffer.from([1, 2, 3, 4]));
  }));

  test('source-open failure rolls back the staged asset without changing incident or source', withStore(async (store, directory) => {
    const created = await store.create({ title: 'Source disappears' }), source = path.join(directory, 'source.pcap'); await fs.writeFile(source, 'original');
    const previous = await fs.readFile(manifestFile(store, created.id));
    const failed = new IncidentStore(directory, { fs: failingFs({ open: async (file, ...options) => {
      if (file === source) throw new Error('Injected source open failure'); return fs.open(file, ...options);
    } }) });
    await assert.rejects(failed.addFile(created.id, { kind: 'capture', sourcePath: source }), /source open failure/);
    assert.deepEqual(await fs.readFile(manifestFile(store, created.id)), previous); assert.equal(await fs.readFile(source, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(path.join(store.directory, created.id, 'evidence')), []);
  }));

  test('total evidence byte bound includes all existing assets before appending', withStore(async store => {
    const created = await store.create({ title: 'Total bound' });
    await rewrite(store, created.id, value => {
      value.totalBytes = LIMITS.incidentBytes;
      value.evidence = Array.from({ length: 4 }, () => {
        const id = crypto.randomUUID(); return { id, kind: 'capture', label: 'metadata', addedAt: value.createdAt, observedAt: null, timeText: null,
          sourceName: 'capture.pcap', originalPath: null, sourceModifiedAt: null, relativePath: 'evidence/' + id + '.bin', bytes: LIMITS.fileBytes, sha256: digest(Buffer.alloc(0)) };
      });
    });
    await assert.rejects(store.addBytes(created.id, { kind: 'capture', bytes: Buffer.from([1]) }), /512 MiB/);
    assert.deepEqual(await fs.readdir(path.join(store.directory, created.id, 'evidence')), []);
  }));
}

async function runIncidentTests(test) {
  const cases = []; defineIncidentTests((name, fn) => cases.push({ name, fn }));
  for (const { name, fn } of cases) await test(name, fn);
}
module.exports = { runIncidentTests };
if (require.main === module) {
  let passed = 0, failed = 0;
  runIncidentTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } })
    .then(() => { console.log(`${passed}/${passed + failed} incident tests passed`); process.exitCode = failed ? 1 : 0; });
}

