// Основной процесс Electron: окно, меню, файлы, сборка, запуск и отладка программ PVM.
'use strict';
const {app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net} = require('electron');
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

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'dist', 'renderer');
const LANGUAGE_FILE = path.join(ROOT, 'languages', 'pvm.json');
const EXAMPLES_DIR = path.join(ROOT, 'examples');
const DOCS_DIR = path.join(ROOT, 'docs');

let settings;
let mainWindow = null;
let dirty = false;
let activity = null; // текущий запуск или сессия отладки: {kind, stop()}
let pendingOpenFile = process.argv.slice(1).find((a) => a.endsWith('.vide') && fs.existsSync(a)) || null;

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

function listExamples() {
  try {
    return fs
      .readdirSync(EXAMPLES_DIR)
      .filter((f) => f.endsWith('.vide'))
      .sort()
      .map((f) => {
        let title = f.replace(/^\d+-/, '').replace(/\.vide$/, '');
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
        {label: 'Новый проект', accelerator: 'CmdOrCtrl+N', click: command('new')},
        {label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: command('open')},
        {label: 'Примеры', submenu: listExamples().map((e) => ({label: e.title, click: command('example', e.file)}))},
        {type: 'separator'},
        {label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: command('save')},
        {label: 'Сохранить как…', accelerator: 'CmdOrCtrl+Shift+S', click: command('saveAs')},
        {type: 'separator'},
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
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {label: 'Отладка и плата', click: () => openDocs('DEBUGGING.md')},
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

/** Папка сборки: рядом с проектом (<имя>.build), а у несохранённого — в данных приложения. */
function buildDirFor(projectPath) {
  if (projectPath) return path.join(path.dirname(projectPath), path.parse(projectPath).name + '.build');
  return path.join(app.getPath('userData'), 'build', 'untitled');
}

async function stopActivity() {
  const current = activity;
  activity = null;
  if (current) await current.stop();
}

// ---------------------------------------------------------------- запуск без отладки

/** Симулятор pvmsim: трассировка отфильтровывается, остаётся вывод программы. */
function runSimulator({bin, outputFilter}) {
  const t = tools();
  if (!t.found.pvmsim) throw new Error('pvmsim не найден — укажите папку утилит PVM в настройках');
  const started = Date.now();
  const child = spawn(t.found.pvmsim, [bin], {cwd: path.dirname(bin), windowsHide: true});
  const filter = createLineFilter(outputFilter);
  const decoder = new TextDecoder('utf-8');
  let halted = false;
  let tail = '';
  send('run:event', {type: 'status', text: `$ pvmsim ${path.basename(bin)}\n`});
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
async function runOnBoard({files, target, port, baud}) {
  const t = tools();
  const started = Date.now();
  const s = new DebugSession({target, pvmdbg: t.found.pvmdbg, files, port, baud});
  s.on('output', (o) => send('run:event', {type: 'output', stream: o.kind === 'stderr' ? 'stderr' : 'stdout', text: o.text}));
  let finished = false;
  const done = (payload) => {
    if (finished) return;
    finished = true;
    if (activity?.session === s) activity = null;
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
  activity = {kind: 'run', session: s, stop: () => s.stop()};
  send('run:event', {type: 'status', text: `$ pvmdbg --host ${path.basename(files.bin)} --port ${port} --baud ${baud}\n`});
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

  ipcMain.handle('examples:list', () => listExamples());
  ipcMain.handle('examples:read', (_e, file) => fs.readFileSync(path.join(EXAMPLES_DIR, path.basename(file)), 'utf8'));

  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Открыть проект',
      filters: [{name: 'Проект VisualIDE', extensions: ['vide']}, {name: 'Все файлы', extensions: ['*']}],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return {path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8')};
  });

  ipcMain.handle('project:save', async (_e, filePath, content) => {
    let target = filePath;
    if (!target) {
      const r = await dialog.showSaveDialog(mainWindow, {
        title: 'Сохранить проект',
        defaultPath: 'проект.vide',
        filters: [{name: 'Проект VisualIDE', extensions: ['vide']}],
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

  // ---- PVM ----

  ipcMain.handle('pvm:tools', () => tools());
  ipcMain.handle('serial:list', () => listPorts());

  ipcMain.handle('pvm:build', async (_e, {code, projectPath}) => {
    const t = tools();
    if (!t.dir) {
      return {ok: false, stage: 'tools', errors: [], log: 'Утилиты PVM не найдены. Укажите папку Release проекта PVM в настройках (Файл → Настройки) или в переменной PVM_HOME.'};
    }
    const buildDir = buildDirFor(projectPath);
    const result = await buildProgram({code, buildDir, tools: t, onOutput: (o) => send('build:output', o)});
    // Тексты для вкладок «Ассемблер» и «Листинг».
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    result.texts = {pvms: read(result.files.pvms), lst: read(result.files.lst)};
    return result;
  });

  ipcMain.handle('pvm:openBuildFolder', (_e, projectPath) => {
    const dir = buildDirFor(projectPath);
    fs.mkdirSync(dir, {recursive: true});
    return shell.openPath(dir);
  });

  ipcMain.handle('pvm:run', async (_e, {files, target, port, baud, outputFilter}) => {
    await stopActivity();
    try {
      if (target === 'sim') runSimulator({bin: files.bin, outputFilter});
      else await runOnBoard({files, target: 'board-host', port, baud});
      return {ok: true};
    } catch (e) {
      activity = null;
      return {ok: false, error: e.message};
    }
  });

  ipcMain.handle('debug:start', async (_e, {files, target, port, baud, breakpoints}) => {
    await stopActivity();
    const t = tools();
    if (!t.found.pvmdbg) return {ok: false, error: 'pvmdbg не найден — укажите папку утилит PVM в настройках'};
    const s = new DebugSession({target, pvmdbg: t.found.pvmdbg, files, port: target === 'sim' ? null : port, baud});
    s.on('state', (st) => {
      if (st.status === 'ended' && activity?.session === s) activity = null;
      send('debug:event', {type: 'state', ...st});
    });
    s.on('output', (o) => send('debug:event', {type: 'output', ...o}));
    s.on('breakpoints', (b) => send('debug:event', {type: 'breakpoints', ...b}));
    activity = {kind: 'debug', session: s, stop: () => s.stop()};
    try {
      await s.setBreakpoints(breakpoints || []); // до старта только запоминаются
      await s.start();
      await s.setBreakpoints(breakpoints || []);
      return {ok: true};
    } catch (e) {
      if (activity?.session === s) activity = null;
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
  ipcMain.handle('pvm:exportProject', async (_e, {code, port}) => {
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
    let log = '';
    const res = await runTool(t.found.pvminit, [dir, '--main', 'main.hlc', '--port', port || 'COM3', '--tools', t.dir], {
      cwd: dir,
      onOutput: (o) => {
        log += o.text;
      },
    });
    return {ok: res.code === 0, dir, log};
  });
}

function createWindow() {
  const w = settings.get().window;
  mainWindow = new BrowserWindow({
    width: w.width,
    height: w.height,
    minWidth: 980,
    minHeight: 620,
    title: 'VisualIDE',
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
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenFile) {
      send('open-file', {path: pendingOpenFile, content: fs.readFileSync(pendingOpenFile, 'utf8')});
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
        title: 'VisualIDE',
        message: 'В проекте есть несохранённые изменения. Выйти?',
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
    const maximized = mainWindow.isMaximized();
    const bounds = mainWindow.getNormalBounds();
    settings.set({window: {width: bounds.width, height: bounds.height, maximized}});
    stopActivity();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.VIDE_DEBUG) {
    // Сообщения консоли интерфейса — в терминал (отладка, автотесты).
    mainWindow.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  }
  if (process.env.VIDE_SCREENSHOT) {
    // Снимок окна для проверки интерфейса: VIDE_SCREENSHOT=путь.png, VIDE_EVAL — код до снимка.
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.VIDE_EVAL) await mainWindow.webContents.executeJavaScript(process.env.VIDE_EVAL).catch((e) => console.log(e));
        await new Promise((r) => setTimeout(r, Number(process.env.VIDE_EVAL_DELAY || 300)));
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.VIDE_SCREENSHOT, image.toPNG());
        dirty = false;
        await stopActivity();
        app.exit(0);
      }, Number(process.env.VIDE_SCREENSHOT_DELAY || 3000));
    });
  }

  mainWindow.loadURL('app://ide/index.html');
}

if (process.env.VIDE_USER_DATA) app.setPath('userData', process.env.VIDE_USER_DATA);

// macOS: двойной щелчок по файлу .vide.
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (mainWindow) send('open-file', {path: filePath, content: fs.readFileSync(filePath, 'utf8')});
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
