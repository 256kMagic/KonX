'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Compile the production owning method with a narrow filesystem observation
// seam. Reads still use actual temporary files and owned real descriptors.
function reader(overrides = {}) {
  const filename = path.resolve(__dirname, '../src/main/capture/index.js');
  const source = fs.readFileSync(filename, 'utf8');
  const module = new Module(filename), requireFrom = Module.createRequire(filename);
  module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  module.require = name => name === 'fs' ? { ...fs, ...overrides } : requireFrom(name);
  module._compile(source, filename);
  return module.exports.readCaptureFile;
}
function fixture(fn) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'konx-capture-reader-'));
  try { return fn(folder); } finally {
    if (path.dirname(folder) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('konx-capture-reader-')) throw new Error('Unexpected test cleanup directory');
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

async function runCaptureFileReaderTests(test) {
  await test('capture file reader returns exact-limit bytes over multiple bounded reads and preserves extension rules', () => fixture(folder => {
    const read = reader(), file = path.join(folder, 'capture.PCAPNG'), data = Buffer.alloc(131073, 73);
    fs.writeFileSync(file, data); assert.deepEqual(read(file, { maxBytes: data.length }), data);
    assert.deepEqual(read(file), data);
    const empty = path.join(folder, 'empty.cap'); fs.writeFileSync(empty, ''); assert.equal(read(empty, { maxBytes: 1 }).length, 0);
    assert.throws(() => read(path.join(folder, 'capture.txt')), /Not a capture file/);
    for (const maxBytes of [0, -1, 1.5, Infinity, 1024 * 1024 * 1024 + 1]) assert.throws(() => read(file, { maxBytes }), /byte limit/);
  }));

  await test('ordinary capture import fills and returns one initial-size allocation without a second whole-file copy', () => fixture(folder => {
    const file = path.join(folder, 'single-allocation.pcap'), data = Buffer.alloc(2 * 1024 * 1024, 91);
    fs.writeFileSync(file, data); const buffers = new Set(); let readCalls = 0;
    const read = reader({ readSync(fd, buffer, offset, length, position) {
      buffers.add(buffer); readCalls++; assert.ok(buffer.length <= data.length + 1);
      return fs.readSync(fd, buffer, offset, length, position);
    } });
    const result = read(file, { maxBytes: data.length });
    assert.deepEqual(result, data); assert.ok(readCalls > 1); assert.equal(buffers.size, 1);
    const owned = [...buffers][0]; assert.equal(result.buffer, owned.buffer); assert.equal(result.byteOffset, owned.byteOffset);
    assert.equal(owned.length, data.length + 1); assert.equal(result.length, data.length);
  }));

  await test('capture file reader rejects an oversized file before reads and closes its descriptor', () => fixture(folder => {
    const file = path.join(folder, 'too-large.pcap'); fs.writeFileSync(file, '12345'); let reads = 0, closed = 0, descriptor;
    const read = reader({ openSync(...args) { descriptor = fs.openSync(...args); return descriptor; },
      readSync(...args) { reads++; return fs.readSync(...args); }, closeSync(fd) { closed++; return fs.closeSync(fd); } });
    assert.throws(() => read(file, { maxBytes: 4 }), /4-byte limit/); assert.equal(reads, 0); assert.equal(closed, 1);
    assert.throws(() => fs.fstatSync(descriptor), error => error.code === 'EBADF');
  }));

  await test('capture file reader rejects directories instead of treating non-file input as captured bytes', () => fixture(folder => {
    const directory = path.join(folder, 'directory.pcap'); fs.mkdirSync(directory); let reads = 0;
    const read = reader({ readSync(...args) { reads++; return fs.readSync(...args); } });
    assert.throws(() => read(directory, { maxBytes: 16 }), /regular file|EISDIR|EACCES|EPERM/); assert.equal(reads, 0);
  }));

  await test('capture file growth after descriptor stat cannot exceed maxBytes plus one read byte', () => fixture(folder => {
    const file = path.join(folder, 'growing.pcap'); fs.writeFileSync(file, '1234'); let totalRead = 0, closed = 0, grew = false;
    const read = reader({ fstatSync(fd) { const stat = fs.fstatSync(fd); if (!grew) { grew = true; fs.appendFileSync(file, '567890'); } return stat; },
      readSync(fd, buffer, offset, length, position) { assert.ok(length <= 6 - totalRead); const count = fs.readSync(fd, buffer, offset, length, position); totalRead += count; return count; },
      closeSync(fd) { closed++; fs.closeSync(fd); } });
    assert.throws(() => read(file, { maxBytes: 5 }), /5-byte limit/); assert.equal(totalRead, 6); assert.equal(closed, 1);
  }));

  await test('capture file changes below the bound return only bytes read from the owned descriptor', () => fixture(folder => {
    const file = path.join(folder, 'changing.pcap'); fs.writeFileSync(file, '1234'); let changed = false;
    const grown = reader({ fstatSync(fd) { const stat = fs.fstatSync(fd); if (!changed) { changed = true; fs.appendFileSync(file, '56'); } return stat; } });
    assert.equal(grown(file, { maxBytes: 8 }).toString(), '123456');
    const shrunk = reader({ fstatSync(fd) { const stat = fs.fstatSync(fd); fs.truncateSync(file, 2); return stat; } });
    assert.equal(shrunk(file, { maxBytes: 8 }).toString(), '12');
  }));

  await test('capture read errors close the owned descriptor and preserve the original error', () => fixture(folder => {
    const file = path.join(folder, 'failed.pcap'); fs.writeFileSync(file, '1234'); let descriptor, closed = 0;
    const failure = new Error('controlled disk read failure');
    const read = reader({ openSync(...args) { descriptor = fs.openSync(...args); return descriptor; }, readSync() { throw failure; },
      closeSync(fd) { closed++; fs.closeSync(fd); } });
    assert.throws(() => read(file, { maxBytes: 5 }), error => error === failure); assert.equal(closed, 1);
    assert.throws(() => fs.fstatSync(descriptor), error => error.code === 'EBADF');
  }));
}

module.exports = { runCaptureFileReaderTests };
if (require.main === module) {
  (async () => {
    let passed = 0, failed = 0;
    await runCaptureFileReaderTests(async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } });
    console.log(`${passed}/${passed + failed} capture file reader tests passed`); process.exitCode = failed ? 1 : 0;
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
