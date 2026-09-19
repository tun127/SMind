# 解耦任务总表（Decoupling Plan）

> 生成：2026-09-19 ｜ 权威依据：`docs/refactor-audit.md`（§3 拆分计划、§4 执行顺序）
> 本文件是它的**可执行版**：每一项＝一个批次＝一个提交，逐项给「现状 / 目标 / 手法 / 调用点改动 / 风险 / 验收」。
> 每完成一项，把状态列改成 ✅ 并写上提交号。

---

## 一、总原则（每条都不可省）

1. **行为零变化**。拆分只搬代码。任何"顺手修一下"的冲动 → **另开一个提交**，不许混进拆分。
2. **调用点改动 0–2 行**：原文件保留为入口（facade / barrel，显式再导出或 `export *`）。同名文件与目录可共存（`measure.ts` + `measure/`）。
3. **每批五道门槛**：`typecheck`（含 `tsconfig.strict.json`）/ `lint --max-warnings 0` / `format:check` / `selfcheck` / `verify`，全绿才提交。
   **每道门单独打印退出码**——用 `;` 串联只在末尾读一次 `$LASTEXITCODE` 会吞掉前面失败的门（本轮真踩过：`format:check` 的 exit 1 被掩盖）。
4. **一次只搬一个文件**，不许两个文件合批，便于回滚时精确定位。
5. **搬动用整段字节级移动**（按行范围剪切粘贴，不改内容），搬完先跑门槛，再做重命名与整理。
6. **导出面逐一核对**：搬动前后对「导出名集合」做 diff，证明零丢失（`shared` 层六次拆分都这么验的，结果全部 `LOST: (none)`）。
7. **源码编辑一律走 read/write/edit 工具**。禁止用 PowerShell 的 `Get-Content -Raw` + `Set-Content` 批量改：会重编码整份文件、把中文注释写成乱码（本轮真发生过，靠 `git checkout` 恢复）。
8. 每一批提交信息里写清：**搬了什么、调用点改了几行、门槛结论、以及"没做行为改动"**。

---

## 二、现状（实测，2026-09-19）

| 指标 | 数值 |
|---|---|
| 规模 | 战役起点 **144 个文件 / 56,681 行** → 现 **192 个文件 / 58,914 行**（文件数因拆分上升；行数上升来自自检断言 2522 → 2628 项与新模块） |
| 分层方向 | `shared` 从不 import `renderer`/`main`；`main`/`preload` 不 import `renderer`；**无循环依赖**（唯一一个是类型态可擦除的 `layout/types ↔ layout/accessory`） |
| IPC 面 | **70 条通道，两侧齐全**（脚本逐条核对：preload 缺失 0、main/menu 缺失 0） |
| 已完成拆分 | **`shared` 层 6 次全完成**：`layout/core`（`6eeab2f`）、`layout/overlays`（`6c2f7ee`）、`layout/graphic`（`a7b01ec`）、`agent/index`（`db46ffd`）、`code/highlight`、`ai/index`；死代码清理 `8b7908a` |
| 未完成（2026-09-19 本轮实测同步） | 只剩 **3 个 600+ 行文件**：`Canvas.tsx` 2951（A8，未开工）、`store/editor.ts` 2316（B1）、`chat/use-chat-loop.ts` 1274（A6 的 runtime 模块，按任务表「ref 环不可跨文件拆」整块落地）。`main/index.ts` 已降到 54 行、`selfcheck` 入口 473 行、`NodePanel`/`Toolbar`/`ChatPanel`/`App` 均已降到 142/322/417/466 行 ｜ **2026-09-19 晚更新**：A8 已收尾 —— `Canvas.tsx` **2951 → 385**（9 批，`canvas/` 22 个文件）；`chat/turn-runtime.ts` 仍 636（A6-4 可选）、`store/editor.ts` 仍 2181（B1 第二步待做）、`App.tsx` 仍 366（A7 残留） |
| 安全网 | `selfcheck` **2628 项断言**（本轮从 2522 涨上来的），`verify` 21 个 `.xmind` + 4 个 `.emmx` 往返一致 |

> **行数口径更正（2026-09-19）**：本机 PowerShell 的 `Get-Content` 按 GBK 解码，会**吞掉 LF-only 文件里紧跟中文的换行符**——用它统计行数偏小（实测：5 行的临时 LF 文件被数成 2 行；仓库里的 CRLF 文件不受影响）。`.editorconfig` 要求 `end_of_line = lf`，所以本轮新增/重写的文件都是 LF，**行数必须用 node 统计**（`fs.readFileSync(f,'utf8').split('\n')`）或直接看 `read` 工具的末行号。
> **node 口径实测**：A4 `NodePanel.tsx` **814 → 142**、A5 `Toolbar.tsx` **1059 → 322**、A6 `ChatPanel.tsx` **1953 → 417**（另 `chat/use-chat-loop.ts` **1274**）、A7 `App.tsx` **1272 → 466**；未受影响的项：`TopicNode.tsx` 305、`Canvas.tsx` 2951、`store/editor.ts` 2316、`scripts/selfcheck.ts` 473、`main/index.ts` 54。**任务表各行括注的行数是当时用 Get-Content 量的（偏小），以本条为准。**

---

## 三、任务表

顺序＝依赖顺序＋风险从低到高。**每一行都是一批、一个提交。**

### Step A · 渲染层（8 项）

