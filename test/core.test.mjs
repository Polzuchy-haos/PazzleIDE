// Модульные тесты: транслитерация, вывод типов, шаблонный движок, язык PVM HLC, разбор артефактов pvmc.
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Blockly from 'blockly';
import {
  createLanguage,
  generateCode,
  buildToolbox,
  inferTypes,
  transliterate,
  toIdentifier,
  validatePack,
  extractBlockMarkers,
  parseProject,
  library,
} from '../src/core/index.js';

const require = createRequire(import.meta.url);
const {SourceMap, parseListing} = require('../src/main/pvm/artifacts.cjs');
const {createLineFilter} = require('../src/main/runner.cjs');
const {parseErrors, applyLimits} = require('../src/main/pvm/build.cjs');
const targets = require('../src/main/targets.cjs');
const {HostCliDriver} = require('../src/main/pvm/debug.cjs');

const root = path.resolve(import.meta.dirname, '..');
const pvm = createLanguage(JSON.parse(fs.readFileSync(path.join(root, 'languages', 'pvm.json'), 'utf8')));

function load(json) {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(json, ws);
  return ws;
}

describe('транслитерация', () => {
  test('кириллица -> латиница', () => {
    assert.equal(transliterate('Счётчик'), 'Schyotchik');
    assert.equal(transliterate('ЗАДЕРЖКА'), 'ZADERZHKA');
    assert.equal(toIdentifier('МАКС скорость'), 'MAKS_skorost');
    assert.equal(toIdentifier('моя переменная'), 'moya_peremennaya');
    assert.equal(toIdentifier('1-й шаг'), 'v_1_y_shag');
  });
});

describe('вывод типов', () => {
  test('тип распространяется через присваивания', () => {
    const ws = load({
      variables: [{id: 'a', name: 'a'}, {id: 'b', name: 'b'}],
      blocks: {
        blocks: [
          {
            type: 'variables_set',
            fields: {VAR: {id: 'a'}},
            inputs: {VALUE: {block: {type: 'logic_boolean'}}},
            next: {block: {type: 'variables_set', fields: {VAR: {id: 'b'}}, inputs: {VALUE: {block: {type: 'variables_get', fields: {VAR: {id: 'a'}}}}}}},
          },
        ],
      },
    });
    const types = inferTypes(ws);
    assert.equal(types.varType('a'), 'Boolean');
    assert.equal(types.varType('b'), 'Boolean');
  });
});

