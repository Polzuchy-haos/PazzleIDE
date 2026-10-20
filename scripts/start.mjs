// Запуск IDE в режиме разработки. Сбрасывает ELECTRON_RUN_AS_NODE, которую
// выставляют некоторые среды (например, терминалы внутри VS Code), — иначе Electron
// стартует как обычный Node.js.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], {stdio: 'inherit', env});
child.on('close', (code) => process.exit(code ?? 0));
