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
} from '../src/core/index.js';

const require = createRequire(import.meta.url);
const {SourceMap, parseListing} = require('../src/main/pvm/artifacts.cjs');
const {createLineFilter} = require('../src/main/runner.cjs');
const {parseErrors} = require('../src/main/pvm/build.cjs');
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
    const r = extractBlockMarkers("a\n@@VIDE_BLOCK@@'X'\n  b\n\n\n\nc  \n");
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
                inputs: {VALUE: {block: {type: 'pvm_svc_value', fields: {N: 2}, inputs: {A: {block: {type: 'math_number', fields: {NUM: 3}}}, B: {block: {type: 'math_number', fields: {NUM: 4}}}}}}},
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

  test('имена: HLC -> блоки', () => {
    const ws = load({variables: [{id: 'v', name: 'счёт'}], blocks: {blocks: [{type: 'math_change', fields: {VAR: {id: 'v'}}}]}});
    assert.deepEqual(generateCode(pvm, ws).names, {schyot: 'счёт'});
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
    const f = createLineFilter({keep: String.raw`^pvmsim: SVC print -> (-?\d+)\s*$`, replace: '$1'});
    assert.equal(f.push('0x7 SVC #1\npvmsim: SVC print -> 1') + f.push('0\r\npvmsim: halted\n') + f.flush(), '10\n');
  });
});
