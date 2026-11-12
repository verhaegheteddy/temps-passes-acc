const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: call('state:get'),
  setToken: call('settings:setToken'),
  setDatabases: call('settings:setDatabases'),
  inspect: call('notion:inspect'),
  sync: call('sync:start'),
  cancelSync: call('sync:cancel'),
  conflicts: call('conflicts:list'),
  acknowledge: call('conflicts:ack'),
  tagValues: call('report:tags'),
  buildReport: call('report:build'),
  exportReport: call('report:export'),
  buildStats: call('stats:build'),
  issueRows: call('stats:issueRows'),
  updatePerson: call('stats:updatePerson'),
  setTimeSettings: call('stats:setSettings'),
  identities: call('people:identities'),
  setAlias: call('people:setAlias'),
  closurePreview: call('closure:preview'),
  closePeriod: call('closure:close'),
  reopenPeriod: call('closure:reopen'),
  closureHistory: call('closure:history'),
  openExternal: call('shell:open'),
  openDataFolder: call('shell:dataFolder'),
  onSyncProgress: (fn) => ipcRenderer.on('sync:progress', (_e, p) => fn(p)),
});
