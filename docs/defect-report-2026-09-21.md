# SMind 缺陷检测报告（2026-09-21）

> **审查者**：质检/文书侧（**本轮零代码改动**，只做只读审查）
> **审查基线**：`HEAD da0f478`（只看**已提交**代码；未提交的工作树改动不在范围内）
> **第二轮复验**：同日 21:1x，基线推进到 `HEAD cbc1ead`（工作树干净）→ **见 §7**（含新发现 **D-16**，🔴 P0）
> **第三轮复验**：同日 21:3x，基线推进到 `HEAD f66b073` → **见 §8**（8 条已修逐条取证 + 清单口径纠正 + 新登记 **D-17**）
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

**2026-09-21 晚追加（§7 复验结论）**：**D-16**（🔴 P0，上传脚本不产 `rt.yml` → 0.9.2 的"首跑验收"会**假通过**）＋ **D-01 已由 `cbc1ead` 修复并通过复核** ＋ **D-15 仍未落地** ＋ **A3 属"已交付但实测无效"**（= D-07，口径要纠正）。
**2026-09-21 深夜追加（§8 复验结论）**：**总账 17 条**（原 15 + D-16 + **新 D-17**）；**已修 8 条**（D-01/D-03/D-09/D-10/D-11*/D-12/D-15/D-16，其中 **D-11 只做了前一半**）；**剩余 9 条**（D-02/D-04/D-05/D-06/D-07/D-08/D-13/D-14/**D-17**）；自检 **2852**，五道门槛全绿；待推 **14** 条。

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
- 自检基线：**2791 项**（只增不减；2026-09-21 晚复验时已推进到 **2838**，见 §7.7）
- 复现浮动主题：`samples/` 里的 `.xmind` 无浮动主题，需要**新造**一份（`xmind/serialize.ts` 支持 `children.detached`）或用带浮动主题的真实 Xmind 文件
- 复现组词期折行：需真实中文输入法（无法在自检里造），但可以用合成 `CompositionEvent` 脚本复现
- 复现 D-01：不需要真实 AI，直接对 `useEditor.getState()` 连续调用 store 动作填满撤销栈即可

---

## 7. 交付复验（2026-09-21 晚 · 第二轮）

> **复验者**：同一质检/文书侧，**零代码改动**
> **复验基线**：`HEAD cbc1ead`（工作树**干净**，无未提交改动）
> **复验对象**：代码侧自报的 (a)(b)(c)(d) 四条交付
> **复验方式**：`git show` 逐提交看改动面 + 逐个能力点读实现 + 当日实跑五道门槛 + 线上/脚本实况核对

### 7.0 结论速览

| 自报交付 | 复验结论 |
|---|---|
| (a) A1/A2/A3 + 公式插 python + 编辑态快捷键 **三批修复** | ✅ 三批都在提交里、都有断言；**但 A3 的修复被 CSS 抵消 → 功能等于没做**（= D-07，另有 D-08）。**这条不能算"已修"** |
| (a) 0.9.2 + D3 源切回 OSS + `release/` 未被覆盖 | ✅ **复验通过**（时间戳 + SHA512 逐字比对，见 7.2） |
| (a) D2 本机回环（T1/T2/T5/T6/T9/T10） | 🔶 记录在案；**T3 = D-15 至今未修**；**且 D4 会静默失败（新发现 D-16）** |
| (b) F1–F5 登记进 `known-issues.md` | ✅ `3daedfe`，四段式 + `file:line` + 符号名（且自知"行号会漂、**符号名优先**"）｜⚠️ 只覆盖**第一轮** F1–F5；第二轮 D-04～D-15 仅在本报告 |
| (c) overlay 文字做成真富文本 | 🔶 **部分完成，口径必须收紧**（见 7.3） |
| (d) 格式栏 + 节点属性面板都加高亮 | ✅ `ba91793`，两个入口都在 |
| 每批补断言 + 过五道门槛 | ✅ 断言 2759 → 2791 → 2832 → **2838**（只增不减）；五道门槛当日实跑全绿 |

### 7.1 (b) 登记复验

`3daedfe` → `docs/known-issues.md` **+60 行**，每条四段式（现象 / 证据 / 建议 / 验收），证据带 `file:line` 与符号名，开头即说明「行号以 `65d028a` 为基准、**符号名优先**」——**符合本报告对"登记"的要求** ✓

⚠️ 范围差异：登记的是**第一轮 F1–F5**；第二轮 **D-04～D-15** 仍只存在于本报告（已随 `4d9b1e6` 落库），代码侧若按 `known-issues.md` 排期会漏掉它们。

### 7.2 (a) 三批修复 + D3 —— 逐条取证

| 项 | 提交 | 关键产物 | 复核结论 |
|---|---|---|---|
| A1 行内代码提交即丢 | `515aac2` | 新增 `shared/mono-font.ts`(24)、重写 `shared/inline-rules.ts`(83)、`richtext/index.ts`(+19)、`import/markdown/inline.ts` | ✅ 双向对齐（`code` mark ↔ 等宽 `fontFamily`），`code` 分支带 `fontFamily === undefined` 守卫 |
| A2 中文紧贴 markdown | `515aac2` | 新增 `editor/cjk-inline-rules.ts`(51) | ✅ 边界含 CJK、不含字母数字，配 4 条反向断言 |
| **A3 组词期宽度冻住** | `515aac2` | 新增 `editor/composition-width.ts`(36) + `RichTextEditor` 的 composition 处理 | ⚠️ **代码在、实测无效**：`.rich-editor__content` 是 `.topic__editor` 的 flex 子项且自身 `min-width: 0`，把 `max-width` 放开后 `width` 立刻被 **flex-shrink** 压回节点内宽 → 拼音照样折行（= **D-07**）。**放错了约束** |
| 点「公式」插入 python | `4c001f5` | 新增 `nodePanel/code-draft.ts`(40) + `topic-branch.tsx` | ✅ |
| 编辑态快捷键全失效 | `da0f478` | 新增 `app/shortcut-scope.ts`(52) + `use-keyboard-shortcuts.ts` | ✅ |
| 0.9.2 + D3 源切回 OSS | `65d028a` | `package.json`(0.9.2) / `electron-builder.yml` / `.gitignore` | ✅ `release-rt/win-unpacked/resources/app-update.yml` = `https://dl.smindapp.cn/`；`release/` 五个资产时间戳仍 09-20 10:48，setup 实算 SHA512(base64) 与线上 `latest.yml` 那条**逐字一致** → **0.9.1 未被覆盖成立** |

### 7.3 (c) overlay 富文本 —— 已完成 / 未完成（🔶 口径要收紧）

**已完成**（`6c3f078`，15 文件 / +396 −103）
- **数据层**：`Relationship` / `Boundary` / `Summary` 各加 `titleRich?: RichText`（`shared/model/types.ts`），纯文本 `title` 仍是主字段
- **`.xmind` 往返**：`serialize.ts` + `parse.ts`；抽出 `buildExtensions` / `splitOurExtensions` **统一"写入 + 剔除"**，主题那条老路径也换过来共用 → **顺带消掉了本报告此前担心的"两条路径各写一份、迟早有一边忘了剔除"**
- **布局与测量**：`overlayRunLines(rich, title)`、`OverlayLayout.titleRich`、`overlays/build.ts` 三个构造函数透传
- **画布按 run 分段渲染**：新增 `canvas/overlay-title-runs.tsx`（三处共用一份"行 → tspan"）
- **编辑入口**：`parseInlineRichText` 支持 `**粗体**` `*斜*` `~~删~~` `==高亮==` `^上标^` `~下标~` `` `等宽` ``；节点面板与画布双击编辑**走同一套解析**
- 自检 2819 → **2832**

**未完成（不能算在"已完成"里）**
1. **图形化「选中几个字 → 点按钮加粗」没有做**（提交说明自己列为"下一批"）。`nodePanel/overlay-branch.tsx` 的字体/颜色按钮仍作用于**整块**（`setOverlayStyle(kind, item.id, { bold: !styleText.bold })`），面板提示原文即「…下面的字体与颜色**作用于整块**」。
2. **"部分变色"做不到**：`parseInlineRichText` **没有颜色简写**，颜色只能整块设。

→ **准确口径**：`部分加粗 / 高亮 / 等宽 / 上下标` 靠**手写标记**可表达；`部分变色` 与 `选中点按钮` **均未支持**。对内排期与对外说明都按这句写，别让它以"已完成"进 0.9.2 说明。

### 7.4 🔴 新发现 D-16 · 上传脚本不产 `rt.yml` → rt.3 永远收不到真 0.9.2（**首跑验收会假通过**）

**级别**：🔴 P0（会让 0.9.2 的"首跑验收"结论失真，且症状静默） ｜ **置信度：高**（读脚本 + 线上实测）

**证据**
```
scripts/upload-oss.mjs:59-82   上传清单只有 4 项：
                               setup.exe / portable.exe / latest.yml / setup.exe.blockmap
                               —— **没有 rt.yml**
```
- rt 预发布构建的 `app-update.yml` 里是 `channel: rt` → electron-updater 的 `GenericProvider.getLatestVersion()` 会取 `getChannelFilename('rt')` = **`rt.yml`**；
- 线上实测：`https://dl.smindapp.cn/rt.yml` = **404**，`latest.yml` = **200**。

**为什么阶段一没事、阶段二会踩**
D2 本机回环的服务器目录里放的是 **rt.2 的四个资产（含 `rt.yml`）**，channel 对得上，所以 T2 能通过；而 D4 的 ⑧ 是 `npm run mirror:oss` 上传**真 0.9.2**，产物清单名是 `latest.yml` → **rt.3 请求 `rt.yml` 得 404**。

**影响**
装 rt.3 的机器永远收不到更新，而"例行检查失败"是**刻意静默**的（`docs/auto-update-and-license-delivery.md` 的设计）→ 现场表现是"什么都没发生"，极易被误判为"更新链路坏了"并白跑一轮验收（**这是本轮最贵的一个坑**）。

**修法（零成本，二选一）**
1. `upload-oss.mjs` 的 `targets` 增一条 `rt.yml`（内容 = `release/latest.yml` 另存，`contentType` 同 `latest.yml`）；
2. 或 D4 上传完手工把 `latest.yml` 复制成 `rt.yml` 对象。

**验收判据**：`curl -I https://dl.smindapp.cn/rt.yml` = **200**；rt.3 在 45 秒~数分钟内日志出现 `updater` 检查成功并收到 0.9.2（版本号随之变化）。

### 7.5 其他两条待收口

**7.5.1 测试方案 §3 与 §5 的版本号口径打架**
`docs/auto-update-test-plan.md` §3 表格写阶段二装 **`0.9.2-alpha.1`**，§5 执行步骤写 **`0.9.2-rt.3`**；同文件「版本号安排（2026-09-21 修订）」已统一为 `rt.1 / rt.2 / rt.3` → **§3 是过时残留**，照它打会打错版本号，并让 §5 的 ⑦⑧ 对不上。

**7.5.2 D-15（代码侧称 T3）至今未修**
`git log -- src/shared/update-policy.ts src/main/update/index.ts` 最新仍是 `43aadc1`。裁决见 §3b/D-15：**批准修，属 §8 红线的受控例外**（只改 `lastCheckAt === null` 分支 + 给 45 秒定时器加守卫 + 三条断言钉住语义）。

### 7.6 顺带确认：D-01 已修，且**修法正确、无过修**

`cbc1ead`（3 文件 / +99 −9）即本报告 D-01，**采了首选方案**并有三点加分：
- 用**单调递增 `turnSeq`** 取代"入栈下标"：`aiTurn: { turnSeq, selectionBefore }` + 新增 `aiTurnSeq: number`；`commitAiTurn` 改为 `undoStack.filter((e) => e.turnSeq === turn.turnSeq)`；
- **合并条目插回本回合第一条的位置**（不是一律追加到末尾）→ 回合内夹着手动改动时撤销次序不会乱；
- **跨回合不参与 coalesce**（`canMerge` 增加 `last.turnSeq === turnSeq`）→ 防两轮 AI 粘成一步。
新增 6 条断言，其中两条正是本报告的判据（"栈满后一条覆盖三处"＋"一次 `undo()` 三处全回退"）；提交信息并**如实交底 D-02 / D-03 未做**。
✅ **复核结论：通过**（判据全部满足，未过修）。

### 7.7 复验当日的门槛状态（实跑）

| 门槛 | 结果 |
|---|---|
| `typecheck` | ✅ exit 0 |
| `lint --max-warnings 0` | ✅ exit 0 |
| `format:check` | ✅ exit 0 |
| `selfcheck` | ✅ **2838 项** |
| `verify` | ✅ 21 `.xmind` + 4 `.emmx` 全部往返一致 |

> 注：本报告 §5 的诊断依然成立——2838 项仍**全部落在纯函数上**，D-07 / D-08 / D-14（CSS × DOM × effect）与 D-16（脚本产物清单）纯函数盖不住，这也是这轮"全绿但仍有假账"的原因。

---

## 8. 第三轮复验（2026-09-21 深夜 · 批 A 与更新链路）

> **复验基线**：`HEAD f66b073`（工作树仅本文件未提交）
> **复验对象**：代码侧自报「**14 条 → 已修 6 条**」及下一轮清单
> **一句话结论**：**实际已修 8 条、且逐条取证通过**（不止 6 条 —— **D-15 / D-16 也已修掉**）；**清单口径有三处要纠正**；**新登记 D-17**。

### 8.1 已修 8 条 · 逐条取证

| # | 提交 | 复验结论 |
|---|---|---|
| D-01 | `cbc1ead` | ✅ 见 §7.6（`turnSeq` 取代下标，修法与判据一致，无过修） |
| D-09 | `517fc6b` | ✅ 采**推荐方案**（记原位 → 放回 → 如实返 `false`）。**重点验的一环**：`findParent` 走 `walk`（两类子节点都走）且额外用 `originDetached` 标记落点 → **浮动主题也放得回原位**，这条过得干净 |
| D-10 | `517fc6b` | ✅ 语义下沉到树层 `attachChild`（`-1`=末尾、`<=-2` 倒数），规划层不再夹取。旧行为里 `-1` 本来就是"追加到末尾"，**只有 `<=-2` 才改变行为** → 影响面可控；并补了「`0` 仍落最前」防改坏正常语义 |
| D-11 | `517fc6b` | 🔶 **部分完成**：`.finally(endSave)` 已做；报告里的「同时标记为**后台任务**、不要混进 AI 回合耗时归属行」**未做，且提交信息未交底**（属"静默半成品"） |
| D-12 | `517fc6b` | ✅ `detachRef` + hook 最外层 cleanup effect 兜底，机制正确 |
| D-03 | `49fccfe` | ✅ `docRevision` + `markSaved(path, revision)`，判据正确（`dirty: docRevision === revision ? false : dirty`）；两个保存调用点都传了代次；顺带暴露并修掉一处旧断言少参数（说明签名变更被类型网兜住） |
| D-15 | `f66b073` | ✅ 与 §3b 给的修法**逐字一致**（`null → false` + 45s 定时器守卫 + 三条断言 + `auto-update-test-plan.md` §8 措辞同步）。**加分**：主动发现并改掉一条"把错行为钉死"的旧断言，且交底了实测失败数（2851/1）。⚠️ 未做：本机未重跑 T3（需真机构建，随 rt.3/D4 一起验） |
| D-16 | `03343ab` | ✅ 加 `rt.yml` target，`sourceName: 'latest.yml'` 指回同一份内容、对象名 `rt.yml`、`text/yaml` —— 正是 §7.4 的方案；HEAD/PUT 仍按对象名走，跳过已传逻辑不受影响。**诚实交底**：本机无 AK，未真传，验收待 D4。⚠️ 这条**没有任何回归网**（`.mjs` 无断言，建议补一条静态断言钉住 `targets` 里有 `rt.yml`） |

### 8.2 清单口径三处纠正

1. **总数不是 14，是 17**（原 15 + D-16 + 新 D-17）；**已修 8**、**剩余 9**：D-02、D-04、D-05、D-06、D-07、D-08、D-13、D-14、**D-17**。
   代码侧把 **D-15 从"剩余"里漏掉了** —— 它其实已经修掉，所以"8 条"这个数字碰巧对上了，但**来源是错的**。这种"清单与仓库不同步"正是 0.9.2 前最该避免的：下一个人会照清单干活。
2. **下一轮顺序自相矛盾**：正文写「下一轮第一优先就是 D-07/D-08」，而编号清单里它排第 **4**（在 D-06/D-04/D-05 之后）。**以正文为准**，理由见 8.3。
3. **待推不是 13 条**：`git status -sb` = `main...origin/main [ahead 14]`（差的那条是 `f66b073`）。

### 8.3 下一轮排序建议（与代码侧清单的三处差异）

| 顺序 | 项 | 为什么排这里 |
|---|---|---|
| **1** | **D-07 + D-08（+ D-14 探针）** | 用户已复现（4 张截图）；且 **A3 那条"修复"目前是假账**（放开的是 `max-width`，卡住的是 flex `shrink`）。D-08 的"宽度只留一个写入点"同时是 D-14 丙类根因的解 → 三条一起做最省 |
| **2** | **D-17**（新，待裁决） | 见 8.4：**可能把 B 的内容写进 A 的文件** |
| 3 | D-02 | 剩余里最大一块（`main/autosave.ts` + IPC + 恢复链），要留足时间，别压在 D4 前 |
| 4 | D-06 | 改动最小（`docRevision` 已就位，只需接上去重键） |
| 5 | D-04 | 7 处 + 静态口径断言，性价比高但纯 AI 侧、用户不可见 |
| 6 | D-05 / D-13 / D-14 | D-14 必须先跑探针取证再动手 |

### 8.4 🟠 新登记 D-17 · 保存期间切标签 → `markSaved` 落到**另一个文档**（可能覆盖别的文件）

**级别**：🟠 P1（**潜在数据丢失**，窗口窄但静默） ｜ **置信度：高（四环读码闭环，未做运行时确认）**

**证据（四环缺一不可）**
```
① 发起写盘时抓快照与代次，然后 await
   src/renderer/src/app/use-document-actions.ts:63-65
     const state = useEditor.getState(); const revision = state.docRevision
     await window.api.saveToPath(activeDocId(), state.filePath, state.workbook)
     useEditor.getState().markSaved(state.filePath, revision)      ← 此刻可能已是**另一个文档**
② 切标签会**换掉**编辑器里的当前文档（不等在途保存）
   src/renderer/src/store/tabs.ts:184-187   switchTo: commitEditing() → applyToEditor(target)
   src/renderer/src/store/tabs.ts:209       closeTab 关掉激活标签时同理
③ applyToEditor **不动 docRevision**，快照里也根本没捕获它（:80-108）
   → 代次在切标签后**仍然相等**，「dirty 判据」拦不住
④ markSaved 的 filePath 是**无条件**写的
   src/renderer/src/store/slices/document.ts:131-135
     markSaved: (path, revision) => set((state) => ({ filePath: path,
                                     dirty: state.docRevision === revision ? false : state.dirty }))
```
**触发路径**：大文档（带图片/附件，`serializeXmind` 实测可到数百毫秒）按 Ctrl+S → 写盘未回来时点另一个标签（或关掉当前标签）→ `applyToEditor` 换文档 → 写盘回来执行 `markSaved(A 的 path, A 的代次)` → **B 文档拿到 A 的 `filePath`，且 `dirty: false`**。
**后果**：此后在 B 上按 Ctrl+S → `saveToPath(activeDocId(), state.filePath /* A 的路径 */, state.workbook /* B 的内容 */)` → **把 B 的内容写进 A 的文件**；而界面全程没有任何异常提示。

**修法建议（与 D-03 同源，把"代次"升级成"身份 + 代次"）**
- `markSaved(path, docId, revision)`：`docId` 用保存发起时的 `activeDocId()`；返回时若 `docId !== activeDocId()` 则**既不写 `filePath` 也不清 `dirty`**（这笔写盘对当前文档毫无意义）；
- 或者更彻底：切标签时**作废在途保存**（保存回调只认自己那一份文档快照）。
- 不要用「切标签时重置 `docRevision`」来治 —— 那会让"保存期间切回来"的判定更乱。

**验收判据**
- 断言：「保存返回时 `docId` 已变 → `filePath` 不变且仍脏」；
- 断言（回归网）：「同一文档、代次未变 → 正常清脏」（防改过头）；
- 手工：打开两个标签，在大文档上 Ctrl+S 后**立刻**点另一个标签，确认两个标签的 `filePath` 都没被串改、标题栏 `●` 状态正确。

### 8.5 门槛与推送（当日实跑）

| 项 | 实况 |
|---|---|
| 五道门槛（`HEAD f66b073`） | ✅ `typecheck` / `lint` / `format:check` / `selfcheck` / `verify` **全绿** |
| 自检断言 | **2852**（2791 → 2832 → 2838 → 2844 → 2849 → 2852，「只增不减」成立） |
| 待推提交 | **14 条**（`main...origin/main [ahead 14]`）—— 沙箱网络不通，等本机推 |
| 工作树 | 仅本文件（§7/§8）未提交 |

> **口径提醒（给下一个人）**：D-15 那批**修改了一条既有断言**（把错行为钉死的那条）。这类改法是允许的（被改的断言本身在钉 bug），但**必须逐条交底**——本轮交了 ✓。"只增不减"指的是**净增**，不是"一行都不许动"。

---

## 9. 第四轮复验（2026-09-21 深夜 · 收尾三批 + D-02 放行裁决）

> **复验基线**：`HEAD 7030a3a`（五道门槛实跑全绿，自检 **2852**，待推 **15** 条）

### 9.1 三批取证

| 批 | 提交 | 复核结论 |
|---|---|---|
| B1 · D-16 | `03343ab` | ✅ 见 §8.1（`rt.yml` 换对象名上传，方案与 §7.4 一致） |
| B4 · D-15 | `f66b073` | ✅ 见 §8.1（与 §3b 修法逐字一致 + 交底旧断言改动） |
| B5 · 文书两处 | `7030a3a` | ✅ `0.9.2-alpha.1` → `0.9.2-rt.3`（§3 表格 + 段说明）；`known-issues.md` 新增「已修 / 未修 + overlay 口径收紧」，**并把 A3 实测无效写进去、明确"不得按已修记账"** —— 这是本轮最该表扬的一处（主动认账 + 写进排期文件，不靠口头）。⚠️ 残留一处：`auto-update-test-plan.md:19` 仍以 `0.9.2-alpha.1` 举例（属**示例文本**非规格，可选统一） |

**未做（如实交底）**：**D-07 / D-08**，自述理由是「验证链（真机 8 音节不折行 + 单一写入点 + Electron 合成 composition 量 `getBoundingClientRect()`）这轮预算做不完，不盲改」——**这个理由我认可**，A3 的教训恰恰就是"改了代码就当修好了"。但它仍是**用户可见项 + 一条假账待平**，必须排下一批第一条。

### 9.2 D-02 的 IPC 契约受控例外 · **批准**（改动面比报告写的大，必须分两步）

**放行的核心安全理由**：本仓库 IPC 契约集中在 `src/shared/ipc.ts` 一处且全程有类型 → **改签名会被 `typecheck` 全量兜住**，风险有界。这比"没人拦得住的样式/时序改动"更可控，所以这条例外可以批。

**但实际改动面不止 `clearAutosave` 一处**（读码清单）
```
shared/ipc.ts:251-266        autosave(docId,…) / clearAutosave() / recoveryCheck() / recoveryLoad(docId) / recoveryDiscard()
main/autosave.ts:18-19       autosaveFile(slot) / autosaveMeta(slot)   ← 按**窗口**命名，docId 根本没进文件名
main/ipc/document.ts:84-105  autosave 写 state.slot；autosaveClear 删掉**整个 slot**
main/ipc/recovery.ts:19-77   recoveryCheck / recoveryDiscard 全按 slot；recoveryLoad 读 slot 后再挂到入参 docId 名下
main/windows.ts:248-257      窗口关闭时删本窗口的 slot 文件
app/use-window-close.ts:72   关窗时 clearAutosave()
```
→ **只给 `clearAutosave` 加参数不够**：`recoveryCheck()` 仍按窗口只认一份，非激活标签的存档**即便写了也没人恢复**。

**分两步（本批别一口吃下）**
- **第 1 步（本批）**：`autosave` 按 `(slot, docId)` 落文件 + `clearAutosave(docId)` 只清那一份 + `recoveryCheck` 返回**列表**（退一步：先返回"最近一份 + 总数"）+ `recoveryLoad(docId)` 读对应文件；**窗口关闭仍清本窗口全部**（`windows.ts` 与 `use-window-close` 两处都要覆盖，漏了就出"幽灵恢复"）。
- **第 2 步（单开一批）**：恢复 UI 支持逐份 / 全部恢复（当前是单份对话框）。

**⚠️ 必须防的半修**：若写了 `slot-docId.xmind` 而恢复侧仍读 `slot.xmind`，多标签恢复会从"只恢复一份"退化成"**一份都恢复不了**"。所以第 1 步必须**写读同时改**并带断言；做不完就在 `known-issues.md` 写"未修"，**不许留半截**。

**断言要求**：① 两个 docId → 两个不同文件；② `clearAutosave(A)` 不动 B；③ **不传 `docId` 时不得删任何文件**（fail-safe，防漏改调用点变成"清全窗"）；④ "关窗清全部"这条路径仍成立。

### 9.3 顺带修掉一处仓库自洽问题

`known-issues.md`（`7030a3a` 已提交）引用了报告 **§7 / §7.1**，而报告 §7/§8 当时**尚未提交** → 别人 checkout 会找不到该节（悬空引用）。已在本轮随本文件一并提交。

---

## 10. 第五轮复验（2026-09-21 深夜 · D-07/D-08、D-17、D-02）+ 新登记 D-18

> **复验基线**：`HEAD f61e82b`（五道门槛实跑全绿，自检 **2857**，待推 **19**，工作树干净）

### 10.1 三批取证

| 批 | 提交 | 复核结论 |
|---|---|---|
| 1 · D-07/D-08 | `cb98bd9` | ✅ **机制对了**：两个 effect 合并成一个宽度 effect，`dom.style.width` 只剩一处写入、`baseWidthRef` 归同一处；组词期 `flex: 0 0 auto` + `maxWidth: none` 直接打在 D-07 的根因（flex-shrink）上。🔶 **但真机验收未跑** → 仍是"改了没验证"，与 A3 同一位置（差别是这次**如实标注了**） |
| 2 · D-17 | `d64764d` | ✅ 修法与 §8.4 等价（额外把 `saveToPath` 的 docId 改用发起时的，顺带修掉"写盘用错 docId"）。⚠️ 未采用 `markSaved(path, docId, revision)` 三参形式，理由是"document 切片拿不到 tabs 的当前文档、会循环依赖"——**这个理由成立**。⚠️ 见 10.3-④ |
| 3 · D-02 | `f61e82b` | 🔶 **部分完成，且引入两个新问题** —— 见 10.2 / 10.3 |

> **D-07 的 CSS 复核**（我自己查的）：`.topic`（`09-section.css:6-16`）与 `.topic__editor`（`:350-358`）**都没有 `overflow: hidden`** → 加宽后的文字不会被裁切，最坏是**溢出到节点框外**（与提交说明里交底的一致）。所以真机验收要看的是「折行消失」，而不是"被截断"。

### 10.2 🔴 D-02 **不能记成已修**：核心症状仍在一条常见路径上

**现状**（`main/ipc/document.ts:99-129`）：存档按 `(slot, docId)` 落文件 ✓、`clearAutosave` 不再清整槽 ✓ —— 这两条**做到了**。
**但** `autosaveClear` 删的不是"**刚保存的那个文档**"，而是"**最近被自动存档过的那个文档**"（模块内 `lastAutosaveDocIds` 只由 `autosave` 处理器更新）：

```
A 脏 → 30s 定时器存 A → lastAutosaveDocIds = A
用户切到 B（A 被 park、仍脏）→ 编辑 B
B 上按 Ctrl+S（B 还没到下一次定时器）→ 保存成功 → clearAutosave()
   → 删掉的是 **A 的存档** + latest  ← 而 B 自己的存档此刻并不存在
