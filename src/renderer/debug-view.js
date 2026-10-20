// Панель «Отладка»: где остановились, переменные программы и стек ВМ.

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

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

export class DebugView {
  constructor() {
    this.empty = document.getElementById('debug-empty');
    this.view = document.getElementById('debug-view');
    this.where = document.getElementById('debug-where');
    this.vars = document.getElementById('debug-vars');
    this.stack = document.getElementById('debug-stack');
    this.previous = new Map();
  }

  reset() {
    this.previous = new Map();
    this.view.hidden = true;
    this.empty.hidden = false;
  }

  running(targetName) {
    this.empty.hidden = true;
    this.view.hidden = false;
    this.where.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'reason running';
    badge.textContent = REASONS.running;
    this.where.append(badge, document.createTextNode(targetName || ''));
  }

  /** snap — состояние из DebugSession.report; names — имя в HLC -> имя переменной в блоках. */
  show(snap, names = {}) {
    this.empty.hidden = true;
    this.view.hidden = false;

    this.where.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = `reason ${snap.reason}`;
    badge.textContent = REASONS[snap.reason] || snap.reason;
    this.where.append(badge);
    const parts = [];
    if (snap.line) parts.push(`строка ${snap.line}`);
    else if (snap.file) parts.push(`${snap.file}:${snap.fileLine}`);
    if (snap.func) parts.push(`функция ${snap.func}`);
    this.where.append(document.createTextNode(parts.join(' · ')));
    const regs = document.createElement('div');
    regs.className = 'muted';
    regs.textContent =
      (snap.pc !== null && snap.pc !== undefined ? `PC ${hex(snap.pc)}` : 'PC ----') +
      `   SP ${snap.sp ?? '-'}   FP ${snap.fp ?? '-'}` +
      (snap.instruction ? `   ▸ ${snap.instruction}` : '');
    this.where.append(regs);
    if (snap.error) {
      const err = document.createElement('div');
      err.className = 'muted';
      err.textContent = snap.error;
      this.where.append(err);
    }

    this.vars.textContent = '';
    if (!snap.variables?.length) {
      const tr = document.createElement('tr');
      tr.append(cell('нет глобальных переменных', 'dim'));
      this.vars.append(tr);
    }
    for (const v of snap.variables || []) {
      const tr = document.createElement('tr');
      const shown = names[v.name] && names[v.name] !== v.name ? `${names[v.name]} (${v.name})` : v.name;
      const value = v.values ? v.values.join(', ') : '—';
      const key = `${v.name}@${v.address}`;
      if (this.previous.has(key) && this.previous.get(key) !== value) tr.className = 'changed';
      this.previous.set(key, value);
      const kind = v.area === 'usrsect' ? 'порт' : v.words > 1 ? `массив[${v.words}]` : '';
      tr.append(cell(shown, 'name'), cell(value, 'value'), cell(kind, 'dim'), cell(hex(v.address), 'addr'));
      this.vars.append(tr);
    }

    this.stack.textContent = '';
    if (!snap.stack?.length) {
      const tr = document.createElement('tr');
      tr.append(cell('пусто', 'dim'));
      this.stack.append(tr);
    }
    (snap.stack || []).forEach((w, i) => {
      const tr = document.createElement('tr');
      tr.append(cell(`[${i}]`, 'addr'), cell(String(w), 'value'), cell(i === 0 ? '← вершина' : '', 'dim'));
      this.stack.append(tr);
    });
  }
}
