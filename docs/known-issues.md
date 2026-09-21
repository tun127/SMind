# 待修问题清单（Known Issues）

> 生成时间：2026-09-14
> 最后处理：**2026-09-15**（见下方「处理结果」）；**2026-09-21 追加**一组「待处理」审查发现（F1–F5，见文末）
> 对应版本：0.6.0 起
> 排查方式：全仓只读审查（安全 / 健壮性 / 性能 / 资源泄漏 / 类型卫生 / 功能缺口），关键结论均已人工复核

每条含四项：**现象** → **证据（文件:行号）** → **建议改法** → **怎么验收**。
优先级：P0 会丢用户数据；P1 安全纵深；P2 性能；P3 工程规范；P4 分发；P5 功能缺口。

---

## 处理结果（2026-09-18 · 本轮代码审计）

来源：`docs/shared-audit.md`（对 `src/shared/**` 83 文件 / 18k 行的三遍独立审计）+ 用户实测报障。
分 8 批落地，每批各自过**五道门槛**（typecheck / lint / format:check / selfcheck / verify）后单独提交，
自检断言 2522 → 2625 项。下表用**符号名**而不是行号（行号一改就假，本轮已因此踩过）。

| 项 | 结果 | 落地位置 |
|---|---|---|
| 悬浮/浮动主题删不掉、移不动（`store` 谎报成功） | **已修**：子节点遍历统一到 `allChildrenOf` | `shared/model/tree.ts`、`store/editor.ts`、`agent/address.ts`、`layout/core.ts` |
| 数字字符引用越界抛 `RangeError` | **已修**：抽成 `entities.ts` 带上下界守卫；三处名字表**有意保留差异**（XML/纯文本/Markdown 口径不同） | `shared/entities.ts` |
| Markdown 开头 `---` 吞掉全文、未闭合围栏丢整块 | **已修**：front-matter 需有闭合行；EOF 冲刷未闭合围栏 | `shared/import/markdown.ts` |
| 大小写不敏感匹配下标错位、替换删错字 | **已修**：改用字面量正则；`normalizeQuery` 统一口径 | `shared/search/index.ts` |
| 导出标题未转义（`3*4` 被读成斜体） | **已修**：`escapeMarkdownText` | `shared/markdown-escape.ts`、`shared/outline/index.ts` |
| 合并提示词缺规格与两条质量判据 | **已修**：`documentSpecLines(depth, 4)` | `shared/ai/prompts.ts` |
| XML 闭标签不校验名字（错位嵌套挂错父级） | **已修**：对名字弹栈，找不到当野闭标签忽略 | `shared/xmind/xml.ts` |
| 压缩炸弹（解压后才判上限） | **已修**：解压前读**声明的**未压缩大小直接跳过 | `main/document.ts` |
| SSE 末尾不带换行的 `data:` 行丢正文 | **已修**：`createSseLineSplitter` 补 `flush()`，主进程收尾接上 | `shared/ai/stream.ts`、`main/index.ts` |
| CSS 字符串不认转义（`"a\"b"` 腰斩串色） | **已修**：带转义识别的扫描循环 | `shared/code/lexer.ts` |
| 许可 payload 只判"非空" | **已修**：`issuedAt` 必须是真日期（`2026-02-31` 这类"JS 会帮忙滚"的也要拒），holder/order 限长并拒控制字符 | `shared/license.ts` |
| 「昨天」按流逝时长算 | **已修**：改按**日历日差**（跨午夜即昨天） | `shared/history/index.ts` |
| 吸附半径边界口径不一 | **已修**：`closestNodeWithin` 起点 `maxDistance + 1`（"**超过**才算空白"与其文档、与 `nearestSiblingGap` 的 `<=` 统一；保留"同距先到先得"） | `shared/model/drop.ts` |
| 非法落点原因与路径不匹配 | **已修**：多选约束优先说出；非 child 落点给出具体规则 | `shared/model/drop.ts` |
| `stackDirection` 在两节点**中心重合**时"顺手造"出一个顺序 | **已写成显式契约**（水平、向后）并加断言钉住：退化情形没有客观正确答案，与其让实现细节随机决定，不如定下来；将来想换规则会先撞到断言 | `shared/model/drop.ts` |

### 经**核对不成立**的审计建议（记录在此，避免以后重复立案）

| 建议 | 为什么不改 |
|---|---|
| "拖到中心主题前/后应报错" | 行为**有意**：被自检断言钉住（"目标是根主题 → 只能成为它的子主题"），改成拒绝反而像卡死 |
| "`stop()` 应清 `requestIdRef`" | 清掉会让主进程随后发来的终止 `aborted` 事件被 `handleEvent` 过滤掉——「已停止」标记与回合收尾一起消失 |
| "`runsToHtml` 是死代码，删掉" | **不是死代码**：`scripts/selfcheck.ts` 的行内语法断言在用它（审计只 grep 了 `src/**`，漏了 `scripts/**`） |
| "两个节点计数器口径不一致，应合并" | **有意不同**：`countTopicTree` 只走 `children`（给模型报分支规模，与实体层级一致），`countTopics` 走 `walk`（含自由摆放主题，界面用）；`ai/context.ts` 的注释已写明"别把两者合并" |

### 明确不改（附理由）

| 项 | 理由 |
|---|---|
| `stackDirection` 的"平局造序" | 只有两个节点中心**完全重合**（退化情形）时才出现；改成别的任意选择没有依据 |
| `font` 串两处实现 | 签名不同（一处收 style 对象、一处收 4 个标量），合并的改动面大于收益 |
| 大纲面板列浮动主题 | **产品口径问题**：`shared/layout` 除分支配色外不遍历 `detachedChildren`，没有画布行为可对齐；注释已按实际行为写清，想改只需一处（见 `outline/index.ts` 的说明） |

---

## 渲染层回归审计（2026-09-19 · 解耦收口后的独立复查）

来源：只读子代理对 `src/renderer/src/**` 的六面审计（钩子依赖 / effect 清理与顺序 / state 生命周期 /
ref-vs-state / 回调身份与 `React.memo` 浅比较面 / 事件绑定 / zustand 切片组合），
每条都回到**拆分前的版本**（`git show <rev>^:<path>`）逐段比对；主 agent 对每条**亲自读代码核实**后才处置。

