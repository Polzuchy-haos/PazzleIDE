// Интерфейс PazzleIDE для PVM: блоки и код HLC, сборка, запуск, прошивка и отладка.
//
// Открытые файлы — документы: проект пазлов (.pzl: своё рабочее поле Blockly и
// сгенерированный HLC) или текст (.hlc и любой другой файл в редакторе Monaco).
// Рабочий стол определяет, как они показаны:
//   «Пазлы» — один проект пазлов, код и панель отладки (как раньше);
//   «HLC»   — один файл кода, сборка и отладка по строкам;
//   «IDE»   — дерево папки, вкладки с пазлами и кодом вместе.
import * as Blockly from 'blockly';
import * as Ru from 'blockly/msg/ru';
import {monaco} from './monaco-setup.js';
import {createLanguage, generateCode, buildToolbox, serializeProject, parseProject, loadProjectInto, library} from '../core/index.js';
import {blocklyTheme, monacoTheme, applyPageTheme} from './theme.js';
import {ConsoleView} from './console.js';
import {initSplitters} from './splitter.js';
import {openSettingsDialog} from './settings-dialog.js';
import {openTargetsDialog} from './targets-dialog.js';
import {DebugView} from './debug-view.js';
import {Explorer, samePath, parentOf} from './explorer.js';
import {ask} from './dialogs.js';

Blockly.setLocale(Ru);
// Без комментария-заглушки «Опишите эту функцию…» у новых функций (он попадал бы в код).
Blockly.Msg['PROCEDURES_DEFNORETURN_COMMENT'] = '';
Blockly.Msg['PROCEDURES_DEFRETURN_COMMENT'] = '';
self.MonacoEnvironment = {getWorker: () => new Worker('editor.worker.js')};

const pazzle = window.pazzle;
const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'pazzle.session.v2';
const LEGACY_AUTOSAVE_KEY = 'pazzle.pvm.autosave';
const LAYOUTS = ['blocks', 'hlc', 'ide'];
const LAYOUT_NAMES = {blocks: 'Пазлы', hlc: 'HLC', ide: 'IDE'};
const EMPTY_GENERATED = {code: '', warnings: [], unsupported: [], lineBlocks: {}, names: {}};

/** Новая программа — пара «▶ начало программы» … «■ конец программы»; блоки вставляются между ними. */
const NEW_PROJECT = {
  format: 'pazzleide-project',
  version: 1,
  language: 'pvm',
  workspace: {blocks: {languageVersion: 0, blocks: [{type: 'pvm_start', x: 60, y: 60, next: {block: {type: 'pvm_end'}}}]}},
};
const HLC_TEMPLATE = `// Программа на PVM HLC
volatile int OUT @ 0x4007;   // регистр вывода: в симуляторе — строки вывода

int count;

void main() {
    count = 0;
    while (count < 5) {
        count = count + 1;
        OUT = count;
    }
}
`;

const state = {
  settings: null,
  language: null,
  tools: null,
  targetsInfo: null,
  editor: null,
  decorations: null,
  view: 'hlc',
  layout: 'blocks',
  folder: '',
  docs: [],
  doc: null, // активный документ
  libraries: [],
  debug: {active: false, running: false, build: null, doc: null, snapshot: null, currentBlock: null},
  running: false,
  runKind: null, // run | flash
  busy: false,
};

const consoleView = new ConsoleView($('console-output'));
const debugView = new DebugView({onSelectFrame: (frame, index) => showFrame(frame, index)});
let explorer = null;
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

const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const joinPath = (dir, name) => (dir.includes('\\') ? `${dir.replace(/\\+$/, '')}\\${name}` : `${dir.replace(/\/+$/, '')}/${name}`);
const isBlocksPath = (p) => /\.(pzl|vide)$/i.test(p || '');
const isHlcPath = (p) => !p || /\.hlc$/i.test(p);

function languageForPath(p) {
  const ext = String(p || '.hlc').split('.').pop().toLowerCase();
  if (['hlc', 'c', 'h', 'cpp', 'hpp'].includes(ext)) return 'c';
  if (['pvms', 'lst', 'dbgmap'].includes(ext)) return 'pvms';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['json', 'pzl', 'pzlib', 'js', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (['ini', 'cfg', 'conf', 'gitignore'].includes(ext)) return 'ini';
  if (['sh', 'bash'].includes(ext)) return 'shell';
  if (['bat', 'cmd'].includes(ext)) return 'bat';
  if (['yml', 'yaml'].includes(ext)) return 'yaml';
  if (ext === 'py') return 'python';
  return 'plaintext';
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

// ---------------------------------------------------------------- документы

let docSeq = 0;

function docName(doc) {
  if (doc.path) return baseName(doc.path);
  return doc.suggestedName || (doc.kind === 'blocks' ? 'Без имени.pzl' : 'Без имени.hlc');
}

function baseDoc(kind, path) {
  return {
    id: ++docSeq,
    kind,
    path: path || null,
    dirty: false,
    build: null,
    buildErrors: new Map(),
    lastActive: Date.now(),
    viewState: {},
    models: {
      pvms: monaco.editor.createModel('# Ассемблер появится после сборки (Ctrl+B)\n', 'pvms'),
      lst: monaco.editor.createModel('# Листинг появится после сборки (Ctrl+B)\n', 'pvms'),
    },
  };
}

/** Проект пазлов из текста .pzl; null — файл не разобрать (сообщение — в консоли). */
function createBlocksDoc(text, path) {
  let project;
  try {
    project = typeof text === 'string' ? parseProject(text) : text;
  } catch (e) {
    consoleView.error(`Не удалось открыть ${path ? baseName(path) : 'проект'}: ${e.message}`);
    setStatus('Ошибка открытия проекта', true);
    return null;
  }
  const doc = baseDoc('blocks', path);
  Object.assign(doc, {breakpoints: new Set(), generated: EMPTY_GENERATED, manualEdit: false, appliedWarnings: new Map(), regenTimer: null});
  doc.models.hlc = monaco.editor.createModel('', 'c');
  doc.host = document.createElement('div');
  doc.host.className = 'ws-host';
  doc.host.hidden = true;
  $('blockly').append(doc.host);
  doc.host.hidden = false; // Blockly меряет контейнер при создании
  injectWorkspace(doc);
  doc.host.hidden = true;
  loadProjectInto(doc.ws, project);
  doc.breakpoints = new Set((project.breakpoints || []).filter((id) => doc.ws.getBlockById(id)));
  state.docs.push(doc);
  regenerate(doc);
  return doc;
}

function createTextDoc(content, path) {
  const doc = baseDoc('text', path);
  doc.models.hlc = monaco.editor.createModel(content, languageForPath(path));
  doc.savedVersion = doc.models.hlc.getAlternativeVersionId();
  doc.bpDecorations = [];
  doc.models.hlc.onDidChangeContent(() => {
    setDocDirty(doc, doc.models.hlc.getAlternativeVersionId() !== doc.savedVersion);
    scheduleSession();
    if (state.debug.active && state.debug.doc === doc) setStatus('Код изменён после сборки — перезапустите отладку, чтобы изменения попали в программу');
  });
  state.docs.push(doc);
  return doc;
}

function setDocDirty(doc, value) {
  if (doc.dirty !== value) {
    doc.dirty = value;
    renderTabs();
    updateTitle();
  }
  pazzle.setDirty(state.docs.some((d) => d.dirty));
}

function disposeDoc(doc) {
  if (doc.ws) doc.ws.dispose();
  doc.host?.remove();
  for (const m of Object.values(doc.models)) m.dispose();
  state.docs = state.docs.filter((d) => d !== doc);
  pazzle.setDirty(state.docs.some((d) => d.dirty));
}

function confirmDiscard(doc) {
  return !doc?.dirty || window.confirm(`В «${docName(doc)}» есть несохранённые изменения. Закрыть без сохранения?`);
}

async function closeDoc(doc, {force = false} = {}) {
  if (!doc) return true;
  if (!force && !confirmDiscard(doc)) return false;
  if (state.debug.doc === doc || (state.running && state.doc === doc)) await stop();
  const wasActive = state.doc === doc;
  disposeDoc(doc);
  if (wasActive) {
    state.doc = null;
    const next = mostRecent(state.layout === 'ide' ? null : state.layout === 'blocks' ? 'blocks' : 'text');
    if (next) activateDoc(next);
    else if (state.layout === 'ide') activateDoc(null);
    else ensureLayoutDoc();
  }
  renderTabs();
  scheduleSession();
  return true;
}

function mostRecent(kind) {
  return (
    state.docs
      .filter((d) => !kind || d.kind === kind)
      .filter((d) => kind !== 'text' || state.layout !== 'hlc' || isHlcPath(d.path))
      .sort((a, b) => b.lastActive - a.lastActive)[0] || null
  );
}

function activateDoc(doc) {
  const prev = state.doc;
  if (prev && prev !== doc && state.editor.getModel()) {
    prev.viewState[state.view] = state.editor.saveViewState();
    if (prev.host) prev.host.hidden = true;
  }
  state.doc = doc;
  document.body.dataset.doc = doc ? doc.kind : 'none';
  $('no-doc').hidden = !!doc;
  if (doc) {
    doc.lastActive = Date.now();
    if (doc.host) {
      doc.host.hidden = false;
      requestAnimationFrame(() => doc.ws && Blockly.svgResize(doc.ws));
    }
    if (state.view !== 'hlc' && !doc.build) state.view = 'hlc';
    showCodeView(state.view);
    applyManualEditUi();
    updateWarningsBadge();
    updateDocStatus();
    $('status-memory').textContent = doc.build ? formatMemory(doc.build) : '';
    explorer?.reveal(doc.path);
  } else {
    state.editor.setModel(null);
  }
  renderTabs();
  updateTitle();
  updateButtons();
  scheduleSession();
}

function updateTitle() {
  const doc = state.doc;
  document.title = doc ? `${docName(doc)}${doc.dirty ? ' •' : ''} — PazzleIDE` : 'PazzleIDE';
}

function updateDocStatus() {
  const doc = state.doc;
  if (!doc) return ($('status-blocks').textContent = '');
  $('status-blocks').textContent = doc.kind === 'blocks' ? `Блоков: ${doc.ws.getAllBlocks(false).length}` : `Строк: ${doc.models.hlc.getLineCount()}`;
}

function renderTabs() {
  const bar = $('doc-tabs');
  bar.textContent = '';
  for (const doc of state.docs) {
    const tab = document.createElement('div');
    tab.className = 'doc-tab' + (doc === state.doc ? ' active' : '') + (doc.dirty ? ' dirty' : '');
    tab.title = doc.path || 'Не сохранён';
    const icon = document.createElement('span');
    icon.className = `doc-icon ${doc.kind}`;
    icon.textContent = doc.kind === 'blocks' ? '🧩' : '</>';
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = docName(doc);
    const close = document.createElement('button');
    close.className = 'doc-close';
    close.title = 'Закрыть (Ctrl+W)';
    close.textContent = doc.dirty ? '●' : '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDoc(doc);
    });
    tab.append(icon, name, close);
    tab.addEventListener('click', () => activateDoc(doc));
    tab.addEventListener('auxclick', (e) => e.button === 1 && closeDoc(doc));
    bar.append(tab);
  }
}

