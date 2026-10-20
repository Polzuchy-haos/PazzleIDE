// Запуск сгенерированных программ: сохранение во временную папку,
// последовательное выполнение шагов (компиляция, запуск), потоковый вывод и stdin.
'use strict';
const {spawn} = require('child_process');
const {EventEmitter} = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

/** Ищет команду в папке инструментов языка (pvmcc -> <toolDir>/pvmcc.exe). */
function findInToolDir(cmd, toolDir) {
  if (!toolDir || /[\\/]/.test(cmd)) return cmd;
  const names = isWin && !path.extname(cmd) ? [cmd + '.exe', cmd + '.cmd', cmd + '.bat', cmd] : [cmd];
  for (const n of names) {
    const full = path.join(toolDir, n);
    if (fs.existsSync(full)) return full;
  }
  return cmd;
}

/** Окружение процесса с папкой инструментов в начале PATH (учитывает «Path» на Windows). */
function buildEnv(extra, toolDir) {
  const env = {...process.env, ...extra};
  if (toolDir) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = toolDir + path.delimiter + (env[key] || '');
  }
  return env;
}

/**
 * Построчный фильтр вывода: {keep: regex, replace: шаблон} оставляет только подходящие строки
 * (например, полезный вывод симулятора без трассировки), {drop: regex} — убирает подходящие.
 */
function createLineFilter(spec) {
  if (!spec || (!spec.keep && !spec.drop)) return null;
  const keep = spec.keep ? new RegExp(spec.keep) : null;
  const drop = spec.drop ? new RegExp(spec.drop) : null;
  let pending = '';
  const apply = (line) => {
    const body = line.replace(/\r$/, '');
    if (drop && drop.test(body)) return '';
    if (!keep) return body + '\n';
    if (!keep.test(body)) return '';
    return (spec.replace !== undefined ? body.replace(keep, spec.replace) : body) + '\n';
  };
  return {
    push(text) {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      return lines.map(apply).join('');
    },
    flush() {
      const rest = pending;
      pending = '';
      return rest ? apply(rest) : '';
    },
  };
}

function formatCommandLine(argv) {
  return argv.map((a) => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

/** Превращает шаг с токенами {file} {exe} {dir} {name} в {cmd, args}. */
function resolveStep(step, ctx) {
  const sub = (s) =>
    String(s)
      .replace(/\{file\}/g, ctx.file)
      .replace(/\{exe\}/g, ctx.exe)
      .replace(/\{dir\}/g, ctx.dir)
      .replace(/\{name\}/g, ctx.name);
  const [cmd, ...args] = step.map(sub);
  return {cmd: findInToolDir(cmd, ctx.toolDir), args, env: {}};
}

class RunSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.code       исходный код
   * @param {string} opts.fileName   имя файла (main.py, Main.java...)
   * @param {string[][]} opts.steps  шаги запуска (argv с токенами)
   * @param {string} [opts.toolDir]  папка инструментов языка (добавляется в PATH)
   * @param {object} [opts.outputFilter] фильтр stdout последнего шага (см. createLineFilter)
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.child = null;
    this.killed = false;
  }

  async start() {
    const {code, fileName, steps} = this.opts;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visualide-'));
    this.dir = dir;
    const file = path.join(dir, fileName);
    const name = path.parse(fileName).name;
    fs.writeFileSync(file, code, 'utf8');
    const ctx = {
      file,
      dir,
      name,
      exe: path.join(dir, name + (isWin ? '.exe' : '')),
      toolDir: this.opts.toolDir || null,
    };
    const started = Date.now();
    let exitCode = 0;
    for (let i = 0; i < steps.length && !this.killed; i++) {
      const isLast = i === steps.length - 1;
      exitCode = await this.runStep(resolveStep(steps[i], ctx), dir, isLast, ctx.toolDir);
      if (exitCode !== 0) break;
    }
    this.cleanup();
    this.emit('exit', {code: this.killed ? null : exitCode, killed: this.killed, ms: Date.now() - started});
  }

  runStep({cmd, args, env}, cwd, interactive, toolDir) {
    return new Promise((resolve) => {
      this.emit('status', {command: formatCommandLine([cmd, ...args]), interactive});
      let child;
      try {
        child = spawn(cmd, args, {
          cwd,
          env: buildEnv(env, toolDir),
          windowsHide: true,
        });
      } catch (e) {
        this.emit('output', {stream: 'stderr', text: `Не удалось запустить «${cmd}»: ${e.message}\n`});
        resolve(-1);
        return;
      }
      this.child = child;
      const decoders = {stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8')};
      const filter = interactive ? createLineFilter(this.opts.outputFilter) : null;
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          let text = decoders[stream].decode(chunk, {stream: true});
          if (stream === 'stdout' && filter) text = filter.push(text);
          if (text) this.emit('output', {stream, text});
        });
      }
      child.stdin.on('error', () => {});
      if (!interactive) child.stdin.end();
      child.on('error', (e) => {
        const hint =
          e.code === 'ENOENT'
            ? `Команда «${cmd}» не найдена. Установите её или измените команду запуска в настройках.\n`
            : `Ошибка запуска «${cmd}»: ${e.message}\n`;
        this.emit('output', {stream: 'stderr', text: hint});
      });
      child.on('close', (code) => {
        const rest = filter?.flush();
        if (rest) this.emit('output', {stream: 'stdout', text: rest});
        this.child = null;
        resolve(code ?? -1);
      });
    });
  }

  write(text) {
    if (this.child && this.child.stdin.writable) this.child.stdin.write(text);
  }

  closeInput() {
    if (this.child) this.child.stdin.end();
  }

  kill() {
    this.killed = true;
    if (this.child) this.child.kill();
  }

  cleanup() {
    try {
      fs.rmSync(this.dir, {recursive: true, force: true});
    } catch {
      // Файл может быть ещё занят (Windows) — не критично.
    }
  }
}

/** Удобная обёртка: запустить и собрать вывод (используется в тестах и CLI). */
function runToCompletion(opts, stdin = '') {
  return new Promise((resolve) => {
    const s = new RunSession(opts);
    let stdout = '';
    let stderr = '';
    s.on('status', ({interactive}) => {
      if (interactive && stdin) setTimeout(() => (s.write(stdin), s.closeInput()), 0);
      else if (interactive) setTimeout(() => s.closeInput(), 0);
    });
    s.on('output', ({stream, text}) => (stream === 'stdout' ? (stdout += text) : (stderr += text)));
    s.on('exit', ({code}) => resolve({code, stdout, stderr}));
    s.start();
  });
}

module.exports = {RunSession, runToCompletion, createLineFilter};