⟹ A 仍然脏，却**失去了崩溃保护**；崩溃后 A 照样不可恢复（= D-02 的原症状）
```
**根因**：主进程没有"这次保存的是谁"的信息，于是用了一个**猜**（最近自动存档者）。而这个信息其实就在手边 —— `saveToPath(docId, …)` 的入参里就有。

**修法（二选一，都不大）**
1. **最小（仍不改契约）**：在 `saveToPath` / `saveAs` 两个处理器**写盘成功后** `lastAutosaveDocIds.set(slot, docId)` —— 之后紧跟的 `clearAutosave()` 删的就是刚保存的那个文档；
2. **干净（= §9.2 已批准的例外）**：`clearAutosave(docId)`，调用点传 `docIdAtSave`。**上一轮我批的就是这条**，用不用都行，但**语义必须对**。

**验收判据**：纯函数/断言覆盖不到 → 按 10.5 的手工步骤验（重点看"另一个标签的存档还在不在"）。

### 10.3 本轮新登记 D-18（四条，两条是这次改动自己引入的）

**① 🔴 中文注释被破坏成 `?`（`src/main/ipc/document.ts`，4 处，含一整段 JSDoc）**
```
:31   /** ?????????????????????? id??clearAutosave ?????????????D-02? */
:98   // ? docId ??????????????????????? D-02?
:109  // ????????????????recovery.ts ???????????????
:118-122  /** **??????????????**…… */   ← 整段注释报废
```
**全仓 grep 确认范围只有这一个文件**（与提交说明里"第一版脚本改坏过该文件、回滚后单点插入"吻合）。
**为什么五道门槛全绿也拦不住**：注释不参与 typecheck / lint / format / selfcheck / verify —— 又一个"全绿 ≠ 没问题"的实例。
**根因**：用脚本写文件时没显式 UTF-8。
**要求**：修复这 4 处；并立一条硬规矩 —— **任何脚本改写文件必须显式 `'utf8'`，改完 `git diff` 扫一眼中文**。

**② 🟠 per-doc 存档没有任何回收路径 → 无界增长 + 幽灵存档**
`autosaveClear` 只删"最近那个 doc"的 + latest；`recoveryDiscard`（`main/ipc/recovery.ts:72-77`）只删 latest；关窗清理（`main/windows.ts:248-257`）也只删 latest。
→ 其余 `slot-*.xmind/.json`（每份都是完整 .xmind，可含图片/附件资源）**永久留在 `%APPDATA%/SMind/autosave/`**，没人删、下次启动也不清、恢复链也不会读它们 = **占盘且永不生效的幽灵存档**。
**修法**：关窗按**前缀**清本 slot 的全部（`slot-*`）；`autosaveClear` 顺手清自己那份；或启动时扫一次目录只保留 latest。**断言**：给了 N 个 docId 的存档后执行关窗清理 → 目录里不再有本 slot 的残留。

**③ 🟡 `latest` 副本是"双写"**：每次 autosave 写两份（per-doc + latest）。功能上没错（保住了恢复链的旧行为、且 `latestAutosaveFile(slot)` 路径与旧 `slot.xmind` **同名**，升级后旧存档仍可读 ✓），但**两份内容必须同步**，将来任何只改一处就会出"恢复出来的是旧内容"。建议加一条注释钉住"两份必须同一个 bytes"，或干脆让恢复链扫目录取最新。

**④ 🟡 D-17 的 `return false` 分支缺提示**：`use-document-actions.ts` 里"标签已切走"时直接 `return false` —— 而**内容其实已经落盘**，用户看到的是"按了 Ctrl+S、脏标记还在、没有任何提示"。建议给一条可读 toast（如「已保存到 A（你已切到 B）」），别让用户以为保存失败又存一遍。

### 10.4 断言与门槛

| 项 | 实况 |
|---|---|
| 断言 | 2852 → **2857**（+5：`autosaveKeyOf` 的两 docId / 稳定性 / 跨窗口同名 / 路径分隔符清洗，另含 **D-16 静态断言**补齐 ✓） |
| 五道门槛 | ✅ 全绿（`typecheck` / `lint` / `format:check` / `selfcheck` / `verify`） |
| D-16 的零断言问题 | ✅ 已补（这条上轮被点名，本轮补上了） |

### 10.5 只能由**用户本人**跑的三项真机验收（代码侧起不了稳定 GUI 会话）

1. **D-07 组词不折行**：进编辑态 → 中文输入法连打 8+ 音节（如 `dawadawdwa`）**不回车** → 拼音须保持**一行**。若拼音溢出到节点框外，属"最小可见修"的已知代价，记录下来即可。
2. **D-02 多标签崩溃恢复（重点）**：开 A/B 两标签各改一笔（**都不保存**）→ 等 ≥30 秒（让定时器存一次）→ 切到另一个标签再改一笔 → **强杀进程** → 重启 → 看提示恢复的是谁。**重点确认 A 还在不在** —— 这正是 10.2 的洞。
3. **D-17 保存中切标签**：两标签 + 大文档（带图片最佳）→ 在 A 上 Ctrl+S → **立刻点 B** → 两个标签的路径/标题都不得被串改。

---

## 11. 第六轮复验（2026-09-21 深夜 · D-02 第 1 步）+ 新登记 D-19

> **复验基线**：`HEAD 4a85800`（五道门槛实跑全绿，自检 **2862**，待推 **21**）
> **背景**：这是**全项目风险最高的一次改动**（IPC 契约 + 写侧 + 读侧 + 关窗路径同时动），故逐环节读实际实现，而不是只看提交说明。

### 11.1 判对了的六处（含一处比报告建议更细）

| # | 实现 | 复验 |
|---|---|---|
| 1 | `clearAutosave(docId)` 必填 + 纯函数 `autosaveKeysToClear(keys, docId)`：`if (!docId) return []` | ✅ **fail-safe 真成立**：漏改的调用点不会退化成"清全窗" |
| 2 | 保存点传的是 **`docIdAtSave`**（不是 `activeDocId()`） | ✅ 正确 —— 保存期间切了标签也不会清错份（正是 §10.2 的修法②） |
| 3 | `autosaveClear` 里「latest 副本只在它确实属于刚清掉的那份时才删」（`document.ts:134`） | ✅ **比报告建议更细**：避免顺手删掉别的标签的"最近一份" |
| 4 | `windows.ts` 关窗改为**枚举每一份** per-doc 存档清理 | ✅ 既保住"关窗清全部"语义，又**顺带修掉了 D-18②**（存档回收） |
| 5 | `recoveryCheck` 逐份枚举 + `savedAt` 倒序 + 可选 `docId` 字段 | ✅ 多标签时**非最新**的存档也能进候选（数据层） |
| 6 | `recoveryLoad(docId, savedDocId?)` 按份读；`recoveryDiscard(savedDocId?)` 不传=清全部 | ✅ 读侧与写侧同时改了，**没有留半截** |

> 门槛：`typecheck` / `lint` / `format:check` / `selfcheck`（**2862**，+5）/ `verify` **全绿** ✓

### 11.2 🟠 新登记 D-19 · 升级后的「旧存档」不再被提示恢复（本次改动引入的兼容回归）

**证据**（`main/ipc/recovery.ts:37-40`）
```
const items: RecoveryInfo[] = []
for (const docId of await listAutosaveDocIds(state.slot)) { … }      ← 只枚举 `slot-N-<docId>.xmind`
```
而 `listAutosaveDocIds`（`main/autosave.ts`）是**前缀 + 后缀**过滤（`slot-N-` 开头、`.xmind` 结尾）→ **旧格式存档 `slot-N.xmind` 不在列表里**（它既不是 `slot-N-` 开头，也恰好就是 `latestAutosaveFile`）。

**触发路径**：升级前崩溃退出 → 磁盘上只有旧的 `slot-1.xmind` → 升级后启动（**此时还没跑过任何 autosave**）→ `recoveryCheck` 返回 `{ items: [], total: 0 }` → **不再提示恢复**，那份未保存内容静默作废。
**这是回归**：改动前 `recoveryCheck` 读的就是 `slot.xmind`（= 现在的 `latestAutosaveFile`），是会提示的。

**修法（~6 行）**：`recoveryCheck` 里在逐份枚举之后**兜底**读一次 `latestAutosaveMeta(slot)`：若存在、且没有任何 per-doc 项与之同源（或 items 为空），就作为一项 `{ …, docId: undefined }` 返回。
`recoveryLoad(docId, undefined)` **已经**能读 latest（`recovery.ts:71`）→ **读侧已兼容，只差 check 侧这一处**。

**验收判据**：造一个只有 `${slot}.xmind`（无 per-doc 文件）的 autosave 目录 → `recoveryCheck` 必须返回 **1 项**；再补一条"升级后第一次 autosave 之后，latest 与 per-doc 不重复计数"的断言。

### 11.3 D-18 四条的现状

| 子项 | 现状 |
|---|---|
| ① `document.ts` 中文注释被脚本改坏 | ✅ **已修完**（提交 **`8243320`**；原文写的是 `499b0ac`，该 hash 在历史重写后已失效 —— 见本节附注）。初次撰写时还剩 `:111` 一处**未提交**，随后清除 → 复验：全仓 `\?{4,}` 扫描 **0 命中** |
| ② per-doc 存档无回收 | ✅ **已修**（`windows.ts` 枚举每份清理） |
| ③ `latest` 双写需同步 | 🔴 **未做**（仍写两份；`document.ts:112-113`） |
| ④ D-17 `return false` 分支缺提示 | 🔴 **未做** |

> 代码侧自述"没读 §10.3 的正文"——**这正是"清单与文档不同步"的又一次**：报告里的登记项必须被读到，否则同一批会把已修的和没修的一起漏掉。

### 11.4 D-02 的最终口径（别记成已修）

- **数据层**：✅ 修对了（逐份存、只清自己那份、关窗清全部、读侧同步）—— §10.2 点名的核心症状（保存 B 抹掉 A 的保护）**已解决**；
- **用户可见层**：🔴 **仍未达成**。恢复界面**仍只提示一份**（自述"留待下一批"），所以用户看到的行为与改动前一样：只弹最近那一份；
- **真机验收**：🔴 未跑（两标签各改一笔 → 强杀 → 重启）。
→ 结论：**D-02 记「部分完成」**，剩「恢复 UI 逐份/全部」+「真机验收」两件。

### 11.5 仍未跑的真机验收（只有用户能做）

1. **D-02**：A/B 各改一笔**都不保存** → 等 ≥30 秒 → 切标签再改一笔 → **强杀进程** → 重启 → **重点看 A 是否还在候选里**；
2. **D-07**：编辑态 → 中文输入法连打 8+ 音节不回车 → 拼音须保持一行（溢出框外属已知代价）；
3. **D-17**：两标签 + 大文档 → A 上 Ctrl+S → 立刻点 B → 两边路径不得串改。

---

### 11.6 附注：一次历史重写（2026-09-21 深夜）——内容无丢失，但留下两个副作用

**发生了什么**：代码侧修注释时误用 `git commit --amend`，而当时 HEAD 已是文书侧的 §11 报告提交 → 两件事被并进同一个提交。事后用 `reset --soft` + `-C 7851e7c` 复用原 message 拆回两个干净提交：`8243320`（仅 `document.ts` 3 行）、`31e5786`（仅报告 61 行）。

**复验结论：内容无丢失** ✓
- 章节查重：`§0`–`§11` + 附，**各一次**，共 **736 行**；`git status` 干净；
- 关键提交均在：`4a85800`（D-02 第 1 步）、`2429d7d` / `67c7af2`（报告 §7–§10）；
- 文书侧原提交 `b3e510b` / `f2a2dcf` 的对象仍在，但**已不在分支上**（内容由 `31e5786` 承载，§11 正文与那处更正都在）。

**副作用（两条，都要防）**
1. **文档里的旧 hash 变悬空**：本节 11.3 ① 原引用 `499b0ac`（已被 `8243320` 取代）→ 已改正。**凡是改写历史，必须 grep 文档里引用的旧 hash。**
2. 修订历史里出现了"同名两条提交"（`499b0ac` 与 `432b06d` 都写"修复 3 处"，实际是分两次修完）→ 回溯困难。

**立的规矩（硬性）**：共享分支上**禁止 `--amend` / `rebase` / `reset` 改写历史**，除非**先确认那几个提交确定是自己的**；确需改写，改完必须扫文档里的旧 hash。

**另：一次自我更正**。§10.3 ① 列的损坏位置有 4 处，是**基于 `f61e82b` 那一版 diff** 得出的；其中 `:118-122` 那段 JSDoc 在 `4a85800` 重写 clear handler 时**已被顺带写回正常中文** → 实际待修的是 **3 处**（`:33` / `:100` / `:111`）。代码侧说的"清单偏保守"成立，成因是**行号随版本漂移** —— 这正是本报告开篇立的规矩（"行号以提交为基准、**符号名优先**"）。

---

## 12. 第七轮复验（2026-09-21 深夜 · D-19 / D-18③ / D-18④）

> **复验基线**：`HEAD 7f462fb`（五道门槛实跑全绿，自检 **2866**，待推 **25**，工作树干净）

### 12.1 三条取证

| 条 | 结论 |
|---|---|
| 🟠 **D-19** 升级兼容兜底 | ✅ **做完，且我专门验了"不会重复计数"**：兜底写作 `if (items.length === 0) { … }`（`main/ipc/recovery.ts:67-86`）→ per-doc 已有候选时**不执行**，不会同一份内容被列两次。兜底项**有意不带 `docId`**（`recoveryLoad(docId, undefined)` 读「最近一份」，读侧本来就支持）。**并且对旧存档同样跑了 `shouldOfferRecovery`** —— 不会把过期内容当作可恢复项推给用户，这一步容易被漏。另外把前缀判据抽成纯函数 `isPerDocAutosaveName`，主进程与自检共用 ✓ |
| 🟡 **D-18③** | ✅ **结案**：约束已钉在两处（`main/autosave.ts` 的定义注释 + `document.ts:111` 的调用点注释），本轮只补口径与断言、不重复改代码 —— 处置正确 |
| 🟡 **D-18④** | ✅ 两个分支各补一条 toast，且**路径用的是各自分支的正确来源**（`saveAs` 用 `result.path`、`saveToPath` 用 `state.filePath`）✓ 措辞也准确（"已保存到 X（你已切到别的标签，那边的保存标记没有动）"——写盘确实成功了，只是不该串到当前文档） |

门槛：全绿 ✓；断言 **2862 → 2866**（+4：旧格式名不被认作 per-doc / per-doc 名被认出 / `slot-1-` 不误吞 `slot-10-` / 兜底存在的源码级断言）。

### 12.2 ⚠️ 本轮最重要的发现：**挂账的根因不是代码，是「没有真机验证通道」**

把当前所有未结项按"卡在哪"归类：

| 卡点 | 条目 | 说明 |
|---|---|---|
| **卡在"跑不到"** | **D-02**（真机：两标签→强杀→重启）、**D-07**（真机：输入法连打 8 音节）、**D-14**（需跑 DevTools 探针定甲/乙/丙）、**D-19**（目录级：`recoveryCheck` 在主进程且依赖 `ctx.stateOf(sender)`，纯 Node 自检跑不到）、**D-18②**（目录级断言同因） | **五条挂账全卡在同一处** |
| 卡在"没预算" | D-11 后半、恢复 UI 逐份、D-06/D-04/D-05/D-13① | 这些是能测的，只是没排上 |

**结论**：`selfcheck` 已经 **2866 条**、五道门槛全绿，但**能测的维度和真实缺陷的维度仍然错开**（= §5 的判断，这一轮给出了它的"成本量化"：**5 条 bug 被同一个瓶颈卡住**）。
→ **下一批的第一优先级应该是一项"验证能力"交付，而不是又一条 bug 修复**：一条 **Electron/IPC 脚本骨架**（仓库里 `shot.cjs`、`t7-quit-semantics.cjs` 已证明可行），把「真机窗口 + 合成 composition 事件 + 量 `getBoundingClientRect`」「主进程 IPC + 目录级断言」这两类统一接进可重复执行的脚本。**一次投入，解锁上面五条。**

### 12.3 一条新规矩（来自代码侧本轮踩的坑）

代码侧本轮踩到：**脚本里的转义引号写坏 → 整个脚本静默没执行 → 而 `typecheck / selfcheck` 报"全绿"**。它自己总结得很准：**"那是没改动的绿"**。

> **规矩**：「门槛绿」必须与「确实有改动」同时成立 —— 跑门槛**之前**先看 `git status --short` 与 `git diff --stat` 非空（或明确说明为何断言数不变）。否则"全绿"只是在证明**你什么都没做**。

（这是本项目第三次出现"全绿 ≠ 正确"：A3 的无效修复、`?` 注释损坏、本次的空改动。三次都发生在**门槛覆盖不到的维度**上。）

### 12.4 只有用户能做的三项验收（现在成了关键路径）

这三项已经挂了三轮，**它们不解锁，D-02 / D-07 / D-14 就只能一直记"机制对了但没验收"**：

1. **D-02 多标签崩溃恢复**（最重要）：开 A/B 两标签各改一笔（**都不保存**）→ 等 ≥30 秒 → 切到另一个标签再改一笔 → **任务管理器强杀进程** → 重启 → 看候选里**A 是否还在**；
2. **D-07 组词不折行**：进编辑态 → 中文输入法连打 8+ 音节（`dawadawdwa`）**不回车** → 拼音须保持**一行**（溢出节点框外属已知代价，记录下来）；
3. **D-17 保存中切标签**：两个标签 + 大文档 → 在 A 上 Ctrl+S → **立刻点 B** → 两边路径不得串改，且应看到新的那条 toast。

---

## 13. 第八轮复验（2026-09-21 深夜 · D-18② / D-11 后半）+ 一个已成形的偏差

> **复验基线**：`HEAD 9f4bbd7`（五道门槛实跑全绿，自检 **2872**，待推 **27**，工作树干净）

### 13.1 两条取证 + 一条真问题被断言抓出

| 条 | 结论 |
|---|---|
| 🟡 **D-18②** 目录级回收 | ✅ **断言第一次就红了，抓出真问题**：枚举器只认 `.xmind` → "正文已不在、只剩 `.json`"的那份**永远清不掉**，关窗与"不恢复"两条路径都漏过 → 存档目录留下**永久孤儿 meta**。修法 `isPerDocAutosaveArtifact`（`.xmind` / `.json` 都算产物）+ `listAutosaveDocIds` 按 `Set` 取并集去重 ✓ |
| 🔍 我的额外复核 | ✅ 修法**覆盖三条清理路径**（关窗 `windows.ts`、"不恢复" `recoveryDiscard`、保存后 `autosaveClear` —— 三者都经 `listAutosaveDocIds`）；✅ **`recoveryCheck` 不会因孤儿 `.json` 产生假候选**（它同时要求 `existsSync(autosaveFile)` 才收，孤儿在 `.xmind` 那步就 `continue` 了）—— 这一步是本轮最容易被写错的地方 |
| 🟡 **D-11 后半** | ✅ `beginBackgroundCost`：计时照做但**不写 `costs` 表** → 不再混进 AI 回合的耗时归属行；只在 ≥`SLOW_MS` 时单独记一行 `慢(后台)`（且仍受 `armed` 调试开关约束 ✓）。调用点已换 ✓ **D-11 全条完成** |

门槛：全绿 ✓；断言 **2862 → 2872**（+10）。

### 13.2 ⚠️ 一个已成形的偏差：**每一轮"能纯函数验证的"都做完了，"需要真机/UI 的"一条没动**

按轮次把"实际完成"与"被推迟"对照：

| 轮次 | 完成的 | 推迟的 |
|---|---|---|
| 批 A / 更新链 | D-01、D-09~D-12、D-15、D-16（**全部纯函数可验**） | — |
| D-07/D-08、D-17 | D-17（**类型层可验**）、D-07/D-08（"最小可见修"，**真机未验**） | D-07/D-08 治本、D-14 |
| D-02 / D-19 / D-18 | D-02 数据层、D-19、D-18②③④、D-11（**全部纯函数可验**） | **恢复 UI 逐份**（用户可见）、**D-14 探针**（第 3 轮） |

**这不是谁偷懒，是激励结构**：纯函数可验的一条半小时收工、门槛立刻全绿；需要真机/改 UI 的要么跑不到、要么改动更大。于是"理性的"顺序**系统性**地把**用户看得见的**排到最后 —— 与 §5 的判断、以及"你感觉修得慢"的机制解释完全一致。

**破法（硬规则）**：给批次加一个**硬槽位** —— **每批的第 1 个槽位必须留给「用户已报的 bug」或「待验收项」，不许被容易的内部项插队**。人（用户）只需在每轮开头看一眼"第一条是不是那一条"。

### 13.3 📌 与此相关的商业判断：**0.9.2 其实只差一次真机验收**

0.9.2 的建议门槛是三条，现状：

| 门槛项 | 状态 |
|---|---|
| **D-16**（验收通路：`rt.yml`） | ✅ 已完成（`03343ab`） |
| **D-17**（数据安全：保存串号） | ✅ 已完成（`d64764d`） |
| **D-07 / D-08**（用户可见：组词折行） | 🔶 **机制已就绪**（唯一写入点 + 解除 flex-shrink），**只欠一次真机验收** |

→ **别等 19 条清完再发版**。**你跑一次组词验收（连打 8+ 音节不回车）+ 完成 D4 上传，0.9.2 就可以发**；其余 15 条排 0.9.3。理由：现在收到的用户反馈是 0，等于在替所有人猜优先级。

### 13.4 规则细化（§12 的规矩漏在你身上一次）

本轮代码侧如实交底「§12 是刚落库的，这轮没来得及读」。根因是**报告在开工之后又长了**。
→ 规则补一句：**开工读一次报告最新章节；收尾前再扫一次**（`git log --oneline -3 -- docs/defect-report-*.md`），确认没有新增章节。

---

## 14. 第九轮复验（2026-09-21 深夜 · 验证骨架）+ 发版裁决

> **复验基线**：`HEAD 7875e1a`（五道门槛实跑全绿；自检 **2872 未变** —— 本批按仓库惯例 `.cjs/.ts` 脚本不进 `selfcheck`，属**有意不变**，且已按 §12.3 规则先确认改动非空 ✓）

### 14.1 我亲手跑了一遍骨架：**ALL GREEN，且能在别人机器上复现** ✓

```
& '.\scripts\verify\run-all.ps1'
→ SUMMARY renderer=0 main=0 / ALL GREEN     渲染侧 4/4 PASS，主进程侧 6/6 PASS
```

**这是本项目第一次能由「非代码侧」独立复现的非纯函数证据** —— 从"验证资产"的标准看是合格的（一条命令、有明确结论、有退出码）。

**其中最有价值的一条**：
```
PASS  A3 复刻：只放开 maxWidth → 宽度被 flex-shrink 压回节点内宽   << 实际=120px
PASS  D-07 复刻：flex: 0 0 auto → 宽度真的生效                     << 实际=600px（真窗口 + 产品自己的 CSS）
```
→ **A3「改了但真机无效」从"读码推断"升级为"可机器复现的证据"**，这条假账从此有据可查，不再依赖任何人复述。

**边界（它证明什么 / 不证明什么）** —— README 已写清，我再确认一次：
- ✅ **证明**：CSS × DOM 的约束机制（`flex: 0 0 auto` 真能生效）、主进程目录级行为（枚举 / 清理 / 兜底）、composition 事件管线可用；
- ❌ **不证明**：真机上的真实输入法行为、`use-canvas-layout` 的真实测量链路、标签切换与 IPC 时序。
→ **§12.4 的三项真机验收不能省**（A3 的教训正是"机制对、真机无效"）。

**一处小问题（cherry，非缺陷）**：`run-all.ps1` 打印的 `D-18②` 在我的控制台显示成 `D-18鈶?` —— 说明该 `.ps1` 里的非 ASCII 字符在 **PowerShell 5.1（UTF-8 无 BOM 时按 GBK 解）** 下会乱码。**只影响显示**（两个子脚本退出码 0/0、结论正常）。建议 `.ps1` 存成 **UTF-8 with BOM**、或脚本内只用 ASCII —— 本项目已被编码咬过两次（`?` 注释那次），顺手统一。

### 14.2 📌 发版裁决：**0.9.2 立刻发，别再等**

用户判定「官网挂的还是 bug 巨多的版本，必须现修掉」→ **我同意，且这是当前边际收益最高的动作。**
**理由**：0.9.1 → 0.9.2 修掉的是一整批**用户可感 + 数据安全**的问题 —— 行内代码提交即丢、编辑主题时快捷键全失效、点公式插入 python 代码块、撤销栈满后"一步撤销"失效、写盘期间编辑被误标已保存、**保存期间切标签会把内容写进别的文件**、更新链路收不到新版。这些都是用户**真会撞上**的。

**发版清单（四步；唯一阻塞项是第 1 步）**
1. 🔴 **一次 D-07 真机验收（20 秒）**：编辑态 → 中文输入法连打 8+ 音节**不回车** → 拼音须**保持一行**。**唯一不能省的一步**；若仍折行，就**不要按"已修"发改版说明**。
2. ✅ 版本号 0.9.2 + 更新源指向 OSS 已就绪（`65d028a`）；`release/` 里 0.9.1 五个资产未被覆盖（已核）。
3. ⚠️ **D4 上传**：`npm run mirror:oss` → **`curl -I https://dl.smindapp.cn/rt.yml` 必须 200**（`03343ab` 修的就是它）→ 确认 setup / portable / blockmap / latest.yml 四件齐。
4. ⚠️ 官网版本号与下载链接切到 0.9.2 + 一条短公告。

