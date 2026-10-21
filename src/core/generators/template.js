// Шаблонный генератор: позволяет описать новый целевой язык JSON-файлом
// без программирования. Формат описан в docs/CUSTOM_LANGUAGES.md.
import * as Blockly from 'blockly';
import {inferTypes, NUM, STR, BOOL, isList, elemType, enclosingProcedure} from '../types.js';
import {installUnsupportedFallback} from './common.js';

const NONE = 99;
const PLACEHOLDER = /\{\{\s*([^}|]+?)\s*((?:\|\s*[\w-]+\s*)*)\}\}/g;

const asText = (tpl) => (Array.isArray(tpl) ? tpl.join('\n') : tpl);

// Перед кодом каждого оператора Blockly вставляет STATEMENT_PREFIX с id блока.
// После генерации эти строки-маркеры вырезаются, а из их положения строится
// таблица «строка кода → блок» (подсветка блока при отладке, точки останова на блоках).
const MARKER = '@@PAZZLE_BLOCK@@';
const MARKER_LINE = /^\s*@@PAZZLE_BLOCK@@'(.*)'\s*$/;

/** Убирает маркеры и лишние пустые строки; возвращает код и номера строк (с 1) → id блока. */
export function extractBlockMarkers(text) {
  const out = [];
  const lineBlocks = {};
  let pending = null;
  for (const raw of text.split('\n')) {
    const m = MARKER_LINE.exec(raw);
    if (m) {
      pending = m[1];
      continue;
    }
    const line = raw.replace(/[ \t]+$/, '');
    if (!line && (!out.length || out[out.length - 1] === '')) continue; // не больше одной пустой строки подряд
    out.push(line);
    if (pending !== null && line) {
      lineBlocks[out.length] = pending;
      pending = null;
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return {code: out.join('\n') + '\n', lineBlocks};
}

export class TemplateGenerator extends Blockly.CodeGenerator {
  constructor(pack) {
    super(pack.name || pack.id);
    this.pack = pack;
    this.INDENT = pack.indent ?? '    ';
    this.STATEMENT_PREFIX = MARKER + '%1\n';
    this.addReservedWords((pack.reservedWords || []).join(','));
    const comment = (text) => this.lineComment(text);
    installUnsupportedFallback(this, {comment, defaultValue: pack.defaults?.Number ?? '0'});
    for (const type of Object.keys(pack.blocks || {})) {
      this.forBlock[type] = (block, g) => g.renderBlock(block, pack.blocks[type]);
    }
    if (pack.functions) {
      this.forBlock['procedures_defnoreturn'] ??= (block, g) => g.renderProcedure(block);
      this.forBlock['procedures_defreturn'] ??= (block, g) => g.renderProcedure(block);
    }
  }

  lineComment(text) {
    const c = this.pack.lineComment ?? '//';
    return c.includes('{{') ? c.replace(/\{\{\s*TEXT\s*\}\}/, text) : `${c} ${text}`;
  }

  init(workspace) {
    super.init(workspace);
    if (!this.nameDB_) {
      this.nameDB_ = new Blockly.Names(this.RESERVED_WORDS_);
      if (this.pack.identifiers === 'unicode') {
        // Языки с кириллическими идентификаторами (например, КуМир) — без транслитерации.
        this.nameDB_.safeName = (name) => {
          let id = String(name || 'без_имени').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
          if (/^\p{N}/u.test(id)) id = '_' + id;
          return id || 'без_имени';
        };
      }
    } else {
      this.nameDB_.reset();
    }
    this.nameDB_.setVariableMap(workspace.getVariableMap());
    this.nameDB_.populateVariables(workspace);
    this.nameDB_.populateProcedures(workspace);
    this.workspace_ = workspace;
    this.types = inferTypes(workspace);
    this.helpers_ = new Map();
    this.functions_ = [];
    this.prototypes_ = [];
    this.temps_ = new Map(); // `${block.id}:${base}` -> {name, type}
    this.isInitialized = true;
  }

  finish(code) {
    const p = this.pack;
    const decls = [];
    if (p.variables?.declaration) {
      const declare = (name, type) =>
        decls.push(this.renderText(p.variables.declaration, null, {vars: {NAME: name, TYPE: this.typeName(type), DEFAULT: this.defaultFor(type)}}));
      for (const v of Blockly.Variables.allUsedVarModels(this.workspace_)) {
        declare(this.getVariableName(v.getId()), this.types.varType(v.getId()));
      }
      if (p.variables.declareTemps !== false) for (const t of this.temps_.values()) declare(t.name, t.type);
    }
    const sep = (s, d) => (s === undefined ? d : s);
    const vars = {
      BODY: code,
      HELPERS: [...this.helpers_.values()].join('\n\n'),
      FUNCTIONS: this.functions_.join(sep(p.functions?.separator, '\n\n')),
      PROTOTYPES: this.prototypes_.join('\n'),
      VARIABLES: decls.length
        ? this.renderText(p.variables.section ?? '{{DECLARATIONS}}', null, {vars: {DECLARATIONS: decls.join(sep(p.variables.separator, '\n'))}})
        : '',
      WARNINGS: this.types.warnings.map((w) => this.lineComment('Внимание: ' + w)).join('\n'),
    };
    const program = this.renderText(p.program ?? '{{HELPERS}}\n{{VARIABLES}}\n{{FUNCTIONS}}\n{{BODY}}', null, {vars});

    // Имя в коде → имя переменной в блоках (для панели переменных отладчика).
    this.lastNames = {};
    for (const v of Blockly.Variables.allUsedVarModels(this.workspace_)) {
      this.lastNames[this.getVariableName(v.getId())] = v.getName();
    }

    this.isInitialized = false;
    this.nameDB_.reset();
    super.finish(code);
    const {code: clean, lineBlocks} = extractBlockMarkers(program.replace(/^\n+/, ''));
    this.lastLineBlocks = lineBlocks;
    return clean;
  }

  scrubNakedValue(line) {
    return this.renderText(this.pack.nakedValue ?? '{{CODE}}', null, {vars: {CODE: line}}) + '\n';
  }

  quote_(text) {
    const s = this.pack.strings || {};
    const escapes = s.escapes || {'\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t'};
    const q = s.quote ?? '"';
    let out = '';
    for (const ch of String(text)) out += escapes[ch] ?? ch;
    return q + out + (s.closeQuote ?? q);
  }

  scrub_(block, code, thisOnly) {
    let comment = '';
    if (!block.outputConnection || !block.outputConnection.targetConnection) {
      const text = block.getCommentText();
      if (text) comment = text.split('\n').map((l) => this.lineComment(l)).join('\n') + '\n';
    }
    const next = block.nextConnection && block.nextConnection.targetBlock();
    return comment + code + (thisOnly ? '' : this.blockToCode(next));
  }

  // ---------- типы ----------

  typeName(t) {
    const types = this.pack.types || {};
    if (isList(t)) {
      const e = elemType(t);
      const elem = this.pack.elementTypes?.[e] ?? this.typeName(e);
      return (types.List ?? 'List').replace(/\{\{\s*ELEMENT\s*\}\}/g, elem);
    }
    return types[t] ?? types.default ?? t;
  }

  defaultFor(t) {
    const d = this.pack.defaults || {};
    if (isList(t)) return d.List ?? d.default ?? '[]';
    return d[t] ?? d.default ?? '0';
  }

  typeOfKey(block, key, ctx) {
    const name = ctx.alias?.[key] ?? key;
    if (block.getInput(name)) {
      const target = block.getInputTargetBlock(name);
      return target ? this.types.exprType(target) || NUM : NUM;
    }
    const field = block.getField(key);
    if (field instanceof Blockly.FieldVariable) return this.types.varType(block.getFieldValue(key));
    return NUM;
  }

  // ---------- шаблоны ----------

  /** Раскрывает switch/switchType и возвращает итоговую спецификацию. */
  select(block, spec, ctx, inherited = {}) {
    for (let depth = 0; depth < 32; depth++) {
      if (spec == null) return null;
      if (typeof spec === 'string' || Array.isArray(spec)) return {...inherited, template: asText(spec)};
      const merged = {...inherited};
      for (const k of ['order', 'argOrder', 'inputOrders', 'fields']) if (k in spec) merged[k] = spec[k];
      this.require(spec.requires);
      this.declare(block, spec.declare, ctx);
      if ('switch' in spec) {
        const value = this.switchValue(block, spec.switch, ctx);
        spec = spec.cases?.[value] ?? spec.default;
      } else if ('switchType' in spec) {
        const t = this.typeOfKey(block, spec.switchType, ctx);
        const c = spec.cases || {};
        spec = c[t] ?? (isList(t) ? c.List : undefined) ?? spec.default;
      } else {
        return {...merged, ...spec, template: asText(spec.template)};
      }
      inherited = merged;
    }
    return null;
  }

  switchValue(block, key, ctx) {
    if (ctx.vars && key in ctx.vars) return String(ctx.vars[key]);
    if (key === '$HAS_RETURN') return String(!!block.hasReturnValue_);
    if (key.startsWith('$CONNECTED:')) return String(!!block.getInputTargetBlock(key.slice(11)));
    return String(block.getFieldValue(key));
  }

  require(names) {
    for (const name of [].concat(names || [])) {
      if (this.helpers_.has(name)) continue;
      const h = this.pack.helpers?.[name];
      if (h == null) continue;
      if (typeof h === 'object' && !Array.isArray(h)) {
        this.require(h.requires);
        this.helpers_.set(name, asText(h.code));
      } else {
        this.helpers_.set(name, asText(h));
      }
    }
  }

  /** Объявление верхнего уровня, зависящее от блока (например, `volatile int LED @ 0x4000;`). */
  declare(block, template, ctx) {
    if (template == null) return;
    const text = this.renderText(template, block, ctx);
    if (text.trim()) this.helpers_.set('decl:' + text, text);
  }

  renderBlock(block, rawSpec) {
    const code = this.renderSpec(block, rawSpec, {alias: {}, vars: {}});
    if (code === null) {
      this.unsupported_.add(block.type);
      return block.outputConnection ? [this.defaultFor(NUM), 0] : this.lineComment(`блок «${block.type}» не поддерживается`) + '\n';
    }
    if (block.outputConnection) return [code, this.lastOrder_ ?? 0];
    if (code === '') return ''; // блок только с объявлением (declare), без кода на месте
    // Некоторые стандартные блоки (controls_if) просят Blockly не добавлять префикс —
    // маркер «строка → блок» ставим сами.
    const marker = block.suppressPrefixSuffix && this.STATEMENT_PREFIX ? this.injectId(this.STATEMENT_PREFIX, block) : '';
    return marker + (code.endsWith('\n') ? code : code + '\n');
  }

  /** Рендерит спецификацию в строку кода (или null, если вариант не описан). */
  renderSpec(block, rawSpec, ctx, inherited) {
    const spec = this.select(block, rawSpec, ctx, inherited);
    if (!spec) return null;
    let code;
    if ('if' in spec) code = this.renderIf(block, spec, ctx);
    else if ('repeat' in spec) code = this.renderRepeat(block, spec, ctx);
    else code = this.renderText(spec.template ?? '', block, ctx, spec);
    this.lastOrder_ = spec.order ?? 0;
    return code;
  }

  renderIf(block, spec, ctx) {
    let code = '';
    for (let n = 0; block.getInput('IF' + n); n++) {
      const alias = {...ctx.alias, IF: 'IF' + n, DO: 'DO' + n};
      code += this.renderText(asText(n === 0 ? spec.if : spec.elseif ?? spec.if), block, {...ctx, alias}, spec);
    }
    if (block.getInput('ELSE') && spec.else != null) {
      code += this.renderText(asText(spec.else), block, {...ctx, alias: {...ctx.alias, DO: 'ELSE'}}, spec);
    }
    return code + asText(spec.end ?? '');
  }

  renderRepeat(block, spec, ctx) {
    const items = [];
    for (let i = 0; block.getInput(spec.repeat + i); i++) {
      const name = spec.repeat + i;
      if (spec.skipEmpty && !block.getInputTargetBlock(name)) continue;
      const itemCtx = {alias: {...ctx.alias, ITEM: name}, vars: {...ctx.vars, INDEX: String(i)}};
      const itemSpec = spec.item ?? '{{ITEM}}';
      items.push(this.renderSpec(block, itemSpec, itemCtx, {order: spec.order, argOrder: spec.argOrder}) ?? '');
    }
    const vars = {...ctx.vars, ITEMS: items.join(spec.separator ?? ', '), COUNT: String(items.length)};
    let tpl = spec.template ?? '{{ITEMS}}';
    if (!items.length && spec.empty != null) tpl = asText(spec.empty);
    else if (items.length === 1 && spec.single != null) {
      tpl = asText(spec.single);
      vars.ITEM = items[0];
    }
    return this.renderText(tpl, block, {...ctx, vars}, spec);
  }

  renderText(template, block, ctx = {}, spec = {}) {
    return asText(template).replace(PLACEHOLDER, (_, key, filters) => {
      let value = this.resolve(block, key, ctx, spec);
      for (const f of filters.split('|').map((s) => s.trim()).filter(Boolean)) value = this.filter(f, value);
      return value;
    });
  }

  filter(name, value) {
    switch (name) {
      case 'string': return this.quote_(value);
      case 'indent': return value.replace(/^(?=.)/gm, this.INDENT);
      case 'upper': return value.toUpperCase();
      case 'lower': return value.toLowerCase();
      case 'capitalize': return value.charAt(0).toUpperCase() + value.slice(1);
      case 'trim': return value.trim();
      case 'int': return /^-?[\d.]+(e[-+]?\d+)?$/i.test(value) ? String(Math.trunc(Number(value))) : value;
      case 'float': return /^-?\d+$/.test(value) ? value + '.0' : value;
      default: return value;
    }
  }

  resolve(block, key, ctx, spec) {
    if (ctx.vars && key in ctx.vars) return ctx.vars[key];
    if (key === '$INDENT') return this.INDENT;
    if (!block) return '';
    if (key.startsWith('$TEMP:')) return this.temp(block, key.slice(6));
    if (key.startsWith('$TYPE:')) return this.typeName(this.typeOfKey(block, key.slice(6), ctx));
    if (key === '$PROC') return this.getProcedureName(enclosingProcedure(block)?.getFieldValue('NAME') ?? '');

    const inputName = ctx.alias?.[key] ?? key;
    const input = block.getInput(inputName);
    if (input?.connection?.type === Blockly.ConnectionType.NEXT_STATEMENT) {
      return this.statementToCode(block, inputName);
    }
    if (input?.connection) {
      const order = spec.inputOrders?.[key] ?? spec.argOrder ?? spec.order ?? NONE;
      const code = this.valueToCode(block, inputName, order);
      if (code) return code;
      const check = input.connection.getCheck();
      const t = check?.includes(STR) ? STR : check?.includes(BOOL) ? BOOL : NUM;
      return this.defaultFor(t);
    }
    const field = block.getField(key);
    if (field) {
      const value = block.getFieldValue(key);
      if (field instanceof Blockly.FieldVariable) return this.getVariableName(value);
      if (key === 'NAME' && block.type.startsWith('procedures_')) return this.getProcedureName(value);
      const mapped = spec.fields?.[key]?.[value];
      return mapped ?? String(value ?? '');
    }
    return '';
  }

  temp(block, base) {
    const key = `${block.id}:${base}`;
    if (!this.temps_.has(key)) {
      const name = this.nameDB_.getDistinctName(base, Blockly.Names.NameType.VARIABLE);
      this.temps_.set(key, {name, type: this.pack.types?.Integer ? 'Integer' : NUM});
    }
    return this.temps_.get(key).name;
  }

  renderProcedure(block) {
    const F = this.pack.functions;
    const rawName = block.getFieldValue('NAME');
    const withReturn = block.type === 'procedures_defreturn';
    const retType = this.types.returnType(rawName);
    const params = block.getVarModels().map((v) =>
      this.renderText(F.param ?? '{{NAME}}', null, {vars: {NAME: this.getVariableName(v.getId()), TYPE: this.typeName(this.types.varType(v.getId()))}}),
    );
    const joined = params.join(F.paramSeparator ?? ', ');
    const vars = {
      NAME: this.getProcedureName(rawName),
      PARAMS: joined,
      // «(a, b)» или пусто, если параметров нет (для языков, где пустые скобки не пишут).
      PARAMS_WRAPPED: params.length ? this.renderText(F.paramsWrap ?? '({{PARAMS}})', null, {vars: {PARAMS: joined}}) : '',
      BODY: this.statementToCode(block, 'STACK'),
      RETURN: withReturn ? this.valueToCode(block, 'RETURN', NONE) || this.defaultFor(retType) : '',
      RETURN_TYPE: withReturn ? this.typeName(retType) : this.pack.types?.Void ?? 'void',
    };
    const tpl = withReturn ? F.withReturn : F.noReturn;
    const comment = this.scrub_(block, '', true);
    const marker = this.injectId(this.STATEMENT_PREFIX, block); // заголовок функции → блок определения
    this.functions_.push(comment + marker + this.renderText(tpl, null, {vars}).replace(/\n$/, ''));
    if (F.prototype) this.prototypes_.push(this.renderText(F.prototype, null, {vars}));
    return null;
  }
}

/** Проверка пакета языка; возвращает список ошибок. */
export function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== 'object') return ['Пакет должен быть JSON-объектом'];
  if (!pack.id || !/^[a-z0-9_-]+$/i.test(pack.id)) errors.push('Поле "id" обязательно (латиница, цифры, _ и -)');
  if (!pack.name) errors.push('Поле "name" обязательно');
  if (!pack.blocks || typeof pack.blocks !== 'object') errors.push('Поле "blocks" обязательно');
  return errors;
}
