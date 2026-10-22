// Сборка программы PVM: main.hlc -> pvmcc -> main.pvms -> pvmc -> bin, hex, C-массив, листинг, карта отладки.
'use strict';
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');
const {loadListing} = require('./artifacts.cjs');

/** Запускает утилиту и собирает вывод; onOutput получает текст по мере появления. */
function runTool(cmd, args, {cwd, onOutput} = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    onOutput?.({stream: 'command', text: `$ ${[path.basename(cmd), ...args].join(' ')}\n`});
    let child;
    try {
      child = spawn(cmd, args, {cwd, windowsHide: true});
    } catch (e) {
      resolve({code: -1, stdout, stderr: e.message});
      return;
    }
    const decoder = {stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8')};
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        const text = decoder[stream].decode(chunk, {stream: true});
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        onOutput?.({stream, text});
      });
    }
    child.on('error', (e) => {
      stderr += e.message;
      onOutput?.({stream: 'stderr', text: `Не удалось запустить ${cmd}: ${e.message}\n`});
    });
    child.on('close', (code) => resolve({code: code ?? -1, stdout, stderr}));
  });
}

/** «main.hlc:12: error: unknown identifier 'x'» -> {file, line, message}. */
function parseErrors(text) {
  const errors = [];
  for (const m of String(text).matchAll(/^(.*?):(\d+):\s*error:\s*(.+)$/gm)) {
    errors.push({file: m[1].trim(), line: Number(m[2]), message: m[3].trim()});
  }
  return errors;
}

/**
 * Ограничения памяти цели (код, RAM, стек) -> объявления section в конце кода:
 * номера строк не сдвигаются. Секцию, которую код объявляет сам, не трогаем —
 * его объявление важнее (в HLC каждая секция объявляется не больше одного раза).
 * Возвращает {code, applied: {вид: размер}, own: [виды, объявленные в коде]}.
 */
function applyLimits(code, limits = {}) {
  const applied = {};
  const own = [];
  const lines = [];
  for (const kind of ['code', 'ram', 'stack']) {
    const value = limits?.[kind];
    if (!value) continue;
    if (new RegExp(`^\\s*section\\s+${kind}\\b`, 'm').test(code)) {
      own.push(kind);
      continue;
    }
    applied[kind] = value;
    lines.push(`section ${kind} ${value};`);
  }
  if (!lines.length) return {code, applied, own};
  const text = code.replace(/\n*$/, '\n') + '\n// Ограничения памяти цели (PazzleIDE)\n' + lines.join('\n') + '\n';
  return {code: text, applied, own};
}

/**
 * Путь для -I относительно папки сборки (обычно «..»: она лежит рядом с исходником).
 * Утилиты PVM на Windows не понимают не-ASCII в аргументах (pvmcc: «Cannot convert
 * character sequence»), поэтому путь с кириллицей не передаётся вовсе.
 */
function includeArg(buildDir, dir) {
  if (!dir) return null;
  const ascii = (p) => /^[\x20-\x7e]*$/.test(p);
  const rel = path.relative(buildDir, dir) || '.';
  if (ascii(rel)) return rel;
  return ascii(dir) ? dir : null;
}

/**
 * Собирает программу в buildDir. Возвращает
 * {ok, dir, files: {hlc, pvms, bin, lst, map, hex, carray}, errors, stack, listing, limits}.
 * limits — ограничения памяти цели, includeDirs — где ещё искать import (папка исходника).
 */
async function buildProgram({code, buildDir, tools, name = 'main', limits, includeDirs = [], onOutput}) {
  fs.mkdirSync(buildDir, {recursive: true});
  const files = {
    hlc: path.join(buildDir, `${name}.hlc`),
    pvms: path.join(buildDir, `${name}.pvms`),
    bin: path.join(buildDir, `${name}.bin`),
    lst: path.join(buildDir, `${name}.lst`),
    map: path.join(buildDir, `${name}.dbgmap`),
    hex: path.join(buildDir, `${name}.hex`),
    carray: path.join(buildDir, `${name}.c`),
  };
  for (const f of [files.pvms, files.bin, files.lst, files.map, files.hex, files.carray]) fs.rmSync(f, {force: true});
  const limited = applyLimits(code, limits);
  fs.writeFileSync(files.hlc, limited.code, 'utf8');

  const fail = (stage, r) => ({ok: false, stage, dir: buildDir, files, limits: {applied: limited.applied, own: limited.own}, errors: parseErrors(r.stderr + '\n' + r.stdout), log: r.stderr || r.stdout});
  const opts = {cwd: buildDir, onOutput};

  // Имена файлов — относительные: так карта отладки ссылается на «main.hlc».
  // -I: import ищется и рядом с исходным файлом, а не только рядом с копией в папке сборки.
  const includes = includeDirs.map((dir) => includeArg(buildDir, dir)).filter(Boolean).flatMap((dir) => ['-I', dir]);
  let r = await runTool(tools.found.pvmcc, [`${name}.hlc`, '-o', `${name}.pvms`, ...includes], opts);
  if (r.code !== 0) return fail('pvmcc', r);
  const stack = /stack:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || null;

  r = await runTool(tools.found.pvmc, [`${name}.pvms`, '-o', `${name}.bin`, '-f', 'bin', '-l', `${name}.lst`, '-g', `${name}.dbgmap`], opts);
  if (r.code !== 0) return fail('pvmc', r);
  r = await runTool(tools.found.pvmc, [`${name}.pvms`, '-o', `${name}.hex`, '-f', 'hex'], opts);
  if (r.code !== 0) return fail('pvmc', r);
  r = await runTool(tools.found.pvmc, [`${name}.pvms`, '-o', `${name}.c`, '-f', 'carray'], opts);
  if (r.code !== 0) return fail('pvmc', r);

  const listing = loadListing(files.lst);
  return {
    ok: true,
    dir: buildDir,
    files,
    errors: [],
    stack,
    memory: listing.memory,
    functions: listing.functions,
    variables: listing.variables,
    size: fs.statSync(files.bin).size,
    limits: {applied: limited.applied, own: limited.own},
  };
}

module.exports = {buildProgram, runTool, parseErrors, applyLimits};