| 发现 | 判定 | 处置 |
|---|---|---|
| `NodePanel.tsx` 入口在 `{body}` 外面又包了一层 `.side-panel` + `PanelHeader`，而两条分支组件**各自也带一份**（它们的 JSX 是从原实现的三条 early-return 整块搬来的，每块本来就自带外壳）→ 选中主题 / 画布元素时出现**嵌套面板与两个关闭按钮** | **真回归**（A4 引入）。当时的行多重集守卫只比对"旧文件有没有丢行"，**看不见多出来的行** | **已修**：恢复「每条分支渲染自己的外壳」，空态分支补回外壳；DOM 与拆分前一致。**待人眼确认**（见 `handover.md` §五） |
| `NodePanel` 的草稿同步 effect 只依赖 `[id]`：撤销后选中的还是同一节点 → effect 不重跑 → 草稿仍是撤销前的文本，再失焦就把撤销掉的内容**盖回去** | 真缺陷，**早于解耦**（不是拆分引入的）。**根因已钉死并亲手复核**：`store/slices/history.ts:184` 的 undo 是 `selection: liveSelection(root, entry.selectionBefore)`——**撤销刻意保持同一个节点被选中**，所以 `id` 按构造就不变，而这个 effect 的依赖里没有 `topic`（`NodePanel.tsx:29` 的 memo 依赖 `[workbook, id]`，实际内容已经换了） | **已修**：依赖补上该节点**已提交**的字段（`notes` / `href` / `formula` / `code.text` / `code.language`）；草稿只在失焦时写回 store，所以打字过程中不会被覆盖。**两个可复现触发**：①备注 —— 选中 → 输入 → 点别处（提交）→ `Ctrl+Z` → 点进备注再点走 → 撤销掉的内容回来了（还多一条历史）；②代码块 —— 同一条路径，`topic-branch.tsx:116` 的 `commitCode` 拿 `topic.code?.text` 与草稿比对，于是画布已回退、输入框还是新代码，一点走又写回去。`href` / `formula` 同形 |
| `store/slices/document.ts` 顶部注释称「仍在同一次 `set` 里写 `aiTurn: null`」，实际调用 `resetHistory()`（两次 `set`） | 注释与代码不符；**无用户可见副作用**（换文档本就是"整屏换内容"） | **已订正注释**并如实登记两轮通知的差异 |
| `app/use-keyboard-shortcuts.ts` 顶部注释称「依赖数组仍是 `[showToast]`」，实际是 `[showToast, setSidePanel]`（:208） | 注释与代码不符；`setSidePanel` 是 `useState` setter（身份恒定）→ **重跑时机没变**，与上一条同类 | **已订正注释**（写明两个依赖各自为什么是稳定引用） |
| `TabBar.tsx` 拖拽重排：`onDragOver` 里 `moveTab(from, index)` 之后把 `dragIdRef` 指向**被悬停的**标签 | **可证缺陷、早于解耦**（该文件没被本轮重构动过；`git log -S` 追到特性提交 `6546b7e`）。**证明**（本轮亲手复核）：`tab` 是 `tabs.map((tab, index) => …)` 的绑定 → `tab === tabs[index]`；而能进入该分支的前提是 `from !== index`，所以那行赋值**必然**把"被拖的标签"替换成另一个（被悬停的）标签，此后每次 `dragover` 都在移动**另一个**标签 | **已修**：删掉那行赋值、让 `dragIdRef` 始终指向 `onDragStart` 记下的源标签（与注释想表达的"跟手"一致），并写清为什么不能覆盖它。**待运行确认**：多标签来回拖动应跟手、不跳位 |
| 其余（A8 九批 / A3 `topic/**` / A4 `nodePanel/**` / A5 Toolbar / A6 `turn-runtime` / A7 App hooks / B1 十一个切片 / E1 常量收敛） | **未见缺陷** | 逐条对照拆分前版本；切片状态键集合经核对互不重叠 |

**"核查干净"的具体口径**（审计记录，供后来者判断这份结论的覆盖面）：

- **A8 Canvas（9 批，2951 → 385）**：每个搬走的块与 `9acca77^:Canvas.tsx` **逐字节、按序**比对一致；
  effect 注册顺序逐条保留（闪一下 cleanup → 字体就绪 → 布局 `mark` → ResizeObserver → `viewportActions`
  注册 → 编辑时 ensureVisible → 跟随一对 → 折叠 `useLayoutEffect` → 文档居中 → 滚轮 → 拖拽层 transform）；
  `geometry.ts` 显式入参化后每个阈值/分支（14 / 6 / 260 / 0.22 / 0.5 / 240 / 90 / \>60 与
  `{axis:'x',forward:true}` 兜底）都还在；依赖数组逐字未变或只补了恒定身份的 `RefObject`；
  10 个节点回调仍是 `useCallback` + ref → `TopicNode` 的浅比较面没变。两条"疑似泄漏"（窗口 pointer 监听、
  跟随循环里的 `nodePointerHeldRef` 复查）经比对是**早于解耦**就存在的写法，已排除。
- **A3 / A4 / A5**：`topic/**` 与 `nodePanel/**` 内**没有任何 useState/useEffect/useRef**（草稿仍在入口层，
  与原实现一致）；正反向行多重集都干净；`OVERLAY_TITLE_DEFAULTS[kind]` 与旧内联三元逐值相等；
  Toolbar 的处理器接线 1:1（只有 `root`→`rootId` 这类改名）。
- **A6 chat**：订阅 effect 依赖 `[handleEvent]`、`handleEvent` 依赖 `[update, dumpDiag]` 且两者都是
  `useCallback([], …)` → cleanup 里的 `stopRef.current()` / `commitTurnRef.current()` **不可能在回合中途触发**；
  `resolvePending` 那条裸 disable 无害（只碰 ref、稳定 setter 与 `useEditor.getState()`）；35 个展示组件的 props 1:1。
- **A7 App**：effect 顺序保留；`onCloseRequest` 只注册一次；自动保存/恢复/关窗正文逐字未改；
  三处 disable（`App.tsx` / `HistoryDialog.tsx` / `ThemePanel.tsx`）的理由**属实**（一次性信号 / 异步读盘）。
- **B1 store**：11 个切片的**顶层状态键互不重叠**（不存在组合覆盖）；除上面第 3 条外，每个切片正文与
  `1db2999:editor.ts` 逐行相同；`editor-pure.ts` / `editor-ops.ts` 的抽取逐调用点语义等价。
- **E1**：所有收敛后的数值逐字节相等（概要/边界/关系线标题 13/12/12 px；`LABEL_*` 11/18/7/4/170；
  `metrics.ts` 的常量由 `OVERLAY_TITLE_DEFAULTS` 派生）。

---

## 主进程回归网 + 两类契约守卫（2026-09-19 补，2694 → **2753** 项断言）

**背景**：`selfcheck` 长期只覆盖主进程的 `atomic-write.ts` 一个文件（C1 把 `main/index.ts` 拆成
14 个 IPC 域之后，这块全靠 `npm run build` + 手工冒烟）。这一轮按「**把纯判定从 Electron 里抽出来**」
的姿势补网，五笔提交：

