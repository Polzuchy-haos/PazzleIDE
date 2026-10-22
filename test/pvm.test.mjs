// Сквозные тесты с настоящими утилитами PVM: сборка примеров и отладка в симуляторе.
// Утилиты ищутся как в IDE (PVM_HOME, ../pvm/Release, PATH); если их нет — тесты пропускаются.
// Плата: PVM_BOARD_PORT=COM3 [PVM_BOARD_BAUD=9600] — тогда пример выполняется и на ней.
import {test, describe, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Blockly from 'blockly';
import {createLanguage, generateCode, parseProject} from '../src/core/index.js';

const require = createRequire(import.meta.url);
const {locateTools} = require('../src/main/pvm/tools.cjs');
const {buildProgram} = require('../src/main/pvm/build.cjs');
const {DebugSession} = require('../src/main/pvm/debug.cjs');
const {createLineFilter} = require('../src/main/runner.cjs');
const targets = require('../src/main/targets.cjs');
const {spawnSync} = require('node:child_process');

const root = path.resolve(import.meta.dirname, '..');
const pvm = createLanguage(JSON.parse(fs.readFileSync(path.join(root, 'languages', 'pvm.json'), 'utf8')));
const tools = locateTools({appRoot: root});
const skip = !tools.dir && 'утилиты PVM не найдены (PVM_HOME)';

function generate(example) {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(parseProject(fs.readFileSync(path.join(root, 'examples', example), 'utf8')).workspace, ws);
  return {ws, ...generateCode(pvm, ws)};
}

async function build(example) {
  const g = generate(example);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-pvm-'));
  const r = await buildProgram({code: g.code, buildDir: dir, tools});
  assert.equal(r.ok, true, `${example}: ${r.log}\n${g.code}`);
  return {...g, build: r};
}

// Сессии закрываются и при упавшей проверке — иначе pvmdbg держит процесс тестов.
const opened = [];
after(async () => {
  for (const s of opened) await s.stop();
});

/** Запускает сессию; next() — промис следующей остановки. */
function session(files, options = {}) {
  const s = new DebugSession({pvmdbg: tools.found.pvmdbg, files, target: 'sim', ...options});
  opened.push(s);
  const stops = [];
  const output = [];
  let waiter = null;
  s.on('state', (st) => {
    if (st.status === 'stopped') {
      stops.push(st);
      waiter?.(st);
    }
  });
  s.on('output', (o) => output.push(o.text));
  const next = () => new Promise((resolve) => (waiter = resolve));
  return {s, stops, output, next};
}

const vars = (st) => Object.fromEntries(st.variables.map((v) => [v.name, v.words > 1 ? v.values : v.values?.[0]]));
const vars_ = vars;

const EXPECTED = {
  '01-migalka.pzl': {pereklyucheniy: 6, LED: 0},
  '02-faktorial.pzl': {rezultat: 5040, OUT: 5040},
  '03-prostye-chisla.pzl': {skolko: 15, poslednee: 47, OUT: 15},
  '04-begushchiy-ogon.pzl': {bit: 256, LED: 0},
  '05-konstanty.pzl': {schyot: 4, LED: 0, OUT: 8},
  '06-lokalnye-peremennye.pzl': {otvet: 55, OUT: 55},
};

describe('PVM: сборка и выполнение примеров в симуляторе', {skip, timeout: 120_000}, () => {
  for (const [example, expected] of Object.entries(EXPECTED)) {
    test(example, async () => {
      const {build: b} = await build(example);
      for (const f of ['bin', 'lst', 'map', 'hex', 'carray']) assert.ok(fs.existsSync(b.files[f]), f);
      const {s, next} = session(b.files);
      const entry = next();
      await s.start();
      assert.equal((await entry).reason, 'entry');
      const end = next();
      s.continue();
      const st = await end;
      assert.equal(st.reason, 'halted');
      const v = vars(st);
      for (const [name, value] of Object.entries(expected)) assert.equal(v[name], value, name);
      await s.stop();
    });
  }
});

describe('PVM: отладка', {skip, timeout: 120_000}, () => {
  test('точка останова на блоке, шаги, регистр вывода', async () => {
    const {build: b, lineBlocks, ws} = await build('02-faktorial.pzl');
    const ifReturn = ws.getAllBlocks(false).find((x) => x.type === 'procedures_ifreturn');
    const line = Number(Object.entries(lineBlocks).find(([, id]) => id === ifReturn.id)[0]);
    const {s, next} = session(b.files);
    let wait = next();
    await s.start();
    await wait;
    await s.setBreakpoints([line]);

    wait = next();
    s.continue();
    let st = await wait;
    assert.equal(st.reason, 'breakpoint');
    assert.equal(st.line, line);
    assert.equal(st.func, 'faktorial');

    wait = next();
    s.continue(); // следующий уровень рекурсии — та же точка останова
    st = await wait;
    assert.equal(st.reason, 'breakpoint');

    await s.setBreakpoints([]);
    wait = next();
    s.stepLine('out');
    st = await wait;
    assert.equal(st.reason, 'step');

    wait = next();
    s.continue();
    st = await wait;
    assert.equal(st.reason, 'halted');
    assert.equal(vars(st).rezultat, 5040);
    assert.equal(vars(st).OUT, 5040); // «напечатать» пишет в регистр вывода 0x4007
    await s.stop();
  });

  test('стек вызовов: рекурсия, параметры каждого кадра', async () => {
    const {build: b, lineBlocks, ws} = await build('02-faktorial.pzl');
    const ifReturn = ws.getAllBlocks(false).find((x) => x.type === 'procedures_ifreturn');
    const line = Number(Object.entries(lineBlocks).find(([, id]) => id === ifReturn.id)[0]);
    const {s, next} = session(b.files);
    let wait = next();
    await s.start();
    await wait;
    await s.setBreakpoints([line]);
    for (let hit = 0; hit < 3; hit++) {
      wait = next();
      s.continue();
      await wait;
    }
    const st = s.last;
    assert.deepEqual(
      st.frames.map((f) => [f.func, f.vars.find((v) => v.name === 'n')?.value ?? null]),
      [['faktorial', 5], ['faktorial', 6], ['faktorial', 7], ['main', null]],
    );
    assert.equal(st.frames[0].line, line);
    assert.ok(st.frames[1].line > line, 'внешний кадр стоит на строке рекурсивного вызова');
    await s.stop();
  });

  test('запуск в pvmsim: вывод программы — записи в 0x4007', async () => {
    const {build: b} = await build('03-prostye-chisla.pzl');
    const r = spawnSync(tools.found.pvmsim, [b.files.bin], {encoding: 'utf8', maxBuffer: 64 << 20});
    const f = createLineFilter(pvm.pack.outputFilter);
    assert.equal(f.push(r.stdout) + f.flush(), '15\n');
  });

  test('локальные переменные: у каждого кадра рекурсии свои значения', async () => {
    const {build: b, code} = await build('06-lokalnye-peremennye.pzl');
    const line = code.split('\n').findIndex((l) => /return levoe \+ pravoe;/.test(l)) + 1;
    const {s, next} = session(b.files);
    let wait = next();
    await s.start();
    await wait;
    await s.setBreakpoints([line]);
    wait = next();
    s.continue();
    const st = await wait;
    assert.equal(st.reason, 'breakpoint');
    // fibonachchi(10) -> ... -> fibonachchi(2): 9 кадров функции и main
    assert.equal(st.frames.length, 10);
    const top = Object.fromEntries(st.frames[0].vars.map((v) => [v.name, v.value]));
    assert.deepEqual(top, {n: 2, levoe: 1, pravoe: 0});
    assert.equal(st.frames[0].vars.find((v) => v.name === 'levoe').kind, 'local');
    assert.equal(st.frames.at(-1).func, 'main');
    assert.ok(!st.variables.some((v) => ['levoe', 'pravoe', 'n'].includes(v.name)), 'локальные не в глобальных');
    await s.stop();
  });

  test('программа завершается на блоке «конец программы»', async () => {
    const {build: b, lineBlocks, ws} = await build('03-prostye-chisla.pzl');
    const end = ws.getAllBlocks(false).find((x) => x.type === 'pvm_end');
    const line = Number(Object.entries(lineBlocks).find(([, id]) => id === end.id)[0]);
    const {s, next} = session(b.files);
    let wait = next();
    await s.start();
    await wait;
    await s.setBreakpoints([line]); // HALT сам по себе причина остановки: агент сообщает «halted»
    wait = next();
    s.continue();
    const st = await wait;
    assert.ok(['breakpoint', 'halted'].includes(st.reason), st.reason);
    assert.equal(st.line, line); // подсвечен блок «конец программы»
    assert.match(st.instruction, /^HALT/);
    assert.equal(vars(st).OUT, 15);
    await s.stop();
  });

  test('шаг с обходом не заходит в функцию', async () => {
    const {build: b, code} = await build('02-faktorial.pzl');
    const callLine = code.split('\n').findIndex((l) => /rezultat = faktorial/.test(l)) + 1;
    const {s, next} = session(b.files);
    let wait = next();
    await s.start();
    await wait;
    await s.setBreakpoints([callLine]);
    wait = next();
    s.continue();
    assert.equal((await wait).line, callLine);
    await s.setBreakpoints([]);
    wait = next();
    s.stepLine('over');
    const st = await wait;
    assert.equal(st.func, 'main');
    assert.equal(st.line, callLine + 1);
    assert.equal(vars(st).rezultat, 5040);
    await s.stop();
  });
});

describe('PVM: цели', {skip, timeout: 120_000}, () => {
  test('ограничения памяти цели: программа, которая не помещается, не собирается', async () => {
    const g = generate('03-prostye-chisla.pzl'); // три глобальные переменные
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-pvm-'));
    const tight = await buildProgram({code: g.code, buildDir: dir, tools, limits: {ram: 2}});
    assert.equal(tight.ok, false);
    assert.match(tight.log, /does not fit in RAM \(2 words\)/);
    const roomy = await buildProgram({code: g.code, buildDir: dir, tools, limits: {code: 4096, ram: 16, stack: 64}});
    assert.equal(roomy.ok, true, roomy.log);
    assert.equal(roomy.memory.ram.total, 16);
    assert.equal(roomy.memory.stack.total, 64);
    assert.equal(roomy.memory.code.total, 4096);
    const tiny = await buildProgram({code: g.code, buildDir: dir, tools, limits: {code: 8}});
    assert.equal(tiny.ok, false);
    assert.match(tiny.log, /exceeds the declared \.code size of 8 bytes/);
  });

  test('блок «память» в проекте важнее ограничения цели', async () => {
    const g = generate('01-migalka.pzl'); // section ram 64 из блока
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-pvm-'));
    const r = await buildProgram({code: g.code, buildDir: dir, tools, limits: {ram: 8}});
    assert.equal(r.ok, true, r.log);
    assert.deepEqual(r.limits.own, ['ram']);
    assert.equal(r.memory.ram.total, 64);
  });

  // pvmboard — «плата-процесс» по TCP; мост цели запускает её, pvmdbg подключается по --tcp.
  const pvmboard = [tools.found.pvmboard, path.join(root, '..', 'pvm', 'build', 'debugger', 'pvmboard.exe'), path.join(root, 'vendor', 'pvm', 'pvmboard.exe'), path.join(root, '..', 'pvm', 'build', 'debugger', 'pvmboard')].find(
    (p) => p && fs.existsSync(p),
  );
  test('цель по TCP с мостом (pvmboard): прошитая программа отлаживается до HALT', {skip: !pvmboard && 'нет pvmboard'}, async () => {
    const {build: b} = await build('02-faktorial.pzl');
    const target = targets.normalizeTarget({
      mode: 'board-flash',
      connection: 'tcp',
      tcp: '5577',
      bridge: `"${pvmboard}" "\${bin}" --listen \${tcpPort} --paused --once`,
      bridgeReady: 'debugger on',
    });
    const vars = targets.targetVariables({target, files: b.files, tools});
    const env = targets.commandEnv(vars, target.env);
    let log = '';
    const bridge = await targets.startBridge({...target, bridge: targets.expandVariables(target.bridge, vars, env)}, {env, onOutput: (o) => (log += o.text)});
    try {
      const {s, next} = session(b.files, {target: 'board-flash', link: targets.pvmdbgLink(target)});
      let wait = next();
      await s.start();
      await wait;
      wait = next();
      s.continue();
      const st = await wait;
      assert.equal(st.reason, 'halted');
      assert.equal(vars_(st).rezultat, 5040);
      await s.stop();
      assert.match(log, /debugger connected/);
    } finally {
      bridge.stop();
    }
  });
});

const port = process.env.PVM_BOARD_PORT;
describe('PVM: плата (программа с хоста)', {skip: skip || (!port && 'не задан PVM_BOARD_PORT'), timeout: 300_000}, () => {
  test('01-migalka на плате', async () => {
    const {build: b} = await build('01-migalka.pzl');
    const {s, next} = session(b.files, {target: 'board-host', port, baud: Number(process.env.PVM_BOARD_BAUD || 9600)});
    let wait = next();
    await s.start();
    await wait;
    wait = next();
    s.runFree();
    const st = await wait;
    assert.equal(st.reason, 'halted');
    assert.equal(vars(st).pereklyucheniy, 6);
    await s.stop();
  });
});
