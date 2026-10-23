'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readCaptureFile } = require('./capture');

/** All handlers inherit the main window and updater operation guard. */
function registerSiteWorkspaces(register, { sites, dialog, dialogOwner, isClosing = () => false }) {
  const ready = () => { if (isClosing()) throw new Error('KonX is closing. Wait before using saved workspaces.'); };
  const handle = (channel, action) => register(channel, (...args) => { ready(); return action(...args); });
  handle('tools:siteList', () => sites.list());
  handle('tools:siteGet', id => sites.get(id));
  handle('tools:siteSave', input => sites.save(input));
  handle('tools:siteDuplicate', (id, options) => sites.duplicate(id, options));
  handle('tools:siteRemove', id => sites.remove(id));
  handle('tools:siteImport', async () => {
    const result = await dialog.showOpenDialog(dialogOwner(), { title: 'Import site workspace', properties: ['openFile'],
      filters: [{ name: 'Site workspace JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    ready();
    return sites.importFile(result.filePaths[0]);
  });
  handle('tools:siteExport', async id => {
    await sites.get(id);
    const result = await dialog.showSaveDialog(dialogOwner(), { title: 'Export site workspace', defaultPath: 'konx-site-workspace.json',
      filters: [{ name: 'Site workspace JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    ready();
    return sites.exportFile(id, result.filePath);
  });
  handle('tools:sitePickCapture', async () => {
    const result = await dialog.showOpenDialog(dialogOwner(), { title: 'Choose a capture reference', properties: ['openFile'],
      filters: [{ name: 'Packet captures', extensions: ['pcap', 'pcapng', 'cap', 'dmp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    ready();
    return { id: randomUUID(), name: path.basename(result.filePaths[0]), path: result.filePaths[0] };
  });
  handle('tools:siteReadCapture', async (id, captureId) => {
    const workspace = await sites.get(id);
    const reference = workspace.captures.find(item => item.id === captureId);
    if (!reference) throw new Error('That capture reference is no longer in this saved site. Save the site before opening a new reference.');
    return { name: reference.name, bytes: readCaptureFile(reference.path, { maxBytes: 64 * 1024 * 1024 }) };
  });
}

module.exports = { registerSiteWorkspaces };