/**
 * Открывает текст как документ. На рабочих столах «Пазлы» и «HLC» документ один:
 * новый заменяет текущий того же вида (если в нём ничего не потеряется), а файл
 * другого вида переключает рабочий стол. В «IDE» каждый файл — своя вкладка.
 */
function openContent(kind, content, path, {suggestedName} = {}) {
  let replace = null;
  if (state.layout !== 'ide') {
    const wanted = kind === 'blocks' ? 'blocks' : 'hlc';
    if (state.layout !== wanted) setLayout(wanted, {ensure: false});
    replace = state.doc?.kind === kind ? state.doc : null;
    if (replace && !confirmDiscard(replace)) return null;
  }
  const doc = kind === 'blocks' ? createBlocksDoc(content, path) : createTextDoc(content, path);
  if (!doc) return null;
  doc.suggestedName = suggestedName;
  activateDoc(doc);
  if (replace) {
    if (state.debug.doc === replace || state.running) stop();
    disposeDoc(replace);
    renderTabs();
  }
  if (kind === 'blocks') setTimeout(() => doc.ws && !doc.ws.isDisposed?.() && doc.ws.scrollCenter(), 0);
  scheduleSession();
  return doc;
}

async function openPath(path, {content} = {}) {
  const existing = state.docs.find((d) => d.path && samePath(d.path, path));
  if (existing) {
    if (state.layout !== 'ide') setLayout(existing.kind === 'blocks' ? 'blocks' : 'hlc', {ensure: false});
    activateDoc(existing);
    return existing;
  }
  let text = content;
  if (text === undefined) {
    try {
      const r = await pazzle.fs.read(path);
      if (r.binary) {
        setStatus(`${baseName(path)} — не текстовый файл, открыт в системе`);
        pazzle.fs.openExternal(path);
        return null;
      }
      text = r.content;
    } catch (e) {
      consoleView.error(`Не удалось открыть ${path}: ${e.message}`);
      return null;
    }
  }
  return openContent(isBlocksPath(path) ? 'blocks' : 'text', text, path);
}

async function saveDoc(doc, saveAs = false) {
  if (!doc) return false;
  const content = doc.kind === 'blocks' ? serializeDoc(doc) : doc.models.hlc.getValue();
  const saved = await pazzle.file.save({path: saveAs ? null : doc.path, content, kind: doc.kind, defaultName: doc.suggestedName || docName(doc)});
  if (!saved) return false;
  const moved = !doc.path || !samePath(doc.path, saved);
  doc.path = saved;
  if (doc.kind === 'text') {
    doc.savedVersion = doc.models.hlc.getAlternativeVersionId();
    monaco.editor.setModelLanguage(doc.models.hlc, languageForPath(saved));
  }
  if (moved) doc.build = null; // папка сборки — рядом с файлом
  setDocDirty(doc, false);
  renderTabs();
  updateTitle();
  explorer?.reveal(saved);
  scheduleSession();
  setStatus(`Сохранено: ${saved}`);
  return true;
}

// ---------------------------------------------------------------- рабочие столы

function setLayout(layout, {persist = true, ensure = true} = {}) {
  if (!LAYOUTS.includes(layout)) layout = 'blocks';
  state.layout = layout;
  document.body.dataset.layout = layout;
  for (const b of document.querySelectorAll('#layout-switch button')) b.classList.toggle('active', b.dataset.layout === layout);
  if (persist) pazzle.settings.set({layout}).then((s) => (state.settings = s));
  if (ensure) ensureLayoutDoc();
  renderTabs();
  $('btn-new').title = layout === 'hlc' ? 'Новый файл HLC (Ctrl+Alt+N)' : 'Новый проект пазлов (Ctrl+N)';
  requestAnimationFrame(() => state.doc?.ws && Blockly.svgResize(state.doc.ws));
}

/** На рабочем столе должен быть документ своего вида: последний такой или новый. */
function ensureLayoutDoc() {
  const layout = state.layout;
  if (layout === 'blocks' && state.doc?.kind !== 'blocks') {
    activateDoc(mostRecent('blocks') || createBlocksDoc(structuredClone(NEW_PROJECT), null));
  } else if (layout === 'hlc' && !(state.doc?.kind === 'text' && isHlcPath(state.doc.path))) {
    activateDoc(mostRecent('text') || createTextDoc(HLC_TEMPLATE, null));
  } else if (layout === 'ide') {
    activateDoc(state.doc || mostRecent(null));
  }
}

async function setFolder(dir) {
  state.folder = dir || '';
  state.settings = await pazzle.settings.set({folder: state.folder});
  await explorer.setRoot(state.folder || null);
  explorer.reveal(state.doc?.path);
  pazzle.fs.watch(state.folder || null);
  refreshLibraries();
}

// ---------------------------------------------------------------- рабочее поле пазлов

function docOfWorkspace(ws) {
  const root = ws?.getRootWorkspace?.() || ws;
  return state.docs.find((d) => d.ws === root || d.ws === ws) || null;
}

