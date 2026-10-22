// Цели — где и как выполняется программа: симулятор, плата по порту или по TCP,
// утилита-мост, команды прошивки и запуска, ограничения памяти. Встроенные цели
// можно менять, к ним добавляются свои. В командах подставляются переменные
// ${имя}; те же значения получают запущенные процессы как переменные окружения PAZZLE_*.
'use strict';
const {spawn, execFileSync} = require('child_process');
const path = require('path');

const MODES = ['sim', 'board-host', 'board-flash'];
const LIMIT_KINDS = ['code', 'ram', 'stack'];

/** Размеры по умолчанию (pvm/pvm.h и ассемблер pvmc), если в цели и в коде не заданы. */
const PVM_DEFAULT_LIMITS = {code: 65535, ram: 64, stack: 1024};

/** Заводские ограничения встроенных и новых целей: небольшая плата — код 1 КБ, RAM и стек по 64 слова. */
const FACTORY_LIMITS = {code: 1024, ram: 64, stack: 64};

const BLANK = {
  id: '',
  name: '',
  mode: 'sim',
  connection: 'serial', // serial | tcp — для плат
  port: 'COM3',
  baud: 9600,
  tcp: '127.0.0.1:5555',
  limits: {code: null, ram: null, stack: null},
  bridge: '', // команда утилиты-моста: запускается перед подключением и завершается после
  bridgeReady: '', // мост готов, когда в его выводе появится этот текст (регулярное выражение)...
  bridgeDelay: 1000, // ... или через столько миллисекунд
  flash: '', // команда «Прошить / загрузить»
  run: '', // своя команда «Запустить» вместо встроенной
  env: '', // дополнительные переменные окружения: строки ИМЯ=значение
};

const DEFAULT_TARGETS = [
  {id: 'sim', name: 'Симулятор (ВМ на компьютере)', mode: 'sim', limits: FACTORY_LIMITS},
  {id: 'board-host', name: 'Плата: программа с хоста', mode: 'board-host', limits: FACTORY_LIMITS},
  {id: 'board-flash', name: 'Плата: прошитая программа', mode: 'board-flash', limits: FACTORY_LIMITS},
];

const positive = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function normalizeTarget(raw, index = 0) {
  const t = {...BLANK, ...(raw || {})};
  t.id = String(t.id || `target-${Date.now().toString(36)}-${index}`);
  t.name = String(t.name || 'Цель').trim() || 'Цель';
  if (!MODES.includes(t.mode)) t.mode = 'sim';
  if (!['serial', 'tcp'].includes(t.connection)) t.connection = 'serial';
  t.baud = positive(t.baud) || 9600;
  t.bridgeDelay = Math.max(0, Number(t.bridgeDelay) || 0);
  const limits = raw?.limits || {};
  t.limits = Object.fromEntries(LIMIT_KINDS.map((k) => [k, positive(limits[k])]));
  for (const k of ['port', 'tcp', 'bridge', 'bridgeReady', 'flash', 'run', 'env']) t[k] = String(t[k] ?? '').trim();
  return t;
}

/**
 * Встроенные цели, сохранённые до появления заводских ограничений (все поля пустые), получают
 * заводские значения — один раз, при переходе настроек на limitsVersion 1.
 */
function applyFactoryLimits(list) {
  const builtIn = new Set(DEFAULT_TARGETS.map((t) => t.id));
  return list.map((t) =>
    builtIn.has(t.id) && LIMIT_KINDS.every((k) => !t.limits?.[k]) ? normalizeTarget({...t, limits: FACTORY_LIMITS}) : t,
  );
}

/** Список целей из настроек; при первом запуске — встроенные с портом и скоростью из старых настроек. */
function normalizeTargets(list, {port, baud} = {}) {
  if (!Array.isArray(list) || !list.length) {
    return DEFAULT_TARGETS.map((t, i) => normalizeTarget({...t, port: port || BLANK.port, baud: baud || BLANK.baud}, i));
  }
  const seen = new Set();
  return list.map(normalizeTarget).filter((t) => !seen.has(t.id) && seen.add(t.id));
}

// ---------------------------------------------------------------- переменные

