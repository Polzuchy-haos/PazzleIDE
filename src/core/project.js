// Формат файла проекта PazzleIDE (*.pzl): JSON с сериализованным workspace Blockly.
import * as Blockly from 'blockly';

export const PROJECT_FORMAT = 'pazzleide-project';
export const PROJECT_VERSION = 1;

// Проекты, сохранённые до переименования (VisualIDE, *.vide), открываются как есть.
const LEGACY_FORMATS = ['visualide-project'];
const LEGACY_BLOCK_TYPES = {
  vide_comment: 'pazzle_comment',
  vide_raw_code: 'pazzle_raw_code',
  vide_raw_expr: 'pazzle_raw_expr',
};

/** Старые типы блоков -> новые (по всему дереву сериализации). */
function migrateBlockTypes(node) {
  if (Array.isArray(node)) return node.forEach(migrateBlockTypes);
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string' && LEGACY_BLOCK_TYPES[node.type]) node.type = LEGACY_BLOCK_TYPES[node.type];
  for (const value of Object.values(node)) migrateBlockTypes(value);
}

export function serializeProject(workspace, {language} = {}) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    language: language || 'pvm',
    workspace: Blockly.serialization.workspaces.save(workspace),
  };
}

/** Разбирает текст/объект проекта. Бросает Error с понятным сообщением. */
export function parseProject(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new Error('Файл проекта повреждён: ' + e.message);
    }
  }
  if (!data || (data.format !== PROJECT_FORMAT && !LEGACY_FORMATS.includes(data.format))) {
    throw new Error('Это не файл проекта PazzleIDE');
  }
  if (data.version > PROJECT_VERSION) throw new Error('Проект создан более новой версией PazzleIDE');
  if (data.format !== PROJECT_FORMAT) {
    data.format = PROJECT_FORMAT;
    migrateBlockTypes(data.workspace);
  }
  return data;
}

/** Загружает проект без генерации событий (чтобы загрузка не считалась изменением). */
export function loadProjectInto(workspace, project) {
  Blockly.Events.disable();
  try {
    workspace.clear();
    Blockly.serialization.workspaces.load(project.workspace || {}, workspace);
  } finally {
    Blockly.Events.enable();
  }
  workspace.clearUndo?.();
}
