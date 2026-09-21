# SMind 缺陷检测报告（2026-09-21）

> **审查者**：质检/文书侧（**本轮零代码改动**，只做只读审查）
> **审查基线**：`HEAD da0f478`（只看**已提交**代码；未提交的工作树改动不在范围内）
> **方法**：逐文件读代码 + 目录级存在性扫描 + 关键结论当日实跑（五道门槛 / 线上 CH 校验）
> **本文件用途**：交给代码 agent 逐条修复。每条都给了**证据（file:line）→ 触发路径 → 影响 → 修法建议 → 验收判据**。

---

## 0. 怎么用这份报告

1. **按 §1 的批次走**：一批一个提交、每批过五道门槛（`typecheck` / `lint` / `format:check` / `selfcheck` / `verify`），自检断言**只增不减**（当前 **2791 项**）。
2. 每条的「验收判据」里写明了**要补的自检断言**；能纯函数化的必须补，不能的按写的步骤手工验。
3. **§2 有两条触及你之前定的红线**（AI 事务语义），已单独标注 ⚠️，修的时候按「保语义、只修错位」的原则做，并在提交信息里交底。
4. **§4 是我核实过「没问题」的清单**——不要重复立案，也不要去"修"它们。

### 结论摘要

| 级别 | 条数 | 一句话 |
|---|---|---|
| 🔴 P0 数据安全 | 3 | 撤销一步失效 / 多标签崩溃恢复缺口 / 保存竞态误标已保存 |
| 🟠 P1 正确性 | 5 | AI 对浮动主题整块失明 / 上下文压缩漏一段 / 重复调用拿旧结果 / 组词期加宽无效 / 两个 effect 抢写宽度 |
| 🟠 P1 用户已复现 | 1 | **清空标题后节点不缩回**（D-14；用户 2026-09-21 判定为缺陷，需先按 §3 探针定死机制） |
| 🟡 P2 一致性 | 6 | 改树却报失败 / index 负数静默夹取 / 诊断计时失效 / 监听器泄漏 / AI 清空型写操作缺确认（方案已定稿）/ 启动时发两次更新检查（D-15） |

**这些都不是解耦搬坏的**：逐条追过，逻辑在搬迁前就存在（`history.ts` 的头注还明写「`HISTORY_LIMIT` 截断……一律逐字未改」）。
**真正的成因**：自检 2791 项断言**全部落在纯函数上**，而下面 15 条里只有 2 条本来就能被纯函数覆盖（见 §5）。

---

## 1. 建议的修复批次

| 批次 | 内容 | 理由 |
|---|---|---|
| **B1**（P0，最优先） | D-01、D-02、D-03 | 全是"静默丢数据/丢撤销"，且都能用纯函数断言钉住 |
| **B2**（P1 遍历口径） | D-04 | 一处改动面（`shared/agent/**` 7 处），能一次钉死同类 |
| **B3**（P1 编辑态几何） | D-07、D-08 | 用户肉眼可感；需要一条 Electron 脚本验证（§5.2） |
| **B4**（P1 上下文） | D-05、D-06 | 只动 wire 拼装与队列判重，风险低 |
| **B5**（P2） | D-09 ~ D-12 | 单点小修，各自带断言 |
| **B6** | D-13 第 1 步、D-14 | D-13 第 1 步（加"内容变少就确认"）改动小，可随 0.9.2；D-14 需**先**按 §3 的探针定死机制（5 分钟）。D-13 第 2 步（备注拆"补充 / 改写"）单开一批 |

---

## 2. 缺陷详情

### 🔴 D-01 · 撤销栈满 200 后，AI 回合的「一步撤销」**静默失效**，而界面仍向用户保证"一次全回退"

**级别**：P0（数据安全 + 对用户说假话） ｜ **置信度：高**（纯逻辑，读代码即可确证） ｜ ⚠️ **触及 AI 事务语义红线**

**证据**
```
src/renderer/src/store/slices/history.ts:31    const HISTORY_LIMIT = 200
                                   :108-111    undoStack: [...undoStack, entry].slice(-HISTORY_LIMIT)  ← 从**头部**截断
                                   :120        set({ aiTurn: { depth: get().undoStack.length, ... } }) ← 用「下标」当 depth
                                   :138        const batch = undoStack.slice(turn.depth)                ← 下标已错位
                                   :155        undoStack: [...undoStack.slice(0, turn.depth), merged].slice(-HISTORY_LIMIT)
```

**触发路径**
`beginAiTurn` 记下的 `depth` 是**数组下标**，而 `mutate` 每次都会 `slice(-200)` 从头部截掉最老的条目。于是只要回合开始时栈长度接近上限，下标就永久错位：

- 回合开始时栈**已满 200**：后续每次 `mutate` 都把长度压回 200 → `slice(200) === []` → 走 `batch.length === 0` 分支，**只清 `aiTurn`、什么都不合并**；
- 回合开始时栈长 **199**、AI 改 3 处：数组被截到 200 → `slice(199)` **只拿到最后 1 条** → 只合并了第 3 处，前两处退化成两条独立撤销步。

**影响**
产品对外承诺（`README` / `CHANGELOG` / 气泡文案）是「整轮 AI 改动并成**一步**，Ctrl+Z 一下全回来」。实际要按 2~N 次。而 `chat/turn-runtime.ts:191` 仍然照样打印
「撤销：按一次 Ctrl+Z 全部回退」——**界面在陈述与事实不符的信息**。（`commitTurn` 忽略了 `commitAiTurn` 的返回值，所以连"没合并成功"都无人知晓。）

**修法建议**（保语义、只修错位）
二选一，**不要**动"一条命令 = 一步撤销"这个语义：
1. **首选**：`beginAiTurn` 不存下标，改存一个**单调递增的回合序号**；`mutate` 给每条历史条目打上该序号；`commitAiTurn` 改为「取序号 ≥ turnSeq 的条目」——这样截断不会破坏定位。
2. **最小**：保留下标，但在 `mutate` 截断时同步把 `aiTurn.depth` 减去被截掉的条数（`aiTurn.depth = Math.max(0, depth - dropped)`）。