const VARIABLES = [
  ['projectFile', 'открытый файл: проект пазлов (.pzl) или код (.hlc)'],
  ['projectDir', 'папка этого файла'],
  ['projectName', 'имя файла без расширения'],
  ['workspaceFolder', 'папка, открытая в рабочем столе «IDE» (иначе папка файла)'],
  ['buildDir', 'папка сборки'],
  ['hlc', 'собранный код HLC (main.hlc в папке сборки)'],
  ['pvms', 'ассемблер PVM'],
  ['bin', 'программа (bin)'],
  ['hex', 'программа в Intel HEX'],
  ['carray', 'программа как массив Си (main.c)'],
  ['lst', 'листинг'],
  ['map', 'карта отладки (dbgmap)'],
  ['toolsDir', 'папка утилит PVM'],
  ['pvmcc', 'компилятор HLC'],
  ['pvmc', 'ассемблер'],
  ['pvmsim', 'симулятор'],
  ['pvmdbg', 'отладчик'],
  ['pvminit', 'генератор проектов'],
  ['pvmboard', 'плата-процесс для проверки TCP (если есть в сборке PVM)'],
  ['target', 'название цели'],
  ['port', 'последовательный порт цели'],
  ['baud', 'скорость порта'],
  ['tcp', 'адрес TCP цели (хост:порт)'],
  ['tcpHost', 'хост из адреса TCP'],
  ['tcpPort', 'порт из адреса TCP'],
  ['codeSize', 'ограничение кода, байт (пусто — по умолчанию)'],
  ['ramSize', 'ограничение RAM, слов'],
  ['stackSize', 'ограничение стека, слов'],
  ['appDir', 'папка PazzleIDE'],
];

/** projectFile -> PAZZLE_PROJECT_FILE */
const envName = (name) => 'PAZZLE_' + name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** Значения переменных для цели и сборки. */
function targetVariables({target, files = {}, projectPath, folder, tools = {}, appDir}) {
  const projectDir = projectPath ? path.dirname(projectPath) : folder || '';
  const [tcpHost, tcpPort] = splitTcp(target?.tcp || '');
  const limits = target?.limits || {};
  return {
    projectFile: projectPath || '',
    projectDir,
    projectName: projectPath ? path.parse(projectPath).name : 'untitled',
    workspaceFolder: folder || projectDir,
    buildDir: files.bin ? path.dirname(files.bin) : '',
    hlc: files.hlc || '',
    pvms: files.pvms || '',
    bin: files.bin || '',
    hex: files.hex || '',
    carray: files.carray || '',
    lst: files.lst || '',
    map: files.map || '',
    toolsDir: tools.dir || '',
    pvmcc: tools.found?.pvmcc || '',
    pvmc: tools.found?.pvmc || '',
    pvmsim: tools.found?.pvmsim || '',
    pvmdbg: tools.found?.pvmdbg || '',
    pvminit: tools.found?.pvminit || '',
    pvmboard: tools.found?.pvmboard || '',
    target: target?.name || '',
    port: target?.port || '',
    baud: String(target?.baud || ''),
    tcp: target?.tcp || '',
    tcpHost,
    tcpPort,
    codeSize: limits.code ? String(limits.code) : '',
    ramSize: limits.ram ? String(limits.ram) : '',
    stackSize: limits.stack ? String(limits.stack) : '',
    appDir: appDir || '',
  };
}

/** «host:port» или просто «port» (эта машина). */
function splitTcp(text) {
  const m = /^(?:(.*):)?(\d+)$/.exec(String(text).trim());
  if (!m) return [String(text).trim(), ''];
  return [m[1] || '127.0.0.1', m[2]];
}

/** ${имя} — переменная PazzleIDE, ${env:ИМЯ} — переменная окружения; неизвестные остаются как есть. */
function expandVariables(text, vars, env = process.env) {
  return String(text ?? '').replace(/\$\{(env:)?([A-Za-z_][\w]*)\}/g, (all, isEnv, name) => {
    if (isEnv) return env[name] ?? '';
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all;
  });
}

/** Окружение процесса: системное + PAZZLE_* + переменные цели (в них тоже подставляются ${...}). */
function commandEnv(vars, extra = '', base = process.env) {
  const env = {...base};
  for (const [name, value] of Object.entries(vars)) env[envName(name)] = value;
  for (const line of String(extra).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=(.*)$/.exec(line);
    if (m) env[m[1]] = expandVariables(m[2].trim(), vars, env);
  }
  return env;
}

// ---------------------------------------------------------------- процессы

/** Завершает процесс вместе с дочерними (команда идёт через оболочку). */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true}).on('error', () => child.kill());
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill();
    }
  }
}

/**
 * Запускает строку команды через оболочку (cmd.exe / sh): работают кавычки,
 * перенаправления и &&. Возвращает {child, done: Promise<{code}>}.
 */
let oemDecoder;

/**
 * Кодировка консольных программ Windows (OEM: cp866 в русской системе). cmd.exe и
 * многие утилиты пишут в ней, а не в UTF-8, когда вывод идёт в канал.
 */