| # | 现状 | 目标结构 | 手法 | 调用点改动 | 主要风险 | 状态 |
|---|---|---|---|---|---|---|
| A1 | `render/measure.ts` 723 | `render/measure.ts` 入口 + `measure/{cache,formula-size,wrap,style,main}.ts` | 先把「字宽缓存」「公式尺寸」「断行」「样式解析」四块按行范围搬出，入口保留同名再导出 | 0 | `cssFontOf` / `ResolvedStyle` 刚被导出过，注意别丢公开面 | ✅ 9b5f077 |
| A2 | `export/drawing.ts` 741 | `export/drawing.ts` 入口 + `export/ops.ts`（类型）+ `drawNode.ts` + `drawOverlay.ts` + `compose.ts` | 类型先搬到 `ops.ts`，`svg.ts`/`raster.ts` 改从 `ops` 引类型 | 2（svg、raster 的 import） | 类型搬动后 `strict` 配置下的 `noUncheckedIndexedAccess` 可能报新错 → 逐处按语义处理 | ✅ 8fdc8d6 |
| A3 | `components/TopicNode.tsx` 618 | `topic/` 5 个（外壳 / 文本 / 装饰 / 附件与指示器 / 内联公式） | 抽子组件，props 原样传 | 0 | `React.memo` 的浅比较：回调 props 必须是稳定引用，别在拆分时引入内联箭头函数 | ✅ A3-1 `64ed49e`（纯搬动）+ **A3-2 收口**（3 批：`0bb4812` `3fe548d` `329546a`，共抽 9 个子组件到 `topic/`）；入口 619 → **305** 行。**外壳刻意不抽**：`.topic` 外层 div 的 className/style 依赖 `visualFor`/`branchColorOf`/`minNodeWidth` 等一组值，其中 `color`、`minNodeWidth/minNodeHeight` 折叠徽标与拉伸手柄也要用——抽出去要么重复计算、要么只剩一个空壳 div，都比"只搬不改"更差 |
| A4 | `components/NodePanel.tsx` 814 | `nodePanel/` 4 个（两条独立分支各拆组件 + 公共控件） | 按"选到节点 / 选到画布元素"两条分支拆 | 0 | 面板内草稿状态（`useState`）跨组件后要确认没有重复初始化 | ✅ **`8441f54`**：入口 **814 → 133**；`nodePanel/` **7 个**（`panel-parts` 34 / `overlay-branch` 160 / `topic-branch` 318 + 段落 `marker-section` 73 / `image-section` 95 / `attachment-section` 113 / `overlay-list-section` 101——段落组件是为满足 DoD「子模块 ≤400 行」从 613 行的 topic-branch 再拆的）。**高危点的解法＝草稿 state 不下沉**：六个草稿 `useState` + 三个聚焦 ref + 四个 effect 全留在入口层，子组件只收原样 props；因为 `selectOverlay` 会清空 `selection`，分支组件确实随选中对象挂载/卸载，草稿搬下去生命周期就会变。行多重集守卫：旧文件独有的 25 种行全部可解释，无一行 JSX/className/文案丢失 |
| A5 | `components/Toolbar.tsx` 1059 | `toolbar/` 3 个（主栏 / 结构切换 / 视图与缩放） | 自洽组件直接搬家 | 0 | 工具栏项数组里有彼此依赖的禁用条件，搬完要手点一遍逻辑分支 | ✅ **`c11e365`**：入口 **1059 → 310**；`toolbar/` **11 个**（`tool-menu` 156 / `pin-wrap` 90 / `quick-items` 26 + 8 个工具组：`file-group` 152 / `edit-group` 85 / `structure-picker` 41 / `overlay-group` 82 / `panel-group` 107 / `ai-group` 40 / `view-controls` 80 / `pinned-group` 73）。**高危点的解法＝整组搬走**：禁用条件与按钮始终留在同一个 JSX 块里；`toggle`（useMemo 防 selector 新对象）、三句禁用原因提示、`currentStructure` 三个派生值都随组搬家。行多重集守卫：旧独有 37 种行全部可解释，无一行 JSX/className/文案丢失 |
| A6 | `components/ChatPanel.tsx` 1953 | `chat/` 5 个（runtime 状态机 / 纯函数 / 消息列表 / 工具条目 / 确认弹层） | 先抽纯函数与 runtime（本轮修过 `aiTurn` 收尾，`commitTurnRef` 一族必须整体搬、不能拆开） | 0 | **最高风险之一**：`runRoundRef`/`processQueueRef`/`commitTurnRef`/`stopRef` 是"打破循环引用"的一组 ref，拆散的瞬间会变成"用到未初始化" | ✅ **`fa7d843`（A6-1）+ `a5bc249`（A6-2）**：入口 **1953 → 386**。A6-1 抽纯函数与 10 个展示组件（`types` 44 / `format` 22 / `title-refs` 36 / `tool-notes` 21 / `message-list` 130 / `chat-header` 92 / `chat-input` 122 / `confirm-bar` 51 / `license-bar` 81 / `doc-chips` 36）；A6-2 把 runtime **整块**搬进 `chat/use-chat-loop.ts`（1155 行，含 4 个 effect）。**ref 环按任务表要求当作一个模块搬**：四个环 ref 与它们指向的四个函数同处一个文件；`handleEvent` 仍是 `useCallback(..., [update, dumpDiag])`、订阅 effect 仍是 `[handleEvent]`（一旦因渲染重跑，cleanup 会把正在跑的回合掐掉），effect 声明顺序与依赖数组一字未动。搬迁用 `.tmp-check/move-chat-loop.mjs`（15 段区间逐段断言首末行标记 + 区间不重叠 + 先校验后落盘）。<br>⚠️ **残留（DoD 例外，已记在「仍未做」）**：runtime 模块 1155 行 > 子模块上限 400。任务表强制「ref 环不可跨文件拆」与「子模块 ≤400」在这一项上冲突，本轮选择先满足前者；**A6-3 ✅ 已完成（代码实体在 `57b044e`，记录提交 `0115b5d`）**＝按 `applyWriteIntent / noteAction+pushToolResult+compress+diag / processQueue / commitTurn+setPending+skipConfirmFor` 边界收成一个 `createTurnRuntime(deps)` 工厂（**22 个显式 deps 字段**、函数体逐字不动）→ `chat/turn-runtime.ts` **636 行**，`use-chat-loop.ts` 1274 → **799**；`handleEvent` / `send` 按配方留在 hook（订阅 effect 依赖 `[handleEvent]`，搬走会掐掉正在跑的回合）。残留与 A6-4 配方见 §八 |
| A7 | `App.tsx` 1272 | `app/` 8 个 hooks（菜单事件 / 快捷键 / 自动保存 / 窗口关闭 / 标签同步 / 主题 / 剪贴板 / 启动） | 逐类副作用抽 hook | 0 | 窗口关闭与未保存确认这条链路刚修过（`closeCancel`），拆时要保证 effect 顺序与依赖不变 | ✅ **`394e1f1`（A7-1）+ `f55a2af`（A7-2）**：入口 **1272 → 443**，`app/` **8 个 hook**（`use-theme-library` 37 / `use-menu-commands` 138 / `use-autosave` 64 / `use-recovery` 69 / `use-window-title` 31 / `use-keyboard-shortcuts` 232 / `use-file-drop` 100 / `use-document-actions` 328）。**关窗链路一字未动**：`closeApp`/`forceCloseIds`/`closeWindowFlow`/`closeTabById`/`guard`/`receiveExternalFile`/`pending` 弹窗与 `onCloseRequest` effect 全部留在 App。**每个 hook 的调用点落在它原来那个 effect 的位置**，effect 声明顺序与拆分前逐一对应；只有 10 处依赖数组补了稳定项（RefObject / 模块级函数 / React setter），不改变重跑时机。<br>⚠️ **残留**：入口 443 行 > DoD 建议的 250；剩下的是必须与关窗链路一起设计的部分（见 §八） |
| A8 | `components/Canvas.tsx` 2951 | `canvas/` 11 个（4 hooks + 3 纯函数 + 4 组件） | 先抽纯函数（命中测试、落点、手势数学），再抽 hooks（视口/跟随/拖拽/框选） | 0 | **最高风险**：`viewportActions` 注册与 `useLayoutEffect` 锚点补偿依赖挂载顺序；`refs` 一族是"指针跟手"的前提，不许改成 state | 🟡 **已做 9 批（`9acca77` `fad4f30` `e69e4b0` `1597796` `2444758` `25d00ff` `76c6eb4` `b30c78d` `7e39e42`）**：入口 **2951 → 385**；`canvas/` **22 个文件**（纯函数 `geometry` 388 / `clip-text` 19；薄绑定 hook `use-canvas-geometry` 143 / `use-canvas-viewport` 197 / `use-flash-nodes` 41 / `use-view-follow` 251 / `use-wheel-pan-zoom` 85 / `use-fold-anchor` 57 / `view-lock-warn` 18 / `use-node-drag` 608 / `use-relationship-drag` 180 / `use-title-edit` 73 / `use-marquee-select` 184 / `use-canvas-layout` 186 / `use-canvas-display` 395 / `use-node-callbacks` 130；JSX 层组件 `canvas-edges-layer` 317 / `canvas-overlay-layer` 338 / `canvas-nodes-layer` 123 / `canvas-title-editor` 81 / `canvas-hints` 68 / `canvas-relationship-hit-layer` 49）。手法＝**整块搬 + 薄 hook + 调用点落在原位置**（去 ref 化：原来读 `layoutRef.current` / `rootRef.current` 的地方在纯函数里收成显式入参，由薄 hook 在调用那一刻读 ref 传进去）＋**JSX 整层抽组件**（外面包 Fragment、props 原样传、不加 `memo`、回调不重新包装）。三条红线都按实测处置：`viewportActions` 注册与**卸载复位**逐字搬进 hook、`useLayoutEffect` 锚点补偿连它的两个 ref 整块搬且**调用点落在原位置**（effect 次序逐条核对过）、`refs` 一族一个都没改成 state。<br>⚠️ **残留**：入口 385 行 > DoD 250；剩下的是**画布顶部的 state/选择器/ref 与十二处 hook 装配**（组合根）＋ JSX 外壳。按 §八 的口径记为「入口刻意保留的装配代码」（见 §八） |

