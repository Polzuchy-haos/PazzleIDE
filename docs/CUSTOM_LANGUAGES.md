# Описание языка: languages/pvm.json

Как блоки переводятся в PVM HLC, описано не кодом, а JSON-файлом [`languages/pvm.json`](../languages/pvm.json).
В нём есть шаблон для каждого блока, правила для типов и переменных, вспомогательные функции на HLC и
собственные блоки категории «PVM». Шаблоны обрабатывает генератор
[`src/core/generators/template.js`](../src/core/generators/template.js).

Чтобы добавить блок (например, для своей периферии или SVC-вызова платы), опишите его в `customBlocks`,
добавьте в категорию `toolbox` и задайте шаблон в `blocks` (см. «Свои блоки» ниже). После правки файла
перезагрузите интерфейс (Вид → Перезагрузить интерфейс).

Проверить результат можно без интерфейса:

```bash
node src/cli/pazzle.mjs hlc examples/02-faktorial.pzl
```

## Минимальный пакет

```json
{
  "id": "mini",
  "name": "Мини-язык",
  "fileExtension": "mini",
  "blocks": {
    "text_print": "say {{TEXT}}",
    "text": "{{TEXT|string}}",
    "math_number": "{{NUM}}",
    "variables_set": "let {{VAR}} = {{VALUE}}",
    "variables_get": "{{VAR}}",
    "controls_repeat_ext": "repeat {{TIMES}} {\n{{DO}}}"
  }
}
```

Если в пакете нет шаблона для какого-то блока, генерация всё равно проходит: вместо кода
вставляется комментарий, а сам блок помечается в рабочей области значком предупреждения.

## Поля пакета

| Поле | Обязательно | Назначение |
|------|:-:|------------|
| `id` | да | Идентификатор языка: латиница, цифры, `_`, `-` |
| `name` | да | Название в списке языков |
| `blocks` | да | Шаблоны блоков (см. ниже) |
| `fileExtension` | | Расширение файла при экспорте и запуске |
| `fileName` | | Имя исходного файла в папке сборки (`main.hlc`) |
| `editorLanguage` | | Подсветка кода в редакторе (для HLC — `c`) |
| `highlight` | | Своя подсветка, если подходящей в Monaco нет: `keywords`, `types`, `constants`, `lineComment`, `blockComment`, `ignoreCase` |
| `indent` | | Строка одного уровня отступа (по умолчанию 4 пробела) |
| `lineComment` | | Начало строчного комментария (`//`, `#`, `\|`) или шаблон с `{{TEXT}}` |
| `reservedWords` | | Слова, которые нельзя использовать как имена (к ним добавится суффикс) |
| `identifiers` | | `"unicode"` — оставить кириллицу в именах. По умолчанию имена транслитерируются: `счёт` → `schyot` |
| `strings` | | `quote`, `closeQuote`, `escapes`: как записывать строковые литералы |
| `types` | | Имена типов: `Number`, `String`, `Boolean`, `Integer`, `List` (с `{{ELEMENT}}`), `Void` |
| `defaults` | | Значения по умолчанию для типов: `Number`, `String`, `Boolean`, `List` |
| `variables` | | Объявления переменных: `declaration`, `section`, `separator`, `declareTemps` |
| `functions` | | Определения функций: `noReturn`, `withReturn`, `param`, `paramSeparator`, `paramsWrap`, `prototype`, `separator` |
| `program` | | Каркас программы (см. ниже) |
| `nakedValue` | | Как записать выражение, стоящее отдельно (`{{CODE}}`) |
| `helpers` | | Вспомогательный код, который добавляется только при использовании |
| `customBlocks` | | Свои блоки в формате JSON Blockly |
| `toolbox` | | Дополнительные категории палитры (видны, только когда выбран этот язык) |

Любой шаблон можно записать строкой (`"a\nb"`) или массивом строк (`["a", "b"]`), они склеиваются через перевод строки.

## Шаблоны блоков

### Подстановки