| 提交 | 内容 |
|---|---|
| `fb4adbd` | `main/doc-resources.ts`（按 docId 隔离资源 + `pruneForSave` 三条语义）与 `main/document.ts`（拖文档抽取 + 防 zip 炸弹）纳入自检（+22 条） |
| `7ceec3f` | **IPC 契约静态断言**（见下）+ 新增 `main/file-args.ts`（`firstPathOf` / `ensureXmindExt`，从 `files.ts` 抽出，`files.ts` 原样再导出 → 调用点零改动）（+13 条） |
| `88da8b6` | 新增 `main/license/state.ts`（`normalizeLicenseState`：坏 JSON 逐字段收敛）+ `shared/update-policy.ts` 增加 `releaseNotesOf`（剥 HTML / 分段拼接 / 超 800 字截断）（+18 条） |
| `1128477` | **菜单命令契约静态断言**（见下）（+3 条） |
| `3298a2c` | 最后四块纯判定：`main/resource-table.ts`（URL→路径、按 key 查表，含**穿越式 key 查不到**）、`main/quit-flow.ts`（退出前该问哪些窗口）、`main/license/verify.ts`（`verifyLicenseKeyWith(raw, pem)`，自检用**自生成 Ed25519 密钥对**跑正反两条路）、`main/window-match.ts`（多文档窗口归属 / 界面已亡的窗口不算）（+25 条） |

**两类契约守卫**（过去只有文档口径，没有任何门）：

* **IPC**：通道常量 **70** 条 / `ipcMain` 注册处数 **66** 条（= 70 − 4 条主→渲染）/ 无重复注册 /
  每条「渲染→主」通道都有 handler / 四条主→渲染通道不被 handler 注册 / `preload` 覆盖全部通道。
  漏一条的症状是"渲染层 `invoke` 永远等不到回执"，而五道门槛照样全绿。
* **菜单命令**：`main/menu.ts` 发的每条命令都必须在 `use-menu-commands.ts` 有处理器（双向集合相等）。
  漏一条的症状是"菜单项点下去毫无反应"。**并带防空过守卫**：断言扫描至少抓到 20 条命令——
  静态扫描类断言最容易"正则失效 → 两侧空集合 → 假绿"。

### 为什么剩下的这些项**刻意不建网**（2026-09-19 拍板）

**判据（以后判断"要不要为某条路径加网"，三条同时满足才值得投测试）**：
**静默失败 ＋ 会伤数据或收入 ＋ 能纯函数化**。

按这条过一遍剩下的六项——要么**失败看得见**，要么**危险的那半已经抽出来测完了**，要么**根本不是静默的**：

| 项 | 能自动化吗 | 值得吗 | 理由 |
|---|---|---|---|
| `menu.ts` 结构 | 需 Menu API | ❌ | 失败可见（菜单点了没反应），而这个真风险已被**菜单命令守卫**覆盖（每条命令必须有渲染层处理器，双向集合相等）；再写一层就是"变更检测器"，改菜单就得改测试 |
| `lifecycle.ts`（单实例锁 / 心跳 / 装配顺序） | 需 Electron mock | ❌ | 失败每次都看得见（起不来 / 两个实例）；mock 重现不了"装配顺序错"这类真问题 |
| `protocol.handle` 注册本身 | 需 protocol | ❌ 已够 | 危险的那半已经抽出来测了：`main/resource-table.ts`（URL→路径→查表，含穿越式 key 查不到）；剩下是几行注册 |
| `ipc/*` 入参校验 | 部分可 | ❌ 已够 | 该校验的都校验了（写盘路径全部来自对话框），个别域不校验是因为不需要 |
| `license/index.ts` 状态落盘 + Pro 缓存 | 部分可 | ❌ 已够 | 原子写已测、坏 JSON 收敛已抽 `license/state.ts` 测、验签已抽 `license/verify.ts`（自生成密钥真签真验）、缓存失效已核 |
| `update/*` × electron-updater | 需 mock updater | ❌ | 判定逻辑已抽 `shared/update-policy.ts` 并测（portable 守卫 / 6 小时复查 / 说明清洗）；剩下只能在 0.9.1 首跑里验 |

**另一条更硬的理由**：要测这六项，必须给主进程引入 **Electron mock**，而本仓库至今**刻意零 mock**——
唯一例外是 `fakeMeasure`，那是给"自检没有 DOM"的**测量依赖**做的纯函数替身（测量本来就是
`layoutSheet(root, measure, …)` 的注入参数），属于"判断与环境分开"的产物，**不是环境模拟层**。
引入 mock 层会带来更糟的后果：**"测试绿"与"应用能用"之间的关联变弱**，同时多出一层要跟着
Electron API 变化维护的假实现。

**真正值得建网的是"静默失败且会伤数据"的那类**——SSE 丢末行、实体解码越界抛异常、IPC 通道漏注册、
快照归属、原子写……这些都已经建好了，也正是自检从 2522 涨到 2753 的主要来源。

---

## E1 剩项的个人复核结论（2026-09-19 · E1 收口批次）

来源：`shared-audit.md` §5 的第 (2)(3)(4)(5)(10)(12)(15) 组。判据仍是**抽原语、调用点各自保留策略**，
**每一行都是本次亲自 grep/读代码核实的，不是照抄审计**（审计的行号已多处漂移，且有两处结论需要修正）。

> **后续补记（2026-09-19，`ddf08ab`）——(1) 组的尾巴也收口了**：`refactor-audit.md` §七 的「唯一遗留」
> 说 XML 实体解码还剩 3 份。实测那 3 份里**数值引用的解码早已统一**（都走 `shared/entities.ts`），
> 真正重复的是「扫描 + 数字优先 + 解不出保留原文」这段分派。本轮按同一条判据收进
> `shared/entities.ts` 的 `decodeEntityReferences` / `decodeEntityBody`；
> 三处的**名字表与查表口径仍各自保留**（`&nbsp;` 在 XML 读取里是 U+00A0、在「XML→纯文本」与
> Markdown 里是普通空格；XML 读取不折叠大小写、另两处折叠）——这些差异是有意的，已用 6 条断言钉住，
> 另加 3 条原语断言与 3 条"共同底线"断言（越界码点 / 合成十六进制 / NUL 引用一律原样保留）。
> 自检 **2660 → 2672**。E1 至此**再无未完项**。

**本轮收掉的 3 组（各一个提交，五道门槛逐条退出码全绿）：**

