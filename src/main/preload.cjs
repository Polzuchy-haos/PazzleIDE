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
  ready: () => ipcRenderer.send('app:ready'),
  openDocs: (name) => ipcRenderer.invoke('app:openDocs', name),
  setDirty: (dirty) => ipcRenderer.send('app:setDirty', dirty),
  loadLanguage: () => ipcRenderer.invoke('language:load'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  project: {
    examples: () => ipcRenderer.invoke('examples:list'),
    readExample: (name) => ipcRenderer.invoke('examples:read', name),
  },
  file: {
    open: (opts) => ipcRenderer.invoke('file:open', opts),
    save: (opts) => ipcRenderer.invoke('file:save', opts),
  },
  exportCode: (defaultName, content) => ipcRenderer.invoke('code:export', defaultName, content),

  fs: {
    chooseFolder: () => ipcRenderer.invoke('folder:choose'),
    watch: (dir) => ipcRenderer.invoke('folder:watch', dir),
    list: (dir) => ipcRenderer.invoke('fs:list', dir),
    read: (file) => ipcRenderer.invoke('fs:read', file),
    write: (file, content) => ipcRenderer.invoke('fs:write', file, content),
    create: (target, options) => ipcRenderer.invoke('fs:create', target, options),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
    trash: (target) => ipcRenderer.invoke('fs:trash', target),
    exists: (target) => ipcRenderer.invoke('fs:exists', target),
    reveal: (target) => ipcRenderer.invoke('fs:reveal', target),
    openExternal: (target) => ipcRenderer.invoke('fs:openExternal', target),
    contextMenu: (opts) => ipcRenderer.invoke('fs:contextMenu', opts),
    onChanged: on('fs:changed'),
  },

  libraries: {
    list: (opts) => ipcRenderer.invoke('libraries:list', opts),
    save: (lib) => ipcRenderer.invoke('libraries:save', lib),
    remove: (file) => ipcRenderer.invoke('libraries:delete', file),
    import: () => ipcRenderer.invoke('libraries:import'),
    openFolder: () => ipcRenderer.invoke('libraries:openFolder'),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),
  },
  targets: {
    info: () => ipcRenderer.invoke('targets:info'),
  },

  pvm: {
    tools: () => ipcRenderer.invoke('pvm:tools'),
    ports: () => ipcRenderer.invoke('serial:list'),
    build: (opts) => ipcRenderer.invoke('pvm:build', opts),
    openBuildFolder: (projectPath) => ipcRenderer.invoke('pvm:openBuildFolder', projectPath),
    exportProject: (opts) => ipcRenderer.invoke('pvm:exportProject', opts),
    run: (opts) => ipcRenderer.invoke('pvm:run', opts),
    flash: (opts) => ipcRenderer.invoke('pvm:flash', opts),
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