**验收判据**
- 新增纯函数断言（**这条能直接把 bug 钉红**）：
  `newDocument → 连续 mutate 够 200 条填满栈 → beginAiTurn → 再改 3 处 → commitAiTurn` → 断言
  ① `undoStack.length === 201 - 200 + …`（按实现语义明确写出期望长度）②**新增历史条目恰好 1 条** ③ 该条目的 `patches` 覆盖那 3 处改动 ④ 一次 `undo()` 后三处全部回退。
- 手工：在栈接近满的文档上让 AI 改 2 处以上，按一次 Ctrl+Z，确认**全部**回退。

---

### 🔴 D-02 · 多标签下崩溃恢复对**非激活标签**完全失效

**级别**：P0（数据丢失） ｜ **置信度：高**（链路完整可证）

**证据**
```
src/main/autosave.ts:15-19            自动存档按「**窗口**」分槽（slot-N），不是按标签
src/main/ipc/document.ts:89           writeFileAtomic(autosaveFile(state.slot), bytes)   ← 只有激活标签的内容
src/renderer/src/app/use-autosave.ts:34   autosave(activeDocId(), ...)                    ← 定时器只送激活标签
src/renderer/src/app/use-document-actions.ts:77  await window.api.clearAutosave()         ← 任一次保存清空整个槽位
```

**触发路径**
一个窗口开两个标签 A、B 都改过且都没保存 → 30 秒定时器只会把**当前激活的那个**写进 `slot-N`（每次覆盖），另一个**从头到尾没有任何存档**；此时随便保存一次，`clearAutosave()` 会把整个槽位文件删掉 → 崩溃/断电后，非激活标签的未保存内容**不可恢复**。

**影响**
README 的对外承诺是笼统的「每 30 秒自动保存、崩溃恢复」。多标签用户丢的是整份工作。
（设计注释只写了"一次只存/问激活的那个标签"（`doc-resources.ts:9`、`document.ts` 头注），**没有写它的后果**。）

**修法建议**（二选一）
1. 自动存档槽位从「按窗口」改为「按 docId」（`autosaveFile(slot)` → `autosaveFile(docId)`），恢复时按标签各恢复各的；
2. 或者保留按窗口，但**每个脏标签各存一份**（`slot-N-docId`），并在保存某个标签时只清该标签那一份（`clearAutosave` 要带 docId）。

无论走哪条，**不要把 `clearAutosave()` 做成清全窗口**——那是现在这条 bug 的直接成因。

**验收判据**
- `main/autosave.ts` 的路径构造函数加纯函数断言：两个不同 docId 得到两个不同文件；`clearAutosave(docId)` 不影响另一个。
- 手工：开两个标签都改一笔（不保存）→ 强杀进程 → 重启 → 两个标签都应提示可恢复。

---

### 🔴 D-03 · 写盘期间产生的新编辑，被 `markSaved()` 一并标成「已保存」

**级别**：P0（数据丢失，窗口较窄） ｜ **置信度：中高**（机制确定，属竞态）

**证据**
```
src/renderer/src/app/use-document-actions.ts:63-76
  const state = useEditor.getState()                 ← 取快照
  await window.api.saveToPath(..., state.workbook)   ← 异步写盘（这段时间用户还能打字）
  useEditor.getState().markSaved(state.filePath)     ← 无条件 dirty: false
src/renderer/src/store/slices/document.ts:118
  markSaved: (path) => set({ filePath: path, dirty: false })
```

**触发路径**
写盘期间用户的每次 `mutate` 都会把 `dirty` 置真，但写盘结束后的 `markSaved` 又无条件把它抹掉 → 那几笔**没写进磁盘**的编辑被标记为"已保存" → 之后关窗/退出**不再提示**，改动静默丢失。

触发窗口：`saveToPath` 通常几十毫秒，但大文档 + 图片/附件走 `serializeXmind` 要打包资源，实测可到几百毫秒；`saveAs` 那条路还叠一次对话框往返。

**修法建议**
给文档加一个**保存代次 / 修订号**（`docRevision`，每次 `mutate` 自增）；`markSaved` 记录"这次保存基于的修订号"，只在「当前修订号 == 保存时的修订号」时置 `dirty: false`，否则保持 `dirty: true`（如实提示"保存后又改过"）。

**验收判据**
- 纯函数断言：模拟「取快照 → 一次 mutate → markSaved(旧代次)」→ 断言 `dirty` 仍为 `true`。
- 手工（弱网/大文档更容易命中）：保存 → 保存过程中立刻打字 → 保存完成后标题栏仍应是 `●`。

---

### 🟠 D-04 · `shared/agent/**` 对「浮动主题」**整块失明**（同一个 bug 类的第二处缺口）

**级别**：P1（AI 正确性 / 功能缺口） ｜ **置信度：高**（目录级存在性扫描 + 逐处读代码）

**证据（先看扫描结论）**
对 `src/shared` 做 `detachedChildren` 存在性扫描，命中 14 个文件：

```
命中：tree / dragmove / resources / editor-pure / search / outline / layout/core /
      xmind{parse,legacy,emmx,serialize} / model{types,factory} / ai/context
未命中：shared/agent/**        ← 整个目录零处提及
```

而未命中的目录里，下面这些地方**都在遍历 `topic.children`**：