| 组 | 提交 | 原语 | 说明 |
|---|---|---|---|
| (5) 概览/边界标题默认样式 | `4d21d08` | `model/overlay-style.ts` 的 `OVERLAY_TITLE_DEFAULTS` | 10 个写数字的点（布局 3 常量 + 画布 2 + 导出 3 + 面板 1 + 关系线 1）收敛成一处；`metrics.ts` 的 `*_FONT_SIZE` **保留名字、改为派生**，取值逐字对齐、外观零变化 |
| (3) `extensionOf` ×2 | `5a6830b` | `model/resources.ts` 的 `extensionOf` | 实测确实只有两份（`document/index.ts` 私有 + `resources.ts` 导出）；`license.ts` 的 `key.split('.')` 是密钥分段、不是扩展名。25 输入实测等价，两处 `??` 兜底均不可达 |
| (12) 资源目录前缀 ×3 | `022b0bd` | `model/resources.ts` 的 `RESOURCES_DIR` / `LEGACY_ATTACHMENTS_DIR` | 审计归为"三份同值"**需修正**：真同值只有 2 份 `'resources/'`，第三处 `xmind/parse.ts` 是 `'attachments/'`（旧版包前缀，另一个字符串）。一并收进同一模块 |

**本轮核实后确认"不合并"的组（附具体证据）：**

| 组 | 实测位置 | 为什么不合并（证据） |
|---|---|---|
| (2) `normalizeDocPath` vs `documentKeyOf` | `shared/window.ts:12`、`shared/snapshot/index.ts:71` | **同族但口径确实不同（实跑复核）**：斜杠方向相反（前者统一成 `/`、后者统一成 `\`）、后者多 `file:` 前缀；**归一强度也不同**——同一份文件的 `C:/A//B.XMIND/` 与 `c:\a\\b.xmind`，`normalizeDocPath` 判为同键（折叠重复斜杠 + 去尾斜杠 + 小写），`documentKeyOf` **判为不同键**（不折叠、不去尾斜杠）；空格与空串口径也不同（前者不 trim、后者 trim 且空返回 `null`）。另外 `documentKeyOf` 的返回值是**持久化面**（写进快照索引的 `docKey` 字段，`snapshot/index.ts:81` 读取时还要 trim 校验）。合并等于改一处持久化键 → 不改 |
| (4) `bracePath` ×2 | `layout/core/connect.ts:499`、`layout/overlays/shapes.ts:20` | **同名不同义**：前者 `(x, yTop, yBottom, tipX)` 4 参、只竖着、给括号图结构；后者 `(axis, spanStart, spanEnd, base, spine, nib)` 6 参、有 spine/nib 两段几何、给概要括号。圆角也不同（`clamp(2,12,span/4)` vs `clamp(2,14,span/4)`）。**无任何文件同时 import 两者**（`stack.ts` 只 import `core` 的、`build.ts` 只 import `shapes` 的）→ 合并必须加 axis 参数并统一圆角，属行为改动 |
| (15) 两种节点计数 | `ai/context.ts:20` `countTopicTree`、`model/tree.ts:381` `countTopics` | **口径有意不同**：`countTopics` 走 `walk`（`tree.ts:28` 递归 `detachedChildren`，含自由摆放主题，另有 `includeRoot` 开关）；`countTopicTree` 只递归 `children`。调用方也是两组：`StatusBar.tsx:35` / `use-canvas-layout.ts:97` 用前者，`ai/context.ts:50` / `plan-write.ts:141,676` / `use-chat-loop.ts:693` 用后者。`context.ts:12-19` 的注释**明确写着"别把两者合并"** → 不改 |
| (10) `activeSheet` 族 | `tree.ts:422` `activeSheet`、`outline/index.ts:232` `activeSheetOf`、`naming.ts:55-58`（内联第三次） | **审计漏了一处**：同一"找当前画布"的表达式实测有 **3** 份（不是 2 份）。三者**空工作簿契约不同**：`tree.activeSheet` 用 `!` 断言（渲染热路径不许抛，注释已写明）、`activeSheetOf` 返回 `undefined` 且调用方抛"当前没有可导出的画布"、`defaultDocumentName` 还要容忍 `workbook === undefined`。§八 已写"建议不做" → 只登记 |
| (10) 字节数格式化 | `snapshot/index.ts:223` `formatBytes` vs `nodePanel/attachment-section.tsx:15` `formatSize`（审计原引 `NodePanel.tsx:44-49`，已搬走） | **可合并但会改文案**：①空态 `'0 B'` vs `''`；②KB 口径 `(size/1024).toFixed(1)` vs `Math.round(size/1024)`（`1536` → `1.5 KB` vs `2 KB`）；③B 口径 `Math.round(size)` vs 原值。合并必然改其中一处的界面文字 → 属行为改动，留用户拍板 |
| (10) 颜色校验 | `theme/index.ts:139` `HEX_RE` vs `model/coerce.ts:19` `COLOR_PATTERN` | **宽严相反、用途不同**：前者只认 `#rgb`/`#rrggbb`（校验**导入的主题 JSON**），后者是宽松白名单 `[a-zA-Z0-9#(),.%\s-]{1,64}`（校验**节点富文本样式**，同时兼作导出 SVG/PDF 的转义防线，会被写进属性）。合并任一方都会砍掉另一方现在合法接受的输入 → 不改 |
| (10) 文件名清理 | `model/naming.ts:41` `sanitizeFileName` vs `model/resources.ts:66` `safeResourceName` | **口径不同**：前者面向"用户可见的默认文件名"（60 字上限、折叠空白、去尾部点/空格、Windows 保留设备名加 `_`、清空返回 `''`）；后者面向"包内资源文件名"（先取基名、去**开头**的点、80 字上限、**空则兜底 `'file'`**）。§八 已写"建议不做" → 不改 |
| (10) 默认对齐 `'center'` | `shared/ipc.ts:68` `DEFAULT_APP_SETTINGS.defaultAlign` vs `renderer/render/defaults.ts:10` | 两处都写同一个值：一个是**设置项的落盘默认值**，一个是渲染层模块级可变默认值（启动早期、设置读回来之前的初值）。**可合并（改 1 行、零行为变化）且不属 §八 的"建议不做"三项**，但属 (10) 混合组、本批按"只核实"处理 → 建议另开一个小提交 |
| (10) basename 取法 | `history/index.ts:72,104`、`naming.ts:80` `fileNameOf`、`store/tabs.ts:124`、`model/resources.ts:93`（`extensionOf` 内的同一表达式） | **同族、但空态与尾分隔符口径不同**：`history` 用 `?? path`（**死代码**，`pop()` 永不 undefined）、`resources` 用 `?? ''`、`fileNameOf` 返回 `string \| null` 且空基名时退回**整条路径**、`tabs.ts` 空基名时退回**中心主题名**。可抽 `baseNameOf(path): string` 而各调用点保留策略（正是本战役判据），但会动 `history/`、`renderer/store/tabs.ts` 等 3 个模块 → 超出 E1 本批范围，登记待派 |

---

## 处理结果（2026-09-15）