function injectWorkspace(doc) {
  const ws = Blockly.inject(doc.host, {
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
  ws.addChangeListener((e) => onWorkspaceChange(doc, e));
  ws.registerToolboxCategoryCallback('PVM_CONSTANTS', constantsFlyout);
  ws.registerToolboxCategoryCallback('VARIABLE', variablesFlyout);
  ws.registerToolboxCategoryCallback('PAZZLE_LIBRARIES', librariesFlyout);
  doc.ws = ws;
  return ws;
}

function recreateWorkspace(doc) {
  const saved = Blockly.serialization.workspaces.save(doc.ws);
  const hidden = doc.host.hidden;
  doc.ws.dispose();
  doc.host.hidden = false;
  injectWorkspace(doc);
  doc.host.hidden = hidden;
  loadProjectInto(doc.ws, {workspace: saved});
  doc.appliedWarnings.clear();
  regenerate(doc);
}

/** Категория «Переменные»: стандартные блоки Blockly + «локальная переменная» для функций. */
function variablesFlyout(ws) {
  const items = Blockly.Variables.flyoutCategory(ws, false);
  const localType = state.language.pack.localBlock;
  if (!localType) return items;
  const first = ws.getVariableMap().getAllVariables()[0];
  items.push(
    {kind: 'label', text: 'Только внутри функции — своя копия у каждого вызова:'},
    {kind: 'block', type: localType, ...(first ? {fields: {VAR: {name: first.getName()}}} : {})},
  );
  return items;
}

/** Имена объявленных констант по порядку (без повторов). */
function definedConstants(ws) {
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
function renameConstantUses(doc, e) {
  if (e.type !== Blockly.Events.BLOCK_CHANGE || e.element !== 'field' || e.name !== 'NAME') return;
  const block = doc.ws.getBlockById(e.blockId);
  if (block?.type !== 'pvm_const_define') return;
  const from = String(e.oldValue).trim();
  const to = String(e.newValue).trim();
  if (!from || from === to || definedConstants(doc.ws).includes(from)) return; // старое имя ещё объявлено в другом месте
  for (const b of doc.ws.getAllBlocks(false)) {
    if (b.type === 'pvm_const_get' && b.getFieldValue('NAME') === from) b.setFieldValue(to, 'NAME');
  }
}

function scheduleRegenerate(doc) {
  clearTimeout(doc.regenTimer);
  doc.regenTimer = setTimeout(() => regenerate(doc), 120);
}

function onWorkspaceChange(doc, e) {
  if (e.type === Blockly.Events.BLOCK_CREATE) importLibraryDependencies(doc, e);
  if (e.isUiEvent || e.type === Blockly.Events.FINISHED_LOADING) return;
  if (e.type === Blockly.Events.BLOCK_DELETE) {
    for (const id of e.ids || []) doc.breakpoints.delete(id);
  }
  renameConstantUses(doc, e);
  setDocDirty(doc, true);
  scheduleRegenerate(doc);
  scheduleSession();
}

/** Предупреждения на блоках: неподдерживаемые блоки и ошибки компиляции (ставятся только при изменении). */
function applyBlockWarnings(doc) {
  const g = doc.generated;
  const unsupported = new Set(g.unsupported || []);
  const detached = new Set(g.detached || []);
  const extraEntries = new Set(g.extraEntries || []);
  const misplacedLocals = new Set(g.misplacedLocals || []);
  const constCount = new Map();
  for (const b of doc.ws.getAllBlocks(false)) {
    if (b.type === 'pvm_const_define' && b.isEnabled()) {
      const name = b.getFieldValue('NAME').trim();
      constCount.set(name, (constCount.get(name) || 0) + 1);
    }
  }
  for (const block of doc.ws.getAllBlocks(false)) {
    let text = doc.buildErrors.get(block.id) || null;
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
    if (!text && misplacedLocals.has(block.id)) {
      text = 'Локальная переменная работает только внутри функции — здесь это обычное присваивание глобальной';
    }
    if (!text && extraEntries.has(block.id)) {
      text = 'Блок «начало программы» должен быть один — выполняется только верхний';
    }
    if ((doc.appliedWarnings.get(block.id) || null) === text) continue;
    block.setWarningText(text);
    if (text) doc.appliedWarnings.set(block.id, text);
    else doc.appliedWarnings.delete(block.id);
  }
}

// ---------------------------------------------------------------- точки останова

function refreshBreakpointVisuals(doc) {
  if (doc?.kind !== 'blocks') return;
  for (const block of doc.ws.getAllBlocks(false)) {
    block.getSvgRoot()?.classList.toggle('pz-bp', doc.breakpoints.has(block.id));
  }
  if (doc === state.doc) refreshEditorDecorations();
}

function canHaveBreakpoint(block) {
  // У «начала программы» нет своего кода — останавливаться можно на блоках под ним.
  return block && !block.outputConnection && !block.isShadow() && !block.workspace.isFlyout && block.type !== state.language.pack.entryBlock;
}

function toggleBreakpoint(block) {
  if (!canHaveBreakpoint(block)) return;
  const doc = docOfWorkspace(block.workspace);
  if (!doc) return;
  if (doc.breakpoints.has(block.id)) doc.breakpoints.delete(block.id);
  else doc.breakpoints.add(block.id);
  refreshBreakpointVisuals(doc);
  scheduleSession();
  syncDebugBreakpoints(doc);
}

/** Точка останова на строке текстового документа — декорация модели: она переезжает вместе со строкой при правке. */
function toggleLineBreakpoint(doc, line) {
  const model = doc.models.hlc;
  const here = doc.bpDecorations.filter((id) => model.getDecorationRange(id)?.startLineNumber === line);
  if (here.length) {
    model.deltaDecorations(here, []);
    doc.bpDecorations = doc.bpDecorations.filter((id) => !here.includes(id));
  } else {
    const [id] = model.deltaDecorations(
      [],
      [
        {
          range: new monaco.Range(line, 1, line, 1),
          options: {glyphMarginClassName: 'pz-bp-glyph', glyphMarginHoverMessage: {value: 'Точка останова'}, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges},
        },
      ],
    );
    doc.bpDecorations.push(id);
  }
  scheduleSession();
  syncDebugBreakpoints(doc);
}

function textBreakpointLines(doc) {
  const model = doc.models.hlc;
  const lines = doc.bpDecorations.map((id) => model.getDecorationRange(id)?.startLineNumber).filter(Boolean);
  return [...new Set(lines)].sort((a, b) => a - b);
}

function breakpointLines(doc, build) {
  if (!doc || !build) return [];
  if (doc.kind === 'text') return textBreakpointLines(doc);
  return [...doc.breakpoints].map((id) => lineForBlock(build.lineBlocks, id)).filter(Boolean);
}

function syncDebugBreakpoints(doc) {
  if (state.debug.active && state.debug.doc === doc) pazzle.debug.command('breakpoints', breakpointLines(doc, state.debug.build));
}

function registerContextMenus() {
  const registry = Blockly.ContextMenuRegistry.registry;
  const add = (item) => registry.getItem(item.id) || registry.register(item);
  add({
    id: 'pazzle_toggle_breakpoint',
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -10,
    displayText: (scope) => (docOfWorkspace(scope.block.workspace)?.breakpoints.has(scope.block.id) ? 'Убрать точку останова (F9)' : 'Точка останова (F9)'),
    preconditionFn: (scope) => (canHaveBreakpoint(scope.block) ? 'enabled' : 'hidden'),
    callback: (scope) => toggleBreakpoint(scope.block),
  });
  add({
    id: 'pazzle_save_to_library',
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -9,
    displayText: (scope) => (library.itemKind(scope.block) === 'snippet' ? 'Сохранить фрагмент в библиотеку…' : 'Сохранить в библиотеку…'),
    preconditionFn: (scope) => (scope.block.workspace.isFlyout || scope.block.isShadow() || scope.block.type === state.language.pack.entryBlock ? 'hidden' : 'enabled'),
    callback: (scope) => runCommand('saveToLibrary', scope.block),
  });
  add({
    id: 'pazzle_remove_from_library',
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -8,
    displayText: 'Удалить из библиотеки',
    preconditionFn: (scope) =>
      scope.block.workspace.isFlyout && String(scope.block.data || '').startsWith(library.LIBRARY_DATA_PREFIX) ? 'enabled' : 'hidden',
    callback: (scope) => runCommand('removeFromLibrary', scope.block),
  });
}

// ---------------------------------------------------------------- редактор кода

function refreshEditorDecorations() {
  if (!state.decorations) return;
  const doc = state.doc;
  const items = [];
  if (doc && state.view === 'hlc') {
    if (doc.kind === 'blocks') {
      for (const id of doc.breakpoints) {
        const line = lineForBlock(doc.generated.lineBlocks, id);
        if (line) items.push({range: new monaco.Range(line, 1, line, 1), options: {glyphMarginClassName: 'pz-bp-glyph', glyphMarginHoverMessage: {value: 'Точка останова'}}});
      }
    }
    const debugHere = state.debug.active && state.debug.doc === doc && !state.debug.running;
    const snap = state.debug.snapshot;
    if (debugHere && snap?.line) {
      items.push({range: new monaco.Range(snap.line, 1, snap.line, 1), options: {isWholeLine: true, className: 'pz-current-line', glyphMarginClassName: 'pz-current-glyph'}});
    }
    if (debugHere && state.debug.frameLine) {
      const l = state.debug.frameLine;
      items.push({range: new monaco.Range(l, 1, l, 1), options: {isWholeLine: true, className: 'pz-frame-line', hoverMessage: {value: 'Место вызова выбранной функции'}}});
    }
  }
  state.decorations.set(items);
}

function regenerate(doc = state.doc) {
  if (!doc || doc.kind !== 'blocks' || !doc.ws) return;
  if (doc === state.doc) updateDocStatus();
  if (doc.manualEdit) return;
  const result = generateCode(state.language, doc.ws);
  if (result.error) {
    setStatus('Ошибка генерации кода — подробности в консоли', true);
    consoleView.error(result.error);
    return;
  }
  doc.generated = result;
  const model = doc.models.hlc;
  if (model.getValue() !== result.code) {
    const shown = state.editor.getModel() === model;
    const top = shown ? state.editor.getScrollTop() : 0;
    model.setValue(result.code);
    if (shown) state.editor.setScrollTop(top);
  }
  if (doc === state.doc) updateWarningsBadge();
  applyBlockWarnings(doc);
  refreshBreakpointVisuals(doc);
  if (state.debug.active && state.debug.doc === doc && state.debug.build && state.debug.build.code !== result.code) {
    setStatus('Блоки изменены после сборки — перезапустите отладку, чтобы изменения попали в программу');
  }
}

function updateWarningsBadge() {
  const warnings = state.doc?.kind === 'blocks' ? state.doc.generated.warnings || [] : [];
  const badge = $('code-warnings');
  badge.hidden = !warnings.length;
  badge.textContent = `⚠ ${warnings.length}`;
  badge.title = warnings.join('\n');
}

function showCodeView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('#code-tabs .tab')) tab.classList.toggle('active', tab.dataset.view === view);
  const doc = state.doc;
  if (!doc) return;
  const model = doc.models[view];
  if (state.editor.getModel() !== model) {
    const current = state.docs.find((d) => Object.values(d.models).includes(state.editor.getModel()));
    if (current) current.viewState[Object.keys(current.models).find((k) => current.models[k] === state.editor.getModel())] = state.editor.saveViewState();
    state.editor.setModel(model);
    if (doc.viewState[view]) state.editor.restoreViewState(doc.viewState[view]);
  }
  const editable = view === 'hlc' && (doc.kind === 'text' || doc.manualEdit);
  state.editor.updateOptions({
    readOnly: !editable,
    glyphMargin: view === 'hlc',
    readOnlyMessage: {value: doc.kind === 'blocks' ? 'Код создаётся из блоков. Нажмите «Править», чтобы изменить его вручную.' : 'Ассемблер и листинг — результат сборки.'},
  });
  $('tab-hlc').textContent = doc.kind === 'text' ? docName(doc) : 'HLC';
  $('btn-edit').hidden = view !== 'hlc' || doc.kind !== 'blocks';
  refreshEditorDecorations();
}

function createEditor() {
  state.editor = monaco.editor.create($('code'), {
    model: null,
    readOnly: true,
    theme: monacoTheme(state.settings.theme),
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
  state.decorations = state.editor.createDecorationsCollection();
  // Щелчок слева от строки — точка останова: на блоке этой строки или на самой строке файла.
  state.editor.onMouseDown((e) => {
    const doc = state.doc;
    if (!doc || state.view !== 'hlc') return;
    const t = e.target.type;
    if (t !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && t !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    const line = e.target.position?.lineNumber;
    if (!line) return;
    if (doc.kind === 'text') return toggleLineBreakpoint(doc, line);
    const id = blockForLine(doc.generated.lineBlocks, line);
    const block = id ? doc.ws.getBlockById(id) : null;
    if (block) toggleBreakpoint(block);
  });
  // Курсор в коде -> выделить соответствующий блок.
  state.editor.onDidChangeCursorPosition((e) => {
    const doc = state.doc;
    if (doc?.kind !== 'blocks' || state.view !== 'hlc' || e.source !== 'mouse' || doc.manualEdit) return;
    const id = blockForLine(doc.generated.lineBlocks, e.position.lineNumber);
    const block = id && doc.ws.getBlockById(id);
    if (block) block.select();
  });
  state.editor.onDidChangeModelContent(() => state.doc?.kind === 'text' && updateDocStatus());
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

function applyManualEditUi() {
  const doc = state.doc;
  const manual = doc?.kind === 'blocks' && doc.manualEdit;
  $('btn-edit').classList.toggle('active', !!manual);
  $('code-banner').hidden = !manual;
}

function toggleManualEdit(force) {
  const doc = state.doc;
  if (doc?.kind !== 'blocks') return;
  doc.manualEdit = force ?? !doc.manualEdit;
  if (state.view !== 'hlc') showCodeView('hlc');
  else showCodeView('hlc'); // обновить «только чтение»
  applyManualEditUi();
  if (doc.manualEdit) state.editor.focus();
  else regenerate(doc);
}

function currentCode(doc = state.doc) {
  if (!doc) return '';
  if (doc.kind === 'text') return doc.models.hlc.getValue();
  if (!doc.manualEdit) regenerate(doc);
  return doc.manualEdit ? doc.models.hlc.getValue() : doc.generated.code;
}

// ---------------------------------------------------------------- сохранение сеанса

function serializeDoc(doc) {
  const data = serializeProject(doc.ws, {language: 'pvm'});
  data.breakpoints = [...doc.breakpoints];
  return JSON.stringify(data, null, 2);
}

/** Открытые документы переживают перезапуск: сохранённые файлы перечитываются с диска, остальное — из сеанса. */
function saveSession() {
  try {
    const docs = state.docs.map((d) => ({
      kind: d.kind,
      path: d.path,
      dirty: d.dirty,
      suggestedName: d.suggestedName,
      content: d.dirty || !d.path ? (d.kind === 'blocks' ? serializeDoc(d) : d.models.hlc.getValue()) : null,
      breakpoints: d.kind === 'blocks' ? [...d.breakpoints] : textBreakpointLines(d),
      manualCode: d.kind === 'blocks' && d.manualEdit ? d.models.hlc.getValue() : undefined,
    }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({docs, active: state.docs.indexOf(state.doc)}));
  } catch {
    // Нет места или хранилище недоступно — не критично.
  }
}
const scheduleSession = debounce(saveSession, 800);

async function restoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!saved) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_AUTOSAVE_KEY) || 'null');
      if (legacy?.project) saved = {docs: [{kind: 'blocks', path: legacy.filePath, dirty: legacy.dirty, content: legacy.project}], active: 0};
    }
  } catch {
    saved = null;
  }
  if (!saved?.docs?.length) return false;
  const restored = [];
  for (const d of saved.docs) {
    let content = d.content;
    if (content == null && d.path) {
      try {
        const r = await pazzle.fs.read(d.path);
        if (r.binary) continue;
        content = r.content;
      } catch {
        continue; // файл удалён или перемещён
      }
    }
    if (content == null) continue;
    const doc = d.kind === 'blocks' ? createBlocksDoc(content, d.path) : createTextDoc(content, d.path);
    if (!doc) continue;
    doc.suggestedName = d.suggestedName;
    if (d.kind === 'blocks') {
      doc.breakpoints = new Set((d.breakpoints || []).filter((id) => doc.ws.getBlockById(id)));
      if (d.manualCode !== undefined) {
        doc.manualEdit = true;
        doc.models.hlc.setValue(d.manualCode);
      }
      refreshBreakpointVisuals(doc);
      setDocDirty(doc, !!d.dirty);
    } else {
      for (const line of d.breakpoints || []) if (line <= doc.models.hlc.getLineCount()) toggleLineBreakpoint(doc, line);
      if (d.dirty) {
        doc.savedVersion = -1;
        setDocDirty(doc, true);
      }
    }
    restored.push(doc);
  }
  const active = restored[Math.min(Math.max(saved.active ?? 0, 0), restored.length - 1)];
  if (active) active.lastActive = Date.now() + 1;
  return restored.length > 0;
}