| 位置 | 作用 | 漏掉的后果 |
|---|---|---|
| `src/shared/agent/address.ts:93` | 短句柄 `#xxxxxx` 扫描 | 模型拿到句柄也**解析不到**浮动主题 |
| `src/shared/agent/address.ts:157` | 「唯一标题」收集（`collect`） | 标题唯一也不认，回「没有找到标题为 X 的主题」 |
| `src/shared/agent/address.ts:63` | `suggestTitles` 纠错建议 | 纠错提示里不列浮动主题，模型更绕不出来 |
| `src/shared/agent/title-index.ts:45` | 回复里节点引用的索引 | **点浮动主题的引用没反应**（界面可点性直接失效） |
| `src/shared/agent/run-read.ts:80` | `getSubtree` 的行遍历（`outlineOf`） | 模型"看"不到浮动子树 |
| `src/shared/agent/run-read.ts:105` | `countsOf` → `getDocStats` | 节点总数与界面 `countTopics` **口径不一致** |
| `src/shared/agent/run-read.ts:243` | `searchNodes` | **搜索找不到浮动主题**——模型发现节点的主入口 |
| `src/shared/agent/plan-write.ts:102` | `insertSubtree` 防照抄用的「已存在标题」集合 | 集合不全 → 防照抄判定偏松（次要） |

**为什么这是"遗漏"而不是"决策"（三条对照证据）**
1. **同一函数里口径已经打架**：`address.ts:127` 的路径寻址用的是 `allChildrenOf()`（**含**浮动），而同一个函数的 `:93` / `:157` 只走 `children`；
2. **同一仓库里成对写对的地方**：`model/dragmove.ts:23/24`、`model/resources.ts:31/32`、`outline/index.ts:108/109` 都是相邻两行把两类子节点都走一遍；
3. **仓库自己立过这条规矩** —— `src/shared/model/tree.ts:60-64`：
   > 「自由摆放的主题能被找到、能被统计，却删不掉也移不动……**以后凡是要遍历子节点，一律用这个函数**，别再手写 `topic.children`（除非明确只要"挂在树上的那些"）」
   当时修的是 `detachTopic`，**`shared/agent/**` 没跟上**。

**用户可见后果**
打开一份带浮动主题的 .xmind（Xmind 正式功能，也是本产品"格式保真"的卖点；`outline/index.ts:89-96` 明确把它当一等公民：「大纲面板是"还能找到它们"的主要入口」）→ 用户在画布与大纲里**都看得见**它 → 让 AI 改它 → AI 回「没有找到」；且 AI 回复里提到它的标题时**点不动**；`getDocStats` 报的节点数与状态栏对不上。

**修法建议**
上表 8 处里的前 7 处，把 `topic.children` / `node.children` 换成 `allChildrenOf(topic)` 或直接用 `walk(...)`。
⚠️ **不要动** `shared/ai/context.ts:20` 的 `countTopicTree`——它只走 `children` 是**有意**的，文件里有注释说明「别把两者合并」。

**验收判据（这条建议做成静态断言，一次钉死同类）**
- 新增断言：构造一份含 `detachedChildren` 的文档，然后逐条断言
  ① `resolveTopicAddress(root, '#<浮动主题句柄>')` 命中；② 浮动主题标题唯一时按标题命中；
  ③ `searchNodes` 命中它；④ `getSubtree` 的行里能看到它；⑤ `getDocStats` 的节点总数 == `countTopics(root)`（含浮动）；
  ⑥ `buildTitleIndex` + `segmentTitleMentions` 能把回复里的浮动主题标题切成 `topicId != null` 的片段。
- 可再加一条**静态口径断言**：`src/shared/agent/**` 里每出现 `\.children` 遍历，必须同时出现 `allChildrenOf` / `walk`（防空过：先断言扫到至少 N 处）。

---

### 🟠 D-05 · 上下文压缩窗口与注入口径之间有一条缝：最近几条里除最后一条外的 `toolNotes` 谁都看不到

**级别**：P1（AI 正确性） ｜ **置信度：高**

**证据**
```
src/shared/ai/context.ts:226-256       compressHistory：older → digest（**含 toolNotes**）；recent 原样返回（**保留 toolNotes**）
src/renderer/src/components/chat/use-chat-loop.ts:751-753
  ...compressed.recent.filter((msg) => msg.content.trim().length > 0)
      .map((msg): AiMessage => ({ role: msg.role, content: msg.content }))     ← 只取 role/content，toolNotes 被丢掉
src/renderer/src/components/chat/use-chat-loop.ts:733
  previousTurnNotes: messagesRef.current[...]?.toolNotes ?? []                 ← 只注入**最后一条**的 toolNotes
```

**触发路径**
时间线上最近 `HISTORY_KEEP_RECENT = 6` 条消息落在 `recent` 窗口里：它们的 `toolNotes` **不进 digest**（digest 只吃 `older`），而拼 wire 时又只取 `role/content` → **既没进摘要、也没进消息线**。只有最后一条的 `toolNotes` 通过 system prompt 的 `previousTurnNotes` 活下来。
多轮会话里（比如 4 轮），第 2、3 轮里 AI 实际做过什么，模型在任何地方都看不到。

**影响**
正是仓库此前专门修过的那类问题的**残留一半**：「用户说『继续』，模型不知道上一轮干过什么，于是从零重读重做」。现在只有"最后一轮"被治好了。

**修法建议**
把 `recent` 窗口里 assistant 消息的 `toolNotes` 也拼进 wire——最小改法是在 `send()` 里给这些消息补一行附注：
`{ role: 'assistant', content: last.content }` 之前，若 `toolNotes.length > 0` 则把 `（本轮执行：…）` 追加到 content 末尾（或作为一条独立的 `user` 附注注入），并按需要截断长度。

**验收判据**
- 纯函数断言：`compressHistory` 之后，对「recent 窗口内带 toolNotes 的消息」，最终 wire 里必须能找到这些 summary 文本（构造 4 轮历史，断言第 2 轮的 summary 出现在 wire 中）。
- 手工：连续 3 轮让 AI 各改一处，第 4 轮发「继续」，确认它不提"从头重来"。

---

### 🟠 D-06 · 同一回合内按「参数文本」判重：文档已变时重复调用拿到的是**旧结果**

**级别**：P1（AI 正确性） ｜ **置信度：中高**

**证据**
```
src/renderer/src/components/chat/tool-queue.ts:113-124
  const callKey = `${call.name}|${call.argumentsText}`
  if (seenCallsRef.current.has(callKey)) { pushToolResult(call, '（这个调用本回合已经执行过…）'); … return }
  seenCallsRef.current.add(callKey)
```

