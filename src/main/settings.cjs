// Настройки пользователя: <userData>/settings.json
'use strict';
const fs = require('fs');
const path = require('path');
const {normalizeTargets, applyFactoryLimits} = require('./targets.cjs');

const DEFAULTS = {
  theme: 'dark', // dark | light
  renderer: 'zelos', // zelos (как Scratch) | geras | thrasos
  fontSize: 14,
  pvmTools: '', // папка с pvmcc, pvmc, pvmsim, pvmdbg (пусто — искать автоматически)
  target: 'sim', // id текущей цели
  targets: null, // список целей (src/main/targets.cjs); null — встроенные
  limitsVersion: 1, // 1 — у встроенных целей заводские ограничения памяти (см. applyFactoryLimits)
  port: 'COM3', // порт и скорость для новых целей
  baud: 9600,
  rawOutput: false, // не фильтровать вывод симулятора (показывать трассировку)
  layout: 'blocks', // рабочий стол: blocks (пазлы) | hlc | ide
  folder: '', // папка рабочего стола «IDE»
  window: {width: 1440, height: 900, maximized: false},
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = structuredClone(DEFAULTS);
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {...this.data, ...saved, window: {...DEFAULTS.window, ...(saved.window || {})}};
    } catch {
      // Первый запуск или повреждённый файл — используем значения по умолчанию.
    }
    this.data.targets = normalizeTargets(this.data.targets, this.data);
    if (saved && !(saved.limitsVersion >= 1)) {
      this.data.targets = applyFactoryLimits(this.data.targets);
      this.data.limitsVersion = 1;
    }
    if (!this.data.targets.some((t) => t.id === this.data.target)) this.data.target = this.data.targets[0].id;
  }

  /** Текущая цель. */
  target() {
    return structuredClone(this.data.targets.find((t) => t.id === this.data.target) || this.data.targets[0]);
  }

  get() {
    return structuredClone(this.data);
  }

  set(patch) {
    this.data = {...this.data, ...patch};
    if ('targets' in patch) this.data.targets = normalizeTargets(this.data.targets, this.data);
    if (!this.data.targets.some((t) => t.id === this.data.target)) this.data.target = this.data.targets[0].id;
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
