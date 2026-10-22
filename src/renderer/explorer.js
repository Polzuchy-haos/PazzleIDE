// Дерево файлов рабочего стола «IDE». Папки раскрываются по щелчку и читаются
// по мере раскрытия; какие папки раскрыты, запоминается для каждой корневой папки.

const KEY = 'pazzle.explorer.expanded';

const ICONS = {
  dir: '<path d="M3 7h6l2 2h10v10H3z"/>',
  pzl: '<path d="M4 5h7v3a1.5 1.5 0 0 0 3 0V5h6v6h-3a1.5 1.5 0 0 0 0 3h3v6H4z"/>',
  hlc: '<path d="M8 7l-5 5 5 5 M16 7l5 5-5 5"/>',
  pzlib: '<path d="M4 6h16v13H4z M4 10h16 M10 6v4"/>',
  file: '<path d="M6 3h8l4 4v14H6z M14 3v4h4"/>',
};

function iconFor(entry) {
  if (entry.dir) return 'dir';
  const ext = entry.name.split('.').pop().toLowerCase();
  if (ext === 'pzl' || ext === 'vide') return 'pzl';
  if (ext === 'hlc') return 'hlc';
  if (ext === 'pzlib') return 'pzlib';
  return 'file';
}

function loadExpanded() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export class Explorer {
  /**
   * @param {object} o
   * @param {object} o.fs          window.pazzle.fs
   * @param {(path: string) => void} o.onOpen         открыть файл
   * @param {(entry, isRoot) => void} o.onContextMenu  правый щелчок (entry: {path, dir, name})
   */
  constructor({fs, onOpen, onContextMenu}) {
    this.fs = fs;
    this.onOpen = onOpen;
    this.onContextMenu = onContextMenu;
    this.tree = document.getElementById('explorer-tree');
    this.title = document.getElementById('explorer-title');
    this.empty = document.getElementById('explorer-empty');
    this.root = null;
    this.expanded = new Set();
    this.active = null;
    this.tree.addEventListener('contextmenu', (e) => {
      if (e.target === this.tree && this.root) {
        e.preventDefault();
        this.onContextMenu({path: this.root, dir: true, name: ''}, true);
      }
    });
  }

  async setRoot(dir) {
    this.root = dir || null;
    const saved = loadExpanded();
    this.expanded = new Set(dir ? saved[dir] || [] : []);
    this.title.textContent = dir ? dir.split(/[\\/]/).filter(Boolean).pop() : 'Папка';
    this.title.title = dir || '';
    this.empty.hidden = !!dir;
    this.tree.hidden = !dir;
    await this.render();
  }

  saveExpanded() {
    if (!this.root) return;
    const saved = loadExpanded();
    saved[this.root] = [...this.expanded];
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // не критично
    }
  }

  async render() {
    if (!this.root) {
      this.tree.textContent = '';
      return;
    }
    // Перерисовки асинхронные: результат устаревшей (начатой раньше последней) отбрасываем.
    const seq = (this.seq = (this.seq || 0) + 1);
    const scroll = this.tree.scrollTop;
    const fragment = document.createDocumentFragment();
    await this.renderDir(this.root, 0, fragment);
    if (seq !== this.seq) return;
    this.tree.textContent = '';
    this.tree.append(fragment);
    this.tree.scrollTop = scroll;
  }

  async renderDir(dir, depth, parent) {
    const entries = await this.fs.list(dir);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'tree-row' + (entry.dir ? ' dir' : '') + (/\.build$/i.test(entry.name) ? ' dim' : '');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.dataset.path = entry.path;
      row.title = entry.path;
      const open = entry.dir && this.expanded.has(entry.path);
      const chevron = document.createElement('span');
      chevron.className = 'chevron';
      chevron.textContent = entry.dir ? (open ? '▾' : '▸') : '';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.classList.add('tree-icon', iconFor(entry));
      icon.innerHTML = ICONS[iconFor(entry)];
      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = entry.name;
      row.append(chevron, icon, name);
      if (!entry.dir && this.active && samePath(entry.path, this.active)) row.classList.add('active');
      row.addEventListener('click', () => (entry.dir ? this.toggle(entry.path) : this.onOpen(entry.path)));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onContextMenu(entry, false);
      });
      parent.append(row);
      if (open) await this.renderDir(entry.path, depth + 1, parent);
    }
  }

  async toggle(dir) {
    if (this.expanded.has(dir)) this.expanded.delete(dir);
    else this.expanded.add(dir);
    this.saveExpanded();
    await this.render();
  }

  async reveal(path) {
    // Раскрыть папки до файла (если он внутри корня) и подсветить его.
    this.active = path;
    if (this.root && path && isInside(path, this.root)) {
      let dir = parentOf(path);
      while (dir && isInside(dir, this.root) && !samePath(dir, this.root)) {
        this.expanded.add(dir);
        dir = parentOf(dir);
      }
      this.saveExpanded();
    }
    await this.render();
  }

  collapseAll() {
    this.expanded.clear();
    this.saveExpanded();
    return this.render();
  }
}

const norm = (p) => String(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const samePath = (a, b) => norm(a) === norm(b);
const isInside = (p, dir) => norm(p).startsWith(norm(dir) + '/');
const parentOf = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : null;
};
export {samePath, parentOf};