**触发路径**
同一回合里模型先 `searchNodes` / `getSubtree` 探查 → 改名/搬节点/插入子树 → **再查一次同样的关键词**（很自然的"改完再确认一下"）→ 参数一模一样 → 被判为重复调用，回喂的是"结果见上面那条"，而上面那条是**改动前**的旧快照。

**影响**
模型基于过期信息继续推理（比如以为某节点还在原位），表现为"改完越改越乱"。判重本身是为了防白烧配额，方向没错，但**读工具的去重条件缺了"文档没变"这个前提**。

**修法建议**
把去重键加一个"文档修订号"（可与 D-03 的 `docRevision` 复用）：`${docRevision}|${name}|${argumentsText}`；**写工具**保持现在的严格去重（同一参数重复写确实没意义），**读工具**在文档变过之后允许重读。

**验收判据**
- 纯函数断言：同一读调用在 `docRevision` 未变时判重、变化后不判重。
- 手工：让 AI「读一下 X → 把 X 改名 → 再读一次 X」，确认第二次返回的是新标题。

---

### 🟠 D-07 · 输入法组词期的临时加宽**被 flex 收缩抵消**（用户已复现：拼音折成 5 行）

**级别**：P1（用户肉眼可感，功能等于没做） ｜ **置信度：高（读代码即可确证）** ｜ **用户已提供 4 张复现截图**

**证据链（四段缺一不可）**
```
① 修复只动最内层 DOM
   src/renderer/src/components/RichTextEditor.tsx:210-232
     dom.style.maxWidth = 'none'
     dom.style.width = `${compositionBoxWidth(baseWidthRef.current, extra, cap)}px`

② 这个 dom 就是带 .rich-editor__content 类的元素
   src/renderer/src/components/RichTextEditor.tsx:73-74
     editorProps: { attributes: { class: 'rich-editor__content', spellcheck: 'false' } }

③ 这条 CSS 正是为「长串也要在节点内断行」加的反向约束
   src/renderer/src/styles/09-section.css:361-373
     .rich-editor__content { width: 100%; min-width: 0; overflow-wrap: anywhere; }

④ 它的父级把宽度锁死在节点框里，且它是 flex 子项
   src/renderer/src/styles/09-section.css:350-358
     .topic__editor { width: 100%; min-width: 0; display: flex; align-items: center; justify-content: center; }
```

**根因**
`.rich-editor__content` 是 `.topic__editor` 的 **flex 子项**（默认 `flex-shrink: 1`），而它自己又被设了 `min-width: 0` → **可以被无限制压回容器宽度**。所以 A3 把内层宽度写成 `NNNpx` 之后，只要 `NNN > 节点内宽`，flex 收缩立刻把它压回节点内宽，`overflow-wrap: anywhere` 再在这个窄宽度上断行 → **拼音照样折行**。

一句话：**修复放开的是 `max-width`，而真正卡住它的是 flex 的 `shrink`。** 放错了约束。

**修法建议（三档，按代价）**
1. **最小可见修**：组词期临时加宽时**同时解除 flex 收缩**——给该元素 `flex: 0 0 auto`（不是只写 width），并把 `.topic__editor` 的 `overflow` 临时放开。代价：文字会**溢出节点框**（框本身不会跟着变大），手感仍不理想。
2. **推荐（治本）**：把组词文本接入"有效宽度"——A3 当初否掉的方案 B：让 `use-canvas-layout.ts` 的测量在组词期吃 `max(editingText, 组词文本)`，**框跟着变宽**，这才是用户期望的手感。代价：组词期每次 `compositionupdate` 触发一次重排（组词期很短，可接受；建议仍加 ~50ms 节流）。
3. **视觉解耦**：组词文本用绝对定位浮层显示，不参与 flex 布局。

**验收判据**
- **手工（必须）**：中文输入法连续输入 8 个以上音节（如 `dawadawdwa…`）**不按回车**，编辑框内文字应始终保持在一行（或最多按节点上限换行），**不得**因为宽度冻住而折成多行。
- 可脚本化：用 Electron 起真窗口，向编辑区合成派发 `compositionstart` / `compositionupdate` / `compositionend`，量 `getBoundingClientRect()`，断言组词期 `scrollHeight` 不超过一行高度。
- 自检能覆盖的部分：`compositionBoxWidth` 的算术（已有 6 条）**不够**——这条 bug 恰恰说明纯函数断言盖不住 DOM 约束。

---

### 🟠 D-08 · `dom.style.width` 有**两个 effect 抢写**，组词中途会被宽度同步 effect 覆盖

**级别**：P1（偶发性来源） ｜ **置信度：中高**

**证据**
```
src/renderer/src/components/RichTextEditor.tsx:192-200   宽度同步 effect，依赖 [editor, node.width, node.paddingX, node.depth]
src/renderer/src/components/RichTextEditor.tsx:210-232   组词加宽 effect，依赖 [editor, node.depth, node.fontSize]
两者都写同一个 dom.style.width；宽度同步那条还会改 baseWidthRef.current（组词还原的基准）
```

**触发路径**
组词期间只要 `node.width` 变了一次（ProseMirror 在组词中也可能触发 `onUpdate` → `editingRich` 变 → 重排 → 新 node 对象），宽度同步 effect 就会重跑，**把加宽值原地覆盖掉**，同时把 `baseWidthRef.current` 改成新值 → `compositionend` 的 `restore()` 还原到一个已经变了的基准。这正是用户看到的"有时折行、有时不折"。

**修法建议**
- 把「宽度同步」与「组词加宽」合并成**一个** effect（同一处按状态算出最终宽度）；或
- 让加宽走 CSS 变量（`--compose-extra`），由唯一的宽度计算点统一消费；
- 无论哪种，`baseWidthRef` 的更新与还原必须同一处拥有。

