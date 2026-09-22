/**
 * 自检域：testAgentTools / testAttachmentTools / testWriteToolsAndTurn / testAi（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
 *
 * 域文件**不能从入口 import**（入口要调用域函数，会成环），
 * 所以共用助手一律从 `../helpers`、断言原语从 `../harness` 取。
 */

/**
 * 编辑器内核自检。
 *
 * 这里不测 UI，只测「不依赖浏览器」的核心逻辑：
 * 状态操作、撤销重做、节点移动与循环保护、复制粘贴、折叠、
 * .xmind 往返保真、布局引擎、以及各种边界情况。
 *
 * 运行：npm run selfcheck
 */

import { withFoldedSides } from '../../../src/shared/model/tree'
import { createTopic } from '../../../src/shared/model/factory'
import {
  buildChatSystemPrompt,
  accumulateToolCalls,
  CONTINUATION_MIN_OVERLAP,
  createRepetitionGuard,
  createThinkingFilter,
  DEGENERATION_MAX_REPEAT,
  extractStreamDelta,
  finalizeToolCalls,
  isTruncatedFinish,
  joinContinuation,
  mergeContinuation,
  toWireMessages
} from '../../../src/shared/ai'
import {
  AGENT_ALL_TOOLS,
  AGENT_CANVAS_TOOL_NAMES,
  AGENT_MAX_ROUNDS,
  AGENT_MAX_TOOL_CALLS,
  AGENT_WRITE_TOOLS,
  canContinueAgentLoop,
  DESTRUCTIVE_WRITE_KINDS,
  DESTRUCTIVE_WRITE_LABELS,
  isDestructiveWriteKind,
  isMutatingIntent,
  isReadToolName,
  normalizeConfirmSkip,
  planAvailableTools,
  planWriteTool,
  resolveTopicAddress,
  runReadTool,
  shortHandleOf,
  type ToolContext
} from '../../../src/shared/agent'
import { DEFAULT_APP_SETTINGS } from '../../../src/shared/ipc'

import {
  DEFAULT_AI_CONFIG,
  buildDocumentChunkMessages,
  buildDocumentMergeMessages,
  buildDocumentOutlineMessages,
  chatCompletionsUrl,
  describeAiError,
  extractContent,
  normalizeAiConfig,
  outlineToTopic,
  parseOutline,
  toConfigView
} from '../../../src/shared/ai'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, group } from '../harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import { store, root, sheet, find, reset, addChildOf } from '../helpers'

/* ---- D1 拆分：域 testInit/testAddAndCommit/testCommitGuard/testCommitAndAdd/testUndoRedo/testDelete/testMove/testMoveMany 搬进 ./selfcheck/domains/edit.ts ---- */

/* ---- D1 拆分：域 testSortAndDedupe/testNodeDrag/testCollapseSelection/testUndoGranularity/testStructureIsCanvasLevel/testUndoSelectionAndRelayout 搬进 ./selfcheck/domains/canvas.ts ---- */

/* ---- D1 拆分：域 testOverlayReserve/testIncrementalLayout/testLayoutNoOverlap/testLayout/testStructures/testOverlays/testOverlayToggles 搬进 ./selfcheck/domains/layout.ts ---- */

/* ---- D1 拆分：域 testAiChatHelpers/testAgentHelpers/testLicenseHelpers 搬进 ./selfcheck/domains/ai.ts ---- */

