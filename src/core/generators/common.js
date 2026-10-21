// Общие механизмы генерации кода.
import * as Blockly from 'blockly';

const baseBlockToCode = Blockly.CodeGenerator.prototype.blockToCode;

/**
 * Блок, для которого у языка нет шаблона, не должен ронять генерацию:
 * вместо исключения вставляем комментарий и запоминаем тип блока.
 */
export function installUnsupportedFallback(gen, {comment = (t) => `// ${t}`, defaultValue = '0'} = {}) {
  gen.unsupported_ = new Set();
  gen.blockToCode = function (block, thisOnly) {
    if (block && !this.forBlock[block.type]) {
      this.forBlock[block.type] = (b, g) => {
        g.unsupported_.add(b.type);
        const note = comment(`блок «${b.type}» не поддерживается этим языком`);
        return b.outputConnection ? [defaultValue, 0] : note + '\n';
      };
    }
    return baseBlockToCode.call(this, block, thisOnly);
  };
}

/**
 * Генерирует код. Кроме текста возвращает предупреждения, таблицу
 * «строка → id блока» и соответствие имён в коде именам переменных в блоках.
 */
export function generateWithReport(gen, workspace) {
  gen.unsupported_?.clear();
  const code = gen.workspaceToCode(workspace);
  const unsupported = [...(gen.unsupported_ || [])];
  const warnings = unsupported.map((t) => `Блок «${t}» не поддерживается этим языком`);
  if (gen.types?.warnings) warnings.push(...gen.types.warnings);
  if (gen.lastDetached?.length) {
    warnings.push(`Стопок вне «начала программы»: ${gen.lastDetached.length} — они не выполняются`);
  }
  if (gen.lastExtraEntries?.length) warnings.push('Блок «начало программы» должен быть один — выполняется верхний');
  return {
    code,
    warnings,
    unsupported,
    lineBlocks: gen.lastLineBlocks || {},
    names: gen.lastNames || {},
    detached: gen.lastDetached || [], // стопки вне блока начала программы — не выполняются
    extraEntries: gen.lastExtraEntries || [], // лишние блоки начала программы
  };
}
