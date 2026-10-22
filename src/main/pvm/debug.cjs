// Отладка программ PVM поверх утилиты pvmdbg.
//
// Протокол с устройством (кадры, CRC, COM-порт) целиком остаётся в pvmdbg — он
// уже проверен на железе. Здесь только два «драйвера», которые разговаривают с
// pvmdbg текстом, и контроллер над ними: шаги по строкам, точки останова, чтение
// переменных.
//
//   MachineDriver  — pvmdbg --machine: симулятор (ВМ в процессе pvmdbg) и плата с
//                    прошитой программой. Есть run/poll/pause.
//   HostCliDriver  — интерактивная сессия pvmdbg --host: программа на хосте, плата
//                    исполняет её по одной инструкции. Машинного протокола для
//                    --host в pvmdbg пока нет, а «run» там блокирующий и
//                    прерывается только Ctrl+C, поэтому выполнение идёт шагами,
//                    которые отдаёт контроллер, — так пауза работает всегда.
'use strict';
const {spawn} = require('child_process');
const {EventEmitter} = require('events');
const {SourceMap, loadListing, functionAt, baseName} = require('./artifacts.cjs');

/* PVMDbgStop_e в pvm/pvmdbg.h */
const MACHINE_REASONS = {0: 'running', 1: 'pause', 2: 'step', 3: 'breakpoint', 4: 'halted'};

/** Строка вывода программы: «pvmdbg: SVC print -> 15» -> «15». */
function programOutput(line) {
  const m = /SVC print -> (-?\d+)/.exec(line);
  return m ? m[1] + '\n' : null;
}

/** Значение переменной: число или null (нет на этом месте программы — «?», «not there yet»). */
function wordValue(raw) {
  const t = String(raw ?? '').trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
}

function frameVar(name, kind, offset, raw) {
  return {name: String(name), kind: kind === 'param' ? 'param' : 'local', offset, value: wordValue(raw)};
}

function globalVar(name, address, size, rawValues) {
  return {
    name: String(name),
    address,
    words: size,
    area: address >= 0x4000 ? 'usrsect' : 'ram',
    values: rawValues.map(wordValue),
  };
}

