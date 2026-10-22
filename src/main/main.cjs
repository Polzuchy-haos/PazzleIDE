// Основной процесс Electron: окно, меню, файлы, сборка, запуск, прошивка и отладка программ PVM.
'use strict';
const {app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, clipboard} = require('electron');
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const {Settings} = require('./settings.cjs');
const {createLineFilter} = require('./runner.cjs');
const {locateTools} = require('./pvm/tools.cjs');
const {buildProgram, runTool} = require('./pvm/build.cjs');
const {listPorts} = require('./pvm/serial.cjs');
const {DebugSession} = require('./pvm/debug.cjs');
const targets = require('./targets.cjs');
const files = require('./files.cjs');
const libraries = require('./libraries.cjs');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'dist', 'renderer');
const LANGUAGE_FILE = path.join(ROOT, 'languages', 'pvm.json');
const EXAMPLES_DIR = path.join(ROOT, 'examples');
const DOCS_DIR = path.join(ROOT, 'docs');
const OPENABLE = /\.(pzl|vide|hlc)$/i;

let settings;
let mainWindow = null;
let dirty = false;
let activity = null; // текущий запуск, прошивка или сессия отладки: {kind, stop()}
let folderWatcher = null;
let pendingOpenFile = process.argv.slice(1).find((a) => OPENABLE.test(a) && fs.existsSync(a)) || null;

protocol.registerSchemesAsPrivileged([
  {scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true}},
]);