### Step B · `store/editor.ts`（1 项）

| # | 现状 | 目标 | 手法 | 调用点改动 | 风险 | 状态 |
|---|---|---|---|---|---|---|
| B1 | `store/editor.ts` 2316 | 纯逻辑下沉 `shared/model`（撤销栈合成、排序、移动、派生值）+ `store/slices/` 6 个 | **先下沉纯函数**（可被 selfcheck 直接覆盖），切片放最后一步 | 0 | zustand 切片组合会改变 `set/get` 的书写方式；`aiTurn`/`viewLock`/`lastFold` 这些跨域状态必须先想清楚归哪个切片 | 🟡 **第一步已完成 `57b044e`**：11 个纯函数（12 段 139 行）→ `shared/model/editor-pure.ts`（175 行），`editor.ts` 2316 → **2181**；调用点 0 行（公开面靠 `editor.ts` 再导出兜住）。**实测：真正可搬的只有这 11 个**，`useEditor` 的 1615 行（120 个成员）没有一个现成可搬。剩余＝「内联纯逻辑」约 188 行 + 切片（归属表见 §八） |

### Step C · `main/index.ts`（1 项）

| # | 现状 | 目标 | 手法 | 调用点改动 | 风险 | 状态 |
|---|---|---|---|---|---|---|
| C1 | `main/index.ts` 2498 | `main/ipc/*`（12 域）+ `windows.ts` / `files.ts` / `ai.ts` / `lifecycle.ts` | **先建 `ctx` 类型并让现有代码适配**，再按域逐个搬回调；**通道名一律不动** | 0（渲染层完全无感） | 窗口状态（`stateOf`/`docOf`）与关闭确认链路是跨域共享的，必须全部经 `ctx` 传递，不许留模块级可变单例 | ✅ **已拆完（8 批）**：`a8aebe6`（建 `MainContext` 并让现有代码适配）→ `cdf8cff`（历史域）→ `b2b0647`（文档资源表下沉成纯函数）→ `e3aaf3c`（AI / 自动保存 / 主题 / 文件读写）→ `a7af884`（窗口 / 文档 / 恢复 / 设置 / 主题 5 域）→ `230d4c9`（其余 8 域）→ `7d7cbe8`（windows / resource-protocol / ipc 调度器）→ `3a61e69`（lifecycle）。入口 `main/index.ts` **2498 → 65 行**；14 个 IPC 域在 `main/ipc/*`（1479 行）；跨域可变状态只经 `ctx` 传递，无模块级可变单例；通道名与注册顺序未动 |

### Step D · `scripts/selfcheck.ts`（1 项）

| # | 现状 | 目标 | 手法 | 调用点改动 | 风险 | 状态 |
|---|---|---|---|---|---|---|
| D1 | `scripts/selfcheck.ts` 11,844 | `scripts/selfcheck/` 16 个域文件 + `harness.ts` | **先落 harness**（`check`/`eq`/`group`/`failures`/`reset` 等），再逐域搬；`main()` 调用顺序不变 | 0（入口仍叫 `scripts/selfcheck.ts`，`run-selfcheck.mjs` 不动） | 各域的局部 helper（如 `json`）作用域会变——本轮就踩过"在 A 域里用了 B 域的 `json`"导致运行时报 `ReferenceError` | ✅ a40bce9 / 1357011 / 72b35cf / b12c0f7 / e45774b / 8247a9d / 232ca88 / 23bbf5f / e075a84 / dcacfb4 |

### Step E · 剩余重复实现收敛（按需，逐组单独提交）

| # | 内容 | 状态 |
|---|---|---|
| E1 | **枚举真实来源是 `docs/shared-audit.md` §5「Duplicated implementations」**（(1)–(18) 共 18 组；`refactor-audit.md` §5 是「刻意不做」，不是这份清单——本条此前指错了文件，2026-09-19 实测订正）。收敛判据见 `known-issues.md`：**抽原语、调用点各留策略**，不是强行合一 | 🟡 已收 **8 组**：`FOLD_SIDE_LABELS`（`0054b68`，下沉 `shared/model/fold-labels.ts`；审计建议的"复用 @shared/agent"**不成立**，改为放中立模型层）、(1) XML 实体解码（`shared/entities.ts`，名字表**有意**保留三份）、(7) font 串（`render/measure/text-metrics.cssFontOf`）、(8) 祖先标题链（`model/tree.ancestorTitlesOf/titlePathOf`）、(13) `subtreeContains`（`isSelfOrDescendant`）、(16) 大纲方言（`shared/outline-dialect.ts`）、(17) 语言清单（`shared/code-language.ts`）、(18) 引号扫描（`code/lexer.scanQuoted`）。<br>**实测剩余 10 组**（编号与实测位置见 `shared-audit.md` §5）：(2) `normalizeDocPath` vs `documentKeyOf`、(3) `extensionOf` ×2、(4) `bracePath` ×2（同名不同义）、(5) 概览/边界标题默认样式 ×3、(6) 标签行排版常量 ×2、(10) 混合组、(11) DOCUMENT_EXTENSIONS 三份、(12) resources 前缀三份、(14) 工具参数 JSON 解析 ×2、(15) 两种节点计数。<br>**建议顺序（按风险低→高、收益高→低）**：(5) → (6) → (14) → (11) → (3)(12) 小原语 → (1) 尾巴（实体引用正则）→ `refactor-audit.md` §2.4 的两条脚本侧（CRC32+PNG、esbuild runner）。<br>⚠️ **建议不做**（实测「只是长得像」或有意外部契约，理由与证据另记）：(2)（快照键格式是持久化面）、(4)（同名不同义，且无文件同时 import 两者）、(15)（统计口径不同，`known-issues.md` 已写明别合并）、(10) 的「颜色校验 / 文件名清理 / activeSheet 空工作簿契约」三个子项、(16) 残留的编号剥离正则 |

### Step F · `styles.css` 拆分（1 项）

| # | 现状 | 目标 | 手法 | 调用点改动 | 风险 | 状态 |
|---|---|---|---|---|---|---|
| F1 | `renderer/styles.css` 3649 | `styles/*.css` 12 个（按现有区块） | `main.tsx` 按**原顺序** import（层叠顺序是行为的一部分） | 1 | 顺序一变就会静默改样式；拆完要逐屏比对关键界面（列表/画布/面板/对话框） | ✅ cca2c5b |

### Step G · 收尾（2 项）

| # | 内容 | 状态 |
|---|---|---|
| G1 | `shared/import/markdown.ts` 764 → `import/markdown/` 2 个（共享层最后一处 700+ 文件；可行则做，不划算就记录理由） | ✅ **`56e477d` 已完成**（入口 807 → 307 + `import/markdown/inline.ts`；配方照做即成功）。以下保留当时的失败记录：⛔ 两次尝试失败已回退（第 1 次自创"类型回捞"、第 2 次区间边界切在注释中间）。**配方（下次照做）**：类型随函数一起搬 + 入口 `export *` 保公开面 + 边界用"顶层声明边界"算法（含 doc 注释），不要手挑行号 |
| G2 | 文档收口：`refactor-audit.md` 的执行顺序打勾、`CHANGELOG.md` 记录、`known-issues.md` 状态同步 | ✅ `8527fa3`（CHANGELOG「解耦 · 单文件拆分」小节 + known-issues「仍未做」「经核对不成立」两表 + `refactor-audit.md` §四 执行顺序打勾） |

---

## 四、完成定义（DoD）

一项任务算完成，必须同时满足：