**会带着出去的已知缺陷（提前知情，别写进"已修"）**

| 缺陷 | 状态 |
|---|---|
| **D-14 清空标题后节点不缩回**（用户已报） | ❌ 未修 → 0.9.3 第一条 |
| D-02 多标签崩溃恢复 | 🔶 数据层已修，**界面仍只提示一份** |
| D-07/D-08 的治本版（框跟着变宽） | ❌ 未做（当前是最小可见修：不折行，但可能溢出框外） |
| D-04 / D-05 / D-06 / D-13① | ❌ AI 侧，未修 |
| overlay 富文本「选中点按钮 / 部分变色」 | ❌ 未做 —— **不得写进发布说明** |

**发版说明口径**：只写"修了什么 + 新增什么"，不写没做的。0.9.2 的定位是「**修掉一批用户可感的 bug**」，不是"完成度里程碑"。

### 14.3 发版清单（以下每一项都是今晚实测过的，不是照抄计划）

**前置状态（已核）**
| 项 | 实况 |
|---|---|
| `package.json` version | **0.9.2** ✓（`65d028a`） |
| `electron-builder.yml` publish | `provider: generic` / `url: https://dl.smindapp.cn/` ✓；targets = `nsis` + `portable` ✓ |
| `release/` 里的产物 | ⚠️ **仍然只有 0.9.1 的五个资产（09-20 10:48）——0.9.2 从未打包**；0.9.2 只有 `release-rt/` 里的 rt.1/rt.2/rt.3 |
| OSS 现状 | `latest.yml` 200 / 0.9.1 setup 200 / 0.9.1 portable 200 / **0.9.1 setup 的 blockmap 200**（→ 老用户走差分不会废 ✓）/ **`rt.yml` 404**（`03343ab` 的修复尚未上传） |
| `release/latest.yml` 基线 | `version: 0.9.1`、`sha512: lNR8+…WUVQ==`、`size: 113429722` —— 与 `release/` 里 setup **实算体积逐字一致** ✓（本地这套就是线上那套） |

