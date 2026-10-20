// Формат файла проекта VisualIDE (*.vide): JSON с сериализованным workspace Blockly.
import * as Blockly from 'blockly';

export const PROJECT_FORMAT = 'visualide-project';
export const PROJECT_VERSION = 1;

export function serializeProject(workspace, {language} = {}) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    language: language || 'python',
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
  if (!data || data.format !== PROJECT_FORMAT) throw new Error('Это не файл проекта VisualIDE');
  if (data.version > PROJECT_VERSION) throw new Error('Проект создан более новой версией VisualIDE');
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
