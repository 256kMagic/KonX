'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MAX_BODY_BYTES, bodyFilename, saveCaptureBody } = require('../src/main/capture/export');

async function runCaptureExportTests(test) {
  console.log('packet capture: recovered HTTP body export');
  await test('recovered body writes exact binary bytes only to the native-dialog destination', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'konx-body-'));
    const destination = path.join(dir, 'chosen.bin');
    try {
      const allBytes = Uint8Array.from([99, 0, 255, 195, 169, 13, 10, 99]);
      const bytes = allBytes.subarray(1, -1);
      let dialogOptions;
      const saved = await saveCaptureBody('C:\\outside\\..\\captured.bin', bytes, {
        chooseFile: async (options) => {
          dialogOptions = options;
          return { canceled: false, filePath: destination };
        },
        writeFile: fs.writeFile,
      });
      assert.equal(saved, destination);
      assert.equal(dialogOptions.defaultPath, 'captured.bin');
      assert.deepEqual(await fs.readFile(destination), Buffer.from(bytes));
      assert.deepEqual(await fs.readdir(dir), ['chosen.bin']);
    } finally {
      // Only known files in this test-created temporary directory are removed.
      await fs.unlink(destination).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(dir);
    }
  });

  await test('suggested body filenames discard paths and Windows-invalid or device names', () => {
    const cases = [
      ['../../private/data.json', 'data.json'],
      ['..\\..\\secret.txt', 'secret.txt'],
      ['\\\\server\\share\\body.txt', 'body.txt'],
      ['hello:stream?.txt. ', 'hello_stream_.txt'],
      ['CON.txt', '_CON.txt'],
      ['com1', '_com1'],
      ['LPT².log', '_LPT².log'],
      ['NUL .txt', '_NUL .txt'],
      ['..', 'recovered-body.bin'],
      ['', 'recovered-body.bin'],
      [null, 'recovered-body.bin'],
    ];
    for (const [input, expected] of cases) assert.equal(bodyFilename(input), expected);
    const longName = bodyFilename('a'.repeat(300) + '.json');
    assert.ok(longName.length <= 180);
    assert.ok(longName.endsWith('.json'));
    const unicodeName = bodyFilename('🦊'.repeat(200) + '.json');
    assert.ok(unicodeName.length <= 180);
    assert.ok(unicodeName.endsWith('.json'));
    assert.ok(unicodeName.isWellFormed());
  });

  await test('invalid and oversized body payloads are rejected before the save dialog or write', async () => {
    let calls = 0;
    const dependencies = {
      chooseFile: async () => { calls++; return { canceled: true }; },
      writeFile: async () => { calls++; },
    };
    for (const bytes of [null, 'hello', [1, 2], new ArrayBuffer(2), { byteLength: 2, 0: 1, 1: 2 }]) {
      await assert.rejects(saveCaptureBody('body.bin', bytes, dependencies), /Uint8Array/);
    }
    await assert.rejects(saveCaptureBody('body.bin', new Uint8Array(MAX_BODY_BYTES + 1), dependencies), /16 MiB/);
    assert.equal(calls, 0);
  });

  await test('cancelling recovered-body export does not write a file', async () => {
    for (const result of [{ canceled: true, filePath: 'ignored.bin' }, { canceled: false }]) {
      const value = await saveCaptureBody('body.bin', new Uint8Array([1]), {
        chooseFile: async () => result,
        writeFile: async () => assert.fail('cancelled dialog must not write'),
      });
      assert.equal(value, null);
    }
  });

  await test('recovered-body export snapshots the selected bytes before waiting for the dialog', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    let written;
    await saveCaptureBody('body.bin', bytes, {
      chooseFile: async () => {
        bytes.fill(9);
        return { canceled: false, filePath: 'chosen.bin' };
      },
      writeFile: async (_file, data) => { written = data; },
    });
    assert.deepEqual(written, Buffer.from([1, 2, 3]));
  });

  await test('empty and maximum-size recovered bodies retain their exact size', async () => {
    for (const size of [0, MAX_BODY_BYTES]) {
      let writtenSize = -1;
      await saveCaptureBody('body.bin', new Uint8Array(size), {
        chooseFile: async () => ({ canceled: false, filePath: 'chosen.bin' }),
        writeFile: async (_file, bytes) => { writtenSize = bytes.length; },
      });
      assert.equal(writtenSize, size);
    }
  });

  await test('native-dialog and disk errors propagate instead of reporting a saved body', async () => {
    const dialogError = new Error('Dialog failed');
    await assert.rejects(saveCaptureBody('body.bin', new Uint8Array([1]), {
      chooseFile: async () => { throw dialogError; },
      writeFile: async () => assert.fail('failed dialog must not write'),
    }), (error) => error === dialogError);
    const diskError = new Error('Disk full');
    await assert.rejects(saveCaptureBody('body.bin', new Uint8Array([1]), {
      chooseFile: async () => ({ canceled: false, filePath: 'chosen.bin' }),
      writeFile: async () => { throw diskError; },
    }), (error) => error === diskError);
  });
}

module.exports = { runCaptureExportTests };
