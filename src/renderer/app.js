// Интерфейс PazzleIDE для PVM: блоки, код HLC, сборка, запуск и отладка (симулятор или плата).
import * as Blockly from 'blockly';
import * as Ru from 'blockly/msg/ru';
import {monaco} from './monaco-setup.js';
import {createLanguage, generateCode, buildToolbox, serializeProject, parseProject, loadProjectInto} from '../core/index.js';
import {blocklyTheme, monacoTheme, applyPageTheme} from './theme.js';
import {ConsoleView} from './console.js';
import {initSplitters} from './splitter.js';
import {openSettingsDialog} from './settings-dialog.js';
import {DebugView} from './debug-view.js';

Blockly.setLocale(Ru);
// Без комментария-заглушки «Опишите эту функцию…» у новых функций (он попадал бы в код).
Blockly.Msg['PROCEDURES_DEFNORETURN_COMMENT'] = '';
Blockly.Msg['PROCEDURES_DEFRETURN_COMMENT'] = '';
self.MonacoEnvironment = {getWorker: () => new Worker('editor.worker.js')};

const pazzle = window.pazzle;
const $ = (id) => document.getElementById(id);
const AUTOSAVE_KEY = 'pazzle.pvm.autosave';
const TARGET_NAMES = {
  sim: 'симулятор',
  'board-host': 'плата (программа с хоста)',
  'board-flash': 'плата (прошитая программа)',
};

const state = {
  settings: null,
  language: null,
  tools: null,
  ws: null,
  editor: null,
  models: {},
  view: 'hlc',
  filePath: null,
  dirty: false,
  manualEdit: false,
  generated: {code: '', warnings: [], unsupported: [], lineBlocks: {}, names: {}},
  build: null, // последняя успешная сборка (+ код и таблица строк, из которых она сделана)
  buildErrors: new Map(), // id блока -> текст ошибки компиляции
  breakpoints: new Set(), // id блоков
  debug: {active: false, running: false, build: null, snapshot: null, currentBlock: null},
  running: false,
  busy: false,
};

const consoleView = new ConsoleView($('console-output'));
const debugView = new DebugView({onSelectFrame: (frame, index) => showFrame(frame, index)});
window.pazzleDebug = {state, Blockly, monaco}; // доступ из DevTools

// ---------------------------------------------------------------- утилиты

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function setStatus(text, isError = false) {
  $('status-text').textContent = text;
  document.querySelector('.statusbar').classList.toggle('error', isError);
}

function updateTitle() {
  const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : 'Без имени';
  document.title = `${name}${state.dirty ? ' •' : ''} — PazzleIDE PVM`;
}

function setDirty(value) {
  if (state.dirty === value) return;
  state.dirty = value;
  pazzle.setDirty(value);
  updateTitle();
}

/** Блок, к которому относится строка кода: ближайший маркер на этой строке или выше. */
function blockForLine(lineBlocks, line) {
  for (let l = line; l > 0; l--) if (lineBlocks[l]) return lineBlocks[l];
  return null;
}

function lineForBlock(lineBlocks, id) {
  for (const [line, block] of Object.entries(lineBlocks)) if (block === id) return Number(line);
  return null;
}

function showBottom(panelId) {
  for (const tab of document.querySelectorAll('#bottom-tabs .tab')) tab.classList.toggle('active', tab.dataset.panel === panelId);
  for (const id of ['console-panel', 'debug-panel']) $(id).hidden = id !== panelId;
}

function showCodeView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('#code-tabs .tab')) tab.classList.toggle('active', tab.dataset.view === view);
  state.editor.setModel(state.models[view]);
  state.editor.updateOptions({readOnly: view !== 'hlc' || !state.manualEdit, glyphMargin: view === 'hlc'});
  $('btn-edit').hidden = view !== 'hlc';
}

// ---------------------------------------------------------------- рабочая область

function injectWorkspace() {
  const ws = Blockly.inject($('blockly'), {
    toolbox: buildToolbox(state.language),
    renderer: state.settings.renderer,
    theme: blocklyTheme(state.settings.theme),
    media: 'media/',
    grid: {spacing: 24, length: 2, colour: '#8a8f9840', snap: true},
    zoom: {controls: true, wheel: true, startScale: 0.85, maxScale: 3, minScale: 0.3, scaleSpeed: 1.15},
    move: {scrollbars: true, drag: true, wheel: false},
    trashcan: true,
    sounds: true,
    oneBasedIndex: true,
  });
  ws.addChangeListener(onWorkspaceChange);
  ws.registerToolboxCategoryCallback('PVM_CONSTANTS', constantsFlyout);
  state.ws = ws;
  return ws;
}

// ---------------------------------------------------------------- константы

