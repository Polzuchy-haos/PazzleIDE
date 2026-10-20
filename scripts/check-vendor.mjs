// Перед упаковкой: утилиты PVM должны быть собраны в vendor/pvm (npm run pvm:bundle).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'pvm');
const exe = (n) => (process.platform === 'win32' ? n + '.exe' : n);
const missing = ['pvmcc', 'pvmc', 'pvmsim', 'pvmdbg'].filter((t) => !fs.existsSync(path.join(dir, exe(t))));
if (missing.length) {
  console.error(`В vendor/pvm нет: ${missing.join(', ')}. Сначала соберите утилиты: npm run pvm:bundle`);
  process.exit(1);
}
console.log(`Утилиты PVM для дистрибутива: ${dir}`);
