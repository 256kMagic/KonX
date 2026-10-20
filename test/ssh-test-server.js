'use strict';
// Local SSH + SFTP server for testing and demos. Accepts user "test" / password "test".
// The shell imitates a network switch CLI; SFTP serves a temp folder as "/".
//   node test/ssh-test-server.js [port]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils } = require('ssh2');

const { STATUS_CODE, flagsToString } = utils.sftp;

function startServer({ port = 2222, root, user = 'test', password = 'test', hostname = 'lab-sw1' } = {}) {
  root = root || fs.mkdtempSync(path.join(os.tmpdir(), 'tl-sftp-'));
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === password) return ctx.accept();
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          if (ctx.username === user && answers[0] === password) ctx.accept();
          else ctx.reject();
        });
      }
      ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let cols = 80;
        session.on('pty', (acc, rej, info) => {
          cols = info.cols;
          acc && acc();
        });
        session.on('window-change', (acc, rej, info) => {
          cols = info.cols;
          acc && acc();
        });
        session.on('shell', (acc) => fakeShell(acc(), hostname, () => cols));
        session.on('sftp', (acc) => sftpHandler(acc(), root));
      });
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, root, port: server.address().port })));
}

const COMMANDS = {
  'show version': (h) => `KonX Test Switch Software, Version 17.9.4a
Copyright (c) 2026 Example Networks.

ROM: Bootstrap program is 17.9.1r
${h} uptime is 42 days, 7 hours, 13 minutes
System image file is "flash:packages.conf"

Model Number                   : TL-9300-48P
System Serial Number           : FOC2626X0AB
Base Ethernet MAC Address      : 00:1b:54:aa:bb:cc

Switch Ports Model              SW Version        SW Image
------ ----- -----              ----------        ----------
*    1 62    TL-9300-48P        17.9.4a           CAT9K_IOSXE`,
  'show ip interface brief': () => `Interface              IP-Address      OK? Method Status                Protocol
Vlan1                  unassigned      YES NVRAM  administratively down down
Vlan10                 10.10.10.1      YES NVRAM  up                    up
Vlan20                 10.10.20.1      YES NVRAM  up                    up
GigabitEthernet1/0/1   unassigned      YES unset  up                    up
GigabitEthernet1/0/2   unassigned      YES unset  down                  down
TenGigabitEthernet1/1/1 192.0.2.2      YES NVRAM  up                    up`,
  'terminal length 0': () => '',
  uptime: () => ' 13:37:00 up 42 days,  7:13,  1 user,  load average: 0.08, 0.03, 0.01',
};

function fakeShell(stream, hostname, getCols) {
  let line = '';
  const prompt = () => stream.write(`\r\n${hostname}#`);
  stream.write(`\r\n\x1b[1mWelcome to ${hostname}\x1b[0m — KonX test server\r\nType "show version", "show ip interface brief" or "exit".\r\n`);
  prompt();
  stream.on('data', (d) => {
    for (const ch of d.toString('utf8')) {
      if (ch === '\r' || ch === '\n') {
        const cmd = line.trim();
        line = '';
        if (cmd === 'exit' || cmd === 'logout') {
          stream.write('\r\n');
          stream.exit(0);
          stream.end();
          return;
        }
        const fn = COMMANDS[cmd];
        if (fn) {
          const out = fn(hostname);
          if (out) stream.write('\r\n' + out.replace(/\n/g, '\r\n'));
        } else if (cmd === 'cols') {
          stream.write(`\r\n${getCols()}`);
        } else if (cmd) {
          stream.write(`\r\n% Invalid input detected at '^' marker.`);
        }
        prompt();
      } else if (ch === '\x7f' || ch === '\b') {
        if (line) {
          line = line.slice(0, -1);
          stream.write('\b \b');
        }
      } else if (ch >= ' ') {
        line += ch;
        stream.write(ch);
      }
    }
  });
}

