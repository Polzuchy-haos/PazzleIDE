// Файлы для рабочего стола «IDE»: дерево папки, чтение и запись, создание,
// переименование, удаление в корзину, слежение за изменениями.
'use strict';
const fs = require('fs');
const path = require('path');

const HIDDEN = new Set(['.git', '.svn', '.hg', 'node_modules', '.DS_Store', 'Thumbs.db']);
const MAX_TEXT = 4 * 1024 * 1024;

/** Содержимое папки: сначала папки, потом файлы, по имени. */
function listDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return [];
  }
  return entries
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => ({name: e.name, path: path.join(dir, e.name), dir: e.isDirectory()}))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'ru', {numeric: true, sensitivity: 'base'})));
}

/** Текст файла или {binary: true}, если это не текст (нулевые байты) или файл слишком большой. */
function readText(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_TEXT) return {binary: true, size: stat.size};
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8000).includes(0)) return {binary: true, size: stat.size};
  return {content: buffer.toString('utf8').replace(/^﻿/, '')};
}

function createEntry(target, {dir = false, content = ''} = {}) {
  if (fs.existsSync(target)) throw new Error(`«${path.basename(target)}» уже есть`);
  if (dir) fs.mkdirSync(target, {recursive: true});
  else {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content, 'utf8');
  }
  return target;
}

function renameEntry(from, to) {
  if (fs.existsSync(to) && path.resolve(from).toLowerCase() !== path.resolve(to).toLowerCase()) {
    throw new Error(`«${path.basename(to)}» уже есть`);
  }
  fs.renameSync(from, to);
  return to;
}

/** Слежение за папкой (с подпапками); onChange вызывается не чаще раза в 300 мс. */
function watchFolder(dir, onChange) {
  let timer = null;
  const changed = new Set();
  let watcher;
  try {
    watcher = fs.watch(dir, {recursive: true}, (_event, name) => {
      if (name && String(name).split(/[\\/]/).some((part) => HIDDEN.has(part))) return;
      changed.add(name ? path.dirname(path.join(dir, String(name))) : dir);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const dirs = [...changed];
        changed.clear();
        onChange(dirs);
      }, 300);
    });
    watcher.on('error', () => {});
  } catch {
    return {close() {}};
  }
  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

module.exports = {listDir, readText, createEntry, renameEntry, watchFolder};
