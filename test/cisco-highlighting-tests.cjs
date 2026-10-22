'use strict';

const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { Terminal } = require('@xterm/xterm');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 2500;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + description); await pause(5); }
}
const write = (term, text) => new Promise(resolve => term.write(text, resolve));
function observe(term) {
  const records = [];
  const original = term.registerDecoration.bind(term);
  term.registerDecoration = options => {
    const decoration = original(options);
    if (decoration) records.push({ options, decoration });
    return decoration;
  };
  return { records, active: () => records.filter(item => !item.decoration.isDisposed && !item.options.marker.isDisposed) };
}
function highlightedText(term, observation) {
  return observation.active().sort((a, b) => a.options.marker.line - b.options.marker.line || a.options.x - b.options.x)
    .map(({ options: o }) => term.buffer.normal.getLine(o.marker.line).translateToString(false, o.x, o.x + o.width)).join('');
}
function snapshot(term) {
  const b = term.buffer.active;
  return { type: b.type, x: b.cursorX, y: b.cursorY, baseY: b.baseY, viewportY: b.viewportY,
    lines: Array.from({ length: b.length }, (_, y) => {
      const line = b.getLine(y);
      return { wrapped: line.isWrapped, text: line.translateToString(false), cells: Array.from({ length: Math.min(line.length, term.cols) }, (_, x) => {
        const c = line.getCell(x);
        return [c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isInverse(), c.isInvisible()];
      }) };
    }) };
}