describe('шаблонный движок', () => {
  const pack = {
    id: 'mini',
    name: 'Mini',
    blocks: {
      text_print: {switchType: 'TEXT', cases: {Number: 'say {{TEXT}}'}},
      math_number: '{{NUM|int}}',
      math_arithmetic: {
        switch: 'OP',
        cases: {ADD: {template: '{{A}} + {{B}}', order: 2}, MULTIPLY: {template: '{{A}} * {{B}}', order: 1}},
      },
      controls_if: {if: 'if {{IF}} {\n{{DO}}}', else: ' else {\n{{DO}}}'},
      logic_boolean: {switch: 'BOOL', cases: {TRUE: 'yes', FALSE: 'no'}},
    },
    program: '>>\n{{BODY}}<<',
  };

  test('валидация', () => {
    assert.deepEqual(validatePack(pack), []);
    assert.ok(validatePack({name: 'x'}).length >= 2);
  });

  test('switch, switchType, фильтры, приоритеты, if/else и таблица строк', () => {
    const lang = createLanguage(pack);
    const ws = load({
      blocks: {
        blocks: [
          {
            type: 'controls_if',
            id: 'IF',
            extraState: {hasElse: true},
            inputs: {
              IF0: {block: {type: 'logic_boolean', fields: {BOOL: 'TRUE'}}},
              DO0: {block: {type: 'text_print', id: 'P1', inputs: {TEXT: {block: {type: 'math_number', fields: {NUM: 2.7}}}}}},
              ELSE: {
                block: {
                  type: 'text_print',
                  id: 'P2',
                  inputs: {
                    TEXT: {
                      block: {
                        type: 'math_arithmetic',
                        fields: {OP: 'MULTIPLY'},
                        inputs: {
                          A: {block: {type: 'math_arithmetic', fields: {OP: 'ADD'}, inputs: {A: {block: {type: 'math_number', fields: {NUM: 1}}}, B: {block: {type: 'math_number', fields: {NUM: 2}}}}}},
                          B: {block: {type: 'math_number', fields: {NUM: 3}}},
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });
    const r = generateCode(lang, ws);
    assert.deepEqual(r.unsupported, []);
    assert.equal(r.code, '>>\nif yes {\n    say 2\n} else {\n    say (1 + 2) * 3\n}\n<<\n');
    assert.deepEqual(r.lineBlocks, {2: 'IF', 3: 'P1', 5: 'P2'});
  });

  test('неподдерживаемый блок не ломает генерацию', () => {
    const r = generateCode(createLanguage(pack), load({blocks: {blocks: [{type: 'controls_whileUntil'}]}}));
    assert.deepEqual(r.unsupported, ['controls_whileUntil']);
  });

  test('маркеры блоков вырезаются, пустые строки схлопываются', () => {
    const r = extractBlockMarkers("a\n@@PAZZLE_BLOCK@@'X'\n  b\n\n\n\nc  \n");
    assert.equal(r.code, 'a\n  b\n\nc\n');
    assert.deepEqual(r.lineBlocks, {2: 'X'});
  });
});

describe('язык PVM HLC', () => {
  test('все блоки палитры переводятся в HLC', () => {
    const blocks = [];
    for (const cat of buildToolbox(pvm).contents) {
      for (const item of cat.contents || []) {
        if (item.kind === 'block') blocks.push({type: item.type, fields: item.fields, inputs: item.inputs, extraState: item.extraState});
      }
    }
    const r = generateCode(pvm, load({blocks: {blocks: blocks.map((b, i) => ({...b, x: 0, y: i * 80}))}}));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.unsupported, []);
    assert.match(r.code, /void main\(\) \{/);
  });

  test('порт, section и svc', () => {
    const ws = load({
      blocks: {
        blocks: [
          {
            type: 'pvm_section',
            fields: {KIND: 'ram', SIZE: 32},
            next: {
              block: {
                type: 'pvm_port_set',
                fields: {NAME: 'LED', ADDR: '0x4000'},
                inputs: {VALUE: {block: {type: 'pvm_svc_value', fields: {N: 2}, extraState: {args: 2}, inputs: {ARG0: {block: {type: 'math_number', fields: {NUM: 3}}}, ARG1: {block: {type: 'math_number', fields: {NUM: 4}}}}}}},
              },
            },
          },
        ],
      },
    });
    const {code} = generateCode(pvm, ws);
    assert.match(code, /section ram 32;/);
    assert.match(code, /volatile int LED @ 0x4000;/);
    assert.match(code, /LED = svc\(2, 3, 4\);/);
  });

  test('svc: любое число аргументов, пустой — 0', () => {
    const n = (v) => ({block: {type: 'math_number', fields: {NUM: v}}});
    const svc = (args, inputs, next) => ({type: 'pvm_svc', fields: {N: 5}, extraState: {args}, inputs, ...(next ? {next: {block: next}} : {})});
    const ws = load({blocks: {blocks: [svc(0, {}, svc(4, {ARG0: n(1), ARG1: n(2), ARG3: n(4)}))]}});
    const {code} = generateCode(pvm, ws);
    assert.match(code, /svc\(5\);\n\s*svc\(5, 1, 2, 0, 4\);/);
    const block = ws.getTopBlocks()[0].getNextBlock();
    assert.deepEqual(block.saveExtraState(), {args: 4});
    assert.ok(block.getInput('ARG3') && !block.getInput('ARG4'));
  });

  test('svc из старого проекта (входы A и B) открывается с теми же аргументами', () => {
    const n = (v) => ({block: {type: 'math_number', fields: {NUM: v}}});
    const old = (inputs) => ({type: 'pvm_svc', fields: {N: 1}, inputs});
    const project = parseProject({
      format: 'pazzleide-project',
      version: 1,
      workspace: {blocks: {blocks: [{...old({A: n(7)}), next: {block: {...old({B: n(9)}), next: {block: old({})}}}}]}},
    });
    const ws = load(project.workspace);
    const lines = generateCode(pvm, ws).code.split('\n').map((l) => l.trim());
    assert.ok(lines.includes('svc(1, 7);'));
    assert.ok(lines.includes('svc(1, 0, 9);'));
    assert.ok(lines.includes('svc(1);'));
  });

  test('проект, сохранённый до переименования (VisualIDE), открывается', () => {
    const legacy = {
      format: 'visualide-project',
      version: 1,
      workspace: {blocks: {blocks: [{type: 'vide_comment', fields: {TEXT: 'x'}, next: {block: {type: 'vide_raw_code', fields: {CODE: 'halt;'}}}}]}},
    };
    const project = parseProject(JSON.stringify(legacy));
    assert.equal(project.format, 'pazzleide-project');
    const {code} = generateCode(pvm, load(project.workspace));
    assert.match(code, /\/\/ x\n\s*halt;/);
  });

  test('константы: объявляются до портов и функций, имя не конфликтует с переменной', () => {
    const num = (v) => ({block: {type: 'math_number', fields: {NUM: v}}});
    const get = (name) => ({block: {type: 'pvm_const_get', fields: {NAME: name}}});
    const ws = load({
      variables: [{id: 'v', name: 'шаг'}],
      blocks: {
        blocks: [
          {type: 'pvm_port_set', fields: {NAME: 'LED', ADDR: '0x4000'}, inputs: {VALUE: get('шаг')}, next: {block: {type: 'variables_set', fields: {VAR: {id: 'v'}}, inputs: {VALUE: get('двойной шаг')}}}},
          {
            type: 'pvm_const_define',
            y: 300,
            fields: {NAME: 'шаг'},
            inputs: {VALUE: num(5)},
            next: {block: {type: 'pvm_const_define', fields: {NAME: 'двойной шаг'}, inputs: {VALUE: {block: {type: 'math_arithmetic', fields: {OP: 'MULTIPLY'}, inputs: {A: get('шаг'), B: num(2)}}}}}},
          },
        ],
      },
    });
    const {code, unsupported} = generateCode(pvm, ws);
    assert.deepEqual(unsupported, []);
    const constA = code.indexOf('const int ');
    assert.ok(constA >= 0 && constA < code.indexOf('volatile int LED'), 'константы выше портов');
    const constName = /const int (\w+) = 5;/.exec(code)[1];
    assert.match(code, new RegExp(`const int dvoynoy_shag = ${constName} \\* 2;`));
    assert.match(code, new RegExp(`LED = ${constName};`));
    const varName = /^int (shag\w*);/m.exec(code)[1]; // переменная «шаг» получила своё имя
    assert.notEqual(constName, varName);
    assert.match(code, new RegExp(`${varName} = dvoynoy_shag;`));
  });

  test('блок «начало программы»: в main только его стопка, объявления — отовсюду', () => {
    const num = (v) => ({block: {type: 'math_number', fields: {NUM: v}}});
    const assign = (v) => ({type: 'variables_set', fields: {VAR: {id: 'x'}}, inputs: {VALUE: num(v)}});
    const ws = load({
      variables: [{id: 'x', name: 'x'}],
      blocks: {
        blocks: [
          {...assign(99), id: 'LOOSE'},
          {type: 'pvm_start', id: 'S1', y: 100, next: {block: {...assign(1), next: {block: {type: 'pvm_halt'}}}}},
          {type: 'pvm_const_define', y: 300, fields: {NAME: 'K'}, inputs: {VALUE: num(5)}},
          {type: 'pazzle_comment', y: 400, fields: {TEXT: 'комментарий'}},
          {type: 'pvm_start', id: 'S2', y: 500, next: {block: assign(2)}},
        ],
      },
    });
    const r = generateCode(pvm, ws);
    assert.match(r.code, /void main\(\) \{\n {4}x = 1;\n {4}halt;\n\}/);
    assert.doesNotMatch(r.code, /x = 99|x = 2/);
    assert.match(r.code, /const int K = 5;/);
    assert.deepEqual(r.detached, ['LOOSE']); // стопка из одного комментария — не в счёт
    assert.deepEqual(r.extraEntries, ['S2']);
  });

  test('локальные переменные функции: объявление в начале тела, не в глобальных', () => {
    const num = (v) => ({block: {type: 'math_number', fields: {NUM: v}}});
    const get = (id) => ({block: {type: 'variables_get', fields: {VAR: {id}}}});
    const ws = load({
      variables: [{id: 's', name: 'сумма'}, {id: 'g', name: 'g'}, {id: 'k', name: 'k'}],
      blocks: {
        blocks: [
          {
            type: 'procedures_defreturn',
            fields: {NAME: 'f'},
            inputs: {
              STACK: {
                block: {
                  type: 'pvm_local',
                  fields: {VAR: {id: 's'}},
                  inputs: {VALUE: num(0)},
                  next: {block: {type: 'controls_repeat_ext', inputs: {TIMES: num(3), DO: {block: {type: 'math_change', fields: {VAR: {id: 's'}}, inputs: {DELTA: num(2)}}}}, next: {block: {type: 'pvm_local', fields: {VAR: {id: 'k'}}}}}},
                },
              },
              RETURN: get('s'),
            },
          },
          {type: 'pvm_start', y: 300, next: {block: {type: 'variables_set', fields: {VAR: {id: 'g'}}, inputs: {VALUE: {block: {type: 'procedures_callreturn', extraState: {name: 'f', params: []}}}}, next: {block: {type: 'pvm_local', id: 'MIS', fields: {VAR: {id: 'k'}}, inputs: {VALUE: num(1)}}}}}},
        ],
      },
    });
    const r = generateCode(pvm, ws);
    // Тело функции начинается с объявлений: summa, k и счётчик цикла — все локальные.
    assert.match(r.code, /int f\(\) \{\n {4}int summa;\n {4}int k;\n {4}int count;\n {4}summa = 0;/);
    assert.doesNotMatch(r.code, /^int summa;/m, '«сумма» используется только в f — глобальной не нужна');
    assert.match(r.code, /^int g;/m);
    assert.match(r.code, /^int k;/m, 'k используется и в main — остаётся глобальной');
    assert.doesNotMatch(r.code, /^int count;/m);
    assert.deepEqual(r.misplacedLocals, ['MIS']);
    assert.match(r.code, /void main\(\) \{\n {4}g = f\(\);\n {4}k = 1;/);
  });

  test('блок «конец программы» — halt; в конце main', () => {
    const ws = load({
      variables: [{id: 'x', name: 'x'}],
      blocks: {
        blocks: [
          {
            type: 'pvm_start',
            next: {block: {type: 'variables_set', fields: {VAR: {id: 'x'}}, inputs: {VALUE: {block: {type: 'math_number', fields: {NUM: 1}}}}, next: {block: {type: 'pvm_end', id: 'END'}}}},
          },
        ],
      },
    });
    const r = generateCode(pvm, ws);
    assert.match(r.code, /void main\(\) \{\n {4}x = 1;\n {4}halt;\n\}/);
    assert.ok(Object.values(r.lineBlocks).includes('END'), 'на блок конца можно поставить точку останова');
    assert.equal(ws.getBlockById('END').nextConnection, null, 'ниже «конца» ничего не присоединить');
  });

  test('без блока «начало программы» выполняются все стопки (старые проекты)', () => {
    const ws = load({
      variables: [{id: 'x', name: 'x'}],
      blocks: {blocks: [{type: 'variables_set', fields: {VAR: {id: 'x'}}, inputs: {VALUE: {block: {type: 'math_number', fields: {NUM: 3}}}}}]},
    });
    const r = generateCode(pvm, ws);
    assert.match(r.code, /x = 3;/);
    assert.deepEqual(r.detached, []);
  });

  test('имена: HLC -> блоки', () => {
    const ws = load({variables: [{id: 'v', name: 'счёт'}], blocks: {blocks: [{type: 'math_change', fields: {VAR: {id: 'v'}}}]}});
    assert.deepEqual(generateCode(pvm, ws).names, {schyot: 'счёт'});
  });
});

describe('библиотеки пазлов', () => {
  const n = (v) => ({block: {type: 'math_number', fields: {NUM: v}}});
  // Функция «удвоить» вызывает «сложить» и использует константу ШАГ; переменная x — параметр.
  const source = () =>
    load({
      variables: [{id: 'vx', name: 'x'}, {id: 'va', name: 'a'}, {id: 'vb', name: 'b'}],
      blocks: {
        blocks: [
          {type: 'pvm_const_define', fields: {NAME: 'ШАГ'}, inputs: {VALUE: n(2)}},
          {
            type: 'procedures_defreturn',
            fields: {NAME: 'сложить'},
            extraState: {params: [{name: 'a', id: 'va'}, {name: 'b', id: 'vb'}]},
            inputs: {RETURN: {block: {type: 'math_arithmetic', fields: {OP: 'ADD'}, inputs: {A: {block: {type: 'variables_get', fields: {VAR: {id: 'va'}}}}, B: {block: {type: 'variables_get', fields: {VAR: {id: 'vb'}}}}}}}},
          },
          {
            type: 'procedures_defreturn',
            fields: {NAME: 'удвоить'},
            extraState: {params: [{name: 'x', id: 'vx'}]},
            inputs: {
              RETURN: {
                block: {
                  type: 'procedures_callreturn',
                  extraState: {name: 'сложить', params: ['a', 'b']},
                  inputs: {ARG0: {block: {type: 'variables_get', fields: {VAR: {id: 'vx'}}}}, ARG1: {block: {type: 'pvm_const_get', fields: {NAME: 'ШАГ'}}}},
                },
              },
            },
          },
        ],
      },
    });

  test('функция сохраняется вместе с вызываемыми функциями и константами, без id', () => {
    const ws = source();
    const def = ws.getTopBlocks(false).find((b) => b.getFieldValue('NAME') === 'удвоить');
    const items = library.collectItems(ws, def);
    assert.deepEqual(items.map((i) => `${i.kind}:${i.name}`), ['function:удвоить', 'function:сложить', 'constant:ШАГ']);
    const text = JSON.stringify(items);
    assert.ok(!/"id"/.test(text), 'в библиотеке нет id блоков и переменных');
    assert.match(text, /"VAR":\{"name":"x"\}/);
  });

  test('блок из палитры библиотеки подтягивает зависимости в проект', () => {
    const lib = {...library.newLibrary('Математика'), file: 'math.pzlib'};
    lib.items = library.collectItems(source(), source().getTopBlocks(false).find((b) => b.getFieldValue('NAME') === 'удвоить'));
    const ws = load({blocks: {blocks: [{type: 'pvm_start'}]}});
    // Как из палитры: вызов «удвоить» с меткой библиотеки.
    const call = library.flyoutBlockFor(lib.items[0], library.libraryData(lib, lib.items[0]));
    const {kind: _kind, ...state} = call;
    ws.getTopBlocks(false)[0].nextConnection.connect(
      Blockly.serialization.blocks.append({type: 'text_print', inputs: {TEXT: {block: state}}}, ws).previousConnection,
    );
    const printed = ws.getBlocksByType('text_print', false)[0];
    const wanted = library.libraryDropsIn([printed.getInputTargetBlock('TEXT')]);
    assert.equal(printed.getInputTargetBlock('TEXT').data, null, 'метка снята');
    const plan = library.planImport(ws, [lib], wanted);
    assert.deepEqual(plan.map((p) => p.item.name), ['удвоить', 'сложить', 'ШАГ']);
    library.appendItems(ws, plan.map((p) => p.item));
    const {code} = generateCode(pvm, ws);
    assert.match(code, /const int SHAG = 2;/);
    assert.match(code, /int slozhit\(int a, int b\)/);
    assert.match(code, /return slozhit\(x, SHAG\);/);
    assert.match(code, /OUT = udvoit\(0\);/);
    // Повторно ничего не добавляется: всё уже в проекте.
    assert.equal(library.planImport(ws, [lib], {functions: ['удвоить'], constants: []}).length, 0);
  });

  test('элементы с тем же именем заменяются', () => {
    const lib = library.newLibrary('L');
    const a = library.mergeItems(lib, [{kind: 'function', name: 'f', block: {type: 'x'}}]);
    const b = library.mergeItems(a.library, [{kind: 'function', name: 'f', block: {type: 'y'}}, {kind: 'constant', name: 'f', block: {type: 'z'}}]);
    assert.equal(b.replaced, 1);
    assert.equal(b.added, 1);
    assert.deepEqual(b.library.items.map((i) => i.block.type), ['y', 'z']);
  });
});

describe('цели и ограничения памяти', () => {
  test('ограничения дописываются в конец кода, кроме объявленных в коде', () => {
    const r = applyLimits('section ram 32;\nvoid main() {\n}\n', {code: 4096, ram: 16, stack: 128});
    assert.deepEqual(r.applied, {code: 4096, stack: 128});
    assert.deepEqual(r.own, ['ram']);
    assert.ok(r.code.startsWith('section ram 32;\nvoid main() {\n}\n'), 'строки кода не сдвигаются');
    assert.match(r.code, /section code 4096;\nsection stack 128;\n$/);
    assert.equal(applyLimits('x\n', {}).code, 'x\n');
  });

  test('переменные ${...} и окружение PAZZLE_*', () => {
    const target = targets.normalizeTarget({name: 'Моя плата', mode: 'board-flash', connection: 'tcp', tcp: '10.0.0.5:5555', limits: {ram: '128'}, env: 'FW=${buildDir}/fw'});
    const vars = targets.targetVariables({target, files: {bin: '/p/a.build/main.bin', hex: '/p/a.build/main.hex'}, projectPath: '/p/a.pzl'});
    assert.equal(targets.expandVariables('flash "${hex}" ${tcpHost} ${tcpPort} ${ramSize} ${нет} ${env:PZ_T}', vars, {PZ_T: 'ok'}), 'flash "/p/a.build/main.hex" 10.0.0.5 5555 128 ${нет} ok');
    const env = targets.commandEnv(vars, target.env, {});
    assert.equal(env.PAZZLE_HEX, '/p/a.build/main.hex');
    assert.equal(env.PAZZLE_PROJECT_NAME, 'a');
    assert.equal(env.FW, '/p/a.build/fw');
    assert.deepEqual(targets.pvmdbgLink(target), ['--tcp', '10.0.0.5:5555']);
    assert.deepEqual(targets.splitTcp('5555'), ['127.0.0.1', '5555']);
  });

  test('встроенные цели по умолчанию — с портом и скоростью из старых настроек', () => {
    const list = targets.normalizeTargets(null, {port: 'COM7', baud: 115200});
    assert.deepEqual(list.map((t) => t.id), ['sim', 'board-host', 'board-flash']);
    assert.equal(list[1].port, 'COM7');
    assert.equal(list[1].baud, 115200);
    assert.deepEqual(list[0].limits, {code: 1024, ram: 64, stack: 64}); // заводские значения
    // Встроенные цели из настроек до заводских значений получают их; заданные пользователем — не трогаются.
    const old = targets.applyFactoryLimits([
      targets.normalizeTarget({id: 'sim', mode: 'sim'}),
      targets.normalizeTarget({id: 'board-host', mode: 'board-host', limits: {ram: 128}}),
      targets.normalizeTarget({id: 'mine', mode: 'board-flash'}),
    ]);
    assert.deepEqual(old.map((t) => t.limits), [{code: 1024, ram: 64, stack: 64}, {code: null, ram: 128, stack: null}, {code: null, ram: null, stack: null}]);
  });
});

describe('артефакты pvmc и pvmdbg', () => {
  test('карта отладки', () => {
    const map = SourceMap.parse('0x0000 main.hlc:9\n0x0004 main.hlc:11\n0x0022 main.hlc:13\n0x0042 C:\\x\\lib\\time.hlc:5\n');
    assert.equal(map.locationFor(0x10).line, 11);
    assert.equal(map.addressFor('main.hlc', 13), 0x22);
    assert.deepEqual(map.linesOf('main.hlc'), [9, 11, 13]);
    assert.equal(map.locationFor(0x50).file, 'C:\\x\\lib\\time.hlc');
  });

  test('листинг', () => {
    const lst = parseListing(
      '# code    : 81 of 65535 bytes\n# ram     : 1 of 64 words\n# stack   : 1024 words\n#\n# functions:\n#   0x0000  main\n#   0x0042  square\n#\n# variables:\n#   0x0000  COUNT                  1 word   ram\n#   0x4000  LED                    1 word   usrsect\n\nmain:\n0x0000  1A         ENTER\n0x0001  01 00 00   PUSH 0\n',
    );
    assert.deepEqual(lst.memory.ram, {used: 1, total: 64, unit: 'words', text: '1 of 64 words'});
    assert.equal(lst.functions[1].name, 'square');
    assert.deepEqual(lst.variables.map((v) => [v.name, v.address, v.area]), [['COUNT', 0, 'ram'], ['LED', 0x4000, 'usrsect']]);
    assert.equal(lst.instructions.get(1).text, 'PUSH 0');
  });

  test('ошибки pvmcc', () => {
    assert.deepEqual(parseErrors("main.hlc:27: error: undefined variable 'x'\n"), [{file: 'main.hlc', line: 27, message: "undefined variable 'x'"}]);
  });

  test('состояние интерактивного pvmdbg --host', () => {
    const st = HostCliDriver.parseState('  pc=0x0022  sp=2  fp=1  breakpoint  [host: main]\n  -> 0x0022  01 00 00   PUSH 0\n     prog.hlc:13  x');
    assert.deepEqual(st, {pc: 0x22, sp: 2, fp: 1, reason: 'breakpoint', error: undefined});
    const err = HostCliDriver.parseState('  stack underflow at 0x0010\n  pc=0x0010  sp=0  fp=0  stopped on an error  [host: main]');
    assert.equal(err.reason, 'error');
    assert.match(err.error, /underflow/);
  });

  test('фильтр вывода симулятора', () => {
    // «напечатать» пишет в регистр вывода 0x4007; в трассе pvmsim это STORE 0x4007 -> N.
    const f = createLineFilter(pvm.pack.outputFilter);
    assert.equal(f.push('0x3D LOAD 0x0000 -> 5\n0x40 STORE 0x4007 -> 1') + f.push('0 SP 4 - 1\r\npvmsim: halted\n') + f.flush(), '10\n');
  });
});
