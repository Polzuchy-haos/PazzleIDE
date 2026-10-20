// Сборка интерфейса: esbuild собирает renderer и worker Monaco в dist/renderer.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'renderer');
const watch = process.argv.includes('--watch');

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

function copyStatic() {
  for (const f of ['index.html', 'styles.css']) {
    fs.copyFileSync(path.join(root, 'src', 'renderer', f), path.join(out, f));
  }
  // Звуки и спрайты Blockly — локально, чтобы IDE работала без интернета.
  fs.cpSync(path.join(root, 'node_modules', 'blockly', 'media'), path.join(out, 'media'), {recursive: true});
}

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: 'chrome130',
  logLevel: 'info',
  legalComments: 'none',
};

const builds = [
  {
    ...common,
    entryPoints: {app: path.join(root, 'src', 'renderer', 'app.js')},
    outdir: out,
    format: 'iife',
    loader: {'.ttf': 'file'},
    assetNames: 'assets/[name]-[hash]',
  },
  {
    ...common,
    entryPoints: {'editor.worker': path.join(root, 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor', 'editor.worker.js')},
    outdir: out,
    format: 'iife',
  },
];

copyStatic();
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  fs.watch(path.join(root, 'src', 'renderer'), (_e, f) => {
    if (f === 'index.html' || f === 'styles.css') copyStatic();
  });
  console.log('Слежение за изменениями... (Ctrl+C — выход)');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