async function runCiscoHighlightingTests(test) {
  const { findCiscoHighlights, CiscoOutputHighlighter } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/js/cisco-highlighting.mjs')).href);
  const parsed = text => findCiscoHighlights(text).map(span => [text.slice(span.start, span.end), span.kind]);

  await test('Cisco highlighting parser: interface headers, brief/status columns and state-change syslog are contextual', () => {
    assert.deepEqual(parsed('GigabitEthernet0/1 is up, line protocol is down (notconnect)'), [['up', 'up'], ['down', 'down']]);
    assert.deepEqual(parsed('Vlan10 is administratively down, line protocol is down'), [['administratively down', 'down'], ['down', 'down']]);
    assert.deepEqual(parsed('Gi0/1 192.0.2.1 YES NVRAM administratively down down'), [['192.0.2.1', 'ip'], ['administratively down', 'down'], ['down', 'down']]);
    assert.deepEqual(parsed('Gi1/0/1 backup uplink connected 10 a-full a-1000 10/100/1000BaseTX'), [['connected', 'up']]);
    for (const state of ['notconnect', 'err-disabled', 'disabled', 'inactive', 'suspended']) {
      assert.deepEqual(parsed(`Gi1/0/2 upstream ${state} trunk auto auto 10/100/1000BaseTX`), [[state, 'down']]);
    }
    assert.deepEqual(parsed('*Oct 20 00:00:01: %LINK-5-CHANGED: Interface Gi0/1, changed state to administratively down'), [['administratively down', 'down']]);
    assert.deepEqual(parsed('%LINEPROTO-5-UPDOWN: Line protocol on Interface Gi0/1, changed state to up'), [['up', 'up']]);
    assert.deepEqual(parsed('backup startup upstream uptime is 10 days\n0 input errors, 0 CRC, 0 frame\n0 output errors, 0 collisions\nDescription: backup is up'), []);
  });

  await test('Cisco highlighting parser: diagnostics and severe syslog override inner states; zero counters stay neutral', () => {
    for (const line of ['% Invalid input detected at caret marker.', '% Ambiguous command: show i', '% Incomplete command.', 'ERROR: Cannot configure interface']) {
      assert.deepEqual(parsed(line), [[line, 'error']]);
    }
    for (let severity = 0; severity <= 7; severity++) {
      const message = `%PM-SP-${severity}-ERR_RECOVER: failure on 192.0.2.1`;
      const result = parsed('*Oct 20 09:00:00: ' + message);
      assert.deepEqual(result, severity <= 4 ? [[message, severity <= 3 ? 'error' : 'warning']] : [['192.0.2.1', 'ip']]);
    }
    assert.deepEqual(parsed('%LINK-3-UPDOWN: Interface Gi0/1, changed state to up'), [['%LINK-3-UPDOWN: Interface Gi0/1, changed state to up', 'error']]);
    assert.deepEqual(parsed('  5 input errors, 0 CRC, 0 frame\n  12 output errors, 0 collisions'), [['5 input errors', 'error'], ['12 output errors', 'error']]);
    assert.deepEqual(parsed('0 input errors, 0 output errors, 105 packets input'), []);
  });

  await test('Cisco highlighting parser: whole-token IPv4/IPv6 validation excludes malformed suffixes and version contexts', () => {
    const valid = ['0.0.0.0', '255.255.255.255', '192.0.2.1/24', '::', '::1', '2001:db8::1', '2001:db8:0:1:2:3:4:5', '::ffff:192.0.2.1', 'fe80::1%eth0', '2001:db8::/32'];
    for (const address of valid) assert.deepEqual(parsed(`next hop [${address}],`), [[address, 'ip']]);
    assert.deepEqual(parsed('Peer 192.0.2.1:22 and 198.51.100.2.'), [['192.0.2.1', 'ip'], ['198.51.100.2', 'ip']]);
    for (const address of ['999.192.0.2.1', '256.0.0.1', '192.0.2.1.2', '192.0.2.1hostname', 'host192.0.2.1', 'host-192.0.2.1', '.192.0.2.1', '01.2.3.4',
      '2001:db8::g', '1::2::3', '1:2:3:4:5:6:7:8:9', ':1:2:3:4:5:6:7', '::ffff:999.1.2.3', 'fe80::1%%eth0', '192.0.2.1/33', '2001:db8::1/129', '2001:db8::1/64suffix',
      'Cisco IOS XE Software, Version 17.9.4.1', 'Release: 12.2.3.4', '09:12:33', '00:11:22:33:44:55']) assert.deepEqual(parsed(address), [], address);
    assert.deepEqual(parsed('界🙂e\u0301 192.0.2.1'), [['192.0.2.1', 'ip']], 'spans use original UTF-16 offsets');
  });

  await test('Cisco highlighting controller: real xterm chunks, wraps, Unicode widths and cursor overwrites preserve cells', async () => {
    const term = new Terminal({ cols: 16, rows: 12, scrollback: 100, allowProposedApi: true });
    const observed = observe(term), controller = new CiscoOutputHighlighter(term);
    try {
      await write(term, 'GigabitEthernet0/1 is administratively do');
      await pause(35); assert.equal(observed.active().length, 0, 'partial state must not be guessed');
      await write(term, 'wn, line protocol is down\r\n界🙂e\u0301 192.0.2.1');
      const before = snapshot(term);
      await until(() => highlightedText(term, observed) === 'administratively downdown192.0.2.1', 'wrapped state and Unicode/IP coordinates');
      assert.deepEqual(snapshot(term), before, 'decorations must not mutate bytes, attributes, wrapping or cursor');
      for (const { options } of observed.active()) { assert.equal(options.layer, 'bottom'); assert.equal(options.backgroundColor, undefined); }
      controller.setEnabled(false); assert.equal(observed.active().length, 0); assert.deepEqual(snapshot(term), before);
      await write(term, '\r\nGi0/1 is up'); controller.setEnabled(true);
      await until(() => highlightedText(term, observed).endsWith('up'), 'new up state');
      await write(term, '\rGi0/1 is down\x1b[K');
      await until(() => highlightedText(term, observed).endsWith('down') && !highlightedText(term, observed).endsWith('up'), 'cursor overwrite updates state');
    } finally { controller.dispose(); term.dispose(); }
  });

  await test('Cisco highlighting controller: remote ANSI fg/bg/inverse/invisible take precedence and light palettes replace dark', async () => {
    const term = new Terminal({ cols: 160, rows: 5, allowProposedApi: true });
    const observed = observe(term), controller = new CiscoOutputHighlighter(term, { background: '#07120c' });
    try {
      await write(term, '\x1b[31m192.0.2.1\x1b[0m \x1b[44m192.0.2.2\x1b[0m \x1b[7m192.0.2.3\x1b[0m \x1b[8m192.0.2.4\x1b[0m 198.51.100.2');
      const before = snapshot(term);
      await until(() => highlightedText(term, observed) === '198.51.100.2', 'only unstyled IP decorated');
      assert.equal(observed.active()[0].options.foregroundColor, '#67b7ff');
      controller.setBackground('#ffffff');
      await until(() => observed.active()[0]?.options.foregroundColor === '#175caa', 'light background IP palette');
      assert.deepEqual(snapshot(term), before);
      await write(term, '\r\nGi0/1 is up, line protocol is down');
      await until(() => observed.active().some(item => item.options.foregroundColor === '#116b35') && observed.active().some(item => item.options.foregroundColor === '#b42318'), 'independent green and red state palette');
    } finally { controller.dispose(); term.dispose(); }
  });

  await test('Cisco highlighting controller: viewport-only markers survive scroll/resize, alternate screen and repeated refresh ownership', async () => {
    const term = new Terminal({ cols: 40, rows: 8, scrollback: 3000, allowProposedApi: true });
    await write(term, ('Gi0/1 is up, line protocol is down\r\n').repeat(2000));
    const foreign = term.registerMarker(0), observed = observe(term);
    const buffer = term.buffer.normal, originalGetLine = buffer.getLine.bind(buffer); let reads = 0;
    buffer.getLine = y => { reads++; return originalGetLine(y); };
    const controller = new CiscoOutputHighlighter(term);
    try {
      await until(() => observed.active().length > 0, 'initial visible highlights');
      assert.ok(reads < 100, 'must not scan the 2000-line scrollback');
      const created = observed.records.length;
      for (let i = 0; i < 20; i++) controller.refresh();
      await pause(40); assert.equal(observed.records.length, created, 'unchanged decorations should be reused');
      term.scrollToTop();
      await until(() => observed.active().every(item => item.options.marker.line < 8), 'scroll switches ownership to top viewport');
      term.resize(20, 8);
      await until(() => observed.active().every(item => item.options.x + item.options.width <= 20), 'resize recomputes wrapped coordinates');
      await write(term, '\x1b[?1049h192.0.2.1');
      await until(() => observed.active().length === 0, 'alternate screen has no highlights');
      assert.equal(term.buffer.active.type, 'alternate');
      await write(term, '\x1b[?1049l');
      await until(() => observed.active().length > 0, 'normal buffer highlights return');
      controller.dispose(); assert.equal(observed.active().length, 0); assert.equal(foreign.isDisposed, false, 'foreign marker ownership is preserved');
      const finalCount = observed.records.length;
      await write(term, '\r\nGi0/2 is down'); controller.refresh(); controller.setEnabled(true);
      await pause(40); assert.equal(observed.records.length, finalCount, 'disposed controller cannot create resources');
    } finally { controller.dispose(); foreign.dispose(); term.dispose(); }
  });

  await test('Cisco highlighting controller: oversized logical records and combining-cell expansion are skipped safely', async () => {
    const term = new Terminal({ cols: 80, rows: 40, scrollback: 100, allowProposedApi: true });
    const observed = observe(term), controller = new CiscoOutputHighlighter(term);
    try {
      await write(term, '192.0.2.1 ' + 'x'.repeat(80 * 35));
      await pause(40); assert.equal(observed.active().length, 0, 'incomplete huge wrap chain is not parsed as a fragment');
      await write(term, '\r\nA' + '\u0301'.repeat(17000) + ' 192.0.2.2');
      await pause(40); assert.equal(observed.active().length, 0, 'one expanded cell cannot bypass logical text bounds');
      controller.refresh(); controller.dispose();
      await pause(35); assert.equal(observed.active().length, 0);
    } finally { controller.dispose(); term.dispose(); }
  });
}

module.exports = { runCiscoHighlightingTests };
if (require.main === module) runCiscoHighlightingTests(async (name, run) => { await run(); console.log('PASS ' + name); })
  .catch(error => { console.error(error); process.exitCode = 1; });
