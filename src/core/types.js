// Вывод типов для статически типизированных языков (C, C++, Pascal, Java...).
// Blockly-переменные не имеют типов, поэтому тип выводится из того,
// что в переменную присваивается, и распространяется до неподвижной точки.
import * as Blockly from 'blockly';

export const NUM = 'Number';
export const STR = 'String';
export const BOOL = 'Boolean';
export const UNKNOWN_LIST = 'List<?>';

export const listOf = (t) => `List<${t || '?'}>`;
export const isList = (t) => typeof t === 'string' && t.startsWith('List<');
export const elemType = (t) => (isList(t) ? t.slice(5, -1) : null);

/** Объединение двух типов. conflict вызывается, если типы несовместимы. */
function merge(a, b, conflict) {
  if (!a || a === '?') return b;
  if (!b || b === '?') return a;
  if (a === b) return a;
  if (isList(a) && isList(b)) return listOf(merge(elemType(a), elemType(b), conflict));
  conflict?.(a, b);
  return a;
}

/** Окончательный тип: неизвестное трактуется как число. */
export function resolve(t) {
  if (!t || t === '?') return NUM;
  if (isList(t)) return listOf(resolve(elemType(t)));
  return t;
}

function checkToType(check) {
  if (!check) return null;
  if (check.includes(NUM)) return NUM;
  if (check.includes(STR)) return STR;
  if (check.includes(BOOL)) return BOOL;
  if (check.includes('Array')) return UNKNOWN_LIST;
  return null;
}

export function enclosingProcedure(block) {
  let b = block.getSurroundParent();
  while (b && b.type !== 'procedures_defreturn' && b.type !== 'procedures_defnoreturn') {
    b = b.getSurroundParent();
  }
  return b;
}

export function inferTypes(workspace) {
  const varTypes = new Map(); // id переменной -> тип
  const procReturn = new Map(); // имя процедуры -> тип результата
  const warnings = new Set();
  let changed = false;
  let reportConflicts = false;

  const varName = (id) => workspace.getVariableMap().getVariableById(id)?.getName() ?? id;

  function exprType(block) {
    if (!block) return null;
    switch (block.type) {
      case 'variables_get':
        return varTypes.get(block.getFieldValue('VAR')) || null;
      case 'procedures_callreturn':
        return procReturn.get(block.getFieldValue('NAME')) || null;
      case 'logic_ternary':
        return exprType(block.getInputTargetBlock('THEN')) || exprType(block.getInputTargetBlock('ELSE'));
      case 'lists_getIndex': {
        const lt = exprType(block.getInputTargetBlock('VALUE'));
        return isList(lt) ? elemType(lt) : null;
      }
      case 'lists_create_with': {
        let t = null;
        for (const input of block.inputList) {
          if (input.name.startsWith('ADD')) t = merge(t, exprType(input.connection.targetBlock()));
        }
        return listOf(t);
      }
      case 'lists_repeat':
        return listOf(exprType(block.getInputTargetBlock('ITEM')));
      case 'text_prompt_ext':
      case 'text_prompt':
        return block.getFieldValue('TYPE') === 'NUMBER' ? NUM : STR;
      default:
        return checkToType(block.outputConnection?.getCheck());
    }
  }

  function assign(id, type) {
    if (!id || !type) return;
    const old = varTypes.get(id);
    const next = merge(old, type, reportConflicts
      ? (a, b) => warnings.add(`Переменная «${varName(id)}» используется как ${a} и как ${b}`)
      : null);
    if (next !== old) {
      varTypes.set(id, next);
      changed = true;
    }
  }

  function setReturn(name, type) {
    if (!type) return;
    const old = procReturn.get(name);
    const next = merge(old, type);
    if (next !== old) {
      procReturn.set(name, next);
      changed = true;
    }
  }

  const blocks = workspace.getAllBlocks(false);
  const pass = () => {
    for (const block of blocks) {
      if (!block.isEnabled()) continue;
      const input = (n) => block.getInputTargetBlock(n);
      switch (block.type) {
        case 'variables_set':
          assign(block.getFieldValue('VAR'), exprType(input('VALUE')));
          break;
        case 'math_change':
        case 'controls_for':
          assign(block.getFieldValue('VAR'), NUM);
          break;
        case 'text_append':
          assign(block.getFieldValue('VAR'), STR);
          break;
        case 'controls_forEach': {
          const lt = exprType(input('LIST'));
          if (isList(lt)) assign(block.getFieldValue('VAR'), elemType(lt));
          break;
        }
        case 'lists_setIndex': {
          const list = input('LIST');
          if (list?.type === 'variables_get') assign(list.getFieldValue('VAR'), listOf(exprType(input('TO'))));
          break;
        }
        case 'procedures_callreturn':
        case 'procedures_callnoreturn': {
          const def = Blockly.Procedures.getDefinition(block.getFieldValue('NAME'), workspace);
          if (!def) break;
          def.getVarModels().forEach((v, i) => assign(v.getId(), exprType(input('ARG' + i))));
          break;
        }
        case 'procedures_defreturn':
          setReturn(block.getFieldValue('NAME'), exprType(input('RETURN')));
          break;
        case 'procedures_ifreturn': {
          const def = enclosingProcedure(block);
          if (def && block.hasReturnValue_) setReturn(def.getFieldValue('NAME'), exprType(input('VALUE')));
          break;
        }
      }
    }
  };

  for (let i = 0; i < 20; i++) {
    changed = false;
    pass();
    if (!changed) break;
  }
  reportConflicts = true;
  pass();

  return {
    warnings: [...warnings],
    /** Тип выражения (может быть null, если не определён). */
    exprType,
    /** Окончательный тип переменной по её id. */
    varType: (id) => resolve(varTypes.get(id)),
    /** Окончательный тип результата функции (null — нет результата). */
    returnType: (procName) => resolve(procReturn.get(procName)),
  };
}
