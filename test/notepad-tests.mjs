// Notepad tests: text utilities (pure) and the main-process file / search / session layer.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as T from '../src/renderer/js/notepad/textops.mjs';

const require = createRequire(import.meta.url);

const IOS = `Building configuration...
!
hostname core-sw1
enable secret 9 $9$abcdefghijk$1234567890
username admin privilege 15 secret 0 Sup3rSecret!
!
interface GigabitEthernet1/0/1
 description Uplink
 switchport mode trunk
!
snmp-server community public RO
tacacs-server host 10.1.1.5 key 7 0822455D0A16
line vty 0 4
 password 7 094F471A1A0A
!
end
`;

export async function runNotepadTests(test) {
  console.log('notepad: text utilities');
  await test('encoding detection and round trips (UTF-8, BOM, UTF-16, ANSI)', () => {
    const text = 'Grüße – café ™ “quotes” 10.0.0.1';
    for (const enc of ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be']) {
      const bytes = T.encodeText(text, enc);
      const back = T.decodeBytes(bytes);
      assert.strictEqual(back.text, text, enc);
      assert.strictEqual(back.encoding, enc);
    }
    const ansi = T.encodeText(text, 'windows-1252');
    assert.strictEqual(ansi.lossy, 0);
    assert.deepStrictEqual(Array.from(ansi.subarray(0, 3)), [0x47, 0x72, 0xfc]);
    assert.strictEqual(ansi[6], 0x96); // en dash in CP1252
    const dec = T.decodeBytes(ansi);
    assert.strictEqual(dec.encoding, 'windows-1252');
    assert.strictEqual(dec.text, text);
    assert.strictEqual(T.encodeText('emoji 🙂', 'windows-1252').lossy, 1);
    assert.strictEqual(T.decodeBytes(Uint8Array.of(0x4d, 0x5a, 0, 0, 3)).binary, true);
  });
  await test('line ending detection and conversion', () => {
    assert.strictEqual(T.detectEol('a\r\nb\r\nc\n'), 'CRLF');
    assert.strictEqual(T.detectEol('a\nb\nc'), 'LF');
    assert.strictEqual(T.detectEol('a\rb\rc'), 'CR');
    assert.strictEqual(T.detectEol('single line', 'LF'), 'LF');
    assert.strictEqual(T.convertEol('a\r\nb\rc\n', 'CRLF'), 'a\r\nb\r\nc\r\n');
  });
  await test('line operations', () => {
    assert.strictEqual(T.sortLines('b\nA\nc\nitem10\nitem9'), 'A\nb\nc\nitem9\nitem10');
    assert.strictEqual(T.sortLines('b\na\nc', { desc: true }), 'c\nb\na');
    assert.strictEqual(T.sortIpLines('host 10.0.0.10\nhost 10.0.0.9\nhost 9.9.9.9'), 'host 9.9.9.9\nhost 10.0.0.9\nhost 10.0.0.10');
    assert.strictEqual(T.uniqueLines('x\ny\nx\nz\ny'), 'x\ny\nz');
    assert.strictEqual(T.removeEmptyLines('a\n\n  \nb'), 'a\nb');
    assert.strictEqual(T.trimTrailing('a  \nb\t'), 'a\nb');
    assert.strictEqual(T.joinLines(' a\n b \n\nc'), 'a b c');
    assert.strictEqual(T.tabsToSpaces('\tx\ta', 4), '    x   a');
    assert.strictEqual(T.spacesToTabs('      x', 4), '\t  x');
    assert.strictEqual(T.toTitle('show ip INTERFACE brief'), 'Show Ip Interface Brief');
    assert.strictEqual(T.toSentence('hello world. second one'), 'Hello world. Second one');
    assert.strictEqual(T.invertCase('AbC'), 'aBc');
  });
  await test('formatters and encoders', () => {
    assert.strictEqual(T.jsonFormat('{"a":1,"b":[1,2]}'), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    assert.strictEqual(T.jsonMinify('{ "a" : 1 }'), '{"a":1}');
    assert.throws(() => T.jsonFormat('{bad'), SyntaxError);
    assert.strictEqual(T.xmlFormat('<a><b>1</b><c/></a>'), '<a>\n  <b>1</b>\n  <c/>\n</a>');
    assert.strictEqual(T.base64Encode('admin:Pässword'), 'YWRtaW46UMOkc3N3b3Jk');
    assert.strictEqual(T.base64Decode('YWRtaW46UMOkc3N3b3Jk'), 'admin:Pässword');
    assert.throws(() => T.base64Decode('***'), /Base64/);
    assert.strictEqual(T.urlDecode(T.urlEncode('a b&c=ü')), 'a b&c=ü');
    assert.strictEqual(T.hexEncode('AB'), '41 42');
    assert.strictEqual(T.hexDecode('0x41:42'), 'AB');
  });
  await test('IP / MAC extraction and config sanitizing', () => {
    assert.deepStrictEqual(T.extractIPv4('a 10.0.0.10 b 10.0.0.9 c 999.1.1.1 d 10.0.0.9'), ['10.0.0.9', '10.0.0.10']);
    assert.deepStrictEqual(T.extractMacs('00:1B:54:aa:bb:cc and 001b.54aa.bbcc'), ['00:1b:54:aa:bb:cc', '001b.54aa.bbcc']);
    const r = T.sanitizeConfig(IOS);
    assert.strictEqual(r.count, 5);
    assert.ok(!/Sup3rSecret|\$9\$|public|0822455D0A16|094F471A1A0A/.test(r.text), r.text);
    assert.match(r.text, /^enable secret 9 <removed>$/m);
    assert.match(r.text, /^username admin privilege 15 secret 0 <removed>$/m);
    assert.match(r.text, /^snmp-server community <removed> RO$/m);
    assert.match(r.text, /^ description Uplink$/m); // untouched
  });
  await test('language detection', () => {
    assert.strictEqual(T.detectLanguage('core-sw1.txt', IOS), 'ios');
    assert.strictEqual(T.detectLanguage('router.cfg', 'hostname r1\ninterface Gi0/0\n ip address 10.0.0.1 255.255.255.0\n!\n'), 'ios');
    assert.strictEqual(T.detectLanguage('data.txt', '{"a": [1, 2]}'), 'json');
    assert.strictEqual(T.detectLanguage('x.yaml', 'a: 1'), 'yaml');
    assert.strictEqual(T.detectLanguage('syslog.txt', 'Oct 18 10:00:01 sw1 %LINK-3-UPDOWN: Interface Gi1/0/1, changed state to down\nOct 18 10:00:02 sw1 %LINEPROTO-5-UPDOWN: up\nOct 18 10:00:03 sw1 %SYS-5-CONFIG_I: Configured\n'), 'log');
    assert.strictEqual(T.detectLanguage('notes.txt', 'just some notes'), 'plaintext');
    assert.strictEqual(T.detectLanguage('script.ps1', ''), 'powershell');
    assert.strictEqual(T.detectLanguage('page', '<!DOCTYPE html><html></html>'), 'html');
  });

  console.log('notepad: files, search and session');
  const np = require('../src/main/notepad.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'konx-np-'));
  await test('atomic write, read, and size limit', () => {
    const f = path.join(tmp, 'sub', 'a.cfg');
    const r = np.writeFile(f, Buffer.from('hostname a\n'));
    assert.ok(r.mtime > 0);
    assert.strictEqual(np.readFile(f).bytes.toString(), 'hostname a\n');
    assert.ok(!fs.readdirSync(path.dirname(f)).some((x) => x.endsWith('.tmp')));
    assert.throws(() => np.readFile(tmp), /folder/);
  });
  await test('session and unsaved-document backups', () => {
    const st = new np.NotepadStore(path.join(tmp, 'user'));
    st.writeBackup('d1', 'unsaved work');
    st.writeBackup('d2', 'stale');
    st.setSession({ active: 'd1', docs: [{ id: 'd1', title: 'new 1', untitled: true, dirty: true }] });
    assert.strictEqual(st.readBackup('d1'), 'unsaved work');
    assert.strictEqual(st.readBackup('d2'), null); // pruned: no document refers to it
    assert.strictEqual(st.getSession().docs[0].title, 'new 1');
    assert.throws(() => st.writeBackup('../evil', 'x'), /Bad document id/);
  });
  await test('Find in Files: literal, regex, filters, binaries skipped, stop', async () => {
    const d = path.join(tmp, 'configs');
    fs.mkdirSync(path.join(d, 'site-b'), { recursive: true });
    fs.mkdirSync(path.join(d, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(d, 'sw1.cfg'), 'hostname sw1\ninterface Vlan10\n ip address 10.10.10.1 255.255.255.0\n');
    fs.writeFileSync(path.join(d, 'site-b', 'sw2.cfg'), 'hostname sw2\r\ninterface Vlan10\r\n ip address 10.20.10.1 255.255.255.0\r\n');
    fs.writeFileSync(path.join(d, 'notes.txt'), 'Vlan10 is the data VLAN\n');
    fs.writeFileSync(path.join(d, 'image.bin'), Buffer.from([0, 1, 2, ...Buffer.from('Vlan10')]));
    fs.writeFileSync(path.join(d, 'node_modules', 'x.cfg'), 'Vlan10');
    fs.writeFileSync(path.join(d, 'utf16.cfg'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('interface vlan10\r\n', 'utf16le')]));
    const run = async (opts) => {
      const hits = [];
      let summary;
      await np.findInFiles('j', { dir: d, ...opts }, (ch, _id, data) => (ch === 'np:found' ? hits.push(...data) : (summary = data)), { stopped: false });
      return { hits, summary };
    };
    let r = await run({ query: 'Vlan10', filters: '*.cfg' });
    assert.deepStrictEqual(r.hits.map((x) => path.relative(d, x.file)).sort(), ['site-b\\sw2.cfg', 'sw1.cfg', 'utf16.cfg'].map((p) => p.replace(/\\/g, path.sep)).sort());
    assert.strictEqual(r.hits.find((x) => x.file.endsWith('sw1.cfg')).line, 2);
    r = await run({ query: 'Vlan10', filters: '*.cfg', caseSensitive: true });
    assert.strictEqual(r.hits.length, 2);
    r = await run({ query: 'ip address 10\\.\\d+\\.10\\.1 ', regex: true, filters: '*' });
    assert.strictEqual(r.hits.length, 2);
    assert.strictEqual(r.hits[0].col, 2);
    r = await run({ query: 'Vlan10', filters: '*', recurse: false });
    assert.ok(!r.hits.some((x) => x.file.includes('site-b')));
    assert.ok(!r.hits.some((x) => x.file.endsWith('.bin')));
    assert.ok(r.summary.scanned >= 3);
    const stopped = { stopped: true };
    let s2;
    await np.findInFiles('k', { dir: d, query: 'x' }, (ch, _i, data) => ch === 'np:findDone' && (s2 = data), stopped);
    assert.strictEqual(s2.stopped, true);
    await assert.rejects(np.findInFiles('z', { dir: path.join(tmp, 'nope'), query: 'x' }, () => {}, { stopped: false }), /folder/);
  });
  await test('file and text hashing (MD5/SHA)', async () => {
    const f = path.join(tmp, 'fw.bin');
    fs.writeFileSync(f, 'abc');
    const r = await np.hashFile(f);
    assert.strictEqual(r.md5, '900150983cd24fb0d6963f7d28e17f72');
    assert.strictEqual(r.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(np.hashText('abc').sha1, 'a9993e364706816aba3e25717850c26c9cd0d89d');
  });
  await test('file watcher reports outside edits but not our own saves', async () => {
    const events = [];
    const w = new np.FileWatcher((ch, p, info) => events.push(info));
    const f = path.join(tmp, 'watched.txt');
    const r = np.writeFile(f, Buffer.from('one'));
    w.set([{ path: f, mtime: r.mtime }]);
    const r2 = np.writeFile(f, Buffer.from('two'));
    w.saved(f, r2.mtime);
    w.poll();
    await new Promise((res) => setTimeout(res, 150));
    assert.strictEqual(events.length, 0);
    await new Promise((res) => setTimeout(res, 50));
    fs.writeFileSync(f, 'changed elsewhere');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    w.poll();
    await new Promise((res) => setTimeout(res, 150));
    assert.strictEqual(events.length, 1);
    fs.rmSync(f);
    w.poll();
    await new Promise((res) => setTimeout(res, 150));
    assert.ok(events[1] && events[1].deleted);
    w.stop();
  });
}
