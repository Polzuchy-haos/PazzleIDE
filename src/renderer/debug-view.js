// Панель «Отладка»: где остановились, стек вызовов, переменные функции,
// глобальные переменные и сырой стек ВМ.

const REASONS = {
  entry: 'начало',
  pause: 'пауза',
  step: 'шаг',
  breakpoint: 'точка останова',
  halted: 'программа завершена',
  error: 'ошибка',
  running: 'выполняется…',
};

const hex = (n) => '0x' + Number(n).toString(16).toUpperCase().padStart(4, '0');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(...cells) {
  const tr = document.createElement('tr');
  for (const [text, cls] of cells) tr.append(el('td', cls, text));
  return tr;
}

const shown = (v) => (v === null || v === undefined ? '—' : String(v));

export class DebugView {
  /** onSelectFrame(frame) — пользователь выбрал кадр в стеке вызовов. */
  constructor({onSelectFrame} = {}) {
    this.onSelectFrame = onSelectFrame;
    this.empty = document.getElementById('debug-empty');
    this.view = document.getElementById('debug-view');
    this.where = document.getElementById('debug-where');
    this.calls = document.getElementById('debug-calls');
    this.localsTitle = document.getElementById('debug-locals-title');
    this.locals = document.getElementById('debug-locals');
    this.vars = document.getElementById('debug-vars');
    this.stack = document.getElementById('debug-stack');
    this.previous = new Map();
    this.snap = null;
    this.names = {};
    this.selected = 0;
  }

  reset() {
    this.previous = new Map();
    this.snap = null;
    this.view.hidden = true;
    this.empty.hidden = false;
  }

  running(targetName) {
    this.empty.hidden = true;
    this.view.hidden = false;
    this.where.textContent = '';
    this.where.append(el('span', 'reason running', REASONS.running), document.createTextNode(targetName || ''));
    this.view.classList.add('stale');
  }

  /** Имя из кода -> название в блоках: «результат (rezultat)». */
  label(name) {
    const block = this.names[name];
    return block && block !== name ? `${block} (${name})` : name;
  }

  /** Подсветка значения, изменившегося с прошлой остановки. */
  changed(key, value) {
    const was = this.previous.get(key);
    this.previous.set(key, value);
    return was !== undefined && was !== value;
  }

  /** snap — состояние из DebugSession.report; names — имя в коде -> имя в блоках. */
  show(snap, names = {}) {
    this.snap = snap;
    this.names = names;
    this.selected = 0;
    this.empty.hidden = true;
    this.view.hidden = false;
    this.view.classList.remove('stale');
    this.renderWhere();
    this.renderCalls();
    this.renderLocals();
    this.renderGlobals();
    this.renderStack();
  }

  renderWhere() {
    const snap = this.snap;
    this.where.textContent = '';
    this.where.append(el('span', `reason ${snap.reason}`, REASONS[snap.reason] || snap.reason));
    const parts = [];
    if (snap.line) parts.push(`строка ${snap.line}`);
    else if (snap.file) parts.push(`${snap.file}:${snap.fileLine}`);
    if (snap.func) parts.push(`функция ${this.label(snap.func)}`);
    this.where.append(document.createTextNode(parts.join(' · ')));
    this.where.append(
      el(
        'div',
        'muted',
        (snap.pc !== null && snap.pc !== undefined ? `PC ${hex(snap.pc)}` : 'PC ----') +
          `   SP ${snap.sp ?? '-'}   FP ${snap.fp ?? '-'}` +
          (snap.instruction ? `   ▸ ${snap.instruction}` : ''),
      ),
    );
    if (snap.error) this.where.append(el('div', 'muted', snap.error));
  }

  renderCalls() {
    const frames = this.snap.frames || [];
    this.calls.textContent = '';
    if (!frames.length) {
      this.calls.append(row(['нет данных (нужен pvmdbg с поддержкой стека вызовов)', 'dim']));
      return;
    }
    frames.forEach((f, i) => {
      const args = f.vars
        .filter((v) => v.kind === 'param')
        .map((v) => `${this.names[v.name] || v.name}=${shown(v.value)}`)
        .join(', ');
      const where = f.line ? `строка ${f.line}` : f.file ? `${f.file}:${f.fileLine}` : hex(f.pc);
      const tr = row([`#${f.index}`, 'addr'], [`${this.names[f.func] || f.func}(${args})`, 'name'], [where, 'dim']);
      tr.className = 'frame' + (i === this.selected ? ' selected' : '');
      tr.title = i === 0 ? 'Где стоит программа' : 'Место вызова — щёлкните, чтобы посмотреть переменные этой функции';
      tr.addEventListener('click', () => this.selectFrame(i));
      this.calls.append(tr);
    });
  }

  selectFrame(i) {
    const frames = this.snap?.frames || [];
    if (!frames[i]) return;
    this.selected = i;
    this.renderCalls();
    this.renderLocals();
    this.onSelectFrame?.(frames[i], i);
  }

  renderLocals() {
    const frame = (this.snap.frames || [])[this.selected];
    this.locals.textContent = '';
    this.localsTitle.textContent = frame ? `Переменные функции ${this.names[frame.func] || frame.func}` : 'Переменные функции';
    if (!frame) return;
    if (!frame.vars.length) {
      this.locals.append(row(['нет параметров и локальных переменных', 'dim']));
      return;
    }
    for (const v of frame.vars) {
      const value = shown(v.value);
      const tr = row(
        [this.label(v.name), 'name'],
        [v.value === null ? 'ещё нет' : value, v.value === null ? 'dim' : 'value'],
        [v.kind === 'param' ? 'параметр' : 'локальная', 'dim'],
        [`FP${v.offset >= 0 ? '+' : ''}${v.offset}`, 'addr'],
      );
      if (this.changed(`${frame.index}:${frame.func}:${v.name}`, value)) tr.classList.add('changed');
      this.locals.append(tr);
    }
  }

  renderGlobals() {
    const vars = this.snap.variables || [];
    this.vars.textContent = '';
    if (!vars.length) this.vars.append(row(['нет глобальных переменных', 'dim']));
    for (const v of vars) {
      const value = v.values ? v.values.map(shown).join(', ') : '—';
      const kind = v.area === 'usrsect' ? (v.address === 0x4007 ? 'вывод' : 'порт') : v.words > 1 ? `массив[${v.words}]` : '';
      const tr = row([this.label(v.name), 'name'], [value, 'value'], [kind, 'dim'], [hex(v.address), 'addr']);
      if (this.changed(`${v.name}@${v.address}`, value)) tr.classList.add('changed');
      this.vars.append(tr);
    }
  }

  renderStack() {
    const stack = this.snap.stack || [];
    this.stack.textContent = '';
    if (!stack.length) this.stack.append(row(['пусто', 'dim']));
    stack.forEach((w, i) => this.stack.append(row([`[${i}]`, 'addr'], [String(w), 'value'], [i === 0 ? '← вершина' : '', 'dim'])));
  }
}
