'use strict';
// The only bridge between the page and the main process. Channels are allow-listed
// by prefix so the renderer cannot reach arbitrary IPC.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_PREFIXES = ['app:', 'clipboard:', 'dialog:', 'settings:', 'sessions:', 'hostkeys:', 'conn:', 'serial:', 'sftp:', 'xfer:', 'local:', 'tools:', 'ui:', 'cap:', 'np:'];
const SEND_CHANNELS = ['conn:write', 'conn:resize', 'np:backup'];
const EVENT_CHANNELS = ['app:updateState', 'conn:data', 'conn:status', 'ui:prompt', 'xfer:update', 'sftp:changed', 'sftp:closed', 'sftp:edited', 'sftp:edit-error', 'tools:event', 'cap:packets', 'cap:state', 'np:changed', 'np:found', 'np:findDone'];

contextBridge.exposeInMainWorld('api', {
  invoke(channel, ...args) {
    if (!INVOKE_PREFIXES.some((p) => channel.startsWith(p))) throw new Error('Blocked channel ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    if (!SEND_CHANNELS.includes(channel)) throw new Error('Blocked channel ' + channel);
    ipcRenderer.send(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error('Blocked channel ' + channel);
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** Absolute path of a file dropped from the OS file manager. */
  pathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  platform: process.platform,
});
