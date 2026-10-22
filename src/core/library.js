// Библиотеки пазлов (*.pzlib): функции, константы и фрагменты, сохранённые из блоков.
//
// Элемент библиотеки — сериализованная стопка блоков без id и с переменными по
// имени, чтобы её можно было вставить в любой проект. Вместе с функцией
// сохраняются функции, которые она вызывает, и константы, которые она использует;
// при вставке недостающие зависимости добавляются в проект автоматически.
import * as Blockly from 'blockly';

export const LIBRARY_FORMAT = 'pazzleide-library';
const DEF_TYPES = new Set(['procedures_defnoreturn', 'procedures_defreturn']);
const CALL_TYPES = new Set(['procedures_callnoreturn', 'procedures_callreturn']);
const CONST_DEFINE = 'pvm_const_define';
const CONST_GET = 'pvm_const_get';
/** Метка блока палитры библиотеки (block.data): при перетаскивании в проект подтягиваются зависимости. */
export const LIBRARY_DATA_PREFIX = 'pazzle-lib:';

const isDef = (b) => DEF_TYPES.has(b.type);

/** Вид элемента по корневому блоку: функция, константа или фрагмент. */
export function itemKind(block) {
  if (isDef(block)) return 'function';
  if (block.type === CONST_DEFINE) return 'constant';
  return 'snippet';
}

/** Сериализация без id блоков и переменных: переменные — по имени. */
function portable(node) {
  if (Array.isArray(node)) return node.map(portable);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'id' || key === 'x' || key === 'y') continue;
    if (key === 'fields' && value && typeof value === 'object') {
      out.fields = Object.fromEntries(
        Object.entries(value).map(([name, v]) => [name, v && typeof v === 'object' && 'name' in v ? {name: v.name, ...(v.type ? {type: v.type} : {})} : v]),
      );
    } else if (key === 'extraState' && value && Array.isArray(value.params)) {
      out.extraState = {...value, params: value.params.map((p) => (p && typeof p === 'object' ? {name: p.name} : p))};
    } else {
      out[key] = portable(value);
    }
  }
  return out;
}

function serializeBlock(block, {withNext}) {
  const state = Blockly.serialization.blocks.save(block, {addCoordinates: false, addNextBlocks: withNext, doFullSerialization: true});
  return portable(state);
}

/** Все узлы-блоки в сериализации (с вложенными и следующими). */
function walkState(state, visit) {
  if (!state || typeof state !== 'object') return;
  visit(state);
  for (const input of Object.values(state.inputs || {})) {
    walkState(input.block, visit);
    walkState(input.shadow, visit);
  }
  if (state.next) {
    walkState(state.next.block, visit);
    walkState(state.next.shadow, visit);
  }
}

/** Что использует сериализованная стопка: имена вызываемых функций и констант. */
export function dependenciesOf(state) {
  const functions = new Set();
  const constants = new Set();
  walkState(state, (node) => {
    if (CALL_TYPES.has(node.type) && node.extraState?.name) functions.add(node.extraState.name);
    if (node.type === CONST_GET && node.fields?.NAME) constants.add(String(node.fields.NAME).trim());
  });
  return {functions, constants};
}

function definitionsIn(ws) {
  const functions = new Map();
  const constants = new Map();
  for (const b of ws.getTopBlocks(false)) if (isDef(b)) functions.set(b.getFieldValue('NAME'), b);
  for (const b of ws.getBlocksByType(CONST_DEFINE, false)) {
    const name = b.getFieldValue('NAME').trim();
    if (name && !constants.has(name)) constants.set(name, b);
  }
  return {functions, constants};
}

function makeItem(block, {name} = {}) {
  const kind = itemKind(block);
  const itemName =
    kind === 'function' ? block.getFieldValue('NAME') : kind === 'constant' ? block.getFieldValue('NAME').trim() : name || 'фрагмент';
  // Константа — один блок объявления; фрагмент — блок и всё, что под ним.
  return {kind, name: itemName, block: serializeBlock(block, {withNext: kind === 'snippet'})};
}

/**
 * Элементы для сохранения блока в библиотеку: сам блок (функция, константа или
 * фрагмент от блока до конца стопки) и всё, от чего он зависит в проекте.
 */
export function collectItems(ws, block, {name} = {}) {
  const defs = definitionsIn(ws);
  const items = [makeItem(block, {name})];
  const done = new Set([`${items[0].kind}:${items[0].name}`]);
  for (let i = 0; i < items.length; i++) {
    const deps = dependenciesOf(items[i].block);
    for (const fn of deps.functions) {
      const def = defs.functions.get(fn);
      if (def && !done.has(`function:${fn}`)) {
        done.add(`function:${fn}`);
        items.push(makeItem(def));
      }
    }
    for (const c of deps.constants) {
      const def = defs.constants.get(c);
      if (def && !done.has(`constant:${c}`)) {
        done.add(`constant:${c}`);
        items.push(makeItem(def));
      }
    }
  }
  return items;
}