/** Имена объявленных констант по порядку (без повторов). */
function definedConstants(ws = state.ws) {
  const names = [];
  for (const b of ws.getAllBlocks(true)) {
    if (b.type === 'pvm_const_define' && b.isEnabled()) {
      const name = b.getFieldValue('NAME').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Категория «Константы»: новое объявление и блоки всех объявленных констант. */
function constantsFlyout(ws) {
  const names = definedConstants(ws);
  let i = 1;
  while (names.includes(`КОНСТ${i}`)) i++;
  const items = [
    {kind: 'label', text: 'Объявите константу (в начале программы):'},
    {kind: 'block', type: 'pvm_const_define', fields: {NAME: `КОНСТ${i}`}, inputs: {VALUE: {shadow: {type: 'math_number', fields: {NUM: 10}}}}},
  ];
  if (names.length) {
    items.push({kind: 'label', text: 'Объявленные константы:'});
    for (const name of names) items.push({kind: 'block', type: 'pvm_const_get', fields: {NAME: name}});
  } else {
    items.push({kind: 'label', text: 'После объявления здесь появятся блоки её значения.'});
  }
  return items;
}

/** Переименовали константу в объявлении — переименовываем и блоки её значения. */
function renameConstantUses(e) {
  if (e.type !== Blockly.Events.BLOCK_CHANGE || e.element !== 'field' || e.name !== 'NAME') return;
  const block = state.ws.getBlockById(e.blockId);
  if (block?.type !== 'pvm_const_define') return;
  const from = String(e.oldValue).trim();
  const to = String(e.newValue).trim();
  if (!from || from === to || definedConstants().includes(from)) return; // старое имя ещё объявлено в другом месте
  for (const b of state.ws.getAllBlocks(false)) {
    if (b.type === 'pvm_const_get' && b.getFieldValue('NAME') === from) b.setFieldValue(to, 'NAME');
  }
}

function recreateWorkspace() {
  const saved = Blockly.serialization.workspaces.save(state.ws);
  state.ws.dispose();
  injectWorkspace();
  loadProjectInto(state.ws, {workspace: saved});
  regenerate();
}

const scheduleRegenerate = debounce(() => regenerate(), 120);
const scheduleAutosave = debounce(() => autosave(), 800);

function onWorkspaceChange(e) {
  if (e.isUiEvent || e.type === Blockly.Events.FINISHED_LOADING) return;
  if (e.type === Blockly.Events.BLOCK_DELETE) {
    for (const id of e.ids || []) state.breakpoints.delete(id);
  }
  renameConstantUses(e);
  setDirty(true);
  scheduleRegenerate();
  scheduleAutosave();
}

/** Предупреждения на блоках: неподдерживаемые блоки и ошибки компиляции (ставятся только при изменении). */
const appliedWarnings = new Map();
function applyBlockWarnings() {
  const unsupported = new Set(state.generated.unsupported || []);
  const detached = new Set(state.generated.detached || []);
  const extraEntries = new Set(state.generated.extraEntries || []);
  const constCount = new Map();
  for (const b of state.ws.getAllBlocks(false)) {
    if (b.type === 'pvm_const_define' && b.isEnabled()) {
      const name = b.getFieldValue('NAME').trim();
      constCount.set(name, (constCount.get(name) || 0) + 1);
    }
  }
  for (const block of state.ws.getAllBlocks(false)) {
    let text = state.buildErrors.get(block.id) || null;
    if (!text && unsupported.has(block.type)) text = 'Этот блок нельзя перевести в PVM HLC (в языке только целые числа)';
    if (!text && block.type === 'pvm_const_get' && !constCount.has(block.getFieldValue('NAME').trim())) {
      text = `Константа «${block.getFieldValue('NAME')}» не объявлена — добавьте блок «константа … =» из категории «Константы»`;
    }
    if (!text && block.type === 'pvm_const_define' && constCount.get(block.getFieldValue('NAME').trim()) > 1) {
      text = `Константа «${block.getFieldValue('NAME')}» объявлена несколько раз`;
    }
    if (!text && detached.has(block.id)) {
      text = 'Эта стопка не выполняется: присоедините её под блок «▶ начало программы» (категория «Программа»)';
    }
    if (!text && extraEntries.has(block.id)) {
      text = 'Блок «начало программы» должен быть один — выполняется только верхний';
    }
    if ((appliedWarnings.get(block.id) || null) === text) continue;
    block.setWarningText(text);
    if (text) appliedWarnings.set(block.id, text);
    else appliedWarnings.delete(block.id);
  }
}

// ---------------------------------------------------------------- точки останова

function refreshBreakpointVisuals() {
  for (const block of state.ws.getAllBlocks(false)) {
    block.getSvgRoot()?.classList.toggle('pz-bp', state.breakpoints.has(block.id));
  }
  refreshEditorDecorations();
}

function canHaveBreakpoint(block) {
  // У «начала программы» нет своего кода — останавливаться можно на блоках под ним.
  return block && !block.outputConnection && !block.isShadow() && block.type !== state.language.pack.entryBlock;
}

function toggleBreakpoint(block) {
  if (!canHaveBreakpoint(block)) return;
  if (state.breakpoints.has(block.id)) state.breakpoints.delete(block.id);
  else state.breakpoints.add(block.id);
  refreshBreakpointVisuals();
  scheduleAutosave();
  if (state.debug.active) pazzle.debug.command('breakpoints', breakpointLines(state.debug.build));
}

function breakpointLines(build) {
  if (!build) return [];
  return [...state.breakpoints].map((id) => lineForBlock(build.lineBlocks, id)).filter(Boolean);
}

function registerContextMenu() {
  const id = 'pazzle_toggle_breakpoint';
  if (Blockly.ContextMenuRegistry.registry.getItem(id)) return;
  Blockly.ContextMenuRegistry.registry.register({
    id,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -10,
    displayText: (scope) => (state.breakpoints.has(scope.block.id) ? 'Убрать точку останова (F9)' : 'Точка останова (F9)'),
    preconditionFn: (scope) => (canHaveBreakpoint(scope.block) ? 'enabled' : 'hidden'),
    callback: (scope) => toggleBreakpoint(scope.block),
  });
}

// ---------------------------------------------------------------- код

let decorations = null;

function refreshEditorDecorations() {
  if (!state.editor) return;
  const lineBlocks = state.generated.lineBlocks;
  const items = [];
  for (const id of state.breakpoints) {
    const line = lineForBlock(lineBlocks, id);
    if (line) items.push({range: new monaco.Range(line, 1, line, 1), options: {glyphMarginClassName: 'pz-bp-glyph', glyphMarginHoverMessage: {value: 'Точка останова'}}});
  }
  const snap = state.debug.snapshot;
  if (state.debug.active && snap?.line && !state.debug.running) {
    items.push({range: new monaco.Range(snap.line, 1, snap.line, 1), options: {isWholeLine: true, className: 'pz-current-line', glyphMarginClassName: 'pz-current-glyph'}});
  }
  const frameLine = state.debug.frameLine;
  if (state.debug.active && frameLine && !state.debug.running) {
    items.push({range: new monaco.Range(frameLine, 1, frameLine, 1), options: {isWholeLine: true, className: 'pz-frame-line', hoverMessage: {value: 'Место вызова выбранной функции'}}});
  }
  if (!decorations) decorations = state.editor.createDecorationsCollection(items);
  else decorations.set(state.view === 'hlc' ? items : []);
}

function regenerate() {
  if (!state.ws || !state.editor) return;
  $('status-blocks').textContent = `Блоков: ${state.ws.getAllBlocks(false).length}`;
  if (state.manualEdit) return;
  const result = generateCode(state.language, state.ws);
  if (result.error) {
    setStatus('Ошибка генерации кода — подробности в консоли', true);
    consoleView.error(result.error);
    return;
  }
  state.generated = result;
  const model = state.models.hlc;
  if (model.getValue() !== result.code) {
    const top = state.view === 'hlc' ? state.editor.getScrollTop() : 0;
    model.setValue(result.code);
    if (state.view === 'hlc') state.editor.setScrollTop(top);
  }
  const badge = $('code-warnings');
  badge.hidden = !result.warnings.length;
  badge.textContent = `⚠ ${result.warnings.length}`;
  badge.title = result.warnings.join('\n');
  applyBlockWarnings();
  refreshBreakpointVisuals();
  if (state.debug.active && state.debug.build && state.debug.build.code !== result.code) {
    setStatus('Блоки изменены после сборки — перезапустите отладку, чтобы изменения попали в программу');
  }
}

function createEditor() {
  const common = {readOnly: true};
  state.models.hlc = monaco.editor.createModel('', 'c');
  state.models.pvms = monaco.editor.createModel('# Ассемблер появится после сборки (Ctrl+B)\n', 'pvms');
  state.models.lst = monaco.editor.createModel('# Листинг появится после сборки (Ctrl+B)\n', 'pvms');
  state.editor = monaco.editor.create($('code'), {
    ...common,
    model: state.models.hlc,
    theme: monacoTheme(state.settings.theme),
    readOnlyMessage: {value: 'Код создаётся из блоков. Нажмите «Править», чтобы изменить его вручную.'},
    automaticLayout: true,
    fontSize: state.settings.fontSize,
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace',
    fontLigatures: false,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    tabSize: 4,
    glyphMargin: true,
    smoothScrolling: true,
    padding: {top: 8},
  });
  // Щелчок слева от строки HLC — точка останова на блоке этой строки.
  state.editor.onMouseDown((e) => {
    if (state.view !== 'hlc') return;
    const t = e.target.type;
    if (t !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && t !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    const line = e.target.position?.lineNumber;
    const id = line ? blockForLine(state.generated.lineBlocks, line) : null;
    const block = id ? state.ws.getBlockById(id) : null;
    if (block) toggleBreakpoint(block);
  });
  // Курсор в коде -> выделить соответствующий блок.
  state.editor.onDidChangeCursorPosition((e) => {
    if (state.view !== 'hlc' || e.source !== 'mouse' || state.manualEdit) return;
    const id = blockForLine(state.generated.lineBlocks, e.position.lineNumber);
    const block = id && state.ws.getBlockById(id);
    if (block) block.select();
  });
}

function registerPvmsLanguage() {
  monaco.languages.register({id: 'pvms'});
  monaco.languages.setMonarchTokensProvider('pvms', {
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/^[A-Za-z_][\w]*:/, 'type'],
        [/^\s*\.[a-z]+/, 'keyword'],
        [/^0x[0-9A-Fa-f]+/, 'number.hex'],
        [/\b[A-Z][A-Z0-9_]*\b/, 'keyword'],
        [/-?0x[0-9A-Fa-f]+|-?\d+/, 'number'],
        [/[A-Za-z_]\w*/, 'identifier'],
      ],
    },
  });
}

function toggleManualEdit(force) {
  state.manualEdit = force ?? !state.manualEdit;
  if (state.view !== 'hlc') showCodeView('hlc');
  state.editor.updateOptions({readOnly: !state.manualEdit});
  $('btn-edit').classList.toggle('active', state.manualEdit);
  $('code-banner').hidden = !state.manualEdit;
  if (state.manualEdit) state.editor.focus();
  else regenerate();
}

function currentCode() {
  if (!state.manualEdit) regenerate();
  return state.manualEdit ? state.models.hlc.getValue() : state.generated.code;
}

// ---------------------------------------------------------------- проекты

function serialize() {
  const data = serializeProject(state.ws, {language: 'pvm'});
  data.breakpoints = [...state.breakpoints];
  return JSON.stringify(data, null, 2);
}

function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({project: serialize(), filePath: state.filePath, dirty: state.dirty}));
  } catch {
    // Нет места или хранилище недоступно — не критично.
  }
}