**验收判据**
- 代码层：`dom.style.width` 的写入点只剩一处（可加静态断言/注释钉住）。
- 手工：组词过程中同时滚动缩放画布（制造 `node.width` 变化），加宽不应中途失效。

---

### 🟡 D-09 · `moveTopic` 在「目标父级不存在」时**已经改了树却返回 false**

**级别**：P2 ｜ **置信度：中**（逻辑确定，触发路径较窄）

**证据**
```
src/shared/model/tree.ts:170-183
  const node = detachTopic(root, id)                        ← 已经摘下来了
  if (!parent) { attachChild(root, node, index); return false }   ← 挂到根下，但报「失败」
src/renderer/src/store/slices/move.ts:181
  if (ok) settleAfterMove(draft, id)                        ← 没做收尾（不清 position）
src/renderer/src/store/slices/move.ts:198-202
  if (!moveTopic(...)) continue                             ← 跳过、不计入 applied
```

**影响**
节点实际被搬到了**根下**，但所有调用方按"没移动"处理：不清理自由摆放偏移、不计入批量结果、不更新选中。用户看到的是"节点跑到中心主题旁边，和落点无关"。

**修法建议**
让返回值与副作用一致：要么在 `parent` 不存在时**把节点放回原位**再 `return false`（真正的"什么都没做"），要么 `return true` 并让调用方照常收尾。**推荐前者**（语义更干净：失败了就不该动数据）。

**验收判据**
- 纯函数断言：构造 `targetId` 不存在的场景 → 断言 ① 返回 false ② **树与调用前逐字段相同**（现在这条会失败）。
- 补充：`moveNodes` 的 `applied` 与实际终态一致（加一条等价性断言）。

---

### 🟡 D-10 · `index` 为负数被静默夹成 0（"放最后"变成"放最前"）

**级别**：P2 ｜ **置信度：高**

**证据**
```
src/shared/agent/plan-write.ts:187-191
  const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
    ? Math.max(0, Math.round(rawIndex)) : null
src/shared/agent/plan-write.ts:249-253   批量移动同样处理
```

**影响**
模型常把"放到最后"写成 `index: -1`；现在会静默变成"放到第 0 位"，与意图相反，而且**不报错、不提示**。

**修法建议**
① 负数按"从末尾倒数"解释（`-1` = 末尾，与多数脚本语言一致）；或
② 明确拒绝并回喂可读原因（"index 不能为负；要放到末尾请传子节点数量或省略 index"）。
**推荐 ①**，并在工具描述里写明。

**验收判据**
- 纯函数断言：`index: -1` → 断言落点是末尾（或断言返回可读错误，取决于选哪种）；`index: 0` 不变。

---

### 🟡 D-11 · 自动存档的耗时统计**恒为 ~0**，还污染 AI 回合的「耗时归属」诊断行

**级别**：P2（诊断质量） ｜ **置信度：高**

**证据**
```
src/renderer/src/app/use-autosave.ts:31-45
  const endSave = beginCost('自动存档快照')
  void window.api.autosave(...).catch(...)     ← 没有 await
  endSave()                                    ← 同步立刻收尾
src/renderer/src/dev/stage.ts:67-86            beginCost 是纯同步计时器
src/renderer/src/dev/stage.ts:94-110           reportCosts 会把 costs 表里**所有**条目拼进那一行
```

**影响**
注释写着「这一跳每 30 秒一次……**必须计时**」（专为抓"AI 回合结束后冻结"埋的点），但因为不 `await`，量到的是"发起 IPC 的时间"（≈0–1ms），**永远不会暴露真正的写盘开销**——这正是那次冻结取证最需要的数字。同时它往 `costs` 里塞一条，AI 回合结束那行诊断会多出一个假的小耗时项。

**修法建议**
把 `endSave()` 放进 promise 的 `.finally()`；或改成 `await` 后再收尾（注意定时器回调要能容忍异步）。同时把这条统计标记为"后台任务"，不要混进 AI 回合的耗时归属行。

**验收判据**
- 手工/脚本：在大文档上触发一次自动存档，日志里 `自动存档快照` 的耗时应当与 `serializeXmind` 的实际耗时同量级（不再恒为 0–1ms）。

---

### 🟡 D-12 · `useNodeDrag` 的 window 级监听在**组件卸载时不解除**

**级别**：P2 ｜ **置信度：高**（影响面小：松手时 id 已不匹配 → no-op）

**证据**
```
src/renderer/src/components/canvas/use-node-drag.ts:567-571   按下时注册 4 个 window 监听
                              :481-496                        detach() 只在 onUp / onCancel / Esc 里调用
没有 useEffect cleanup 覆盖「拖拽中途卸载」
```

**触发路径**
按住节点拖动过程中，组件被卸载（切抽屉 / 切文档 / 关闭标签）→ 4 个监听仍挂在 window 上；之后松手会走到 `state.dropNode(...)`，而 `id` 已经不属于当前文档 → `moveTopic` 找不到 → 一次 no-op（另加一次多余的 hitTest 成本）。

**修法建议**
把「拖拽会话」的清理注册到一个 `useEffect(() => () => detachRef.current?.(), [])` 里（detach 函数需要在拖拽开始时写进 ref）。

**验收判据**
- 手工：拖着一个节点不松手 → 用键盘切换到另一个标签页/关掉抽屉 → 松开 → 控制台无异常、随笔移动不再触发任何 hitTest 痕迹（可临时加点计数验证）。

---

### 🟡 D-13 · `setNotes / setCode / setFormula` 传空即**清空用户内容**，但不在破坏性清单里

**级别**：P2（数据安全，有撤销兜底） ｜ **置信度：高** ｜ **产品口径已定稿（2026-09-21 用户拍板）**

**现象（说人话）**
AI 有三个"写字"工具：给节点写备注、写代码、写公式。**它们是覆盖语义，不是追加**。于是：
- 用户手写了 3000 字备注，对 AI 说"补一句说明" → AI 一写，**原来那 3000 字全没了**，只剩它那一句；
- 模型把参数漏填成空串 → **备注 / 代码块 / 公式直接被清空**，而它还在回复里说"已补充说明"。
而"删分支"这类操作会先弹确认，**这三种不会**。

