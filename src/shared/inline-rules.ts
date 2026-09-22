/**
 * 行内 mark 的**输入规则正则**（打字时即时生效的那一套）。
 *
 * 为什么单独放一份：TipTap 内置的 input rule 一律要求前导是「行首或空白」
 * （`(?:^|\s)`），于是 `神经网络**粗体**`、`中文==高亮==` 这类**中文紧贴**写法不触发，
 * 星号/波浪号会原样留在文字里。这里把前导边界放宽成「行首 / 空白 / CJK 字符」，
 * 但**刻意不含字母数字**：`2*3`、`file_name_here` 都是正常内容，
 * 放宽到字母数字会把它们误当成格式开关（星号被吃掉、文字莫名变斜）。
 *
 * 正则形态与 TipTap 的 `markInputRule` 约定一致：最后一个捕获组是**内容**，
 * 它前面的捕获组是含标记字符的整段（`markInputRule` 靠 `fullMatch.indexOf(内容)` 定位，
 * 所以边界必须用 lookbehind、不能吞字符，否则标记字符删不干净）。
 *
 * 抽成纯正则还有个好处：自检可以直接钉住边界（不需要 DOM 与编辑器实例）。
 */

/**
 * 「宽字符」字符类（不含方括号）：CJK 统一表意文字（基本区 + 扩展 A + 兼容区）、
 * 中日韩标点、全角形式、日文假名、韩文音节 —— 中文标点是 Common script，
 * 不会被 `\p{Script=Han}` 覆盖，所以必须写成显式码位区间。
 */
const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF\\uAC00-\\uD7AF'

/**
 * 强调类（粗体 / 斜体 / 删除线 / 高亮）的前导边界：行首、空白、CJK。
 *
 * **不放宽到字母数字**：`2*3`、`a*b*c`、`snake_case` 都是正常内容，
 * 放宽会被误判成格式开关（这是这批规则里最容易踩的坑，自检有对应的反向断言）。
 */
const EMPHASIS_LEAD = `(?<=^|[\\s${CJK}])`

/**
 * 上下标 / 脚注的前导边界：**任意非空白字符**之后都算。
 *
 * `a^2^`、`a~1~` 是这两种写法最典型的形态（紧贴在字母后面）；
 * 而 `^` / `~` 不像 `*` 那样会出现在普通算式里，所以放宽的风险远小于收益。
 * （下标另有一条更严的边界，见下面的 SUBSCRIPT_LEAD。）
 */
const SCRIPT_LEAD = '(?<=^|\\S)'

/**
 * 下标专用的前导边界：在「任意非空白」的基础上**排除 `~`**。
 *
 * 必须排除，否则删除线会被下标抢走：删除线是 `~~x~~`，敲到**倒数第二个** `~`
 * 时文本是 `~~x~`，此时下标规则（`~内容~`）若允许 `~` 前导就会抢先匹配，
 * 把 `~~` 当成一对标记吃掉，用户再也打不出删除线。
 * 这条是 2026-09-21 用真 Electron harness 敲出来的（`.tmp-check/editor-rules-check`）：
 * 静态断言当时只覆盖了完整的 `~~删除线~~`，没覆盖「敲到一半」的中间态。
 */
const SUBSCRIPT_LEAD = '(?<=^|[^\\s~])'

/** `**粗体**` */
export const BOLD_INPUT = new RegExp(
  `${EMPHASIS_LEAD}(\\*\\*(?!\\s+\\*\\*)((?:[^*]+))\\*\\*(?!\\s+\\*\\*))$`
)

/** `__粗体__` */
export const BOLD_UNDERSCORE_INPUT = new RegExp(
  `${EMPHASIS_LEAD}(__(?!\\s+__)((?:[^_]+))__(?!\\s+__))$`
)

/** `*斜体*` */
export const ITALIC_INPUT = new RegExp(`${EMPHASIS_LEAD}(\\*(?!\\s+\\*)((?:[^*]+))\\*(?!\\s+\\*))$`)

/**
 * 单下划线斜体已**停用**（2026-09-22 深夜 P2：`_ab_` / `a_ab_` 这类变量名、
 * 文件名里的下划线会被当语法吞掉）。
 *
 * 保留这个导出符号只为旧调用点与离线实测脚本不因删符号而报错；正则恒不匹配。
 * 需要强调：解析器里的 `_x_` 分支也必须同时去掉，只改这一处无效。
 */
export const ITALIC_UNDERSCORE_INPUT = /$a/

/** `~~删除线~~` */
export const STRIKE_INPUT = new RegExp(`${EMPHASIS_LEAD}(~~(?!\\s+~~)((?:[^~]+))~~(?!\\s+~~))$`)

/** `==高亮==` */
export const HIGHLIGHT_INPUT = new RegExp(`${EMPHASIS_LEAD}((?:==)((?:[^=]+))(?:==))$`)

/** `^上标^` */
export const SUPERSCRIPT_INPUT = new RegExp(`${SCRIPT_LEAD}((?:\\^)((?:[^\\s^]+))(?:\\^))$`)

/** `~下标~`（前导要排除 `~`，否则会抢走 `~~删除线~~`，详见 SUBSCRIPT_LEAD） */
export const SUBSCRIPT_INPUT = new RegExp(`${SUBSCRIPT_LEAD}((?:~)((?:[^\\s~]+))(?:~))$`)

/** `[^1]` 脚注引用（导入时也按上标渲染，编辑器保持一致） */
export const FOOTNOTE_INPUT = new RegExp(`${SCRIPT_LEAD}(\\[\\^[^\\]]+\\])$`)