**清单（按顺序）**
1. 🔴 **D-07 真机验收**（20 秒）—— **唯一阻塞项**；折行就不要按"已修"发改版说明。
2. 🔴 **先把 0.9.1 的两件备份出 `release/`**（`SMind-0.9.1-x64-setup.exe.blockmap` + `latest.yml`）—— 线上 blockmap 虽已 200，但本地这份一旦被覆盖就只能在 GitHub 资产里再取；成本为零，先做。
3. 🔴 **打包必须带 `--publish never`**：`npm run dist -- --publish never`
   （`package.json` 的 `dist` 脚本里**没有** `--publish`，而 publish 段已指向 OSS → 不带这个开关，electron-builder 会**自己去试上传**，计划 §5 点过这个坑）
4. 打完自检：`release/latest.yml` 的 `version` = **0.9.2**；`SMind-0.9.2-x64-setup.exe`、`…-portable.exe`、`…-setup.exe.blockmap` 三件都在。
5. 上传：`npm run mirror:oss`（需 OSS AK）—— 会**顺带传 `rt.yml`**（`03343ab` 的 `sourceName` 机制）。
6. **校验**：`curl -I https://dl.smindapp.cn/rt.yml` = **200**；`latest.yml` 里 `version: 0.9.2`；两个 exe 与 blockmap 均 200。
7. 官网版本号与下载链接切 0.9.2 + 一条短公告。
8. 删代码后想确认没弄坏东西：`& '.\scripts\verify\run-all.ps1'`（新骨架，一条命令）。

