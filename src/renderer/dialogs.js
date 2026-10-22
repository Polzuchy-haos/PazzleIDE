// Диалог с полями ввода вместо window.prompt (в Electron его нет).
//
//   const values = await ask({title, hint, ok, fields: [{name, label, value, type, options, placeholder, required}]});
//   values — {имя: значение} или null, если нажали «Отмена».
// type: text (по умолчанию) | textarea | select (options: [{value, label}]).
// Поле с showIf: {field, value} показывается, только когда у другого поля это значение.

export function ask({title, hint = '', ok = 'OK', fields = []}) {
  const dialog = document.getElementById('prompt-dialog');
  const form = document.getElementById('prompt-form');
  const box = document.getElementById('prompt-fields');
  document.getElementById('prompt-title').textContent = title;
  document.getElementById('prompt-hint').textContent = hint;
  document.getElementById('prompt-hint').hidden = !hint;
  document.getElementById('prompt-ok').textContent = ok;
  box.textContent = '';

  const controls = new Map();
  const rows = [];
  for (const f of fields) {
    const label = document.createElement('label');
    label.className = 'block';
    label.append(document.createTextNode(f.label || ''));
    let control;
    if (f.type === 'select') {
      control = document.createElement('select');
      for (const o of f.options || []) control.append(new Option(o.label, o.value));
    } else if (f.type === 'textarea') {
      control = document.createElement('textarea');
      control.rows = f.rows || 3;
    } else {
      control = document.createElement('input');
      control.spellcheck = false;
    }
    control.name = f.name;
    control.value = f.value ?? '';
    if (f.placeholder) control.placeholder = f.placeholder;
    if (f.required) control.required = true;
    label.append(control);
    box.append(label);
    controls.set(f.name, control);
    rows.push({f, label});
  }
  const sync = () => {
    for (const {f, label} of rows) {
      if (!f.showIf) continue;
      const visible = controls.get(f.showIf.field)?.value === f.showIf.value;
      label.hidden = !visible;
      controls.get(f.name).required = visible && !!f.required;
    }
  };
  form.oninput = sync;
  // Enter — «OK» (иначе форма нажала бы первую кнопку, «Отмена»).
  form.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    if (form.reportValidity()) dialog.close('ok');
  };
  sync();

  return new Promise((resolve) => {
    dialog.onclose = () => {
      form.oninput = null;
      if (dialog.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries([...controls].map(([name, c]) => [name, c.value.trim()])));
    };
    dialog.returnValue = '';
    dialog.showModal();
    const first = [...controls.values()].find((c) => !c.closest('label').hidden);
    if (first) {
      first.focus();
      first.select?.();
    }
  });
}
