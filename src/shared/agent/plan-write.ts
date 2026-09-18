/**
 * 写工具的规划：把（工具名 + 参数文本）解析、寻址、校验成一次 WriteIntent。
 *
 * 单一职责：模型说什么是一回事，画布上**能不能做**是另一回事——
 * 这里集中所有「如实拒绝」的规则（空标题、改别人画布的东西、越界区间……），
 * 拒绝的话术要写成模型能自行纠正的样子。
 */
import type { Topic } from '../model/types'
import { ancestorsOf, findTopic, isSelfOrDescendant, splitFoldSidesOf } from '../model/tree'
import { isRecord } from '../guards'
import { countTopicTree, parseOutline, type OutlineNode } from '../ai'
import { MARKER_LABELS, STRUCTURES, markerGroupOf } from '../xmind/constants'
import { resolveTopicAddress } from './address'
import { duplicateGroups, normalizeTopicTitle, stringArg } from './run-read'
import {
  ATTACHMENT_LABEL,
  destructiveOf,
  FOLD_SIDE_LABELS,
  readAttachmentKind,
  type WritePlan
} from './write-intents'

function subtreeContains(node: Topic, id: string): boolean {
  if (node.id === id) return true
  return node.children.some((child) => subtreeContains(child, id))
}

/**
 * 把写工具的调用解析成一条「操作意图」。
 *
 * 失败也返回文本（`error`）而不是抛错：这段文字会原样回喂给模型，
 * 它看到「标题「成本」出现 2 次，请改用路径」才知道下一步怎么改。
 */