| Подстановка | Что вставляется |
|-------------|-----------------|
| `{{NAME}}` | Входное значение `NAME` (код вложенного блока), содержимое входа-операторов `NAME` (уже с отступом) или значение поля `NAME` |
| `{{VAR}}` | Для поля переменной — её имя в программе |
| `{{NAME}}` в блоках функций | Имя функции |
| `{{$TEMP:имя}}` | Уникальная временная переменная (например, счётчик цикла). Одна и та же внутри блока |
| `{{$TYPE:ВХОД}}` | Имя типа значения на входе или в переменной (по таблице `types`) |
| `{{$INDENT}}` | Один уровень отступа |
| `{{$PROC}}` | Имя функции, внутри которой стоит блок |

Если вход не заполнен, подставляется значение по умолчанию из `defaults` для его типа.

### Фильтры

Фильтры пишутся через `|` и применяются по порядку: `{{TEXT|string|upper}}`.

| Фильтр | Действие |
|--------|----------|
| `string` | Оформить как строковый литерал по правилам `strings` |
| `indent` | Добавить уровень отступа к каждой строке |
| `float` | Дописать `.0` к целому числу (`5` → `5.0`) |
| `int` | Отбросить дробную часть (`2.7` → `2`) — для языков только с целыми числами |
| `constname` | Имя константы из поля блока → идентификатор (транслитерация, без конфликтов с переменными и функциями) |
| `upper`, `lower`, `capitalize`, `trim` | Преобразования текста |

### Варианты по значению поля: `switch`

```json
"math_arithmetic": {
  "switch": "OP",
  "cases": {
    "ADD":      {"template": "{{A}} + {{B}}", "order": 4},
    "MULTIPLY": {"template": "{{A}} * {{B}}", "order": 3},
    "POWER":    "Math.pow({{A}}, {{B}})"
  }
}
```

Вместо поля можно использовать псевдополя: `$HAS_RETURN` (у блока «вернуть если» есть значение — `true`/`false`)
и `$CONNECTED:ВХОД` (вход заполнен — `true`/`false`). Если подходящего варианта нет, берётся `default`.

### Варианты по типу значения: `switchType`

```json
"text_print": {
  "switchType": "TEXT",
  "cases": {"String": "WriteLn({{TEXT}});", "Boolean": "WriteLn(BoolToStr({{TEXT}}));"},
  "default": "WriteLn(PazzleNum({{TEXT}}));"
}
```

Типы: `Number`, `String`, `Boolean` и `List` (любой список). Варианты можно вкладывать друг в друга на любую глубину.

### Скобки и приоритеты: `order`, `argOrder`, `inputOrders`

Чтобы не писать лишних скобок и при этом не ошибаться, у выражений есть приоритет: **чем меньше число, тем сильнее
связывание**, а `0` значит «атом», то есть скобки никогда не нужны.

* `order` — приоритет выражения, которое даёт этот шаблон. Вложенные выражения, которые связываются слабее
  или так же, автоматически берутся в скобки.
* `argOrder` — приоритет, с которым запрашиваются вложенные значения (по умолчанию равен `order`). Для вызовов
  функций вида `sqrt({{X}})` указывать ничего не нужно: если `order` нет, скобки вокруг аргументов не ставятся.
* `inputOrders` — приоритет для отдельных входов: `{"A": 1}`.

Пример: при `"order": 3` для `*` и `"order": 4` для `+` из блоков `(1 + 2) × 3` получится `(1 + 2) * 3`.

### Блоки с переменным числом входов: `repeat`

```json
"text_join": {
  "repeat": "ADD",
  "item": {"switchType": "ITEM", "cases": {"String": "{{ITEM}}"}, "default": "str({{ITEM}})"},
  "separator": " + ",
  "template": "{{ITEMS}}",
  "empty": "\"\"",
  "order": 4
}
```

Обрабатывает входы `ADD0`, `ADD1`, …. В `item` текущий вход доступен как `{{ITEM}}`, а его номер — как `{{INDEX}}`.
Результат склеивается через `separator` и подставляется в `template` как `{{ITEMS}}`, количество элементов —
`{{COUNT}}`. Ещё есть `empty` (нет элементов), `single` (ровно один элемент) и `skipEmpty` (пропускать пустые входы).
Так же описываются вызовы функций: `{"repeat": "ARG", "template": "{{NAME}}({{ITEMS}})"}`.

### Условие «если — иначе если — иначе»

```json
"controls_if": {
  "if": "if ({{IF}}) {\n{{DO}}}",
  "elseif": " else if ({{IF}}) {\n{{DO}}}",
  "else": " else {\n{{DO}}}",
  "end": ""
}
```