| 项 | 结果 | 落地位置 |
|---|---|---|
| **P0-1 保存非原子写** | **已修**：临时文件 → `fsync` → `rename`；失败清理临时文件且不碰原文件 | `src/main/atomic-write.ts`（含自检断言） |
| **P0-2 无错误边界 / 无进程兜底** | **已修**：渲染层错误边界（可复制错误信息、重新加载）；主进程 `uncaughtException` / `unhandledRejection` / `render-process-gone` / `unresponsive` / `did-fail-load` 全部落日志；菜单「帮助 → 打开日志目录」 | `src/renderer/src/components/ErrorBoundary.tsx`、`src/main/log.ts`、`src/main/index.ts` |
| **P0-3 自动保存失败被吞** | **已修**：失败会提示「自动保存失败，请尽快手动保存一次」 | `src/renderer/src/App.tsx` |
| **P0-4 损坏文件抛英文异常** | **已修**：改为中文说明并给出下一步建议 | `src/shared/xmind/parse.ts` 的 `loadZip` |
| **P1-1 无 CSP** | **已修**：生产构建注入 CSP（`script-src 'self'`、禁 object/base/form）；开发模式不注入（否则会打死 Vite 的内联刷新脚本） | `electron.vite.config.ts` 的 `smind-csp` |
| **P1-2 `sandbox: false`** | **已修**：改为 `sandbox: true`，实测生产产物正常启动 | `src/main/index.ts` |
| **P1-3 IPC 入参校验不均** | **已修**：路径合法性（`openPath` / `saveToPath` / `showInFolder` / `historyReveal`）+ 图片 20MB 上限与名称长度 | `src/shared/ipc-args.ts`（含自检断言） |
| **P1-4 公式错误消息未转义** | **已修**：经 `escapeHtml` 后再拼进 `title` | `src/renderer/src/render/formula.ts` |
| **P1-5 导入字段无结构校验** | **已修**：`titleRich` / `code` 逐字段收敛（颜色、字体、字号都限定字符范围），不再 `as` 强转 | `src/shared/model/coerce.ts`（含自检断言） |
| **P2-1 布局每击键全量重算** | **部分修**：测量新增「按对象身份」的快速路径（未改动节点直接命中，不再重建缓存键）；并修掉「改默认对齐/代码字号后布局不重算」。**真正的增量布局仍未做**（见下方遗留） | `src/renderer/src/render/measure.ts`、`store/editor.ts` 的 `renderEpoch` |
| **P2-2 大纲零虚拟化** | **已修**：视口外的行不再参与布局与绘制（`content-visibility`，并让滚动条高度稳定） | `src/renderer/src/styles.css` |
| **P2-3 搜索无防抖** | **已修**：180ms 防抖，画布高亮与搜索面板共用（清空立即生效） | `src/renderer/src/hooks/useDebouncedValue.ts` |
| **P2-4 筛选递归拷贝路径数组** | **已修**：改为父指针回溯，一次遍历 | `src/shared/search/index.ts` |
| **P2-5 缓存满即整体清空** | **已修**：改为淘汰最旧一批（25%），消除周期性卡顿尖峰 | `src/shared/cache.ts`（含自检断言） |
| **P3-1 无 ESLint / Prettier** | **已修**：ESLint flat config + Prettier + EditorConfig，`npm run lint` **0 error**；顺手清掉一批未使用的导入/变量，并修好工具栏三个按钮**丢失禁用原因提示**的缺陷 | `eslint.config.mjs`、`.prettierrc`、`.editorconfig` |
| **P3-2 无 CI** | **已修**：push / PR 自动跑 类型 → 规范 → 自检 → 样本往返 | `.github/workflows/ci.yml` |
| **P3-3 类型严格度不足** | **已修**：开启 `noUnusedLocals` / `noUnusedParameters`（只暴露 3 处，已修） | `tsconfig.json` |
| **P3-4 缺 CHANGELOG 等** | **已修**：新增 `CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md` | 仓库根目录 |
| **P3-5 仍有重复实现** | **已修**：备注 HTML 派生统一为 `notesHtmlFrom`；XML 转义统一到 `shared/xml-escape.ts`；删掉 `isPlainRecord` 历史别名 | 见左 |
| **附一 图标字母 M** | **已修**：字母改为 **S**（用圆弧拼，16px 也不糊），已重新生成 7 个尺寸的 ico 与 PNG | `scripts/make-icon.mjs`、`build/icon.*` |

### 本轮仍未做（明确记录，不是遗漏）

