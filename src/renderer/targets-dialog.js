// Диалог «Цели»: список целей слева, свойства выбранной справа.
// Изменения копятся в рабочей копии и сохраняются кнопкой «Сохранить».

const MODE_NAMES = {sim: 'симулятор', 'board-host': 'с хоста', 'board-flash': 'прошитая'};

const newId = () => `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function openTargetsDialog({targets, current, info, ports = [], focus, onSave}) {
  const dialog = document.getElementById('targets-dialog');
  const form = document.getElementById('targets-form');
  const list = document.getElementById('targets-list');
  const fields = document.getElementById('target-fields');
  const work = structuredClone(targets);
  let selected = Math.max(0, work.findIndex((t) => t.id === current));
  let lastField = null; // поле, куда вставлять переменную по щелчку

  const el = (name) => form.elements.namedItem(name);
  const portsList = document.getElementById('targets-ports');
  portsList.textContent = '';
  for (const p of ports) portsList.append(new Option(p));

  // Справка по переменным: щелчок вставляет ${имя} в последнее активное поле команды.
  const vars = document.getElementById('targets-vars');
  vars.textContent = '';
  for (const v of info?.variables || []) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = '${' + v.name + '}';
    code.title = `Вставить; в окружении — ${v.env}`;
    code.onclick = () => insertVariable(v.name);
    name.append(code);
    const desc = document.createElement('td');
    desc.textContent = v.description;
    tr.append(name, desc);
    vars.append(tr);
  }
  const defaults = info?.defaults || {};
  el('limit-code').placeholder = `${defaults.code ?? ''} (по умолч.)`;
  el('limit-ram').placeholder = `${defaults.ram ?? ''} (по умолч.)`;
  el('limit-stack').placeholder = `${defaults.stack ?? ''} (по умолч.)`;

  function insertVariable(name) {
    const field = lastField || el('flash');
    const text = '${' + name + '}';
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.value = field.value.slice(0, start) + text + field.value.slice(end);
    field.focus();
    field.setSelectionRange(start + text.length, start + text.length);
    readForm();
  }

  function renderList() {
    list.textContent = '';
    work.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = i === selected ? 'selected' : '';
      const name = document.createElement('span');
      name.textContent = t.name || 'Без названия';
      const mode = document.createElement('small');
      mode.textContent = MODE_NAMES[t.mode] + (t.mode !== 'sim' && t.connection === 'tcp' ? ', TCP' : '') + (t.flash ? ', прошивка' : '');
      li.append(name, mode);
      li.onclick = () => {
        readForm();
        selected = i;
        renderList();
        fillForm();
      };
      list.append(li);
    });
    document.getElementById('target-delete').disabled = work.length <= 1;
  }

  function fillForm() {
    const t = work[selected];
    for (const k of ['name', 'mode', 'connection', 'port', 'tcp', 'bridge', 'bridgeReady', 'flash', 'run', 'env']) el(k).value = t[k] ?? '';
    el('baud').value = String(t.baud || 9600);
    el('bridgeDelay').value = String(t.bridgeDelay ?? 1000);
    for (const k of ['code', 'ram', 'stack']) el(`limit-${k}`).value = t.limits?.[k] ?? '';
    syncVisibility();
  }

  function readForm() {
    const t = work[selected];
    if (!t) return;
    for (const k of ['name', 'mode', 'connection', 'port', 'tcp', 'bridge', 'bridgeReady', 'flash', 'run', 'env']) t[k] = el(k).value.trim();
    t.baud = Number(el('baud').value) || 9600;
    t.bridgeDelay = Math.max(0, Number(el('bridgeDelay').value) || 0);
    t.limits = Object.fromEntries(['code', 'ram', 'stack'].map((k) => [k, Number(el(`limit-${k}`).value) || null]));
  }

  function syncVisibility() {
    const board = el('mode').value !== 'sim';
    const tcp = el('connection').value === 'tcp';
    for (const e of fields.querySelectorAll('[data-board]')) e.hidden = !board;
    for (const e of fields.querySelectorAll('[data-serial]')) e.hidden = tcp;
    for (const e of fields.querySelectorAll('[data-tcp]')) e.hidden = !tcp;
  }

  form.oninput = () => {
    readForm();
    syncVisibility();
    renderList();
  };
  // Enter в поле не закрывает диалог (первая кнопка формы — «Отмена»).
  form.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
  };
  fields.onfocusin = (e) => {
    if (e.target.matches('input.mono, textarea.mono')) lastField = e.target;
  };

  document.getElementById('target-add').onclick = () => {
    readForm();
    work.push({...structuredClone(work[selected]), id: newId(), name: 'Новая цель', mode: 'board-flash', flash: '', run: '', bridge: '', bridgeReady: ''});
    selected = work.length - 1;
    renderList();
    fillForm();
    el('name').focus();
    el('name').select();
  };
  document.getElementById('target-copy').onclick = () => {
    readForm();
    work.splice(selected + 1, 0, {...structuredClone(work[selected]), id: newId(), name: `${work[selected].name} (копия)`});
    selected++;
    renderList();
    fillForm();
  };
  document.getElementById('target-delete').onclick = () => {
    if (work.length <= 1) return;
    if (!window.confirm(`Удалить цель «${work[selected].name}»?`)) return;
    work.splice(selected, 1);
    selected = Math.min(selected, work.length - 1);
    renderList();
    fillForm();
  };

  dialog.onclose = () => {
    if (dialog.returnValue !== 'ok') return;
    readForm();
    onSave({targets: work, target: work[selected]?.id || current});
  };

  renderList();
  fillForm();
  dialog.returnValue = '';
  dialog.showModal();
  if (focus) {
    el(focus).focus();
    lastField = el(focus);
  }
}
