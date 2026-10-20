// Настройки пользователя: <userData>/settings.json
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  theme: 'dark', // dark | light
  renderer: 'zelos', // zelos (как Scratch) | geras | thrasos
  fontSize: 14,
  pvmTools: '', // папка с pvmcc, pvmc, pvmsim, pvmdbg (пусто — искать автоматически)
  target: 'sim', // sim | board-host | board-flash
  port: 'COM3',
  baud: 9600,
  rawOutput: false, // не фильтровать вывод симулятора (показывать трассировку)
  window: {width: 1440, height: 900, maximized: false},
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {...this.data, ...saved, window: {...DEFAULTS.window, ...(saved.window || {})}};
    } catch {
      // Первый запуск или повреждённый файл — используем значения по умолчанию.
    }
  }

  get() {
    return structuredClone(this.data);
  }

  set(patch) {
    this.data = {...this.data, ...patch};
    try {
      fs.mkdirSync(path.dirname(this.file), {recursive: true});
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('Не удалось сохранить настройки:', e);
    }
    return this.get();
  }
}

module.exports = {Settings, DEFAULTS};