/** Все функции и константы проекта — для «Создать библиотеку из проекта». */
export function projectItems(ws) {
  const defs = definitionsIn(ws);
  return [...[...defs.constants.values()].map((b) => makeItem(b)), ...[...defs.functions.values()].map((b) => makeItem(b))];
}

/** Добавляет элементы в библиотеку; элемент с тем же видом и именем заменяется. */
export function mergeItems(library, items) {
  const list = [...(library.items || [])];
  let added = 0;
  let replaced = 0;
  for (const item of items) {
    const at = list.findIndex((x) => x.kind === item.kind && x.name === item.name);
    if (at >= 0) {
      list[at] = item;
      replaced++;
    } else {
      list.push(item);
      added++;
    }
  }
  return {library: {...library, items: list}, added, replaced};
}

/**
 * Что нужно добавить в проект для этих имён из библиотеки (с зависимостями),
 * не считая того, что в проекте уже есть.
 */
export function planImport(ws, libraries, {functions = [], constants = []}) {
  const defs = definitionsIn(ws);
  const find = (kind, name) => {
    for (const lib of libraries) {
      const item = (lib.items || []).find((x) => x.kind === kind && x.name === name);
      if (item) return {item, library: lib};
    }
    return null;
  };
  const plan = [];
  const seen = new Set();
  const queue = [...[...functions].map((n) => ['function', n]), ...[...constants].map((n) => ['constant', n])];
  while (queue.length) {
    const [kind, name] = queue.shift();
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === 'function' ? defs.functions.has(name) : defs.constants.has(name)) continue;
    const found = find(kind, name);
    if (!found) continue;
    plan.push(found);
    const deps = dependenciesOf(found.item.block);
    for (const fn of deps.functions) queue.push(['function', fn]);
    for (const c of deps.constants) queue.push(['constant', c]);
  }
  return plan;
}

/** Правее всех блоков проекта — туда встают добавленные определения. */
function freeSpot(ws) {
  let right = 0;
  let top = 0;
  let first = true;
  for (const b of ws.getTopBlocks(false)) {
    const xy = b.getRelativeToSurfaceXY();
    const width = b.getHeightWidth?.().width ?? 300;
    right = Math.max(right, xy.x + width);
    top = first ? xy.y : Math.min(top, xy.y);
    first = false;
  }
  return {x: first ? 40 : right + 80, y: first ? 40 : top};
}

/** Вставляет элементы в проект столбиком; возвращает созданные блоки. */
export function appendItems(ws, items, at = freeSpot(ws)) {
  const created = [];
  let y = at.y;
  for (const item of items) {
    const block = Blockly.serialization.blocks.append({...item.block, x: at.x, y}, ws, {recordUndo: true});
    created.push(block);
    const height = block.getHeightWidth?.().height || 80;
    y += height + 40;
  }
  return created;
}

/** Блок для палитры: вызов функции, значение константы или сам фрагмент. */
export function flyoutBlockFor(item, data) {
  if (item.kind === 'function') {
    const def = item.block;
    const params = (def.extraState?.params || []).map((p) => p.name);
    const type = def.type === 'procedures_defreturn' ? 'procedures_callreturn' : 'procedures_callnoreturn';
    return {kind: 'block', type, extraState: {name: item.name, params}, data};
  }
  if (item.kind === 'constant') return {kind: 'block', type: CONST_GET, fields: {NAME: item.name}, data};
  return {kind: 'block', ...item.block, data};
}

export function libraryData(library, item) {
  return LIBRARY_DATA_PREFIX + JSON.stringify({file: library.file, kind: item.kind, name: item.name});
}

/**
 * Блоки, только что перенесённые из палитры библиотеки: что из библиотек надо
 * добавить в проект, чтобы они работали. Метка из block.data снимается.
 */
export function libraryDropsIn(blocks) {
  const wanted = {functions: new Set(), constants: new Set(), files: new Set()};
  for (const root of blocks) {
    if (typeof root.data !== 'string' || !root.data.startsWith(LIBRARY_DATA_PREFIX)) continue;
    let origin = null;
    try {
      origin = JSON.parse(root.data.slice(LIBRARY_DATA_PREFIX.length));
    } catch {
      // повреждённая метка — просто снимаем
    }
    root.data = null;
    if (!origin) continue;
    wanted.files.add(origin.file);
    for (const b of root.getDescendants(false)) {
      if (CALL_TYPES.has(b.type)) wanted.functions.add(b.getProcedureCall());
      if (b.type === CONST_GET) wanted.constants.add(b.getFieldValue('NAME').trim());
    }
  }
  return wanted;
}

export function newLibrary(name, description = '') {
  return {format: LIBRARY_FORMAT, version: 1, language: 'pvm', name, description, items: []};
}