// ---------------------------------------------------------------- цели

function currentTarget() {
  const list = state.settings.targets || [];
  return list.find((t) => t.id === state.settings.target) || list[0];
}

function renderTargetSelect() {
  const select = $('target');
  select.textContent = '';
  for (const t of state.settings.targets) select.append(new Option(t.name, t.id));
  select.value = currentTarget().id;
}

function applyTargetUi() {
  const t = currentTarget();
  const board = t.mode !== 'sim';
  const serial = board && t.connection !== 'tcp';
  $('port-box').hidden = !serial;
  $('btn-ports').hidden = !serial;
  $('tcp-box').hidden = !(board && t.connection === 'tcp');
  $('tcp-box').textContent = `TCP ${t.tcp}`;
  $('baud').value = String(t.baud || 9600);
  if ([...$('port').options].some((o) => o.value === t.port)) $('port').value = t.port;
  const limits = Object.entries(t.limits || {}).filter(([, v]) => v).map(([k, v]) => `${{code: 'код', ram: 'RAM', stack: 'стек'}[k]} ${v}`);
  $('status-target').textContent = `Цель: ${t.name}${limits.length ? ` (${limits.join(', ')})` : ''}${t.bridge ? ' · мост' : ''}`;
  $('btn-flash').classList.toggle('unset', !t.flash);
  $('btn-flash').title = t.flash ? `Прошить / загрузить (Ctrl+U):\n${t.flash}` : 'Прошить / загрузить (Ctrl+U): у цели нет команды прошивки — нажмите, чтобы задать';
}

/** Изменить текущую цель (порт и скорость с панели инструментов). */
async function updateCurrentTarget(patch) {
  const id = currentTarget().id;
  const targets = state.settings.targets.map((t) => (t.id === id ? {...t, ...patch} : t));
  state.settings = await pazzle.settings.set({targets});
  applyTargetUi();
}