function spawnTool(cmd, args) {
  return spawn(cmd, args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
}

// ---------------------------------------------------------------------------

class MachineDriver {
  constructor({pvmdbg, args, onOutput, onExit}) {
    this.cmd = pvmdbg;
    this.args = [...args, '--machine'];
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.pending = [];
    this.buffer = '';
    this.hostBreakpoints = false;
    this.maxBreakpoints = 4; // слоты агента на устройстве
  }

  start() {
    this.proc = spawnTool(this.cmd, this.args);
    this.proc.stdout.on('data', (c) => this.consume(c.toString('utf8')));
    this.proc.stderr.on('data', (c) => this.onOutput?.(c.toString('utf8'), 'stderr'));
    this.proc.on('error', (e) => this.abort(e.message));
    this.proc.on('close', (code) => {
      this.abort(`pvmdbg завершился (${code})`);
      this.proc = null;
      this.onExit?.(code);
    });
  }

  consume(text) {
    this.buffer += text;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (/^(ok|error)\b/.test(line)) {
        this.pending.shift()?.(MachineDriver.parse(line));
      } else if (line.trim()) {
        // Всё, что не ответ протокола, печатает сама программа (SVC) или pvmdbg.
        const out = programOutput(line);
        this.onOutput?.(out ?? line + '\n', out ? 'program' : 'info');
      }
    }
  }

  static parse(line) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'error') return {ok: false, error: parts[1] || 'unknown'};
    const reply = {ok: true};
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const raw = p.slice(eq + 1);
      reply[p.slice(0, eq)] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
    return reply;
  }

  abort(reason) {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve({ok: false, error: reason});
  }

  command(text) {
    return new Promise((resolve) => {
      if (!this.proc) return resolve({ok: false, error: 'pvmdbg не запущен'});
      this.pending.push(resolve);
      this.proc.stdin.write(text + '\n');
    });
  }

  async init() {
    return this.state();
  }

  async state() {
    const r = await this.command('state');
    if (!r.ok) return {error: r.error, reason: 'error'};
    return {pc: r.pc, sp: r.sp, fp: r.fp, reason: MACHINE_REASONS[r.reason] || 'pause'};
  }

  async stepInstr() {
    const r = await this.command('step');
    if (!r.ok) return {reason: 'error', error: r.error};
    await this.command('poll'); // локально инструкция выполняется, только когда pvmdbg дают время
    return this.state();
  }

  async resume() {
    const r = await this.command('run');
    return r.ok;
  }

  async slice() {
    const r = await this.command('poll');
    if (!r.ok) return {running: false, error: r.error};
    return {running: r.running === 1};
  }

  async pause() {
    await this.command('pause');
  }

  async reset() {
    await this.command('reset');
    return this.state();
  }

  async setBreakpoints(addresses) {
    const current = await this.command('breaks');
    if (current.ok) for (let i = 0; i < current.n; i++) await this.command(`clear ${current[`a${i}`]}`);
    const placed = new Set();
    for (const a of addresses) {
      const r = await this.command(`break ${a}`);
      if (r.ok) placed.add(a);
    }
    return placed;
  }

  async stack(n) {
    const r = await this.command(`stack ${n}`);
    if (!r.ok) return [];
    return Array.from({length: r.n}, (_, i) => r[`v${i}`]);
  }

  async data(address, count) {
    const r = await this.command(`data ${address} ${count}`);
    if (!r.ok) return null;
    return Array.from({length: r.n}, (_, i) => r[`v${i}`]);
  }

  /** Стек вызовов с параметрами и локальными переменными каждого кадра (null — pvmdbg не умеет). */
  async callStack() {
    const r = await this.command('frames');
    if (!r.ok) return null;
    const frames = [];
    for (let i = 0; i < r.n; i++) {
      const v = await this.command(`vars ${i}`);
      const vars = [];
      if (v.ok) {
        for (let k = 0; k < v.n; k++) {
          vars.push(frameVar(v[`name${k}`], v[`kind${k}`], v[`off${k}`], v[`val${k}`]));
        }
      }
      frames.push({index: i, func: String(r[`fn${i}`]), pc: r[`pc${i}`], built: r[`built${i}`] === 1, vars});
    }
    return frames;
  }

  /** Глобальные переменные по карте отладки (null — pvmdbg не умеет). */
  async globals() {
    const r = await this.command('globals');
    if (!r.ok) return null;
    return Array.from({length: r.n}, (_, i) =>
      globalVar(r[`name${i}`], r[`addr${i}`], r[`size${i}`], String(r[`val${i}`] ?? '').split(',')),
    );
  }

  async stop() {
    if (!this.proc) return;
    await Promise.race([this.command('quit'), new Promise((r) => setTimeout(r, 3000))]);
    this.proc?.kill();
  }
}

// ---------------------------------------------------------------------------

const PROMPT = '(pvmdbg) ';
const HOST_REASONS = [
  [/^halted/, 'halted'],
  [/^breakpoint/, 'breakpoint'],
  [/^stepped/, 'step'],
  [/^stopped on an error/, 'error'],
  [/^no answer/, 'error'],
  [/^interrupted/, 'pause'],
  [/^function returned/, 'step'],
];

class HostCliDriver {
  constructor({pvmdbg, args, onOutput, onExit}) {
    this.cmd = pvmdbg;
    this.args = args;
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.buffer = '';
    this.waiting = null; // {resolve} — ответ до следующего приглашения
    this.queue = Promise.resolve();
    this.hostBreakpoints = true;
    this.maxBreakpoints = Infinity;
    this.breakpoints = new Set();
  }

