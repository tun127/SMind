/**
 * 中文紧贴的行内 mark 输入规则：`神经网络**粗体**`、`中文==高亮==`、`a^2^`、`正文[^1]`。
 *
 * TipTap 内置的输入规则（粗体 / 斜体 / 删除线由 StarterKit 带进来）一律要求前导是
 * 「行首或空白」，于是中文紧贴写法根本不触发、标记字符原样留在文字里。
 * 这里按同一套 `markInputRule` 约定补上放宽了边界的版本（正则集中在 `@shared/inline-rules`）。
 *
 * **内置规则刻意保持不动**：`Bold` / `Italic` / `Strike` 三个类由 StarterKit 内部持有、
 * 没有对外导出（直接 `import '@tiptap/extension-bold'` 又是不声明就用的隐式依赖），
 * 重造一份会连 HTML 解析、粘贴规则与快捷键一起丢掉。边界重叠时 InputRule 只执行
 * 第一条匹配的规则（命中即 return），所以两条规则并存不会重复触发。
 *
 * 单独成文件是为了能被实测脚本原样复用（`.tmp-check/editor-rules-check` 用真 Electron
 * 逐字符敲一遍，验证规则确实在编辑器里生效，而不是只对着正则做静态断言）。
 */
import { Extension, markInputRule, type InputRule } from '@tiptap/core'
import type { MarkType } from '@tiptap/pm/model'
import {
  BOLD_INPUT,
  BOLD_UNDERSCORE_INPUT,
  FOOTNOTE_INPUT,
  HIGHLIGHT_INPUT,
  ITALIC_INPUT,
  ITALIC_UNDERSCORE_INPUT,
  STRIKE_INPUT,
  SUBSCRIPT_INPUT,
  SUPERSCRIPT_INPUT
} from '@shared/inline-rules'

export const CjkInlineRules = Extension.create({
  name: 'cjkInlineRules',
  addInputRules() {
    const { marks } = this.editor.schema
    const rules: InputRule[] = []
    // 三个自定义 mark（highlight / superscript / subscript）与 StarterKit 带的
    // bold / italic / strike 都可能是 undefined（别人若改了扩展清单），逐个兜住。
    const add = (find: RegExp, type: MarkType | undefined): void => {
      if (type) rules.push(markInputRule({ find, type }))
    }
    add(BOLD_INPUT, marks.bold)
    add(BOLD_UNDERSCORE_INPUT, marks.bold)
    add(ITALIC_INPUT, marks.italic)
    add(ITALIC_UNDERSCORE_INPUT, marks.italic)
    add(STRIKE_INPUT, marks.strike)
    add(HIGHLIGHT_INPUT, marks.highlight)
    add(SUPERSCRIPT_INPUT, marks.superscript)
    add(FOOTNOTE_INPUT, marks.superscript)
    add(SUBSCRIPT_INPUT, marks.subscript)
    return rules
  }
})