### Вспомогательный код: `requires` и `helpers`

```json
"helpers": {
  "input": ["static String pazzleInput(String p) { ... }"],
  "inputNum": {"requires": ["input"], "code": ["static double pazzleInputNum(String p) { ... }"]}
},
"blocks": {
  "text_prompt_ext": {"switch": "TYPE", "cases": {
    "NUMBER": {"template": "pazzleInputNum({{TEXT}})", "requires": "inputNum"},
    "TEXT":   {"template": "pazzleInput({{TEXT}})",    "requires": "input"}
  }}
}
```

Вспомогательная функция попадает в программу один раз и только если она действительно используется.

### Объявления, зависящие от блока: `declare`

Иногда блок требует объявления на верхнем уровне программы, которое зависит от его полей. Например,
порт микроконтроллера в PVM HLC:

```json
"pvm_port_set": {"template": "{{NAME}} = {{VALUE}};", "declare": "volatile int {{NAME}} @ {{ADDR}};"}
```

`declare` рендерится с подстановками этого блока и попадает в `{{HELPERS}}` (одинаковые объявления — один раз).
`declareOrder` задаёт место объявления в `{{HELPERS}}` (меньше — выше, по умолчанию 100). Так в PVM HLC
`section` (0) и константы (10) оказываются раньше портов и функций, которые их используют:

```json
"pvm_const_define": {"template": "", "declare": "const int {{NAME|constname}} = {{VALUE}};", "declareOrder": 10},
"pvm_const_get": "{{NAME|constname}}"
```

Категория палитры может быть динамической (`"custom": "PVM_CONSTANTS"`): её содержимое строит интерфейс.
Для констант это блок нового объявления и блоки всех уже объявленных констант.
Если у блока `template` пустой, на месте блока код не появляется — остаётся только объявление
(так сделан блок `section` в `pvm.json`).

## Каркас программы, переменные и функции

```json
"program": ["program Main;", "{{VARIABLES}}", "{{HELPERS}}", "{{FUNCTIONS}}", "begin", "{{BODY|indent}}end."],
"variables": {"declaration": "{{NAME}}: {{TYPE}};", "section": "var\n{{DECLARATIONS|indent}}\n"},
"functions": {
  "param": "{{NAME}}: {{TYPE}}",
  "paramSeparator": "; ",
  "noReturn": ["procedure {{NAME}}({{PARAMS}});", "begin", "{{BODY}}end;"],
  "withReturn": ["function {{NAME}}({{PARAMS}}): {{RETURN_TYPE}};", "begin", "{{BODY}}  Result := {{RETURN}};", "end;"]
}
```

* В `program` доступны `{{BODY}}` (основной код), `{{VARIABLES}}`, `{{FUNCTIONS}}`, `{{PROTOTYPES}}`, `{{HELPERS}}`
  и `{{WARNINGS}}` (предупреждения о типах в виде комментариев).
* `variables.declaration` получает `{{NAME}}`, `{{TYPE}}` и `{{DEFAULT}}`. Если поле `variables` не указано,
  переменные не объявляются (для динамических языков). `declareTemps: false` — не объявлять временные
  переменные `$TEMP` (если язык объявляет их прямо в цикле).
* В функциях доступны `{{NAME}}`, `{{PARAMS}}`, `{{PARAMS_WRAPPED}}` (`(a, b)` или пусто, если параметров нет),
  `{{BODY}}`, `{{RETURN}}` и `{{RETURN_TYPE}}`.

**Типы.** Переменные в блоках не имеют типов, поэтому PazzleIDE выводит их сама: смотрит, что присваивается
переменной и что передаётся в функции. Неизвестный тип считается числом. Если переменная используется
с разными типами, появляется предупреждение.

## Свои блоки

Пакет может добавить собственные блоки, например API робота или игрового движка:

```json
"customBlocks": [
  {
    "type": "robot_move",
    "message0": "вперёд на %1 шагов",
    "args0": [{"type": "input_value", "name": "STEPS", "check": "Number"}],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 200
  }
],
"toolbox": [
  {"kind": "category", "name": "Робот", "colour": 200, "contents": [{"kind": "block", "type": "robot_move"}]}
],
"blocks": {"robot_move": "robot.move({{STEPS}})"}
```

