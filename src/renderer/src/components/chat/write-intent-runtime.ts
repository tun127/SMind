/**
 * 写意图执行：把一条 `WriteIntent` 落到 store 上，并把结果回喂给模型。
 *
 * A6-4 从 `chat/turn-runtime.ts` **整块搬出**（原文件 L121-L322，202 行，**函数体逐字未改**）：
 * `pushToolResult` / `compressExecutedCallArgs` / `noteAction` / `applyWriteIntent`，
 * 连它们上面那段「工具执行」分节标题一起带过来（它描述的就是这批代码）。
 *
 * **为什么拆出来（A6-4 配方①）**：`applyWriteIntent` 是**唯一**执行写操作的地方
 * （撤销事务、快照、摘要都在这一处收口），它只依赖「消息线 + 写日志 + 改动节点 +
 * 事务开关 + `update`」；与「队列怎么推进（`processQueue`）」之间只通过显式 deps 与
 * 返回值耦合，A6-3 之后已经没有 ref 环 —— 所以两块可以各自成模块、各自能读能改。
 *
 * **身份语义与搬迁前一致**：这些函数在 A6-3 之前本来就是每次渲染重建的普通 `const`；
 * 现在由本工厂在每次渲染里重建一次（与 `createTurnRuntime` 的既有约定完全相同），
 * 且工厂不参与 React 的依赖比较（hook 里的调用不写进任何依赖数组）。
 */

import type { RefObject } from 'react'
import type { AiMessage, ToolCall } from '@shared/ai'
import { isMutatingIntent, type WriteIntent } from '@shared/agent'
import { activeRoot, ancestorsOf, findTopic } from '@shared/model/tree'
import { useEditor } from '../../store/editor'
import type { ChatMsg } from './types'

/** 本模块需要的全部外部依赖（显式传进来，函数体内用解构还原原局部名） */
export interface WriteIntentRuntimeDeps {
  changedIdsRef: RefObject<string[]>
  turnStartedRef: RefObject<boolean>
  wireRef: RefObject<AiMessage[]>
  writeLogRef: RefObject<string[]>
  update(updater: (prev: ChatMsg[]) => ChatMsg[]): void
  /** AI 要动**第一笔**改动之前调用（App 层用它存一份盘上快照） */
  onBeforeAiWrite(): void
}