export function planWriteTool(name: string, argumentsText: string, root: Topic): WritePlan {
  const fail = (error: string): WritePlan => ({
    ok: false,
    error: `调用 ${name} 失败：${error}`,
    summary: `${name}：${error.length > 30 ? `${error.slice(0, 30)}…` : error}`
  })

  let args: Record<string, unknown> = {}
  const trimmed = argumentsText.trim()
  if (trimmed.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      return fail(`参数不是合法 JSON（${(error as Error).message}）。请重新调用并传入合法参数。`)
    }
    if (!isRecord(parsed)) return fail('参数必须是 JSON 对象。')
    args = parsed
  }

  /** 解析 address 并给出「找到的那个节点」 */
  const resolve = (key: string): { topic: Topic } | { problem: WritePlan } => {
    const address = stringArg(args, key)
    if (address.length === 0) return { problem: fail(`${key} 不能为空。`) }
    const resolved = resolveTopicAddress(root, address)
    if (!resolved.ok) return { problem: fail(resolved.error) }
    return { topic: resolved.resolved.topic }
  }

  if (name === 'renameTopic') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.title !== 'string') return fail('title 必须是字符串。')
    const title = args.title.trim()
    /**
     * 空标题会被拒绝：以前漏传 `title`（=空串）会被当成"清空标题"，
     * 而节点在画布上就只剩一个白条——**静默地毁掉一个节点的内容**。
     * 想"去标题"是用图片 / 公式 / 代码节点，那是节点属性面板里的事，不走改名。
     */
    if (title.length === 0) {
      return fail('标题不能改成空的（那会留下一个看不出内容的节点）。要改请写上新标题。')
    }
    // 空操作要如实说：否则一次「改了名」的报告背后什么都没变，用户以为 AI 在糊弄他
    if (target.topic.title === title) {
      return fail(`「${title}」的标题本来就是它，这次没有任何改动。`)
    }
    return {
      ok: true,
      intent: { kind: 'rename', id: target.topic.id, title },
      summary: `改名「${target.topic.title}」→「${title}」`,
      destructive: false
    }
  }

  if (name === 'insertSubtree') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    const outline = stringArg(args, 'outline')
    if (outline.length === 0) return fail('outline 不能为空。')
    const parsed = parseOutline(outline, '新主题')
    if (!parsed.root) return fail(parsed.warnings.join('；') || 'outline 里解析不出任何主题。')

    // 并列多行会被解析器套一个壳节点：这里**把壳剥掉**，让那些行成为并列的新主题。
    // 直接把壳落进画布会凭空多出一个叫「新主题」的垃圾节点——模型没错，是我们的锅。
    const nodes = parsed.wrapped ? parsed.root.children : [parsed.root]
    if (nodes.length === 0) return fail('outline 里没有可插入的主题。')

    // 防「照抄已有内容」：整理 / 归类时模型很容易用新增来"重写一遍"，结果是把内容**复制**一份
    // （真出过事故：一次整理之后画布上出现了好几套相同的分类与节点）。
    // 硬判定：outline 里的标题有多大比例**文档里已经存在**——过半数且数量不少就拦下来。
    if (args.allowDuplicate !== true) {
      const existing = new Set<string>()
      const collect = (topic: Topic): void => {
        if (topic.title.length > 0) existing.add(topic.title)
        for (const child of topic.children) collect(child)
      }
      collect(root)
      let totalNodes = 0
      let alreadyExists = 0
      const walk = (node: OutlineNode): void => {
        totalNodes += 1
        if (existing.has(node.title)) alreadyExists += 1
        for (const child of node.children) walk(child)
      }
      for (const node of nodes) walk(node)
      if (alreadyExists >= 5 && alreadyExists * 2 >= totalNodes) {
        return fail(
          `outline 里有 ${alreadyExists}/${totalNodes} 个标题在文档中**已经存在**——这看着像是把已有内容重写一遍，` +
            '执行后画布上会多出一份重复内容。归置已有主题请改用 moveTopics（按句柄或标题寻址移动）。' +
            '确实要新增这些同名内容，带上 allowDuplicate: true 再调用一次。'
        )
      }
    }

    const host = target.topic.title
    const shown = nodes
      .slice(0, 3)
      .map((node) => node.title)
      .join('、')
    return {
      ok: true,
      intent: { kind: 'insert', id: target.topic.id, nodes, count: parsed.count },
      summary:
        nodes.length === 1
          ? `在「${host}」下新增「${nodes[0]?.title ?? ''}」（共 ${parsed.count} 个节点）`
          : `在「${host}」下新增 ${nodes.length} 个主题（${shown}${nodes.length > 3 ? ' 等' : ''}；共 ${parsed.count} 个节点）`,
      destructive: false
    }
  }

  if (name === 'deleteTopic') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    const size = countTopicTree(target.topic)
    return {
      ok: true,
      intent: { kind: 'delete', id: target.topic.id, title: target.topic.title, size },
      summary: `删除「${target.topic.title}」（含 ${size} 个节点）`,
      destructive: destructiveOf('delete')
    }
  }

  if (name === 'moveTopic') {
    const source = resolve('address')
    if ('problem' in source) return source.problem
    const destination = resolve('toAddress')
    if ('problem' in destination) return destination.problem
    if (source.topic.id === destination.topic.id) return fail('不能把一个主题移到它自己下面。')
    if (subtreeContains(source.topic, destination.topic.id)) {
      return fail('不能把一个主题移到它自己的子孙下面。')
    }
    // 自由摆放的地盘：用户手动摆过位置的主题默认不动（改动别人的版面比改内容更招人烦，
    // 而且撤得回来也撤不掉火气）。要走这条路必须是模型**显式**说清楚。
    if (source.topic.position && args.allowMoved !== true) {
      return fail(
        `「${source.topic.title}」是用户手动摆过位置的主题，移动它会打乱他自己排的版面。` +
          '如果这一步确实必要（例如用户明确要求重新排列），请再调用一次并带上 allowMoved: true。'
      )
    }
    // 空操作：本来就在这个父级下、又没指定位置——如实说，不要报成「已移动」。
    // 判定与 store 的 moveNode **完全一致**（同父级 + 无 index 就是原地不动），
    // 否则会出现「计划说执行了、实际被忽略」的错位。要重排就显式给 index。
    const chain = ancestorsOf(root, source.topic.id)
    if (chain[chain.length - 1] === destination.topic.id && args.index === undefined) {
      return fail(
        `「${source.topic.title}」本来就在「${destination.topic.title}」下面，这次没有改动。`
      )
    }
    const rawIndex = args.index
    const index =
      typeof rawIndex === 'number' && Number.isFinite(rawIndex)
        ? Math.max(0, Math.round(rawIndex))
        : null
    return {
      ok: true,
      intent: { kind: 'move', id: source.topic.id, targetId: destination.topic.id, index },
      summary: `移动「${source.topic.title}」到「${destination.topic.title}」下`,
      destructive: false
    }
  }

  if (name === 'moveTopics') {
    // 批量移动：整理大导图的正路。
    // 100 条里错 1 条就整批退回 = 烧掉整整一轮（模型重写 100 条 JSON），
    // 所以这里是**跳过容错**：能执行的执行，解析失败的精确列出来让模型补一次即可。
    const raw = args.moves
    if (!Array.isArray(raw) || raw.length === 0) return fail('moves 必须是非空的数组。')
    if (raw.length > 200) return fail('一次最多移动 200 个主题，更多请分批调用。')

    const moves: Array<{ id: string; targetId: string; index: number | null }> = []
    const skipped: string[] = []
    for (let position = 0; position < raw.length; position += 1) {
      const item = raw[position]
      if (!isRecord(item)) {
        skipped.push(`moves[${position}]（不是对象）`)
        continue
      }
      const sourceAddress = typeof item.address === 'string' ? item.address.trim() : ''
      if (sourceAddress.length === 0) {
        skipped.push(`moves[${position}]（缺 address）`)
        continue
      }
      const source = resolveTopicAddress(root, sourceAddress)
      if (!source.ok) {
        skipped.push(`moves[${position}]「${sourceAddress}」`)
        continue
      }
      const targetAddress = typeof item.toAddress === 'string' ? item.toAddress.trim() : ''
      if (targetAddress.length === 0) {
        skipped.push(`moves[${position}]（缺 toAddress）`)
        continue
      }
      const destination = resolveTopicAddress(root, targetAddress)
      if (!destination.ok) {
        skipped.push(`moves[${position}] 的目标「${targetAddress}」`)
        continue
      }
      if (source.resolved.topic.id === destination.resolved.topic.id) {
        skipped.push(`moves[${position}]（目标是它自己）`)
        continue
      }
      if (subtreeContains(source.resolved.topic, destination.resolved.topic.id)) {
        skipped.push(`moves[${position}]（目标是它自己的子孙）`)
        continue
      }
      if (source.resolved.topic.position && args.allowMoved !== true) {
        skipped.push(`moves[${position}]「${source.resolved.topic.title}」（用户手动摆过位置）`)
        continue
      }
      const rawIndex = item.index
      const slot =
        typeof rawIndex === 'number' && Number.isFinite(rawIndex)
          ? Math.max(0, Math.round(rawIndex))
          : null
      moves.push({
        id: source.resolved.topic.id,
        targetId: destination.resolved.topic.id,
        index: slot
      })
    }

    if (moves.length === 0) {
      return fail(
        `没有一条能执行。${skipped.length > 0 ? `原因：${skipped.slice(0, 6).join('；')}。` : ''}` +
          '可以用 searchNodes 搜到正确的标题后再补一次调用。'
      )
    }
    const skippedNote =
      skipped.length > 0
        ? `（跳过 ${skipped.length} 条没执行：${skipped.slice(0, 4).join('；')}${skipped.length > 4 ? '…' : ''}）`
        : ''
    return {
      ok: true,
      intent: { kind: 'moveMany', moves, requested: raw.length },
      summary: `批量移动 ${moves.length} 个主题${skippedNote}`,
      destructive: false
    }
  }

  if (name === 'setCollapsed') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.collapsed !== 'boolean') return fail('collapsed 必须是 true 或 false。')
    const rawSide = args.side
    if (rawSide === undefined) {
      return {
        ok: true,
        intent: { kind: 'collapse', id: target.topic.id, collapsed: args.collapsed },
        summary: `${args.collapsed ? '折叠' : '展开'}「${target.topic.title}」`,
        destructive: false
      }
    }
    if (rawSide !== 'left' && rawSide !== 'right') {
      return fail('side 只能是 left 或 right（不传就是整体折叠 / 展开）。')
    }
    /**
     * 按侧收起只对「思维导图（平衡 / 顺时针）的中心主题」成立。
     * 这里如实拒绝并给出下一步，而不是悄悄退化成整体折叠——后者会让模型以为
     * 「只收了左边」，而用户看到整张图都塌了。
     */
    if (splitFoldSidesOf(root, target.topic.id === root.id).length < 2) {
      return fail(
        'side 只对「思维导图（平衡 / 顺时针）的中心主题」有效（该结构下左右两边都挂着分支）。' +
          '逻辑图 / 时间轴 / 鱼骨图 / 矩阵图等请去掉 side 做整体折叠。'
      )
    }
    const label = FOLD_SIDE_LABELS[rawSide]
    return {
      ok: true,
      intent: { kind: 'collapse', id: target.topic.id, collapsed: args.collapsed, side: rawSide },
      summary: `${args.collapsed ? '收起' : '展开'}「${target.topic.title}」的${label}侧分支`,
      destructive: false
    }
  }

  if (name === 'setNotes') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.text !== 'string') return fail('text 必须是字符串。')
    const text = args.text
    return {
      ok: true,
      intent: { kind: 'notes', id: target.topic.id, text },
      summary:
        text.trim().length === 0
          ? `清空「${target.topic.title}」的备注`
          : `给「${target.topic.title}」写备注（${text.trim().length} 字）`,
      destructive: false
    }
  }

  if (name === 'setCode') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.text !== 'string') return fail('text 必须是字符串。')
    const text = args.text
    if (text.trim().length === 0) {
      return {
        ok: true,
        intent: { kind: 'code', id: target.topic.id, code: null },
        summary: `移除「${target.topic.title}」的代码块`,
        destructive: false
      }
    }
    const language = stringArg(args, 'language')
    return {
      ok: true,
      intent: {
        kind: 'code',
        id: target.topic.id,
        code: { language: language.length > 0 ? language : 'text', text }
      },
      summary: `给「${target.topic.title}」写代码块（${language.length > 0 ? language : 'text'}）`,
      destructive: false
    }
  }

  if (name === 'setFormula') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.formula !== 'string') return fail('formula 必须是字符串。')
    // 模型常常好心地把公式包在 $…$ 里，这里替它剥掉（与公式输入框的处理一致）
    const formula = args.formula
      .trim()
      .replace(/^\$\$?/, '')
      .replace(/\$\$?$/, '')
      .trim()
    return {
      ok: true,
      intent: { kind: 'formula', id: target.topic.id, formula },
      summary:
        formula.length === 0
          ? `移除「${target.topic.title}」的公式`
          : `给「${target.topic.title}」写公式`,
      destructive: false
    }
  }

  if (name === 'askUser') {
    const question = stringArg(args, 'question')
    if (question.length === 0) return fail('question 不能为空。')
    const rawOptions = args.options
    const options = Array.isArray(rawOptions)
      ? rawOptions
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(0, 5)
      : []
    return {
      ok: true,
      intent: { kind: 'ask', question, options },
      summary: `提问：${question.length > 24 ? `${question.slice(0, 24)}…` : question}`,
      destructive: false
    }
  }

  if (name === 'addRelationship') {
    const from = typeof args.from === 'string' ? args.from : ''
    const to = typeof args.to === 'string' ? args.to : ''
    const source = resolveTopicAddress(root, from)
    if (!source.ok) return fail(source.error)
    const target = resolveTopicAddress(root, to)
    if (!target.ok) return fail(target.error)
    if (source.resolved.topic.id === target.resolved.topic.id) {
      return fail('关系线两端不能是同一个主题。')
    }
    const label = typeof args.label === 'string' ? args.label.trim() : ''
    const fromTitle = source.resolved.topic.title
    const toTitle = target.resolved.topic.title
    return {
      ok: true,
      intent: {
        kind: 'relationship',
        ends: [source.resolved.topic.id, target.resolved.topic.id],
        label: `${fromTitle} → ${toTitle}`,
        title: label.length > 0 ? label : null
      },
      summary: `连关系线：${fromTitle} → ${toTitle}`,
      destructive: false
    }
  }

  if (name === 'addBoundary' || name === 'addSummary') {
    const rawList = args.addresses
    const list = Array.isArray(rawList)
      ? rawList.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
    if (list.length === 0) return fail('addresses 至少要给一个主题。')
    const topicIds: string[] = []
    const titles: string[] = []
    for (const item of list) {
      const resolved = resolveTopicAddress(root, item)
      if (!resolved.ok) return fail(resolved.error)
      topicIds.push(resolved.resolved.topic.id)
      titles.push(resolved.resolved.topic.title)
    }
    const title =
      typeof args.title === 'string' && args.title.trim().length > 0 ? args.title.trim() : null
    const shown = titles.join('、')
    const isBoundary = name === 'addBoundary'
    return {
      ok: true,
      intent: { kind: isBoundary ? 'boundary' : 'summary', topicIds, label: shown, title },
      summary: `${isBoundary ? '加边界' : '加概要'}：${shown}`,
      destructive: false
    }
  }

  if (name === 'setAttachmentTitle') {
    const target = readAttachmentKind(args.target)
    if (!target) return fail('target 只能是 relationship / boundary / summary。')
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0) return fail('缺少 id：请先用 listAttachments 拿到元素 id。')
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    return {
      ok: true,
      intent: { kind: 'attachmentTitle', target, id, title },
      summary: `改${ATTACHMENT_LABEL[target]}文字：${title.length > 0 ? title : '（清空）'}`,
      destructive: false
    }
  }

  if (name === 'removeAttachment') {
    const target = readAttachmentKind(args.target)
    if (!target) return fail('target 只能是 relationship / boundary / summary。')
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0) return fail('缺少 id：请先用 listAttachments 拿到元素 id。')
    return {
      ok: true,
      intent: { kind: 'attachmentRemove', target, id, label: ATTACHMENT_LABEL[target] },
      summary: `删除${ATTACHMENT_LABEL[target]}（id=${id}）`,
      // 破坏性：交给渲染层先问一次用户
      destructive: destructiveOf('attachmentRemove')
    }
  }

  if (name === 'setMarkers') {
    const address = typeof args.address === 'string' ? args.address : ''
    const resolved = resolveTopicAddress(root, address)
    if (!resolved.ok) return fail(resolved.error)
    const rawList = args.markers
    const list = Array.isArray(rawList)
      ? rawList
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : []
    const unknown = list.filter((markerId) => !(markerId in MARKER_LABELS))
    if (unknown.length > 0) {
      return fail(
        `不认识的标记 id：${unknown.join('、')}。可用 id 见 listAttachments 返回的清单，不要自己编。`
      )
    }
    /**
     * 同一行（同一类别）只能有一个。这里**明确拒绝并说明**，而不是替它挑一个：
     * 悄悄丢掉一个的话，模型会以为"两个都设上了"，下一轮还会这么给——
     * 而它在界面上看到的结果和它的意图不一致，只会越改越乱。
     */
    const byGroup = new Map<string, string[]>()
    for (const markerId of list) {
      const group = markerGroupOf(markerId)
      if (group === null) continue
      byGroup.set(group, [...(byGroup.get(group) ?? []), markerId])
    }
    const conflict = [...byGroup.entries()].find(([, ids]) => ids.length > 1)
    if (conflict) {
      return fail(
        `同一类别的标记只能有一个：「${conflict[0]}」里给了 ${conflict[1].join('、')}，请只保留一个再调用。`
      )
    }
    const title = resolved.resolved.topic.title
    return {
      ok: true,
      intent: { kind: 'markers', id: resolved.resolved.topic.id, markerIds: list },
      summary: `设置标记（${title}）：${list.length > 0 ? list.join('、') : '清空'}`,
      destructive: false
    }
  }

  if (name === 'addLabel' || name === 'removeLabel') {
    const address = typeof args.address === 'string' ? args.address : ''
    const resolved = resolveTopicAddress(root, address)
    if (!resolved.ok) return fail(resolved.error)
    const label = typeof args.label === 'string' ? args.label.trim() : ''
    if (label.length === 0) return fail('label 不能为空。')
    const add = name === 'addLabel'
    return {
      ok: true,
      intent: { kind: 'label', id: resolved.resolved.topic.id, label, add },
      summary: `${add ? '加' : '去'}标签（${resolved.resolved.topic.title}）：${label}`,
      destructive: false
    }
  }

  if (name === 'setStructure') {
    const raw = stringArg(args, 'structure')
    const structureClass = resolveStructureId(raw)
    if (structureClass === null) {
      return fail(
        `不认识的结构「${raw}」。可选：${STRUCTURES.filter((s) => s.supported)
          .map((s) => `${s.label}（${s.class}）`)
          .join('、')}`
      )
    }
    // 不填 address = 整张图（改中心主题的结构），与界面上点「结构」下拉的效果一致
    const address = stringArg(args, 'address')
    /**
     * 结构是**整张画布**的属性（＝中心主题上的一个字段）：只接受空地址或中心主题本身。
     *
     * 为什么拒绝"只改某一支"：那会在数据里写下子节点的 structureClass，
     * 布局随即把那一支交给别的家族排，画面变成"主干对、下面那截乱"（一棵树混着几套结构）。
     * 工具栏的「结构▾」已经收成只作用于中心主题，两边口径必须一致。
     */
    if (address.length > 0) {
      const resolved = resolveTopicAddress(root, address)
      if (!resolved.ok) return fail(resolved.error)
      if (resolved.resolved.topic.id !== root.id) {
        return fail(
          `结构是整张画布的属性，不能只改「${resolved.resolved.topic.title}」这一支。` +
            '要改就改中心主题（address 留空）。'
        )
      }
    }
    const label = STRUCTURES.find((s) => s.class === structureClass)?.label ?? structureClass
    return {
      ok: true,
      intent: { kind: 'structure', id: root.id, structureClass },
      summary: `把整张画布的结构改成${label}`,
      destructive: false
    }
  }

  if (name === 'sortSiblings') {
    const address = stringArg(args, 'address')
    let parent = root
    if (address.length > 0) {
      const resolved = resolveTopicAddress(root, address)
      if (!resolved.ok) return fail(resolved.error)
      parent = resolved.resolved.topic
    }
    if (parent.children.length < 2) {
      return fail(`「${parent.title}」下面只有 ${parent.children.length} 个子主题，不需要排序。`)
    }
    const by = stringArg(args, 'by') === 'length' ? 'length' : 'title'
    const desc = stringArg(args, 'order') === 'desc'
    const ordered = [...parent.children].sort((left, right) => {
      const base =
        by === 'length'
          ? left.title.length - right.title.length
          : left.title.localeCompare(right.title, 'zh-Hans-CN', {
              numeric: true,
              sensitivity: 'base'
            })
      // 同键时按 id 兜底：顺序稳定，用户重复调用不会每次都变
      return (desc ? -base : base) || left.id.localeCompare(right.id)
    })
    return {
      ok: true,
      intent: {
        kind: 'sortChildren',
        id: parent.id,
        orderedIds: ordered.map((topic) => topic.id),
        renumber: args.renumber === true
      },
      summary:
        `按${by === 'length' ? '标题长度' : '标题'}${desc ? '倒序' : '正序'}排列「${parent.title}」的 ` +
        `${ordered.length} 个子主题${args.renumber === true ? '，并重新编号' : ''}`,
      destructive: false
    }
  }

  if (name === 'mergeDuplicates') {
    const scopeArg = stringArg(args, 'scope')
    let base = root
    if (scopeArg.length > 0) {
      const resolved = resolveTopicAddress(root, scopeArg)
      if (!resolved.ok) return fail(resolved.error)
      base = resolved.resolved.topic
    }
    const rawTitles = Array.isArray(args.titles) ? args.titles : []
    const wanted = rawTitles
      .filter((title): title is string => typeof title === 'string' && title.trim().length > 0)
      .map((title) => normalizeTopicTitle(title))

    const groups = duplicateGroups(base).filter(
      (group) => wanted.length === 0 || wanted.includes(normalizeTopicTitle(group.title))
    )
    if (groups.length === 0) {
      return fail('没有找到可合并的同名主题（可以先调 findDuplicates 看看）。')
    }

    const planned: Array<{ keepId: string; mergeIds: string[] }> = []
    let nested = 0
    for (const group of groups) {
      const topics = group.ids
        .map((id) => findTopic(root, id))
        .filter((topic): topic is Topic => topic !== null)
      // 组内存在祖先/后代关系时合并会搬出一个环：跳过并如实说明
      const hasNesting = topics.some((left) =>
        topics.some((right) => left.id !== right.id && isSelfOrDescendant(root, left.id, right.id))
      )
      if (hasNesting) {
        nested += 1
        continue
      }
      // 保留"内容最全"的那个；同分时保留层级更浅的（信息更容易被找到）
      const ranked = [...topics].sort(
        (left, right) =>
          contentScore(right) - contentScore(left) ||
          ancestorsOf(root, left.id).length - ancestorsOf(root, right.id).length
      )
      const keeper = ranked[0]
      if (!keeper) continue
      planned.push({ keepId: keeper.id, mergeIds: ranked.slice(1).map((topic) => topic.id) })
    }
    if (planned.length === 0) {
      return fail(
        `${groups.length} 组同名主题之间都存在父子包含关系（比如「成本」下面还有「成本」），` +
          '合并会把子节点搬进自己的祖先里——请先手动调整结构再用它。'
      )
    }
    const removed = planned.reduce((sum, item) => sum + item.mergeIds.length, 0)
    return {
      ok: true,
      intent: { kind: 'dedupe', groups: planned },
      summary:
        `合并 ${planned.length} 组同名主题：保留内容最全的那个，删掉多余 ${removed} 个` +
        (nested > 0 ? `（另有 ${nested} 组因存在父子包含关系被跳过）` : ''),
      destructive: destructiveOf('dedupe')
    }
  }

  return fail('不是可用的写工具。')
}

/** 挑「保留哪一个」用的内容量：子树越大越全；同规模时看有没有备注/代码/公式 */
function contentScore(topic: Topic): number {
  return (
    countTopicTree(topic) * 100 +
    (topic.notes && topic.notes.trim().length > 0 ? 10 : 0) +
    (topic.code ? 5 : 0) +
    (topic.formula ? 3 : 0)
  )
}

/** 结构 id 的宽松解析：完整 class、中文名、或点号后缀都能认 */
function resolveStructureId(input: string): string | null {
  const value = input.trim()
  if (value.length === 0) return null
  const supported = STRUCTURES.filter((structure) => structure.supported)
  const lower = value.toLowerCase()
  const hit =
    supported.find((structure) => structure.class === value) ??
    supported.find((structure) => structure.label === value) ??
    supported.find((structure) => structure.class.toLowerCase().endsWith(`.${lower}`))
  return hit ? hit.class : null
}
