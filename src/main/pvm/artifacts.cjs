// Разбор того, что пишет pvmc: карта отладки (-g) и листинг с картой памяти (-l).
'use strict';
const fs = require('fs');
const path = require('path');

const baseName = (p) => path.basename(String(p).replace(/\\/g, '/'));

/**
 * Карта «0xADDR файл:строка». Адрес между двумя записями относится к более ранней:
 * строка исходника обычно превращается в несколько инструкций, помечена только первая.
 */
class SourceMap {
  constructor(entries = []) {
    this.entries = entries.slice().sort((a, b) => a.address - b.address);
  }

  static parse(text) {
    const entries = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      const space = line.indexOf(' ');
      if (space < 0) continue;
      const address = parseInt(line.slice(0, space), 16);
      const rest = line.slice(space + 1);
      const colon = rest.lastIndexOf(':'); // последнее двоеточие: у пути Windows есть своё после буквы диска
      if (colon < 0 || Number.isNaN(address)) continue;
      entries.push({address, file: rest.slice(0, colon), line: Number(rest.slice(colon + 1))});
    }
    return new SourceMap(entries);
  }

  static load(file) {
    try {
      return SourceMap.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return new SourceMap();
    }
  }

  get loaded() {
    return this.entries.length > 0;
  }

  locationFor(address) {
    let best = null;
    for (const e of this.entries) {
      if (e.address > address) break;
      best = e;
    }
    return best;
  }

  /** Наименьший адрес, сгенерированный для строки файла (сравнение по имени файла). */
  addressFor(file, line) {
    const wanted = baseName(file);
    let best = null;
    for (const e of this.entries) {
      if (e.line === line && baseName(e.file) === wanted && (best === null || e.address < best)) best = e.address;
    }
    return best;
  }

  /** Строки файла, для которых есть код (куда можно поставить точку останова). */
  linesOf(file) {
    const wanted = baseName(file);
    return [...new Set(this.entries.filter((e) => baseName(e.file) === wanted).map((e) => e.line))].sort((a, b) => a - b);
  }
}

/** Листинг: карта памяти, функции, переменные и инструкции по адресам. */
function parseListing(text) {
  const result = {memory: {}, functions: [], variables: [], instructions: new Map()};
  let section = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m;
    if ((m = /^#\s+(code|ram|stack|usrsect)\s*:\s*(.+)$/.exec(line))) {
      const value = m[2].trim();
      const used = /^(\d+)\s+of\s+(\d+)\s+(\w+)/.exec(value);
      const total = /^(\d+)\s+(\w+)/.exec(value);
      result.memory[m[1]] = used
        ? {used: +used[1], total: +used[2], unit: used[3], text: value}
        : total
          ? {total: +total[1], unit: total[2], text: value}
          : {text: value};
      continue;
    }
    if (/^#\s+functions:/.test(line)) { section = 'functions'; continue; }
    if (/^#\s+variables:/.test(line)) { section = 'variables'; continue; }
    if (section === 'functions' && (m = /^#\s+0x([0-9A-Fa-f]+)\s+(\S+)/.exec(line))) {
      result.functions.push({address: parseInt(m[1], 16), name: m[2]});
      continue;
    }
    if (section === 'variables' && (m = /^#\s+0x([0-9A-Fa-f]+)\s+(\S+)\s+(\d+)\s+words?\s+(\S+)/.exec(line))) {
      result.variables.push({address: parseInt(m[1], 16), name: m[2], words: +m[3], area: m[4]});
      continue;
    }
    if ((m = /^0x([0-9A-Fa-f]+)\s+((?:[0-9A-Fa-f]{2}\s)+)\s*(.+)$/.exec(line))) {
      section = null;
      result.instructions.set(parseInt(m[1], 16), {bytes: m[2].trim(), text: m[3].trim()});
    }
  }
  return result;
}

function loadListing(file) {
  try {
    return parseListing(fs.readFileSync(file, 'utf8'));
  } catch {
    return parseListing('');
  }
}

/** Функция, которой принадлежит адрес (по таблице функций листинга). */
function functionAt(listing, pc) {
  let best = null;
  for (const f of listing.functions) if (f.address <= pc && (!best || f.address > best.address)) best = f;
  return best ? best.name : null;
}

module.exports = {SourceMap, parseListing, loadListing, functionAt, baseName};
