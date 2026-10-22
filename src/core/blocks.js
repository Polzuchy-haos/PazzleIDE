// Собственные блоки PazzleIDE (в дополнение к стандартным блокам Blockly).
import * as Blockly from 'blockly';

export const CUSTOM_BLOCKS = [
  {
    type: 'pazzle_comment',
    message0: '💬 %1',
    args0: [{type: 'field_input', name: 'TEXT', text: 'комментарий'}],
    previousStatement: null,
    nextStatement: null,
    colour: '#8c8c8c',
    tooltip: 'Комментарий в сгенерированном коде',
  },
  {
    type: 'pazzle_raw_code',
    message0: 'код %1',
    args0: [{type: 'field_input', name: 'CODE', text: ''}],
    previousStatement: null,
    nextStatement: null,
    colour: '#5b5b5b',
    tooltip: 'Строка кода, вставляемая без изменений (для выбранного языка)',
  },
  {
    type: 'pazzle_raw_expr',
    message0: 'выражение %1',
    args0: [{type: 'field_input', name: 'CODE', text: '0'}],
    output: null,
    colour: '#5b5b5b',
    tooltip: 'Выражение, вставляемое в код без изменений',
  },
];

// ---- переменное число аргументов (svc): кнопки «−» и «+» на самом блоке, как в Scratch ----

export const VARIADIC_MAX_ARGS = 8;
const VARIADIC_DEFAULT_ARGS = 2;

const icon = (path) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
      `<circle cx="8" cy="8" r="7.5" fill="#fff" fill-opacity="0.35"/>` +
      `<path d="${path}" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`,
  );
const PLUS_ICON = icon('M8 4.5v7M4.5 8h7');
const MINUS_ICON = icon('M4.5 8h7');

/**
 * Входы ARG0..ARGn-1 (числа) и кнопки «−»/«+» в конце блока. Число аргументов
 * хранится в extraState: {args: n}. Пустой вход генератор заменяет нулём.
 */
const VARIADIC_MIXIN = {
  argCount_: 0,

  saveExtraState() {
    return {args: this.argCount_};
  },

  loadExtraState(state) {
    this.setArgCount_(Number(state?.args) || 0);
  },

  // Буфер обмена и старые форматы Blockly ещё пользуются XML.
  mutationToDom() {
    const m = Blockly.utils.xml.createElement('mutation');
    m.setAttribute('args', String(this.argCount_));
    return m;
  },

  domToMutation(xml) {
    this.setArgCount_(Number(xml.getAttribute('args')) || 0);
  },

  setArgCount_(count) {
    const n = Math.max(0, Math.min(VARIADIC_MAX_ARGS, count));
    if (this.getInput('BUTTONS')) this.removeInput('BUTTONS');
    for (let i = this.argCount_; i < n; i++) {
      const input = this.appendValueInput('ARG' + i).setCheck('Number');
      if (i === 0) input.appendField('аргументы');
    }
    for (let i = this.argCount_ - 1; i >= n; i--) this.removeInput('ARG' + i);
    this.argCount_ = n;
    const buttons = this.appendDummyInput('BUTTONS');
    const click = (delta) => (field) => field.getSourceBlock()?.changeArgCount_(delta);
    if (n > 0) buttons.appendField(new Blockly.FieldImage(MINUS_ICON, 18, 18, '−', click(-1)), 'MINUS');
    if (n < VARIADIC_MAX_ARGS) buttons.appendField(new Blockly.FieldImage(PLUS_ICON, 18, 18, '+', click(1)), 'PLUS');
  },

  /** Щелчок по «−»/«+»: одно действие для «Отменить», вместе с отцеплённым блоком последнего входа. */
  changeArgCount_(delta) {
    if (this.isInFlyout || this.isDeadOrDying?.()) return;
    const ownGroup = !Blockly.Events.getGroup();
    if (ownGroup) Blockly.Events.setGroup(true);
    try {
      const before = Blockly.Events.BlockChange.getExtraBlockState_(this);
      this.setArgCount_(this.argCount_ + delta);
      const after = Blockly.Events.BlockChange.getExtraBlockState_(this);
      if (before !== after) Blockly.Events.fire(new (Blockly.Events.get(Blockly.Events.BLOCK_CHANGE))(this, 'mutation', null, before, after));
    } finally {
      if (ownGroup) Blockly.Events.setGroup(false);
    }
  },
};

function registerVariadicMutator() {
  if (Blockly.Extensions.isRegistered('pazzle_variadic_args')) return;
  Blockly.Extensions.registerMutator('pazzle_variadic_args', VARIADIC_MIXIN, function () {
    // Новый блок без сохранённого состояния — два аргумента; extraState потом заменит это число.
    this.setArgCount_(VARIADIC_DEFAULT_ARGS);
  });
}

const registered = new Set();

/** Регистрирует JSON-описания блоков (повторная регистрация игнорируется). */
export function defineBlocks(defs) {
  const fresh = defs.filter((d) => d && d.type && !registered.has(d.type));
  fresh.forEach((d) => registered.add(d.type));
  if (fresh.length) Blockly.common.defineBlocksWithJsonArray(fresh);
}

export function installCustomBlocks() {
  registerVariadicMutator();
  defineBlocks(CUSTOM_BLOCKS);
}