> **自我更正**：我早前提醒过"0.9.1 的 blockmap 也要上传" —— 实测它**已经在 OSS 上（200）**，那条提醒对已发过的版本不成立；真正需要补传的是 **0.9.2 的 blockmap**（`mirror:oss` 会自动带上 ✓）。本地备份那条仍然建议做，理由见第 2 步。

### 14.4 发版之后（别停下）

装 **GoatCounter** + 发 **V2EX「分享创造」**（工作日上午 10–11 点）。现在下载量仍是盲区，W2 那条红线（下载 <100 就换素材）**无从判定**。发版是"把修好的东西送到用户面前"，不是终点。

---

## 15. 第十轮复验（2026-09-21 深夜 · 打包产物 + **D-07 在真实 App 里验通**）+ 发版解禁

> **基线**：代码侧 `338c7a3`（发版说明 + BOM 修正）× 文书侧报告至 `ab49e7b`
> **本轮我做了两件非代码侧的事**：复核打包产物；**用 CDP 驱动真实打包版 App 完成 D-07 验收**。

### 15.1 打包产物复核（我实算，不采信自述）

| 项 | 实况 |
|---|---|
| 0.9.2 四件 | `setup 113,432,212` / `portable 113,192,546` / `setup.blockmap 119,284` / `latest.yml 347` ✓ 齐 |
| `latest.yml` | `version: 0.9.2`、`sha512: j63cB93R…hhw==` —— **与本机实算 SHA512 逐字一致 → MATCH=True** ✓ |
| 0.9.1 三件 | **仍在 `release/`、时间戳仍 09-20 10:48、字节数未变** ✓ 未被覆盖 |
| 产物内更新源 | `release/win-unpacked/resources/app-update.yml` = `provider: generic` / `url: https://dl.smindapp.cn/` / `updaterCacheDirName: smind-updater` ✓ |
| 公告稿口径 | ✅ 只写已修/新增；overlay 只说行内标记写法；**组词那条被放进"已知问题"** —— 与本报告的 §14.2 口径要求一致 |

