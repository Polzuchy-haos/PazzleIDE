// Транслитерация идентификаторов: «счёт» -> «schyot».
// Blockly по умолчанию превращает не-ASCII символы в «_D1_81...», что нечитаемо
// и не годится для C/C++/Lua. Подменяем Names.prototype.safeName глобально.
import * as Blockly from 'blockly';

const MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

export function transliterate(text) {
  // Слово целиком из заглавных (обычно константа: «ЗАДЕРЖКА») -> тоже заглавными: ZADERZHKA.
  return String(text).replace(/\p{L}+/gu, (word) => {
    const allCaps = word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase();
    let out = '';
    for (const ch of word) {
      const lower = ch.toLowerCase();
      if (lower in MAP) {
        const t = MAP[lower];
        out += allCaps ? t.toUpperCase() : ch !== lower && t ? t[0].toUpperCase() + t.slice(1) : t;
      } else {
        out += ch;
      }
    }
    return out;
  });
}

export function toIdentifier(name) {
  let id = transliterate(name).trim().replace(/[\s-]+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
  if (!id) id = 'unnamed';
  if (/^[0-9]/.test(id)) id = 'v_' + id;
  return id;
}

let installed = false;
export function installTransliteration() {
  if (installed) return;
  installed = true;
  Blockly.Names.prototype.safeName = function (name) {
    return name ? toIdentifier(name) : (Blockly.Msg['UNNAMED_KEY'] || 'unnamed');
  };
}
