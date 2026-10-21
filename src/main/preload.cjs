// Мост между интерфейсом (renderer) и основным процессом. Доступен как window.pazzle.
'use strict';
const {contextBridge, ipcRenderer} = require('electron');

const on = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('pazzle', {
  info: () => ipcRenderer.invoke('app:info'),
  openDocs: (name) => ipcRenderer.invoke('app:openDocs', name),
  setDirty: (dirty) => ipcRenderer.send('app:setDirty', dirty),
  loadLanguage: () => ipcRenderer.invoke('language:load'),

  project: {
    open: () => ipcRenderer.invoke('project:open'),
    save: (filePath, content) => ipcRenderer.invoke('project:save', filePath, content),
    examples: () => ipcRenderer.invoke('examples:list'),
    readExample: (name) => ipcRenderer.invoke('examples:read', name),
  },
  exportCode: (defaultName, content) => ipcRenderer.invoke('code:export', defaultName, content),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),
  },

  pvm: {
    tools: () => ipcRenderer.invoke('pvm:tools'),
    ports: () => ipcRenderer.invoke('serial:list'),
    build: (opts) => ipcRenderer.invoke('pvm:build', opts),
    openBuildFolder: (projectPath) => ipcRenderer.invoke('pvm:openBuildFolder', projectPath),
    exportProject: (opts) => ipcRenderer.invoke('pvm:exportProject', opts),
    run: (opts) => ipcRenderer.invoke('pvm:run', opts),
    stop: () => ipcRenderer.invoke('run:stop'),
    onBuildOutput: on('build:output'),
    onRunEvent: on('run:event'),
  },

  debug: {
    start: (opts) => ipcRenderer.invoke('debug:start', opts),
    command: (name, arg) => ipcRenderer.invoke('debug:command', name, arg),
    onEvent: on('debug:event'),
  },

  onMenu: on('menu'),
  onOpenFile: on('open-file'),
});
