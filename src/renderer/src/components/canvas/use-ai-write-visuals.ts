import { useEffect, useMemo, useRef, useState } from 'react'
import type { Topic, Workbook } from '@shared/model/types'

/**
 * 「AI 执行动效」的**视觉状态**（规格 4.6），三个输出：
 * `writingIds`（刚写入的节点 → 入场渐显）、`pulsingId`（当前执行到的那一个 → 描边脉冲）、
 * `settling`（整回合结束后 300ms 的收敛）。
 *
 * 三条设计原则（同时也是红线）：
 * 1. **只读现有状态**：`aiTurn` 是 AI 事务自己的状态，这里只把它当"回合进行中"的开关，
 *    不写、不改、不参与任何判定——动效是**贴上去的时间轴表现**。
 * 2. **只在回合进行中做检测**：`aiTurnActive` 为假时直接短路返回，普通编辑 / 打字的性能特征零变化。
 * 3. **写入判定是纯 UI 侧 diff**（新出现的 id ＋ 标题变化的 id），不依赖任何 AI 侧信号——
 *    这样 AI 写入路径一行都不用动，也就碰不到事务语义。
 *
 * 已知边界（如实写在这里，不假装覆盖）：AI 若只改**样式/位置/备注**而不动 id 与标题，
 * 这一轮不会转移高亮——写工具的主要形态是"加节点 / 加子树 / 改标题"，先覆盖这些。
 */

const WRITE_IN_MS = 120
const SETTLE_MS = 300

interface Snap {
  ids: Set<string>
  titles: Map<string, string>
}

function snapshot(workbook: Workbook): Snap {
  const ids = new Set<string>()
  const titles = new Map<string, string>()
  for (const sheet of workbook.sheets) {
    const walk = (topic: Topic): void => {
      ids.add(topic.id)
      titles.set(topic.id, topic.title)
      for (const child of topic.children) walk(child)
      for (const child of topic.detachedChildren) walk(child)
    }
    walk(sheet.rootTopic)
  }
  return { ids, titles }
}

export function useAiWriteVisuals(
  workbook: Workbook,
  aiTurnActive: boolean
): { writingIds: ReadonlySet<string>; pulsingId: string | null; settling: boolean } {
  const [writingIds, setWritingIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [pulsingId, setPulsingId] = useState<string | null>(null)
  const [settling, setSettling] = useState(false)
  const prevRef = useRef<Snap | null>(null)
  const wasActiveRef = useRef(false)
  const writeTimerRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (aiTurnActive) {
      wasActiveRef.current = true
      const next = snapshot(workbook)
      const prev = prevRef.current
      prevRef.current = next
      // 回合的第一次快照只当基线：不产生动效（否则一进回合满屏都在闪）
      if (!prev) return

      const touched: string[] = []
      for (const id of next.ids) {
        if (!prev.ids.has(id)) touched.push(id)
      }
      for (const [id, title] of next.titles) {
        if (prev.ids.has(id) && prev.titles.get(id) !== title) touched.push(id)
      }
      if (touched.length === 0) return

      const last = touched[touched.length - 1] ?? null
      // 「派生的动画状态跟着数据走」正是 setState-in-effect 的经典场景（同 NodePanel 的草稿同步）：
      // 依赖是 workbook / aiTurnActive，不是这些动画状态自身，所以不会自激循环。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWritingIds(new Set(touched))
      setPulsingId(last) // 高亮交棒：CSS 过渡 200ms 把上一步的圈收掉、这一步起脉冲
      if (writeTimerRef.current !== null) window.clearTimeout(writeTimerRef.current)
      writeTimerRef.current = window.setTimeout(() => {
        writeTimerRef.current = null
        setWritingIds((prevSet) => (prevSet.size === 0 ? prevSet : new Set<string>()))
      }, WRITE_IN_MS + 60)
      return
    }

    // —— 非回合态：只有"刚刚还在回合里"才做收敛（普通编辑不触发任何动效）
    prevRef.current = null
    setWritingIds((prevSet) => (prevSet.size === 0 ? prevSet : new Set<string>()))
    if (!wasActiveRef.current || settleTimerRef.current !== null) return
    wasActiveRef.current = false
    setSettling(true)
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      setSettling(false)
      setPulsingId(null) // 300ms 收敛结束：脉冲圈（已随 settling 淡出）彻底摘掉
    }, SETTLE_MS)
  }, [workbook, aiTurnActive])

  useEffect(
    () => () => {
      if (writeTimerRef.current !== null) window.clearTimeout(writeTimerRef.current)
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
    },
    []
  )

  return useMemo(() => ({ writingIds, pulsingId, settling }), [writingIds, pulsingId, settling])
}
