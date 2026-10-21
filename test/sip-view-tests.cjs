'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setViewport } = require('./lib/electron-viewport.cjs');

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + description);
    await pause();
  }
}

/** Runs in the existing real-application hidden Electron fixture. */
async function runSipViewChecks(win, run) {
  const evaluate = (fn, ...args) => run('(' + fn.toString() + ')(' + args.map((arg) => JSON.stringify(arg)).join(',') + ')');
  const click = (selector) => evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing SIP test control: ' + selector);
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, selector);
  const clickButton = (text) => evaluate((text) => {
    const button = [...document.querySelectorAll('.sip-workspace button')].find((element) => element.textContent === text);
    if (!button) throw new Error('Missing SIP button: ' + text);
    button.click();
  }, text);
  const painted = async () => {
    await evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const closeModal = () => evaluate(() => document.querySelector('.modal footer button').click());
  const fixtureUrl = pathToFileURL(path.join(__dirname, 'lib/sip-fixtures.mjs')).href;
  const viewUrl = pathToFileURL(path.join(__dirname, '../src/renderer/js/capture/sip-view.js')).href;
  const tempRoot = path.resolve(os.tmpdir());
  const exportRoot = fs.mkdtempSync(path.join(tempRoot, 'konx-sip-ui-'));
  const { dialog } = require('electron');
  const originalDialog = dialog.showSaveDialog;
  const dialogs = [];
  dialog.showSaveDialog = async (parent, options) => {
    assert.equal(parent, win, 'SIP export chooser must belong to the fixture window');
    const format = options.filters[0].extensions[0];
    assert.ok(format === 'pcapng' || format === 'json');
    dialogs.push({ format, title: options.title });
    return { canceled: false, filePath: path.join(exportRoot, 'call.' + format) };
  };
  try {
    await setViewport(win, run, 1400, 880);
    await evaluate(async (fixtureUrl) => {
      const { sipDemoCapture } = await import(fixtureUrl);
      window.__sipTestTab = window.__app.openTool('capture');
      await window.__sipTestTab.loadBytes(sipDemoCapture(), 'sip-ui-fixture.pcapng');
      window.__sipTestTab.setFilter('dns');
      window.__sipTestTab.sipButton.click();
    }, fixtureUrl);
    await until(() => run('document.querySelectorAll(".sip-call-row").length === 3'), 'SIP list from the actual capture toolbar');
    assert.equal(await run('window.__sipTestTab.sipButton.disabled'), true, 'one SIP dialog per capture');
    assert.equal(await run('document.querySelector(".sip-call-row.active .sip-call-id").textContent'), 'demo-call@konx.test');
    assert.equal(await run('document.querySelectorAll(".sip-message-arrow").length'), 14);
    assert.equal(await run('document.querySelectorAll(".sip-lane").length'), 3);
    assert.equal(await run('document.querySelectorAll(".sip-message-arrow.retransmission").length'), 1);
    assert.equal(await run('document.querySelectorAll(".sip-arrow-head").length'), 14, 'every retained message is a visible directional arrow');
    await setViewport(win, run, 900, 560);
    await painted();
    const bounds = await evaluate(() => {
      const rect = (element) => {
        const value = element.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom };
      };
      const modal = document.querySelector('.modal');
      return {
        width: innerWidth, height: innerHeight, body: rect(modal.querySelector('.body')),
        header: rect(modal.querySelector('header')), footer: rect(modal.querySelector('footer')),
        columns: rect(modal.querySelector('.sip-columns')), row: rect(modal.querySelector('.sip-call-row')),
        ladder: rect(modal.querySelector('.sip-ladder-scroll')),
      };
    });
    for (const region of ['header', 'footer']) {
      assert.ok(bounds[region].left >= 0 && bounds[region].right <= bounds.width + 1 &&
        bounds[region].top >= 0 && bounds[region].bottom <= bounds.height + 1,
      'SIP ' + region + ' must remain reachable at 900x560');
    }
    for (const region of ['columns', 'row', 'ladder']) {
      assert.ok(bounds[region].left >= bounds.body.left - 1 && bounds[region].right <= bounds.body.right + 1,
        'SIP ' + region + ' must stay inside the body; only the lane viewport scrolls horizontally');
    }
    await setViewport(win, run, 1400, 880);
    await painted();
    const previewPath = path.resolve(__dirname, '../user-data/sip-ui-preview.png');
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, (await win.webContents.capturePage()).toPNG());

    const arrowPoint = await evaluate(() => {
      const arrow = document.querySelector('.sip-message-arrow[data-message-index="6"] .sip-arrow-head');
      arrow.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = arrow.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    });
    await painted();
    win.webContents.sendInputEvent({ type: 'mouseMove', ...arrowPoint });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...arrowPoint });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...arrowPoint });
    await until(() => run('document.querySelector(".sip-message-arrow.selected").dataset.messageIndex === "6"'), 'native pointer selection of the SIP response arrow');
    assert.match(await run('document.querySelector(".sip-message-detail").textContent'), /SIP\/2\.0 200 OK/);
    assert.match(await run('document.querySelector(".sip-sdp").textContent'), /6000/);
    assert.match(await run('document.querySelector(".sip-codecs").textContent'), /PCMU/);
    assert.match(await run('document.querySelector(".sip-raw-detail pre").textContent'), /Content-Type: application\/sdp/);
    assert.equal(await run('document.querySelector(".sip-message-detail .traffic-frame").textContent'), '#7');

    await clickButton('Export call PCAPNG');
    await until(() => fs.existsSync(path.join(exportRoot, 'call.pcapng')) && run('!document.querySelector(".sip-actions button").disabled'), 'call PCAPNG save');
    await clickButton('Export JSON report');
    await until(() => fs.existsSync(path.join(exportRoot, 'call.json')) && run('!document.querySelector(".sip-actions button").disabled'), 'call JSON save');
    assert.deepEqual(dialogs.map((entry) => entry.format), ['pcapng', 'json'], 'both exports go through the native chooser boundary');
    const { readCapture } = await import('../src/renderer/js/capture/pcapfile.mjs');
    const saved = readCapture(fs.readFileSync(path.join(exportRoot, 'call.pcapng')));
    assert.equal(saved.packets.length, 14, 'capture export keeps this call and its retransmission');
    const report = JSON.parse(fs.readFileSync(path.join(exportRoot, 'call.json'), 'utf8'));
    assert.equal(report.call.callId, 'demo-call@konx.test');
    assert.equal(report.call.messages.length, 14);
    assert.equal(report.sourceName, 'sip-ui-fixture.pcapng');

    await evaluate(() => [...document.querySelectorAll('.sip-call-row')].find((row) => row.textContent.includes('tcp-call@konx.test')).click());
    assert.equal(await run('document.querySelectorAll(".sip-message-arrow").length'), 2);
    assert.match(await run('document.querySelector(".sip-sdp").textContent'), /8000/);
    const frame = await run('Number(document.querySelector(".sip-message-detail .traffic-frame").textContent.slice(1))');
    assert.ok(frame === 21 || frame === 22, 'TCP SIP body must link to an actual split-message frame');
    await click('.sip-message-detail .traffic-frame');
    await until(() => run('!document.querySelector(".sip-workspace") && !window.__sipTestTab.sipOpen'), 'source packet navigation');
    assert.equal(await run('window.__sipTestTab.packets[window.__sipTestTab.selected].no'), frame);
    assert.equal(await run('window.__sipTestTab.dfilter.value'), '', 'source navigation clears a filter hiding its packet');
    assert.equal(await run('window.__sipTestTab.autoScroll'), false, 'navigation holds the evidence packet in view');

    await evaluate(() => { window.__sipTestTab.clear(false); window.__sipTestTab.sipButton.click(); });
    await until(() => run('Boolean(document.querySelector(".sip-workspace"))'), 'empty SIP capture view');
    assert.match(await run('document.querySelector(".sip-workspace").textContent'), /No SIP calls were found/);
    assert.equal(await run('document.querySelectorAll(".sip-message-arrow").length'), 0);
    await closeModal();
    await until(() => run('!window.__sipTestTab.sipOpen'), 'empty modal completion');

    // Larger UI input uses the same owner-shaped facts to exercise paging and
    // inert rendering without duplicating parser coverage.
    await evaluate(async (fixtureUrl, viewUrl) => {
      const { sipDemoCapture } = await import(fixtureUrl);
      const { showSipCalls } = await import(viewUrl);
      await window.__sipTestTab.loadBytes(sipDemoCapture(), 'sip-ui-fixture.pcapng');
      const { analyzeSipCalls } = await import('./js/capture/sip.mjs');
      const source = analyzeSipCalls(window.__sipTestTab.packets);
      const attack = '<img src=x onerror="window.__sipInjected=true">';
      const base = source.calls[0];
      const first = base.messages[0];
      const messages = Array.from({ length: 52 }, (_, index) => ({
        ...first, id: 'ui-message-' + index, src: '192.0.2.1:5060', dst: '192.0.2.' + (index % 10 + 10) + ':5060',
        frames: [100 + index], ts: base.startTime + index, rawText: attack + '\r\n' + first.rawText,
        complete: index !== 7, retransmission: index === 1,
        warnings: index === 7 ? ['Capture ended before this message was complete.'] : [],
      }));
      const large = { ...base, id: 'ui-call-0', messages, frames: messages.flatMap((message) => message.frames), from: attack };
      const calls = Array.from({ length: 21 }, (_, index) => ({ ...large, id: 'ui-call-' + index, callId: index ? 'paged-call-' + index : null }));
      window.__sipLargeAnalysis = { calls, warnings: ['The capture snapshot omits packets.'], limited: true, scannedPackets: 52 };
      window.__sipViewResult = undefined;
      window.__sipViewDone = showSipCalls(window.__sipLargeAnalysis).then((result) => { window.__sipViewResult = result; });
    }, fixtureUrl, viewUrl);
    assert.equal(await run('document.querySelectorAll(".sip-call-row").length'), 20);
    assert.equal(await run('document.querySelectorAll(".sip-message-arrow").length'), 50);
    assert.equal(await run('document.querySelectorAll(".sip-lane").length'), 8);
    assert.match(await run('document.querySelector(".sip-call-row.active").textContent'), /Unknown Call-ID/);
    assert.match(await run('document.querySelector(".sip-workspace").textContent'), /Analysis limits were reached/);
    assert.equal(await run('document.querySelectorAll(".sip-workspace img").length'), 0);
    assert.equal(await run('window.__sipInjected === undefined'), true);
    assert.match(await run('document.querySelector(".sip-raw-detail pre").textContent'), /<img src=x/);
    assert.match(await run('document.querySelector(".sip-message-arrow[data-message-index=\\"7\\"]").textContent'), /select to reveal lanes/);
    await click('.sip-message-arrow[data-message-index="7"]');
    assert.equal(await run('document.querySelectorAll(".sip-lane").length'), 8);
    assert.match(await run('document.querySelector(".sip-message-arrow.selected").getAttribute("aria-label")'), /192\.0\.2\.17:5060/);
    assert.equal(await run('document.querySelectorAll(".sip-message-arrow.selected .sip-arrow-head").length'), 1, 'selecting an off-page endpoint reveals its true lanes');
    assert.match(await run('document.querySelector(".sip-message-detail").textContent'), /Incomplete captured message/);
    assert.equal(await run('document.querySelector(".sip-message-detail .traffic-frame").textContent'), '#107');
    await click('[aria-label="Next messages"]');
    assert.equal(await run('document.querySelectorAll(".sip-message-arrow").length'), 2);
    assert.equal(await run('document.querySelector(".sip-message-detail .traffic-frame").textContent'), '#150');
    await click('[aria-label="Next calls"]');
    assert.equal(await run('document.querySelectorAll(".sip-call-row").length'), 1);
    assert.match(await run('document.querySelector(".sip-call-row.active").textContent'), /paged-call-20/);
    await evaluate(() => {
      const search = document.querySelector('[aria-label="Search SIP calls"]');
      search.value = 'paged-call-12';
      search.dispatchEvent(new Event('input'));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.equal(await run('document.querySelectorAll(".sip-call-row").length'), 1);
    assert.match(await run('document.querySelector(".sip-call-row.active").textContent'), /paged-call-12/);
    assert.equal(await run('Boolean(document.querySelector(".sip-workspace"))'), true, 'search Enter must not close the modal');
    await click('.sip-message-detail .traffic-frame');
    assert.deepEqual(await run('window.__sipViewDone.then(() => window.__sipViewResult)'), { action: 'packet', frame: 100 });
    console.log('SIP_UI_PASS: real capture list/ladder, SDP, native exports, packet navigation, empty state, paging, and inert text');
  } finally {
    dialog.showSaveDialog = originalDialog;
    await evaluate(async () => {
      document.querySelector('.modal footer button')?.click();
      if (window.__sipTestTab) await window.__app.closeTab(window.__sipTestTab);
    }).catch(() => {});
    assert.equal(path.dirname(path.resolve(exportRoot)), tempRoot);
    assert.ok(path.basename(exportRoot).startsWith('konx-sip-ui-'));
    fs.rmSync(exportRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { runSipViewChecks };