1. 目标文件已降到约定规模（入口文件建议 ≤ 250 行，子模块 ≤ 400 行）；
2. 导出名集合 diff 无丢失（或"丢失项已确认零引用"）；
3. 调用点改动 ≤ 2 行**且已列出**；
4. 五道门槛全绿（各自退出码单独打印过）；
5. **行为零变化**：提交信息里写明"未做行为改动"，或注明"行为改动另见提交 X"；
6. 单项提交，可 `git revert <sha>` 独立回滚。

---

## 五、明确不做的事

- **不批量剪除"死导出"**：已复核，清单条目是多余 `export` / barrel 冗余再导出，类型再导出构建时被抹掉、零运行时收益；且清单可靠性已被证伪多次（`runsToHtml` 实际被自检断言使用）。理由见 `known-issues.md`。
- **不为让 lint 变绿去改高频路径的 ref 用法**（`refs`/`immutability`/`purity` 三条已实测留档）。
- **不在拆分批次里顺手改行为**（这是本轮反复强调的纪律）。
- **不动已冻结的公开契约**：IPC 通道名、`.xmind`/`.emmx` 写出的字段、`selfcheck` 入口路径。

---

## 六、风险与预案

| 风险 | 预案 |
|---|---|
| 拆 `ChatPanel` 的 ref 环被拆散 | 一组相互引用的 ref 当作**一个整体**搬进同一个模块，禁止跨文件拆 |
| 拆 `Canvas` 时视口/跟随逻辑顺序变化 | 先抽纯函数（无副作用）→ 再抽 hooks（保留 effect 声明顺序与依赖数组）→ 最后拆组件 |
| 拆 `store/editor` 切片导致状态归属混乱 | 纯函数先下沉（有 selfcheck 断言保护），切片最后做；跨域状态先画归属表 |
| 拆 `main/index` 后共享状态被复制成多份 | 一律经 `ctx` 传参，禁止新的模块级可变单例（`viewportActions` 那种单例已在渲染层有卸载复位的约定） |
| `selfcheck` 分域后局部 helper 作用域断裂 | 先落 harness，再搬；每个域搬完立刻跑一次 selfcheck（它是自己的回归测试） |
| `styles.css` 顺序变化悄悄改样式 | `main.tsx` 按原顺序 import；拆完逐屏比对 |
| 门槛红了 | **先 `git checkout` 该文件回退**，不要在红的基础上继续搬；确认是"搬错"还是"本来就红"再动手 |

---

## 六点五、已完成的拆分轨迹（截至 2026-09-19）

| 目标 | 结果 |
|---|---|
| `render/measure.ts` 724 | → **493** + `measure/{text-metrics,wrap,segments,style}.ts`（调用点 0 行） |
| `export/drawing.ts` 771 | → **162** + `export/{ops,node}.ts`（类型经 `export *` 兜住，调用点 0 行） |
| `components/TopicNode.tsx` 619 | → **542** + `topic/{props,segment-style}.ts`（纯搬动部分；抽子组件留作 A3-2） |
| `styles.css` 3650 | → `styles/*.css` **21 个** + `index.css`（按原顺序 @import；`main.tsx` 1 行改动） |
| `scripts/selfcheck.ts` 11,844 | → **473**（−96%）：`harness.ts` 76 + `helpers.ts` 853 + `domains/{edit,canvas,layout,ai,agent,io,ui,xmind}.ts` 共 8 个；入口只剩 import 表 + `main()` 调用顺序。**入口契约不变**（`run-selfcheck.mjs` 未动，断言仍 2628 项） |

**手法（可复用）**：按行范围字节级搬迁脚本 + 把 `typecheck`/`lint` 当簿记检查器；块起止按"顶层声明边界"机械计算（不手写行号）；每批固定收尾 = `eslint --fix` 清导入 → 去掉它给入口补的 `.ts` 后缀 → prettier；带删除的脚本必须有前置守卫（名字不能少、搬走行数 == 删除行数）。

## 七、执行记录

