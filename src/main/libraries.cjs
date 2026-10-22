// Библиотеки пазлов (*.pzlib): свои функции, константы и фрагменты из блоков.
// Лежат в папке библиотек пользователя и в папке «libraries» открытой в IDE папки.
'use strict';
const fs = require('fs');
const path = require('path');

const LIBRARY_FORMAT = 'pazzleide-library';
const EXT = '.pzlib';

function readLibrary(file, source) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.format !== LIBRARY_FORMAT || !Array.isArray(data.items)) return null;
    return {
      ...data,
      id: file,
      file,
      source,
      name: String(data.name || path.basename(file, EXT)),
      description: String(data.description || ''),
    };
  } catch {
    return null;
  }
}

/** Все библиотеки из папок [{dir, source}] по имени; одинаковые файлы не повторяются. */
function listLibraries(dirs) {
  const out = [];
  const seen = new Set();
  for (const {dir, source} of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(EXT));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const key = path.resolve(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const lib = readLibrary(file, source);
      if (lib) out.push(lib);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Имя файла из названия библиотеки: без запрещённых символов. */
function fileNameFor(name) {
  const base = String(name || 'библиотека').trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\.+$/, '') || 'библиотека';
  return base.slice(0, 80) + EXT;
}

/** Сохраняет библиотеку: в её файл или новый файл в dir (имя не занимает чужой файл). */
function saveLibrary(lib, {file, dir}) {
  let target = file;
  if (!target) {
    fs.mkdirSync(dir, {recursive: true});
    const name = fileNameFor(lib.name);
    target = path.join(dir, name);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, name.replace(EXT, ` (${i})${EXT}`));
  }
  const {id, file: _f, source, ...data} = lib;
  const out = {format: LIBRARY_FORMAT, version: 1, language: 'pvm', ...data};
  out.format = LIBRARY_FORMAT;
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return target;
}

module.exports = {LIBRARY_FORMAT, EXT, listLibraries, readLibrary, saveLibrary, fileNameFor};