function legacyDecoder() {
  if (oemDecoder !== undefined) return oemDecoder;
  oemDecoder = null;
  if (process.platform !== 'win32') return oemDecoder;
  try {
    const text = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], {encoding: 'utf8', windowsHide: true});
    const cp = /OEMCP\s+REG_SZ\s+(\d+)/.exec(text)?.[1];
    if (cp && cp !== '65001') oemDecoder = new TextDecoder(`cp${cp}`);
  } catch {
    // нет реестра или кодовой страницы нет в TextDecoder — остаёмся на UTF-8
  }
  return oemDecoder;
}

/**
 * Вывод процесса построчно: строка, которая не читается как UTF-8, — в OEM-кодировке.
 * Хвост без перевода строки (индикатор прогресса) отдаётся через 150 мс тишины.
 */
function outputDecoder(emit) {
  const utf8 = new TextDecoder('utf-8', {fatal: true});
  const decode = (bytes) => {
    try {
      return utf8.decode(bytes);
    } catch {
      return (legacyDecoder() || new TextDecoder('utf-8')).decode(bytes);
    }
  };
  let pending = Buffer.alloc(0);
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    if (pending.length) emit(decode(pending));
    pending = Buffer.alloc(0);
  };
  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      const nl = pending.lastIndexOf(10);
      if (nl >= 0) {
        emit(decode(pending.subarray(0, nl + 1)));
        pending = pending.subarray(nl + 1);
      }
      clearTimeout(timer);
      if (pending.length) timer = setTimeout(flush, 150);
    },
    end: flush,
  };
}

function runShell(command, {cwd, env, onOutput} = {}) {
  const child = spawn(command, {
    cwd: cwd || undefined,
    env,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32', // своя группа процессов — чтобы завершить её целиком
  });
  const decoders = {};
  for (const stream of ['stdout', 'stderr']) {
    decoders[stream] = outputDecoder((text) => onOutput?.({stream, text}));
    child[stream].on('data', (chunk) => decoders[stream].push(chunk));
  }
  const done = new Promise((resolve) => {
    child.on('error', (e) => {
      onOutput?.({stream: 'stderr', text: `Не удалось выполнить команду: ${e.message}\n`});
      resolve({code: -1});
    });
    child.on('close', (code, signal) => {
      decoders.stdout.end();
      decoders.stderr.end();
      resolve({code: code ?? -1, signal});
    });
  });
  return {child, done, stop: () => killTree(child)};
}

/**
 * Мост цели: запускает команду и ждёт готовности — текста bridgeReady в выводе или
 * bridgeDelay мс. Возвращает {stop()} или бросает Error, если мост завершился раньше.
 */
async function startBridge(target, {cwd, env, onOutput}) {
  const command = target.bridge;
  let output = '';
  const ready = target.bridgeReady ? safeRegExp(target.bridgeReady) : null;
  const proc = runShell(command, {
    cwd,
    env,
    onOutput: (o) => {
      output = (output + o.text).slice(-4000);
      onOutput?.(o);
      if (ready && ready.test(output)) resolveReady?.();
    },
  });
  let resolveReady;
  const wait = new Promise((resolve, reject) => {
    resolveReady = resolve;
    proc.done.then(({code}) => reject(new Error(`мост завершился (код ${code}) до подключения`)));
    if (!ready) setTimeout(resolve, target.bridgeDelay);
    else setTimeout(() => reject(new Error(`мост не сообщил о готовности за 20 с (ждали «${target.bridgeReady}»)`)), 20000);
  });
  try {
    await wait;
  } catch (e) {
    proc.stop();
    throw e;
  }
  return {child: proc.child, done: proc.done, stop: proc.stop};
}

function safeRegExp(text) {
  try {
    return new RegExp(text);
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

/** Аргументы подключения pvmdbg к плате цели. */
function pvmdbgLink(target) {
  if (target.connection === 'tcp') return ['--tcp', target.tcp];
  return ['--port', target.port, '--baud', String(target.baud || 9600)];
}

/** Описание подключения для консоли: «COM3, 9600» или «TCP 127.0.0.1:5555». */
function describeLink(target) {
  if (target.mode === 'sim') return 'симулятор';
  return target.connection === 'tcp' ? `TCP ${target.tcp}` : `${target.port}, ${target.baud}`;
}

module.exports = {
  MODES,
  LIMIT_KINDS,
  PVM_DEFAULT_LIMITS,
  FACTORY_LIMITS,
  DEFAULT_TARGETS,
  applyFactoryLimits,
  VARIABLES,
  normalizeTarget,
  normalizeTargets,
  targetVariables,
  expandVariables,
  commandEnv,
  envName,
  splitTcp,
  runShell,
  killTree,
  startBridge,
  pvmdbgLink,
  describeLink,
};