| 日期 | 批次 | 提交 | 结论 |
|---|---|---|---|
| 2026-09-19 | 本计划制定 | — | 现状实测 144 文件 / 56,681 行；`shared` 层 6 次拆分已完成，剩余 13 个 600+ 行文件全在 renderer/main/scripts |
| 2026-09-19 | A1 / A2 / A3-1 / D1(10 批) / E1(1 组) / F1 / G1 / G2 | `9b5f077` `8fdc8d6` `64ed49e` `a40bce9`–`dcacfb4` `0054b68` `cca2c5b` `56e477d` `8527fa3` | 补记（原表停留在计划制定时）。各批五道门槛逐条打印退出码全绿；契约不变：selfcheck 入口仍是 `scripts/selfcheck.ts`、`run-selfcheck.mjs` 未动、断言 2628 项、70 条 IPC 通道与 `.xmind`/`.emmx` 字段未动 |
| 2026-09-19 | 状态列同步（本次） | — | 修正 G1（⛔→已完成 `56e477d`）、G2（⬜→✅ `8527fa3`）、A3（✅→🟡，仅 A3-1）三处滞后状态；现状规模与剩余文件行数按实测更新；`refactor-audit.md` §四 第 3–8 步补勾 |
| 2026-09-19 | C1（8 批） | `a8aebe6` `cdf8cff` `b2b0647` `e3aaf3c` `a7af884` `230d4c9` `7d7cbe8` `3a61e69` | `main/index.ts` 2498 → 65 行，14 个 IPC 域拆进 `main/ipc/*`。每批五道门槛逐条打印退出码全绿；结构守卫「`ipcMain.handle\|on(` 注册总数 = 66」全程不变；契约未动（通道名 / `.xmind`·`.emmx` 字段 / `@import` 顺序 / `selfcheck` 入口） |
| 2026-09-19 | C1 状态列同步（本次） | — | C1 行两处打勾 + `refactor-audit.md` §四 第 5 步打勾；未完成文件表仍待更新（下次统一做） |
| 2026-09-19 | A3-2（2 批） | `0bb4812` `3fe548d` | TopicNode 抽子组件：第一批 4 个纯展示块（标记条 / 附件指示器 / 文本行+行内公式 / 标签行），第二批 4 个交互块（图片 / 公式 / 代码块 / 拉伸手柄）。手法＝整块搬 JSX + 外面包 Fragment + **props 原样传**（块体零改动）；两批五道门槛逐条打印退出码全绿；入口 619 → 334 行。折叠徽标与外壳仍未抽 |
| 2026-09-19 | A3-2 第三批（收官） | `329546a` | 折叠徽标（双向展开两根 + 单徽标）抽进 `topic/collapse-badges.tsx`，入口 334 → **305** 行；A3 行改 ✅ 并写明"外壳刻意不抽"的理由。工具：`.tmp-check/extract-jsx.mjs`（脚本化 JSX 抽取 + 括号/注释配平与"注释数量不变量"守卫） |
| 2026-09-19 | A4 | `8441f54` | `NodePanel.tsx` 814 → **133**，`nodePanel/` 7 个文件。五道门槛逐条打印退出码全绿（selfcheck 2628 项、verify 21+4 样本）；调用点 0 行；结构守卫＝行多重集对比（旧独有行全部可解释）。**方法学新增两条**：①「面板级 `useState` 不下沉」——挂载点会变的分支组件不许接管草稿 state（不靠推理证明等价，直接按 state 位置取胜）；②段落组件拆分判据＝「这一段碰不碰草稿」，不碰的连同它的处理器与 store 订阅整段搬走 |
| 2026-09-19 | A5 | `c11e365` | `Toolbar.tsx` 1059 → **310**，`toolbar/` 11 个文件。五道门槛逐条打印退出码全绿；调用点 0 行。**方法学新增一条**：工具组的拆分单位是「整组」而不是「整块 JSX」——禁用条件、按下态、防 selector 新对象的 `useMemo`、禁用原因提示都必须与该组的按钮同处一个渲染路径，一起搬才不会散；**顺手记一条守卫假阳性**：`{/* … */}` 形式的 JSX 注释被改写成 `//`（位置同在 `return` 括号内，行为不变）时，行多重集守卫会把它报成"丢失行"——守卫输出要逐条看解释，不能只看数量 |
| 2026-09-19 | A6-1 / A6-2 | `fa7d843` `a5bc249` | `ChatPanel.tsx` 1953 → **386**（A6-1 抽纯函数 + 10 个展示组件；A6-2 把 runtime 整块搬进 `chat/use-chat-loop.ts` 1155 行）。五道门槛逐条打印退出码全绿；调用点 0 行。**方法学新增两条**：①「整块搬迁 + 行多重集守卫」在 1000 行级 runtime 上也成立——守卫证明旧文件独有的行与 A6-1 同源（没有一行 runtime 丢失）；②**函数身份是行为的一部分**：`handleEvent` / `runRound` / 订阅 effect 三者的依赖数组必须原样保留（订阅 effect 一旦因渲染重跑，cleanup 里的 `stopRef.current()` + `commitTurnRef.current()` 会掐掉正在跑的回合）；唯一补进去的 `setAtBottom`/`setDraft` 是稳定 setter，不改变 `send` 的身份变化时机 |
| 2026-09-19 | A8-1 / A8-2 | `9acca77` `fad4f30` | `Canvas.tsx` 2951 → **2446**。A8-1 把落点几何整块搬进 `canvas/geometry.ts`（388，纯函数收显式入参）+ `canvas/clip-text.ts`（19）+ `canvas/use-canvas-geometry.ts`（143，薄绑定层）；A8-2 把「闪一下」搬进 `use-flash-nodes.ts`（41）、视口动作与它的两个 effect 搬进 `use-canvas-viewport.ts`（197）。五道门槛逐条打印退出码全绿；调用点 0 行（只有 1 处解构 + 导入增删）。**方法学新增**：①「薄绑定 hook」＝去 ref 化的正确姿势（纯函数收显式入参、hook 在调用那一刻读 ref）；②依赖数组统一收成 `[dropIndex]` 的**等价性要逐条论证**（被依赖回调的身份只在 `dropIndex` 变时才变）；③lint 会把参数进来的 `RefObject` 当非稳定值，列进依赖数组不改变重跑时机（A7 的做法）；④`viewGestureAtRef` 的**声明位置上移**是安全的（`useRef` 没有顺序语义，只有 effect 有） |
| 2026-09-19 | A8-3 / A8-4 | `e69e4b0` `1597796` | `Canvas.tsx` 2446 → **1721**。A8-3：视角锁定跟随整块（含 focus 一族派生值与两条 effect）→ `use-view-follow.ts`（251）、折叠锚点 `useLayoutEffect` 连两个 ref → `use-fold-anchor.ts`（57）、滚轮 → `use-wheel-pan-zoom.ts`（85）、`warnViewLock` → `view-lock-warn.ts`（18）；A8-4：拖动节点整件事（5 个落点 state + 7 个 ref + `dragAutoScroll` + 390 行 `handleNodePointerDown`）→ `use-node-drag.ts`（608）。五道门槛逐条打印退出码全绿（selfcheck 2628 项、verify 21+4 样本）；调用点 0 行。**方法学新增三条**：①**区间依赖分析脚本化**（`.tmp-check/region-deps.mjs`：算出「要传进来的画布作用域名字」与「要返回的名字」，别靠印象）；②**多段搬迁要防「吃掉区间后的空行时误吞下一段的注释开头 `/**`」**（注释标记配平守卫当场抓出，A8-4 真踩到）；③**「留在画布还是搬进 hook」由 TDZ 决定**：`dragVisual` / `nodePointerHeldRef` 被更靠上的 follow hook 读、而拖拽 hook 必须排在几何 hook 之后 → 这两个只能留画布、以参数进 hook。**拖动 effect 序列逐条核对**（画布自己的 11 条 effect 相对顺序与搬迁前一一对应） |
| 2026-09-19 | A6-3 / A8-5 并行 | 见下批提交号 | 两个独立子任务（`chat/use-chat-loop.ts` 的域函数收 deps 对象、`Canvas.tsx` 的手势族整块搬）同时开工，互不重叠改动路径。 |
| 2026-09-19 | A7-1 / A7-2 | `394e1f1` `f55a2af` | `App.tsx` 1272 → **443**，`app/` 8 个 hook（副作用的 hook 调用点落在原 effect 位置）。五道门槛逐条打印退出码全绿；调用点 0 行。**方法学新增三条**：①**只有 effect 有顺序语义，回调没有**——所以「文件操作回调组」可以整组搬进 hook 而不影响 effect 顺序，这让「哪些能拆」的判断第一次有了硬判据；②**守卫要写成「首行 + 末行序列」**：A7-2 第一次提交区间末行取错（停在 `)` 而不是 `}, [deps])`），守卫直接拦下、未产出半成品；③**「从入口现有导入推导 hook 的导入」是不成立的**——入口的导入块会被 eslint 裁剪，推不出 hook 需要的名字（`viewportActions`/`beginCost`/`stageTypedChar`），还会把入口对 hook 自身的导入复制进 hook；正确姿势是按**门槛报告的名字**逐条补（`.tmp-check/fix-app-hook-imports2.mjs`） |
| 2026-09-19 | **并行四批**：A6-3 / A7-3 / B1 第一步 / E1×(6)(14)(11) | `57b044e` `0115b5d`（A6-3 记录提交）`c9a1961`（A7-3）`57b044e`（B1）`51f0018` `449b279` `80b6049`（E1） | 见 §八 各行的实测口径。**本轮采用「四个子任务并行改互不重叠的路径」**，每个子任务自带「五道门槛逐条打印退出码 + 行多重集守卫 + 提交信息写清未做行为改动」的要求；主 agent 在最终树（HEAD）上**亲手复跑五道门槛全绿**（typecheck 0 / lint 0 / format:check 0 / selfcheck 0 2628 项 / verify 0），并**独立复跑 A7-3 的守卫**（旧独有 4 行，与其上报一致）。<br>⚠️ **并发事故（已核实、无内容丢失）**：B1 与 A6-3 的 `git add` 落进**同一个 index**（仓库无 hook、无 `commit.all`），于是 `57b044e` 里混进了 A6-3 的两个 chat 文件——`git diff HEAD -- chat/` 为空、`git hash-object` 三处一致，**一行没丢**，但 A6-3 的改动没有自己的提交信息。A6-3 补了一个 `--allow-empty --only -- <自己的两个路径>` 的**记录提交** `0115b5d`（tree diff 为空、消息写明代码实体在 `57b044e`）。**决定：不做历史重写**（其上已压了 4 个别人的提交，rebase/amend 会动到它们，且会让这些提交的门槛结论与实测字节脱钩）；归因问题在此如实登记。<br>**方法学新增**：①多 agent 并行时 `git add` 不是互斥的——**同一 index 的窗口期会让提交互相吞并**，要么让每个 agent 用独立 clone/worktree，要么接受"合并提交 + 记录提交"；②别人在飞的半成品让全仓门槛变红时**不要去修**（那不是你的改动），等它落盘再跑；③只给自己文件跑 prettier（`npm run format` 是全仓 `--write`） |
| 2026-09-19 | A8-5 + 交接文档第四版 | `2444758`（A8-5）｜`35d1e52`（文档） | A8-5：画布交互手势四段 → `canvas/use-relationship-drag.ts`(180) / `use-title-edit.ts`(73) / `use-marquee-select.ts`(184)，Canvas **1721 → 1480**；五道门槛在 HEAD 上由主 agent 复跑全绿；行多重集守卫**旧文件独有只剩 2 行**（`[]` 与 `[setPan]`——两处依赖数组补了恒定身份项）。**这一批前两次尝试整体回退**（TDZ：`setMarquee` used before declaration、`use-marquee-select.ts` 里重复标识符、`titleEditRef.current = titleEdit` 处类型被推成 `any`、解构了画布不再用的 `setHandleDrag`），第四次按「最独立 → 最耦合」拆成三段才过——**方法学**：搬 state 进 hook 时，**hook 调用点必须排在它所有消费者（JSX / memo / 其它 handler）之前**，且 hook 内部要用的局部值必须已声明。<br>`docs/handover.md` 第四版：自包含交接（零、开工前先确认工作树状态含"又脏了怎么办"的处置流程与踩坑清单；一、可整段粘贴的提示词；二、现态含 12 个提交与全部行数；三、剩余配方；四、方法学＋坑表＋审计纠偏；五、待用户人眼验收清单；六、文档索引） |
| 2026-09-19 | **A8-6 / A8-7 / A8-8 / A8-9（A8 收尾四批）** | `25d00ff` `76c6eb4` `b30c78d` `7e39e42` | `Canvas.tsx` **1480 → 385**（−1095）。A8-6：展示层派生值（4 段 294 行）→ `canvas/use-canvas-display.ts`(395)；A8-7：四个 JSX 层（5 段 621 行）→ `canvas-edges-layer.tsx`(317) / `canvas-overlay-layer.tsx`(338) / `canvas-nodes-layer.tsx`(123) / `canvas-relationship-hit-layer.tsx`(49)；A8-8：节点回调一族(66) → `canvas/use-node-callbacks.ts`(130)、标题编辑框(51) → `canvas-title-editor.tsx`(81)、底部提示层(36) → `canvas-hints.tsx`(68)；A8-9：布局与测量(134) → `canvas/use-canvas-layout.ts`(186)。每批五道门槛逐条打印退出码全绿（selfcheck 2628 项、verify 21+4 样本）；调用点＝按名字解构 + 组件调用，**JSX 块体零改动**。<br>**方法学新增四条**：①**JSX 整层抽组件的配方在画布上也成立**（外面包 Fragment 不产生 DOM 节点、props 原样传、不加 `memo`、10 个节点回调按名字直接传 → `TopicNode` 的浅比较面一点没变）；②**子组件的 prop 名必须与父作用域名同名**（A8-7 第一次把 10 个回调改名成 `onPointerDown` 导致块体 10 处 TS2304，回退重做——改了名就等于改了块体）；③**搬 state/effect 进 hook 时，"调用点钉在原位置"仍是硬约束**（A8-9 的三条 effect 次序用脚本把两边正文首行序列打出来对照）；④**lint 对"从参数进来的 `RefObject`"一律要求列进依赖数组**（A8-8 两处、A8-9 一处 `[] → [containerRef, …]`，身份恒定所以重建时机不变）。<br>**门槛执行备注（本轮实测，重要）**：审批策略变为 never、**无法提权**，而 `npm run selfcheck` 的 esbuild JS API 会 spawn 服务进程（管道 stdio）→ 受限沙箱下必然 EPERM（`ensureServiceIsRunning`）。**等价的免提权跑法**：用 esbuild CLI 打包再跑 node（同 2628 项断言、exit 0）——`node_modules\@esbuild\win32-x64\esbuild.exe scripts\selfcheck.ts --bundle --platform=node --format=cjs --target=node20 --sourcemap=inline --log-level=warning --tsconfig=tsconfig.json "--alias:@shared=./src/shared" "--alias:@=./src/renderer/src" --outfile=.tmp-check\selfcheck-cli.cjs`，然后 `node .tmp-check\selfcheck-cli.cjs`（两者都要**文件重定向** `*> 日志`，不能用管道）。<br>**同样受沙箱影响的另一处**：node 里 `execFileSync('git', …)` 打包脚本也会 EPERM → 行多重集守卫改成"旧快照由 PowerShell 落成 UTF-8 文件、脚本只读文件"（`.tmp-check/msguard2.mjs <旧快照> <新文件列表>`，通用版，后续批次可直接复用；注意 PowerShell 重定向会写 UTF-16，要用 `[System.IO.File]::WriteAllText` + `[Console]::OutputEncoding = UTF8` 才不会乱码） |

