import type { FoldSide } from './tree'

/**
 * 按侧收起时的方向名（徽标文案与提示用）——**全仓唯一一份**。
 *
 * 画布（`components/TopicNode.tsx`）与 AI 的写入意图描述（`agent/write-intents.ts`）
 * 共用它：两处以前各写一份、逐字节相同，改文案就得记得改两个地方。
 * 放在 `shared/model` 而不是 `shared/agent`：方向名是**模型**概念，
 * 画布不该为了一个标签映射去依赖 AI 层。
 */
export const FOLD_SIDE_LABELS: Record<FoldSide, string> = {
  left: '左',
  right: '右',
  up: '上',
  down: '下'
}