### 15.2 ✅ D-07 在**真实打包版 App** 里验收通过（非代码侧独立完成）

**方法**：`release/win-unpacked/SMind.exe --remote-debugging-port=9222` → CDP 连入 → 双击中心主题进编辑态 → **先 Ctrl+A / Backspace 清空**（关键）→ `Input.imeSetComposition` 合成**真实 composition 事件** → 量 `.rich-editor__content`。

| 组词文本 | 编辑框宽 | 文本所需宽 | 行数 | 判定 |
|---|---|---|---|---|
| `dawadawdwa`（10 字符，= 判据样例） | 201px | 85px | **1** | ✅ PASS |
| 24 字符压力样例 | 320px（已达上限） | 202px | **1** | ✅ PASS |

同时确认：`editorInlineFlex = "0 0 auto"`、`maxWidth = none`（修复的 DOM 写入真的生效）；**节点框在组词期仍是 124px** → **文字确实短暂超出节点框**。
→ 公告稿里那句「组词期拼音不折行的改动，请在真实输入法下确认效果；**文字可能短暂超出节点框**」**措辞完全准确**，是实测确认的代价，**建议保留**。

**边界（诚实标注）**：这是**合成** composition（`Input.imeSetComposition`），走的是真实 Chromium 的 IME 路径与产品自己的 `compositionupdate` 监听，但**没有真实候选窗与输入法自身的时序**，与"真人敲键盘"仍有最后一毫米。
→ **结论：不阻塞发版**；建议发版后你顺手真人敲一次做最终确认即可。