**证据**
```
src/shared/agent/write-intents.ts:82      DESTRUCTIVE_WRITE_KINDS = ['delete', 'attachmentRemove', 'dedupe']
src/shared/agent/plan-write.ts:315-329    setNotes：text 为空 → 清空备注（destructive: false）
src/shared/agent/plan-write.ts:331-355    setCode：text 全空白 → 移除代码块
src/shared/agent/plan-write.ts:357-376    setFormula：formula 为空 → 移除公式
```

**为什么不能简单改成"追加"（三条反例，已论证）**
1. 只给追加，AI 就**没法表达"改写 / 精简 / 删掉过时那句"**了 → 只能用追加兜，结果**旧段还在、新段在下面**，两段打架，备注越加越长；
2. "整体替换"是**幂等**的（同一调用发两遍结果一样），改成追加后**重发即重复追加**——模型重发同一调用很常见（仓库已专门做过"重复调用判重"），备注会被同样的话撑乱；
3. "追加"对**代码块 / 公式**说不通：一个节点只有一块代码、一个公式，追加等于把两段代码拼成一块、两个公式粘在一起，语义更乱。

**定稿方案（三步，按落地成本排序）**

**第 1 步（必做；改动最小，建议随 0.9.2）——加"内容变少就确认"的硬网**
- 判据放在规划层：`setNotes` / `setCode` / `setFormula` 这次调用会让内容**变少**（清空，或覆盖后明显短于原文）时，把 `destructive` 标为 `true`；
- 这一层**不看模型意图**，是兜底网：模型用错工具（该"补充"却用了"改写"）也拦得住；
- 实现建议：`DESTRUCTIVE_WRITE_KINDS` 加入 `notes` / `code` / `formula`（这样「不再询问」记得住、`DESTRUCTIVE_WRITE_LABELS` 有中文名，三处口径自动跟着走），但把"是否破坏性"从 `destructiveOf(kind)` 改成**由规划层按参数给**（三个分支各加一个判断）。
- ⚠️ **不要把这三种的"全部调用"都标成破坏性**：正常写内容也弹窗会造成**确认疲劳**，用户会去勾「不再询问」，反而把真正的删除确认一起关掉。

**第 2 步（增强；建议单独一批）——备注拆成「补充 / 改写」两个动作**

| 动作 | 什么时候用 | 判据写进工具描述 |
|---|---|---|
| **补充**（追加到末尾） | 用户说"加上 / 补充 / 再来一段" | 追加，并做**末尾去重**（末尾已有这段就不重复加） |
| **改写**（整段替换） | 用户说"整理成 / 改写成 / 精简 / 删掉那句" | 沿用现在 `setNotes` 的语义 |

**第 3 步——代码块 / 公式保持"整体替换"**，不提供追加（一块代码 / 一个公式的语义决定了追加没意义），只靠第 1 步的确认保护。

**验收判据**
- 第 1 步：断言 ①「`setNotes` 传空串 / 内容变短 → 走确认流程」②「`setNotes` 正常写新内容 → **不**走确认」（防确认疲劳）③`DESTRUCTIVE_WRITE_LABELS` 补中文名 ④ 设置面板"不再询问"清单自动多出三项。
- 第 2 步：断言 ①「补充动作对"末尾已含该段"的备注不重复追加」②「改写动作仍可清空 → 回到第 1 步的确认」③ 工具数量断言同步更新（`known-issues.md` 里"写工具数量钉死"那批断言）。

**红线**：只动"写意图的破坏性标记 + 备注类工具的动作拆分"，**不动**许可闸门、试用计数、IPC 契约、事务语义。

---

## 3. 清空标题后节点不缩回（D-14，用户已判定为缺陷）

### 🟠 D-14 · 清空标题后节点不缩回最小尺寸

**级别**：P1（用户肉眼可感，2026-09-21 用户复现并**明确判定为缺陷**） ｜ **置信度：确认为缺陷；根因待一次运行时取证**

**现象**（用户的四步复现）
1. 中文输入法组词 → 2. 不按回车（拼音折成 5 行，见 D-07）→ 3. 按回车（合成一行）→ 4. **清空内容 → 节点框没有缩回最小尺寸**。

**代码预期值（判据）**
```
src/renderer/src/render/measure.ts:55-56   const MIN_WIDTH_ROOT = 120 ; const MIN_WIDTH = 76
src/renderer/src/render/measure.ts:329     let width = Math.max(Math.ceil(contentWidth) + base.paddingX * 2, base.minWidth)
src/renderer/src/components/TopicNode.tsx:179   width: node.width        ← 节点框宽度由布局测量值决定
```
即：**非中心主题清空后节点框应为 76px，中心主题 120px**；高度应为一行（`paddingY*2 + lineHeight`）。

**⚠️ 先说清楚：静态读到最后一环，链条上每一处都应该缩回**
已逐环核对过、**全部正常**（所以不要在这几处白找）：
- `tiptapToRich` 对空文档产出 `{ paragraphs: [{ runs: [] }] }`（`richtext/index.ts:404-405`），`plainTextOf` 得到 `''`（`:47-53`）→ `editingText === ''`；
- `use-canvas-layout.ts:88-91` 的 `topic.id === editingId && editingRich` 守卫**会通过**（`editingRich` 是真值对象）；
- `incremental.ts` 的 ④ 分支会 `measure(before.topic, before.depth)` 走 draft、比较出 `geometryChanged = true`，再走 ⑥ 分支并把 hot 路径塞进 `touched`（`:345-349`）；
- `core.ts:83-85` 的 `isClean` 只认 `touched`（不认戳），hot 节点必然脏 → 走 `:104-107` 用 `seedMeasures` 的新尺寸；
- `measure.ts:337-341` 的 `sizeOverride` 需要该节点被手动拉伸过才会生效。

