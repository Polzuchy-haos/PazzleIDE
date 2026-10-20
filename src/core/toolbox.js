// Палитра блоков (toolbox) в стиле Scratch. Только то, что есть в PVM HLC:
// 16-битные целые, без строк, списков и ввода. Категория «PVM» (порты, svc,
// биты, память) добавляется из languages/pvm.json.
const num = (n) => ({shadow: {type: 'math_number', fields: {NUM: n}}});

export const BASE_CATEGORIES = [
  {
    kind: 'category',
    name: 'Логика',
    categorystyle: 'logic_category',
    contents: [
      {kind: 'block', type: 'controls_if'},
      {kind: 'block', type: 'controls_if', extraState: {hasElse: true}},
      {kind: 'block', type: 'logic_compare'},
      {kind: 'block', type: 'logic_operation'},
      {kind: 'block', type: 'logic_negate'},
      {kind: 'block', type: 'logic_boolean'},
      {kind: 'block', type: 'logic_ternary'},
    ],
  },
  {
    kind: 'category',
    name: 'Циклы',
    categorystyle: 'loop_category',
    contents: [
      {kind: 'block', type: 'controls_repeat_ext', inputs: {TIMES: num(10)}},
      {kind: 'block', type: 'controls_whileUntil'},
      {kind: 'block', type: 'controls_for', inputs: {FROM: num(1), TO: num(10), BY: num(1)}},
    ],
  },
  {
    kind: 'category',
    name: 'Математика',
    categorystyle: 'math_category',
    contents: [
      {kind: 'block', type: 'math_number', fields: {NUM: 0}},
      {kind: 'block', type: 'math_arithmetic', inputs: {A: num(1), B: num(1)}},
      {kind: 'block', type: 'math_single', inputs: {NUM: num(9)}},
      {kind: 'block', type: 'math_modulo', inputs: {DIVIDEND: num(64), DIVISOR: num(10)}},
      {kind: 'block', type: 'math_number_property', inputs: {NUMBER_TO_CHECK: num(0)}},
      {kind: 'block', type: 'math_constrain', inputs: {VALUE: num(50), LOW: num(1), HIGH: num(100)}},
      {kind: 'block', type: 'math_random_int', inputs: {FROM: num(1), TO: num(100)}},
    ],
  },
  {
    kind: 'category',
    name: 'Вывод',
    categorystyle: 'io_category',
    contents: [{kind: 'block', type: 'text_print', inputs: {TEXT: num(42)}}],
  },
  {kind: 'sep'},
  {kind: 'category', name: 'Переменные', categorystyle: 'variable_category', custom: 'VARIABLE'},
  {kind: 'category', name: 'Функции', categorystyle: 'procedure_category', custom: 'PROCEDURE'},
  {
    kind: 'category',
    name: 'Код',
    categorystyle: 'code_category',
    contents: [
      {kind: 'block', type: 'vide_comment'},
      {kind: 'block', type: 'vide_raw_code'},
      {kind: 'block', type: 'vide_raw_expr'},
    ],
  },
];

/** Палитра: базовые категории + категории из описания языка. */
export function buildToolbox(language) {
  const extra = language?.pack?.toolbox || [];
  return {kind: 'categoryToolbox', contents: [...BASE_CATEGORIES, ...extra]};
}