### 15.3 ⚠️ 我自己的假 FAIL：**验证脚本红了，要先怀疑脚本**

第一次在真实 App 里跑，脚本报的是 **FAIL（rows=2）**，但那是**我的测法错了**：
1. 脚本直接双击**已有标题**的节点 → 组词文本被接在原标题前面（实测 `text = "dawadawdwa中心主题"`，总宽当然超）；
2. 我那个"A3 旧做法对照"也不成立 —— 实测把 `flex` 复位后，flex-shrink **在真实布局里根本没起收缩作用**（编辑框 201px **大于**节点 124px），所以"旧做法 vs 新做法"在真实 App 里不是靠 flex 区分的。

**立规矩（与 §12.3 是一对）**：
> **门槛绿了，先确认"确实有改动"；验证脚本红了，先怀疑"脚本确实测对了"。**
> 工具本身也要被验证 —— 一次假 FAIL 会拦下一个本该发的版本，一次假 PASS 会放出一个坏的版本，两者代价相同。

### 15.4 📌 发版裁决更新：**D-07 不再是阻塞项，0.9.2 可以发**

原 §14.3 第 1 步（D-07 真机验收）**已由非代码侧完成** → 剩下的就是纯操作：
1. `npm run mirror:oss` 上传四件（需你的 AK）；
2. 校验 `curl -I https://dl.smindapp.cn/rt.yml` = **200**、`latest.yml` 的 `version = 0.9.2`；
3. 官网版本号与下载链接切 0.9.2 + 贴公告（短稿已备好）。

**发版说明的一处建议**：组词那条可以从"已知问题"移到"已修"，但**请保留"组词期文字可能短暂超出节点框"**这句 —— 那是实测确认的代价，不是猜测。

### 15.5 本条产出的资产（建议升格进仓库）

`.tmp-check/cdp-d07.cjs`（**gitignored，未提交**）：目前**唯一能驱动"真实打包版 App"**的验证脚本，比 `scripts/verify/renderer-geometry.cjs`（复刻 DOM）强一个量级。
**它直接就能扩出 D-14 的探针**：真 App 里清空标题 → 量 `.topic` 的 inline width / minWidth / 编辑器宽度 → 当场定死甲/乙/丙。建议由代码侧升格到 `scripts/verify/` 并纳入 `run-all.ps1`。

