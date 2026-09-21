/**
 * 编辑器用的三个自定义 mark：**高亮 / 上标 / 下标**。
 *
 * 为什么要自己定义：内核富文本里有 `highlight` 与 `script` 两个属性
 * （Markdown 的 `==高亮==`、`^上标^`、`~下标~` 导入后就是它们），
 * TipTap 不认识这几个 mark 时会在编辑过程中**把它们丢掉**——
 * 用户一改标题，高亮和上下标就没了。这里用最小实现补上。
 *
 * 「打字即生效」的输入规则**不在这里**：统一由 `cjk-inline-rules.ts` 提供
 * （正则见 `@shared/inline-rules`——前导边界必须放宽到中文紧贴写法才谈得上生效）。
 *
 * 单独成一个文件是为了能被实测脚本直接复用（`.tmp-check/editor-rules-check`）：
 * 就地写在组件里的话，只有渲染层能跑到，输入规则就只能靠静态断言了。
 */
import { Mark } from '@tiptap/core'

export const Highlight = Mark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: () => ['mark', { class: 'rt-highlight' }, 0]
})

export const Superscript = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  // inclusive: false —— 光标停在上下标文字**后面**继续打字时不再继承这个格式，
  // 否则 a₁ 之后永远打出下标，写不回正常内容（用户实测反馈）
  inclusive: false,
  parseHTML: () => [{ tag: 'sup' }],
  renderHTML: () => ['sup', 0]
})

export const Subscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  // 同上：`a~1~` 紧贴写法也要生效（`~~删除线~~` 不受影响——下标规则匹配不到它）
  inclusive: false,
  parseHTML: () => [{ tag: 'sub' }],
  renderHTML: () => ['sub', 0]
})