**因此必须用一次运行时取证定死是哪一个**——先取证，再动手改（别先改再看）。

### 决定性探针（5 分钟，DevTools 控制台里粘）

在**编辑态、清空之后**跑这一段（仓库没有暴露全局 store 句柄，所以只读 DOM，足够判别）：

```js
(() => {
  const box = document.querySelector('.topic.topic--editing')
  const ed = box && box.querySelector('.rich-editor__content')
  const r = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)
  return {
    nodeInlineWidth: box && box.style.width,        // 期望 '76px'（非中心主题）/ '120px'（中心）
    nodeBoxWidth: r(box),                           // 屏幕上实际宽（含画布缩放）
    nodeInlineMinWidth: box && box.style.minWidth,  // 期望 '' 或 undefined
    nodeInlineHeight: box && box.style.height,      // 编辑态是 'auto'
    nodeInlineMinHeight: box && box.style.minHeight,
    editorInlineWidth: ed && ed.style.width,        // 期望 = (node.width - 2*14) + 1
    editorInlineMaxWidth: ed && ed.style.maxWidth,
    editorBoxWidth: r(ed),
    editorText: ed ? JSON.stringify(ed.textContent) : null   // 期望 ''
  }
})()
```

**三种读数 → 三种根因（互斥）**

| 读数特征 | 根因 | 去看 |
|---|---|---|
| `nodeInlineWidth` 仍是宽的（如 `'243px'`）且 `editorText` 为 `''` | **甲：布局/测量没吃到空内容** | `use-canvas-layout.ts:88-91` 的 measure 闭包；`incremental.ts` 的 ④/⑤ 分支（打印 `cache.pass` 看走的是 `refresh` 还是 `incremental`）；`core.ts:104-119` 的 seeded / memoized 命中情况 |
| `nodeInlineWidth === '76px'` 但 `nodeBoxWidth` 明显更大 | **乙：被 CSS / 内联最小尺寸撑开** | `TopicNode.tsx:176-184` 的 `minWidth/minHeight`；`.topic` 的 CSS（`styles/09-section.css:6-16`）；有无 `sizeOverride` |
| `nodeInlineWidth === '76px'` 且 `editorInlineWidth` 明显大于 `(76-28)+1` | **丙：编辑器内联宽度残留**（与 D-07/D-08 同源：`restore()` 还原到过期基准） | `RichTextEditor.tsx:192-200` 的宽度同步 effect 没跟上 `node.width` 变化 |

判出甲/丙之后，若还想进一步定位，在 `incremental.ts:344-355` 临时打一行 `console.log(cache.pass, cache.stats)`，清空一次即可看到当轮走的是哪条路径与命中数。

**修法方向（按候选）**
- 甲：让 ④ 分支对 hot 节点**强制**记入 `fresh`（现在的实现依赖 `cache.memo.nodes.get(id)` 存在），或在 `measureAll` 里把 `seeded` 的命中条件从"存在即用"收紧为"存在且尺寸确实来自本轮"；
- 乙：确认 `sizeOverride` 是否该在"标题被清空"时自动失效（这是**产品口径**：手动拉伸优先 vs 内容变空后重算）；若不该，就把 `TopicNode` 的 `minWidth/minHeight` 与 CSS 对齐；
- 丙：并入 D-08 一并修（`dom.style.width` 只留一个写入点）。

**验收判据**
- 手工：**非中心主题**清空后节点框宽度 == `76 × 缩放`，**中心主题** == `120 × 缩放`；高度回到一行。
- 建议补一条 Electron 脚本回归（见 §5.2）：编辑 → 清空 → 量 `.topic` 的 `getBoundingClientRect()`，与 `MIN_WIDTH × zoom` 比较。

---

## 3b. 🟡 D-15 · 启动时发**两次**更新检查，绕过"45 秒后再查"的设计（T3 抓到，文书侧读码确证并放大）

**级别**：P2（行为与设计不符 + 多余网络请求；会阻塞测试方案 T3） ｜ **置信度：高（读码确证）** ｜ ⚠️ 触及 §8 红线，但属**受控例外**（见下）

**现象**
应用启动约 1 秒就发一次更新检查请求（代码侧日志：启动 `12:29:14.958` → 检查 `12:29:15.825`），「启动 45 秒后再查、不跟应用抢启动」的设计被绕过。

**证据**
```
src/shared/update-policy.ts:26-29
  export function shouldRecheck(lastCheckAt: number | null, now: number): boolean {
    if (lastCheckAt === null) return true          // ← 「还没查过」被当成「该查」
    return now - lastCheckAt >= UPDATE_RECHECK_INTERVAL_MS
  }
src/main/update/index.ts:52      let lastCheckAt: number | null = null
                       :95       setTimeout(checkQuietly, 45_000)      // ← 首次检查的**本意**在这里
                       :98-101   app.on('browser-window-focus', () => {
                                   if (!shouldRecheck(lastCheckAt, Date.now())) return
                                   checkQuietly()
                                 })
```
**比代码侧描述更严重的一点**：`setTimeout(checkQuietly, 45_000)` **没有守卫**（`checkQuietly` 只负责"记时刻 + 发请求"）。所以启动时的实际行为是：
1. 窗口一获得焦点（约 1 秒内）→ `shouldRecheck(null, …)` 为真 → `checkQuietly()`；
2. 45 秒后定时器**再无条件**跑一次 → **第二次请求**。

即：启动时既抢了启动资源，又多打了一次网络请求。

**修法（受控例外——只修 null 分支，不动三条语义）**
1. `shouldRecheck`：`if (lastCheckAt === null) return false`（"还没查过"不算"到期"，首次检查只由 45 秒定时器负责）；
2. 45 秒定时器加守卫：`if (lastCheckAt === null) checkQuietly()`（避免用户在 45 秒内点过「检查更新」之后又补一发）；
3. 提交信息里写明这是 §8 的**受控例外**，并同步改 `docs/auto-update-test-plan.md` §8 的措辞为"判据语义不变，仅修正 `null` 分支"。