| 项 | 为什么没做 |
|---|---|
| ~~**真正的增量布局**（P2-1 的完整版）~~ | **已完成（见 `CHANGELOG.md` 未发布段）**。当时判断"连线、坐标归一化、按层/行/列的全局聚合本质上都是全局的"——结论仍然成立，但解法不是"把全局改成局部"，而是**把全局那几步做便宜 + 把不变的部分整块复用**：并行走新旧两棵树按引用剪枝（变更检测 O(脏路径)）、子树戳（内容+尺寸+预留的版本号）让测量/子树占用/层数/连线 path 直接命中跨轮缓存、几何没变的节点沿用上一轮对象、形状没变时零变更直接短路。落地在 `src/shared/layout/{incremental,stamp,run}.ts`，并要求「增量结果逐个字段等于全量结果」（14 个结构 × 全字段比较） |
| **边界/概要的空间预留只接了两个家族** | **已完成**：预留扩成四向，并逐个接进鱼骨 / 时间轴（横竖）/ 放射 / 矩阵 / 树状表格（见 `CHANGELOG.md` 未发布段）。自检对 14 个结构各有一条「边界/概要不侵入相邻分支」断言 |
| **导出 PDF 是位图 PDF** | **已完成**：PDF 改成矢量——主进程用 Chromium 的打印管线（`webContents.printToPDF`）把同一份导出 SVG 转成 PDF，文字可选中、图形是矢量、中文用系统字体。画布超过页面上限（约 190 英寸）或打印管线不可用时**自动回落**为原来的位图 PDF（并写日志），导出永不因此失败 |
| **`noUncheckedIndexedAccess`** | **已完成（全仓启用）**：全仓共 504 处（其中 304 处在自检脚本的断言里——那里刻意不启用，见下）。源文件约 200 处全部按语义修完，并把**整棵源码树（94 个文件）**纳入常驻检查（`tsconfig.strict.json`，由 `npm run typecheck` 一并运行）。几处是真会崩的：AI 返回内容里没有大纲行、对话框取消时仍取 `filePaths[0]`、公式尺寸拿不到时读 `box.width`、导出图片像素越界导致整图 NaN、空工作簿取 `sheets[0]`、Markdown 正则分组缺失时取 `[1].length`。**修法**一律按语义处理（提前退出 / 合理兜底 / 只有确证不可能缺时才断言），不做机械 `!`。<br>自检脚本不纳入：那里的下标都是断言里写死的，加几百个 `!` 只会让断言更难读，而"点错下标"在测试里会立刻失败、不需要这层保护 |
| **react-hooks 的 `refs` / `immutability` / `purity`（React Compiler 三条）** | **仍关闭，但已实测留档**（不是遗漏）。2026-09-18 用 `--rule` 覆盖跑过一遍：共 **19 处**——`refs` 10（Canvas 渲染期读写视口/选择镜像 9 + `RichTextEditor` 的 handlers 镜像 1）、`immutability` 8（Canvas `viewGestureAtRef.current += 1` 一族 5 + 改 DOM style 1 + 「变量在声明前被使用」2）、`purity` 1。<br>**已修 1 处**：`Dialogs.tsx` 渲染期 `Date.now()` → 存档时间缺失时照实显示「时间未知（存档信息不完整）」（既去了不纯，也比伪装成"刚刚"更有用）。<br>**刻意保留 18 处**：它们是同一类写法——画布的高频路径（原生 `pointermove`、拖拽中每帧改 transform、视口镜像）**走 ref 不走 state**，这是"指针跟手"的前提；规则要求的替代写法要么慢一帧（挪进 effect）、要么每帧重渲染（挪进 state）。<br>那 2 处「声明前被使用」**经核查语义正确、只是编译器证明不了**（`App.tsx` 是 useCallback 自引用，注册它的 effect 依赖就是它本身；`ChatPanel.tsx` 里被引用的 `setPending` 是普通局部函数、只写 ref 与稳定 setter），**没有为了让 lint 变绿去改窗口关闭 / AI 回合流程**——那才是真风险。<br>**真要开这三条时**（也是开 React Compiler 的前置）：① 视口镜像改成「在写入点就近写 ref」（`setZoom`/`setPan` 里同步写）→ 命中降到个位数；② 高频状态搬进外部 store + `useSyncExternalStore`、命令式 DOM 写入规范化。细则与实测数字同见 `eslint.config.mjs` 的注释 |
| **`set-state-in-effect`（原 9 条 warning）** | **已处理完毕**：其中 **4 处是真问题**（`useCallback` 缺依赖 → 闭包会读到首次渲染的值，含上一轮我自己引入的一处），已补依赖；其余 5 处是「异步加载磁盘数据」「按依赖重置草稿」这类**合法写法**，用带原因的 disable 保留（硬改需要 remount 或派生状态，代价是丢掉面板内的滚动/焦点等状态）。lint 现在是 **0 error / 0 warning**，并把 `--max-warnings 0` 写进脚本**锁住基线**——这才是不留告警的真正意义：以后新增的告警立刻可见 |
| **P4-1 / P4-2 / P4-3 签名 / 自动更新 / 跨平台** | 分别需要购买代码签名证书、准备发布渠道、以及在对应平台实测，都不是本机改代码能完成的。未签名的影响已在 `README.md` 写清（首次运行提示 + 操作指引） |
| **P5 功能缺口** | 属于产品取舍（演示模式、打印、加密、docx/mm 导入、i18n……），本次刻意不做 |
| **本轮审计剩下的（未做完）** | 只剩**死导出**一项：审计给的是 A 类 72 处 + B 类 129 处，但同一份审计的多条结论已被证伪，这份清单必须逐条自行 grep 复核后再删，且 grep 要同时覆盖 `src/**` 与 `scripts/**`。<br>**其余各项已全部结清**：重复实现收敛——祖先链 `ancestorTitlesOf`/`titlePathOf`、引号扫描 `scanQuoted`、字体串 `cssFontOf`、语言清单 `CODE_LANGUAGES` 唯一来源、大纲方言 `outline-dialect.ts`（AI 大纲与 Markdown 导入共用原语，各自的特殊策略仍分开）；快照作用域＝恢复前按 `snapshotOwnerKey` 校验归属，配额本来就有（`prune` 的 `SNAPSHOT_LIMITS.perDoc` + 手动版本优先保留）；**边界落在连续同级之间由布局侧强制**（`resolveRange` 只在两端同一父级时展开连续兄弟，异常区间退化成单个主题）；`viewportActions` 在画布卸载时复位成空实现（`NOOP_VIEWPORT_ACTIONS`） |

**已核实"不必改"的写法**（避免以后重复立案）：`countTopicTree` 只走 `children`（给模型报分支规模，与实体层级一致）而 `countTopics` 走 `walk`（含自由摆放主题，界面用）——**有意不同**，`ai/context.ts` 的注释已写明"别把两者合并"。

**「死导出」清单（审计 A 类 72 处 + B 类 129 处）经复核：不做批量剪除**，理由记录在此：
- 清单里的条目**要么是多余的 `export` 关键字、要么是 barrel 的冗余再导出**（审计自己在 (b) 段就写明"是 barrel 没有消费者的再导出，属于可剪枝候选，**不是死代码的证据**"）。类型再导出在构建时被完全抹掉，剪除**没有运行时收益**；而这个项目没有外部消费者，barrel 的公开面本身也不是负担。
- 清单的可靠性已被证伪多次：`runsToHtml`（在 (c) 段被点名"零调用、建议删掉"）**实际被 `scripts/selfcheck.ts` 的行内语法断言调用**——按清单删会直接编译失败。
- 唯一**真实**的问题是 `runsToHtml` 的参数里有个 `RichTextRun` 并不存在的 `mono?: boolean`（等宽的真实表示是 `fontFamily`），已就地写成注释（`shared/richtext/index.ts`），不无中生有一个字段。
- 结论：**不值得为"看起来干净的导出面"去改动 200 处零收益的代码**；若将来真要收紧，正确做法是"按目录逐个 barrel 决定哪些是公开面"，而不是照抄一份已多次出错的清单。

## P0–P3 快照的逐条核实（2026-09-20）

> 本节取代原先的 `## P0 / P1 / P2 / P3` 四节——那四节是 **2026-09-14 的审计快照**，标题里还写着「建议**明天**先做」「**明天**不必再查」，那个「明天」是 9/15。
> 2026-09-20 逐条回查代码：**已修的全部删除**（核实证据见下表），**仍开着的 2 条**保留在下方。
> 删掉而不是打勾，是为了让这份文档恢复它唯一的作用：**回答「还剩什么没做」**。