  start() {
    this.proc = spawnTool(this.cmd, this.args);
    this.ready = new Promise((resolve, reject) => {
      this.waiting = {resolve, reject};
    });
    this.proc.stdout.on('data', (c) => this.consume(c.toString('utf8')));
    this.proc.stderr.on('data', (c) => {
      this.stderr = (this.stderr || '') + c.toString('utf8');
      this.onOutput?.(c.toString('utf8'), 'stderr');
    });
    this.proc.on('error', (e) => this.fail(e.message));
    this.proc.on('close', (code) => {
      this.fail(`pvmdbg завершился (${code})\n${(this.buffer + (this.stderr || '')).trim()}`);
      this.proc = null;
      this.onExit?.(code);
    });
  }

  consume(text) {
    this.buffer += text;
    let at;
    while ((at = this.buffer.indexOf(PROMPT)) >= 0) {
      const block = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + PROMPT.length);
      const w = this.waiting;
      this.waiting = null;
      w?.resolve(this.extractOutput(block));
    }
  }

  /** Вывод программы (SVC) уходит в консоль, остальное возвращается как ответ команды. */
  extractOutput(block) {
    const keep = [];
    for (const line of block.replace(/\r/g, '').split('\n')) {
      const out = programOutput(line);
      if (out) this.onOutput?.(out, 'program');
      else keep.push(line);
    }
    return keep.join('\n');
  }

  fail(reason) {
    const w = this.waiting;
    this.waiting = null;
    w?.reject?.(new Error(reason));
    w && !w.reject && w.resolve('');
  }

  command(text) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (!this.proc) return reject(new Error('pvmdbg не запущен'));
        this.waiting = {resolve, reject};
        this.proc.stdin.write(text + '\n');
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  static parseState(text) {
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => /pc=(0x[0-9A-Fa-f]+|----)\s+sp=\d+\s+fp=\d+/.test(l));
    if (idx < 0) return {reason: 'error', error: text.trim() || 'нет ответа от pvmdbg'};
    const m = /pc=(0x[0-9A-Fa-f]+|----)\s+sp=(\d+)\s+fp=(\d+)\s+(.*?)\s*(\[host(?::\s*([^\]]*))?\])?\s*$/.exec(lines[idx]);
    const status = m[4].trim();
    const reason = HOST_REASONS.find(([re]) => re.test(status))?.[1] || 'pause';
    const message = lines
      .slice(0, idx)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    return {
      pc: m[1] === '----' ? null : parseInt(m[1], 16),
      sp: Number(m[2]),
      fp: Number(m[3]),
      reason,
      error: reason === 'error' ? message || status : undefined,
    };
  }

  async init() {
    const text = await this.ready;
    return HostCliDriver.parseState(text);
  }

  async state() {
    return HostCliDriver.parseState(await this.command('state'));
  }

  async stepInstr() {
    return HostCliDriver.parseState(await this.command('step'));
  }

  async resume() {
    return true;
  }

  /** Несколько инструкций (до ~150 мс), с проверкой точек останова на хосте. */
  async slice() {
    const until = Date.now() + 150;
    do {
      const st = await this.stepInstr();
      if (st.reason === 'halted' || st.reason === 'error') return {running: false, state: st};
      if (st.pc !== null && this.breakpoints.has(st.pc)) return {running: false, state: {...st, reason: 'breakpoint'}};
    } while (Date.now() < until);
    return {running: true};
  }

  async pause() {}

  /** Выполнение средствами самого pvmdbg (быстрее шагов, но без паузы — только «Стоп»). */
  async runBlocking() {
    return HostCliDriver.parseState(await this.command('run'));
  }

  kill() {
    this.proc?.kill();
  }

  async reset() {
    return HostCliDriver.parseState(await this.command('reset'));
  }

  async setBreakpoints(addresses) {
    this.breakpoints = new Set(addresses);
    return new Set(addresses);
  }

  async stack(n) {
    const text = await this.command(`stack ${n}`);
    return [...text.matchAll(/\[(\d+)\]\s+(-?\d+)/g)].map((m) => Number(m[2]));
  }

  async data(address, count) {
    const text = await this.command(`data ${address} ${count}`);
    const values = [...text.matchAll(/0x[0-9A-Fa-f]+\s+(-?\d+)\s+\(0x/g)].map((m) => Number(m[1]));
    return values.length ? values : null;
  }

  async callStack() {
    const text = await this.command('bt full');
    if (/unknown command/.test(text)) return null;
    const frames = [];
    for (const line of text.split('\n')) {
      const head = /^\s*>?\s*#(\d+)\s+([A-Za-z_]\w*)\((.*?)\)\s+0x([0-9A-Fa-f]+)/.exec(line);
      if (head) {
        frames.push({index: Number(head[1]), func: head[2], pc: parseInt(head[4], 16), built: true, vars: []});
        continue;
      }
      const v = /^\s+([A-Za-z_]\w*)\s+=\s+(.*?)\s+(param|local)\s+FP([+-]\d+)/.exec(line);
      if (v && frames.length) frames[frames.length - 1].vars.push(frameVar(v[1], v[3], Number(v[4]), v[2].trim()));
    }
    return frames;
  }

  async globals() {
    const text = await this.command('globals');
    if (/unknown command/.test(text)) return null;
    const out = [];
    for (const line of text.split('\n')) {
      const m = /^\s+([A-Za-z_]\w*)\s+0x([0-9A-Fa-f]+)\s+=\s+(.*)$/.exec(line);
      if (!m) continue;
      const values = m[3].trim().replace(/^\{|\}$/g, '').split(',');
      out.push(globalVar(m[1], parseInt(m[2], 16), values.length, values));
    }
    return out;
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    const closed = new Promise((r) => proc.once('close', r));
    proc.stdin.write('exit\n');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
    if (this.proc) this.proc.kill();
  }
}