export function createWriteIntentRuntime(deps: WriteIntentRuntimeDeps): {
  pushToolResult(call: ToolCall, content: string): void
  compressExecutedCallArgs(callId: string): void
  noteAction(summary: string, counts: boolean): void
  applyWriteIntent(intent: WriteIntent): { ok: boolean; note: string }
} {
  const { changedIdsRef, turnStartedRef, wireRef, writeLogRef, update, onBeforeAiWrite } = deps

  /* ------------------------------------------------------------------ */
  /* 工具执行                                                            */
  /* ------------------------------------------------------------------ */

  /** 往消息线里塞一条工具结果（模型下一轮就看得到） */
  const pushToolResult = (call: ToolCall, content: string): void => {
    wireRef.current = [...wireRef.current, { role: 'tool', toolCallId: call.id, content }]
  }

  /**
   * 已成功执行的调用：把消息线里它的完整参数压成短摘要。
   *
   * 轮内每执行完一个调用就把**整条消息线**原样重发给模型——setCode 的整段代码、
   * insertSubtree 的整段大纲全都原样带着。几十个调用就能把单轮提示词撑到
   * 60k+ token，光让服务端读一遍就要一两分钟：UI 没死，但像死了（实测单轮往返 125s）。
   * 执行结果已经在对应的 tool 消息里，参数本体对后续轮次没有用处；
   * 保留开头一段是为万一模型想引用自己刚才写的内容时还有个抓手。
   */
  const compressExecutedCallArgs = (callId: string): void => {
    const HEAD = 200
    wireRef.current = wireRef.current.map((msg) => {
      if (msg.role !== 'assistant' || !msg.toolCalls?.some((c) => c.id === callId)) return msg
      return {
        ...msg,
        toolCalls: msg.toolCalls.map((c) =>
          c.id === callId && c.argumentsText.length > HEAD
            ? {
                ...c,
                argumentsText: `${c.argumentsText.slice(0, HEAD)}…（此调用已成功执行，参数其余部分省略；执行结果见下方对应的工具消息）`
              }
            : c
        )
      }
    })
  }

  /** 把「AI 干了什么」记到界面与日志上 */
  const noteAction = (summary: string, counts: boolean): void => {
    if (counts) writeLogRef.current = [...writeLogRef.current, summary]
    update((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, toolNotes: [...(last.toolNotes ?? []), summary] }]
    })
  }

  /**
   * 把一条写意图落到 store 上。
   *
   * 这里是**唯一**执行写操作的地方：撤销事务、快照、摘要都在这一处收口，
   * 免得以后新增工具时漏掉某一步安全网。
   */
  const applyWriteIntent = (intent: WriteIntent): { ok: boolean; note: string } => {
    const store = useEditor.getState()

    if (!turnStartedRef.current) {
      turnStartedRef.current = true
      store.beginAiTurn()
      onBeforeAiWrite()
    }

    // AI 动手前，先把用户**正在输入**的标题按正常流程提交掉：不提交的话，
    // 输入框里的字会被这次写入冲掉——那是数据丢失，不是体验问题。
    // 提交在 AI 事务**之外**，于是 Ctrl+Z 先撤 AI 的改动、再撤这次提交，顺序对得上。
    if (store.editingId !== null && isMutatingIntent(intent)) store.commitEdit()

    /** 记下这次动过的节点：回合结束时闪一下（「看得见」是放手让 AI 干的前提） */
    const touched = (ids: Array<string | null | undefined>): void => {
      for (const id of ids)
        if (typeof id === 'string' && id.length > 0) changedIdsRef.current.push(id)
    }

    switch (intent.kind) {
      case 'rename':
        store.setTitle(intent.id, intent.title)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'insert': {
        // 可能是多个并列的新主题（解析器套的壳已经在规划阶段剥掉了）
        const before = new Set(
          findTopic(activeRoot(store.workbook), intent.id)?.children.map((child) => child.id) ?? []
        )
        let added = 0
        for (const node of intent.nodes) added += store.applyOutlineTree(intent.id, node)
        if (added === 0) return { ok: false, note: '目标主题已不存在，插入没有生效。' }
        // 新增完比原来多出来的那批就是新节点，顺手也闪它们本人
        const after = findTopic(activeRoot(store.workbook), intent.id)
        touched([
          intent.id,
          ...(after?.children ?? []).filter((child) => !before.has(child.id)).map((c) => c.id)
        ])
        return { ok: true, note: '' }
      }
      case 'delete': {
        // 被删的节点已经没了、闪不了，就闪它的父级——用户至少知道「这一片被动过」
        const chain = ancestorsOf(activeRoot(store.workbook), intent.id)
        const parentId = chain[chain.length - 1]
        const removed = store.deleteTopic(intent.id)
        if (removed) touched([parentId])
        return removed
          ? { ok: true, note: '' }
          : { ok: false, note: '目标主题已不存在，删除没有生效。' }
      }
      case 'move': {
        const moved = store.moveNode(intent.id, intent.targetId, intent.index ?? undefined)
        if (moved) touched([intent.id, intent.targetId])
        return moved
          ? { ok: true, note: '' }
          : { ok: false, note: '移动没有生效：目标位置不合法。' }
      }
      case 'moveMany': {
        // 批量移动：一次写入落完（都在同一步撤销里）。逐条调 moveNode 时，
        // 每条都要扫一遍全树清失效的边界/概要——一次最多 200 条就是 200 遍全树，
        // 终态一样但成本差一个数量级。
        // 个别条目可能因为前面条目改变了结构而落空——如实把比例回喂给模型
        const appliedMoves = store.moveNodes(intent.moves)
        for (const move of appliedMoves) touched([move.id, move.targetId])
        const movedCount = appliedMoves.length
        if (movedCount === 0) return { ok: false, note: '一个都没有移动成功：目标位置可能不合法。' }
        return {
          ok: true,
          note:
            movedCount < intent.requested
              ? `成功 ${movedCount}/${intent.requested}，其余目标位置不合法`
              : ''
        }
      }
      case 'collapse':
        // 带 side = 平衡图中心主题的「按侧收起」（幂等设置值，重试不会来回翻）
        if (intent.side) store.setFoldSide(intent.id, intent.side, intent.collapsed)
        else store.setCollapsed(intent.id, intent.collapsed)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'structure':
        // 结构是整张画布的属性：只改中心主题（intent.id 由规划层保证就是根节点）
        store.setStructure(intent.structureClass)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'sortChildren': {
        store.sortChildren(intent.id, intent.orderedIds, intent.renumber)
        touched([intent.id, ...intent.orderedIds])
        return { ok: true, note: intent.renumber ? '顺序与编号都已更新' : '顺序已更新' }
      }
      case 'dedupe': {
        const merged = store.mergeTopics(intent.groups)
        if (merged === 0) return { ok: false, note: '没有可合并的（组内可能存在父子包含关系）。' }
        touched(intent.groups.map((group) => group.keepId))
        return { ok: true, note: `共删除 ${merged} 个重复节点` }
      }
      case 'notes':
        store.setNotes(intent.id, intent.text)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'code':
        store.setCode(intent.id, intent.code)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'formula':
        store.setFormula(intent.id, intent.formula)
        touched([intent.id])
        return { ok: true, note: '' }
      /* ---- 第二批：画布元素（关系线 / 边界 / 概要）与标记、标签 ---- */
      case 'relationship': {
        const created = store.connectTopics(intent.ends[0], intent.ends[1])
        if (!created) return { ok: false, note: '连关系线没有生效：两端主题可能已不存在。' }
        if (intent.title !== null) store.setRelationshipTitle(created, intent.title)
        touched([intent.ends[0], intent.ends[1]])
        return { ok: true, note: '' }
      }
      case 'boundary': {
        const created = store.addBoundaryFor(intent.topicIds, intent.title ?? undefined)
        if (!created) return { ok: false, note: '这些主题不是同级相邻，圈不成一个范围。' }
        touched(intent.topicIds)
        return { ok: true, note: '' }
      }
      case 'summary': {
        const created = store.addSummaryFor(intent.topicIds, intent.title ?? undefined)
        if (!created) return { ok: false, note: '这些主题不是同级相邻，加不了概要。' }
        touched(intent.topicIds)
        return { ok: true, note: '' }
      }
      case 'attachmentTitle':
        if (intent.target === 'relationship') store.setRelationshipTitle(intent.id, intent.title)
        else if (intent.target === 'boundary') store.setBoundaryTitle(intent.id, intent.title)
        else store.setSummaryTitle(intent.id, intent.title)
        return { ok: true, note: '' }
      case 'attachmentRemove':
        if (intent.target === 'relationship') store.removeRelationship(intent.id)
        else if (intent.target === 'boundary') store.removeBoundary(intent.id)
        else store.removeSummary(intent.id)
        return { ok: true, note: '' }
      case 'markers':
        store.setMarkers(intent.id, intent.markerIds)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'label':
        if (intent.add) store.addLabel(intent.id, intent.label)
        else store.removeLabel(intent.id, intent.label)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'ask':
        return { ok: true, note: '' }
      default:
        return { ok: false, note: '未知操作。' }
    }
  }

  return { pushToolResult, compressExecutedCallArgs, noteAction, applyWriteIntent }
}
