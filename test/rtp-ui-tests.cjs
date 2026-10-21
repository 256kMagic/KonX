'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { setViewport } = require(path.join(repo, 'test/lib/electron-viewport.cjs'));
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; while (!(await check())) { if (Date.now() >= end) throw new Error('Timed out: ' + label); await pause(); } }

async function runRtpUiTests(test) {
  await test('RTP real Electron snapshot analysis, packet evidence, waveform, WAV, muted WebAudio playback and cleanup', async () => {
    const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'konx-rtp-ui-'));
    let child, output = '';
    try {
      child = spawn(require('electron'), [__filename, '--rtp-ui-fixture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KONX_USERDATA: path.join(root, 'profile'), KONX_RTP_UI_ROOT: root, KONX_CAPTURE: '', KONX_DEMO: '' } });
      const collect = (data) => { output = (output + data).slice(-1024 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('RTP UI fixture timed out\n' + output)); }, 60000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      assert.equal(code, 0, output); assert.match(output, /RTP_UI_PASS/);
    } finally {
      if (child && child.exitCode == null) child.kill();
      assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('konx-rtp-ui-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

async function fixture() {
  const { app, BrowserWindow, dialog } = require('electron');
  app.commandLine.appendSwitch('mute-audio');
  const root = path.resolve(process.env.KONX_RTP_UI_ROOT || '');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('konx-rtp-ui-'));
  const exports = []; let finished = false;
  dialog.showSaveDialog = async () => { const filePath = path.join(root, 'stream-' + exports.length + '.wav'); exports.push(filePath); return { canceled: false, filePath }; };
  dialog.showOpenDialog = async () => { throw new Error('Fixture must use its synthetic sample'); };
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const finish = (code, error) => { if (finished) return; finished = true; if (error) console.error(error.stack || error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code); };
  app.on('browser-window-created', (_event, win) => {
    win.setOpacity(0); win.setFocusable(false); win.setSkipTaskbar(true);
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('Renderer:', message); });
    win.webContents.once('did-finish-load', async () => {
      const run = (code) => win.webContents.executeJavaScript(code);
      const button = (label) => `[...document.querySelectorAll('.rtp-workspace button')].find(x=>x.textContent===${JSON.stringify(label)})`;
      const click = async (expression) => {
        let point;
        await until(async () => {
          point = await run(`(() => {const el=${expression};if(!el)return {ready:false};el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,ready:!el.disabled&&r.width>0&&r.height>0&&(hit===el||el.contains(hit)),debug:{rect:[r.left,r.top,r.width,r.height],hit:hit?.tagName,hitClass:hit?.className}};})()`);
          return point.ready;
        }, 'clickable ' + expression).catch((error) => { throw new Error(error.message + ' ' + JSON.stringify(point)); });
        delete point.ready; delete point.debug;
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(30);
      };
      try {
        await until(() => run('Boolean(window.__app)'), 'app');
        await run(`(async()=>{
          const link=document.createElement('link');link.rel='stylesheet';link.href=${JSON.stringify(pathToFileURL(path.join(repo, 'src/renderer/rtp.css')).href)};document.head.append(link);
          const {makeRtpDemo}=await import(${JSON.stringify(pathToFileURL(path.join(repo, 'src/renderer/js/capture/sample-rtp.mjs')).href)});
          const {analyzeSipCalls}=await import('./js/capture/sip.mjs');
          window.__rtpModule=await import(${JSON.stringify(pathToFileURL(path.join(repo, 'src/renderer/js/capture/rtp-view.js')).href)});
          window.__cap=window.__app.openTool('capture');const demo=makeRtpDemo();await window.__cap.loadBytes(demo.bytes,demo.name);
          window.__packets=window.__cap.packets.slice();window.__calls=analyzeSipCalls(window.__packets).calls;
          window.__contexts=[];const Native=window.AudioContext;
          window.AudioContext=class extends Native {constructor(){super();this.__sources=[];window.__contexts.push(this);}createBufferSource(){const source=super.createBufferSource();this.__sources.push(source);return source;}};
          window.__openRtp=(options={})=>{window.__abort=new AbortController();window.__result=undefined;window.__done=window.__rtpModule.showRtpMedia(window.__packets,{sipCalls:window.__calls,onExportWav:(name,bytes)=>window.api.invoke('cap:saveBody',name,bytes),signal:window.__abort.signal,...options}).then(result=>{window.__result=result;});return true;};
          window.__openRtp();return true;
        })()`);
        assert.equal(await run('window.__packets.length'), 401);
        assert.equal(await run('document.querySelectorAll(".rtp-stream").length'), 2);
        assert.equal(await run('window.__contexts.length'), 0, 'Opening analysis must not create audio output');
        assert.match(await run('document.querySelector(".rtp-detail").textContent'), /Sequence gaps3/);
        assert.match(await run('document.querySelector(".rtp-rtcp").textContent'), /RTCP reports \(1\)/);
        await click(button('Build waveform'));
        assert.ok(await run('Boolean(document.querySelector(".rtp-wave"))'));
        assert.ok(await run('document.querySelectorAll(".rtp-silence").length>0'));
        assert.equal(await run('window.__contexts.length'), 0, 'Waveform preparation must remain silent');
        await click(button('Export WAV')); await until(() => exports.length && fs.existsSync(exports[0]), 'WAV export');
        const wav = fs.readFileSync(exports[0]); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
        assert.equal(wav.readUInt32LE(24), 8000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.length, 64044);
        assert.equal(await run('window.__contexts.length'), 0, 'WAV export must not play audio');
        await click(button('Play stream')); await until(() => run('window.__contexts.at(-1)?.state==="running"&&window.__contexts.at(-1).__sources.length===1'), 'real WebAudio stream');
        await click(button('Stop')); await until(() => run('window.__contexts.every(context=>context.state==="closed")'), 'stop closes audio context');
        await click(button('Play both directions')); await until(() => run('window.__contexts.at(-1)?.__sources.length===2'), 'two real sources');
        await run('window.__abort.abort();window.__done.then(()=>true)');
        assert.equal(await run('window.__result'), null); assert.equal(await run('window.__contexts.every(context=>context.state==="closed")'), true);
        assert.equal(await run('Boolean(document.querySelector(".rtp-workspace"))'), false, 'Owner abort closes modal');
        await run('window.__TrackedAudioContext=window.AudioContext;window.AudioContext=class extends window.__TrackedAudioContext{resume(){return new Promise(resolve=>window.__releaseResume=resolve);}};window.__openRtp();');
        await click(button('Play stream')); await until(() => run('Boolean(window.__releaseResume)'), 'pending audio resume');
        await run('window.__abort.abort();window.__done.then(()=>true)');
        assert.equal(await run('window.__contexts.at(-1).state'), 'closed', 'Abort closes context during pending resume');
        await run('window.__releaseResume();window.AudioContext=window.__TrackedAudioContext;true;'); await pause();
        assert.equal(await run('window.__contexts.at(-1).__sources.length'), 0, 'Late resume must never start audio after closing');
        await run('window.__openRtp()'); await click(button('Build waveform'));
        for (const [width, height] of [[1400, 880], [900, 560]]) {
          await setViewport(win, run, width, height); await run('document.querySelector(".rtp-detail").scrollTop=0;void 0;'); await pause(60);
          const geometry = await run('(()=>{const box=document.querySelector(".modal").getBoundingClientRect(),detail=document.querySelector(".rtp-detail").getBoundingClientRect();return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,box:{left:box.left,right:box.right,bottom:box.bottom},detailHeight:detail.height};})()');
          assert.ok(geometry.documentWidth<=geometry.width+2&&geometry.box.left>=-2&&geometry.box.right<=geometry.width+2&&geometry.box.bottom<=geometry.height+2&&geometry.detailHeight>=170, JSON.stringify(geometry));
          if (process.env.KONX_RTP_SCREENSHOTS === '1') {
            const target = path.join(repo, 'review/release-0.9.0'); fs.mkdirSync(target, { recursive: true });
            assert.ok(fs.realpathSync(target).startsWith(fs.realpathSync(path.join(repo, 'review')) + path.sep));
            fs.writeFileSync(path.join(target, `rtp-demo-${width}x${height}-${Date.now()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
            await run('document.querySelector(".rtp-audio").scrollIntoView({block:"start"});void 0;'); await pause(40);
            fs.writeFileSync(path.join(target, `rtp-wave-${width}x${height}-${Date.now()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: 'wx' });
          }
        }
        await click(`document.querySelector('input[aria-label="Show problem packets only"]')`);
        assert.equal(await run('document.querySelectorAll(".rtp-table tbody tr").length'), 2);
        const frame = await run('Number(document.querySelector(".rtp-table button").dataset.frame)');
        await click('document.querySelector(".rtp-table button")'); await run('window.__done.then(()=>true)');
        assert.deepEqual(await run('window.__result'), { action: 'packet', frame });
        assert.equal(await run(`window.__packets.some(packet=>packet.no===${frame})`), true);
        await run('window.__openRtp()'); await click('[...document.querySelectorAll(".rtp-actions button")].find(x=>x.textContent.startsWith("SIP ladder:"))'); await run('window.__done.then(()=>true)');
        assert.equal(await run('window.__result.callKey===window.__calls[0].id'), true);
        await run('window.__openRtp({sipCalls:[]})');
        assert.equal(await run('document.querySelectorAll(".rtp-stream").length'), 0);
        await click(`document.querySelector('input[aria-label="Find possible RTP without SDP"]')`);
        assert.equal(await run('document.querySelectorAll(".rtp-stream").length'), 2);
        assert.equal(await run(button('Play stream') + '.disabled'), true, 'Heuristic audio needs separate explicit interpretation consent');
        await click(`document.querySelector('input[aria-label="Accept heuristic RTP interpretation for audio"]')`); await click(button('Build waveform'));
        assert.equal(await run('Boolean(document.querySelector(".rtp-wave"))'), true);
        await run('window.__abort.abort();window.__done.then(()=>true)');
        await run(`(()=>{const calls=structuredClone(window.__calls);calls[0].callId='<img src=x onerror="window.__rtpInjected=true">';for(const call of calls)for(const message of call.messages)for(const media of message.sdp?.media||[])for(const codec of media.codecs){codec.name='UNKNOWN-CODEC';codec.clockRate=null;}window.__openRtp({sipCalls:calls});return true;})()`);
        assert.equal(await run(button('Play stream') + '.disabled'), true);
        assert.equal(await run('Boolean(window.__rtpInjected||document.querySelector(".rtp-workspace img"))'), false);
        await run('window.__abort.abort();window.__done.then(()=>true)');
        await run(`(()=>{const calls=structuredClone(window.__calls);for(const call of calls)for(const message of call.messages)for(const media of message.sdp?.media||[])media.protocol='RTP/SAVP';window.__openRtp({sipCalls:calls,allowDemo:true});return true;})()`);
        assert.equal(await run('document.querySelectorAll(".rtp-stream").length'), 0);
        assert.match(await run('document.querySelector(".rtp-analysis-notes").textContent'), /SRTP/);
        await click(button('Load synthetic RTP demo')); await run('window.__done.then(()=>true)'); assert.deepEqual(await run('window.__result'), { action: 'demo' });
        await run('window.__cap.clear(false);window.__integrated=window.__cap.openRtpMedia();true;');
        await until(() => run('Boolean(document.querySelector(".rtp-workspace"))'), 'integrated empty media viewer');
        await click(button('Load synthetic RTP demo'));
        await until(() => run('window.__cap.packets.length===401&&document.querySelectorAll(".rtp-stream").length===2'), 'integrated synthetic capture load');
        await click('[...document.querySelectorAll(".rtp-actions button")].find(x=>x.textContent.startsWith("SIP ladder:"))');
        await until(() => run('Boolean(document.querySelector(".sip-workspace"))'), 'media to SIP ladder');
        await click('[...document.querySelectorAll(".sip-workspace button")].find(x=>x.textContent==="RTP Media")');
        await until(() => run('Boolean(document.querySelector(".rtp-workspace"))'), 'SIP ladder to filtered media');
        assert.equal(await run('document.querySelector(".rtp-toolbar select").value===window.__calls[0].id'), true);
        const integratedFrame = await run('Number(document.querySelector(".rtp-table button").dataset.frame)');
        await run('window.__cap.setFilter("sip");true;');
        await click('document.querySelector(".rtp-table button")'); await run('window.__integrated.then(()=>true)');
        assert.equal(await run('window.__cap.packets[window.__cap.selected].no'), integratedFrame);
        assert.equal(await run('window.__cap.autoScroll'), false);
        assert.equal(await run('window.__cap.view.includes(window.__cap.selected)'), true, 'Media navigation reveals source packet outside previous display filter');
        await run('window.__integrated=window.__cap.openRtpMedia();true;'); await until(() => run('Boolean(document.querySelector(".rtp-workspace"))'), 'media reopened');
        await click(button('Play stream')); await until(() => run('window.__contexts.at(-1)?.state==="running"'), 'integrated audio playback');
        await run('window.__cap.clear(false);window.__integrated.then(()=>true)');
        assert.equal(await run('Boolean(document.querySelector(".rtp-workspace"))'), false, 'Capture clear dismisses owned media viewer');
        assert.equal(await run('window.__contexts.every(context=>context.state==="closed")'), true);
        assert.equal(await run('window.__app.jobs.size'), 0, 'No live collection jobs may run');
        console.log('RTP_UI_PASS: real capture decoder/core, synthetic G.711, waveform/gaps, WAV export, actual muted WebAudio single/pair playback and abort cleanup, packet/call navigation results, heuristic consent, unsupported codec/SRTP, XSS and 900×560 layout. No audio hardware/listening or live VoIP device verification.');
        finish(0);
      } catch (error) { finish(1, error); }
    });
  });
  require(path.join(repo, 'src/main/main'));
}

module.exports = { runRtpUiTests };
if (process.versions.electron && process.argv.includes('--rtp-ui-fixture')) fixture().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
else if (require.main === module) runRtpUiTests(async (name, fn) => { await fn(); console.log('PASS ' + name); }).catch((error) => { console.error(error); process.exitCode = 1; });