// ---------------------------------------------------------------------------

const MAX_LINE_STEPS = 5000;

/**
 * Сессия отладки. События:
 *   'state'  {status: 'running'|'stopped'|'ended', ...}  — см. snapshot()
 *   'output' {text, kind}                                — вывод программы и pvmdbg
 */
class DebugSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {'sim'|'board-host'|'board-flash'} o.target
   * @param {string} o.pvmdbg   путь к pvmdbg
   * @param {object} o.files    {bin, map, lst, hlc} — результат сборки
   * @param {string} [o.port]   COM-порт платы
   * @param {number} [o.baud]
   * @param {string[]} [o.link] аргументы подключения pvmdbg вместо port/baud (например, ['--tcp', 'host:5555'])
   */
  constructor(o) {
    super();
    this.o = o;
    this.map = SourceMap.load(o.files.map);
    this.listing = loadListing(o.files.lst);
    this.sourceFile = baseName(o.files.hlc);
    this.breakLines = [];
    this.addresses = new Set();
    this.queue = Promise.resolve();
    this.pauseRequested = false;
    this.ended = false;
    this.last = null;
  }

  get busy() {
    return this._busy;
  }

  async start() {
    const {target, pvmdbg, files, port, baud, link} = this.o;
    const onOutput = (text, kind) => this.emit('output', {text, kind});
    const onExit = (code) => this.finish(this.stopping ? "Сессия отладки завершена" : `pvmdbg завершился (код ${code})`);
    // link — готовые аргументы подключения (--port … или --tcp …), иначе последовательный порт.
    const serial = link || (port ? ['--port', port, '--baud', String(baud || 9600)] : []);
    if (target === 'board-host') {
      this.driver = new HostCliDriver({pvmdbg, args: ['--host', files.bin, ...serial, '--map', files.map], onOutput, onExit});
    } else if (target === 'board-flash') {
      this.driver = new MachineDriver({pvmdbg, args: [...serial, '--map', files.map], onOutput, onExit});
    } else {
      this.driver = new MachineDriver({pvmdbg, args: [files.bin, '--map', files.map], onOutput, onExit});
    }
    this.driver.start();
    let st;
    try {
      st = await this.driver.init();
    } catch (e) {
      this.finish(e.message);
      throw e;
    }
    if (st.reason === 'error') {
      await this.driver.stop();
      throw new Error(st.error || 'устройство не отвечает');
    }
    if (target === 'board-host' || target === 'sim') {
      // Свежий запуск: PC в начало, стек пуст.
      if (target === 'sim') st = await this.driver.reset();
    }
    await this.report({...st, reason: 'entry'});
  }

  /** Все операции с устройством идут строго по очереди. */
  enqueue(fn) {
    const run = async () => {
      if (this.ended) return;
      this._busy = true;
      try {
        await fn();
      } catch (e) {
        this.emit('output', {text: `Ошибка отладчика: ${e.message}\n`, kind: 'stderr'});
      } finally {
        this._busy = false;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }

  // ---- точки останова ----

  setBreakpoints(lines) {
    this.breakLines = [...new Set(lines)].sort((a, b) => a - b);
    if (!this.driver) return Promise.resolve(); // до старта только запоминаем
    return this.enqueue(() => this.syncBreakpoints());
  }

  /** Строка -> адрес; если у строки нет кода, берётся ближайшая следующая строка с кодом. */
  addressForLine(line) {
    const direct = this.map.addressFor(this.sourceFile, line);
    if (direct !== null) return {line, address: direct};
    const next = this.map.linesOf(this.sourceFile).find((l) => l > line && l <= line + 3);
    return next ? {line: next, address: this.map.addressFor(this.sourceFile, next)} : null;
  }

  async syncBreakpoints() {
    const wanted = [];
    for (const line of this.breakLines) {
      const r = this.addressForLine(line);
      if (r) wanted.push({...r, requested: line});
    }
    const limited = wanted.slice(0, this.driver.maxBreakpoints);
    const placed = await this.driver.setBreakpoints(limited.map((w) => w.address));
    this.addresses = placed;
    const verified = wanted.filter((w) => placed.has(w.address)).map((w) => w.requested);
    if (wanted.length > limited.length) {
      this.emit('output', {
        text: `Установлено ${limited.length} точек останова из ${wanted.length}: у агента на устройстве всего ${this.driver.maxBreakpoints} слота.\n`,
        kind: 'info',
      });
    }
    this.emit('breakpoints', {verified});
  }

  // ---- выполнение ----

  pause() {
    this.pauseRequested = true;
  }

  continue() {
    return this.enqueue(async () => {
      this.pauseRequested = false;
      await this.driver.resume();
      this.emit('state', {status: 'running'});
      let stopped = null;
      for (;;) {
        if (this.pauseRequested) {
          await this.driver.pause();
          break;
        }
        const r = await this.driver.slice();
        if (r.error) throw new Error(r.error);
        if (!r.running) {
          stopped = r.state || null;
          break;
        }
      }
      const st = stopped || (await this.driver.state());
      await this.report(this.pauseRequested && st.reason !== 'halted' ? {...st, reason: 'pause'} : st);
    });
  }

  /** Шаг по строке исходника. over — не заходить в функции, out — выйти из текущей. */
  stepLine(mode) {
    return this.enqueue(async () => {
      this.pauseRequested = false;
      const start = await this.driver.state();
      if (start.reason === 'halted') return this.report(start);
      const from = start.pc !== null ? this.map.locationFor(start.pc) : null;
      let st = start;
      let returnTo = null; // шаг с обходом: ждём возврата из вызова на этот адрес
      let returnFp = null; // ... в тот же кадр (важно для рекурсии)
      this.emit('state', {status: 'running'});
      for (let i = 0; i < MAX_LINE_STEPS; i++) {
        if (this.pauseRequested) break;
        const prev = st;
        const executed = prev.pc !== null ? this.listing.instructions.get(prev.pc)?.text || '' : '';
        st = await this.driver.stepInstr();
        if (st.reason === 'halted' || st.reason === 'error') break;
        if (this.addresses.has(st.pc) && i > 0) {
          st = {...st, reason: 'breakpoint'};
          break;
        }
        if (!from) break; // без карты шаг — это одна инструкция
        if (mode === 'out') {
          // Выход из функции: выполнен RET из текущего кадра (или глубже не было).
          if (/^RET\b/.test(executed) && st.fp < start.fp) break;
          continue;
        }
        if (returnTo !== null) {
          if (st.pc === returnTo && st.fp === returnFp) returnTo = null;
          else continue;
        } else if (mode === 'over' && /^CALL\b/.test(executed)) {
          // Указатель кадра растёт только на ENTER, поэтому вызов отслеживаем по CALL.
          const size = this.listing.instructions.get(prev.pc)?.bytes.split(/\s+/).length || 3;
          returnTo = prev.pc + size;
          returnFp = prev.fp;
          continue;
        }
        const here = this.map.locationFor(st.pc);
        if (!here || baseName(here.file) !== this.sourceFile) continue; // библиотечный код (lib/*.hlc) проходим
        if (here.line !== from.line) break;
      }
      await this.report({...st, reason: st.reason === 'breakpoint' || st.reason === 'halted' || st.reason === 'error' ? st.reason : 'step'});
    });
  }

  /** Запуск без отладки: до HALT/ошибки, без точек останова и без паузы. */
  runFree() {
    if (!this.driver.runBlocking) return this.continue();
    this.freeRunning = true;
    return this.enqueue(async () => {
      this.emit('state', {status: 'running'});
      const st = await this.driver.runBlocking();
      this.freeRunning = false;
      await this.report(st);
    });
  }

  stepInstruction() {
    return this.enqueue(async () => this.report({...(await this.driver.stepInstr())}));
  }

  reset() {
    return this.enqueue(async () => this.report({...(await this.driver.reset()), reason: 'entry'}));
  }

  // ---- состояние ----

  /** Значения глобальных переменных: соседние адреса читаются одним запросом. */
  async readVariables() {
    const vars = this.listing.variables;
    const out = [];
    let i = 0;
    while (i < vars.length) {
      let j = i;
      while (j + 1 < vars.length && vars[j + 1].address === vars[j].address + vars[j].words && vars[j + 1].address - vars[i].address < 32) j++;
      const first = vars[i].address;
      const count = Math.min(32, vars[j].address + vars[j].words - first);
      const values = await this.driver.data(first, count);
      for (let k = i; k <= j; k++) {
        const off = vars[k].address - first;
        out.push({...vars[k], values: values ? values.slice(off, off + vars[k].words) : null});
      }
      i = j + 1;
    }
    return out;
  }

  async report(st) {
    if (st.reason === 'error' && st.pc === undefined) {
      this.emit('output', {text: `${st.error}\n`, kind: 'stderr'});
    }
    const pc = st.pc ?? null;
    const loc = pc !== null ? this.map.locationFor(pc) : null;
    const inSource = loc && baseName(loc.file) === this.sourceFile;
    const snapshot = {
      status: 'stopped',
      reason: st.reason,
      error: st.error,
      pc,
      sp: st.sp,
      fp: st.fp,
      line: inSource ? loc.line : null,
      file: loc ? baseName(loc.file) : null,
      fileLine: loc ? loc.line : null,
      func: pc !== null ? functionAt(this.listing, pc) : null,
      instruction: pc !== null ? this.listing.instructions.get(pc)?.text || null : null,
      stack: await this.driver.stack(8),
      frames: ((await this.driver.callStack?.()) || []).map((f) => {
        const at = this.map.locationFor(f.pc);
        return {...f, line: at && baseName(at.file) === this.sourceFile ? at.line : null, file: at ? baseName(at.file) : null, fileLine: at ? at.line : null};
      }),
      variables: (await this.driver.globals?.()) || (await this.readVariables()),
    };
    this.last = snapshot;
    this.emit('state', snapshot);
  }

  async stop() {
    this.pauseRequested = true;
    this.stopping = true;
    if (this.ended) return;
    if (this.freeRunning) {
      // pvmdbg занят командой run и не читает ввод: завершаем процесс. Плату отпустит следующая сессия.
      this.driver.kill();
      this.finish('Остановлено');
      return;
    }
    await this.queue.catch(() => {});
    await this.driver?.stop();
    this.finish('Сессия отладки завершена');
  }

  finish(message) {
    if (this.ended) return;
    this.ended = true;
    this.emit('state', {status: 'ended', message});
  }
}

module.exports = {DebugSession, MachineDriver, HostCliDriver};
