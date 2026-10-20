// Поиск утилит PVM (pvmcc, pvmc, pvmsim, pvmdbg, pvminit).
'use strict';
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? name + '.exe' : name);
const TOOLS = ['pvmcc', 'pvmc', 'pvmsim', 'pvmdbg', 'pvminit', 'pvmdisasm'];

function hasCompiler(dir) {
  return !!dir && fs.existsSync(path.join(dir, exe('pvmcc'))) && fs.existsSync(path.join(dir, exe('pvmc')));
}

/**
 * Папка с утилитами, по порядку: из настроек, из переменной PVM_HOME, встроенные
 * в дистрибутив (resources/pvm), рядом с VisualIDE (../pvm/Release — так лежат
 * репозитории при разработке), собранные скриптом bundle-pvm (vendor/pvm), из PATH.
 */
function locateTools({configured, appRoot} = {}) {
  const resources = process.resourcesPath && !/node_modules[\\/]electron[\\/]dist/.test(process.resourcesPath) ? process.resourcesPath : null;
  const candidates = [
    configured && {dir: configured, source: 'настройки'},
    process.env.PVM_HOME && {dir: process.env.PVM_HOME, source: 'PVM_HOME'},
    resources && {dir: path.join(resources, 'pvm'), source: 'встроенные'},
    appRoot && {dir: path.resolve(appRoot, '..', 'pvm', 'Release'), source: 'рядом с VisualIDE'},
    appRoot && {dir: path.join(appRoot, 'vendor', 'pvm'), source: 'vendor/pvm'},
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => ({dir, source: 'PATH'})),
  ].filter(Boolean);

  for (const c of candidates) {
    if (hasCompiler(c.dir)) return describe(path.resolve(c.dir), c.source);
  }
  return {dir: null, source: null, found: {}, missing: TOOLS.slice()};
}

function describe(dir, source) {
  const found = {};
  const missing = [];
  for (const t of TOOLS) {
    const p = path.join(dir, exe(t));
    if (fs.existsSync(p)) found[t] = p;
    else missing.push(t);
  }
  return {dir, source, found, missing};
}

module.exports = {locateTools, TOOLS};