function openProjectText(text, filePath) {
  let project;
  try {
    project = parseProject(text);
  } catch (e) {
    consoleView.error(`Не удалось открыть проект: ${e.message}`);
    setStatus('Ошибка открытия проекта', true);
    return false;
  }
  if (state.debug.active || state.running) stop();
  loadProjectInto(state.ws, project);
  state.breakpoints = new Set((project.breakpoints || []).filter((id) => state.ws.getBlockById(id)));
  state.filePath = filePath;
  state.build = null;
  state.buildErrors.clear();
  setDirty(false);
  updateTitle();
  regenerate();
  setTimeout(() => state.ws.scrollCenter(), 0);
  autosave();
  return true;
}

function confirmDiscard() {
  return !state.dirty || window.confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

async function saveProject(saveAs = false) {
  const saved = await pazzle.project.save(saveAs ? null : state.filePath, serialize());
  if (!saved) return false;
  state.filePath = saved;
  setDirty(false);
  autosave();
  setStatus(`Сохранено: ${saved}`);
  return true;
}

// ---------------------------------------------------------------- сборка

/** «worst case 13 of 1024 words» -> «стек 13/1024»; рекурсия — глубину не оценить. */
function stackText(text) {
  if (!text) return null;
  if (/recursion/.test(text)) return 'стек: рекурсия';
  const m = /(\d+)\s+of\s+(\d+)/.exec(text);
  return m ? `стек ${m[1]}/${m[2]}` : `стек ${text}`;
}

function formatMemory(build) {
  const m = build.memory || {};
  const part = (label, x) => (x?.used !== undefined ? `${label} ${x.used}/${x.total}` : x?.total ? `${label} ${x.total}` : null);
  return [
    `код ${build.size} Б`,
    part('RAM', m.ram),
    stackText(build.stack) || part('стек', m.stack),
  ]
    .filter(Boolean)
    .join(' · ');
}

async function build({silent = false} = {}) {
  if (state.busy) return null;
  const code = currentCode();
  const snapshot = {code, lineBlocks: state.manualEdit ? {} : state.generated.lineBlocks, names: state.generated.names};
  if (state.build && state.build.code === code) return state.build;

  state.busy = true;
  showBottom('console-panel');
  consoleView.line('— Сборка —', 'info');
  setStatus('Сборка…');
  const r = await pazzle.pvm.build({code, projectPath: state.filePath});
  state.busy = false;

  state.buildErrors.clear();
  if (!r.ok) {
    for (const err of r.errors || []) {
      const id = /main\.hlc$/i.test(err.file) ? blockForLine(snapshot.lineBlocks, err.line) : null;
      if (id) state.buildErrors.set(id, `Ошибка компиляции: ${err.message}`);
    }
    monaco.editor.setModelMarkers(
      state.models.hlc,
      'pvmcc',
      (r.errors || [])
        .filter((e) => /main\.hlc$/i.test(e.file))
        .map((e) => ({startLineNumber: e.line, endLineNumber: e.line, startColumn: 1, endColumn: 200, message: e.message, severity: monaco.MarkerSeverity.Error})),
    );
    applyBlockWarnings();
    if (r.stage === 'tools') consoleView.error(r.log);
    consoleView.error(`✖ Сборка не удалась${r.errors?.length ? ': ' + r.errors.map((e) => `строка ${e.line}: ${e.message}`).join('; ') : ''}`);
    const first = [...state.buildErrors.keys()][0];
    if (first) state.ws.getBlockById(first)?.select();
    const firstLine = (r.errors || []).find((e) => /main\.hlc$/i.test(e.file))?.line;
    if (firstLine) {
      showCodeView('hlc');
      state.editor.revealLineInCenter(firstLine);
    }
    setStatus('Ошибка сборки', true);
    return null;
  }
  monaco.editor.setModelMarkers(state.models.hlc, 'pvmcc', []);
  applyBlockWarnings();
  state.build = {...r, ...snapshot};
  state.models.pvms.setValue(r.texts?.pvms || '');
  state.models.lst.setValue(r.texts?.lst || '');
  $('status-memory').textContent = formatMemory(r);
  consoleView.line(`✔ Собрано: ${r.dir}  (${formatMemory(r)})`, 'ok');
  if (!silent) setStatus(`Собрано: ${formatMemory(r)}`);
  return state.build;
}

// ---------------------------------------------------------------- запуск

function target() {
  return $('target').value;
}

function setRunning(running) {
  state.running = running;
  $('run-controls').hidden = !running;
  updateButtons();
  const badge = $('run-state');
  badge.textContent = running ? `● выполняется (${TARGET_NAMES[target()]})` : '';
  badge.classList.toggle('running', running);
}

function updateButtons() {
  const debugging = state.debug.active;
  $('btn-run').disabled = state.running || debugging;
  $('btn-build').disabled = state.running || debugging;
  $('btn-debug').hidden = debugging;
  $('debug-controls').hidden = !debugging;
  $('target').disabled = state.running || debugging;
  $('port').disabled = state.running || debugging;
  $('baud').disabled = state.running || debugging;
  const running = state.debug.running;
  for (const b of document.querySelectorAll('#debug-controls .step')) b.disabled = running;
  $('dbg-continue').disabled = running;
  $('dbg-pause').disabled = !running;
}

async function run() {
  if (state.running || state.debug.active) return;
  if (target() === 'board-flash') {
    consoleView.error('Прошитая программа выполняется на плате сама. Для управления ею используйте «Отладка».');
    return;
  }
  const b = await build({silent: true});
  if (!b) return;
  showBottom('console-panel');
  consoleView.line(`— Запуск: ${TARGET_NAMES[target()]} —`, 'info');
  setRunning(true);
  const r = await pazzle.pvm.run({
    files: b.files,
    target: target(),
    port: $('port').value,
    baud: Number($('baud').value),
    outputFilter: state.settings.rawOutput ? null : state.language.pack.outputFilter,
  });
  if (!r.ok) {
    setRunning(false);
    consoleView.error(r.error);
    setStatus('Не удалось запустить', true);
  } else {
    setStatus(`Выполняется: ${TARGET_NAMES[target()]}`);
  }
}

function onRunEvent(ev) {
  if (ev.type === 'status') consoleView.write(ev.text, 'command');
  else if (ev.type === 'output') consoleView.write(ev.text, ev.stream === 'stderr' ? 'stderr' : 'stdout');
  else if (ev.type === 'exit') {
    setRunning(false);
    const secs = ((ev.ms || 0) / 1000).toFixed(2);
    if (ev.killed) {
      consoleView.info('■ Остановлено');
      setStatus('Остановлено');
    } else if (ev.halted) {
      consoleView.line(`✔ Программа завершена (HALT) за ${secs} с`, 'ok');
      setStatus('Программа завершена');
    } else if (ev.code === 0) {
      consoleView.info(`Симулятор остановился без HALT за ${secs} с (лимит pvmsim — 100 000 инструкций)`);
      setStatus('Остановлено по лимиту инструкций');
    } else {
      consoleView.error(`✖ Ошибка выполнения${ev.error ? ': ' + ev.error : ''} (код ${ev.code})`);
      setStatus('Ошибка выполнения', true);
    }
    if (ev.variables?.length) {
      const names = state.build?.names || {};
      consoleView.info('Переменные: ' + ev.variables.map((v) => `${names[v.name] || v.name}=${v.values?.join(',') ?? '?'}`).join('  '));
    }
  }
}

// ---------------------------------------------------------------- отладка

async function startDebug() {
  if (state.debug.active) {
    if (!state.debug.running) pazzle.debug.command('continue');
    return;
  }
  if (state.running) return;
  const b = await build({silent: true});
  if (!b) return;
  if (target() === 'board-flash') {
    consoleView.info('Режим «прошитая программа»: карта отладки берётся из этой сборки — в плате должна быть она же (main.hex или main.c из папки сборки).');
  }
  state.debug = {active: true, running: true, build: b, snapshot: null, currentBlock: null};
  debugView.reset();
  debugView.running(` ${TARGET_NAMES[target()]}`);
  updateButtons();
  showBottom('debug-panel');
  consoleView.line(`— Отладка: ${TARGET_NAMES[target()]} —`, 'info');
  setStatus(`Подключение: ${TARGET_NAMES[target()]}…`);
  const r = await pazzle.debug.start({
    files: b.files,
    target: target(),
    port: $('port').value,
    baud: Number($('baud').value),
    breakpoints: breakpointLines(b),
  });
  if (!r.ok) {
    consoleView.error(`✖ Отладка не запустилась: ${r.error}`);
    setStatus('Отладка не запустилась', true);
    endDebug();
  }
}

/** Блок вне видимой области — центрируем его. */
function revealBlock(block) {
  const metrics = state.ws.getMetricsManager().getViewMetrics(true);
  const r = block.getBoundingRectangle();
  const visible = r.left >= metrics.left && r.top >= metrics.top && r.right <= metrics.left + metrics.width && r.bottom <= metrics.top + metrics.height;
  if (!visible) state.ws.centerOnBlock(block.id);
}

function highlightCurrent(snap) {
  const prev = state.debug.currentBlock;
  if (prev) state.ws.getBlockById(prev)?.getSvgRoot()?.classList.remove('pz-current');
  state.debug.currentBlock = null;
  showFrame(null);
  if (!snap?.line) return;
  const id = blockForLine(state.debug.build.lineBlocks, snap.line);
  const block = id && state.ws.getBlockById(id);
  if (!block) return;
  state.debug.currentBlock = id;
  block.getSvgRoot()?.classList.add('pz-current');
  revealBlock(block);
}

/**
 * Выбран кадр стека вызовов: место вызова обводится пунктиром на блоках и
 * подсвечивается в коде. Кадр #0 — это сама текущая позиция (уже подсвечена).
 */
function showFrame(frame, index = 0) {
  const prev = state.debug.frameBlock;
  if (prev) state.ws.getBlockById(prev)?.getSvgRoot()?.classList.remove('pz-frame');
  state.debug.frameBlock = null;
  state.debug.frameLine = null;
  if (frame && index > 0 && frame.line) {
    state.debug.frameLine = frame.line;
    const id = blockForLine(state.debug.build.lineBlocks, frame.line);
    const block = id && state.ws.getBlockById(id);
    if (block) {
      state.debug.frameBlock = id;
      block.getSvgRoot()?.classList.add('pz-frame');
      revealBlock(block);
    }
    if (state.view !== 'hlc') showCodeView('hlc');
    state.editor.revealLineInCenterIfOutsideViewport(frame.line);
  } else if (frame && state.debug.currentBlock) {
    const block = state.ws.getBlockById(state.debug.currentBlock);
    if (block) revealBlock(block);
  }
  refreshEditorDecorations();
}

function onDebugEvent(ev) {
  if (ev.type === 'output') {
    consoleView.write(ev.text, ev.kind === 'program' ? 'stdout' : ev.kind === 'stderr' ? 'stderr' : 'info');
    return;
  }
  if (ev.type === 'breakpoints') return;
  if (!state.debug.active) return;
  if (ev.status === 'running') {
    state.debug.running = true;
    highlightCurrent(null);
    debugView.running(` ${TARGET_NAMES[target()]}`);
    refreshEditorDecorations();
    setStatus('Выполняется… (F6 — пауза)');
  } else if (ev.status === 'stopped') {
    state.debug.running = false;
    state.debug.snapshot = ev;
    debugView.show(ev, state.debug.build.names);
    highlightCurrent(ev);
    if (state.view !== 'hlc') showCodeView('hlc');
    if (ev.line) state.editor.revealLineInCenterIfOutsideViewport(ev.line);
    refreshEditorDecorations();
    const where = ev.line ? `строка ${ev.line}` : ev.func ? `в ${ev.func}` : '';
    const text = {
      entry: 'Остановлено в начале программы — F10 шаг, F5 продолжить',
      breakpoint: `Точка останова: ${where}`,
      step: `Шаг: ${where}`,
      pause: `Пауза: ${where}`,
      halted: 'Программа завершена (HALT) — «Сначала» для повторного запуска',
      error: `Ошибка выполнения: ${ev.error || ''}`,
    }[ev.reason];
    setStatus(text || where, ev.reason === 'error');
    if (ev.reason === 'halted') consoleView.line('✔ Программа завершена (HALT)', 'ok');
    if (ev.reason === 'error') consoleView.error(`✖ ${ev.error || 'Ошибка выполнения'}`);
  } else if (ev.status === 'ended') {
    consoleView.info(ev.message || 'Отладка завершена');
    endDebug();
    setStatus(ev.message || 'Отладка завершена');
  }
  updateButtons();
}

function endDebug() {
  highlightCurrent(null);
  state.debug = {active: false, running: false, build: null, snapshot: null, currentBlock: null};
  refreshEditorDecorations();
  updateButtons();
}

function debugCommand(name) {
  if (!state.debug.active) return;
  if (name !== 'pause' && state.debug.running) return;
  pazzle.debug.command(name);
}

async function stop() {
  if (state.debug.active) await pazzle.debug.command('stop');
  else if (state.running) await pazzle.pvm.stop();
}

// ---------------------------------------------------------------- порты и цель

async function refreshPorts() {
  const ports = await pazzle.pvm.ports();
  const select = $('port');
  const wanted = state.settings.port || 'COM3';
  select.textContent = '';
  const all = [...new Set([...(ports || []), wanted])];
  for (const p of all) select.append(new Option(ports?.includes(p) ? p : `${p} (не найден)`, p));
  select.value = wanted;
}

function applyTargetUi() {
  $('port-box').hidden = target() === 'sim';
  $('btn-ports').hidden = target() === 'sim';
  $('baud').value = String(state.settings.baud || 9600);
}

async function refreshTools() {
  state.tools = await pazzle.pvm.tools();
  const el = $('status-tools');
  el.textContent = state.tools.dir ? `PVM: ${state.tools.dir}` : 'PVM: утилиты не найдены — Настройки';
  el.style.cursor = 'pointer';
  el.onclick = () => commands.settings();
  if (!state.tools.dir) {
    consoleView.error('Утилиты PVM (pvmcc, pvmc, pvmsim, pvmdbg) не найдены. Укажите папку Release проекта PVM: Файл → Настройки.');
  }
}

// ---------------------------------------------------------------- команды

async function showAbout() {
  const info = await pazzle.info();
  $('about-text').textContent =
    `Версия ${info.version}. Визуальное программирование стековой виртуальной машины PVM блоками: ` +
    `код PVM HLC, сборка pvmcc/pvmc, выполнение и отладка в симуляторе или на плате. ` +
    `Платформа: ${info.platform}, Electron ${info.electron}.`;
  $('about-dialog').showModal();
}

function applySettings(next) {
  const prev = state.settings;
  state.settings = next;
  if (prev.theme !== next.theme) {
    applyPageTheme(next.theme);
    state.ws.setTheme(blocklyTheme(next.theme));
    monaco.editor.setTheme(monacoTheme(next.theme));
  }
  if (prev.fontSize !== next.fontSize) state.editor.updateOptions({fontSize: next.fontSize});
  if (prev.renderer !== next.renderer) recreateWorkspace();
  if (prev.pvmTools !== next.pvmTools) {
    state.build = null;
    refreshTools();
  }
  if (prev.port !== next.port || prev.baud !== next.baud) {
    refreshPorts();
    applyTargetUi();
  }
}

const commands = {
  async new() {
    if (!confirmDiscard()) return;
    await stop();
    // Новая программа — пара «▶ начало программы» … «■ конец программы»; блоки вставляются между ними.
    const entry = state.language.pack.entryBlock;
    const start = entry && {type: entry, x: 60, y: 60, ...(Blockly.Blocks.pvm_end ? {next: {block: {type: 'pvm_end'}}} : {})};
    loadProjectInto(state.ws, {workspace: start ? {blocks: {languageVersion: 0, blocks: [start]}} : {}});
    state.filePath = null;
    state.breakpoints.clear();
    state.build = null;
    setDirty(false);
    regenerate();
    autosave();
  },
  async open() {
    if (!confirmDiscard()) return;
    const r = await pazzle.project.open();
    if (r) openProjectText(r.content, r.path);
  },
  async example(file) {
    if (!confirmDiscard()) return;
    openProjectText(await pazzle.project.readExample(file), null);
  },
  save: () => saveProject(false),
  saveAs: () => saveProject(true),
  async export() {
    const saved = await pazzle.exportCode('main.hlc', currentCode());
    if (saved) setStatus(`Код сохранён: ${saved}`);
  },
  async exportProject() {
    const r = await pazzle.pvm.exportProject({code: currentCode(), port: $('port').value || state.settings.port});
    if (!r) return;
    showBottom('console-panel');
    if (r.ok) {
      consoleView.write(r.log, 'command');
      consoleView.line(`✔ Проект создан: ${r.dir} — make, make run, make debug, make board`, 'ok');
    } else {
      consoleView.error(r.error || r.log || 'Не удалось создать проект');
    }
  },
  openBuildFolder: () => pazzle.pvm.openBuildFolder(state.filePath),
  build: async () => {
    state.build = null; // явная сборка — всегда заново
    await build();
  },
  run,
  debug: startDebug,
  continue: () => debugCommand('continue'),
  pause: () => debugCommand('pause'),
  stepOver: () => debugCommand('stepOver'),
  stepInto: () => debugCommand('stepInto'),
  stepOut: () => debugCommand('stepOut'),
  stepInstr: () => debugCommand('stepInstr'),
  reset: () => debugCommand('reset'),
  stop,
  toggleBreakpoint() {
    if (state.editor.hasTextFocus() && state.view === 'hlc') {
      const id = blockForLine(state.generated.lineBlocks, state.editor.getPosition().lineNumber);
      return toggleBreakpoint(id && state.ws.getBlockById(id));
    }
    toggleBreakpoint(Blockly.getSelected?.());
  },
  clearConsole: () => consoleView.clear(),
  undo: () => (state.editor.hasTextFocus() ? state.editor.trigger('menu', 'undo') : state.ws.undo(false)),
  redo: () => (state.editor.hasTextFocus() ? state.editor.trigger('menu', 'redo') : state.ws.undo(true)),
  cleanup: () => state.ws.cleanUp(),
  zoomFit: () => state.ws.zoomToFit(),
  async toggleTheme() {
    const theme = state.settings.theme === 'light' ? 'dark' : 'light';
    applySettings(await pazzle.settings.set({theme}));
  },
  async settings() {
    openSettingsDialog({
      settings: state.settings,
      tools: await pazzle.pvm.tools(),
      chooseFolder: () => pazzle.settings.chooseFolder(),
      onSave: async (patch) => applySettings(await pazzle.settings.set(patch)),
    });
  },
  about: showAbout,
};

function runCommand(id, arg) {
  const fn = commands[id];
  if (!fn) return;
  Promise.resolve(fn(arg)).catch((e) => {
    consoleView.error(String(e?.message || e));
    setStatus('Ошибка', true);
  });
}

function wireUi() {
  for (const btn of document.querySelectorAll('[data-cmd]')) {
    btn.addEventListener('click', () => runCommand(btn.dataset.cmd));
  }
  for (const tab of document.querySelectorAll('#code-tabs .tab')) tab.addEventListener('click', () => showCodeView(tab.dataset.view));
  for (const tab of document.querySelectorAll('#bottom-tabs .tab')) tab.addEventListener('click', () => showBottom(tab.dataset.panel));
  $('btn-edit').addEventListener('click', () => toggleManualEdit());
  $('btn-regenerate').addEventListener('click', () => toggleManualEdit(false));
  $('btn-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.editor.getValue());
    setStatus('Код скопирован в буфер обмена');
  });
  $('target').addEventListener('change', async () => {
    state.settings = await pazzle.settings.set({target: target()});
    applyTargetUi();
  });
  $('port').addEventListener('change', async () => {
    state.settings = await pazzle.settings.set({port: $('port').value});
  });
  $('baud').addEventListener('change', async () => {
    state.settings = await pazzle.settings.set({baud: Number($('baud').value)});
  });
  $('btn-ports').addEventListener('click', () => refreshPorts());
  pazzle.onMenu(({id, arg}) => runCommand(id, arg));
  pazzle.pvm.onBuildOutput((o) => consoleView.write(o.text, o.stream === 'command' ? 'command' : o.stream === 'stderr' ? 'stderr' : 'stdout'));
  pazzle.pvm.onRunEvent(onRunEvent);
  pazzle.debug.onEvent(onDebugEvent);
  pazzle.onOpenFile(({path, content}) => {
    if (confirmDiscard()) openProjectText(content, path);
  });
  initSplitters(() => Blockly.svgResize(state.ws));
  window.addEventListener('resize', () => Blockly.svgResize(state.ws));
}

// ---------------------------------------------------------------- старт

async function main() {
  state.settings = await pazzle.settings.get();
  applyPageTheme(state.settings.theme);
  state.language = createLanguage(await pazzle.loadLanguage());
  registerPvmsLanguage();
  registerContextMenu();
  injectWorkspace();
  createEditor();
  wireUi();
  $('target').value = state.settings.target || 'sim';
  applyTargetUi();
  updateButtons();
  await Promise.all([refreshPorts(), refreshTools()]);

  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
    if (saved?.project) {
      restored = openProjectText(saved.project, saved.filePath);
      if (restored && saved.dirty) setDirty(true);
    }
  } catch {
    restored = false;
  }
  if (!restored) {
    const examples = await pazzle.project.examples();
    if (examples[0]) openProjectText(await pazzle.project.readExample(examples[0].file), null);
  }
  regenerate();
  Object.assign(window.pazzleDebug, {commands, toggleBreakpoint});
  if (state.tools?.dir) setStatus('Готово. Ctrl+B — собрать, Ctrl+F5 — запустить, F5 — отладка.');
}

main().catch((e) => {
  console.error(e);
  setStatus('Ошибка запуска интерфейса: ' + (e?.message || e), true);
});
