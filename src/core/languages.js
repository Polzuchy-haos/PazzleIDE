// Язык VisualIDE — PVM HLC. Он описан декларативно в languages/pvm.json и
// генерируется шаблонным генератором (src/core/generators/template.js).
import {installTransliteration} from './translit.js';
import {installCustomBlocks, defineBlocks} from './blocks.js';
import {TemplateGenerator, validatePack} from './generators/template.js';
import {generateWithReport} from './generators/common.js';

installTransliteration();
installCustomBlocks();

/** Создаёт язык из JSON-описания. Бросает Error, если описание некорректно. */
export function createLanguage(pack) {
  const problems = validatePack(pack);
  if (problems.length) throw new Error(problems.join('; '));
  if (pack.customBlocks) defineBlocks(pack.customBlocks);
  return {
    id: pack.id,
    name: pack.name,
    ext: pack.fileExtension || 'hlc',
    fileName: pack.fileName || `main.${pack.fileExtension || 'hlc'}`,
    editor: pack.editorLanguage || 'c',
    generator: new TemplateGenerator(pack),
    pack,
  };
}

/** Генерирует код; возвращает {code, warnings, unsupported, lineBlocks, names} или {error}. */
export function generateCode(language, workspace) {
  try {
    return generateWithReport(language.generator, workspace);
  } catch (e) {
    return {code: '', warnings: [], unsupported: [], lineBlocks: {}, names: {}, error: String(e?.stack || e)};
  }
}