async function openTargets({focus} = {}) {
  openTargetsDialog({
    targets: state.settings.targets,
    current: state.settings.target,
    info: state.targetsInfo,
    ports: await pazzle.pvm.ports(),
    focus,
    onSave: async ({targets, target}) => {
      state.settings = await pazzle.settings.set({targets, target});
      renderTargetSelect();
      await refreshPorts();
      applyTargetUi();
      setStatus(`Цель: ${currentTarget().name}`);
    },
  });
}

async function refreshPorts() {
  const ports = await pazzle.pvm.ports();
  const select = $('port');
  const wanted = currentTarget().port || state.settings.port || 'COM3';
  select.textContent = '';
  const all = [...new Set([...(ports || []), wanted])];
  for (const p of all) select.append(new Option(ports?.includes(p) ? p : `${p} (не найден)`, p));
  select.value = wanted;
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
  return [part('код', m.code) || `код ${build.size} Б`, part('RAM', m.ram), stackText(build.stack) || part('стек', m.stack)].filter(Boolean).join(' · ');
}

const LIMIT_NAMES = {code: 'код', ram: 'RAM', stack: 'стек'};
const LIMIT_UNITS = {code: 'байт', ram: 'слов', stack: 'слов'};

function describeLimits(r) {
  const applied = Object.entries(r.limits?.applied || {});
  const own = r.limits?.own || [];
  const lines = [];
  if (applied.length) lines.push(`Ограничения цели «${r.target}»: ${applied.map(([k, v]) => `${LIMIT_NAMES[k]} ≤ ${v} ${LIMIT_UNITS[k]}`).join(', ')}`);
  if (own.length) lines.push(`Из кода (блок «память» / section): ${own.map((k) => LIMIT_NAMES[k]).join(', ')} — ограничение цели для них не применено`);
  return lines;
}

async function build({silent = false} = {}) {
  const doc = state.doc;
  if (!doc || state.busy) return null;
  if (doc.kind === 'text' && !isHlcPath(doc.path)) {
    consoleView.error(`Собирается только код HLC (.hlc): «${docName(doc)}» — не программа.`);
    setStatus('Активный файл — не код HLC', true);
    return null;
  }
  const code = currentCode(doc);
  const target = currentTarget();
  const key = `${code}\u0000${JSON.stringify(target.limits || {})}`;
  const snapshot = {
    code,
    key,
    lineBlocks: doc.kind === 'blocks' && !doc.manualEdit ? doc.generated.lineBlocks : {},
    names: doc.kind === 'blocks' ? doc.generated.names : {},
  };
  if (doc.build && doc.build.key === key) return doc.build;

  state.busy = true;
  showBottom('console-panel');
  consoleView.line(`— Сборка: ${docName(doc)} —`, 'info');
  setStatus('Сборка…');
  const r = await pazzle.pvm.build({code, projectPath: doc.path, sourceDir: doc.path ? parentOf(doc.path) : state.folder || null});
  state.busy = false;
  for (const line of describeLimits(r)) consoleView.info(line);

  doc.buildErrors.clear();
  const own = (e) => /main\.hlc$/i.test(e.file);
  if (!r.ok) {
    for (const err of r.errors || []) {
      const id = own(err) ? blockForLine(snapshot.lineBlocks, err.line) : null;
      if (id) doc.buildErrors.set(id, `Ошибка компиляции: ${err.message}`);
    }
    monaco.editor.setModelMarkers(
      doc.models.hlc,
      'pvmcc',
      (r.errors || [])
        .filter(own)
        .map((e) => ({startLineNumber: e.line, endLineNumber: e.line, startColumn: 1, endColumn: 200, message: e.message, severity: monaco.MarkerSeverity.Error})),
    );
    if (doc.kind === 'blocks') applyBlockWarnings(doc);
    if (r.stage === 'tools') consoleView.error(r.log);
    consoleView.error(`✖ Сборка не удалась${r.errors?.length ? ': ' + r.errors.map((e) => `${own(e) ? '' : e.file + ' '}строка ${e.line}: ${e.message}`).join('; ') : ''}`);
    const first = [...doc.buildErrors.keys()][0];
    if (first) doc.ws.getBlockById(first)?.select();
    const firstLine = (r.errors || []).find(own)?.line;
    if (firstLine) {
      showCodeView('hlc');
      state.editor.revealLineInCenter(firstLine);
    }
    setStatus('Ошибка сборки', true);
    return null;
  }
  monaco.editor.setModelMarkers(doc.models.hlc, 'pvmcc', []);
  if (doc.kind === 'blocks') applyBlockWarnings(doc);
  doc.build = {...r, ...snapshot};
  doc.models.pvms.setValue(r.texts?.pvms || '');
  doc.models.lst.setValue(r.texts?.lst || '');
  if (doc === state.doc) $('status-memory').textContent = formatMemory(r);
  consoleView.line(`✔ Собрано: ${r.dir}  (${formatMemory(r)})`, 'ok');
  if (!silent) setStatus(`Собрано: ${formatMemory(r)}`);
  return doc.build;
}

// ---------------------------------------------------------------- запуск и прошивка

function setRunning(running, kind = 'run') {
  state.running = running;
  state.runKind = running ? kind : null;
  $('run-controls').hidden = !running;
  updateButtons();
  const badge = $('run-state');
  const name = currentTarget().name;
  badge.textContent = running ? (kind === 'flash' ? `● прошивка (${name})` : `● выполняется (${name})`) : '';
  badge.classList.toggle('running', running);
}

function updateButtons() {
  const debugging = state.debug.active;
  const busy = state.running || debugging;
  const noDoc = !state.doc;
  $('btn-run').disabled = busy || noDoc;
  $('btn-build').disabled = busy || noDoc;
  $('btn-flash').disabled = busy || noDoc;
  $('btn-debug').disabled = noDoc && !debugging;
  $('btn-debug').hidden = debugging;
  $('debug-controls').hidden = !debugging;
  document.body.classList.toggle('debugging', debugging); // без подписей у неактивных кнопок — панель в одну строку
  $('target').disabled = busy;
  $('port').disabled = busy;
  $('baud').disabled = busy;
  const running = state.debug.running;
  for (const b of document.querySelectorAll('#debug-controls .step')) b.disabled = running;
  $('dbg-continue').disabled = running;
  $('dbg-pause').disabled = !running;
}

async function run() {
  if (state.running || state.debug.active || !state.doc) return;
  const t = currentTarget();
  if (t.mode === 'board-flash' && !t.run) {
    consoleView.error('Прошитая программа выполняется на плате сама. Загрузить новую — «Прошить» (Ctrl+U), управлять ею — «Отладка».');
    return;
  }
  const doc = state.doc;
  const b = await build({silent: true});
  if (!b) return;
  showBottom('console-panel');
  consoleView.line(`— Запуск: ${t.name}${t.run ? ' (своя команда)' : ''} —`, 'info');
  setRunning(true, 'run');
  const r = await pazzle.pvm.run({
    files: b.files,
    projectPath: doc.path,
    folder: state.folder || null,
    outputFilter: state.settings.rawOutput ? null : state.language.pack.outputFilter,
  });
  if (!r.ok) {
    setRunning(false);
    consoleView.error(r.error);
    setStatus('Не удалось запустить', true);
  } else {
    setStatus(`Выполняется: ${t.name}`);
  }
}

async function flash() {
  if (state.running || state.debug.active || !state.doc) return;
  const t = currentTarget();
  if (!t.flash) {
    consoleView.error(`У цели «${t.name}» не задана команда прошивки. Задайте её в целях (поле «Прошить / загрузить»).`);
    setStatus('Нет команды прошивки', true);
    openTargets({focus: 'flash'});
    return;
  }
  const doc = state.doc;
  const b = await build({silent: true});
  if (!b) return;
  showBottom('console-panel');
  consoleView.line(`— Прошивка: ${t.name} —`, 'info');
  setRunning(true, 'flash');
  const r = await pazzle.pvm.flash({files: b.files, projectPath: doc.path, folder: state.folder || null});
  if (!r.ok) {
    setRunning(false);
    consoleView.error(r.error);
    setStatus('Не удалось прошить', true);
  } else {
    setStatus(`Прошивка: ${t.name}…`);
  }
}