---

## 16. 第十一轮复验（2026-09-21 深夜）· 0.9.2 上线实况 + 新登记 D-20

### 16.1 上传结果（文书侧代传，全部实测）

| 对象 | HTTP | Content-Length | 与本地对照 |
|---|---|---|---|
| `latest.yml` | 200 | 347 | **与本地逐字一致** ✓（`version: 0.9.2`） |
| `rt.yml` | 200 | 347 | `version: 0.9.2` ✓ —— **`03343ab` 的修复首次被真实验证** |
| `SMind-0.9.2-x64-setup.exe` | 200 | 113,432,212 | 逐字一致 ✓ |
| `SMind-0.9.2-x64-portable.exe` | 200 | 113,192,546 | 逐字一致 ✓ |
| `SMind-0.9.2-x64-setup.exe.blockmap` | 200 | 119,284 | 逐字一致 ✓ |
| 0.9.1 三件（setup / portable / blockmap） | **全 200** | 未被动 ✓ | 差分下载与 GitHub 回退链不受影响 |

### 16.2 🔴 新登记 D-20 · 上传脚本按**体积**判断"已传过"，导致 `latest.yml` **每次发版都被静默跳过**

**现象（本次真实发生）**：`npm run mirror:oss` 跑完 → 0.9.2 的三个产物与 `rt.yml` 全部 200，**唯独线上 `latest.yml` 仍是 0.9.1**。

**根因**（`scripts/upload-oss.mjs` 的"已存在且**大小一致**就跳过"）
```
本地 release/latest.yml（0.9.2）= 347 字节
线上 latest.yml（0.9.1）        = 347 字节      ← 完全相同 → 判定"已传过" → 跳过
```
`latest.yml` 的结构固定（版本号恒 3 字符、sha512 恒 88 字符 base64），**两版体积天然相等**。

**后果（三条都要命）**
1. **普通用户永远收不到 0.9.2**：客户端读 `latest.yml` → 仍 0.9.1 → 显示「已是最新版」；
2. **只验 rt.3 会误判全绿**：`channel: rt` 的测试机读 `rt.yml`（= 0.9.2）**收得到** → "rt.3 收到更新 ✓" **完全不能代表真实用户路径**。这是"验收路径 ≠ 用户路径"的典型陷阱；
3. **每次发版都会重现**（结构固定 → 体积相等），不是一次性事故。

**本次处置（已完成）**：一次性 `force-PUT` 覆盖（复用同一套 OSS V1 签名、跳过 HEAD 比对）→ 复验 `version: 0.9.2` 且与本地**逐字一致** ✓

**正式修法（给代码侧，二选一）**
- **首选：清单文件永不跳过** —— `latest.yml` / `rt.yml` 只有 347 字节，跳过它们**零收益**；"跳过已传"只对两个 exe（各 108 MB）有意义；
- 或把比对从**体积**换成**内容**（ETag / MD5）：体积相同但内容不同时照传。

**验收判据**：断言「跳过判据对 `latest.yml` / `rt.yml` 恒为 false」；**发版后必须校验"正在服务的清单文件里的 version"等于 `package.json` 的 version** —— 而不是"我上传成功了"。

> **本节立的规矩**：**"上传成功"不等于"用户在拿到新版本"。** 发布验收的最后一跳必须是**读线上正在服务的那个清单**，并核对它指向的版本与产物。

---

## 17. 0.9.2 发布完成（2026-09-21 深夜）· 核对表 + 下次发版检查清单

### 17.1 发布完成核对表（全部线上实测，非自述）

| # | 项 | 证据 |
|---|---|---|
| 1 | 版本号 + 打包 | `package.json` = 0.9.2；`release/` 四件齐，setup 实算 sha512 与 `latest.yml` 记录**逐字一致（MATCH=True）** |
| 2 | 产品内更新源 | `release/win-unpacked/resources/app-update.yml` = `provider: generic` / `url: https://dl.smindapp.cn/` ✓ |
| 3 | OSS 主源 | `SMind-0.9.2-x64-setup.exe` / `-portable.exe` / `.blockmap` / `latest.yml` / `rt.yml` **全部 200**，体积与本地逐字一致 |
| 4 | **老用户更新通道** | `latest.yml` → `version: 0.9.2` ✓（**这一条曾被 D-20 静默跳过，已强制修复**） |
| 5 | 预发布通道 | `rt.yml` → `version: 0.9.2` ✓（`03343ab` 的修复**首次被真实验证**） |
| 6 | 差分下载 | 0.9.1 的 `setup.blockmap` 仍在线上 200 ✓ → 老用户走差分，不会强推 108 MB 全量 |
| 7 | GitHub release | `v0.9.2`，**4 个资产齐全、体积与本地逐字一致**，非 draft / 非 prerelease ✓ |
| 8 | 官网三页 | 首页 `v0.9.2`；`/download/setup/` 与 `/download/portable/` 的**版本文案 + MIRROR + FALLBACK** 全部切到 0.9.2 ✓（推送 `4d7f050`，GitHub Pages 已生效） |
| 9 | 源码与 tag 一致 | 37 条提交已推送（远端 `main` = 本地 HEAD），tag 指向含全部修复的提交 ✓ |

### 17.2 ⚠️ 下次发版必看（今晚踩到的坑，逐条固化）

1. 🔴 **`upload-oss.mjs` 的"按体积跳过"会漏传 `latest.yml`（D-20）** —— 体积与上一版天然相等 → 被判定"已传过" → **线上清单仍是旧版本，普通用户收不到新版，而 rt 通道却收得到（假绿）**。
   → **修好之前，每次发版都要手工核对线上 `latest.yml` 的 `version`**，必要时强制覆盖。
   （首选修法：清单文件永不跳过；或把比对换成 ETag/MD5。）
2. 🔴 **打包必须带 `--publish never`**（`dist` 脚本里没有，而 publish 已指向 OSS → 不带会自己去试上传）。
3. 🔴 **`release/` 里上一版的资产先备份**（本地那份被覆盖后只能回 GitHub 取）。
4. 🔴 **先 `git push`，再建 GitHub release**（否则 tag 指向的提交不含本次修复，用户下到的源码是旧的）。
5. 🟠 **两个下载页都要切** —— `/download/setup/` **和** `/download/portable/`；免安装版**不能自动更新**（`main/update/index.ts:7-9`：portable 每次启动解压到临时目录），它的**唯一升级路径就是那个页面**，漏切 = 免安装用户永远更新不了。
6. 🟠 **GitHub release 的 tag 与文件名必须逐字精确**（`v0.9.2` / `SMind-0.9.2-x64-setup.exe`）—— 官网 `FALLBACK` 是拼死的字符串，差一个字符就是 404。
7. 🟡 **链路间歇**：本机到 github.com 时通时断（`git push` 失败后重试即可；`curl` 得到的 `000` 是超时，**不是资源不存在**）。
8. 🟡 **上传后必须校验"正在服务的清单文件里的版本"**，而不是"我上传成功了"——这是本次唯一漏掉的一跳。

### 17.3 遗留（0.9.3）

**用户已报**：**D-14 清空标题不缩回**（0.9.3 头条，先跑探针定甲/乙/丙）。
**已修未收口**：**D-02 恢复 UI 逐份确认**已实现（`217a298`），待真机验收（两标签各改一笔 → 强杀 → 重启看两份提示）。
**未开始**：D-04（浮动主题失明）、D-05（压缩窗口漏 toolNotes）、D-06（读工具判重键）、D-13①（内容变少就确认）。
**验证资产**：`.tmp-check/cdp-d07.cjs`（唯一驱动**真实打包版 App**的脚本，可直接扩 D-14 探针）待升格进 `scripts/verify/`。

### 17.4 发版之后（商业侧，明天做）

**装 GoatCounter + 发 V2EX「分享创造」**（工作日上午 10–11 点；短稿见 `docs/release-0.9.2-announcement.md`）。
现在下载量仍是**盲区**，W2 的红线（下载 <100 就换素材）无从判定 —— 发版只是把东西送到用户面前，**看不见数字就等于没发**。

---

## 附：本报告的证据来源（全部为当日实测/实读）

- 五道门槛：2026-09-21 实跑，全绿（`selfcheck` 2791 项）
- 线上：`smindapp.cn` 首页/下载页、`dl.smindapp.cn/latest.yml`、setup HEAD，均为当日实测
- 代码：逐文件读 + 目录级 `detachedChildren` 存在性扫描（`src/shared` 命中 14 文件 / `shared/agent/**` 零命中）
- 用户复现：中文输入法组词期折行 4 张截图（2026-09-21）
- **第二轮复验（§7）**：`git show 515aac2 / 4c001f5 / da0f478 / 65d028a / ba91793 / 3daedfe / 6c3f078 / cbc1ead` 逐提交看改动面；
  `scripts/upload-oss.mjs` 与 `scripts/upload-mirror.mjs` 全文实读；`nodePanel/overlay-branch.tsx` 全文实读；
  线上 `dl.smindapp.cn/{latest.yml,rt.yml}` HEAD、`release/` 资产时间戳与 SHA512 实算比对；五道门槛实跑（`selfcheck` 2838 项）