export function testAgentTools(): void {
  /** 对象比较统一转 JSON 串，避免依赖断言器的深比较行为 */
  const json = (value: unknown): string => JSON.stringify(value) ?? 'undefined'

  group('Agent：工具调用的流式分片')

  const chunkLine =
    '{"model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"searchNodes","arguments":"{\\"que"}}]},"finish_reason":null}]}'
  const parsed = extractStreamDelta(chunkLine)
  eq('从分片里解析出工具调用', parsed?.toolCalls.length, 1)
  eq('分片里的函数名', parsed?.toolCalls[0]?.name, 'searchNodes')
  eq(
    '普通文本分片不带工具调用',
    extractStreamDelta('{"choices":[{"delta":{"content":"嗨"}}]}')?.toolCalls.length,
    0
  )
  eq(
    '结束原因能取到',
    extractStreamDelta('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}')?.finishReason,
    'tool_calls'
  )

  group('AI：截断判据与续写拼接')

  eq('length 判为被截断', isTruncatedFinish('length'), true)
  eq('大小写与空格也认（各服务商写法不统一）', isTruncatedFinish(' Length '), true)
  eq('stop 不算截断', isTruncatedFinish('stop'), false)
  eq('tool_calls 不算截断', isTruncatedFinish('tool_calls'), false)
  eq(
    '拿不到结束原因时不判截断（宁可漏判，也不平白多发一次付费请求）',
    isTruncatedFinish(null),
    false
  )

  /**
   * 续写拼接：这是「自动续写」唯一的启发式，坏掉的后果是**静默**的
   * （多出半句话节点、或某一行悄悄消失），所以每条结局都钉住。
   *
   * 核心约束：**只在能确认模型重写了那一行时才丢掉它**。
   * 因为「最后一行写完没有」这个信息不在字符串里——同样两段文本，
   * 可能是「模型在补完残行」，也可能是「模型另起一行」。
   */
  const fragment = '- 乙：内存泄漏排查（重'
  const completed = '- 乙：内存泄漏排查（重点看堆快照）'

  eq('最短重叠是 6 字', CONTINUATION_MIN_OVERLAP, 6)
  eq(
    '加长版：判定为 extended（模型在补完这一行）',
    mergeContinuation(`- 甲\n${fragment}`, completed).relation,
    'extended'
  )
  eq(
    '加长版：只留模型重写的那一行（内容没丢——它就在新文本里）',
    joinContinuation(`- 甲\n${fragment}`, `${completed}\n- 丙`),
    `- 甲\n${completed}\n- 丙`
  )

  /**
   * 下面两条是**原缺陷的正向验证**（改前是反着断言"已知限制"的）：
   * 以前无条件丢掉前一段的尾行，于是「截断正好落在行尾」时会静默少一个节点。
   */
  eq(
    '尾行完整且模型另起一行：两行都保留（以前会丢掉尾行）',
    joinContinuation('- 甲\n- 乙', '- 丙\n- 丁'),
    '- 甲\n- 乙\n- 丙\n- 丁'
  )
  eq('两行无关时关系记为 fresh', mergeContinuation('- 甲\n- 乙', '- 丙').relation, 'fresh')
  eq(
    '尾行完整且被逐字重发：保留一份（以前两份都丢，等于少一个节点）',
    joinContinuation('- 甲\n- 乙', '- 乙\n- 丙'),
    '- 甲\n- 乙\n- 丙'
  )
  eq(
    '残片被逐字重发：两份都去掉（残片不构成内容）',
    joinContinuation('- 甲\n- 乙（半句', '- 乙（半句\n- 丙'),
    '- 甲\n- 丙'
  )
  eq(
    '重写但没保持前缀：两份都留（宁可看得见重复，也不静默丢内容）',
    joinContinuation('- 甲\n- 乙（半句', '- 乙写成完整的一行\n- 丙'),
    '- 甲\n- 乙（半句\n- 乙写成完整的一行\n- 丙'
  )
  eq(
    '重叠太短的兄弟节点不会被误判成"同一行"（缓存 / 缓存策略）',
    joinContinuation('- 缓存', '- 缓存策略'),
    '- 缓存\n- 缓存策略'
  )

  eq(
    '前一段正好以换行结尾：不误丢最后一行完整内容',
    joinContinuation('- 甲\n- 乙\n', '- 丙'),
    '- 甲\n- 乙\n- 丙'
  )
  eq('尾行为空时关系记为 none', mergeContinuation('- 甲\n', '- 丙').relation, 'none')
  eq('续写什么都没返回时，不去动前一段的尾行', joinContinuation('- 甲\n- 乙', ''), '- 甲\n- 乙')
  eq('前段为空时续写直接接上', joinContinuation('', '- 甲'), '- 甲')

  const joined = joinContinuation('- 甲\n- 乙（半', '- 丙\n- 丁')
  eq('拼接缝上不会出现重复行', joined.split('\n').length, new Set(joined.split('\n')).size)
  check(
    '拼接结果里不会留下空行',
    joined.split('\n').every((line) => line.length > 0),
    joined
  )
  /**
   * 去重只发生在**拼接缝**上（前段最后一行 vs 续写第一行），**不做全局去重**：
   * 同级出现两个同名主题完全合法（比如两个「其他」），
   * 全局去重会把用户真要的节点合掉——比留一行重复更糟。
   */
  eq(
    '续写内部出现的同名行不会被合掉（那是模型的合法输出）',
    joinContinuation('- 甲\n- 乙（半', '- 丙\n- 丙').split('\n').length,
    4
  )

  group('AI：思维链直播')

  eq(
    'reasoning_content 能取到',
    extractStreamDelta('{"choices":[{"delta":{"reasoning_content":"想"}}]}')?.reasoning,
    '想'
  )
  eq(
    '普通文本分片的 reasoning 为空串',
    extractStreamDelta('{"choices":[{"delta":{"content":"嗨"}}]}')?.reasoning,
    ''
  )
  eq(
    '同一分片里 content 与 reasoning 各归各',
    (() => {
      const delta = extractStreamDelta(
        '{"choices":[{"delta":{"content":"答","reasoning_content":"想"}}]}'
      )
      return delta ? `${delta.text}/${delta.reasoning}` : ''
    })(),
    '答/想'
  )
  {
    // `<think>` 混在 content 里的模型：气泡拿不到它，直播通道拿得到
    const thinkPieces: string[] = []
    const filter = createThinkingFilter((piece) => thinkPieces.push(piece))
    const visible = [
      filter.push('答'),
      filter.push('<thi'),
      filter.push('nk>想'),
      filter.push('</th'),
      filter.push('ink>完'),
      filter.flush()
    ].join('')
    eq('标签被切成两半也能滤干净', visible, '答完')
    eq('滤掉的思维链进直播通道', thinkPieces.join(''), '想')
  }
  {
    // 不传回调时行为与从前完全一致（纯过滤）
    const plain = createThinkingFilter()
    eq('不传回调时依旧只过滤', [plain.push('a<think>b</think>c'), plain.flush()].join(''), 'ac')
  }

  group('AI：退化循环熔断')

  eq('门槛是 10 次连续重复', DEGENERATION_MAX_REPEAT, 10)
  {
    const guard = createRepetitionGuard(5)
    eq('正常内容不触发', guard('- 甲\n- 乙\n- 丙\n'), false)
    eq('同样的行没到门槛不触发', guard('- 重复行\n- 重复行\n- 重复行\n- 重复行\n'), false)
    eq(
      '同一行连续达到门槛即触发',
      guard('- 重复行\n- 重复行\n- 重复行\n- 重复行\n- 重复行\n'),
      true
    )
    eq('触发后持续返回 true（调用方应当停读）', guard('- 重复行\n'), true)
  }
  eq(
    '半行跨片也能累计（分片任意位置断开）',
    (() => {
      const g = createRepetitionGuard(3)
      g('- 循\n')
      g('- 循环\n')
      g('- 循环\n')
      return g('- 循环\n')
    })(),
    true
  )
  eq(
    '不同行会重置计数（重置后未到新门槛不触发）',
    (() => {
      const g = createRepetitionGuard(4)
      g('- 甲\n')
      g('- 甲\n\n')
      g('- 甲\n')
      g('- 乙\n')
      return g('- 甲\n- 甲\n')
    })(),
    false
  )

  group('AI：写工具描述的内容约束')

  // insertSubtree 是**写**工具，在 ALL 清单里（只读清单 AGENT_TOOLS 里没有它）
  const insertTool = AGENT_ALL_TOOLS.find((tool) => tool.name === 'insertSubtree')
  check(
    'insertSubtree 工具描述明确禁用备注行',
    (insertTool?.description ?? '').includes('不要用 `> `')
  )
  check('insertSubtree 要求节点自带信息量', (insertTool?.description ?? '').includes('自带信息量'))

  // 参数是**跨片拼起来的**：一次覆盖式赋值只会拿到半截 JSON
  const step1 = accumulateToolCalls(
    [],
    [{ index: 0, id: 'c1', name: 'searchNodes', argumentsText: '{"que' }]
  )
  const step2 = accumulateToolCalls(step1, [{ index: 0, argumentsText: 'ry":"成本"}' }])
  eq('参数分片是追加而不是覆盖', step2[0]?.argumentsText, '{"query":"成本"}')
  eq('id 与函数名保留（后续分片不带它们）', `${step2[0]?.id}/${step2[0]?.name}`, 'c1/searchNodes')

  const parallel = accumulateToolCalls(
    [],
    [
      { index: 0, id: 'a', name: 'getDocStats' },
      { index: 1, id: 'b', name: 'getSelection' }
    ]
  )
  eq('并行两个调用各就各位', parallel.length, 2)
  eq('第二个调用的 id 正确', parallel[1]?.id, 'b')
  eq(
    '没拿到名字的空槽在收尾时丢掉',
    finalizeToolCalls([{ id: 'x', name: '', argumentsText: '' }]).length,
    0
  )

  group('Agent：请求体的线格式')

  const wire = toWireMessages([
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'getDocStats', argumentsText: '{}' }]
    },
    { role: 'tool', toolCallId: 'c1', content: '结果' }
  ])
  eq('工具结果用 tool_call_id 关联', json(wire[2]?.tool_call_id), json('c1'))
  eq('助手消息带 tool_calls 数组', Array.isArray(wire[1]?.tool_calls), true)
  const calls = wire[1]?.tool_calls as Array<Record<string, unknown>> | undefined
  const fn = calls?.[0]?.function as Record<string, unknown> | undefined
  eq('参数以字符串形态传（协议要求）', json(fn?.arguments), json('{}'))
  eq('没有工具调用的消息保持原样', json(wire[0]?.content), json('你好'))

  group('Agent：寻址解析')

  // 中心 ─ 成本 ─ 人力 / 物料；另有一支也叫「人力」——专门用来测「重名必须问清」
  const root = createTopic('中心主题')
  const cost = createTopic('成本')
  const labor = createTopic('人力')
  const material = createTopic('物料')
  const otherLabor = createTopic('人力')
  cost.children.push(labor, material)
  root.children.push(cost, otherLabor)

  const byId = resolveTopicAddress(root, labor.id)
  eq('按 id 解析（最可靠的写法）', byId.ok && byId.resolved.topic.id === labor.id, true)
  const byPath = resolveTopicAddress(root, '中心主题/成本/物料')
  eq('按标题路径解析', byPath.ok && byPath.resolved.topic.id === material.id, true)
  eq(
    '路径解析出完整标题链',
    json(byPath.ok ? byPath.resolved.path : []),
    json(['中心主题', '成本', '物料'])
  )
  const withoutRoot = resolveTopicAddress(root, '成本/人力')
  eq('路径可省略开头的中心主题', withoutRoot.ok && withoutRoot.resolved.topic.id === labor.id, true)

  // 模型很爱把文档名 / 中心主题也写进路径开头（真事：「AI 测试Mind/CART树/相关算法/…」）
  const withDocName = resolveTopicAddress(root, '我的文档/中心主题/成本/物料')
  eq(
    '开头多写了文档名也能解析',
    withDocName.ok && withDocName.resolved.topic.id === material.id,
    true
  )
  const skipTwo = resolveTopicAddress(root, '某文档/某中间层/成本/物料')
  eq('最多允许跳过开头两段', skipTwo.ok && skipTwo.resolved.topic.id === material.id, true)

  const deepFail = resolveTopicAddress(root, '中心主题/成本/物料/不存在')
  eq('走到底再失败仍然报错', deepFail.ok, false)
  check(
    '失败时列出「这一层有哪些子主题」，模型能自己纠正',
    !deepFail.ok && deepFail.error.includes('「物料」下面没有子主题'),
    deepFail.ok ? '' : deepFail.error
  )

  const ambiguous = resolveTopicAddress(root, '人力')
  eq('重名标题**不硬选**，直接报错', ambiguous.ok, false)
  check('重名报错里给出候选路径', !ambiguous.ok && ambiguous.error.includes('成本/人力'))
  const missing = resolveTopicAddress(root, '预算')
  eq('找不到时也报错', missing.ok, false)
  check('找不到时给出可读原因（提示去搜）', !missing.ok && missing.error.includes('searchNodes'))
  eq('路径走到断点时报错', resolveTopicAddress(root, '中心主题/不存在').ok, false)
  eq('空 address 报错', resolveTopicAddress(root, '   ').ok, false)

  group('Agent：只读工具')

  const context: ToolContext = {
    root,
    selectedId: labor.id,
    sheetCount: 2,
    sheet: {
      id: 'sheet-1',
      title: '画布 1',
      rootTopic: root,
      relationships: [],
      boundaries: [],
      summaries: []
    }
  }

  group('Agent：第二批写工具（关系线 / 边界 / 概要 / 标记 / 标签）')

  /** 本组助手：把参数对象直接交给 planWriteTool（root 就是上面那棵 5 节点树） */
  const plan = (name: string, args: Record<string, unknown>) =>
    planWriteTool(name, JSON.stringify(args), root)

  const relation = plan('addRelationship', { from: '成本/人力', to: '成本/物料' })
  check(
    '连关系线：解析成 relationship 意图',
    relation.ok && relation.intent.kind === 'relationship'
  )
  check(
    '关系线两端解析成真实 id',
    relation.ok && relation.intent.kind === 'relationship' && relation.intent.ends.length === 2
  )
  check(
    '关系线摘要写出两端标题',
    relation.summary.includes('人力') && relation.summary.includes('物料')
  )
  check('两端不能是同一个主题', plan('addRelationship', { from: '成本', to: '成本' }).ok === false)

  const boundary = plan('addBoundary', { addresses: ['成本/人力', '成本/物料'], title: '两块一起' })
  check('加边界：解析成 boundary 意图', boundary.ok && boundary.intent.kind === 'boundary')
  check(
    '边界的标题原样带上',
    boundary.ok && boundary.intent.kind === 'boundary' && boundary.intent.title === '两块一起'
  )
  check(
    '边界不带标题时为 null（不是空串）',
    (() => {
      const r = plan('addBoundary', { addresses: ['成本/人力'] })
      return r.ok && r.intent.kind === 'boundary' && r.intent.title === null
    })()
  )
  check('addresses 为空被拦下', plan('addBoundary', { addresses: [] }).ok === false)

  const summary = plan('addSummary', { addresses: ['成本/人力'] })
  check('加概要：解析成 summary 意图', summary.ok && summary.intent.kind === 'summary')

  const markers = plan('setMarkers', { address: '成本/人力', markers: ['priority-1', 'task-done'] })
  check('设置标记：解析成 markers 意图', markers.ok && markers.intent.kind === 'markers')
  check(
    '标记是「整体替换」语义（数量与传入一致）',
    markers.ok && markers.intent.kind === 'markers' && markers.intent.markerIds.length === 2
  )
  const sameGroup = plan('setMarkers', {
    address: '成本/人力',
    markers: ['priority-1', 'priority-3']
  })
  check('同一类别给多个 → 明确拒绝（不是替模型挑一个）', sameGroup.ok === false)
  check(
    '拒绝时说清原因（模型才能改对）',
    !sameGroup.ok && sameGroup.error.includes('只能有一个'),
    sameGroup.ok ? '' : sameGroup.error
  )
  const bogusMarker = plan('setMarkers', { address: '成本/人力', markers: ['不存在的标记'] })
  check('乱编的 markerId 被拒绝', bogusMarker.ok === false)
  check(
    '拒绝时告诉模型去哪查清单（不自己编）',
    !bogusMarker.ok && bogusMarker.error.includes('listAttachments'),
    bogusMarker.ok ? '' : bogusMarker.error
  )

  const label = plan('addLabel', { address: '成本/人力', label: '重点' })
  check('加标签：add=true', label.ok && label.intent.kind === 'label' && label.intent.add === true)
  const unlabel = plan('removeLabel', { address: '成本/人力', label: '重点' })
  check(
    '去标签：add=false',
    unlabel.ok && unlabel.intent.kind === 'label' && unlabel.intent.add === false
  )

  check(
    '改元素文字：按 id 走（元素没有标题可寻址）',
    (() => {
      const r = plan('setAttachmentTitle', {
        target: 'boundary',
        id: 'boundary-1',
        title: '新标题'
      })
      return r.ok && r.intent.kind === 'attachmentTitle' && r.intent.id === 'boundary-1'
    })()
  )
  check(
    '元素种类不认识时被拦下',
    plan('setAttachmentTitle', { target: 'nope', id: 'x', title: '' }).ok === false
  )
  check(
    '缺 id 时提醒去 listAttachments 拿',
    (() => {
      const r = plan('removeAttachment', { target: 'boundary' })
      return !r.ok && r.error.includes('listAttachments')
    })()
  )

  const removeAttachment = plan('removeAttachment', { target: 'relationship', id: 'rel-1' })
  check(
    '删元素：解析成 attachmentRemove',
    removeAttachment.ok && removeAttachment.intent.kind === 'attachmentRemove'
  )
  check(
    '**删元素标记为破坏性**（渲染层据此先问用户）',
    removeAttachment.ok && removeAttachment.destructive === true
  )
  check('加元素不是破坏性（不该打扰用户）', relation.ok && relation.destructive === false)

  const attachments = runReadTool('listAttachments', '{}', context)
  check('列元素：空画布如实说明', attachments.content.includes('还没有关系线'))
  check(
    '列元素带上可用标记清单（模型不查就会自己编）',
    attachments.content.includes('priority-1=优先级 1')
  )
  check(
    '列元素：过滤用的 address 解析失败时给可读原因',
    (() => {
      const r = runReadTool('listAttachments', '{"address":"不存在的主题"}', context)
      return !r.ok && r.content.includes('searchNodes')
    })()
  )

  check(
    '第二批工具已注册进写工具清单',
    AGENT_WRITE_TOOLS.some((tool) => tool.name === 'addRelationship') &&
      AGENT_WRITE_TOOLS.some((tool) => tool.name === 'setMarkers')
  )
  check(
    '闸门关闭时第二批工具同样不下发（工具即权限边界）',
    planAvailableTools(false).every((tool) => tool.name !== 'addRelationship')
  )
  check(
    '只读清单里能看见 listAttachments',
    planAvailableTools(false).some((tool) => tool.name === 'listAttachments')
  )

  group('Agent：计划工具（updatePlan，只读）')

  {
    const planned = runReadTool(
      'updatePlan',
      JSON.stringify({ steps: ['读结构', '建分支', '补解释', '自检'], done: 1 }),
      context
    )
    eq('计划工具执行成功', planned.ok, true)
    check('回显已完成 / 总步数', planned.content.includes('完成 1/4'), planned.content)
    check('已完成的打勾', planned.content.includes('✓ 1. 读结构'), planned.content)
    check('当前这一步标出来', planned.content.includes('▶ 2. 建分支'), planned.content)
    check('未开始的留白', planned.content.includes('· 3. 补解释'), planned.content)
    check('告诉它当前该做哪一步', planned.content.includes('当前这一步：建分支'), planned.content)
    check('摘要带上进度', planned.summary.includes('1/4'), planned.summary)

    const finished = runReadTool(
      'updatePlan',
      JSON.stringify({ steps: ['A', 'B'], done: 2 }),
      context
    )
    check('全部完成时提示去做最后自检', finished.content.includes('最后自检'), finished.content)
    const overDone = runReadTool(
      'updatePlan',
      JSON.stringify({ steps: ['A', 'B'], done: 99 }),
      context
    )
    check('done 超出步数会被夹住（不出现 2/2 之外的怪数字）', overDone.content.includes('完成 2/2'))

    const emptyPlan = runReadTool('updatePlan', JSON.stringify({ steps: [] }), context)
    eq('空计划被拒绝', emptyPlan.ok, false)
    check('并给出正确用法', emptyPlan.content.includes('2~6 步'), emptyPlan.content)
  }

  group('Agent：覆盖度自检（findIncompleteNodes）')

  {
    /** 一棵「有备注的 / 没备注的 / 带代码的 / 叶子」都有的小树，覆盖四种命中情况 */
    const root = createTopic('中心主题')
    const branchA = createTopic('分支甲')
    const withNotes = createTopic('有解释的')
    withNotes.notes = '这里是解释'
    const withoutNotes = createTopic('缺解释的')
    const withCode = createTopic('有代码的')
    withCode.notes = '也有解释'
    withCode.code = { language: 'ts', text: 'const a = 1' }
    branchA.children.push(withNotes, withoutNotes, withCode)
    const branchB = createTopic('分支乙')
    const lonelyLeaf = createTopic('光杆节点')
    branchB.children.push(lonelyLeaf)
    root.children.push(branchA, branchB)
    const treeContext: ToolContext = {
      root,
      selectedId: null,
      sheetCount: 1,
      sheet: {
        id: 'sheet-notes',
        title: '画布',
        rootTopic: root,
        relationships: [],
        boundaries: [],
        summaries: []
      }
    }

    const missingNotes = runReadTool('findIncompleteNodes', '{}', treeContext)
    eq('默认查缺备注', missingNotes.ok, true)
    // 7 个节点里，有备注的只有「有解释的」「有代码的」两个 → 命中 5 个
    check('报出命中数与总数', missingNotes.content.includes('命中 5 个'), missingNotes.content)
    check('总节点数也报出来', missingNotes.content.includes('共 7 个节点'), missingNotes.content)
    check('命中项带句柄（可直接拿去补）', missingNotes.content.includes('[#'), missingNotes.content)
    check(
      '带路径（知道在哪一支）',
      missingNotes.content.includes('路径：中心主题 → 分支甲'),
      missingNotes.content
    )
    check(
      '按分支汇总（先补漏得最多的那一支）',
      missingNotes.content.includes('按分支汇总'),
      missingNotes.content
    )

    const scoped = runReadTool(
      'findIncompleteNodes',
      JSON.stringify({ missing: 'notes', scope: '分支甲' }),
      treeContext
    )
    check('scope 能限定某一支', scoped.content.includes('「分支甲」这一支'), scoped.content)
    check('限定后只算这一支的节点', scoped.content.includes('共 4 个节点'), scoped.content)

    const leaves = runReadTool(
      'findIncompleteNodes',
      JSON.stringify({ missing: 'children' }),
      treeContext
    )
    check('查叶子节点', leaves.content.includes('是叶子'), leaves.content)

    const codes = runReadTool(
      'findIncompleteNodes',
      JSON.stringify({ missing: 'code' }),
      treeContext
    )
    check('查缺代码块', codes.content.includes('缺代码块'), codes.content)

    // 全都有解释时要说"没漏"，而不是给一份空清单让模型自己猜
    const allNoted = createTopic('中心')
    allNoted.notes = '中心主题的说明'
    const noted = createTopic('都有解释')
    noted.notes = '解释'
    allNoted.children.push(noted)
    const clean = runReadTool('findIncompleteNodes', '{}', {
      root: allNoted,
      selectedId: null,
      sheetCount: 1,
      sheet: {
        id: 'sheet-clean',
        title: '画布',
        rootTopic: allNoted,
        relationships: [],
        boundaries: [],
        summaries: []
      }
    })
    check('没有漏的就说清楚', clean.content.includes('没有漏的'), clean.content)
  }

  group('Agent：读会话文档（readDocument）')

  {
    const sheetOf = (rootTopic: typeof root): ToolContext['sheet'] => ({
      id: 'sheet-doc',
      title: '画布',
      rootTopic,
      relationships: [],
      boundaries: [],
      summaries: []
    })
    const docContext: ToolContext = {
      root,
      selectedId: null,
      sheetCount: 1,
      sheet: sheetOf(root),
      documents: [
        {
          name: '报告.md',
          text: '第一行：背景\n第二行：性能优化是关键\n第三行：结论如下\n第四行：性能优化要分批'
        },
        { name: '笔记.txt', text: '只有一句话' }
      ]
    }

    const noDocs = runReadTool('readDocument', '{}', {
      root,
      selectedId: null,
      sheetCount: 1,
      sheet: sheetOf(root)
    })
    eq('没有挂文档时如实说', noDocs.ok, false)
    check('并告诉用户怎么挂', noDocs.content.includes('拖进聊天面板'), noDocs.content)

    const ambiguous = runReadTool('readDocument', '{}', docContext)
    eq('有多份文档时不猜', ambiguous.ok, false)
    check(
      '把可选的文档列出来',
      ambiguous.content.includes('报告.md') && ambiguous.content.includes('笔记.txt'),
      ambiguous.content
    )

    const byName = runReadTool('readDocument', JSON.stringify({ name: '报告' }), docContext)
    check(
      '可以按名字读（支持只写一部分）',
      byName.ok && byName.content.includes('报告.md'),
      byName.content
    )

    const byQuery = runReadTool(
      'readDocument',
      JSON.stringify({ name: '报告.md', query: '性能优化' }),
      docContext
    )
    check(
      '按关键词查带行号',
      byQuery.content.includes('2|') && byQuery.content.includes('4|'),
      byQuery.content
    )
    check('命中处的上下文行一起给', byQuery.content.includes('背景'), byQuery.content)

    const missQuery = runReadTool(
      'readDocument',
      JSON.stringify({ name: '报告.md', query: '根本不存在的东西' }),
      docContext
    )
    check(
      '查不到就说查不到（并给下一步）',
      missQuery.content.includes('没有找到'),
      missQuery.content
    )

    const slice = runReadTool('readDocument', JSON.stringify({ name: '报告.md' }), docContext)
    check('不填 query 时按区间给一段', slice.content.includes('第 0~'), slice.content)
    check('结尾如实说明（这一份短）', slice.content.includes('已到末尾'), slice.content)

    // 长文档：默认只给一段，并提示后面还有（否则模型以为看到的就是全部）
    const longContext: ToolContext = {
      ...docContext,
      // 比默认的 6000 字一段更长：应当只给一段、并说还有更多
      documents: [{ name: '长文.txt', text: '段'.repeat(7000) }]
    }
    const longSlice = runReadTool('readDocument', '{}', longContext)
    check(
      '长文档默认只给一段（6000 字）',
      longSlice.content.includes('第 0~6000 字'),
      longSlice.content.slice(0, 80)
    )
    check(
      '并提示后面还有更多',
      longSlice.content.includes('还有更多'),
      longSlice.content.slice(0, 120)
    )
  }

  group('Agent：查重（findDuplicates）')

  {
    const dup = createTopic('中心')
    dup.children.push(
      createTopic('性能优化'),
      createTopic('性能优化！'),
      createTopic('性能优化（补充）'),
      createTopic('缓存策略')
    )
    const dupContext: ToolContext = {
      root: dup,
      selectedId: null,
      sheetCount: 1,
      sheet: {
        id: 'sheet-dup',
        title: '画布',
        rootTopic: dup,
        relationships: [],
        boundaries: [],
        summaries: []
      }
    }
    const report = runReadTool('findDuplicates', '{}', dupContext)
    check('标点与「（补充）」差异也算同名', report.content.includes('×3'), report.content)
    check('每个成员都给句柄', (report.content.match(/\[#/g) ?? []).length >= 3, report.content)
    check('提示下一步可以合并', report.content.includes('mergeDuplicates'), report.content)

    const clean = runReadTool('findDuplicates', '{}', {
      ...dupContext,
      root: createTopic('孤零零')
    })
    check('没有重复就说清楚', clean.content.includes('没有发现同名'), clean.content)
  }

  const stats = runReadTool('getDocStats', '{}', context)
  check('文档概况含节点总数', stats.content.includes('节点总数：5'))
  check('文档概况含画布数', stats.content.includes('画布数：2'))
  check('文档概况的摘要是给用户看的', stats.summary.includes('5 个节点'))

  const selection = runReadTool('getSelection', '{}', context)
  check('读选中含路径', selection.content.includes('中心主题 → 成本 → 人力'))
  eq(
    '没有选中时如实说明（不编造）',
    runReadTool('getSelection', '{}', { ...context, selectedId: null }).content.includes(
      '没有选中'
    ),
    true
  )

  const found = runReadTool('searchNodes', '{"query":"料"}', context)
  eq('搜索命中', found.ok, true)
  check('搜索结果带路径', found.content.includes('中心主题 → 成本 → 物料'))
  check(
    '搜索无命中也不报错（只是没有结果）',
    runReadTool('searchNodes', '{"query":"不存在的词"}', context).content.includes('没有找到')
  )

  const subtree = runReadTool('getSubtree', '{"address":"成本","depth":1}', context)
  check(
    '读子树给出缩进大纲',
    subtree.content.includes('- [#') && subtree.content.includes('] 人力')
  )
  check('子节点一并列出', subtree.content.includes('] 物料'))
  check('每行都带句柄（模型据此寻址）', /- \[#[0-9a-z]+\] /.test(subtree.content))

  eq('未知工具被拒但可读', runReadTool('dropDatabase', '{}', context).ok, false)
  eq(
    '参数不是合法 JSON 时给可纠正的提示',
    runReadTool('searchNodes', '{"query"', context).content.includes('合法 JSON'),
    true
  )
  eq('缺必填参数时报错', runReadTool('getSubtree', '{}', context).ok, false)
  eq(
    '正常结果不会被截断',
    runReadTool('getDocStats', '{}', context).content.includes('截断'),
    false
  )

  group('Agent：循环上限')

  // 用户要求「一句命令生成 100+ 节点的完整图」之后放的：
  // 一次详细生成 = 读骨架 + 按分支分批 insertSubtree + 补解释 + 收尾，十几个轮次起步
  eq('轮数上限 40（够一次详细生成走完所有分支）', AGENT_MAX_ROUNDS, 40)
  eq('调用次数上限 200（100+ 节点的分批写入 + 补充）', AGENT_MAX_TOOL_CALLS, 200)
  eq('刚起步可以继续', canContinueAgentLoop(0, 0).ok, true)
  eq('到轮数上限就停', canContinueAgentLoop(AGENT_MAX_ROUNDS, 0).ok, false)
  check(
    '停下时给出原因（不是静默）',
    canContinueAgentLoop(AGENT_MAX_ROUNDS, 0).reason.includes('轮')
  )
  eq('到调用次数上限就停', canContinueAgentLoop(0, AGENT_MAX_TOOL_CALLS).ok, false)
  eq(
    '刚好在上限之前还能继续',
    canContinueAgentLoop(AGENT_MAX_ROUNDS - 1, AGENT_MAX_TOOL_CALLS - 1).ok,
    true
  )
}

export function testAttachmentTools(): void {
  group('画布元素：AI 用的 store 动作')

  reset()
  const rootId = root().id
  const first = addChildOf(rootId, '甲')
  const second = addChildOf(rootId, '乙')

  const relation = store().connectTopics(first, second)
  eq('连关系线返回 id', typeof relation === 'string', true)
  eq(
    '再连一次复用原来那条（幂等：模型重试不会删线）',
    store().connectTopics(first, second),
    relation
  )
  eq('画布上只有一条关系线', sheet().relationships.length, 1)
  eq('两端指向正确', sheet().relationships[0]?.end2Id, second)
  eq('不能自连', store().connectTopics(first, first), null)
  eq('不存在的 id 不生效', store().connectTopics(first, 'no-such-topic'), null)

  const boundary = store().addBoundaryFor([first, second], '两块')
  eq('加边界返回 id', typeof boundary === 'string', true)
  eq('同区间再加复用（幂等）', store().addBoundaryFor([first, second]), boundary)
  eq('边界标题按传入写入', sheet().boundaries[0]?.title, '两块')
  eq('画布上只有一个边界', sheet().boundaries.length, 1)
  // 注意：buildRange 会把能规整的输入（跨级、乱序）自己规整掉，所以"不同级"不是失败条件。
  // 真正圈不出范围的是**空列表**——这个必须挡住，否则会往画布上塞一个空边界。
  eq('空列表圈不成范围', store().addBoundaryFor([]), null)
  eq('空列表也加不了概要', store().addSummaryFor([]), null)

  eq('加概要返回 id', typeof store().addSummaryFor([first, second]), 'string')
  eq('概要默认标题是「概要」', sheet().summaries[0]?.title, '概要')

  store().setMarkers(first, ['priority-1', 'task-done'])
  eq('设置标记', find(first)?.markers.length, 2)
  store().setMarkers(first, ['priority-2'])
  eq('再设置是**整体替换**（不是 toggle 追加）', find(first)?.markers.length, 1)
  eq('替换后的 id 正确', find(first)?.markers[0]?.markerId, 'priority-2')
  store().setMarkers(first, ['priority-1', 'priority-3', 'star-red'])
  eq(
    '整体替换也按「每行一个」收敛（同组只留第一个）',
    find(first)?.markers.map((marker) => marker.markerId),
    ['priority-1', 'star-red']
  )
  store().setMarkers(first, [])
  eq('传空数组就是清空', find(first)?.markers.length, 0)

  check('这些动作都进了撤销栈（与用户操作同一条管道）', store().undoStack.length > 0)
  reset()
}

export function testWriteToolsAndTurn(): void {
  group('Agent：写工具的意图规划')

  // 工具数量是**纪律**：太多模型会选错（规划里定的「单批 ≤ 12 个」）。
  // 改这个数字必须是有意的——所以用等值断言钉死，而不是 `>=`。
  eq(
    '写工具一共 21 个（+setStructure / sortSiblings / mergeDuplicates）',
    AGENT_WRITE_TOOLS.length,
    21
  )
  eq('全部工具 = 读 10 + 写 21', AGENT_ALL_TOOLS.length, 31)

  // 计划工具与覆盖度自检是**只读**的：不碰画布、也不该消耗试用回合
  check('updatePlan 是只读工具', isReadToolName('updatePlan'))
  check('findIncompleteNodes 是只读工具', isReadToolName('findIncompleteNodes'))
  check('findDuplicates 是只读工具（只看不改）', isReadToolName('findDuplicates'))
  check('readDocument 是只读工具', isReadToolName('readDocument'))
  check('exportOutline 是只读工具（导出不改画布）', isReadToolName('exportOutline'))
  check('sortSiblings 是写工具', !isReadToolName('sortSiblings'))
  check('mergeDuplicates 是写工具', !isReadToolName('mergeDuplicates'))
  check('setStructure 是写工具', !isReadToolName('setStructure'))
  check(
    '「真正改画布」的工具名里没有 askUser（只提问不该消耗试用回合）',
    !AGENT_CANVAS_TOOL_NAMES.includes('askUser')
  )
  check('但包含 setStructure', AGENT_CANVAS_TOOL_NAMES.includes('setStructure'))

  // 注意别把这个变量叫 root：会遮蔽上面那个 root() 助手
  const tree = createTopic('中心主题')
  const cost = createTopic('成本')
  const labor = createTopic('人力')
  const material = createTopic('物料')
  cost.children.push(labor, material)
  tree.children.push(cost)

  const plan = (name: string, args: Record<string, unknown>): ReturnType<typeof planWriteTool> =>
    planWriteTool(name, JSON.stringify(args), tree)
  /** 取「是不是破坏性操作」；规划失败时按 false 处理（失败的断言在别处） */
  const destructiveOf = (p: ReturnType<typeof planWriteTool>): boolean =>
    p.ok ? p.destructive : false

  /**
   * 自由摆放的子主题**也算子孙**。
   *
   * plan-write 原来用的是本文件私有的 `subtreeContains`（只走 `topic.children`），
   * 于是"把主题移进它自己的浮动子主题下面"会被放行，而 store 与拖拽那边一律拦住
   * （它们用共用的 `isSelfOrDescendant`）——AI 写路径成了唯一缺口，真执行下去会把树接成环。
   */
  {
    const floating = createTopic('浮动想法')
    cost.detachedChildren.push(floating)
    const intoFloating = plan('moveTopic', { address: '成本', toAddress: '成本/浮动想法' })
    check(
      '不能把主题移进自己的浮动子主题下（口径与 store / 拖拽统一）',
      intoFloating.ok === false && intoFloating.error.includes('子孙'),
      intoFloating.ok ? '竟然通过了' : intoFloating.error
    )
    cost.detachedChildren.length = 0
  }

  group('Agent：同级排序（sortSiblings）')

  {
    // tree = 中心主题 → 成本 →（人力 / 物料）
    const sorted = plan('sortSiblings', { address: '成本', renumber: true })
    check('排序规划成功', sorted.ok, sorted.ok ? '' : sorted.error)
    check(
      '给出排好的子主题顺序',
      sorted.ok && sorted.intent.kind === 'sortChildren'
        ? sorted.intent.orderedIds.length === 2
        : false
    )
    check(
      '编号标记传下去了',
      sorted.ok && sorted.intent.kind === 'sortChildren' && sorted.intent.renumber === true
    )
    eq('不算破坏性操作', destructiveOf(sorted), false)

    const noKids = plan('sortSiblings', { address: '人力' })
    eq('子主题不足两个时拒绝', noKids.ok, false)
    check(
      '并说明原因',
      !noKids.ok && noKids.error.includes('不需要排序'),
      noKids.ok ? '' : noKids.error
    )
  }

  group('Agent：合并同名（mergeDuplicates）')

  {
    const dupRoot = createTopic('中心主题')
    const rich = createTopic('性能优化')
    rich.notes = '有解释'
    rich.children.push(createTopic('减少重排'))
    const poor = createTopic('性能优化！')
    const nestedParent = createTopic('缓存')
    nestedParent.children.push(createTopic('缓存'))
    dupRoot.children.push(rich, poor, nestedParent)

    const merged = planWriteTool('mergeDuplicates', '{}', dupRoot)
    check('合并规划成功', merged.ok, merged.ok ? '' : merged.error)
    check('标成破坏性（会删节点，界面先问用户）', merged.ok && merged.destructive === true)
    check(
      '保留内容最全的那个',
      merged.ok && merged.intent.kind === 'dedupe'
        ? merged.intent.groups[0]?.keepId === rich.id
        : false
    )
    check(
      '父子同名那组被跳过并如实说明',
      merged.ok && merged.summary.includes('跳过'),
      merged.ok ? merged.summary : ''
    )
    const filtered = planWriteTool(
      'mergeDuplicates',
      JSON.stringify({ titles: ['根本没有这个标题'] }),
      dupRoot
    )
    eq('titles 过滤后没得合并就报错', filtered.ok, false)
  }

  group('Agent：切换结构（setStructure）')

  {
    const structPlan = plan('setStructure', { structure: 'org.xmind.ui.fishbone.leftHeaded' })
    eq('结构规划成功', structPlan.ok, true)
    check(
      '意图带着结构 id',
      structPlan.ok &&
        structPlan.intent.kind === 'structure' &&
        structPlan.intent.structureClass === 'org.xmind.ui.fishbone.leftHeaded',
      structPlan.ok ? structPlan.summary : structPlan.error
    )
    check('摘要写清改成了什么结构', structPlan.ok && structPlan.summary.includes('结构改成'))
    eq('不算破坏性操作（不该弹确认）', destructiveOf(structPlan), false)

    check('中文名也能认（用户说的是「鱼骨图」）', plan('setStructure', { structure: '鱼骨图' }).ok)
    check('点号后缀也能认', plan('setStructure', { structure: 'timeline' }).ok === false)
    const bad = plan('setStructure', { structure: '不存在的结构' })
    eq('不认识的结构被拒', bad.ok, false)
    check('并列出可选值', !bad.ok && bad.error.includes('可选'), bad.ok ? '' : bad.error)

    // 结构是**画布级**属性：只接受不填 address（= 中心主题）
    check(
      '不填 address 时改的是中心主题',
      structPlan.ok && structPlan.intent.kind === 'structure'
        ? structPlan.intent.id === tree.id
        : false
    )
    /**
     * 填了某一支 → **明确拒绝**。
     *
     * 以前这里是"只改那一支"，于是数据里会留下子节点的 structureClass，
     * 布局把那一支交给别的家族排——画面变成"主干对、下面那截乱"。
     * 现在结构与「结构▾」都只作用于中心主题，两边口径一致。
     */
    const scopedStruct = plan('setStructure', {
      structure: 'org.xmind.ui.logic.right',
      address: '成本'
    })
    eq('填了某一支被拒绝', scopedStruct.ok, false)
    check(
      '拒绝时说清"结构属于整张画布"',
      !scopedStruct.ok && scopedStruct.error.includes('整张画布'),
      scopedStruct.ok ? scopedStruct.summary : scopedStruct.error
    )
    const rootAddress = plan('setStructure', {
      structure: 'org.xmind.ui.logic.right',
      address: '中心主题'
    })
    check('address 明确写成中心主题仍然可以', rootAddress.ok)
  }

  const rename = plan('renameTopic', { address: '中心主题/成本/人力', title: '人力成本' })
  eq('改名规划成功', rename.ok, true)
  check(
    '改名指向正确节点',
    rename.ok && rename.intent.kind === 'rename' && rename.intent.id === labor.id
  )
  check('改名摘要给人看', rename.summary.includes('人力') && rename.summary.includes('人力成本'))
  eq('改名不算破坏性', destructiveOf(plan('renameTopic', { address: '成本', title: 'X' })), false)

  const bad = plan('renameTopic', { address: '找不到的', title: 'X' })
  eq('地址无效时规划失败', bad.ok, false)
  check('失败原因可读（要能回喂给模型）', !bad.ok && bad.error.includes('searchNodes'))
  eq('title 类型不对被拦下', plan('renameTopic', { address: '成本', title: 5 }).ok, false)

  const insert = plan('insertSubtree', { address: '成本', outline: '- 预算\n  - 人力\n  - 物料' })
  eq('插入子树规划成功', insert.ok, true)
  check('插入带上节点数', insert.ok && insert.intent.kind === 'insert' && insert.intent.count === 3)
  check(
    '插入摘要有层级说明',
    insert.summary.includes('预算') && insert.summary.includes('3 个节点')
  )
  eq('outline 为空被拦下', plan('insertSubtree', { address: '成本', outline: '   ' }).ok, false)

  // 这两条是「新主题」垃圾节点的回归断言：模型给并列的多行时，
  // 解析器会套一个壳，写工具必须**把壳剥掉**，让那些行成为并列的新主题
  const multi = plan('insertSubtree', { address: '成本', outline: '- 甲\n- 乙\n- 丙' })
  check(
    '并列多行 → 多个同级新主题',
    multi.ok && multi.intent.kind === 'insert' && multi.intent.nodes.length === 3
  )
  check(
    '**不会**凭空多出壳节点（每一条都是模型给的那几行）',
    multi.ok &&
      multi.intent.kind === 'insert' &&
      multi.intent.nodes.every((node) => ['甲', '乙', '丙'].includes(node.title))
  )
  check(
    '并列插入的摘要列出主题',
    multi.summary.includes('3 个主题') && multi.summary.includes('甲')
  )

  const nested = plan('insertSubtree', { address: '成本', outline: '- 预算\n  - 人力' })
  check(
    '单根带子树 → 只插一个（保留它自己的层级）',
    nested.ok && nested.intent.kind === 'insert' && nested.intent.nodes.length === 1
  )
  check(
    '单根时标题就是模型给的标题',
    nested.ok && nested.intent.kind === 'insert' && nested.intent.nodes[0]?.title === '预算'
  )

  // 防「照抄已有内容」：整理 / 归类时模型爱用新增「重写一遍」，结果在画布上复制出一份
  // （真出过事故），所以这条必须硬拦，不能只靠提示词
  const copyTry = plan('insertSubtree', {
    address: '成本',
    outline: '- 成本\n- 人力\n- 物料\n- 中心主题\n- 成本\n- 人力'
  })
  eq('把已有内容重写一遍会被拦下', copyTry.ok, false)
  check(
    '拦截说明点出「重复内容」并指向 moveTopics',
    !copyTry.ok && copyTry.error.includes('重复内容') && copyTry.error.includes('moveTopics'),
    copyTry.ok ? '' : copyTry.error
  )
  eq(
    '确实要同名新增时带 allowDuplicate 放行',
    plan('insertSubtree', {
      address: '成本',
      outline: '- 成本\n- 人力\n- 物料\n- 中心主题\n- 成本\n- 人力',
      allowDuplicate: true
    }).ok,
    true
  )
  eq(
    '真正的新内容不受影响（少量撞名不算复制）',
    plan('insertSubtree', { address: '成本', outline: '- 全新甲\n- 全新乙\n- 人力' }).ok,
    true
  )

  const del = plan('deleteTopic', { address: '成本' })
  eq('删除是破坏性操作（要确认）', destructiveOf(del), true)
  check('删除摘要带上影响范围', del.summary.includes('3 个节点'))

  /**
   * 破坏性操作清单是**唯一来源**：规划层的 destructive 标记、渲染层确认框、
   * 「不再询问」记住的范围、设置界面里可撤销的清单，全都从它取。
   *
   * 它掉链子的方式是**静默**的：清单漏一种 → 那种操作不问就执行；
   * 标签漏一种 → 确认框里显示 "undefined"；脏数据没清 → 确认框被永久关掉。
   */
  eq(
    '破坏性种类共六种（三种无条件 + 清空/删减备注、代码、公式）',
    DESTRUCTIVE_WRITE_KINDS.length,
    6
  )
  check(
    '每种破坏性操作都有中文名（确认框与设置里要用）',
    DESTRUCTIVE_WRITE_KINDS.every((kind) => DESTRUCTIVE_WRITE_LABELS[kind].trim().length > 0)
  )
  eq('删主题在清单里', isDestructiveWriteKind('delete'), true)
  eq('改名不在清单里（不该弹确认）', isDestructiveWriteKind('rename'), false)
  eq(
    '脏数据被清掉：只认清单里的种类，并去重',
    normalizeConfirmSkip(['delete', '不存在的种类', 3, null, 'delete']).join(','),
    'delete'
  )
  eq('不是数组时当空清单处理', normalizeConfirmSkip('delete').length, 0)
  eq('默认配置不跳过任何确认（第一次必须问）', DEFAULT_APP_SETTINGS.aiConfirmSkip.length, 0)
  eq('notes 在清单里（设置面板自动多出三项）', isDestructiveWriteKind('notes'), true)
  eq('code 在清单里', isDestructiveWriteKind('code'), true)
  eq('formula 在清单里', isDestructiveWriteKind('formula'), true)
  eq(
    '不再询问清单能收下这三项，脏数据仍被清掉',
    normalizeConfirmSkip(['notes', 'code', 'formula', 'bad']).join(','),
    'notes,code,formula'
  )

  group('Agent：D-13 清空型写操作按内容变少确认')
  {
    cost.notes = '原文备注有二十个字符，不能静默丢掉。'
    const shrinkNotes = plan('setNotes', { address: '成本', text: '变短' })
    check('备注覆盖后变短 → 标成破坏性', shrinkNotes.ok && shrinkNotes.destructive === true)
    const emptyNotes = plan('setNotes', { address: '成本', text: '  ' })
    check('备注传空 → 标成破坏性', emptyNotes.ok && emptyNotes.destructive === true)
    const freshNotes = plan('setNotes', { address: '物料', text: '这是全新写入的备注内容' })
    check('原本没有备注时正常写新内容 → 不确认', freshNotes.ok && freshNotes.destructive === false)

    cost.code = { language: 'ts', text: 'const answer = 42\n// 一段必须保留的代码' }
    const removeCode = plan('setCode', { address: '成本', text: '' })
    check('移除已有代码块 → 标成破坏性', removeCode.ok && removeCode.destructive === true)
    const freshCode = plan('setCode', { address: '物料', text: 'const x = 1' })
    check('原本没有代码块时写新代码 → 不确认', freshCode.ok && freshCode.destructive === false)

    cost.formula = 'E = mc^2'
    const removeFormula = plan('setFormula', { address: '成本', formula: '' })
    check('移除已有公式 → 标成破坏性', removeFormula.ok && removeFormula.destructive === true)
    const freshFormula = plan('setFormula', { address: '物料', formula: 'a^2+b^2=c^2' })
    check('原本没有公式时写新公式 → 不确认', freshFormula.ok && freshFormula.destructive === false)

    cost.notes = undefined
    cost.code = undefined
    cost.formula = undefined
  }

  const move = plan('moveTopic', { address: '成本/物料', toAddress: '中心主题' })
  eq('移动规划成功', move.ok, true)
  eq('移动不算破坏性', destructiveOf(move), false)
  // 空操作要如实说：否则「已改好」的报告背后什么都没变，用户会以为 AI 在糊弄
  eq(
    '同父级 + 没给位置＝空操作（与 store 的 moveNode 语义一致）',
    plan('moveTopic', { address: '成本/物料', toAddress: '成本' }).ok,
    false
  )
  eq(
    '同父级 + 显式 index＝重排，照常放行',
    plan('moveTopic', { address: '成本/物料', toAddress: '成本', index: 0 }).ok,
    true
  )
  // `null` 也是「没指定位置」：模型常把不指定写成 null，
  // store 的 moveNode 同样把 null 当追加到末尾——两边口径必须一致
  eq(
    '同父级 + index: null＝同样是空操作（不被报成已移动）',
    plan('moveTopic', { address: '成本/物料', toAddress: '成本', index: null }).ok,
    false
  )
  eq('改同名＝空操作', plan('renameTopic', { address: '成本', title: '成本' }).ok, false)
  check(
    '空操作的说明写明「没有改动」',
    (() => {
      const r = plan('renameTopic', { address: '成本', title: '成本' })
      return !r.ok && r.error.includes('没有')
    })()
  )
  eq('真正的改名照常放行', plan('renameTopic', { address: '成本', title: '成本预算' }).ok, true)
  eq('不能移到自己下面', plan('moveTopic', { address: '成本', toAddress: '成本' }).ok, false)
  eq('不能移到自己的子孙下面', plan('moveTopic', { address: '成本', toAddress: '人力' }).ok, false)

  // 自由摆放的地盘：用户手动摆过位置的主题，AI 默认不许挪
  // （改别人的版面比改内容更招人烦，撤得回来也撤不掉火气）
  material.position = { x: 120, y: -40 }
  const pinned = plan('moveTopic', { address: '成本/物料', toAddress: '中心主题' })
  eq('手动摆过位置的节点默认不许移动', pinned.ok, false)
  check(
    '拒绝时告诉模型下一步怎么做（带 allowMoved 再来一次）',
    !pinned.ok && pinned.error.includes('allowMoved'),
    pinned.ok ? '' : pinned.error
  )
  eq(
    '明确许可后才允许移动（用户确实要求重排时）',
    plan('moveTopic', { address: '成本/物料', toAddress: '中心主题', allowMoved: true }).ok,
    true
  )
  material.position = undefined

  // 批量移动：整理大导图的正路（一次调用搬很多节点，调用上限按「调用」算不按节点算）
  const batch = plan('moveTopics', {
    moves: [
      { address: '成本/物料', toAddress: '中心主题' },
      { address: '成本/人力', toAddress: '中心主题', index: 0 }
    ]
  })
  eq('批量移动规划成功', batch.ok, true)
  check(
    '意图里带着每一条移动',
    batch.ok && batch.intent.kind === 'moveMany' && batch.intent.moves.length === 2
  )
  check('摘要说的是批量', batch.summary.includes('批量移动 2 个'))
  eq('空数组被拦下', plan('moveTopics', { moves: [] }).ok, false)
  eq(
    '超过 200 条被拦下',
    plan('moveTopics', {
      moves: Array.from({ length: 201 }, () => ({ address: '成本/物料', toAddress: '中心主题' }))
    }).ok,
    false
  )

  // 跳过容错：100 条里错 1 条就整批退回 = 烧掉一轮，所以能执行的执行、失败的列出来
  const partial = plan('moveTopics', {
    moves: [{ address: '成本/物料', toAddress: '中心主题' }, { toAddress: '中心主题' }]
  })
  eq('坏条目被跳过而不是整批失败', partial.ok, true)
  check(
    '能执行的那条照常在意图里',
    partial.ok && partial.intent.kind === 'moveMany' && partial.intent.moves.length === 1
  )
  check(
    '要求的总数如实记录（模型能对上账）',
    partial.ok && partial.intent.kind === 'moveMany' && partial.intent.requested === 2
  )
  check(
    '摘要里说明跳过了哪条',
    partial.summary.includes('跳过 1 条') && partial.summary.includes('moves[1]')
  )

  check(
    '全军覆没时也要给下一步指引',
    (() => {
      const r = plan('moveTopics', { moves: [{ address: '不存在的东西', toAddress: '成本' }] })
      return !r.ok && r.error.includes('moves[0]') && r.error.includes('searchNodes')
    })()
  )

  // 手动定位保护对批量同样生效
  material.position = { x: 3, y: 4 }
  eq(
    '批量里含手动定位节点默认整批拒绝',
    plan('moveTopics', { moves: [{ address: '成本/物料', toAddress: '中心主题' }] }).ok,
    false
  )
  eq(
    '整批带上 allowMoved 才放行',
    plan('moveTopics', {
      moves: [{ address: '成本/物料', toAddress: '中心主题' }],
      allowMoved: true
    }).ok,
    true
  )
  material.position = undefined

  // 句柄寻址：大导图里同名标题能出现几十次（「创建 socket.socket()」这类），
  // 按标题永远不可能唯一——模型靠读工具打出的句柄定位（一回合整理完的关键）
  const dupA = createTopic('创建 socket.socket()')
  const dupB = createTopic('创建 socket.socket()')
  tree.children.push(dupA, dupB)
  eq(
    '同名标题按标题寻址确实歧义（真实场景）',
    resolveTopicAddress(tree, '创建 socket.socket()').ok,
    false
  )
  const byHandleA = resolveTopicAddress(tree, `#${shortHandleOf(dupA.id)}`)
  eq('按句柄能精确命中其中一个', byHandleA.ok && byHandleA.resolved.topic.id === dupA.id, true)
  const byHandleB = resolveTopicAddress(tree, shortHandleOf(dupB.id))
  eq('句柄不带 # 也认', byHandleB.ok && byHandleB.resolved.topic.id === dupB.id, true)
  check(
    '批量移动可以全用句柄（重名不再是障碍）',
    (() => {
      const r = plan('moveTopics', {
        moves: [
          { address: `#${shortHandleOf(dupA.id)}`, toAddress: '成本' },
          { address: `#${shortHandleOf(dupB.id)}`, toAddress: '成本' }
        ]
      })
      return r.ok && r.intent.kind === 'moveMany' && r.intent.moves.length === 2
    })()
  )
  const readContext: ToolContext = {
    root: tree,
    selectedId: null,
    sheetCount: 1,
    sheet: {
      id: 'sheet-2',
      title: '画布 1',
      rootTopic: tree,
      relationships: [],
      boundaries: [],
      summaries: []
    }
  }
  check(
    '子树读取把句柄打在每行前面',
    runReadTool(
      'getSubtree',
      JSON.stringify({ address: '中心主题', depth: 1 }),
      readContext
    ).content.includes(`[#${shortHandleOf(dupA.id)}]`)
  )
  check(
    '搜索结果也带句柄',
    runReadTool('searchNodes', JSON.stringify({ query: 'socket' }), readContext).content.includes(
      `[#${shortHandleOf(dupA.id)}]`
    )
  )
  // 清掉，别影响后面的断言
  tree.children = tree.children.filter((child) => child.id !== dupA.id && child.id !== dupB.id)

  // 标题里**本身带斜杠**的节点：编程笔记一抓一把（「class A: /A ()」），
  // 路径解析必然走不通——以前直接报错返回，这类节点对 AI 完全不可见
  // （真踩过：python 笔记整理卡在 3 个带斜杠的标题上，模型绕了好几轮都没绕过去）
  material.title = 'class类名: /class类名 ()'
  const slashed = resolveTopicAddress(tree, 'class类名: /class类名 ()')
  eq('标题带斜杠也能按整串标题解析', slashed.ok && slashed.resolved.topic.id === material.id, true)
  check(
    '批量移动同样吃这条解析',
    (() => {
      const r = plan('moveTopics', {
        moves: [{ address: 'class类名: /class类名 ()', toAddress: '成本' }]
      })
      return r.ok && r.intent.kind === 'moveMany' && r.intent.moves.length === 1
    })()
  )
  material.title = '物料'

  eq('折叠必须给布尔值', plan('setCollapsed', { address: '成本', collapsed: 'yes' }).ok, false)
  check(
    '折叠摘要可读',
    plan('setCollapsed', { address: '成本', collapsed: true }).summary.includes('折叠')
  )
  check(
    '备注为空即清空',
    plan('setNotes', { address: '成本', text: '  ' }).summary.includes('清空')
  )
  check('代码块为空即移除', plan('setCode', { address: '成本', text: '' }).summary.includes('移除'))

  group('Agent：按侧收起（setCollapsed 的 side）')

  {
    check(
      '工具描述讲清了 side 的适用范围',
      (AGENT_WRITE_TOOLS.find((tool) => tool.name === 'setCollapsed')?.description ?? '').includes(
        '按侧收起'
      )
    )

    // 平衡结构 + 左右都有分支的中心主题
    const balanced = createTopic('中心主题')
    balanced.structureClass = 'org.xmind.ui.map.unbalanced'
    balanced.children.push(createTopic('右一'), createTopic('左一'))
    const sidePlan = (args: Record<string, unknown>): ReturnType<typeof planWriteTool> =>
      planWriteTool('setCollapsed', JSON.stringify(args), balanced)

    const folded = sidePlan({ address: '中心主题', collapsed: true, side: 'left' })
    check('按侧收起能规划', folded.ok, folded.ok ? '' : folded.error)
    check(
      '意图带着 side（渲染层据此走 setFoldSide）',
      folded.ok && folded.intent.kind === 'collapse' && folded.intent.side === 'left'
    )
    check('摘要写清收了哪一侧', folded.summary.includes('左'))

    eq(
      'side 只认 left / right',
      sidePlan({ address: '中心主题', collapsed: true, side: 'north' }).ok,
      false
    )
    eq(
      '非中心主题带 side 被拒绝（含可读出下一步的提示）',
      sidePlan({ address: '左一', collapsed: true, side: 'left' }).ok,
      false
    )
    check(
      '拒绝理由指向正确用法',
      (() => {
        const r = sidePlan({ address: '左一', collapsed: true, side: 'left' })
        return !r.ok && r.error.includes('去掉 side')
      })()
    )
    eq(
      '单侧结构（逻辑图）同样被拒绝',
      plan('setCollapsed', { address: '成本', collapsed: true, side: 'left' }).ok,
      false
    )

    /**
     * 时间轴 / 鱼骨图**不提供**按侧收起（用户要求保持「一个折叠点」）：
     * 它们的上下只是沿主轴的交替摆放，收一侧只会让图更难读。
     */
    const fish = createTopic('中心主题')
    fish.structureClass = 'org.xmind.ui.fishbone.leftHeaded'
    fish.children.push(createTopic('甲'), createTopic('乙'))
    const upPlan = planWriteTool(
      'setCollapsed',
      JSON.stringify({ address: '中心主题', collapsed: true, side: 'left' }),
      fish
    )
    eq('鱼骨图不提供按侧收起', upPlan.ok, false)
    check('并说明该结构该用整体折叠', !upPlan.ok && upPlan.error.includes('去掉 side'))

    // 顺时针思维导图属于思维导图，按角度分左右半圈，同样支持
    const radial = createTopic('中心主题')
    radial.structureClass = 'org.xmind.ui.map.clockwise'
    radial.children.push(createTopic('一'), createTopic('二'))
    const radialPlan = planWriteTool(
      'setCollapsed',
      JSON.stringify({ address: '中心主题', collapsed: true, side: 'left' }),
      radial
    )
    check(
      '顺时针思维导图支持按侧收起',
      radialPlan.ok && radialPlan.intent.kind === 'collapse' && radialPlan.intent.side === 'left'
    )

    const plain = sidePlan({ address: '中心主题', collapsed: true })
    check(
      '不传 side 仍是整体折叠（行为不变）',
      plain.ok && plain.intent.kind === 'collapse' && plain.intent.side === undefined
    )

    /**
     * 读取工具要能读出「哪一侧被收起了」：模型看到的树必须与画布一致，
     * 否则它不知道右边为什么只剩一根线，还会把已经收起的一侧再收一遍。
     */
    withFoldedSides(balanced, ['left'])
    const read = runReadTool('getSubtree', JSON.stringify({ address: '中心主题' }), {
      root: balanced,
      selectedId: null,
      sheetCount: 1,
      sheet: {
        id: 'sheet-balanced',
        title: '画布',
        rootTopic: balanced,
        relationships: [],
        boundaries: [],
        summaries: []
      }
    })
    check('getSubtree 标出已收起的一侧', read.content.includes('已收起左侧'), read.content)
  }

  const formula = plan('setFormula', { address: '成本', formula: '$$E=mc^2$$' })
  check(
    '公式自动剥掉 $ 包裹',
    formula.ok && formula.intent.kind === 'formula' && formula.intent.formula === 'E=mc^2'
  )

  const ask = plan('askUser', {
    question: '要改哪一支？',
    options: ['成本', '收入', 'a', 'b', 'c', 'd']
  })
  check('提问被规划', ask.ok && ask.intent.kind === 'ask')
  check('候选最多留 5 个', ask.ok && ask.intent.kind === 'ask' && ask.intent.options.length === 5)
  eq('空问题被拦下', plan('askUser', { question: ' ' }).ok, false)
  eq('askUser 不算改动画布', isMutatingIntent({ kind: 'ask', question: 'q', options: [] }), false)

  const broken = planWriteTool('setNotes', '{"address"', tree)
  eq('非法 JSON 被拦下', broken.ok, false)
  check('非法 JSON 的提示点明 JSON', !broken.ok && broken.error.includes('JSON'))
  eq('未知工具被拦住', planWriteTool('dropTable', '{}', tree).ok, false)

  group('Agent 回合事务：一次命令 = 一步撤销')

  reset()
  const turnRoot = root()
  const a = addChildOf(turnRoot.id, '甲')
  const b = addChildOf(turnRoot.id, '乙')
  const c = addChildOf(turnRoot.id, '丙')
  const ours = [a, b, c]
  const order = (): string[] =>
    (find(turnRoot.id)?.children ?? [])
      .filter((topic) => ours.includes(topic.id))
      .map((topic) => topic.title)

  const base = store().undoStack.length
  store().beginAiTurn()
  store().setTitle(a, '甲改名')
  // 故意混入**换父 + 数组重排**：当年把 inverse 合成一份时，正是这种操作坏掉了 children
  store().moveNode(a, b)
  store().setCollapsed(turnRoot.id, true)

  const lockedLen = store().undoStack.length
  store().undo()
  eq('回合中撤销被锁住（否则历史会错位）', store().undoStack.length, lockedLen)

  check('回合确实产生了改动', store().commitAiTurn('AI · 一次命令'))
  eq('三处改动并成一步', store().undoStack.length, base + 1)

  store().undo()
  eq('一次撤销回到家门口（顺序）', order(), ['甲', '乙', '丙'])
  eq('一次撤销回到标题', find(a)?.title, '甲')
  eq('一次撤销回到折叠状态', find(turnRoot.id)?.collapsed, undefined)
  eq('换父移动也被整体撤回（乙名下重新变空）', find(b)?.children.length, 0)

  store().redo()
  eq('重做后甲不再挂在根下（重排生效）', order(), ['乙', '丙'])
  eq('重做后甲挂在乙下面、且带着新名字', find(b)?.children[0]?.title, '甲改名')

  const beforeEmpty = store().undoStack.length
  store().beginAiTurn()
  eq('没改东西的回合不产生条目', store().commitAiTurn('AI · 什么也没做'), false)
  eq('栈长度不变（Ctrl+Z 不会"没反应"）', store().undoStack.length, beforeEmpty)
}

export function testAi(): void {
  group('AI：配置')

  const defaults = normalizeAiConfig(undefined)
  eq('空配置用默认 BaseURL', defaults.config.baseUrl, DEFAULT_AI_CONFIG.baseUrl)
  eq('空配置用默认模型', defaults.config.model, DEFAULT_AI_CONFIG.model)
  eq('空配置没有 Key', defaults.config.apiKey, '')
  eq('空配置无告警（默认值可用）', defaults.warnings.length, 0)

  const bad = normalizeAiConfig({ baseUrl: 'api.deepseek.com', model: '  ', temperature: 9 })
  eq('缺协议的 BaseURL 回退默认', bad.config.baseUrl, DEFAULT_AI_CONFIG.baseUrl)
  check('缺协议时给出提示', bad.warnings.length === 1, bad.warnings.join('|'))
  eq('空模型名回退默认', bad.config.model, DEFAULT_AI_CONFIG.model)
  eq('温度被夹到上限', bad.config.temperature, 2)
  eq('负温度被夹到 0', normalizeAiConfig({ temperature: -3 }).config.temperature, 0)
  eq(
    '非法温度回退默认',
    normalizeAiConfig({ temperature: Number.NaN }).config.temperature,
    DEFAULT_AI_CONFIG.temperature
  )
  // 输出上限：默认必须给足（服务商默认值只有 1.5k~2k，会把"完整详细的大纲"写到一半掐断）
  // 100+ 节点（含每点解释备注）大约要 8k~14k 输出 token
  eq('默认输出上限给足', DEFAULT_AI_CONFIG.maxTokens, 16384)
  eq('空配置用默认输出上限', defaults.config.maxTokens, DEFAULT_AI_CONFIG.maxTokens)
  eq('0 是合规值（表示不发送该字段）', normalizeAiConfig({ maxTokens: 0 }).config.maxTokens, 0)
  eq('负输出上限夹到 0', normalizeAiConfig({ maxTokens: -5 }).config.maxTokens, 0)
  eq('超大输出上限夹到 65536', normalizeAiConfig({ maxTokens: 1e9 }).config.maxTokens, 65536)
  eq('小数取整', normalizeAiConfig({ maxTokens: 2048.6 }).config.maxTokens, 2049)
  eq(
    '非法输出上限回退默认',
    normalizeAiConfig({ maxTokens: Number.NaN }).config.maxTokens,
    DEFAULT_AI_CONFIG.maxTokens
  )
  eq('界面能读到输出上限', toConfigView(DEFAULT_AI_CONFIG).maxTokens, DEFAULT_AI_CONFIG.maxTokens)

  const view = toConfigView({
    baseUrl: 'https://x/v1',
    model: 'm',
    temperature: 0.5,
    maxTokens: 8192,
    apiKey: 'sk-abcdef123456',
    tier: 'mid'
  })
  eq('掩码保留前缀与后四位', view.keyPreview, 'sk-…3456')
  check('界面上不出现完整 Key', !JSON.stringify(view).includes('sk-abcdef123456'))
  eq('没 Key 时掩码为 null', toConfigView({ ...DEFAULT_AI_CONFIG }).keyPreview, null)
  eq('短 Key 只显示星号', toConfigView({ ...DEFAULT_AI_CONFIG, apiKey: 'abc' }).keyPreview, '****')

  group('AI：接口地址拼装')

  eq(
    '裸域名补 /v1/chat/completions',
    chatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/v1/chat/completions'
  )
  eq(
    '带 /v1 不重复补',
    chatCompletionsUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions'
  )
  eq(
    '末尾斜杠会被去掉',
    chatCompletionsUrl('https://api.openai.com/v1/'),
    'https://api.openai.com/v1/chat/completions'
  )
  eq(
    '完整地址原样使用',
    chatCompletionsUrl('https://x.com/v1/chat/completions'),
    'https://x.com/v1/chat/completions'
  )
  eq(
    '本地端口 + /v1',
    chatCompletionsUrl('http://localhost:11434/v1'),
    'http://localhost:11434/v1/chat/completions'
  )
  eq(
    '智谱 v4 形态',
    chatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4'),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  )
  eq('空串返回空', chatCompletionsUrl('   '), '')

  group('AI：文档 → 导图提示词（唯一还在用的出图路径）')

  const docPrompt = buildDocumentOutlineMessages({ name: '报告.md', text: '正文内容' })
  eq('两条消息（system + user）', docPrompt.length, 2)
  check('系统提示只输出大纲', docPrompt[0].content.includes('只输出大纲本身'))
  check('要求覆盖全部章节与要点', docPrompt[1].content.includes('全部章节与要点'))
  check('要求写具体内容（保留数字/结论/条件）', docPrompt[1].content.includes('数字'))
  check('解释直接成子节点（不用备注行）', docPrompt[1].content.includes('不要用 `> `'))
  check('禁止「XX 的概述」这类空节点', docPrompt[1].content.includes('概述'))
  /**
   * 单一来源：三条质量判据住在 `QUALITY_CHECKS`，聊天层与文档规格都引用它。
   * 这里钉「两处字面一致」——否则以后改了这边、那边过期，模型会同时看到两套说法。
   */
  const qualityHints = ['有信息量：删掉它', '是事实不是评价', '可操作：读到叶子就能答题']
  check(
    '文档规格复用聊天层同一套质量判据（单一来源）',
    qualityHints.every((hint) => docPrompt[1].content.includes(hint))
  )
  // 不能借用别的作用域里的 `prompt` 变量：这个名字会撞上宿主环境的全局函数，就地构造一份
  const chatWithCriteria = buildChatSystemPrompt({
    skeleton: '- 甲（2 个节点）',
    selectedTitles: [],
    totalNodes: 2,
    sheetCount: 1,
    canWrite: true
  })
  check(
    '聊天层也带同一套判据（两处字面一致）',
    qualityHints.every((hint) => chatWithCriteria.includes(hint))
  )
  check('带上文档全文与文件名', docPrompt[1].content.includes('【文档全文】'))
  check('带上文件名', docPrompt[1].content.includes('报告.md'))

  const chunkPrompt = buildDocumentChunkMessages({
    name: '报告.md',
    index: 1,
    total: 3,
    text: '第一段'
  })
  check('分段读：只依据这一段（防跨段瞎猜）', chunkPrompt[1].content.includes('只依据这一段'))
  check(
    '分段读：原文关键句写成子节点（与出图规格一致）',
    chunkPrompt[1].content.includes('单独写成子节点')
  )

  const mergePrompt = buildDocumentMergeMessages({ name: '报告.md', parts: ['- 甲', '- 乙'] })
  check('合并阶段：去重归位', mergePrompt[1].content.includes('合并去重'))

  /*
   * 合并场景以前用 `documentSpecLines(depth).slice(1, 4)` 拼规格：
   * 正好切掉「覆盖文档的全部章节」并砍掉三条质量判据里的后两条。
   * 这里逐条钉住「整份规格都在」。
   */
  const mergeText = mergePrompt[1].content
  check('合并阶段：要求覆盖全部章节', mergeText.includes('覆盖文档的**全部章节与要点**'), mergeText)
  check('合并阶段：质量判据整段都在（不只是第一条）', mergeText.includes('质量判据'), mergeText)
  // 三条判据的字面与聊天层保持一致（与上面 docPrompt 的断言用同一份文案）
  const mergeHints = ['有信息量：删掉它', '是事实不是评价', '可操作：读到叶子就能答题']
  check(
    '合并阶段：三条质量判据一条不少',
    mergeHints.every((hint) => mergeText.includes(hint)),
    mergeText
  )
  check('合并阶段：条目接着 1~3 条往下编号（不重复 2）', mergeText.includes('4.'), mergeText)

  group('AI：解析模型输出')

  const parsed = parseOutline(`好的，这是大纲：
- 产品规划
  - 市场分析
    - 目标用户
  - 产品设计
  - 研发计划`)
  eq('解析出根节点', parsed.root?.title, '产品规划')
  eq('解析出节点总数', parsed.count, 5)
  eq(
    '一级子节点',
    parsed.root?.children.map((c) => c.title),
    ['市场分析', '产品设计', '研发计划']
  )
  eq(
    '二级子节点',
    parsed.root?.children[0].children.map((c) => c.title),
    ['目标用户']
  )
  check('开场白那行被跳过', !JSON.stringify(parsed.root).includes('好的'))

  // 模型给出多个并列顶层节点时，套一个根，不散着
  const multiRoot = parseOutline('- 甲\n- 乙')
  eq(
    '并列顶层套根',
    multiRoot.root?.children.map((c) => c.title),
    ['甲', '乙']
  )
  check(
    '并列顶层给出提示',
    multiRoot.warnings.some((w) => w.includes('并列')),
    multiRoot.warnings.join('|')
  )

  // 模型常见的几种「不听话」写法都要能处理
  check('代码块包裹能剥掉', parseOutline('```\n- A\n  - B\n```').count === 2)
  check('星号列表也能解析', parseOutline('* A\n  * B').count === 2)
  check('数字列表也能解析', parseOutline('1. A\n  1. B').count === 2)
  check(
    'Markdown 标题也能解析（并列时套一个根）',
    parseOutline('# A\n## B').root?.children.length === 2,
    JSON.stringify(parseOutline('# A\n## B').root)
  )
  check('制表符缩进也能解析', parseOutline('- A\n\t- B').root?.children.length === 1)
  eq('多余空行不影响', parseOutline('- A\n\n\n  - B').count, 2)
  check(
    '加粗标题去掉星号',
    parseOutline('- **重要**').root?.title === '重要',
    parseOutline('- **重要**').root?.title
  )
  check(
    '开场白不进入大纲（关键）',
    parseOutline('好的，这是大纲：\n- 甲\n  - 乙').root?.title === '甲',
    JSON.stringify(parseOutline('好的，这是大纲：\n- 甲\n  - 乙').root)
  )
  eq('开场白被跳过后节点数正确', parseOutline('好的，这是大纲：\n- 甲\n  - 乙').count, 2)

  const flatRoots = parseOutline('- 甲\n- 乙\n- 丙', '我的主题')
  eq('多个顶层节点套一个根', flatRoots.root?.title, '我的主题')
  eq('同级的都挂在根下', flatRoots.root?.children.length, 3)
  check('多顶层时给出提示', flatRoots.warnings.length === 1, flatRoots.warnings.join('|'))
  // 「根是不是套上去的壳」必须能被调用方识别：写工具靠它决定剥不剥壳
  eq('多顶层时标记为壳（写工具据此剥壳）', flatRoots.wrapped, true)
  eq('单顶层不是壳', parseOutline('- 甲\n  - 乙').wrapped, false)
  eq('解析不出内容时也不是壳', parseOutline('只有一句话。').wrapped, false)

  const shifted = parseOutline('    - 根\n      - 子')
  eq('整体缩进的层级被归一化', shifted.root?.title, '根')
  eq('归一化后子节点关系正确', shifted.root?.children.length, 1)

  const deepJump = parseOutline('- 根\n      - 跳级子节点')
  check('层级跳跃不会崩（按最近父级挂）', (deepJump.root?.children.length ?? 0) >= 1)

  // 「详细内容」的载体：`> 解释` 落到上一个主题的**备注**（不占画布宽度、可搜索可导出）
  const noted = parseOutline('- 考点一\n  > 这是解释\n- 考点二\n  > 第二段解释')
  // 2 个并列顶层会套一个壳根，所以是 3；解释行本身不算节点
  eq('解释行不算节点（2 个主题 + 1 个壳根）', noted.count, 3)
  eq('解释进入对应节点的备注', noted.root?.children[0]?.notes, '这是解释')
  eq('第二个节点的备注也对', noted.root?.children[1]?.notes, '第二段解释')
  eq(
    '同一节点多行解释会拼起来',
    parseOutline('- 甲\n  > 第一行\n  > 第二行').root?.notes,
    '第一行\n第二行'
  )
  eq('没有解释时不产生备注字段', parseOutline('- 甲').root?.notes, undefined)

  const orphanNote = parseOutline('> 无主的解释\n- 甲')
  eq('无主解释不静默丢（给一次警告）', orphanNote.warnings.length, 1)
  check(
    '并说明为什么忽略',
    orphanNote.warnings[0]?.includes('出现在任何主题之前') === true,
    orphanNote.warnings.join('|')
  )
  eq('无主解释不影响节点', orphanNote.root?.title, '甲')

  // 长行不再被静默丢弃：这条 27 字、无逗号的行在旧阈值（24 字）下会被吃掉
  eq(
    '兜底路径不再丢掉长行',
    parseOutline('性能优化：减少重排与合并写入避免频繁触发重渲染导致卡顿').count,
    1
  )
  const dropped = parseOutline(
    '这一行是模型的解释文字，包含多个逗号，长度超过了阈值，应该被跳过\n甲\n乙'
  )
  check(
    '确实丢行时给出计数与原因',
    dropped.warnings.some((warning) => warning.includes('被跳过')),
    dropped.warnings.join('|')
  )
  // 甲 / 乙 两个并列顶层 → 套一个壳根 → 3
  eq('丢行不影响保留下来的节点（2 个主题 + 1 个壳根）', dropped.count, 3)

  const empty = parseOutline('很抱歉，我无法完成这个请求。')
  eq('只有说明文字时根为 null', empty.root, null)
  eq('只有说明文字时给提示', empty.warnings.length, 1)
  check('提示说明了原因', empty.warnings[0].includes('说明文字'), empty.warnings[0])

  const bare = parseOutline('甲\n乙\n丙')
  eq(
    '没有列表符号时按一行一个主题解析',
    bare.root?.children.map((c) => c.title),
    ['甲', '乙', '丙']
  )
  check(
    '并给出格式提示',
    bare.warnings.some((w) => w.includes('一行一个主题')),
    bare.warnings.join('|')
  )

  group('AI：响应解析与错误翻译')

  eq('取 message.content', extractContent({ choices: [{ message: { content: '结果' } }] }), '结果')
  eq('兼容 text 字段', extractContent({ choices: [{ text: '旧格式' }] }), '旧格式')

  let noChoices = ''
  try {
    extractContent({ choices: [] })
  } catch (error) {
    noChoices = (error as Error).message
  }
  check('choices 为空给出可读错误', noChoices.includes('choices 为空'), noChoices)

  let apiError = ''
  try {
    extractContent({ error: { message: '额度不足' } })
  } catch (error) {
    apiError = (error as Error).message
  }
  check('响应里带 error 时透出服务端信息', apiError.includes('额度不足'), apiError)

  let notObject = ''
  try {
    extractContent('不是对象')
  } catch (error) {
    notObject = (error as Error).message
  }
  check('非对象给出可读错误', notObject.includes('不是合法的 JSON 对象'), notObject)

  check(
    '401 提示检查 Key',
    describeAiError(401, '{"error":{"message":"invalid api key"}}').includes('API Key')
  )
  check(
    '401 带上服务端信息',
    describeAiError(401, '{"error":{"message":"invalid api key"}}').includes('invalid api key')
  )
  check('404 提示 BaseURL/模型名', describeAiError(404, '').includes('/v1'))
  check('429 提示限流', describeAiError(429, '').includes('限流'))
  check('400 提示模型名或长度', describeAiError(400, '').includes('模型名'))
  check('5xx 说明不是用户的问题', describeAiError(503, '').includes('不是你的问题'))
  check('其它状态码也给状态码', describeAiError(418, '').includes('418'))
  check('超长响应体被截断', describeAiError(400, 'x'.repeat(500)).length < 400)

  group('AI：大纲落到模型')

  const toTopic = outlineToTopic({ title: '根', children: [{ title: '子', children: [] }] })
  eq('转成主题树', toTopic.title, '根')
  eq(
    '子节点也转了',
    toTopic.children.map((c) => c.title),
    ['子']
  )
  check('生成了 id', toTopic.id.length > 0 && toTopic.children[0].id.length > 0)
  check('id 互不相同', toTopic.id !== toTopic.children[0].id)
  eq(
    '默认字段齐全',
    [toTopic.labels.length, toTopic.markers.length, toTopic.attachments.length],
    [0, 0, 0]
  )

  group('AI：结果写入画布（一步撤销）')

  reset()
  const aiRootId = root().id
  const aiTarget = addChildOf(aiRootId, '待扩写')
  const before = store().undoStack.length
  const added = store().addChildTitles(aiTarget, ['甲', '乙', '  ', '丙'])
  eq('空白标题被忽略', added, 3)
  eq(
    '子主题真写进去了',
    find(aiTarget)?.children.map((c) => c.title),
    ['甲', '乙', '丙']
  )
  eq('整批只占一步撤销', store().undoStack.length, before + 1)
  store().undo()
  eq('一次撤销整批回退', find(aiTarget)?.children.length, 0)

  // 「生成新导图」已改为在新窗口里成为独立文档（不走 applyOutlineTree）；
  // 这里只测「挂到指定主题下」这一条路
  reset()
  const aiHost = addChildOf(root().id, '宿主')
  const applied = store().applyOutlineTree(aiHost, {
    title: 'AI 主题',
    children: [{ title: '分支一', children: [{ title: '细节点', children: [] }] }]
  })
  eq('生成的节点数正确', applied, 3)
  eq('层级被正确写入', find(aiHost)?.children[0]?.children[0]?.children[0]?.title, '细节点')
  store().undo()
  eq('一次撤销整批回退', find(aiHost)?.children.length, 0)

  reset()
  const hostId = addChildOf(root().id, '宿主主题')
  const childApplied = store().applyOutlineTree(hostId, {
    title: '生成的分支',
    children: []
  })
  eq('挂到已有主题下：节点数', childApplied, 1)
  eq(
    '挂载结果正确',
    find(hostId)?.children.map((c) => c.title),
    ['生成的分支']
  )

  const unknownTarget = store().applyOutlineTree('不存在的主题', {
    title: 'x',
    children: []
  })
  eq('目标主题不存在时不会崩（返回计数但什么都没写）', unknownTarget, 1)
  eq('确实没有写进任何地方', find(hostId)?.children.length, 1)

  /**
   * 「AI 详细图」的核心载体：`> 解释` 会变成节点备注。
   * 上面测了 `outlineToTopic` 层（见「导入：备注一并带进模型」）与这一层的层级/撤销，
   * 但**「备注经 applyOutlineTree 真的写进 store」**正好落在两者的夹缝里——补上，
   * 否则「解释去哪了」这种回归只能靠用户发现。
   */
  reset()
  const noteHost = addChildOf(root().id, '宿主')
  store().applyOutlineTree(noteHost, {
    title: '考点',
    notes: '这是解释',
    children: [{ title: '子考点', notes: '子解释', children: [] }]
  })
  eq('备注经 applyOutlineTree 落进 store', find(noteHost)?.children[0]?.notes, '这是解释')
  eq('子节点的备注也落进 store', find(noteHost)?.children[0]?.children[0]?.notes, '子解释')
  check(
    '备注同时生成 notesHtml（搜索与导出要用）',
    (find(noteHost)?.children[0]?.notesHtml ?? '').length > 0
  )
  store().applyOutlineTree(noteHost, { title: '无备注', children: [] })
  eq('没有备注时不写空串（避免正文区出现空块）', find(noteHost)?.children[1]?.notes, undefined)
}