**验收判据**
- 自检断言：`shouldRecheck(null, now) === false`；`shouldRecheck(now - 6h + 1ms, now) === false`；`shouldRecheck(now - 6h, now) === true`（三条一起钉住语义没被顺手改掉）。
- 手工：打包版启动后 45 秒内日志**无** `updater` 检查记录；45 秒处恰好一条。

---

## 4. 已核实**无问题**（不要重复立案，也不要"修"它们）

| 项 | 核实结论 | 证据 |
|---|---|---|
| `sizeOverride`（手动拉伸）往返保真 | ✅ 写读成对、含数值收敛 | `xmind/serialize.ts:53-62` ↔ `xmind/parse.ts:131-137,184` |
| `activeSheet` 的 `!` 断言 | ✅ 安全：解析层保证 ≥1 画布（否则抛人话） | `xmind/parse.ts:357-359`、`xmind/emmx.ts:216-217` |
| 破坏性操作确认后的续跑 | ✅ **不会**被 `seenCallsRef` 当成"已执行"误伤（`resolvePending` 直接用 pending intent 执行再 `index+1` + `processQueue`） | `chat/use-chat-loop.ts:370-399` |
| `use-relationship-drag` 的 `onUp` | ✅ 有 `detach()`（读原文确认；grep 输出曾被截断，勿据此立案） | `canvas/use-relationship-drag.ts:101-107` |
| `detachTopic` 对浮动主题 | ✅ 两类子节点都找 | `model/tree.ts:143-158` |
| `dragmove` / `resources` / `outline` / `search` / `tree` 的遍历口径 | ✅ 都成对走了 `children` + `detachedChildren` | 各自相邻两行 |
| `countTopicTree` 只走 `children` | ✅ **有意**（给模型报"分支多大"，与实体层级一致），文件里有注释禁止合并 | `ai/context.ts:12-24` |
| `serialize` 的 `compact` / `xap:` 前缀 / 自家扩展剔除 | ✅ 与 `parse` 成对，"打开→另存"不会多出一份重复数据 | `xmind/serialize.ts:35-45,47-108` ↔ `xmind/parse.ts:193-200` |
| 全仓卫生 | ✅ 零 `as any` / 零 `@ts-ignore` / 零 TODO·FIXME；空 `catch` 仅 1 处且已注释说明 | 全仓扫描 |

---

## 5. 缺口分析：为什么"五道门槛全绿"仍藏这些 bug

**结构性错位**：2791 项自检断言**全部落在纯函数上**；本报告 15 条里，**只有 2 条**（`compositionBoxWidth` 的算术、`canContinueAgentLoop` 的上限）本来就能被纯函数断言覆盖。其余 13 条全在三类**没有网**的地方：

| 类别 | 涉及条目 | 为什么纯函数盖不住 |
|---|---|---|
| ① 状态机 / 时序边界（栈满 / 多标签 / 异步窗口 / 去重条件 / 启动时序） | D-01、D-02、D-03、D-05、D-06、D-15 | 要"跑一段交互序列"或"多路径拼起来的时序"，而现有断言都是"一次调用一个纯函数"。D-15 尤其典型：`shouldRecheck` **有**断言，但漏了 `null` 这个边界值，而缺陷恰好住在那里 |
| ② CSS × DOM × effect 的桥接 | D-07、D-08、D-14 | 断言没有 DOM；而这几条 bug 恰好由 CSS 约束 / DOM 尺寸 / effect 时序决定 |
| ③ 跨模块口径漂移（同一个概念在 N 处各写一遍） | D-04 | 断言"某函数的输出"，不问"某个目录有没有漏掉一类节点" |

### 建议补的三类网（按性价比排序）

1. **口径静态断言**（最便宜，一次钉死 D-04 同类）：扫 `src/shared/agent/**`，凡出现 `.children` 遍历必须有 `allChildrenOf` / `walk`；**带防空过守卫**（先断言扫到 ≥ N 处），照抄 `known-issues.md` 里「IPC 契约」「菜单命令」那两条静态断言的做法。
2. **纯函数断言补 D-01**（现在就能把 bug 钉红）：`beginAiTurn → 满栈 mutate ×200 → 改 3 处 → commitAiTurn`，断言"新增历史条目恰好 1 条 + 一次 undo 全回退"。
3. **一条 Electron 交互脚本**（覆盖 ②）：组词期不折行 + 清空后宽度符合 `MIN_WIDTH`。仓库里 `handover-next-session.md` §5 已证明这条路走得通（`shot.cjs` 截图、`t7-quit-semantics.cjs` 真 Electron 行为验证），只是从没用在编辑态几何上。这类脚本**不必进 selfcheck**，放 `.tmp-check/` 级别即可。

---

## 6. 验证环境备忘（复用）

- 五道门槛（每道单独打印退出码，日志重定向前先确认目录存在）：
  `npm run typecheck && npm run lint && npm run format:check && npm run selfcheck && npm run verify`
- 自检基线：**2791 项**（只增不减）
- 复现浮动主题：`samples/` 里的 `.xmind` 无浮动主题，需要**新造**一份（`xmind/serialize.ts` 支持 `children.detached`）或用带浮动主题的真实 Xmind 文件
- 复现组词期折行：需真实中文输入法（无法在自检里造），但可以用合成 `CompositionEvent` 脚本复现
- 复现 D-01：不需要真实 AI，直接对 `useEditor.getState()` 连续调用 store 动作填满撤销栈即可

---

## 附：本报告的证据来源（全部为当日实测/实读）

- 五道门槛：2026-09-21 实跑，全绿（`selfcheck` 2791 项）
- 线上：`smindapp.cn` 首页/下载页、`dl.smindapp.cn/latest.yml`、setup HEAD，均为当日实测
- 代码：逐文件读 + 目录级 `detachedChildren` 存在性扫描（`src/shared` 命中 14 文件 / `shared/agent/**` 零命中）
- 用户复现：中文输入法组词期折行 4 张截图（2026-09-21）
