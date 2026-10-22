// Перетаскиваемые разделители панелей. Размеры запоминаются в localStorage.
//   data-target="right"    — ширина панели кода (справа от разделителя)
//   data-target="explorer" — ширина дерева файлов (слева от разделителя)
//   data-target="console"  — высота консоли (под разделителем)
const KEY = 'pazzle.layout';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Хранилище недоступно — размеры просто не запомнятся.
  }
}

export function initSplitters(onResize) {
  const sizes = load();
  const panes = {
    right: document.getElementById('right'),
    explorer: document.getElementById('explorer'),
    console: document.getElementById('console'),
  };
  if (sizes.right) panes.right.style.width = sizes.right;
  if (sizes.explorer) panes.explorer.style.width = sizes.explorer;
  if (sizes.console) panes.console.style.height = sizes.console;

  for (const splitter of document.querySelectorAll('.splitter')) {
    const which = splitter.dataset.target;
    const target = panes[which];
    if (!target) continue;
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('dragging');
      const parent = target.parentElement.getBoundingClientRect();
      const move = (ev) => {
        if (which === 'right') {
          const w = Math.min(Math.max(parent.right - ev.clientX, 280), parent.width - 300);
          target.style.width = `${(w / parent.width) * 100}%`;
        } else if (which === 'explorer') {
          const w = Math.min(Math.max(ev.clientX - parent.left, 160), parent.width * 0.5);
          target.style.width = `${Math.round(w)}px`;
        } else {
          const h = Math.min(Math.max(parent.bottom - ev.clientY, 90), parent.height - 120);
          target.style.height = `${(h / parent.height) * 100}%`;
        }
        onResize?.();
      };
      const up = () => {
        splitter.classList.remove('dragging');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        save({right: panes.right.style.width, explorer: panes.explorer.style.width, console: panes.console.style.height});
        onResize?.();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  }
}
