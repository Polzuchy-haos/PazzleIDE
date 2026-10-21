// Генерирует примеры проектов PVM в examples/*.pzl (они же — эталоны для тестов).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- маленький DSL для описания блоков ----
const n = (v) => ({block: {type: 'math_number', fields: {NUM: v}}});
const get = (id) => ({block: {type: 'variables_get', fields: {VAR: {id}}}});
const val = (block) => ({block});
const set = (id, value) => ({type: 'variables_set', fields: {VAR: {id}}, inputs: {VALUE: value}});
const change = (id, delta) => ({type: 'math_change', fields: {VAR: {id}}, inputs: {DELTA: delta}});
const print = (v) => ({type: 'text_print', inputs: {TEXT: v}});
const arith = (op, a, b) => val({type: 'math_arithmetic', fields: {OP: op}, inputs: {A: a, B: b}});
const cmp = (op, a, b) => val({type: 'logic_compare', fields: {OP: op}, inputs: {A: a, B: b}});
const bits = (op, a, b) => val({type: 'pvm_bit_op', fields: {OP: op}, inputs: {A: a, B: b}});
const portGet = (name = 'LED', addr = '0x4000') => val({type: 'pvm_port_get', fields: {NAME: name, ADDR: addr}});
const portSet = (value, name = 'LED', addr = '0x4000') => ({type: 'pvm_port_set', fields: {NAME: name, ADDR: addr}, inputs: {VALUE: value}});
const pause = (ticks) => ({type: 'pvm_delay', inputs: {TICKS: ticks}});
const section = (kind, size) => ({type: 'pvm_section', fields: {KIND: kind, SIZE: size}});
const comment = (text) => ({type: 'pazzle_comment', fields: {TEXT: text}});
const constDef = (name, value) => ({type: 'pvm_const_define', fields: {NAME: name}, inputs: {VALUE: value}});
const constGet = (name) => val({type: 'pvm_const_get', fields: {NAME: name}});

function seq(...blocks) {
  const list = blocks.flat().filter(Boolean);
  for (let i = list.length - 2; i >= 0; i--) list[i] = {...list[i], next: {block: list[i + 1]}};
  return list[0];
}
const stmt = (...blocks) => ({block: seq(...blocks)});
// Главная стопка программы — между «▶ начало программы» и «■ конец программы».
const start = (...blocks) => ({type: 'pvm_start', next: {block: seq(...blocks, {type: 'pvm_end'})}});
const repeat = (times, body) => ({type: 'controls_repeat_ext', inputs: {TIMES: times, DO: stmt(...body)}});
const forRange = (id, from, to, body) => ({
  type: 'controls_for',
  fields: {VAR: {id}},
  inputs: {FROM: from, TO: to, BY: n(1), DO: stmt(...body)},
});
const ifThen = (cond, body) => ({type: 'controls_if', inputs: {IF0: cond, DO0: stmt(...body)}});
const call = (name, params, args) =>
  val({
    type: 'procedures_callreturn',
    extraState: {name, params},
    inputs: Object.fromEntries(args.map((a, i) => ['ARG' + i, a])),
  });

function project(title, description, vars, topBlocks) {
  return {
    format: 'pazzleide-project',
    version: 1,
    language: 'pvm',
    title,
    description,
    workspace: {
      blocks: {languageVersion: 0, blocks: topBlocks.map((b, i) => ({...b, x: 40, y: 40 + i * 440}))},
      variables: vars.map(([id, name]) => ({id, name})),
    },
  };
}

const examples = {};

examples['01-migalka'] = project(
  'Мигание светодиодом',
  'Переключает бит порта LED (0x4000) и считает переключения. Работает и в симуляторе, и на плате.',
  [['count', 'переключений']],
  [
    start(
      comment('Мигаем светодиодом 6 раз'),
      section('ram', 64),
      set('count', n(0)),
      repeat(n(6), [
        portSet(bits('XOR', portGet(), n(1))),
        change('count', n(1)),
        pause(n(100)),
      ]),
      portSet(n(0)),
    ),
  ],
);