Формат описания блоков — стандартный JSON Blockly ([документация](https://developers.google.com/blockly/guides/create-custom-blocks/define/structure)).
Категория появляется в палитре, только когда выбран этот язык.

## Справочник стандартных блоков

| Блок | Входы (`{{…}}`) | Поля и их значения |
|------|-----------------|--------------------|
| `controls_if` | `IF`, `DO` (в разделах `if`/`elseif`/`else`) | — |
| `controls_repeat_ext` | `TIMES`, `DO` | — |
| `controls_whileUntil` | `BOOL`, `DO` | `MODE`: `WHILE`, `UNTIL` |
| `controls_for` | `FROM`, `TO`, `BY`, `DO` | `VAR` |
| `controls_forEach` | `LIST`, `DO` | `VAR` |
| `controls_flow_statements` | — | `FLOW`: `BREAK`, `CONTINUE` |
| `logic_compare` | `A`, `B` | `OP`: `EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE` |
| `logic_operation` | `A`, `B` | `OP`: `AND`, `OR` |
| `logic_negate` | `BOOL` | — |
| `logic_boolean` | — | `BOOL`: `TRUE`, `FALSE` |
| `logic_ternary` | `IF`, `THEN`, `ELSE` | — |
| `math_number` | — | `NUM` |
| `math_arithmetic` | `A`, `B` | `OP`: `ADD`, `MINUS`, `MULTIPLY`, `DIVIDE`, `POWER` |
| `math_single` | `NUM` | `OP`: `ROOT`, `ABS`, `NEG`, `LN`, `LOG10`, `EXP`, `POW10` |
| `math_trig` | `NUM` (в градусах) | `OP`: `SIN`, `COS`, `TAN`, `ASIN`, `ACOS`, `ATAN` |
| `math_constant` | — | `CONSTANT`: `PI`, `E`, `GOLDEN_RATIO`, `SQRT2`, `SQRT1_2`, `INFINITY` |
| `math_number_property` | `NUMBER_TO_CHECK`, `DIVISOR` | `PROPERTY`: `EVEN`, `ODD`, `PRIME`, `WHOLE`, `POSITIVE`, `NEGATIVE`, `DIVISIBLE_BY` |
| `math_round` | `NUM` | `OP`: `ROUND`, `ROUNDUP`, `ROUNDDOWN` |
| `math_modulo` | `DIVIDEND`, `DIVISOR` | — |
| `math_constrain` | `VALUE`, `LOW`, `HIGH` | — |
| `math_random_int` | `FROM`, `TO` | — |
| `math_random_float` | — | — |
| `math_change` | `DELTA` | `VAR` |
| `text` | — | `TEXT` (используйте `{{TEXT\|string}}`) |
| `text_join` | `ADD0…ADDn` (через `repeat`) | — |
| `text_append` | `TEXT` | `VAR` |
| `text_length`, `text_isEmpty` | `VALUE` | — |
| `text_print` | `TEXT` | — |
| `text_prompt_ext` | `TEXT` (подсказка) | `TYPE`: `TEXT`, `NUMBER` |
| `variables_get` | — | `VAR` |
| `variables_set` | `VALUE` | `VAR` |
| `procedures_callreturn`, `procedures_callnoreturn` | `ARG0…ARGn` (через `repeat`) | `NAME` |
| `procedures_ifreturn` | `CONDITION`, `VALUE` | псевдополе `$HAS_RETURN` |
| `lists_create_empty` | — | — |
| `lists_create_with` | `ADD0…ADDn` | — |
| `lists_repeat` | `ITEM`, `NUM` | — |
| `lists_length`, `lists_isEmpty` | `VALUE` | — |
| `lists_getIndex` | `VALUE`, `AT` | `MODE`: `GET`, `GET_REMOVE`, `REMOVE`; `WHERE`: `FROM_START`, `FROM_END`, `FIRST`, `LAST`, `RANDOM` |
| `lists_setIndex` | `LIST`, `AT`, `TO` | `MODE`: `SET`, `INSERT`; `WHERE`: как выше |
| `pazzle_comment` | — | `TEXT` |
| `pazzle_raw_code`, `pazzle_raw_expr` | — | `CODE` (вставляется как есть) |

Индексы в блоках списков начинаются с 1, как в Scratch. Определения функций (`procedures_defnoreturn`,
`procedures_defreturn`) описываются не в `blocks`, а в разделе `functions`.