| 原条目 | 当时的断言 | 2026-09-20 回查（证据） |
|---|---|---|
| P0-1 | 保存不是原子写，会把原文件截断成坏包 | **已修**：`writeJsonAtomic` / `writeFileAtomic` 全仓 25 处，`main/atomic-write.ts` 在 |
| P0-2 | 没有错误边界，出错就是白屏 / 静默退出 | **已修**：`renderer/src/components/ErrorBoundary.tsx` 在 |
| P0-3 | 自动保存失败被静默吞掉 | **已修**：`use-autosave.ts:43` 会 `showToast('自动保存失败：…（请尽快手动保存一次）')` |
| P0-4 | 损坏文件把 JSZip 英文异常直接抛给用户 | **已修**：`main/document.ts` 给人话原因 + GBK 回退 + 解压前拦压缩炸弹 |
| P1-2 | `sandbox: false` | **已修**：`main/windows.ts:46`、`main/ipc/export.ts:135` 均为 `sandbox: true` |
| P1-4 | 公式错误信息未转义就拼进 HTML 属性 | **已修**：`render/formula.ts:42` 已用 `escapeHtml` |
| P1-5 | 导入的外部字段缺结构校验（`as unknown as`） | **已修**：`xmind/parse.ts` 已用 `isRecord` 逐字段守卫 |
| P2-1 | 布局每次击键全量重算 | **已修**：增量布局（`shared/layout/{incremental,stamp,run}.ts`），自检有「增量必须逐字段等于全量」断言 |
| P2-2 | 大纲面板零虚拟化 | **已修**：已用 `content-visibility` |
| P2-3 | 搜索没有防抖 | **已修**：防抖痕迹 13 处 |
| P2-4 | `applyTopicFilter` 每次递归都拷贝路径数组 | **已修**：改父指针回溯（`shared/search/index.ts` 的注释里记着这次改动） |
| P2-5 | 测量缓存到上限是整体 `clear()` | **已修**：`@shared/cache` 的 `evictOldest` 分批淘汰 |
| P3-1 | 没有 ESLint / Prettier / .editorconfig | **已修**：四件套齐 + `npm run lint`（现零告警） |
| P3-2 | 没有 CI | **已修**：`.github/workflows/ci.yml`（含 `format:check` 一道门） |
| P3-3 | 类型只开 `strict` | **已修**：`noUncheckedIndexedAccess` 已进 `tsconfig.strict.json` |
| P3-4 | 缺 CHANGELOG / CONTRIBUTING / SECURITY | **已修**：三份都在 |
| P3-5 | 仍有重复实现（备注 HTML 派生 / XML 转义 / `isPlainRecord` 别名） | **已修**：`isPlainRecord` 0 处；`editor.ts` 2084 → **74 行**（原文那种行号引用早已失效——这正是它后来改用符号名的原因） |
| P3-6 | 提交习惯（多主题攒成一笔） | **无需修**：属流程约定；后续各批均已按主题单独提交 |
| 附一 | 图标字母还是 M，产品名已是 SMind | **已修**：`scripts/make-icon.mjs:5` 现写着「字母用『S』（应用名 SMind 的首字母）」 |
| 附二 | 八项「已核查确认没问题」 | **结论保留**（路径穿越安全 / 导航与弹窗一律拒绝 / 只放行 `https?`·`mailto` / 零 `as any`·零 `ts-ignore` / 零 TODO·FIXME / 定时器与 IPC 监听有清理 / 外部数据不当 HTML 执行 / `contextIsolation: true` + `nodeIntegration: false`）。⚠️ **证据行号已随重构失效**，需按符号名重新定位；其中「零 TODO·FIXME」于 2026-09-20 复测仍成立 |
| 附三 | 「明天的建议顺序」5 条 | **已全部执行**（原子保存 / 错误边界 + autosave / 三处小修 / CI + lint / 安全纵深） |
| P5 | 功能缺口清单 | **需重新核对一条**：`.docx` 现已被 `main/document.ts` 用于**抽取文本**（AI 附件那条链路），是否等同于原文所指的「导入成图」待确认；其余仍未实现 |

### 原「仍开着的 2 条」——2026-09-20 复核后**均已关闭**

#### P1-1 渲染进程 CSP：**已修（2026-09-15）**，本条曾被一次复核误记为"仍未设置"

- **误记的原因（搜索口径）**：原文写「2026-09-20 实测：全仓搜不到 `Content-Security-Policy`」——
  但 `electron.vite.config.ts` 在**仓库根目录**、不在 `src/**` 下，只搜源码目录必然搜不到。
