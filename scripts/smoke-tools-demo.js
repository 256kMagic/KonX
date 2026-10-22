(async () => {
  const options = window.__KONX_TOOLS_SMOKE;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test, description) => {
    const deadline = Date.now() + 15000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error('Timed out: ' + description);
      await pause();
    }
  };
  await until(() => window.__app, 'application initialization');
  const app = window.__app;
  const { api } = await import('./js/ui.js');
  const { exportReport, validateReport } = await import('./js/security-report.mjs');
  const { TOOLS } = await import('./js/tools.js');
  const complete = async (checks) => {
    if (sessionManagement) checks.sessionManagement = sessionManagement;
    // Portable launchers do not necessarily forward their app's stdout. Write
    // test evidence only to the parent-provided private artifact file.
    await api.invoke('np:write', options.resultPath, new TextEncoder().encode(JSON.stringify(checks, null, 2)));
    console.log('KONX_TOOLS_PACKAGE_SMOKE_PASS ' + JSON.stringify(checks));
  };
  const info = await api.invoke('app:info');
  assert(info.version === options.version && app.info.version === options.version, 'Unexpected application version');
  assert(info.encryption, 'Windows credential encryption must be available');
  for (const kind of ['security', 'wifi', 'mist', 'ai']) assert(TOOLS.some((tool) => tool.kind === kind), 'Missing tool entry: ' + kind);
  assert(app.jobs.size === 0, 'Fresh app unexpectedly started a tool job');
  const security = app.openTool('security');
  assert(security.audit.options.length === 8, 'Expected eight security assessments');
  assert(security.audit.value === 'windows' && !security.runButton.disabled, 'Local Windows assessment is unavailable');
  const wifi = app.openTool('wifi');
  assert(!wifi.runButton.disabled && !wifi.report && !wifi.jobId, 'Wi-Fi tool is not ready for an explicit refresh');
  const mist = app.openTool('mist');
  await until(() => !mist.configBusy && mist.config, 'Mist connection settings');
  assert(mist.region.options.length === 12 && mist.config.regions.length === 12, 'Mist cloud regions are missing');
  assert(mist.token.type === 'password', 'Mist credential input must mask its value');
  assert(app.jobs.size === 0, 'Opening tool tabs unexpectedly started a job');
  const ai = app.openTool('ai');
  await until(() => !ai.configBusy && ai.config, 'AI connection settings');
  assert(ai.provider.options.length === 5 && ai.key.type === 'password', 'Five AI providers and a masked key input are required');
  const knowledge = await api.invoke('tools:knowledgeStatus');
  assert(knowledge.state === 'ready' && knowledge.documents >= 30 && knowledge.chunks > 0, 'Packaged background knowledge database is not ready');
  assert(knowledge.algorithm === 'Local TF-IDF cosine vectors', 'Unexpected vector index algorithm');
  assert((await api.invoke('tools:knowledgeList', { query: 'RSSI' })).length > 0, 'Offline reference search found no signal guidance');
  const noteTitle = 'Package smoke synthetic reference';
  const versionParts = info.version.split('.').map(Number);
  const supportsDeviceInspector = versionParts[0] > 0 || versionParts[1] >= 7;
  const supportsSnapshots = versionParts[0] > 0 || versionParts[1] >= 8;
  const supportsRtp = versionParts[0] > 0 || versionParts[1] >= 9;
  const supportsIncidents = versionParts[0] > 0 || versionParts[1] >= 10;
  const supportsRemoteCapture = versionParts[0] > 0 || versionParts[1] >= 11;
  const supportsRunbooks = versionParts[0] > 0 || versionParts[1] >= 12;
  const supportsComparison = versionParts[0] > 0 || versionParts[1] >= 13;
  const supportsLayouts = versionParts[0] > 0 || versionParts[1] >= 14;
  const supportsSessionManagement = versionParts[0] > 0 || versionParts[1] >= 15;
  let sessionManagement = null;
  const sessionName = 'Package smoke synthetic saved session';

  if (options.phase === 'save') {
    if (supportsSessionManagement) {
      const saved = await api.invoke('sessions:save', { name: sessionName, protocol: 'ssh', host: '192.0.2.15', port: 22, username: 'fixture-user', auth: 'password', password: options.token + '-session' });
      assert(saved.hasPassword && saved.username === 'fixture-user' && !Object.hasOwn(saved, 'password') && !Object.hasOwn(saved, 'passwordEnc'), 'Saved session exposed credentials or omitted its username');
      await app.sessions.load(); app.rememberRecent(saved.id);
      assert(app.recentSessions().some(item => item.id === saved.id), 'Saved session did not enter recent history');
      localStorage.setItem('konx.session-smoke-marker', 'retained');
      assert(app.clearRecentSessions() && app.recentSessions().length === 0, 'Recent history did not clear');
      assert((await api.invoke('sessions:list')).sessions.some(item => item.id === saved.id && item.hasPassword), 'Clearing history removed a saved credential');
      sessionManagement = { usernameSaved: true, passwordPresencePrivate: true, historyCleared: true, savedSessionRetained: true };
    }
    if (supportsLayouts) {
      const originalTabs = [...app.tabs], theme = app.settings.uiTheme, palette = app.settings.colorScheme;
      for (const uiLayout of ['workbench', 'incident-desk', 'operations-wall', 'focus', 'classic']) {
        await app.saveSettings({ uiLayout });
        assert(app.workspaceLayout.get().layout === uiLayout, 'Packaged layout did not apply: ' + uiLayout);
        assert(originalTabs.every(tab => app.tabs.includes(tab) && app.byId.get(tab.id) === tab), 'Layout replaced an existing tool');
        assert(app.settings.uiTheme === theme && app.settings.colorScheme === palette, 'Layout changed theme or terminal palette');
      }
      await app.saveSettings({ uiLayout: 'focus' });
      assert(app.jobs.size === 0, 'Layout started a tool job');
    }
    let deviceInspector = null;
    let deviceSnapshots = null;
    let rtpMedia = null;
    let incidentWorkspace = null;
    let remoteCapture = null;
    let runbooks = null;
    let captureComparison = null;
    if (supportsComparison) {
      assert(TOOLS.some(tool => tool.kind === 'capture-compare'), 'Capture Comparison tool is missing');
      const comparison = app.openTool('capture-compare'); await comparison.ready; await comparison.loadDemo();
      assert(comparison.report?.summary.matchedServices === 2 && comparison.report.summary.changed >= 8, 'Packaged working/failing demo did not compare');
      assert(comparison.sources.before.packets.length === 11 && comparison.sources.after.packets.length === 11, 'Demo source packets were not retained');
      assert(['dns', 'tcp', 'http'].every(category => comparison.report.changes.some(row => row.category === category && row.status === 'changed')), 'Expected DNS/TCP/HTTP observations are missing');
      assert(comparison.aiContext && !Object.hasOwn(comparison.aiContext, 'changes') && !Object.hasOwn(comparison.aiContext, 'packets'), 'Comparison AI context must contain only its summary');
      const row = comparison.report.changes.find(item => item.category === 'http' && item.status === 'changed' && item.afterSources.length);
      assert(row, 'HTTP source-frame evidence is missing');
      await comparison.openSource('after', row.afterSources[0].frame);
      const evidence = app.active;
      assert(evidence.kind === 'capture' && evidence.packets.length === 11 && evidence.captureCoverage?.examinedAllRecords === true, 'Retained comparison source did not open with coverage');
      await app.closeTab(evidence);
      captureComparison = { matchedServices: comparison.report.summary.matchedServices, changes: comparison.report.summary.changed,
        dnsTcpHttp: true, retainedSourceOpened: true, summaryOnlyAI: true, noNetworkCollection: app.jobs.size === 0 };
      await app.closeTab(comparison); assert(!app.byId.has(comparison.id), 'Comparison tab failed to close');
    }
    if (supportsRunbooks) {
      assert(TOOLS.some(tool => tool.kind === 'runbook'), 'Troubleshooting Runbooks tool is missing');
      const runbook = app.openTool('runbook'); await runbook.ready;
      assert(runbook.templates.length === 3 && runbook.saved.length === 0 && app.jobs.size === 0, 'Built-in runbooks are missing or started automatically');
      const definition = { schemaVersion: 1, name: 'Synthetic package smoke procedure', inputs: [], steps: [
        { id: 'review', title: 'Review synthetic evidence', kind: 'checklist', instructions: 'Manual evidence remains unknown.' }
      ] };
      const saved = await api.invoke('tools:runbookSave', { definition });
      await runbook.refresh(); await runbook.select('saved:' + saved.id);
      assert(runbook.definition.name === definition.name && !runbook.isDirty(), 'Saved procedure did not load cleanly');
      await runbook.start(); await until(() => !runbook.jobId && runbook.report, 'packaged manual procedure');
      assert(runbook.report.complete && runbook.report.steps.length === 1 && runbook.report.steps[0].status === 'unknown', 'Manual procedure invented a passing observation');
      assert(runbook.updateBlockers().length === 0, 'Saved idle runbook still blocks updating');
      await app.closeTab(runbook); assert(!app.byId.has(runbook.id), 'Saved idle runbook failed to close');
      runbooks = { templates: 3, customDefinitionSaved: true, manualObservationUnknown: true, noNetworkCollection: true };
    }
    if (supportsRemoteCapture) {
      assert(TOOLS.some(tool => tool.kind === 'remote-capture'), 'Remote Capture tool is missing');
      const remote = app.openTool('remote-capture'); await remote.ready;
      assert(remote.connections.length === 0 && remote.startButton.disabled && !remote.jobId, 'Remote capture must require a connected session and explicit start');
      assert(!remote.report && remote.openButton.disabled && remote.deleteButton.disabled, 'Fresh remote tool exposed a retained result');
      assert(remote.updateBlockers().length === 0 && app.jobs.size === 0, 'Idle remote tool blocks updates or started a job');
      let rejected = false;
      try { await api.invoke('tools:remoteCaptureRead', 'unknown-result'); } catch { rejected = true; }
      assert(rejected, 'Remote capture reader accepted an unknown result');
      await app.closeTab(remote);
      assert(!app.byId.has(remote.id), 'Idle remote tab failed to close');
      remoteCapture = { explicitStartRequired: true, unknownResultRejected: true, noNetworkCollection: true };
    }
    if (supportsDeviceInspector) {
      assert(TOOLS.some((tool) => tool.kind === 'device'), 'Device Inspector entry is missing');
      const device = app.openTool('device');
      await device.ready;
      assert(!device.report && !device.jobId && app.jobs.size === 0, 'Device Inspector must not automatically collect SSH output');
      await device.load('tools:deviceDemo');
      assert(device.report?.devices.length === 2, 'Packaged Device Inspector demo is unavailable: ' + device.status.textContent);
      assert(device.report.devices.every((entry) => entry.facts.interfaces.length > 0 && entry.facts.mac.length > 0), 'Packaged Cisco demo facts are missing');
      device.query.value = '192.0.2.100'; await device.find();
      assert(device.trace?.matches.length >= 2 && device.trace.paths.length >= 1, 'Packaged endpoint trace did not connect the synthetic switches');
      assert(device.traceResults.querySelector('.device-match button'), 'Packaged endpoint evidence controls are missing');
      deviceInspector = { demoDevices: device.report.devices.length, endpointMatches: device.trace.matches.length, paths: device.trace.paths.length, noNetworkCollection: !device.jobId };
      await app.closeTab(device);
      assert(!app.byId.has(device.id) && app.jobs.size === 0, 'Device Inspector smoke did not close cleanly');
    }
    if (supportsSnapshots) {
      assert(TOOLS.some((tool) => tool.kind === 'snapshots'), 'Device Snapshots entry is missing');
      const snapshots = app.openTool('snapshots'); await snapshots.ready;
      assert(snapshots.snapshots.length === 0, 'Fresh smoke profile unexpectedly contains device snapshots');
      await snapshots.loadDemo();
      assert(snapshots.report?.kind === 'device-snapshot-comparison' && snapshots.report.devices.length === 2 && snapshots.report.changes.length > 0,
        'Packaged snapshot demo comparison failed: ' + snapshots.status.textContent);
      assert(snapshots.report.changes.some((change) => change.category === 'configuration'), 'Packaged configuration comparison is missing');
      assert(snapshots.report.changes.some((change) => change.category === 'routes'), 'Packaged route comparison is missing');
      assert(snapshots.aiContext?.summary && !Object.hasOwn(snapshots.aiContext, 'changes'), 'Snapshot AI context must contain a summary without changed values');
      const saved = await api.invoke('tools:snapshotList');
      assert(saved.snapshots.length === 2 && saved.issues.length === 0, 'Demo snapshots were not stored correctly');
      deviceSnapshots = { savedSnapshots: saved.snapshots.length, comparedDevices: snapshots.report.devices.length, changes: snapshots.report.changes.length,
        configurationAndRoutesCompared: true, aiSummaryOnly: true, noNetworkCollection: app.jobs.size === 0 };
      await app.closeTab(snapshots);
      assert(!app.byId.has(snapshots.id) && app.jobs.size === 0, 'Snapshot smoke did not close cleanly');
    }
    if (supportsRtp) {
      const { makeRtpDemo } = await import('./js/capture/sample-rtp.mjs');
      const { analyzeSipCalls } = await import('./js/capture/sip.mjs');
      const { analyzeRtp, buildRtpAudio, encodeWav } = await import('./js/capture/rtp.mjs');
      const capture = app.openTool('capture'), demo = makeRtpDemo();
      await capture.loadBytes(demo.bytes, demo.name);
      const sip = analyzeSipCalls(capture.packets), media = analyzeRtp(capture.packets, { sipCalls: sip.calls });
      assert(capture.packets.length === 401 && sip.calls.length === 1 && media.streams.length === 2, 'Packaged RTP demo did not decode');
      assert(media.streams.some(stream => stream.sequenceGaps === 3 && stream.outOfOrderPackets === 1 && stream.duplicatePackets === 1), 'Packaged RTP capture findings are missing');
      const audio = buildRtpAudio(media.streams[0]), wav = encodeWav(audio);
      assert(audio.samples.length === 32000 && wav.length === 64044, 'Packaged G.711 WAV reconstruction failed');
      const opened = capture.openRtpMedia();
      await until(() => document.querySelector('.rtp-workspace'), 'packaged RTP viewer');
      assert(document.querySelectorAll('.rtp-stream').length === 2, 'Packaged RTP stream list is missing');
      [...document.querySelectorAll('.rtp-workspace button')].find(button => button.textContent === 'Build waveform').click();
      assert(document.querySelector('.rtp-wave') && document.querySelector('.rtp-silence'), 'Packaged audio waveform or gap markers are missing');
      document.querySelector('.modal > header .x').click(); await opened;
      assert(!document.querySelector('.rtp-workspace'), 'Packaged RTP viewer failed to close');
      rtpMedia = { packets: capture.packets.length, calls: sip.calls.length, streams: media.streams.length, rtcp: media.rtcp.length,
        samples: audio.samples.length, wavBytes: wav.length, waveformAndGaps: true, noPlayback: true, noNetworkCollection: app.jobs.size === 0 };
      await app.closeTab(capture);
    }
    if (supportsIncidents) {
      assert(TOOLS.some(tool => tool.kind === 'incidents'), 'Incident Workspace tool is missing');
      const incidents = app.openTool('incidents'); await incidents.ready;
      assert(incidents.incidents.length === 0, 'Fresh smoke profile unexpectedly contains incidents');
      const created = await api.invoke('tools:incidentCreate', { title: 'Synthetic package smoke incident', description: 'Offline evidence persistence fixture' });
      await incidents.refresh(created.id);
      incidents.noteText.value = 'Synthetic observation: audio gap seen in a local sample.';
      incidents.noteLabel.value = 'Package smoke note'; await incidents.addText();
      assert(incidents.report.evidence.length === 1 && incidents.report.timeline[0].observedAt === null, 'Untimed note must stay unknown');
      const { makeRtpDemo } = await import('./js/capture/sample-rtp.mjs');
      const demo = makeRtpDemo();
      incidents.acceptIncident(await api.invoke('tools:incidentAddCapture', created.id, { bytes: demo.bytes, label: demo.name }));
      assert(incidents.report.evidence.length === 2 && incidents.report.evidence.find(item => item.kind === 'note').integrity === 'verified', 'Text evidence copy was not verified');
      assert(incidents.report.evidence.find(item => item.kind === 'capture').integrity === 'not-checked', 'Binary integrity should remain unknown until read');
      assert(incidents.aiContext.evidenceCount === 2 && !Object.hasOwn(incidents.aiContext, 'evidence'), 'Incident AI context must exclude raw evidence');
      incidentWorkspace = { savedEvidence: 2, unknownNoteTimePreserved: true, captureCopied: true, summaryOnlyAI: true, noNetworkCollection: app.jobs.size === 0 };
      await app.closeTab(incidents);
    }
    assert(!mist.config.hasToken && mist.testButton.disabled, 'Fresh profile must have no API token');
    app.activate(security);
    security.audit.value = 'config';
    security.audit.dispatchEvent(new Event('change'));
    security.host.value = 'Synthetic package smoke fixture';
    security.config.value = 'version 17.1\nhostname konx-smoke\nip ssh version 2\nusername fixture-user password 0 SYNTHETIC_CONFIG_SECRET\nline vty 0 4\n transport input telnet ssh\n';
    security.runButton.click();
    await until(() => security.state === 'idle' && !security.jobId, 'offline configuration assessment');
    assert(security.report, 'Packaged assessment produced no report: ' + security.status.textContent);
    const report = validateReport(security.report);
    assert(report.kind === 'config' && report.checks.length >= 5, 'Packaged offline rules were not loaded');
    assert(report.checks.some((check) => ['warning', 'fail'].includes(check.status)), 'Unsafe synthetic settings were not detected');
    assert(report.checks.some((check) => check.status === 'unknown'), 'Missing fixture settings must remain unknown');
    const json = exportReport(report, 'json'), html = exportReport(report, 'html');
    assert(JSON.parse(json).checks.length === report.checks.length && html.includes('<!doctype html>'), 'Assessment export failed');
    assert(!json.includes('SYNTHETIC_CONFIG_SECRET') && !html.includes('SYNTHETIC_CONFIG_SECRET') && !json.includes('fixture-user'), 'Assessment exposed fixture credentials');
    assert(!security.jsonButton.disabled && !security.htmlButton.disabled, 'Assessment export controls remain disabled');
    app.activate(mist);
    await until(() => !mist.configBusy && !mist.saveButton.disabled, 'Mist settings after tab activation');
    mist.token.value = options.token;
    mist.saveButton.click();
    await until(() => !mist.configBusy, 'synthetic Mist credential save');
    assert(mist.config.hasToken, 'Synthetic Mist token was not encrypted and saved: ' + mist.status.textContent);
    assert(mist.token.value === '' && !mist.testButton.disabled && !mist.forgetButton.disabled, 'Mist controls did not update after saving');
    const publicConfig = await api.invoke('tools:mistConfig');
    assert(publicConfig.hasToken && !JSON.stringify(publicConfig).includes(options.token) && !Object.hasOwn(publicConfig, 'tokenEnc'), 'Mist settings exposed credential material');
    app.activate(ai);
    await until(() => !ai.configBusy, 'AI settings after activation');
    ai.provider.value = 'nyquest'; ai.provider.dispatchEvent(new Event('change'));
    ai.key.value = options.token; ai.saveButton.click();
    await until(() => !ai.configBusy, 'synthetic AI credential save');
    assert(ai.config.provider === 'nyquest' && ai.config.hasKey && ai.key.value === '', 'AI credential was not saved securely');
    assert(!JSON.stringify(await api.invoke('tools:aiConfig')).includes(options.token), 'AI settings exposed a saved key');
    ai.context.value = 'RSSI -67 dBm\npassword=synthetic_context_secret'; ai.context.dispatchEvent(new Event('input'));
    await ai.previewContext();
    assert(!ai.preview.textContent.includes('synthetic_context_secret') && ai.preview.textContent.includes('Redacted'), 'AI preview did not redact the test secret');
    assert(!ai.shareContext.checked && !ai.shareContext.disabled, 'Context must require explicit selection after preview');
    const article = await api.invoke('tools:knowledgeSave', { title: noteTitle, vendor: 'Synthetic fixture', content: 'Wireless RSSI observations are cached evidence. Verify the adapter and collection time.' });
    await ai.readDocument(article.id);
    assert(ai.documentContent.textContent.includes('cached evidence'), 'Packaged local article did not render');
    await complete({ phase: options.phase, version: info.version, tools: supportsComparison ? 11 : supportsRunbooks ? 10 : supportsRemoteCapture ? 9 : supportsIncidents ? 8 : supportsRtp ? 7 : supportsSnapshots ? 6 : supportsDeviceInspector ? 5 : 4, ...(deviceInspector ? { deviceInspector } : {}), ...(deviceSnapshots ? { deviceSnapshots } : {}), ...(rtpMedia ? { rtpMedia } : {}), ...(incidentWorkspace ? { incidentWorkspace } : {}), ...(remoteCapture ? { remoteCapture } : {}), ...(runbooks ? { runbooks } : {}), ...(captureComparison ? { captureComparison } : {}), assessments: 8, mistRegions: 12, aiProviders: 5, knowledgeDocuments: knowledge.documents, vectorIndexReady: true, customNoteSaved: true, configChecks: report.checks.length, redactedExports: true, contextPreviewRedacted: true, encryptedTokenSaved: true, encryptedAiKeySaved: true, noAutomaticJobs: app.jobs.size === 0 });
  } else if (options.phase === 'forget') {
    if (supportsSessionManagement) {
      await app.sessions.load();
      const saved = app.sessions.data.sessions.find(item => item.name === sessionName);
      assert(saved?.username === 'fixture-user' && saved.hasPassword, 'Saved username/password presence did not survive restart');
      assert(app.recentSessions().length === 0 && localStorage.getItem('konx.recent') === null, 'Cleared recent history returned after restart');
      assert(localStorage.getItem('konx.session-smoke-marker') === 'retained', 'History clearing removed unrelated local preferences');
      const cleared = await api.invoke('sessions:save', { id: saved.id, password: null });
      assert(!cleared.hasPassword && cleared.username === 'fixture-user', 'Explicit password removal changed the saved username');
      await api.invoke('sessions:delete', saved.id); localStorage.removeItem('konx.session-smoke-marker');
      sessionManagement = { persistedAcrossRestart: true, historyStayedCleared: true, unrelatedPreferencesRetained: true, passwordRemoved: true };
    }
    if (supportsLayouts) assert(app.settings.uiLayout === 'focus' && app.workspaceLayout.get().layout === 'focus', 'Workspace layout did not survive packaged restart');
    assert(mist.config.hasToken && !mist.testButton.disabled, 'Encrypted Mist token did not survive app restart');
    assert(mist.token.value === '', 'Saved credential must not be returned to the input');
    mist.forgetButton.click();
    await until(() => !mist.configBusy, 'synthetic Mist credential removal');
    assert(!mist.config.hasToken && mist.testButton.disabled && mist.forgetButton.disabled, 'Mist token removal did not update controls');
    const config = await api.invoke('tools:mistConfig');
    assert(!config.hasToken && !JSON.stringify(config).includes(options.token), 'Mist token remained after removal');
    app.activate(ai);
    await until(() => !ai.configBusy, 'AI settings after activation');
    assert(ai.config.provider === 'nyquest' && ai.config.hasKey && ai.key.value === '', 'Encrypted AI key did not survive restart');
    ai.forgetButton.click(); await until(() => !ai.configBusy, 'synthetic AI credential removal');
    assert(!ai.config.hasKey && !JSON.stringify(await api.invoke('tools:aiConfig')).includes(options.token), 'AI credential remained after Forget');
    const notes = await api.invoke('tools:knowledgeList', { query: noteTitle });
    const note = notes.find((article) => article.title === noteTitle && article.builtin === false);
    assert(note, 'Custom knowledge note did not survive restart');
    await api.invoke('tools:knowledgeRemove', note.id);
    assert(!(await api.invoke('tools:knowledgeGet', note.id)), 'Custom note remained after removal');
    let deviceSnapshots = null;
    if (supportsSnapshots) {
      const history = await api.invoke('tools:snapshotList');
      assert(history.snapshots.length === 2 && history.issues.length === 0, 'Device snapshots did not survive restart');
      const before = history.snapshots.find((item) => item.label === 'Demo before change');
      const after = history.snapshots.find((item) => item.label === 'Demo after change');
      assert(before && after, 'Saved demo snapshot identities are missing');
      const comparison = await api.invoke('tools:snapshotCompare', { beforeId: before.id, afterId: after.id });
      assert(comparison.devices.length === 2 && comparison.changes.length > 0, 'Restored snapshots no longer compare correctly');
      await api.invoke('tools:snapshotRemove', before.id); await api.invoke('tools:snapshotRemove', after.id);
      assert((await api.invoke('tools:snapshotList')).snapshots.length === 0, 'Synthetic snapshots remained after removal');
      deviceSnapshots = { persistedAcrossRestart: true, comparisonRestored: true, syntheticSnapshotsRemoved: true };
    }
    let incidentWorkspace = null;
    if (supportsIncidents) {
      const library = await api.invoke('tools:incidentList');
      assert(library.incidents.length === 1 && library.issues.length === 0, 'Incident evidence did not survive restart');
      const saved = library.incidents.find(item => item.title === 'Synthetic package smoke incident');
      assert(saved, 'Synthetic incident identity missing after restart');
      const incident = await api.invoke('tools:incidentGet', saved.id);
      assert(incident.evidence.length === 2 && incident.evidence.find(item => item.kind === 'note').integrity === 'verified', 'Restored text evidence failed verification');
      const capture = incident.evidence.find(item => item.kind === 'capture');
      const bytes = await api.invoke('tools:incidentCapture', saved.id, capture.id);
      const { readCapture } = await import('./js/capture/pcapfile.mjs');
      assert(readCapture(bytes.bytes).packets.length === 401, 'Restored capture copy is unreadable');
      await api.invoke('tools:incidentRemove', saved.id);
      assert((await api.invoke('tools:incidentList')).incidents.length === 0, 'Synthetic incident remained after removal');
      incidentWorkspace = { persistedAcrossRestart: true, retainedCaptureVerified: true, syntheticIncidentRemoved: true };
    }
    assert(app.jobs.size === 0, 'Smoke left running jobs');
    let runbooks = null;
    if (supportsRunbooks) {
      const library = await api.invoke('tools:runbookList');
      assert(library.runbooks.length === 1 && library.issues.length === 0, 'Custom runbook did not survive restart');
      const saved = await api.invoke('tools:runbookGet', library.runbooks[0].id);
      assert(saved.definition.name === 'Synthetic package smoke procedure' && saved.definition.steps[0].kind === 'checklist', 'Restored runbook definition changed');
      await api.invoke('tools:runbookRemove', saved.id);
      assert((await api.invoke('tools:runbookList')).runbooks.length === 0, 'Synthetic procedure remained after removal');
      runbooks = { persistedAcrossRestart: true, syntheticProcedureRemoved: true };
    }
    await complete({ phase: options.phase, version: info.version, ...(deviceSnapshots ? { deviceSnapshots } : {}), ...(incidentWorkspace ? { incidentWorkspace } : {}), ...(runbooks ? { runbooks } : {}), encryptedTokenPersisted: true, tokenForgotten: true, encryptedAiKeyPersisted: true, aiKeyForgotten: true, customNotePersisted: true, customNoteRemoved: true, vectorIndexReady: true, noAutomaticJobs: true });
  } else throw new Error('Unknown package smoke phase');
})()