| 2026-09-19 | **并行收尾（AgentTeams 4 人：eng-b1 / eng-e1 / eng-scripts / eng-app）** | `9fd3627`+`3641c5e`（脚本侧 1）｜`4d21d08`（E1-(5)）｜`5a6830b`（E1-(3)）｜`022b0bd`（E1-(12)）｜`105a732`（E1-(11) 尾巴）｜`e347937`（B1 第二步 A-1） | **用户要求"把剩下的任务全部完成"**，于是把 §八 剩余项按「同文件串行、不同文件并行」拆给 4 名成员，captain（主 agent）只做**独立验收 + 文档同步**，且**在成员跑门槛期间不改源码**（避免把别人的门槛搅红）。<br>**已落盘并逐条独立验收**：①**脚本侧 (1)** `9fd3627`：CRC32+PNG chunk 装订 → `scripts/lib/png.mjs`（74 行），两处调用点净 −69 行；captain 独立复跑 `icon`/`samples`/`marker-art` 后比对 **35 个产物 sha256 全部一致**（0 不一致）；成员另用"不带查表、逐位重算的 CRC32"拆 chunk 复核 9 个 PNG / 27 chunk 全对；`3641c5e` 是补记的空记录提交（`--numstat` 0 行，未吞并他人改动——当时 HEAD 已压了别人的提交，故按纪律**不重写历史**）。②**E1-(5)** `4d21d08`：概览/边界/关系线标题默认样式 → `shared/model/overlay-style.ts` 的 `OVERLAY_TITLE_DEFAULTS`；captain 验收口径＝**数值逐字可映射**（summary 13/boundary 12/relationship 12，被删的字面量恰好是这三组；`metrics.ts` 的三个常量改为由表派生、导出名保留→调用点 0 行）。③**E1-(3)** `5a6830b`：`document/index.ts` 的私有 `extensionOf` 去掉、改用 `model/resources.ts` 的导出实现（1+/6− 正确，`resources.ts` 本就存在，见 `cccb72e`）。④**E1-(12)** `022b0bd`：包内资源前缀三处 → `RESOURCES_DIR`，captain 核过**三处值都没变**（`'resources/'`、`'attachments/'` → `LEGACY_ATTACHMENTS_DIR`）。⑤**E1-(11) 尾巴** `105a732`：撞名消除（`MINDMAP_SUFFIXES` 由 `MINDMAP_EXTENSIONS` 派生；`main/document.ts` 改名 `IMPORT_DOCUMENT_EXTENSIONS`、数组字面量逐字未动）。⑥**B1 第二步 A-1** `e347937`：`select` 的 reducer / 键盘落点计算 → `shared/model/editor-ops.ts`（`selectReducer` / `resolveKeyMove` / `navigateTargetOf`）；captain 逐行核过**最易失守的语义细节**——"`additive` 且命中的那一支**不带** `selectedOverlay`（`set()` 合并时不动它）"被逐字保留。<br>**captain 的树级独立门槛**（在含成员在飞编辑的树上亲跑）：`lint` 0 ｜ `format:check` 0 ｜ `selfcheck` 0（2628 断言）｜ `verify` 0；`typecheck` 当时红 4 条经逐条归因确认全是在飞编辑中间态。**六条提交累计未触碰任何冻结面**（IPC 注册 / `.xmind` 字段 / `@import`）。<br>**方法学新增**：①派活前**自己先 grep** 再写任务单（我凭印象写的"make-marker-art 里也有 PNG 代码"被成员实测证伪）；②成员做的"改字符串/清单"类收敛，验收标准是**逐处把旧值和新值列出来比对**，不是"门槛绿了就算"；③**应用层值得单独立项**：`make-marker-art.mjs` 用 `prettier.format(text,{filepath})` 而 Prettier 3 编程式调用不回读 `.prettierrc` → 生成产物是"双引号+分号"、与仓库风格相反，而该文件在 `format:check` 覆盖范围内（已派任务修，验收＝跑完生成器工作树干净 + `format:check` 仍 0） |