- **实测证据（2026-09-20 复核）**：`electron.vite.config.ts` 的 `CSP` 常量 + `cspPlugin()`
  （`apply: 'build'`，`transformIndexHtml` 注入 `<meta http-equiv="Content-Security-Policy">`）；
  **构建产物 `out/renderer/index.html` 里确有该 meta**：
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: mind-resource:;
  font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`；
  另 `SECURITY.md` 与本文档的 2026-09-15 处理结果表都登记为**已修**。
- **开发模式刻意不注入**（否则会打死 Vite 的内联刷新脚本）→ 验收判据是"**打包版** Console 无 CSP 警告"。
- **复核方法**：`npm run build` 后
  `Select-String -Path out/renderer/index.html -Pattern Content-Security-Policy`。

#### P1-3 "每个参数都校验"的覆盖度：**按拍板判据不做**

- 现状（2026-09-20 复核）：`shared/ipc-args.ts` 覆盖路径与图片载荷校验，`shared/guards.ts` 通用守卫，
  再加 **IPC 契约静态断言**（70 条通道常量 / 66 条注册 / 无重复 / 每条渲染→主通道都有 handler / preload 两侧齐全）。
- **判据**（用户 2026-09-20 拍板，**三条同时满足才值得加网**）：**静默失败 ＋ 会伤数据或收入 ＋ 能纯函数化**。
  缺失入参校验的症状是**当场报错**（不是静默写坏文件），不满足第一条；而"把『必须校验』写进契约断言"
  属"改通道就得改测试"的变更检测器，与 menu 结构那条同性质 → **不做**。
- 真要回来时看这里：该补的是"会**静默**伤数据"的入参路径（写盘路径已全部来自对话框，不走用户输入）。

---

## P4 · 分发

| 编号 | 问题 | 影响 | 备注 |
|---|---|---|---|
| P4-1 | 无代码签名 | 对方首次运行会看到 SmartScreen「未知发布者」，需点「仍要运行」 | 消除必须购买证书；过渡期可在 README 里写明这一点 |
| P4-2 | 无自动更新 | 升级要重新分发 exe | ✅ **已实现**（客户端 + 渠道 + 镜像脚本 + CI，2026-09-19：`20bcd71` `bfc4932` `6b09711`）：打包版启动 45s 后台检查、退出时静默安装、帮助菜单可主动检查/立即重启安装；**免安装版不支持自更新**（显式守卫 + 提示手动下载）；更新源为 **GitHub Releases 固定直链**（generic provider，2026-09-20 改；R2 因无可用支付方式搁置，见 `docs/release-mirror.md`）。**2026-09-20 已发版**：v0.9.1 Release 已发布（四件资产齐全，`latest.yml` 的 `version=0.9.1`、三条直链实测 206），官网下载页与首页已切到 0.9.1 |
| P4-3 | 仅 Windows x64 | macOS / Linux 未配置 | 按需 |

---

## P5 · 功能缺口（相对 Xmind，已确认"完全没有"）

- 演示 / 走查（Pitch）模式、Zen 专注模式（需求书列为"暂不做"）
- 打印 / 打印预览
- 文档加密 / 口令保护
- Word（`.docx`）导入
- FreeMind（`.mm`）导入（现在只有 Markdown / OPML；`.txt` 是蹭 Markdown 通道，没有独立的纯文本大纲导入）
- 自动编号
- 界面多语言（文案硬编码简体中文）
- 界面级浅色 / 深色切换（现有 `builtin-dark` 只改画布配色，不动界面外壳）
- 模板库
- 文件夹 / 批量管理

**优先级判断**：这些不建议现在做。本项目的差异点是**本地优先 + 格式保真 + 反向兼容亿图 `.emmx`**，把这三件事做深，比补齐功能清单更值。

---

## 待处理（2026-09-21 独立只读审查：F1–F5）

来源：一次独立代码审查（覆盖 `store/slices/**`、`layout/**`、`app/**`、`main/**` 胶水层与部分画布 hook；
`shared/agent/**`、`shared/ai/**`、`shared/export/**`、`xmind/serialize.ts` 与多数 `*.tsx` **未覆盖**）。
行号以提交 `65d028a` 为基准，**符号名优先**（行号一改就假，本轮已因此踩过）。
五条都**不是**解耦搬迁引入的（`history.ts` 那批注释已写明"逐字未改"），是早就存在的语义缺陷；
共同根因是「自检 2800 条断言全在纯函数上，而真 bug 落在栈满 / 多标签 / 异步竞态 / 诊断埋点」。

### F1 撤销栈满 200 后，AI 回合的「一步撤销」静默失效（P0）

- **现象**：长会话（撤销栈接近或达到 200）之后，AI 改一轮再按 Ctrl+Z **回不到**改动前、要按 2~N 次；
  而气泡与 `chat/turn-runtime.ts` 仍打印"按一次 Ctrl+Z 全部回退"——对用户说了假话。
- **证据**：`store/slices/history.ts` 的 `HISTORY_LIMIT = 200`（:31）、入栈 `slice(-HISTORY_LIMIT)`（:108-111）、
  `aiTurn.depth = undoStack.length`（:120，**拿数组下标当深度**）、`undoStack.slice(turn.depth)`（:138）、
  合并 `[...slice(0, turn.depth), merged].slice(-HISTORY_LIMIT)`（:155）。
  截断从**头部**丢而 `depth` 按下标记 → 栈满后 `slice(depth)` 恒为空 → 走 `batch.length === 0` 分支：
  只清 `aiTurn`、什么都不合并；`commitTurn` 又忽略了返回值，失败无人知晓。
- **建议**：`depth` 改存**稳定标识**（entry id，或"距尾部偏移"），合并时按标识定位；返回值接到调用点，失败至少落一行日志。
- **验收**：自检断言——把栈填满 `HISTORY_LIMIT` 后再做一轮三步改动，`undo()` 一次即回起点。

### F2 多标签下崩溃恢复只覆盖「激活标签」（P0）

- **现象**：一个窗口开 A/B 两标签、都改过未保存 → 崩溃后只能恢复最后激活的那个；README 却笼统承诺"30 秒自动保存 + 崩溃恢复"。
- **证据**：`main/autosave.ts`（自动存档按**窗口**分槽 slot-N，不是按标签）；
  `main/ipc/document.ts` 的 `writeFileAtomic(autosaveFile(state.slot), bytes)` 只写激活标签；
  `app/use-autosave.ts` 只送 `activeDocId()`；`app/use-document-actions.ts` 任一次保存就把整槽 `clearAutosave()`。
- **建议**：槽位按标签分文件（slot-N-doc-M）；或单文件内改存多文档；至少"非激活标签有未保存改动时不清空槽位"。
- **验收**：自检覆盖"两标签都脏 → 存档序列化含两份"；真机：两标签各改一笔 → 强杀 → 看恢复提示覆盖两个。

### F3 保存期间的新编辑被 `markSaved()` 一并标成「已保存」（P1，窄窗口竞态）

- **现象**：写盘那几十到几百毫秒里继续打字，这些改动没落盘却被标记已保存 → 之后关窗不再提示，静默丢失。
- **证据**：`app/use-document-actions.ts`：`const state = useEditor.getState()` 取快照 → `await saveToPath(...)`
  → `useEditor.getState().markSaved(state.filePath)` 无条件置假；`store/slices/document.ts` 的 `markSaved` 直接 `set({ dirty: false })`。
- **建议**：给文档加"保存代次"（`mutate` 自增），`markSaved` 只在代次未变时置 `dirty: false`。
- **验收**：自检断言"保存期间有改动 → 仍 dirty"。

### F4 `moveTopic` 在「目标父级不存在」时改了树却返回 false（P2）

- **现象**：拖拽/批量移动时若目标父级已被删除或收起，节点被挂到**根下**且保留自由摆放偏移，
  调用方却按"没移动"处理——不收尾、不计入结果、不更新选中。
- **证据**：`shared/model/tree.ts` 的 `moveTopic`：先 `detachTopic`，`if (!parent) { attachChild(root, node, index); return false }`；
  `store/slices/move.ts` 的 `if (!moveTopic(...)) continue` 跳过位置清理，`if (ok) settleAfterMove(...)` 也不执行。
- **建议**：二者选一——要么真的不移动（原样挂回再返回 false），要么返回 true 让调用方按"移到根下"收尾。
- **验收**：自检断言"目标父级不存在 → 树与调用前逐字相同"或"→ 挂到根下且 position 已清理"。

### F5 自动存档计时恒为 ~0，并污染 AI 回合的耗时归属行（P3，诊断可靠性）

- **现象**：为抓"回合结束后冻结"埋的计时点量到的是"发起 IPC 的时间"，永远看不到真实写盘开销。
- **证据**：`app/use-autosave.ts` 的 `const endSave = beginCost('自动存档快照')` → `void window.api.autosave(...)`（**没有 await**）
  → 紧接 `endSave()`；`dev/stage.ts` 的 `beginCost` 是纯同步计时器，`reportCosts` 会把 `costs` 表里所有条目拼进那一行。
- **建议**：`await` 后再 `endSave()`（或 `.finally`）；不想阻塞就换个不进 `costs` 表的名字。
- **验收**：真机跑一次自动存档，诊断行里该条耗时应与实际写盘量级一致。

**2026-09-21 处置**：按用户决定，**本轮只登记不改**（先把「关系线/概要富文本 + 高亮」两条需求做完）。
其中 F1 / F2 / F3 都满足「静默失败 + 伤数据」两条，建议尽早排一轮；F5 是取证链路的可靠性问题，改动最小、可顺手做。
