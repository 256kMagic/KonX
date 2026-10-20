'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SftpManager } = require('../src/main/sftp');

const DIR = 0o040755;
const FILE = 0o100644;

async function withTemp(fn) {
  // Keep all filesystem fixtures inside the repository, including link targets.
  const parent = path.resolve(__dirname);
  const dir = fs.mkdtempSync(path.join(parent, '.sftp-regression-'));
  try {
    await fn(dir);
  } finally {
    const relative = path.relative(parent, dir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fixture(dir, tree) {
  const events = [];
  const downloads = [];
  const session = {
    stat: async (src) => {
      const item = tree[src];
      if (!item) throw new Error('Unexpected remote path: ' + src);
      return { mode: item.entries ? DIR : FILE, size: (item.content || '').length, mtime: 1234 };
    },
    sftp: {
      readdir: (src, cb) => cb(null, tree[src].entries.map((filename) => ({ filename }))),
      fastGet: (src, dst, options, cb) => {
        if (typeof options === 'function') cb = options;
        downloads.push([src, dst]);
        try {
          fs.writeFileSync(dst, tree[src].content || '');
          cb(null);
        } catch (error) { cb(error); }
      },
      end: () => {},
    },
    close: () => {},
  };
  session.channel = async () => session.sftp;
  const manager = new SftpManager({
    emit: (...args) => events.push(args),
    ask: async () => { throw new Error('Unexpected conflict prompt'); },
    openExternal: async () => {},
    tempDir: () => path.join(dir, 'edits'),
  });
  manager.sessions.set('s', session);
  return { manager, session, events, downloads };
}

async function withLink(link, target, fn) {
  // Mock link metadata so these security checks also run in Windows sandboxes
  // that prohibit creating reparse points. Transfer/file IO remains real.
  const originalLstat = fs.promises.lstat;
  const originalRealpath = fs.promises.realpath;
  fs.promises.lstat = async (file, ...args) => path.resolve(file) === link
    ? { isSymbolicLink: () => true }
    : originalLstat(file, ...args);
  fs.promises.realpath = async (file, ...args) => originalRealpath(path.resolve(file) === link ? target : file, ...args);
  try {
    await fn();
  } finally {
    fs.promises.lstat = originalLstat;
    fs.promises.realpath = originalRealpath;
  }
}

async function waitFor(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for SFTP test transfer');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withClock(fn) {
  const originals = { setInterval: global.setInterval, clearInterval: global.clearInterval, now: Date.now };
  const timers = [];
  let now = 0;
  global.setInterval = (tick, delay) => {
    const timer = { tick, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearInterval = (timer) => { timer.cleared = true; };
  Date.now = () => now;
  try {
    await fn({
      timers,
      tick: async (advance = 1000) => {
        now += advance;
        const timer = timers[timers.length - 1];
        assert.ok(timer && !timer.cleared);
        await timer.tick();
      },
    });
  } finally {
    global.setInterval = originals.setInterval;
    global.clearInterval = originals.clearInterval;
    Date.now = originals.now;
  }
}

function save(local, content, mtime) {
  fs.writeFileSync(local, content);
  const time = new Date(mtime);
  fs.utimesSync(local, time, time);
}

async function runSftpRegressionTests(test) {
  await test('sftp: reject recursive download names containing local path separators', () => withTemp(async (dir) => {
    const badNames = ['..\\..\\escaped.txt', 'sub\\file.txt', 'sub/file.txt', '\\server\\share', 'C:\\escape.txt', 'nul\0.txt'];
    if (process.platform === 'win32') badNames.push('file:stream', 'NUL.txt', 'COM1', 'COM\u00b9.txt', 'AUX .txt', 'file.', 'file ');
    for (const name of badNames) {
      const { manager, downloads } = fixture(dir, { '/folder': { entries: [name] } });
      manager.queue.concurrency = 0;
      await assert.rejects(manager.download('s', ['/folder'], path.join(dir, 'local')), /filename cannot be saved safely/);
      assert.deepStrictEqual(downloads, []);
      assert.strictEqual(manager.queue.jobs.length, 0);
      assert.ok(!fs.existsSync(path.join(dir, 'escaped.txt')));
    }
  }));

  await test('sftp: validate selected remote names for downloads and external editing', () => withTemp(async (dir) => {
    const { manager, downloads } = fixture(dir, {});
    const names = ['/remote/..\\escape.txt', '/'];
    if (process.platform === 'win32') names.push('/remote/file:stream', '/remote/CON.txt');
    for (const name of names) {
      await assert.rejects(manager.download('s', [name], path.join(dir, 'local')), /filename cannot be saved safely/);
      await assert.rejects(manager.edit('s', name), /filename cannot be saved safely/);
    }
    assert.deepStrictEqual(downloads, []);
    assert.ok(!fs.existsSync(path.join(dir, 'edits')));
  }));

  await test('sftp: download normal nested names without renaming them', () => withTemp(async (dir) => {
    const { manager, downloads } = fixture(dir, {
      '/folder': { entries: ['.', '..', 'report v1.txt', 'nested'] },
      '/folder/report v1.txt': { content: 'report' },
      '/folder/nested': { entries: ['caf\u00e9.txt'] },
      '/folder/nested/caf\u00e9.txt': { content: 'nested' },
    });
    const destination = path.join(dir, 'local');
    assert.strictEqual(await manager.download('s', ['/folder'], destination, { conflict: 'overwrite' }), 2);
    await waitFor(() => manager.queue.active.size === 0);
    assert.deepStrictEqual(manager.queue.jobs.map((job) => job.status), ['done', 'done']);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'folder', 'report v1.txt'), 'utf8'), 'report');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'folder', 'nested', 'caf\u00e9.txt'), 'utf8'), 'nested');
    assert.strictEqual(downloads.length, 2);
  }));

  await test('sftp: existing local junction cannot redirect a recursive download', () => withTemp(async (dir) => {
    const destination = path.join(dir, 'local');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(destination);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(destination, 'folder'));
    const { manager, downloads } = fixture(dir, { '/folder': { entries: ['keep.txt'] } });
    await withLink(path.join(destination, 'folder'), outside, async () => {
      await assert.rejects(manager.download('s', ['/folder'], destination, { conflict: 'overwrite' }), /symbolic link or junction/);
    });
    assert.deepStrictEqual(downloads, []);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  }));

  await test('sftp: queued download rechecks its destination before writing', () => withTemp(async (dir) => {
    const destination = path.join(dir, 'local');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const { manager, downloads } = fixture(dir, { '/folder': { entries: ['keep.txt'] }, '/folder/keep.txt': { content: 'overwrite' } });
    manager.queue.concurrency = 0;
    await manager.download('s', ['/folder'], destination, { conflict: 'overwrite' });
    await withLink(path.join(destination, 'folder'), outside, async () => {
      manager.queue.concurrency = 1;
      manager.queue._pump();
      await waitFor(() => manager.queue.active.size === 0);
    });
    assert.strictEqual(manager.queue.jobs[0].status, 'error');
    assert.match(manager.queue.jobs[0].error, /symbolic link or junction/);
    assert.deepStrictEqual(downloads, []);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  }));

  await test('sftp: a user-selected linked destination resolves to its intended root', () => withTemp(async (dir) => {
    const destination = path.join(dir, 'target');
    const selected = path.join(dir, 'selected');
    fs.mkdirSync(destination);
    fs.mkdirSync(selected);
    const { manager } = fixture(dir, { '/file.txt': { content: 'normal' } });
    await withLink(selected, destination, async () => {
      await manager.download('s', ['/file.txt'], selected, { conflict: 'overwrite' });
      await waitFor(() => manager.queue.active.size === 0);
    });
    assert.strictEqual(manager.queue.jobs[0].status, 'done');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'file.txt'), 'utf8'), 'normal');
  }));

  await test('sftp: failed external-editor upload retries the same save', () => withTemp((dir) => withClock(async (clock) => {
    const { manager, session, events } = fixture(dir, { '/file.txt': { content: 'original' } });
    let attempts = 0;
    session.sftp.fastPut = (_local, _remote, cb) => cb(++attempts === 1 ? new Error('Connection reset') : null);
    try {
      const local = await manager.edit('s', '/file.txt');
      const mtime = fs.statSync(local).mtimeMs;
      save(local, 'edited', mtime + 2000);
      await clock.tick();
      assert.strictEqual(attempts, 1);
      const errors = events.filter(([kind]) => kind === 'sftp:edit-error');
      assert.strictEqual(errors.length, 1);
      assert.deepStrictEqual(errors[0].slice(1, 3), ['s', '/file.txt']);
      assert.ok(errors[0][3].includes('Connection reset') && errors[0][3].includes(local));
      assert.strictEqual(events.filter(([kind]) => kind === 'sftp:edited').length, 0);
      await clock.tick();
      assert.strictEqual(attempts, 2);
      assert.strictEqual(events.filter(([kind]) => kind === 'sftp:edited').length, 1);
      await clock.tick();
      assert.strictEqual(attempts, 2);
      assert.strictEqual(fs.readFileSync(local, 'utf8'), 'edited');
    } finally { manager.close('s'); }
    assert.ok(clock.timers.every((timer) => timer.cleared));
  })));

  await test('sftp: editor retries back off and report once until recovery', () => withTemp((dir) => withClock(async (clock) => {
    const { manager, session, events } = fixture(dir, { '/file.txt': { content: 'original' } });
    let attempts = 0;
    session.sftp.fastPut = (_local, _remote, cb) => cb(++attempts === 4 ? null : new Error('Offline'));
    try {
      const local = await manager.edit('s', '/file.txt');
      const mtime = fs.statSync(local).mtimeMs;
      save(local, 'edit 1', mtime + 2000);
      await clock.tick(); // 1000: failure, retry at 2000
      await clock.tick(500);
      assert.strictEqual(attempts, 1);
      await clock.tick(500); // 2000: failure, retry at 4000
      await clock.tick();
      assert.strictEqual(attempts, 2);
      await clock.tick(); // 4000: failure, retry at 8000
      await clock.tick(3000);
      assert.strictEqual(attempts, 3);
      await clock.tick(); // 8000: recovered
      assert.strictEqual(attempts, 4);
      assert.strictEqual(events.filter(([kind]) => kind === 'sftp:edit-error').length, 1);
      assert.strictEqual(events.filter(([kind]) => kind === 'sftp:edited').length, 1);
      save(local, 'edit 2', mtime + 4000);
      await clock.tick();
      assert.strictEqual(attempts, 5);
      assert.strictEqual(events.filter(([kind]) => kind === 'sftp:edit-error').length, 2);
    } finally { manager.close('s'); }
  })));

  await test('sftp: save during upload is uploaded afterward without overlapping transfers', () => withTemp((dir) => withClock(async (clock) => {
    const { manager, session, events } = fixture(dir, { '/file.txt': { content: 'original' } });
    let attempts = 0;
    let finishFirst;
    session.sftp.fastPut = (_local, _remote, cb) => {
      if (++attempts === 1) finishFirst = cb;
      else cb(null);
    };
    try {
      const local = await manager.edit('s', '/file.txt');
      const mtime = fs.statSync(local).mtimeMs;
      save(local, 'edit 1', mtime + 2000);
      const firstTick = clock.tick();
      while (!finishFirst) await new Promise((resolve) => setImmediate(resolve));
      save(local, 'edit 2', mtime + 4000);
      await clock.tick();
      assert.strictEqual(attempts, 1);
      finishFirst(null);
      await firstTick;
      await clock.tick();
      assert.strictEqual(attempts, 2);
      assert.strictEqual(events.filter(([kind]) => kind === 'sftp:edited').length, 2);
    } finally { manager.close('s'); }
  })));
}

module.exports = { runSftpRegressionTests };

if (require.main === module) {
  let failed = 0;
  runSftpRegressionTests(async (name, fn) => {
    try {
      await fn();
      console.log('ok ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL ' + name + '\n' + error.stack);
    }
  }).then(() => { process.exitCode = failed ? 1 : 0; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