## 八、仍未做（明确记录，不是遗漏）

> **本轮并行收尾的进行时（2026-09-19 晚，随时可能已变）**：4 名成员仍在跑——`eng-b1`＝B1 第二步 A 的后续子批次与 `store/slices` 切片（`editor.ts` 2181 → **2112** 进行中）；`eng-e1`＝E1 (2)(4)(10)(15) 的核实结论 + A6-4（chat runtime 再拆）；`eng-scripts`＝E1-(11) 尾巴已交、正在做 `make-marker-art` 的 prettier 修复；`eng-app`＝A7-3 残留（`App.tsx` 366 → **249**，四个新文件 `app-dialogs.tsx` / `app-side-panels.tsx` / `use-external-file.ts` / `use-toolbar-actions.ts`）已完成搬迁、正在跑门槛。<br>**captain 已预核** t8 的两条红线：`onToggleHidden` 仍是普通箭头函数（**未**包 `useCallback`，保持每渲染新身份）、`UnsavedDialog` 的关窗回路三处逻辑逐字保留（`closeCancel()` 回执 / `discard→run` / `saveDocument(false).then(ok => run)`）。<br>**环境备注**：审批策略为 never（不可提权），`npm run selfcheck` 的 esbuild JS API 必然 EPERM，全员改用 esbuild CLI + 文件重定向的等价跑法（2628 断言）。