function onRunEvent(ev) {
  if (ev.type === 'status') consoleView.write(ev.text, 'command');
  else if (ev.type === 'output') consoleView.write(ev.text, ev.stream === 'stderr' ? 'stderr' : 'stdout');
  else if (ev.type === 'exit') {
    const kind = state.runKind;
    setRunning(false);
    const secs = ((ev.ms || 0) / 1000).toFixed(2);
    if (ev.killed) {
      consoleView.info('■ Остановлено');
      setStatus('Остановлено');
    } else if (ev.custom) {
      const what = ev.kind === 'flash' ? 'Прошивка' : 'Команда';
      if (ev.code === 0) {
        consoleView.line(`✔ ${ev.kind === 'flash' ? 'Прошито' : 'Команда завершена'} за ${secs} с`, 'ok');
        setStatus(ev.kind === 'flash' ? 'Прошито' : 'Команда завершена');
      } else {
        consoleView.error(`✖ ${what}: команда завершилась с кодом ${ev.code}`);
        setStatus(`${what} не удалась (код ${ev.code})`, true);
      }
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
    if (ev.variables?.length && kind === 'run') {
      const names = state.doc?.build?.names || {};
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
  if (state.running || !state.doc) return;
  const doc = state.doc;
  const t = currentTarget();
  const b = await build({silent: true});
  if (!b) return;
  if (t.mode === 'board-flash') {
    consoleView.info('Режим «прошитая программа»: карта отладки берётся из этой сборки — в плате должна быть она же (Ctrl+U — прошить).');
  }
  state.debug = {active: true, running: true, build: b, doc, snapshot: null, currentBlock: null};
  debugView.reset();
  debugView.running(` ${t.name}`);
  updateButtons();
  showBottom('debug-panel');
  consoleView.line(`— Отладка: ${t.name} —`, 'info');
  setStatus(`Подключение: ${t.name}…`);
  const r = await pazzle.debug.start({files: b.files, projectPath: doc.path, folder: state.folder || null, breakpoints: breakpointLines(doc, b)});
  if (!r.ok) {
    consoleView.error(`✖ Отладка не запустилась: ${r.error}`);
    setStatus('Отладка не запустилась', true);
    endDebug();
  }
}

/** Блок вне видимой области — центрируем его. */
function revealBlock(block) {
  const ws = block.workspace;
  const metrics = ws.getMetricsManager().getViewMetrics(true);
  const r = block.getBoundingRectangle();
  const visible = r.left >= metrics.left && r.top >= metrics.top && r.right <= metrics.left + metrics.width && r.bottom <= metrics.top + metrics.height;
  if (!visible) ws.centerOnBlock(block.id);
}

function debugWs() {
  const doc = state.debug.doc;
  return doc?.kind === 'blocks' && state.docs.includes(doc) ? doc.ws : null;
}

function highlightCurrent(snap) {
  const ws = debugWs();
  const prev = state.debug.currentBlock;
  if (prev && ws) ws.getBlockById(prev)?.getSvgRoot()?.classList.remove('pz-current');
  state.debug.currentBlock = null;
  showFrame(null);
  if (!snap?.line || !ws) return;
  const id = blockForLine(state.debug.build.lineBlocks, snap.line);
  const block = id && ws.getBlockById(id);
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
  const ws = debugWs();
  const prev = state.debug.frameBlock;
  if (prev && ws) ws.getBlockById(prev)?.getSvgRoot()?.classList.remove('pz-frame');
  state.debug.frameBlock = null;
  state.debug.frameLine = null;
  if (frame && index > 0 && frame.line) {
    state.debug.frameLine = frame.line;
    const id = ws && blockForLine(state.debug.build.lineBlocks, frame.line);
    const block = id && ws.getBlockById(id);
    if (block) {
      state.debug.frameBlock = id;
      block.getSvgRoot()?.classList.add('pz-frame');
      revealBlock(block);
    }
    if (state.view !== 'hlc') showCodeView('hlc');
    state.editor.revealLineInCenterIfOutsideViewport(frame.line);
  } else if (frame && state.debug.currentBlock && ws) {
    const block = ws.getBlockById(state.debug.currentBlock);
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
  const name = currentTarget().name;
  if (ev.status === 'running') {
    state.debug.running = true;
    highlightCurrent(null);
    debugView.running(` ${name}`);
    refreshEditorDecorations();
    setStatus('Выполняется… (F6 — пауза)');
  } else if (ev.status === 'stopped') {
    state.debug.running = false;
    state.debug.snapshot = ev;
    // Остановка в другом документе — показываем его, как отладчики показывают файл текущей строки.
    const doc = state.debug.doc;
    if (doc && state.docs.includes(doc) && state.doc !== doc) {
      if (state.layout !== 'ide') setLayout(doc.kind === 'blocks' ? 'blocks' : 'hlc', {ensure: false});
      activateDoc(doc);
    }
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
  state.debug = {active: false, running: false, build: null, doc: null, snapshot: null, currentBlock: null};
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

// ---------------------------------------------------------------- библиотеки пазлов

async function refreshLibraries() {
  try {
    state.libraries = await pazzle.libraries.list({folder: state.folder || null});
  } catch (e) {
    consoleView.error(`Библиотеки не прочитаны: ${e.message}`);
    state.libraries = [];
  }
  for (const doc of state.docs) if (doc.kind === 'blocks') doc.ws.refreshToolboxSelection();
}

/** Категория «Библиотеки»: по каждой библиотеке — вызовы её функций, её константы и фрагменты. */
function librariesFlyout(ws) {
  const items = [];
  const button = (text, key, fn) => {
    ws.registerButtonCallback(key, () => runCommand(fn));
    items.push({kind: 'button', text, callbackKey: key});
  };
  if (!state.libraries.length) {
    items.push(
      {kind: 'label', text: 'Своих библиотек пока нет.'},
      {kind: 'label', text: 'Правый щелчок по функции, константе или стопке блоков →'},
      {kind: 'label', text: '«Сохранить в библиотеку…». Или: Библиотеки → Создать из проекта.'},
    );
    button('Подключить файл библиотеки…', 'PAZZLE_LIB_IMPORT', 'libraryImport');
    return items;
  }
  items.push({kind: 'label', text: 'Перетащите блок в проект — нужные функции и константы добавятся сами.'});
  state.libraries.forEach((lib, i) => {
    items.push({kind: 'sep', gap: 24});
    items.push({kind: 'label', text: `📦 ${lib.name}${lib.source === 'папка проекта' ? '  (папка проекта)' : ''}`});
    if (lib.description) items.push({kind: 'label', text: lib.description});
    for (const item of lib.items) items.push(library.flyoutBlockFor(item, library.libraryData(lib, item)));
    ws.registerButtonCallback(`PAZZLE_LIB_ADD_${i}`, () => runCommand('libraryAddAll', lib));
    items.push({kind: 'button', text: 'Добавить всё в проект', callbackKey: `PAZZLE_LIB_ADD_${i}`});
    ws.registerButtonCallback(`PAZZLE_LIB_DEL_${i}`, () => runCommand('libraryDelete', lib));
    items.push({kind: 'button', text: 'Удалить библиотеку…', callbackKey: `PAZZLE_LIB_DEL_${i}`});
  });
  items.push({kind: 'sep', gap: 24});
  button('Подключить файл библиотеки…', 'PAZZLE_LIB_IMPORT', 'libraryImport');
  return items;
}

/** Перетащили блок из палитры библиотеки — добавляем в проект функции и константы, без которых он не работает. */
function importLibraryDependencies(doc, e) {
  const blocks = (e.ids || [e.blockId]).map((id) => doc.ws.getBlockById(id)).filter(Boolean);
  const wanted = library.libraryDropsIn(blocks);
  if (!wanted.files.size) return;
  const origin = state.libraries.filter((l) => wanted.files.has(l.file));
  const others = state.libraries.filter((l) => !wanted.files.has(l.file));
  const plan = library.planImport(doc.ws, [...origin, ...others], wanted);
  if (!plan.length) return;
  const group = Blockly.Events.getGroup();
  Blockly.Events.setGroup(e.group || true); // одно «Отменить» вместе с перетаскиванием
  try {
    library.appendItems(doc.ws, plan.map((p) => p.item));
  } finally {
    Blockly.Events.setGroup(group || false);
  }
  const names = plan.map((p) => `${p.item.kind === 'function' ? 'функция' : 'константа'} «${p.item.name}»`);
  setStatus(`Из библиотеки добавлено: ${names.join(', ')}`);
}

async function chooseLibrary({title, hint, itemField}) {
  const libs = state.libraries.filter((l) => l.source === 'мои' || l.source === 'папка проекта');
  const values = await ask({
    title,
    hint,
    ok: 'Сохранить',
    fields: [
      {
        name: 'file',
        label: 'Библиотека',
        type: 'select',
        options: [...libs.map((l) => ({value: l.file, label: `${l.name}${l.source === 'папка проекта' ? ' (папка проекта)' : ''}`})), {value: '', label: '＋ Новая библиотека'}],
        value: state.lastLibrary && libs.some((l) => l.file === state.lastLibrary) ? state.lastLibrary : libs[0]?.file || '',
      },
      {name: 'name', label: 'Название новой библиотеки', placeholder: 'например: Светодиоды', required: true, showIf: {field: 'file', value: ''}},
      {name: 'description', label: 'Описание (необязательно)', showIf: {field: 'file', value: ''}},
      ...(itemField ? [itemField] : []),
    ],
  });
  if (!values) return null;
  const existing = libs.find((l) => l.file === values.file);
  return {values, lib: existing ? structuredClone(existing) : {...library.newLibrary(values.name, values.description)}};
}

async function saveItemsToLibrary(lib, items) {
  const merged = library.mergeItems(lib, items);
  const file = await pazzle.libraries.save(merged.library);
  state.lastLibrary = file;
  await refreshLibraries();
  setStatus(`Библиотека «${lib.name}»: добавлено ${merged.added}, обновлено ${merged.replaced}`);
  consoleView.line(`✔ Библиотека «${lib.name}» сохранена: ${file}`, 'ok');
}

async function saveBlockToLibrary(block) {
  const ws = block.workspace;
  const kind = library.itemKind(block);
  const name = kind === 'snippet' ? null : block.getFieldValue('NAME');
  const hint = {
    function: `Функция «${name}» сохранится вместе с функциями и константами, которые она использует.`,
    constant: `Константа «${name}» сохранится вместе с константами, через которые она вычисляется.`,
    snippet: 'Сохранится этот блок и всё, что под ним, вместе с функциями и константами, которые они используют.',
  }[kind];
  const chosen = await chooseLibrary({
    title: 'Сохранить в библиотеку',
    hint,
    itemField: kind === 'snippet' ? {name: 'itemName', label: 'Название фрагмента', value: 'фрагмент', required: true} : null,
  });
  if (!chosen) return;
  const items = library.collectItems(ws, block, {name: chosen.values.itemName});
  await saveItemsToLibrary(chosen.lib, items);
}

async function libraryFromProject() {
  const doc = state.doc;
  if (doc?.kind !== 'blocks') {
    consoleView.error('Библиотека создаётся из проекта пазлов — откройте его.');
    return;
  }
  const items = library.projectItems(doc.ws);
  if (!items.length) {
    consoleView.error('В проекте нет функций и констант — в библиотеку нечего сохранить.');
    return;
  }
  const chosen = await chooseLibrary({
    title: 'Создать библиотеку из проекта',
    hint: `В библиотеку войдут все функции и константы проекта: ${items.map((i) => i.name).join(', ')}.`,
  });
  if (chosen) await saveItemsToLibrary(chosen.lib, items);
}

async function removeFromLibrary(block) {
  let origin;
  try {
    origin = JSON.parse(String(block.data).slice(library.LIBRARY_DATA_PREFIX.length));
  } catch {
    return;
  }
  const lib = state.libraries.find((l) => l.file === origin.file);
  if (!lib || !window.confirm(`Удалить «${origin.name}» из библиотеки «${lib.name}»?`)) return;
  const items = lib.items.filter((i) => !(i.kind === origin.kind && i.name === origin.name));
  await pazzle.libraries.save({...lib, items});
  await refreshLibraries();
  setStatus(`«${origin.name}» удалено из библиотеки «${lib.name}»`);
}

function libraryAddAll(lib) {
  const doc = state.doc;
  if (doc?.kind !== 'blocks') return;
  const plan = library.planImport(doc.ws, [lib, ...state.libraries.filter((l) => l !== lib)], {
    functions: lib.items.filter((i) => i.kind === 'function').map((i) => i.name),
    constants: lib.items.filter((i) => i.kind === 'constant').map((i) => i.name),
  });
  if (!plan.length) return setStatus(`Всё из библиотеки «${lib.name}» уже есть в проекте`);
  Blockly.Events.setGroup(true);
  try {
    library.appendItems(doc.ws, plan.map((p) => p.item));
  } finally {
    Blockly.Events.setGroup(false);
  }
  setStatus(`Из библиотеки «${lib.name}» добавлено: ${plan.length}`);
}

// ---------------------------------------------------------------- дерево файлов

async function explorerMenu(entry, isRoot) {
  const action = await pazzle.fs.contextMenu({dir: entry.dir, root: isRoot});
  if (!action) return;
  const dir = entry.dir ? entry.path : parentOf(entry.path);
  try {
    await explorerAction(action, entry, dir);
  } catch (e) {
    consoleView.error(e.message || String(e));
    setStatus('Ошибка', true);
  }
  await explorer.render();
}

async function askName(title, value, hint) {
  const r = await ask({title, hint, fields: [{name: 'name', label: 'Имя', value, required: true}]});
  return r?.name || null;
}

async function createFileIn(dir, kind) {
  const presets = {
    blocks: {title: 'Новый проект пазлов', value: 'проект.pzl', ext: '.pzl', content: () => JSON.stringify(NEW_PROJECT, null, 2) + '\n'},
    hlc: {title: 'Новый файл HLC', value: 'main.hlc', ext: '.hlc', content: () => HLC_TEMPLATE},
    file: {title: 'Новый файл', value: '', ext: '', content: () => ''},
  }[kind];
  let name = await askName(presets.title, presets.value, `Папка: ${dir}`);
  if (!name) return;
  if (presets.ext && !name.toLowerCase().endsWith(presets.ext)) name += presets.ext;
  const target = await pazzle.fs.create(joinPath(dir, name), {content: presets.content()});
  await openPath(target);
}

async function explorerAction(action, entry, dir) {
  switch (action) {
    case 'newBlocks':
      return createFileIn(dir, 'blocks');
    case 'newHlc':
      return createFileIn(dir, 'hlc');
    case 'newFile':
      return createFileIn(dir, 'file');
    case 'newFolder': {
      const name = await askName('Новая папка', '', `В папке: ${dir}`);
      if (name) await pazzle.fs.create(joinPath(dir, name), {dir: true});
      return;
    }
    case 'rename': {
      const name = await askName('Переименовать', entry.name);
      if (!name || name === entry.name) return;
      const to = joinPath(parentOf(entry.path), name);
      await pazzle.fs.rename(entry.path, to);
      // Открытые файлы (и файлы внутри переименованной папки) — по новому пути.
      for (const d of state.docs) {
        if (!d.path) continue;
        if (samePath(d.path, entry.path)) d.path = to;
        else if (entry.dir && d.path.toLowerCase().startsWith((entry.path + (entry.path.includes('\\') ? '\\' : '/')).toLowerCase())) d.path = to + d.path.slice(entry.path.length);
      }
      renderTabs();
      updateTitle();
      return;
    }
    case 'trash': {
      if (!window.confirm(`Удалить «${entry.name}» в корзину?`)) return;
      await pazzle.fs.trash(entry.path);
      for (const d of [...state.docs]) {
        const inside = d.path && (samePath(d.path, entry.path) || d.path.toLowerCase().startsWith(entry.path.toLowerCase() + (entry.path.includes('\\') ? '\\' : '/')));
        if (inside && !d.dirty) await closeDoc(d, {force: true});
        else if (inside) d.path = null; // несохранённые правки не теряем: файл станет «без имени»
      }
      renderTabs();
      return;
    }
    case 'reveal':
      return pazzle.fs.reveal(entry.path);
    case 'openExternal':
      return pazzle.fs.openExternal(entry.path);
    case 'copyPath':
      await pazzle.copyText(entry.path);
      return setStatus(`Путь скопирован: ${entry.path}`);
  }
}

// ---------------------------------------------------------------- команды

async function showAbout() {
  const info = await pazzle.info();
  $('about-text').textContent =
    `Версия ${info.version}. Визуальное программирование стековой виртуальной машины PVM блоками и кодом HLC: ` +
    `сборка pvmcc/pvmc, выполнение, прошивка и отладка в симуляторе или на плате. ` +
    `Платформа: ${info.platform}, Electron ${info.electron}.`;
  $('about-dialog').showModal();
}

function applySettings(next) {
  const prev = state.settings;
  state.settings = next;
  if (prev.theme !== next.theme) {
    applyPageTheme(next.theme);
    for (const d of state.docs) if (d.ws) d.ws.setTheme(blocklyTheme(next.theme));
    monaco.editor.setTheme(monacoTheme(next.theme));
  }
  if (prev.fontSize !== next.fontSize) state.editor.updateOptions({fontSize: next.fontSize});
  if (prev.renderer !== next.renderer) for (const d of state.docs) if (d.kind === 'blocks') recreateWorkspace(d);
  if (prev.pvmTools !== next.pvmTools) {
    for (const d of state.docs) d.build = null;
    refreshTools();
  }
}

const commands = {
  new: () => openContent('blocks', structuredClone(NEW_PROJECT), null),
  newHlc: () => openContent('text', HLC_TEMPLATE, null),
  // Кнопка «Новый» на панели: на рабочем столе «HLC» — файл кода, иначе проект пазлов.
  newDoc: () => (state.layout === 'hlc' ? commands.newHlc() : commands.new()),
  async open() {
    const kind = state.layout === 'blocks' ? 'blocks' : state.layout === 'hlc' ? 'text' : null;
    const r = await pazzle.file.open({kind});
    if (r) await openPath(r.path, {content: r.content});
  },
  async openFolder() {
    const dir = await pazzle.fs.chooseFolder();
    if (!dir) return;
    await setFolder(dir);
    setLayout('ide');
  },
  async example(file) {
    openContent('blocks', await pazzle.project.readExample(file), null, {suggestedName: file});
  },
  save: () => saveDoc(state.doc, false),
  saveAs: () => saveDoc(state.doc, true),
  closeTab: () => (state.layout === 'ide' ? closeDoc(state.doc) : null),
  codeToFile() {
    const doc = state.doc;
    if (doc?.kind !== 'blocks') return;
    const name = (doc.path ? baseName(doc.path).replace(/\.\w+$/, '') : 'main') + '.hlc';
    openContent('text', currentCode(doc), null, {suggestedName: name});
    setStatus('Код открыт как файл HLC — сохраните его (Ctrl+S); блоки этот файл больше не меняют');
  },
  async export() {
    const doc = state.doc;
    if (!doc) return;
    const saved = await pazzle.exportCode(doc.kind === 'text' ? docName(doc) : 'main.hlc', currentCode());
    if (saved) setStatus(`Код сохранён: ${saved}`);
  },
  async exportProject() {
    if (!state.doc) return;
    const r = await pazzle.pvm.exportProject({code: currentCode()});
    if (!r) return;
    showBottom('console-panel');
    if (r.ok) {
      consoleView.write(r.log, 'command');
      consoleView.line(`✔ Проект создан: ${r.dir} — make, make run, make debug, make board`, 'ok');
    } else {
      consoleView.error(r.error || r.log || 'Не удалось создать проект');
    }
  },
  openBuildFolder: () => pazzle.pvm.openBuildFolder(state.doc?.path || null),
  build: async () => {
    if (state.doc) state.doc.build = null; // явная сборка — всегда заново
    await build();
  },
  run,
  flash,
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
    const doc = state.doc;
    if (!doc) return;
    if (state.editor.hasTextFocus() && state.view === 'hlc') {
      const line = state.editor.getPosition().lineNumber;
      if (doc.kind === 'text') return toggleLineBreakpoint(doc, line);
      const id = blockForLine(doc.generated.lineBlocks, line);
      return toggleBreakpoint(id && doc.ws.getBlockById(id));
    }
    if (doc.kind === 'blocks') toggleBreakpoint(Blockly.getSelected?.());
  },
  clearConsole: () => consoleView.clear(),
  undo: () => (state.editor.hasTextFocus() ? state.editor.trigger('menu', 'undo') : state.doc?.ws?.undo(false)),
  redo: () => (state.editor.hasTextFocus() ? state.editor.trigger('menu', 'redo') : state.doc?.ws?.undo(true)),
  cleanup: () => state.doc?.ws?.cleanUp(),
  zoomFit: () => state.doc?.ws?.zoomToFit(),
  layout: (name) => setLayout(name),
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
      onTargets: () => openTargets(),
    });
  },
  targets: () => openTargets(),
  saveToLibrary: (block) => saveBlockToLibrary(block),
  removeFromLibrary: (block) => removeFromLibrary(block),
  libraryFromProject,
  libraryAddAll: (lib) => libraryAddAll(lib),
  async libraryDelete(lib) {
    if (!window.confirm(`Удалить библиотеку «${lib.name}» в корзину?\n${lib.file}`)) return;
    await pazzle.libraries.remove(lib.file);
    await refreshLibraries();
    setStatus(`Библиотека «${lib.name}» удалена`);
  },
  async libraryImport() {
    const added = await pazzle.libraries.import();
    if (!added.length) return;
    await refreshLibraries();
    setStatus(`Подключено библиотек: ${added.length}`);
  },
  libraryFolder: () => pazzle.libraries.openFolder(),
  async libraryRefresh() {
    await refreshLibraries();
    setStatus(`Библиотек: ${state.libraries.length}`);
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
  for (const btn of document.querySelectorAll('#layout-switch button')) btn.addEventListener('click', () => setLayout(btn.dataset.layout));
  for (const tab of document.querySelectorAll('#code-tabs .tab')) tab.addEventListener('click', () => showCodeView(tab.dataset.view));
  for (const tab of document.querySelectorAll('#bottom-tabs .tab')) tab.addEventListener('click', () => showBottom(tab.dataset.panel));
  $('btn-edit').addEventListener('click', () => toggleManualEdit());
  $('btn-regenerate').addEventListener('click', () => toggleManualEdit(false));
  $('btn-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.editor.getValue());
    setStatus('Код скопирован в буфер обмена');
  });
  $('target').addEventListener('change', async () => {
    state.settings = await pazzle.settings.set({target: $('target').value});
    await refreshPorts();
    applyTargetUi();
    setStatus(`Цель: ${currentTarget().name}`);
  });
  $('port').addEventListener('change', () => updateCurrentTarget({port: $('port').value}));
  $('baud').addEventListener('change', () => updateCurrentTarget({baud: Number($('baud').value)}));
  $('btn-ports').addEventListener('click', () => refreshPorts());
  $('tcp-box').addEventListener('click', () => openTargets({focus: 'tcp'}));
  $('explorer-new-file').addEventListener('click', () => state.folder && createFileIn(state.folder, 'file').then(() => explorer.render()));
  $('explorer-new-folder').addEventListener('click', () => state.folder && explorerAction('newFolder', {path: state.folder, dir: true}, state.folder).then(() => explorer.render()));
  $('explorer-refresh').addEventListener('click', () => explorer.render());
  $('explorer-collapse').addEventListener('click', () => explorer.collapseAll());
  // Ctrl+W и Ctrl+Tab — вкладки рабочего стола «IDE».
  window.addEventListener('keydown', (e) => {
    if (state.layout !== 'ide' || !(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'w') {
      e.preventDefault();
      runCommand('closeTab');
    } else if (e.key === 'Tab' && state.docs.length > 1) {
      e.preventDefault();
      const i = state.docs.indexOf(state.doc);
      activateDoc(state.docs[(i + (e.shiftKey ? -1 : 1) + state.docs.length) % state.docs.length]);
    }
  });
  pazzle.onMenu(({id, arg}) => runCommand(id, arg));
  pazzle.pvm.onBuildOutput((o) => consoleView.write(o.text, o.stream === 'command' ? 'command' : o.stream === 'stderr' ? 'stderr' : 'stdout'));
  pazzle.pvm.onRunEvent(onRunEvent);
  pazzle.debug.onEvent(onDebugEvent);
  pazzle.fs.onChanged(debounce(() => explorer.render(), 200));
  pazzle.onOpenFile(({path, content}) => openPath(path, {content}));
  const resize = () => state.doc?.ws && Blockly.svgResize(state.doc.ws);
  initSplitters(resize);
  window.addEventListener('resize', resize);
}

// ---------------------------------------------------------------- старт

async function main() {
  state.settings = await pazzle.settings.get();
  applyPageTheme(state.settings.theme);
  state.language = createLanguage(await pazzle.loadLanguage());
  state.targetsInfo = await pazzle.targets.info();
  registerPvmsLanguage();
  registerContextMenus();
  createEditor();
  explorer = new Explorer({fs: pazzle.fs, onOpen: (p) => runCommand('openPathFromTree', p), onContextMenu: explorerMenu});
  commands.openPathFromTree = (p) => openPath(p);
  wireUi();
  renderTargetSelect();
  await Promise.all([refreshPorts(), refreshTools()]);
  applyTargetUi();
  state.folder = state.settings.folder || '';
  await explorer.setRoot(state.folder || null);
  if (state.folder) pazzle.fs.watch(state.folder);
  await refreshLibraries();

  const restored = await restoreSession();
  const layout = state.settings.layout || 'blocks';
  if (!restored && layout === 'blocks') {
    // Первый запуск — первый пример, чтобы было с чем попробовать сборку и отладку.
    const examples = await pazzle.project.examples();
    const doc = examples[0] && createBlocksDoc(await pazzle.project.readExample(examples[0].file), null);
    if (doc) doc.suggestedName = examples[0].file;
  }
  setLayout(layout, {persist: false});
  updateButtons();
  pazzle.ready();
  Object.assign(window.pazzleDebug, {commands, toggleBreakpoint, setLayout, setFolder, openPath, activateDoc, build, refreshLibraries, toggleLineBreakpoint, library});
  if (state.tools?.dir) setStatus('Готово. Ctrl+B — собрать, Ctrl+F5 — запустить, F5 — отладка, Ctrl+U — прошить.');
}

main().catch((e) => {
  console.error(e);
  setStatus('Ошибка запуска интерфейса: ' + (e?.message || e), true);
});
