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

const registered = new Set();

/** Регистрирует JSON-описания блоков (повторная регистрация игнорируется). */
export function defineBlocks(defs) {
  const fresh = defs.filter((d) => d && d.type && !registered.has(d.type));
  fresh.forEach((d) => registered.add(d.type));
  if (fresh.length) Blockly.common.defineBlocksWithJsonArray(fresh);
}

export function installCustomBlocks() {
  defineBlocks(CUSTOM_BLOCKS);
}