function sftpHandler(sftp, root) {
  const handles = new Map();
  let next = 0;
  const real = (p) => path.join(root, path.posix.normalize('/' + p));
  const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
  const newHandle = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(++next);
    handles.set(next, v);
    return b;
  };
  const get = (b) => handles.get(b.readUInt32BE(0));
  const fail = (id, e) => sftp.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : e && e.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE, e ? e.message : '');
  const tryOp = (id, fn) => {
    try {
      fn();
    } catch (e) {
      fail(id, e);
    }
  };

  sftp.on('REALPATH', (id, p) => {
    const norm = path.posix.normalize('/' + (p === '.' ? '' : p));
    sftp.name(id, [{ filename: norm, longname: norm, attrs: {} }]);
  });
  const stat = (id, p) => tryOp(id, () => sftp.attrs(id, attrsOf(fs.statSync(real(p)))));
  sftp.on('STAT', stat);
  sftp.on('LSTAT', stat);
  sftp.on('FSTAT', (id, h) => tryOp(id, () => sftp.attrs(id, attrsOf(fs.fstatSync(get(h).fd)))));
  sftp.on('OPENDIR', (id, p) => tryOp(id, () => {
    if (!fs.statSync(real(p)).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
    sftp.handle(id, newHandle({ dir: real(p), done: false }));
  }));
  sftp.on('READDIR', (id, h) => {
    const d = get(h);
    if (!d || d.done) return sftp.status(id, STATUS_CODE.EOF);
    d.done = true;
    const names = fs.readdirSync(d.dir).map((n) => {
      const st = fs.statSync(path.join(d.dir, n));
      const perms = (st.isDirectory() ? 'd' : '-') + 'rw-r--r--';
      return { filename: n, longname: `${perms}    1 test     test     ${st.size} Jan  1 00:00 ${n}`, attrs: attrsOf(st) };
    });
    sftp.name(id, names);
  });
  sftp.on('OPEN', (id, p, flags) => tryOp(id, () => sftp.handle(id, newHandle({ fd: fs.openSync(real(p), flagsToString(flags)) }))));
  sftp.on('READ', (id, h, offset, length) => tryOp(id, () => {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(get(h).fd, buf, 0, length, offset);
    if (n === 0) sftp.status(id, STATUS_CODE.EOF);
    else sftp.data(id, buf.subarray(0, n));
  }));
  sftp.on('WRITE', (id, h, offset, data) => tryOp(id, () => {
    fs.writeSync(get(h).fd, data, 0, data.length, offset);
    sftp.status(id, STATUS_CODE.OK);
  }));
  sftp.on('CLOSE', (id, h) => {
    const k = h.readUInt32BE(0);
    const v = handles.get(k);
    if (v && v.fd != null) fs.closeSync(v.fd);
    handles.delete(k);
    sftp.status(id, STATUS_CODE.OK);
  });
  const ok = (id, fn) => tryOp(id, () => {
    fn();
    sftp.status(id, STATUS_CODE.OK);
  });
  sftp.on('MKDIR', (id, p) => ok(id, () => fs.mkdirSync(real(p))));
  sftp.on('RMDIR', (id, p) => ok(id, () => fs.rmdirSync(real(p))));
  sftp.on('REMOVE', (id, p) => ok(id, () => fs.unlinkSync(real(p))));
  sftp.on('RENAME', (id, a, b) => ok(id, () => fs.renameSync(real(a), real(b))));
  const setstat = (target, attrs) => {
    if (attrs.mode != null) fs.chmodSync(target, attrs.mode);
    if (attrs.mtime != null) fs.utimesSync(target, attrs.atime || attrs.mtime, attrs.mtime);
  };
  sftp.on('SETSTAT', (id, p, attrs) => ok(id, () => setstat(real(p), attrs)));
  sftp.on('FSETSTAT', (id, h, attrs) => ok(id, () => {
    if (attrs.mtime != null) fs.futimesSync(get(h).fd, attrs.atime || attrs.mtime, attrs.mtime);
  }));
}

module.exports = { startServer };

if (require.main === module) {
  const port = Number(process.argv[2]) || 2222;
  startServer({ port }).then(({ root, port: p }) => {
    fs.writeFileSync(path.join(root, 'readme.txt'), 'Files in this folder are served over SFTP by the KonX test server.\n');
    fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'configs', 'core-sw1.cfg'), 'hostname core-sw1\n!\ninterface Vlan10\n ip address 10.10.10.1 255.255.255.0\n');
    console.log(`Test SSH/SFTP server on 127.0.0.1:${p} (user test / password test), SFTP root ${root}`);
  });
}
