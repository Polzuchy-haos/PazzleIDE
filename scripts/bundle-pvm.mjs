// Собирает утилиты PVM из исходников и кладёт их в vendor/pvm — оттуда они попадают
// в дистрибутив PazzleIDE (resources/pvm), и IDE работает без отдельной установки PVM.
//
//   node scripts/bundle-pvm.mjs [--src ../pvm] [--no-build]
//
// Нужны CMake и компилятор C/C++ (на Windows — MinGW-w64).
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const src = path.resolve(opt('--src', process.env.PVM_SRC || path.join(root, '..', 'pvm')));
const buildDir = path.join(root, 'vendor', 'pvm-build');
const out = path.join(root, 'vendor', 'pvm');
const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? n + '.exe' : n);

function run(cmd, cmdArgs) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, {stdio: 'inherit'});
  if (r.status !== 0) {
    console.error(`Команда завершилась с ошибкой (${r.status ?? r.error?.message})`);
    process.exit(1);
  }
}

/** Где лежит компилятор (для MinGW рядом с ним — libwinpthread-1.dll). */
function compilerDir() {
  const r = spawnSync(isWin ? 'where' : 'which', ['gcc'], {encoding: 'utf8'});
  const first = r.stdout?.split(/\r?\n/).find(Boolean);
  return first ? path.dirname(first) : null;
}

if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
  console.error(`Исходники PVM не найдены: ${src} (укажите --src или PVM_SRC)`);
  process.exit(1);
}

if (!args.includes('--no-build')) {
  const generator = isWin ? ['-G', 'MinGW Makefiles'] : [];
  run('cmake', ['-S', src, '-B', buildDir, ...generator, '-DCMAKE_BUILD_TYPE=Release']);
  run('cmake', ['--build', buildDir, '-j', '8']);
}

const tools = {
  pvmcc: 'hlc',
  pvmc: 'compilator',
  pvmdisasm: 'compilator',
  pvmsim: 'simulator',
  pvmdbg: 'debugger',
  pvminit: 'pvminit',
};
// Необязательные: pvmboard — «плата-процесс» по TCP, чтобы проверять цели с TCP и мостом без железа.
const optional = {pvmboard: 'debugger'};

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});
for (const [tool, dir] of Object.entries(tools)) {
  const from = path.join(buildDir, dir, exe(tool));
  if (!fs.existsSync(from)) {
    console.error(`Нет ${from} — сборка PVM не завершилась?`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(out, exe(tool)));
}
for (const [tool, dir] of Object.entries(optional)) {
  const from = path.join(buildDir, dir, exe(tool));
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, exe(tool)));
  else console.warn(`Нет ${from} — ${tool} не войдёт в дистрибутив`);
}
// lib/ рядом с pvmcc: там import ищет mathlib, time и т.п.
fs.cpSync(path.join(src, 'lib'), path.join(out, 'lib'), {recursive: true});
for (const f of ['LICENSE', 'README.md', 'README.en.md']) {
  if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(out, f === 'LICENSE' ? 'LICENSE.pvm' : f));
}

// MinGW: libgcc/libstdc++ слинкованы статически, а winpthread — нет.
if (isWin) {
  const dll = compilerDir() && path.join(compilerDir(), 'libwinpthread-1.dll');
  if (dll && fs.existsSync(dll)) fs.copyFileSync(dll, path.join(out, 'libwinpthread-1.dll'));
  else console.warn('Внимание: libwinpthread-1.dll не найдена — на машине без MinGW утилиты могут не запуститься');
}

const commit = spawnSync('git', ['-C', src, 'log', '-1', '--format=%h %cs %s'], {encoding: 'utf8'}).stdout?.trim();
fs.writeFileSync(path.join(out, 'VERSION.txt'), `PVM ${commit || '(версия неизвестна)'}\nСобрано: ${new Date().toISOString()}\n`);

console.log(`Утилиты PVM: ${out}`);
for (const f of fs.readdirSync(out)) console.log('  ' + f);
