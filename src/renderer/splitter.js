// Перетаскиваемые разделители панелей. Размеры запоминаются в localStorage.
const KEY = 'vide.layout';

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
  const right = document.getElementById('right');
  const consoleEl = document.getElementById('console');
  if (sizes.right) right.style.width = sizes.right;
  if (sizes.console) consoleEl.style.height = sizes.console;

  for (const splitter of document.querySelectorAll('.splitter')) {
    const vertical = splitter.classList.contains('vertical');
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('dragging');
      const target = vertical ? right : consoleEl;
      const parent = target.parentElement.getBoundingClientRect();
      const move = (ev) => {
        if (vertical) {
          const w = Math.min(Math.max(parent.right - ev.clientX, 280), parent.width - 300);
          target.style.width = `${(w / parent.width) * 100}%`;
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
        save({right: right.style.width, console: consoleEl.style.height});
        onResize?.();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  }
}
