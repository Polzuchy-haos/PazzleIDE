// Панель консоли: вывод программы, сообщения IDE и строка ввода (stdin).
const MAX_CHARS = 400_000;

export class ConsoleView {
  constructor(outputEl) {
    this.el = outputEl;
    this.size = 0;
  }

  clear() {
    this.el.textContent = '';
    this.size = 0;
  }

  write(text, kind = 'stdout') {
    if (!text) return;
    const stick = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 4;
    const last = this.el.lastChild;
    if (last && last.dataset?.kind === kind) {
      last.textContent += text;
    } else {
      const span = document.createElement('span');
      span.dataset.kind = kind;
      if (kind !== 'stdout') span.className = kind;
      span.textContent = text;
      this.el.appendChild(span);
    }
    this.size += text.length;
    if (this.size > MAX_CHARS) this.trim();
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }

  /** Служебное сообщение IDE — всегда с новой строки. */
  line(text, kind = 'info') {
    const content = this.el.textContent;
    if (content && !content.endsWith('\n')) this.write('\n', 'stdout');
    this.write(text + '\n', kind);
  }

  info(text) {
    this.line(text, 'info');
  }

  error(text) {
    this.line(text, 'stderr');
  }

  trim() {
    while (this.size > MAX_CHARS * 0.7 && this.el.firstChild) {
      this.size -= this.el.firstChild.textContent.length;
      this.el.removeChild(this.el.firstChild);
    }
  }
}