| 项 | 为什么没做 / 怎么做 |
|---|---|
| **A6-3 runtime 模块再拆** | ✅ **已完成**（代码实体在 `57b044e`，记录提交 `0115b5d`）：`chat/turn-runtime.ts` **636 行**新建（`createTurnRuntime(deps)` 工厂，**22 个显式 deps 字段**——不是 19 个：`region-deps.mjs` 只认 2 空格缩进的声明，看不见 `useChatLoop({...}: LoopInput)` 的解构入参，漏了 `onBeforeAiWrite`/`refreshLicense`/`docsRef`，A6-3 补了 `a6-3-freescan.mjs` 复算）；`use-chat-loop.ts` **1274 → 799 行**。搬走 5 段 505 行（H0 分节标题 3 + R1 31 + R2 170 + R3 107 + R4 194，逐字拷贝）。**红线守住了**：`update` / `dumpDiag` 仍是 hook 里的 `useCallback`，`handleEvent` 依赖数组 `[update, dumpDiag]`、订阅 effect 依赖数组 `[handleEvent]` 与搬迁前**逐字相同** → 身份变化时机不变、订阅 effect 不会被重跑。**一处如实交代的偏离**：搬迁后 `exhaustive-deps` 多 2 条 warning，**没有按建议补依赖**（`setPending` 每渲染重建，补进 effect 会让它每渲染重跑＝掐掉正在跑的回合；补进 `send` 会让 `send` 每渲染换身份），改为两处 `eslint-disable-next-line` + 理由注释（仓库已有 2 处同类 disable，其一就在同族 `resolvePending` 上）——这与计划表 §五「不为让 lint 变绿去改高频路径的 ref 用法」一致。<br>⚠️ **残留**：hook 仍 799 行、新模块 636 行 > DoD 400。**A6-4 配方**：`handleEvent`/`resolvePending`/`send`/`runRound`/`stop`/`clearChat`/`update`/`dumpDiag` **不能搬**（前者带 `useCallback([update, dumpDiag])` 且被订阅 effect 依赖；`resolvePending` 是 `useCallback([])` 带 disable 且要读 `pendingRef`/`patchAppSettings`；`send` 要读大量视图侧入参），但可以把「写意图执行（`applyWriteIntent`+`noteAction`）」与「队列推进（`processQueue`）」再分两个模块——它们之间只通过显式 deps 与返回值耦合、已无 ref 环。另一个正解：把 `setPending` 留在 hook、以 deps 传进工厂（它保持函数字面量，lint 重新认可稳定性），代价是 12 行不搬 |
| **A7-3 入口再降** | ✅ **已完成**（`c9a1961`）：`App.tsx` **466 → 366 行**，`app/use-window-close.ts` **168 行**新建。搬走 5 段 116 行：`pending` state(8) / `closeApp`(21) / `closeTabById`(24) / `guard`(14) / 横幅+`forceCloseIds`+`closeWindowFlow`+`onCloseRequest` effect(49)；入参 `{ commitPending, recoveryPendingRef }`，返回 `{ pending, setPending, closeTabById, guard }` → **JSX 里的名字原样，调用点 0 行**（JSX 段 170 行逐字一致，脚本核过）。**effect 顺序用脚本核过**（`a7-3-effect-order.mjs`）：搬迁前后**都是 12 条**、顺序与正文指纹逐条一致（第 5 条就是 `onCloseRequest`，从 App 内联挪到 hook 内仍处同一位置）；hook 调用点刻意落在**原 effect 的位置**（App L165，紧跟 `openFilePending`、在 `useAutosave` 之前），**没有**挪到 `pending` 原来的第 2 个 hook 位置（那样 effect 会跑到最前面）。唯一依赖改动：`closeApp` 的 `[]` → `[recoveryPendingRef]`（恒定身份，重建时机不变）。守卫旧独有 **4 行**，全部是本次改写白名单项。<br>⚠️ **残留**：App 仍 366 行 > 250（剩下是顶部 state/订阅 + Toolbar actions + 各面板弹窗装配，属另一批）；`pending` 的 `useState` 槽位在 hook 顺序里后移（同一版本内稳定）。**待用户人肉验收 12 条**（关窗链路不渲染就无法自证）：取消后回执主进程并能再次询问、单标签保存/不保存、多标签逐个询问、`forceCloseIds` 不重复询问、保存失败不关窗、启动即关窗不清自动存档、崩溃恢复弹窗、关单个标签且释放文档资源、历史快照恢复前确认、菜单/快捷键关窗入口、拖文件与双击 .xmind、关窗后自动存档与版本快照 |
| **A8 `Canvas.tsx` 2951** | ✅ **主体已完成（9 批，入口 2951 → 385）**：A8-6 / A8-7 / A8-8 / A8-9 见 §七 末行与任务表 A8 行（展示层派生值 → `canvas/use-canvas-display`(395)；四个 JSX 层 → `canvas-edges-layer`(317) / `canvas-overlay-layer`(338) / `canvas-nodes-layer`(123) / `canvas-relationship-hit-layer`(49)；节点回调一族 → `use-node-callbacks`(130)、标题编辑框 → `canvas-title-editor`(81)、底部提示层 → `canvas-hints`(68)；布局与测量 → `use-canvas-layout`(186)）。**残留**：入口 **385 行 > DoD 250**，剩下的是「顶部 state / 选择器 / ref + 十二处 hook 装配」＝**组合根**；再往下压只剩两种做法——①把这十二处装配整体收进一个组合 hook（把"谁在什么顺序被装配"藏一层）、②把 `dragVisual` 与各 ref 也下沉（会动到"指针跟手"的前提）。两者都超出「只搬代码」的配方范围，按 §四 的口径如实记为**入口刻意保留的装配代码**（不是遗漏）。<br>⚠️ **以下原文是 A8 第 5 批当时的记录**（其中"剩余配方"的三条已被 A8-6～A8-9 做完，保留作为过程档案）：**进行中（5 批已提交，入口 2951 → 1480）**。已搬走：落点几何与常量（A8-1 `9acca77`）、闪一下 + 视口动作（A8-2 `fad4f30`）、视角锁定跟随 + 折叠锚点 + 滚轮（A8-3 `e69e4b0`）、拖动节点整件事（A8-4 `1597796`，含 390 行的 `handleNodePointerDown`）、画布交互手势四段（A8-5 `2444758`：`handleRelationshipPointerDown` / `commitTitleEdit` + `titleEditRef` / `pickOverlay` / `handleCurvePointerDown` / `handleBackgroundPointerDown` + `marquee` state → `canvas/use-relationship-drag.ts` 180 / `use-title-edit.ts` 73 / `use-marquee-select.ts` 184；五道门槛全 0，守卫旧独有只剩 2 行＝两处依赖数组补了恒定身份项）。**方法学（本轮新增，可复用）**：①**「薄绑定 hook」是去 ref 化的正确姿势**——纯函数收显式入参（`lay` / `rootTopic` / `dropIndex`），由 hook 在**调用那一刻**读 ref 传进去，读到的值与搬迁前同源；②**依赖数组统一收成 `[dropIndex]` 是等价的**（被依赖的回调身份只在 `dropIndex` 变化时才变），但**必须逐条论证**；③**lint 会把「从参数进来的 `RefObject`」当非稳定值**，要求列进依赖数组——列进去不改变重建时机（恒定身份），这是 A7 那轮留下的做法；④**区间依赖分析脚本化**（`.tmp-check/region-deps.mjs`）：算「用到但声明在区间外的画布作用域名字」＝ hook 参数，「区间内声明、区间外也在用」＝ hook 返回值，别靠印象；⑤**多段搬迁要防「吞掉下一段的注释开头」**（A8-4 真踩到：吃掉区间后的空行时误吞了 `/**`，注释标记配平守卫当场抓出）；⑥**A8-5 实测到的 TDZ 判据**：把某个 state 搬进 hook 后，**hook 调用点必须排在它所有消费者（JSX / memo / 其它 handler）之前**，且 hook 内部要用的画布局部值必须已声明——A8-5 前两次尝试就是在这里红的（`setMarquee` used before declaration / `setHandleTrigger` 之类重复标识符 / `titleEditRef` 赋值处类型被推成 `any`），按 §六 的纪律整块回退重做、未产出半成品。<br>**剩余配方（还差约 1230 行）**：①**展示层 memos 先做**（风险最低）：`dropPreview`（120 行）、`sideFlipPreview`、`groupBadge`、`dragFocus`、`visibleEdges` / `staticEdges` / `dragEdges` / `marqueeHits` / `searchHits` / `filterResult` / `visibleNodes`——纯计算、无 effect、无顺序语义，可整块搬进一个 `canvas/use-canvas-display.ts`（**TDZ 约束**：它们读 `layout` / `dragVisual` / `dropIndex`，hook 调用点必须排在 `useCanvasGeometry(...)` 与 `useNodeDrag(...)` **之后**）；②**JSX 装配与覆盖层组件**（唯一能把入口压到 250 的最后一公里，风险最高，建议**先抽"层"**：静态连线层 / 拖拽层 / 覆盖层 / 提示层，再抽单个覆盖层；抽完核对 `React.memo` 的浅比较面没变）；③零散 handler 与派生值（`pickOverlay`、节点回调一族、`renderEdge`）可并入前两块一起搬。<br>**交接文档见 `docs/handover.md`（第四版，自包含）。** |
| **B1 `store/editor.ts` 2316** | 🟡 **第一步已完成**（`57b044e`）：11 个纯函数 + 1 个分节标题（12 段 139 行）下沉到 `shared/model/editor-pure.ts`（**175 行**），`editor.ts` **2316 → 2181 行**。**实测口径**（比计划表的「99 行」更准）：真正逐字可搬的只有这 11 个函数；`useEditor` 那 1615 行（120 个成员，占全文件 70%）**没有一个现成可搬**（全部闭包捕获 `set`/`get`）。**必须记住的一步**：9 个函数原来**文件私有**，换文件后不带 `export` 就 import 不到（第一次 typecheck 9 条 TS2459 + 6 条 TS6133）→ 给 9 个声明行加 `export` 是**可见性**变化，函数体/签名/调用点全没动。公开面靠 `editor.ts` 再导出兜住（`export { overlayToggleOf, themeColorsOf } from '@shared/model/editor-pure'`）→ 4 个外部文件 0 改动、内部 22 处调用 0 改动。**顺带修正一处旧文档偏差**：`sameRich` 上方第 545 行那句「备注 HTML 的转义统一走共享实现」讲的其实是 `notesHtmlFrom`、与 `sameRich` 无关（按配方一起搬了，**未顺手改**，建议后续单独挪回）。<br>**剩余**：①「内联纯逻辑」约 188 行可抽（`setImage` 尺寸归一 7 / `setSizeOverride` 钳制 36 / `moveSelectionByKey` 31 / `navigateSelection` 26 / `sortChildren` 17 / `deleteSelection` 落点 16 / `mergeTopics` 字段并入 14 / 画布级元素查重 20 …）；②切片（`store/slices/` 6 个）最后做。**切片归属表（实测得出）**：`aiTurn` 必须与 `undoStack`/`redoStack`/`mutate` 同切片（`beginAiTurn` 用 `undoStack.length` 当 depth、`commitAiTurn` 用 `undoStack.slice(depth)`，且被 3 处文档生命周期写）→ 历史切片拥有它、文档切片只调用一个复位动作；`viewLock` 归视图切片（localStorage 持久化 + 被 `tabs.ts` 快照纳入 + `newDocument`/`loadDocument` 会按 `defaultViewLock` 重算）；`lastFold` 在 editor.ts 内**只写不读**、唯一消费者是 Canvas 的镜头锚点。**不要搬**：`snapshotForSave`（吃 store 的 `EditorState` 类型，改签名要动 8 处调用）、`patchAppSettings`（store+IPC）、`readPersistedViewLock`/`persistViewLock`（localStorage）、`createId`/`createTopic`（`Date.now`+`Math.random`） |
| **E1 余项（实测 10 组，不是 18 组）** | 枚举来源订正为 `docs/shared-audit.md` §5（18 组，其中 **11 组已收敛**）。判据不变：**抽原语、调用点各自表达策略**，不强行合一；每组一个提交。**本轮又收 3 组**：(6) 标签行排版常量 → `shared/layout/accessory.ts`（`51f0018`，顺带消掉 `export/node.ts` 里裸的 `fontSize: 11`）、(14) agent 工具参数 JSON 解析 → 新建 `shared/agent/args.ts` 的 `parseToolArguments`（`449b279`，原语不含文案、两个调用点各自包装，文案逐字保留）、(11) 思维导图扩展名清单 → `shared/openfile.ts` 的 `MINDMAP_EXTENSIONS` + `MINDMAP_FILE_RE`（`80b6049`，四处各写一份 → 一处；对话框另外两条子集过滤器按调用点策略保留）。**剩 7 组**：(2)(3)(4)(5)(10)(12)(15)。建议下一个做 (5) 概览/边界标题默认样式（原语放 `shared/model/overlay-style.ts`，消掉「布局按常量预留白、绘制按字面量画」的漂移；注意它要动 `Canvas.tsx`，得排在 A8 手势族之后）。另有 `refactor-audit.md` §2.4 的两条脚本侧待办（CRC32+PNG 抽 `scripts/lib/png.mjs`、三份 esbuild runner 合成一个）——后者是**五道门槛自己的执行器**，单独一个提交并改完立刻各跑一次；以及 (11) 的尾巴：`shared/openfile.ts` 的 `DOCUMENT_EXTENSIONS` 与 `main/document.ts` 的同名导出**语义完全不同只是撞名**，改名属「顺手该修」另开提交。 |