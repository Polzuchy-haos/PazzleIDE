#!/usr/bin/env node
// Командная строка VisualIDE: код HLC, сборка и запуск проектов .vide без интерфейса.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import * as Blockly from 'blockly';
import {createLanguage, generateCode, parseProject} from '../core/index.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = `VisualIDE CLI (PVM)

  vide hlc   <проект.vide> [-o файл.hlc]           код PVM HLC из блоков (по умолчанию — в stdout)
  vide build <проект.vide> [-o папка]              собрать: hlc, pvms, bin, hex, C-массив, листинг, карта отладки
  vide run   <проект.vide> [--port COM3] [--baud 9600]
                                                  собрать и выполнить: в симуляторе, а с --port — на плате
                                                  (программа с хоста, pvmdbg --host)

  --tools <папка>   утилиты PVM (иначе PVM_HOME, ../pvm/Release, PATH)
  --raw             не фильтровать вывод симулятора
`;

function parseArgs(argv) {
  const args = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--tools') args.tools = argv[++i];
    else if (a === '--port') args.port = argv[++i];
    else if (a === '--baud') args.baud = Number(argv[++i]);
    else if (a === '--raw') args.raw = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, file] = args._;
  if (args.help || !command) return process.stdout.write(USAGE);
  if (!['hlc', 'build', 'run'].includes(command)) fail(USAGE);
  if (!file) fail('Укажите файл проекта .vide');

  const pack = JSON.parse(fs.readFileSync(path.join(root, 'languages', 'pvm.json'), 'utf8'));
  const language = createLanguage(pack);
  let project;
  try {
    project = parseProject(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(e.message);
  }
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(project.workspace, ws);
  const {code, warnings, error} = generateCode(language, ws);
  if (error) fail(error);
  for (const w of warnings) process.stderr.write(`Предупреждение: ${w}\n`);

  if (command === 'hlc') {
    if (args.out) fs.writeFileSync(args.out, code);
    else process.stdout.write(code);
    return;
  }

  const {locateTools} = require('../main/pvm/tools.cjs');
  const {buildProgram} = require('../main/pvm/build.cjs');
  const tools = locateTools({configured: args.tools, appRoot: root});
  if (!tools.dir) fail('Утилиты PVM не найдены: укажите --tools <папка Release> или переменную PVM_HOME');

  const buildDir = path.resolve(args.out || path.join(path.dirname(file), path.parse(file).name + '.build'));
  const result = await buildProgram({code, buildDir, tools, onOutput: ({stream, text}) => process.stderr.write(stream === 'stdout' ? text : text)});
  if (!result.ok) fail(`Сборка не удалась (${result.stage})`);
  process.stderr.write(`Собрано в ${buildDir}\n`);
  if (command === 'build') return;

  if (args.port) {
    const {DebugSession} = require('../main/pvm/debug.cjs');
    const s = new DebugSession({target: 'board-host', pvmdbg: tools.found.pvmdbg, files: result.files, port: args.port, baud: args.baud || 9600});
    s.on('output', ({text}) => process.stdout.write(text));
    s.on('state', async (st) => {
      if (st.status !== 'stopped' || st.reason === 'entry') return;
      const vars = st.variables.map((v) => `${v.name}=${v.values?.join(',') ?? '?'}`).join(' ');
      process.stdout.write(`${st.reason === 'halted' ? 'Программа завершена' : 'Остановка: ' + st.reason}. ${vars}\n`);
      await s.stop();
      process.exit(st.reason === 'halted' ? 0 : 1);
    });
    process.on('SIGINT', async () => {
      await s.stop();
      process.exit(130);
    });
    await s.start();
    await s.setBreakpoints([]);
    s.continue();
    return;
  }

  const {spawn} = await import('node:child_process');
  const {createLineFilter} = require('../main/runner.cjs');
  const filter = args.raw ? null : createLineFilter(pack.outputFilter);
  const child = spawn(tools.found.pvmsim, [result.files.bin], {cwd: buildDir});
  child.stdout.on('data', (d) => process.stdout.write(filter ? filter.push(d.toString()) : d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('close', (c) => {
    if (filter) process.stdout.write(filter.flush());
    process.exit(c ?? 1);
  });
}

main();