examples['02-faktorial'] = project(
  'Функции: факториал',
  'Рекурсивная функция. Результат 7! = 5040 — в переменной «результат» (панель «Отладка»).',
  [['n', 'n'], ['result', 'результат']],
  [
    {
      type: 'procedures_defreturn',
      fields: {NAME: 'факториал'},
      extraState: {params: [{name: 'n', id: 'n'}]},
      inputs: {
        STACK: stmt({
          type: 'procedures_ifreturn',
          extraState: '<mutation value="1"></mutation>',
          inputs: {CONDITION: cmp('LTE', get('n'), n(1)), VALUE: n(1)},
        }),
        RETURN: arith('MULTIPLY', get('n'), call('факториал', ['n'], [arith('MINUS', get('n'), n(1))])),
      },
    },
    start(set('result', call('факториал', ['n'], [n(7)])), print(get('result'))),
  ],
);

examples['03-prostye-chisla'] = project(
  'Простые числа до 50',
  'Считает простые числа от 2 до 50: сколько их и какое последнее. Ответ: 15 и 47.',
  [['i', 'i'], ['count', 'сколько'], ['last', 'последнее']],
  [
    start(
      set('count', n(0)),
      set('last', n(0)),
      forRange('i', n(2), n(50), [
        ifThen(val({type: 'math_number_property', fields: {PROPERTY: 'PRIME'}, inputs: {NUMBER_TO_CHECK: get('i')}}), [
          change('count', n(1)),
          set('last', get('i')),
        ]),
      ]),
      print(get('count')),
    ),
  ],
);

examples['04-begushchiy-ogon'] = project(
  'Бегущий огонь (биты)',
  'Сдвигает единичный бит по 8 разрядам порта LED: 1, 2, 4 … 128.',
  [['bit', 'бит']],
  [
    start(
      set('bit', n(1)),
      repeat(n(8), [portSet(get('bit')), set('bit', bits('SHL', get('bit'), n(1))), pause(n(50))]),
      portSet(n(0)),
    ),
  ],
);

examples['05-konstanty'] = project(
  'Константы',
  'Именованные константы: число мигания, пауза, маска бита и константа, вычисленная из другой. В RAM они не попадают.',
  [['count', 'счёт']],
  [
    start(
      comment('Константы вычисляет компилятор, их можно использовать как обычные числа'),
      constDef('МИГАНИЙ', n(4)),
      constDef('ПАУЗА', n(50)),
      constDef('МАСКА', bits('SHL', n(1), n(2))),
      constDef('ИТОГ', arith('MULTIPLY', constGet('МИГАНИЙ'), n(2))),
      set('count', n(0)),
      repeat(constGet('МИГАНИЙ'), [
        portSet(bits('XOR', portGet(), constGet('МАСКА'))),
        change('count', n(1)),
        pause(constGet('ПАУЗА')),
      ]),
      print(constGet('ИТОГ')),
    ),
  ],
);

examples['06-lokalnye-peremennye'] = project(
  'Локальные переменные',
  'Числа Фибоначчи рекурсией: у каждого вызова свои «левое» и «правое». С глобальными переменными вложенный вызов затёр бы их. Ответ: 55.',
  [['n', 'n'], ['left', 'левое'], ['right', 'правое'], ['answer', 'ответ']],
  [
    {
      type: 'procedures_defreturn',
      fields: {NAME: 'фибоначчи'},
      extraState: {params: [{name: 'n', id: 'n'}]},
      inputs: {
        STACK: stmt(
          {
            type: 'procedures_ifreturn',
            extraState: '<mutation value="1"></mutation>',
            inputs: {CONDITION: cmp('LTE', get('n'), n(1)), VALUE: get('n')},
          },
          {type: 'pvm_local', fields: {VAR: {id: 'left'}}, inputs: {VALUE: call('фибоначчи', ['n'], [arith('MINUS', get('n'), n(1))])}},
          {type: 'pvm_local', fields: {VAR: {id: 'right'}}, inputs: {VALUE: call('фибоначчи', ['n'], [arith('MINUS', get('n'), n(2))])}},
        ),
        RETURN: arith('ADD', get('left'), get('right')),
      },
    },
    start(set('answer', call('фибоначчи', ['n'], [n(10)])), print(get('answer'))),
  ],
);

const dir = path.join(root, 'examples');
fs.mkdirSync(dir, {recursive: true});
for (const f of fs.readdirSync(dir)) if (f.endsWith('.pzl')) fs.rmSync(path.join(dir, f));
for (const [name, data] of Object.entries(examples)) {
  fs.writeFileSync(path.join(dir, name + '.pzl'), JSON.stringify(data, null, 2) + '\n');
}
console.log(`Создано примеров: ${Object.keys(examples).length}`);
