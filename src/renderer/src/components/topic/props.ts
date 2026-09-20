/**
 * TopicNode 的 props 契约（由 ../TopicNode.tsx 按行范围搬出，行为零变化）。
 *
 * 单独一份的理由：它是画布与节点之间的**接口**，回调全在这里声明；
 * 入口 TopicNode.tsx 只保留组件实现，改接口时不必在 500 行组件里找。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { LayoutResult, NodeLayout } from '@shared/layout/types'
import type { RichText, ThemeColors } from '@shared/model/types'
import type { FoldSide } from '@shared/model/tree'

export interface TopicNodeProps {
  node: NodeLayout
  layout: LayoutResult
  colors: ThemeColors
  selected: boolean
  editing: boolean
  editingRich: RichText | null
  /**
   * 落点高亮：
   * - `child`：松手后成为它的子主题（绿色虚线）；
   * - `sibling`：松手后插到它前面 / 后面（蓝色虚线）——只标**参照的那个主题本身**。
   *   绝不标它的父级：把父级框出来会让用户误以为"要落到父级上"（尤其父级是中心主题时）。
   */
  highlight: 'child' | 'sibling' | null
  /** 命中当前搜索关键词 */
  searchHit: boolean
  /**
   * 框选中「**将要**被选中」（还没松手）。
   * 先亮起来，用户不用等松手才知道圈到了谁。
   */
  marqueeHit: boolean
  /** AI 刚改过这个节点：闪一下（「直接操作」的信任全靠事后看得见） */
  flash: boolean
  /**
   * 「AI 正在写这个节点」的**视觉层**（规格 4.6）：入场渐显 120ms（`opacity 0→1` + `scale .98→1`）。
   * 纯表现——回合分组 / 撤销粒度 / 快照一概不看它，它也不反过来影响任何判定。
   */
  writing: boolean
  /** 「AI 当前执行到这一步」：一圈 2px 描边脉冲（1.2s 循环），步骤切换时交棒给下一个节点 */
  pulsing: boolean
  /**
   * 淡出显示：`true` = 被筛选排除（很淡）；`'soft'` = 拖拽时的无关枝叶（轻淡，
   * 仍看得见用来定位）。两者共用一条通路，避免再开一套状态。
   */
  dimmed: boolean | 'soft'
  dragOffset: { dx: number; dy: number } | null
  /** 是否是「手里正抓着的那一个」（它随之移动的后代不算），用于区分抬起的手感 */
  dragPrimary: boolean
  /** 正被拖着（含跟着走的子树）。拖动中不再显示落点高亮，免得和"抓着的东西"打架 */
  dragged: boolean
  /**
   * 是否可拖动。中心主题是整张图的锚点，不能拖走，
   * 所以它不显示「抓取」光标——光标本身就是最省事的操作提示。
   */
  draggable: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void
  onDoubleClick: (id: string) => void
  onRichChange: (id: string, rich: RichText) => void
  onCancelEdit: () => void
  /** 提交编辑并退出（编辑中按 Enter）——只退出，不新建 */
  onCommitEdit: () => void
  onCommitAndAddChild: () => void
  onCommitAndAddSibling: () => void
  /**
   * 空主题里按方向键：交给上层「提交本次编辑 + 移动选择」。
   * 不做这件事的话，刚建出来的空节点上按方向键会"像失灵一样"毫无反应。
   */
  onNavigateEdit: (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') => void
  onToggleCollapse: (id: string) => void
  /**
   * 平衡思维导图的中心主题：按侧收起 / 展开（左右各一根徽标）。
   * 其余节点走 `onToggleCollapse`（整体收起）。
   */
  onToggleFoldSide: (id: string, side: FoldSide) => void
}
