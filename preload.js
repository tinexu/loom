'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('loom', {
  sys: invoke('sys:info'),
  run: invoke('cmd:run'),
  kill: invoke('cmd:kill'),
  stdin: invoke('cmd:stdin'),
  resize: invoke('cmd:resize'),
  ack: invoke('cmd:ack'),
  forget: invoke('cmd:forget'),
  onData: (fn) => ipcRenderer.on('cmd:data', (_e, m) => fn(m)),
  onExit: (fn) => ipcRenderer.on('cmd:exit', (_e, m) => fn(m)),
  listDir: invoke('fs:list'),
  names: invoke('fs:names'),
  openPath: invoke('fs:open'),
  gitLog: invoke('git:log'),
  gitStatus: invoke('git:status'),
  ai: invoke('ai:complete'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  loadSession: invoke('session:load'),
  saveSession: invoke('session:save'),
  smokeDone: invoke('smoke:done'),
  smokeReport: invoke('smoke:report'),
  smokeKeys: invoke('smoke:keys'),
  smokeResize: invoke('smoke:resize'),
});
