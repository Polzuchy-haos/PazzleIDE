// Ядро PazzleIDE: не зависит от Electron, работает и в браузере, и в Node.js (CLI, тесты).
export {createLanguage, generateCode} from './languages.js';
export {buildToolbox, BASE_CATEGORIES} from './toolbox.js';
export {serializeProject, parseProject, loadProjectInto, PROJECT_FORMAT} from './project.js';
export {validatePack, extractBlockMarkers} from './generators/template.js';
export {inferTypes} from './types.js';
export {transliterate, toIdentifier} from './translit.js';
export * as library from './library.js';
