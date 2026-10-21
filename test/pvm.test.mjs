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

const EXPECTED = {
  '01-migalka.pzl': {pereklyucheniy: 6, LED: 0},
  '02-faktorial.pzl': {rezultat: 5040},
  '03-prostye-chisla.pzl': {skolko: 15, poslednee: 47},
  '04-begushchiy-ogon.pzl': {bit: 256, LED: 0},
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
  test('точка останова на блоке, шаги, вывод программы', async () => {
    const {build: b, lineBlocks, ws} = await build('02-faktorial.pzl');
    const ifReturn = ws.getAllBlocks(false).find((x) => x.type === 'procedures_ifreturn');
    const line = Number(Object.entries(lineBlocks).find(([, id]) => id === ifReturn.id)[0]);
    const {s, next, output} = session(b.files);
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
    assert.match(output.join(''), /5040/);
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