function registerAppProtocol() {
  // Интерфейс загружается по app://ide/..., а не file:// — так работают Web Workers и CSP.
  protocol.handle('app', (request) => {
    const {pathname} = new URL(request.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', {status: 403});
    return net.fetch(pathToFileURL(file).toString());
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
const command = (id, arg) => () => send('menu', {id, arg});

const tools = () => locateTools({configured: settings.get().pvmTools, appRoot: ROOT});
const librariesDir = () => path.join(app.getPath('userData'), 'libraries');

function listExamples() {
  try {
    return fs
      .readdirSync(EXAMPLES_DIR)
      .filter((f) => f.endsWith('.pzl'))
      .sort()
      .map((f) => {
        let title = f.replace(/^\d+-/, '').replace(/\.pzl$/, '');
        try {
          title = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8')).title || title;
        } catch {
          // имя файла как запасной вариант
        }
        return {file: f, title};
      });
  } catch {
    return [];
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const noIntercept = {registerAccelerator: false}; // клавиши обрабатывает сам интерфейс
  const template = [
    ...(isMac ? [{role: 'appMenu'}] : []),
    {
      label: 'Файл',
      submenu: [
        {label: 'Новый проект пазлов', accelerator: 'CmdOrCtrl+N', click: command('new')},
        {label: 'Новый файл HLC', accelerator: 'CmdOrCtrl+Alt+N', click: command('newHlc')},
        {label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: command('open')},
        {label: 'Открыть папку…', accelerator: 'CmdOrCtrl+Alt+O', click: command('openFolder')},
        {label: 'Примеры', submenu: listExamples().map((e) => ({label: e.title, click: command('example', e.file)}))},
        {type: 'separator'},
        {label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: command('save')},
        {label: 'Сохранить как…', accelerator: 'CmdOrCtrl+Shift+S', click: command('saveAs')},
        {label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', ...noIntercept, click: command('closeTab')},
        {type: 'separator'},
        {label: 'Открыть код HLC как файл', click: command('codeToFile')},
        {label: 'Экспорт кода HLC…', accelerator: 'CmdOrCtrl+E', click: command('export')},
        {label: 'Экспорт проекта (Makefile, VS Code)…', click: command('exportProject')},
        {label: 'Открыть папку сборки', click: command('openBuildFolder')},
        {type: 'separator'},
        {label: 'Настройки…', accelerator: 'CmdOrCtrl+,', click: command('settings')},
        {type: 'separator'},
        isMac ? {role: 'close', label: 'Закрыть'} : {role: 'quit', label: 'Выход'},
      ],
    },
    {
      label: 'Правка',
      submenu: [
        {label: 'Отменить', accelerator: 'CmdOrCtrl+Z', ...noIntercept, click: command('undo')},
        {label: 'Повторить', accelerator: 'CmdOrCtrl+Y', ...noIntercept, click: command('redo')},
        {type: 'separator'},
        {role: 'cut', label: 'Вырезать'},
        {role: 'copy', label: 'Копировать'},
        {role: 'paste', label: 'Вставить'},
        {role: 'selectAll', label: 'Выделить всё'},
      ],
    },
    {
      label: 'Вид',
      submenu: [
        {label: 'Рабочий стол «Пазлы»', accelerator: 'CmdOrCtrl+1', click: command('layout', 'blocks')},
        {label: 'Рабочий стол «HLC»', accelerator: 'CmdOrCtrl+2', click: command('layout', 'hlc')},
        {label: 'Рабочий стол «IDE» (с файлами)', accelerator: 'CmdOrCtrl+3', click: command('layout', 'ide')},
        {type: 'separator'},
        {label: 'Упорядочить блоки', click: command('cleanup')},
        {label: 'Показать все блоки', click: command('zoomFit')},
        {label: 'Светлая / тёмная тема', click: command('toggleTheme')},
        {type: 'separator'},
        {role: 'zoomIn', label: 'Крупнее интерфейс'},
        {role: 'zoomOut', label: 'Мельче интерфейс'},
        {role: 'resetZoom', label: 'Обычный размер'},
        {type: 'separator'},
        {role: 'reload', label: 'Перезагрузить интерфейс'},
        {role: 'toggleDevTools', label: 'Инструменты разработчика'},
      ],
    },
    {
      label: 'Сборка',
      submenu: [
        {label: 'Собрать', accelerator: 'CmdOrCtrl+B', click: command('build')},
        {label: 'Запустить без отладки', accelerator: 'CmdOrCtrl+F5', click: command('run')},
        {label: 'Прошить / загрузить', accelerator: 'CmdOrCtrl+U', click: command('flash')},
        {type: 'separator'},
        {label: 'Отладка / продолжить', accelerator: 'F5', click: command('debug')},
        {label: 'Пауза', accelerator: 'F6', click: command('pause')},
        {label: 'Шаг с обходом', accelerator: 'F10', click: command('stepOver')},
        {label: 'Шаг с заходом', accelerator: 'F11', click: command('stepInto')},
        {label: 'Шаг с выходом', accelerator: 'Shift+F11', click: command('stepOut')},
        {label: 'Шаг на одну инструкцию', accelerator: 'CmdOrCtrl+F11', click: command('stepInstr')},
        {label: 'Сначала (сброс)', accelerator: 'CmdOrCtrl+Shift+F5', click: command('reset')},
        {label: 'Остановить', accelerator: 'Shift+F5', click: command('stop')},
        {type: 'separator'},
        {label: 'Точка останова', accelerator: 'F9', click: command('toggleBreakpoint')},
        {label: 'Очистить консоль', click: command('clearConsole')},
        {type: 'separator'},
        {label: 'Цели (плата, TCP, мост, память, прошивка)…', click: command('targets')},
      ],
    },
    {
      label: 'Библиотеки',
      submenu: [
        {label: 'Создать библиотеку из проекта…', click: command('libraryFromProject')},
        {label: 'Подключить файл библиотеки…', click: command('libraryImport')},
        {label: 'Открыть папку библиотек', click: command('libraryFolder')},
        {label: 'Обновить список', click: command('libraryRefresh')},
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {label: 'Отладка, цели и плата', click: () => openDocs('DEBUGGING.md')},
        {label: 'Описание языка PVM HLC (pvm.json)', click: () => openDocs('CUSTOM_LANGUAGES.md')},
        {label: 'Архитектура проекта', click: () => openDocs('ARCHITECTURE.md')},
        {type: 'separator'},
        {label: 'О программе', click: command('about')},
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openDocs(name) {
  return shell.openPath(path.join(DOCS_DIR, path.basename(name)));
}

/** Папка сборки: рядом с файлом (<имя>.build), а у несохранённого — в данных приложения. */
function buildDirFor(projectPath) {
  if (projectPath) return path.join(path.dirname(projectPath), path.parse(projectPath).name + '.build');
  return path.join(app.getPath('userData'), 'build', 'untitled');
}

async function stopActivity() {
  const current = activity;
  activity = null;
  if (current) await current.stop();
}

// ---------------------------------------------------------------- цели: переменные, мост, команды

/** Переменные ${...} и окружение PAZZLE_* для команд текущей цели. */
function commandContext({files: built = {}, projectPath, folder}) {
  const target = settings.target();
  const t = tools();
  const vars = targets.targetVariables({target, files: built, projectPath, folder, tools: t, appDir: ROOT});
  const env = targets.commandEnv(vars, target.env);
  const cwd = folder || (projectPath ? path.dirname(projectPath) : built.bin ? path.dirname(built.bin) : undefined);
  return {target, vars, env, cwd, expand: (text) => targets.expandVariables(text, vars, env)};
}

/** Запускает мост цели, если он задан; вывод моста — с пометкой [мост]. */
async function maybeBridge(ctx, emit) {
  if (!ctx.target.bridge || ctx.target.mode === 'sim') return null;
  const commandLine = ctx.expand(ctx.target.bridge);
  emit(`$ ${commandLine}   [мост]\n`, 'command');
  // Вывод приходит кусками — пометка [мост] ставится в начало каждой целой строки.
  const pending = {stdout: '', stderr: ''};
  const onOutput = (o) => {
    const lines = (pending[o.stream] + o.text).split(/(?<=\n)/);
    pending[o.stream] = lines[lines.length - 1].endsWith('\n') ? '' : lines.pop();
    if (lines.length) emit(lines.map((l) => `[мост] ${l}`).join(''), o.stream === 'stderr' ? 'stderr' : 'info');
  };
  const bridge = await targets.startBridge({...ctx.target, bridge: commandLine}, {cwd: ctx.cwd, env: ctx.env, onOutput});
  bridge.done.then(({code}) => {
    for (const stream of ['stdout', 'stderr']) if (pending[stream]) onOutput({stream, text: '\n'});
    emit(`[мост] завершился (код ${code})\n`, 'info');
  });
  return bridge;
}

/**
 * Своя команда цели (запуск или прошивка): вывод — в консоль, «Стоп» завершает
 * процесс вместе с дочерними.
 */
function runTargetCommand({kind, commandLine, ctx}) {
  const started = Date.now();
  send('run:event', {type: 'status', text: `$ ${commandLine}\n`});
  const proc = targets.runShell(commandLine, {
    cwd: ctx.cwd,
    env: ctx.env,
    onOutput: (o) => send('run:event', {type: 'output', stream: o.stream, text: o.text}),
  });
  let stopped = false;
  const current = {
    kind,
    child: proc.child,
    stop: async () => {
      stopped = true;
      proc.stop();
    },
  };
  activity = current;
  proc.done.then(({code}) => {
    if (activity === current) activity = null;
    send('run:event', {type: 'exit', kind, custom: true, code, killed: stopped, ms: Date.now() - started});
  });
}

// ---------------------------------------------------------------- запуск без отладки

/** Симулятор pvmsim: трассировка отфильтровывается, остаётся вывод программы. */
function runSimulator({bin, outputFilter, limits = {}}) {
  const t = tools();
  if (!t.found.pvmsim) throw new Error('pvmsim не найден — укажите папку утилит PVM в настройках');
  const started = Date.now();
  // Стек и RAM — как у платы цели (если ограничения заданы).
  const args = [bin, ...(limits.stack ? ['--stack', String(limits.stack)] : []), ...(limits.ram ? ['--ram', String(limits.ram)] : [])];
  const child = spawn(t.found.pvmsim, args, {cwd: path.dirname(bin), windowsHide: true});
  const filter = createLineFilter(outputFilter);
  const decoder = new TextDecoder('utf-8');
  let halted = false;
  let tail = '';
  send('run:event', {type: 'status', text: `$ pvmsim ${[path.basename(bin), ...args.slice(1)].join(' ')}\n`});
  child.stdout.on('data', (chunk) => {
    let text = decoder.decode(chunk, {stream: true});
    tail = (tail + text).slice(-200);
    if (/pvmsim: halted/.test(tail)) halted = true;
    if (filter) text = filter.push(text);
    if (text) send('run:event', {type: 'output', stream: 'stdout', text});
  });
  child.stderr.on('data', (chunk) => send('run:event', {type: 'output', stream: 'stderr', text: chunk.toString('utf8')}));
  child.on('error', (e) => send('run:event', {type: 'output', stream: 'stderr', text: `Не удалось запустить pvmsim: ${e.message}\n`}));
  child.on('close', (code) => {
    const rest = filter?.flush();
    if (rest) send('run:event', {type: 'output', stream: 'stdout', text: rest});
    if (activity?.child === child) activity = null;
    send('run:event', {type: 'exit', code, halted, killed: child.killed, ms: Date.now() - started});
  });
  activity = {kind: 'run', child, stop: async () => child.kill()};
}

/** Плата: программа с хоста выполняется до конца (или до «Стоп»). */
async function runOnBoard({files: built, ctx}) {
  const t = tools();
  if (!t.found.pvmdbg) throw new Error('pvmdbg не найден — укажите папку утилит PVM в настройках');
  const started = Date.now();
  const emit = (text, kind) => send('run:event', {type: kind === 'command' ? 'status' : 'output', stream: kind === 'stderr' ? 'stderr' : 'stdout', text});
  const current = {kind: 'run', session: null, bridge: null, stop: async () => {}};
  activity = current;
  current.bridge = await maybeBridge(ctx, emit);
  const link = targets.pvmdbgLink(ctx.target);
  const s = new DebugSession({target: 'board-host', pvmdbg: t.found.pvmdbg, files: built, link});
  current.session = s;
  current.stop = async () => {
    await s.stop();
    current.bridge?.stop();
  };
  s.on('output', (o) => send('run:event', {type: 'output', stream: o.kind === 'stderr' ? 'stderr' : 'stdout', text: o.text}));
  let finished = false;
  const done = (payload) => {
    if (finished) return;
    finished = true;
    if (activity === current) activity = null;
    current.bridge?.stop();
    send('run:event', {type: 'exit', ms: Date.now() - started, ...payload});
  };
  s.on('state', (st) => {
    if (st.status === 'stopped' && st.reason !== 'entry') {
      done({code: st.reason === 'halted' ? 0 : 1, halted: st.reason === 'halted', error: st.error, variables: st.variables});
      s.stop();
    } else if (st.status === 'ended') {
      done({code: null, killed: true});
    }
  });
  send('run:event', {type: 'status', text: `$ pvmdbg --host ${path.basename(built.bin)} ${link.join(' ')}\n`});
  await s.start();
  await s.setBreakpoints([]);
  s.runFree();
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
  }));
  ipcMain.handle('app:openDocs', (_e, name) => openDocs(name));
  ipcMain.on('app:setDirty', (_e, value) => {
    dirty = !!value;
  });

  ipcMain.handle('language:load', () => JSON.parse(fs.readFileSync(LANGUAGE_FILE, 'utf8')));

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => settings.set(patch));
  ipcMain.handle('settings:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {title: 'Папка с утилитами PVM (Release)', properties: ['openDirectory']});
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('targets:info', () => ({
    variables: targets.VARIABLES.map(([name, description]) => ({name, description, env: targets.envName(name)})),
    defaults: targets.PVM_DEFAULT_LIMITS,
    factory: targets.FACTORY_LIMITS,
  }));

  ipcMain.handle('examples:list', () => listExamples());
  ipcMain.handle('examples:read', (_e, file) => fs.readFileSync(path.join(EXAMPLES_DIR, path.basename(file)), 'utf8'));

  // ---- файлы: проекты пазлов (.pzl) и код (.hlc) ----

  ipcMain.handle('file:open', async (_e, {kind} = {}) => {
    const filters = {
      blocks: [{name: 'Проект пазлов PazzleIDE', extensions: ['pzl', 'vide']}],
      text: [{name: 'Код PVM HLC', extensions: ['hlc']}],
    }[kind] || [{name: 'Проекты и код PazzleIDE', extensions: ['pzl', 'vide', 'hlc']}];
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Открыть',
      filters: [...filters, {name: 'Все файлы', extensions: ['*']}],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return {path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8')};
  });

  ipcMain.handle('file:save', async (_e, {path: filePath, content, kind, defaultName}) => {
    let target = filePath;
    if (!target) {
      const blocks = kind === 'blocks';
      const r = await dialog.showSaveDialog(mainWindow, {
        title: blocks ? 'Сохранить проект пазлов' : 'Сохранить файл',
        defaultPath: path.join(settings.get().folder || app.getPath('documents'), defaultName || (blocks ? 'проект.pzl' : 'main.hlc')),
        filters: blocks
          ? [{name: 'Проект пазлов PazzleIDE', extensions: ['pzl']}]
          : [{name: 'Код PVM HLC', extensions: ['hlc']}, {name: 'Все файлы', extensions: ['*']}],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, content, 'utf8');
    return target;
  });

  ipcMain.handle('code:export', async (_e, defaultName, content) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт кода HLC',
      defaultPath: defaultName,
      filters: [{name: 'Исходный код PVM HLC', extensions: ['hlc']}, {name: 'Все файлы', extensions: ['*']}],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });

  // ---- папка рабочего стола «IDE» ----

  ipcMain.handle('folder:choose', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {title: 'Открыть папку', properties: ['openDirectory', 'createDirectory']});
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('folder:watch', (_e, dir) => {
    folderWatcher?.close();
    folderWatcher = dir && fs.existsSync(dir) ? files.watchFolder(dir, (dirs) => send('fs:changed', {dirs})) : null;
    return !!folderWatcher;
  });
  ipcMain.handle('fs:list', (_e, dir) => files.listDir(dir));
  ipcMain.handle('fs:read', (_e, file) => files.readText(file));
  ipcMain.handle('fs:write', (_e, file, content) => {
    fs.writeFileSync(file, content, 'utf8');
    return true;
  });
  ipcMain.handle('fs:create', (_e, target, options) => files.createEntry(target, options));
  ipcMain.handle('fs:rename', (_e, from, to) => files.renameEntry(from, to));
  ipcMain.handle('fs:trash', (_e, target) => shell.trashItem(target));
  ipcMain.handle('fs:exists', (_e, target) => fs.existsSync(target));
  ipcMain.handle('fs:reveal', (_e, target) => shell.showItemInFolder(target));
  ipcMain.handle('fs:openExternal', (_e, target) => shell.openPath(target));
  ipcMain.handle('fs:contextMenu', (_e, {dir, root}) =>
    new Promise((resolve) => {
      let chosen = null;
      const item = (label, id) => ({label, click: () => (chosen = id)});
      const template = [
        item('Новый проект пазлов…', 'newBlocks'),
        item('Новый файл HLC…', 'newHlc'),
        item('Новый файл…', 'newFile'),
        item('Новая папка…', 'newFolder'),
        {type: 'separator'},
        ...(root ? [] : [item('Переименовать…', 'rename'), item('Удалить в корзину', 'trash'), {type: 'separator'}]),
        ...(dir ? [] : [item('Открыть в системе', 'openExternal')]),
        item(process.platform === 'darwin' ? 'Показать в Finder' : 'Показать в проводнике', 'reveal'),
        item('Копировать путь', 'copyPath'),
      ];
      // Щелчок по пункту приходит раньше или позже закрытия меню — ждём оба.
      Menu.buildFromTemplate(template).popup({window: mainWindow, callback: () => setTimeout(() => resolve(chosen), 50)});
    }),
  );
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

  // ---- библиотеки пазлов ----

  const libraryDirs = (folder) => [
    {dir: librariesDir(), source: 'мои'},
    ...(folder ? [{dir: path.join(folder, 'libraries'), source: 'папка проекта'}] : []),
  ];
  ipcMain.handle('libraries:list', (_e, {folder} = {}) => libraries.listLibraries(libraryDirs(folder)));
  ipcMain.handle('libraries:save', (_e, lib) => libraries.saveLibrary(lib, {file: lib.file, dir: librariesDir()}));
  ipcMain.handle('libraries:delete', (_e, file) => shell.trashItem(file));
  ipcMain.handle('libraries:openFolder', () => {
    fs.mkdirSync(librariesDir(), {recursive: true});
    return shell.openPath(librariesDir());
  });
  ipcMain.handle('libraries:import', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Подключить библиотеку пазлов',
      filters: [{name: 'Библиотека пазлов PazzleIDE', extensions: ['pzlib']}],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    fs.mkdirSync(librariesDir(), {recursive: true});
    const added = [];
    for (const file of r.filePaths) {
      const lib = libraries.readLibrary(file, 'мои');
      if (!lib) throw new Error(`${path.basename(file)} — не библиотека PazzleIDE`);
      added.push(libraries.saveLibrary(lib, {dir: librariesDir()}));
    }
    return added;
  });

  // ---- PVM ----

  ipcMain.handle('pvm:tools', () => tools());
  ipcMain.handle('serial:list', () => listPorts());

  ipcMain.handle('pvm:build', async (_e, {code, projectPath, sourceDir}) => {
    const t = tools();
    if (!t.dir) {
      return {ok: false, stage: 'tools', errors: [], log: 'Утилиты PVM не найдены. Укажите папку Release проекта PVM в настройках (Файл → Настройки) или в переменной PVM_HOME.'};
    }
    const buildDir = buildDirFor(projectPath);
    const target = settings.target();
    const result = await buildProgram({
      code,
      buildDir,
      tools: t,
      limits: target.limits,
      includeDirs: [sourceDir],
      onOutput: (o) => send('build:output', o),
    });
    // Тексты для вкладок «Ассемблер» и «Листинг».
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    result.texts = {pvms: read(result.files.pvms), lst: read(result.files.lst)};
    result.target = target.name;
    return result;
  });

  ipcMain.handle('pvm:openBuildFolder', (_e, projectPath) => {
    const dir = buildDirFor(projectPath);
    fs.mkdirSync(dir, {recursive: true});
    return shell.openPath(dir);
  });

  ipcMain.handle('pvm:run', async (_e, {files: built, projectPath, folder, outputFilter}) => {
    await stopActivity();
    const ctx = commandContext({files: built, projectPath, folder});
    try {
      if (ctx.target.run) runTargetCommand({kind: 'run', commandLine: ctx.expand(ctx.target.run), ctx});
      else if (ctx.target.mode === 'sim') runSimulator({bin: built.bin, outputFilter, limits: ctx.target.limits});
      else if (ctx.target.mode === 'board-host') await runOnBoard({files: built, ctx});
      else return {ok: false, error: 'Прошитая программа выполняется на плате сама: для управления ею — «Отладка», для загрузки новой — «Прошить».'};
      return {ok: true};
    } catch (e) {
      await stopActivity();
      return {ok: false, error: e.message};
    }
  });

  ipcMain.handle('pvm:flash', async (_e, {files: built, projectPath, folder}) => {
    await stopActivity();
    const ctx = commandContext({files: built, projectPath, folder});
    if (!ctx.target.flash) return {ok: false, noCommand: true, error: `У цели «${ctx.target.name}» не задана команда прошивки`};
    runTargetCommand({kind: 'flash', commandLine: ctx.expand(ctx.target.flash), ctx});
    return {ok: true};
  });

  ipcMain.handle('debug:start', async (_e, {files: built, projectPath, folder, breakpoints}) => {
    await stopActivity();
    const t = tools();
    if (!t.found.pvmdbg) return {ok: false, error: 'pvmdbg не найден — укажите папку утилит PVM в настройках'};
    const ctx = commandContext({files: built, projectPath, folder});
    const mode = ctx.target.mode;
    const emit = (text, kind) => send('debug:event', {type: 'output', text, kind: kind === 'command' ? 'info' : kind});
    const current = {kind: 'debug', session: null, bridge: null, stop: async () => {}};
    activity = current;
    try {
      current.bridge = await maybeBridge(ctx, emit);
      const link = mode === 'sim' ? null : targets.pvmdbgLink(ctx.target);
      const s = new DebugSession({target: mode, pvmdbg: t.found.pvmdbg, files: built, link});
      current.session = s;
      current.stop = async () => {
        await s.stop();
        current.bridge?.stop();
      };
      s.on('state', (st) => {
        if (st.status === 'ended') {
          if (activity === current) activity = null;
          current.bridge?.stop();
        }
        send('debug:event', {type: 'state', ...st});
      });
      s.on('output', (o) => send('debug:event', {type: 'output', ...o}));
      s.on('breakpoints', (b) => send('debug:event', {type: 'breakpoints', ...b}));
      if (link) emit(`$ pvmdbg ${mode === 'board-host' ? `--host ${path.basename(built.bin)} ` : ''}${link.join(' ')}\n`, 'info');
      await s.setBreakpoints(breakpoints || []); // до старта только запоминаются
      await s.start();
      await s.setBreakpoints(breakpoints || []);
      return {ok: true};
    } catch (e) {
      current.bridge?.stop();
      if (activity === current) activity = null;
      return {ok: false, error: e.message};
    }
  });

  ipcMain.handle('debug:command', async (_e, name, arg) => {
    const s = activity?.kind === 'debug' ? activity.session : null;
    if (name === 'stop') return stopActivity();
    if (!s) return false;
    switch (name) {
      case 'continue': s.continue(); break;
      case 'pause': s.pause(); break;
      case 'stepOver': s.stepLine('over'); break;
      case 'stepInto': s.stepLine('into'); break;
      case 'stepOut': s.stepLine('out'); break;
      case 'stepInstr': s.stepInstruction(); break;
      case 'reset': s.reset(); break;
      case 'breakpoints': s.setBreakpoints(arg || []); break;
      default: return false;
    }
    return true;
  });

  ipcMain.handle('run:stop', () => stopActivity());

  // Проект для make и VS Code: pvminit + сгенерированный main.hlc.
  ipcMain.handle('pvm:exportProject', async (_e, {code}) => {
    const t = tools();
    if (!t.found.pvminit) return {ok: false, error: 'pvminit не найден в папке утилит PVM'};
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Папка для проекта (Makefile, .vscode)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const main = path.join(dir, 'main.hlc');
    if (fs.existsSync(main)) {
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Перезаписать main.hlc', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        message: 'В папке уже есть main.hlc. Заменить его кодом из блоков?',
      });
      if (answer.response !== 0) return null;
    }
    fs.writeFileSync(main, code, 'utf8');
    const target = settings.target();
    let log = '';
    const res = await runTool(t.found.pvminit, [dir, '--main', 'main.hlc', '--port', target.port || 'COM3', '--tools', t.dir], {
      cwd: dir,
      onOutput: (o) => {
        log += o.text;
      },
    });
    return {ok: res.code === 0, dir, log};
  });
}

function sendOpenFile(filePath) {
  send('open-file', {path: filePath, content: fs.readFileSync(filePath, 'utf8')});
}

function createWindow() {
  const w = settings.get().window;
  mainWindow = new BrowserWindow({
    width: w.width,
    height: w.height,
    minWidth: 980,
    minHeight: 620,
    title: 'PazzleIDE',
    backgroundColor: settings.get().theme === 'light' ? '#f5f6f8' : '#1e1f22',
    icon: path.join(ROOT, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (w.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Внешние ссылки открываем в браузере, навигацию внутри окна запрещаем.
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return {action: 'deny'};
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  ipcMain.once('app:ready', () => {
    if (pendingOpenFile) {
      sendOpenFile(pendingOpenFile);
      pendingOpenFile = null;
    }
  });

  mainWindow.on('close', (e) => {
    if (dirty) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Выйти без сохранения', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        title: 'PazzleIDE',
        message: 'Есть несохранённые изменения. Выйти?',
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
    const maximized = mainWindow.isMaximized();
    const bounds = mainWindow.getNormalBounds();
    settings.set({window: {width: bounds.width, height: bounds.height, maximized}});
    folderWatcher?.close();
    stopActivity();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.PAZZLE_DEBUG) {
    // Сообщения консоли интерфейса — в терминал (отладка, автотесты).
    mainWindow.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  }
  if (process.env.PAZZLE_SCREENSHOT) {
    // Снимок окна для проверки интерфейса: PAZZLE_SCREENSHOT=путь.png, PAZZLE_EVAL — код до снимка.
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.PAZZLE_EVAL) await mainWindow.webContents.executeJavaScript(process.env.PAZZLE_EVAL).catch((e) => console.log(e));
        await new Promise((r) => setTimeout(r, Number(process.env.PAZZLE_EVAL_DELAY || 300)));
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.PAZZLE_SCREENSHOT, image.toPNG());
        dirty = false;
        await stopActivity();
        app.exit(0);
      }, Number(process.env.PAZZLE_SCREENSHOT_DELAY || 3000));
    });
  }

  mainWindow.loadURL('app://ide/index.html');
}

if (process.env.PAZZLE_USER_DATA) app.setPath('userData', process.env.PAZZLE_USER_DATA);

// macOS: двойной щелчок по файлу .pzl / .hlc.
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (mainWindow) sendOpenFile(filePath);
  else pendingOpenFile = filePath;
});

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));
  registerAppProtocol();
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
