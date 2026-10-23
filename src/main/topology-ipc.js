'use strict';
const fs = require('node:fs/promises');
const { buildTopology, exportTopology, LIMITS } = require('./topology');
const { analyzeDevices } = require('./device-analysis');

function registerTopology(handle, { dialog, dialogOwner, isClosing = () => false, io = fs }) {
  const requireReady = () => { if (isClosing()) throw new Error('KonX is closing. Wait before using topology files.'); };
  handle('tools:topologyBuild', (report, options) => { requireReady(); return buildTopology(report, options); });
  handle('tools:topologyImport', async () => {
    requireReady();
    const result = await dialog.showOpenDialog(dialogOwner(), { title: 'Open topology or Device Inspector report',
      properties: ['openFile'], filters: [{ name: 'Topology or device report', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths?.[0]) return null;
    requireReady();
    const file = await io.open(result.filePaths[0], 'r');
    let content;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Choose a regular topology or Device Inspector report file.');
      if (stat.size > LIMITS.exportBytes) throw new Error('Topology report exceeds the 20 MiB file limit.');
      // Read one byte beyond the observed size to detect growth without an
      // unbounded readFile allocation. A changing file is not a stable report.
      const buffer = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < buffer.length) {
        const part = await file.read(buffer, length, buffer.length - length, null);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length !== stat.size) throw new Error('Topology report changed while reading. Try loading it again.');
      content = buffer.subarray(0, length).toString('utf8');
    } finally { await file.close(); }
    requireReady();
    let input;
    try { input = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw new Error('Topology or Device Inspector report JSON is malformed.'); }
    if (input?.kind === 'topology') {
      if (input.schemaVersion !== 1 || !input.sourceReport) throw new Error('Topology export has an unsupported schema or no retained source report.');
      input = input.sourceReport;
    }
    // Never trust imported graph nodes, paths, coverage, or supplied facts.
    // The canonical device owner reinterprets the retained command evidence.
    return analyzeDevices(input);
  });
  handle('tools:topologyExport', async (report, options) => {
    requireReady();
    const content = exportTopology(report, options);
    const result = await dialog.showSaveDialog(dialogOwner(), { title: 'Export topology and source observations',
      defaultPath: 'konx-topology.json', filters: [{ name: 'Topology JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    requireReady();
    await io.writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 });
    return result.filePath;
  });
}
module.exports = { registerTopology };
