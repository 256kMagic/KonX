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

  if (options.phase === 'save') {
    let deviceInspector = null;
    let deviceSnapshots = null;
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
    await complete({ phase: options.phase, version: info.version, tools: supportsSnapshots ? 6 : supportsDeviceInspector ? 5 : 4, ...(deviceInspector ? { deviceInspector } : {}), ...(deviceSnapshots ? { deviceSnapshots } : {}), assessments: 8, mistRegions: 12, aiProviders: 5, knowledgeDocuments: knowledge.documents, vectorIndexReady: true, customNoteSaved: true, configChecks: report.checks.length, redactedExports: true, contextPreviewRedacted: true, encryptedTokenSaved: true, encryptedAiKeySaved: true, noAutomaticJobs: app.jobs.size === 0 });
  } else if (options.phase === 'forget') {
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
    assert(app.jobs.size === 0, 'Smoke left running jobs');
    await complete({ phase: options.phase, version: info.version, ...(deviceSnapshots ? { deviceSnapshots } : {}), encryptedTokenPersisted: true, tokenForgotten: true, encryptedAiKeyPersisted: true, aiKeyForgotten: true, customNotePersisted: true, customNoteRemoved: true, vectorIndexReady: true, noAutomaticJobs: true });
  } else throw new Error('Unknown package smoke phase');
})()
