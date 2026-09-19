# 交接文档：解耦战役（给新 agent 的提示词与现态总结）

---

## 补记（第五次交接，2026-09-19 晚）—— 先读这一段

> **HEAD：`7e39e42`**（A8-9）＋ 本次文档提交。工作树干净。
> 本补记覆盖第四版之后的进展；**第四版正文（下面全部内容）仍然有效**，只有"现态数字"与"A8 剩余配方"被本补记更新。

**这一段做完的（4 个提交，全部五道门槛逐条打印退出码全绿）：**

| 批次 | 提交 | 结果 |
|---|---|---|
| A8-6 | `25d00ff` | 展示层派生值（4 段 294 行）→ `canvas/use-canvas-display.ts`(395)；`Canvas.tsx` 1480 → 1216 |
| A8-7 | `76c6eb4` | 四个 JSX 层（5 段 621 行）→ `canvas-edges-layer.tsx`(317) / `canvas-overlay-layer.tsx`(338) / `canvas-nodes-layer.tsx`(123) / `canvas-relationship-hit-layer.tsx`(49)；1216 → 644 |
| A8-8 | `b30c78d` | 节点回调一族(66) → `canvas/use-node-callbacks.ts`(130)；标题编辑框(51) → `canvas-title-editor.tsx`(81)；底部提示层(36) → `canvas-hints.tsx`(68)；644 → 514 |
| A8-9 | `7e39e42` | 布局与测量(134) → `canvas/use-canvas-layout.ts`(186)；514 → **385** |

**`Canvas.tsx` 2951 → 385（−87%）**，`canvas/` 从 13 个文件涨到 **22 个**（新增 9 个：`use-canvas-display` 395 /
`use-canvas-layout` 186 / `use-node-callbacks` 130 / `canvas-edges-layer` 317 / `canvas-overlay-layer` 338 /
`canvas-nodes-layer` 123 / `canvas-relationship-hit-layer` 49 / `canvas-title-editor` 81 / `canvas-hints` 68）。
全部子模块都在 DoD 400 行以内。

**A8 的残留（重要，不是遗漏）**：入口 385 行 > DoD 250，剩下的是**画布顶部的 state / 选择器 / ref 与十二处 hook 装配**
（`useFlashNodes` / `useCanvasLayout` / `useCanvasViewport` / `useViewFollow` / `useFoldAnchor` / `useWheelPanZoom` /
`useCanvasGeometry` / `useNodeDrag` / `useRelationshipDrag` / `useTitleEdit` / `useNodeCallbacks` / `useMarqueeSelect` /
`useCanvasDisplay` 的调用与入参表）＋ JSX 外壳。**再往下压只剩两种做法**：①把这十二处装配整体收进一个组合 hook
（把"谁在什么顺序被装配"藏一层）；②把 `dragVisual` 与各 ref 也下沉（会动到"指针跟手"的前提）。两者都超出
「只搬代码」的配方范围 → 记为**入口刻意保留的装配代码**。要接着做，请先在计划表 §八 把这条决定写清楚。

**本轮的硬经验（下一批照做能省一次事故）：**

1. **沙箱变了：审批策略是 never，不能提权。** `npm run selfcheck` 的 esbuild JS API 会 spawn 服务进程（管道 stdio）
   → 受限沙箱下**必然 EPERM**（`ensureServiceIsRunning`），不要再试提权。**等价跑法（已实测同 2628 项断言、exit 0）**：
   ```
   node_modules\@esbuild\win32-x64\esbuild.exe scripts/selfcheck.ts --bundle --platform=node --format=cjs `
     --target=node20 --sourcemap=inline --log-level=warning --tsconfig=tsconfig.json `
     "--alias:@shared=./src/shared" "--alias:@=./src/renderer/src" --outfile=.tmp-check\selfcheck-cli.cjs *> 日志
   node .tmp-check\selfcheck-cli.cjs *> 日志
   ```
   （**必须文件重定向**，管道会 EPERM。）
2. **node 里 `execFileSync('git', …)` 也 EPERM** → 行多重集守卫改成"旧快照先落成 UTF-8 文件、脚本只读文件"：
   `node .tmp-check/msguard2.mjs <旧快照.txt> <新文件1,新文件2,…>`（**通用版，可直接复用**）。落快照的正确姿势：
   `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 后用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`
   —— 直接用 `>` 重定向会写成 **UTF-16**，读出来全是 `\u0000`。
3. **抽 JSX 层时，子组件的 prop 名必须与父作用域名同名**（§四.3 第 3 条不是形式主义）：A8-7 第一次把 10 个
   节点回调改名成 `onPointerDown` 等，块体立刻 10 处 TS2304，按 §六 纪律整块回退重做。
4. **lint 对"从参数进来的 `RefObject`"一律要求列进依赖数组**（A8-8 两处、A8-9 一处 `[] → [containerRef, …]`）：
   身份恒定，列进去不改变重建时机，这是等价改写，写进提交信息即可。
5. **搬迁脚本的括号/注释配平守卫不能跨文件比总数**（新模块骨架自带括号）：改成"**每个文本各自配平**"
   （旧画布 / 新画布 / 被搬文本 / 新模块各算一次）。A8-6 第一次用总数比，误报 46 个括号差。

**待用户人眼验收（自检不渲染 React，agent 无法自证）——在第四版那一串之外新增：**
A8-6/A8-7 是渲染层重构，请走一遍：**画布正常显示**（装饰线 / 边界 / 概要 / 树上连线 / 关系线 / 节点 / 覆盖层
逐层都在，层次没变）；**拖拽**：三种落点提示（成为子主题的空位框＋「将成为『X』的子主题」文案、同级插入线、
Alt 自由摆放）+ 多选徽标 + 左右对调预览 + 端点改接；**搜索命中与筛选**染色；**框选**高亮与橡皮筋；
**双击改标题**（边界 / 概要 / 关系线：Enter 换行、Esc 取消、Ctrl+Enter 提交、失焦提交）；**底部图例三段高亮**；
**滚动缩放后节点裁剪正常**（可见节点/连线裁剪没有因为搬层而失效）。

**下一步建议顺序（沿用第四版，未变）**：B1 第二步（内联纯逻辑 ~188 行 + 切片，§3.4 有归属表）
→ A6-4（可选）→ E1 剩 7 组（先做 (5)）→ `refactor-audit.md` §2.4 的两条脚本侧待办。

---

## 第四版正文（现态数字以本补记为准）

# 交接文档：解耦战役（给新 agent 的提示词与现态总结）

> 更新：2026-09-19（**第四次交接**）｜ 仓库：`D:\Mind`（产品名 SMind）｜ 已提交的 HEAD：**`2444758`**（+ 本次文档提交）
> **本文件是自包含的**：新 agent 只读它 + `docs/decoupling-plan.md` + 仓库本身即可继续。
> 上一版（第三次交接，HEAD `a87ff82`）见 `git show a87ff82:docs/handover.md`。
> 两版之间的进展：**A8 做了 5 批（入口 2951 → 1480）、A6-3 / A7-3 / B1 第一步 / E1 三组全部做完。**
> **权威口径永远是仓库里的 `docs/decoupling-plan.md`**（记忆里的待办会滞后于仓库，别只信记忆）。

---

## 零、开工前的第一件事：确认工作树状态

**写这份文档的时刻，工作树是干净的**，HEAD 已含 A8-5：

| 批次 | 提交 | 结果 |
|---|---|---|
| A8-5 | `2444758` | Canvas 的「画布交互手势」四段整块搬进 `canvas/use-relationship-drag.ts`(180) / `use-title-edit.ts`(73) / `use-marquee-select.ts`(184)；入口 **1721 → 1480**。主 agent 已在 HEAD 上复跑五道门槛（全 0）与行多重集守卫——**旧文件独有只剩 2 行**（`[]` 与 `[setPan]`，即两处依赖数组补了恒定身份项） |

但你读到时可能又脏了（比如用户又派了子任务）。所以：

1. `git status --short` + `git log --oneline -3`。**如果干净**，直接跳到 §三 选一项开工。
2. **如果不干净**：
   - 先确认**有没有别的 agent / 子任务正在改同一批文件**——在跑就**不要动它们**（会互相覆盖），等它收工或让用户确认它已停。
   - 再二选一（不要含糊）：
     - **收下**：跑五道门槛（逐条退出码）→ 通过就按该批的格式提交（`git add` **只加它改动的那几条精确路径**，
       **绝不 `git add -A`**）；不通过就**整块回退**（`git checkout -- <那些文件>` + 删掉新增文件）。
     - **回退**：若你判断"结构上搬不动"，退回并把具体障碍写进计划表 §八（**不要留下半成品**）。
       这是计划表 §六 的既有纪律：「门槛红了先 `git checkout` 该文件回退，不要在红的基础上继续搬」。
3. 另外**留意未跟踪的新文件**（`??`）：一个批次的搬迁常常同时产生"改主文件 + 新增模块"，
   回退时**新增文件也要一起删**，否则下次搬迁脚本会因为"目标文件已存在"而拒绝落盘。

**A8-5 过程中踩过的三类报错**（A8 手势族这一带最容易撞，供排查参考）：
`canvas/use-marquee-select.ts` 里 `setMarquee` 重复标识符（TS2300）；`Canvas.tsx` 里 `setMarquee`
used before its declaration（TS2448/2454 —— **TDZ：hook 调用点必须排在它所有消费者之前**）；
`titleEditRef.current = titleEdit` 处类型被推成 `any`（TS2345/7006）；解构了画布不再使用的
`setHandleDrag`（TS6133）。

---

## 一、可直接粘贴的提示词（建议整段发给新 agent）

```
你是 Mind（应用名 smind，仓库 D:\Mind）的专业代码架构师，对代码块的管理与修正更新负全责。
本次任务：继续执行 docs/decoupling-plan.md 里的解耦任务表，把剩余项按批次做完。
（C1、A1–A7、A8 的前 4 批、A6-3、A7-3、B1 第一步、E1 的 11 组已完成。
 剩下建议顺序：A8 收尾（手势族 → 展示层 memos → JSX 装配）→ B1 第二步（内联纯逻辑 + 切片）
 → A6-4（可选）→ E1 剩 7 组。计划表 §八「仍未做」里每一项都写了配方与红线，开工前先读它。）

【开工前固定动作】
0. git status --short 与 git log --oneline -5。**工作树可能不干净**：A8-5 的 4 个文件（Canvas.tsx +
   canvas/use-relationship-drag.ts / use-title-edit.ts / use-marquee-select.ts）可能还没提交，
   而且可能有别的子 agent 正在改它们——先接手（跑门槛后提交）或整块回退，处置干净了再开工。
   同时读 docs/decoupling-plan.md 的任务表状态列 + §二 行数口径 + §八 仍未做，以及
   docs/known-issues.md 的核对表——不要只信记忆里的待办清单（它会滞后于仓库）。
1. 每完成一项 = 一个提交，提交前必须过**五道门槛**且每道门**单独打印退出码**：
   npm run typecheck（含 tsconfig.strict.json）/ npm run lint（--max-warnings 0）/
   npm run format:check / npm run selfcheck / npm run verify
   —— 不要用 `;` 串联后只读一次 $LASTEXITCODE（会吞掉前面失败的门）；日志文件名别含冒号
      （`format:check` 被 PowerShell 当成 drive，重定向会失败、退出码变陈旧值）。
   —— `npm run selfcheck` 在受限沙箱下经管道（`| Tee-Object` / `| Select-Object`）会 EPERM；
      改成文件重定向 `npm run selfcheck *> 日志文件` 就能跑通，**不需要提权**。
   —— 看门槛输出别截断：`Select-Object -Last N` 会吞掉前面的错误；用
      `Select-String -Path <日志> -Pattern 'error TS'` 全量列。
   —— `npm run format` 是**全仓** prettier --write：只给自己改的文件跑
      `npx prettier --write <你的路径>`（若同时有别的 agent 在工作树里，全仓 write 会动到它的半成品）。
2. 行为零变化：拆分只搬代码；任何"顺手该修"的东西**另开提交**。
3. 每批提交信息写清：搬了什么（含原行范围与行数）、调用点改了几行、依赖数组有没有动（动了哪些、为什么等价）、
   门槛结论、结构守卫结论、"未做行为改动"、残留。
4. 汇报前必须亲手跑验证，并说清哪些验证过、哪些是推断；未验证的必须标注。

【硬约束（不可动）】
- scripts/selfcheck.ts 必须仍是自检入口（scripts/run-selfcheck.mjs 不依赖别的路径）。
- IPC 通道名（共 66 条）、.xmind/.emmx 写出字段、styles/index.css 的 @import 顺序都属"行为"，不许改。
- React.memo 的浅比较面不许扩大（配方见 §四.2）。
- .tmp-check/ 是 gitignore 的脚本暂存区，可自由使用；.dsh-meow/ 是记忆库，别碰。
- 源码编辑一律用 read/write/edit 工具；搬迁脚本可写在 .tmp-check/*.mjs 里用 node 显式 UTF-8 读写。
  绝不用 PowerShell 的 Get-Content+Set-Content 改源码（会重编码 → 中文乱码）。

【并行纪律（本战役真踩过事故）】
- 多 agent 同时改同一仓库：`git add` 只加自己的路径、绝不 `git add -A`；但仍要意识到
  **`git add` 与 `git commit` 之间不是互斥的**——本战役发生过两条提交互相吞并（B1 的 `57b044e`
  里混进了别人 add 好的 chat 两个文件；已核实无内容丢失，用一条 `--allow-empty --only -- <路径>`
  的空提交作记录，**没有**重写历史）。
- 别人在飞的半成品会让全仓门槛变红：**不要去"修"它**（那不是你的改动），等它落盘再跑自己的门槛。
- 同一文件必须串行；不同文件才能并行。

【汇报】
- 用户是中文交流，所有面向用户的输出用中文；内部推理用英文。
- 被问完成度时按批次逐项给状态表，不许用"基本完成"糊过去；未验证的必须标注"未验证"。
```

---

## 二、现态总结（已提交的部分，全部实测）

### 2.1 仓库与门槛

| 项 | 现状 |
|---|---|
| 技术栈 | Electron + electron-vite 5 + React 19 + zustand 5 + immer（patch/undo）+ TS 5.9 strict + ESLint 10 + Prettier 3 |
| 分层 | `src/shared`（纯逻辑）← `src/main`（IPC 注册）/ `src/preload` ↔ `src/renderer/src`（React） |
| IPC 面 | **66 条注册**，主进程侧与 preload 侧逐条核对无缺失（C1 后未变） |
| 自检 | `scripts/selfcheck.ts` → **2628 项断言**，全绿（⚠️ 它只测 shared 逻辑与 store，**不渲染 React 组件**） |
| 往返 | `npm run verify`：21 个 `.xmind` + 4 个 `.emmx` 样本往返一致 |
| 提交 | 解耦战役累计 **44 个提交**，最新 `ecf625f` |
| 门槛注意 | `format:check` 只覆盖 `src/**/*.{ts,tsx,css}`（**不查 `scripts/**` 与 `docs/**`**）；行数统计别用 `Get-Content`；行数在 prettier 之后统计 |

**本会话（第四次交接覆盖段）在 HEAD 上亲手复跑的五道门槛**：

```
npm run typecheck    → exit 0   （含 tsconfig.strict.json）
npm run lint         → exit 0   （--max-warnings 0）
npm run format:check → exit 0
npm run selfcheck    → exit 0   （全部通过：2628 项断言）
npm run verify       → exit 0   （21 个 .xmind + 4 个 .emmx 往返一致）
```

### 2.2 行数现状（node 口径，2026-09-19 实测）

| 文件 | 之前 | 现在 |
|---|---|---|
| `components/Canvas.tsx` | 2951 | **1480**（A8 已做 5 批） |
| `components/chat/use-chat-loop.ts` | 1274 | **799**（+ 新模块 `chat/turn-runtime.ts` 636） |
| `store/editor.ts` | 2316 | **2181**（+ 新模块 `shared/model/editor-pure.ts` 175） |
| `App.tsx` | 466 | **366**（+ 新模块 `app/use-window-close.ts` 168） |
| `scripts/selfcheck.ts` / `main/index.ts` / `TopicNode.tsx` / `NodePanel.tsx` / `Toolbar.tsx` / `ChatPanel.tsx` | 11844 / 2498 / 619 / 814 / 1059 / 1953 | **473 / 54 / 305 / 133 / 310 / 386** |

`canvas/` 现有 13 个模块：`geometry` 388 / `use-node-drag` 608 / `use-view-follow` 251 /
`use-canvas-viewport` 197 / `use-marquee-select` 184 / `use-relationship-drag` 180 /
`use-canvas-geometry` 143 / `use-wheel-pan-zoom` 85 / `use-title-edit` 73 / `use-fold-anchor` 57 /
`use-flash-nodes` 41 / `clip-text` 19 / `view-lock-warn` 18。

### 2.3 本会话（第四次交接覆盖段）的 11 个提交

| 批次 | 提交 | 结果 |
|---|---|---|
| A8-1 | `9acca77` | 落点几何与常量 → `canvas/geometry.ts`（纯函数收显式入参）+ `canvas/clip-text.ts` + `canvas/use-canvas-geometry.ts`（薄绑定层）；Canvas 2951 → 2594 |
| A8-2 | `fad4f30` | 闪一下 → `canvas/use-flash-nodes.ts`；视口动作 + 两个 effect → `canvas/use-canvas-viewport.ts`；2594 → 2446 |
| A8-3 | `e69e4b0` | 视角锁定跟随 → `canvas/use-view-follow.ts`；折叠锚点 `useLayoutEffect` → `canvas/use-fold-anchor.ts`；滚轮 → `canvas/use-wheel-pan-zoom.ts`；`warnViewLock` → `canvas/view-lock-warn.ts`；2446 → 2178 |
| A8-4 | `1597796` | 拖动节点整件事（5 个落点 state + 7 个 ref + `dragAutoScroll` + 390 行 `handleNodePointerDown`）→ `canvas/use-node-drag.ts`；2178 → **1721** |
| A8-5 | `2444758` | 画布交互手势四段 → `canvas/use-relationship-drag.ts` + `use-title-edit.ts` + `use-marquee-select.ts`；**1721 → 1480**（五道门槛全 0；守卫旧独有只剩 2 行＝两处依赖数组补了恒定身份项） |
| B1 第一步 | `57b044e` | 11 个纯函数（12 段 139 行）→ `shared/model/editor-pure.ts`；`store/editor.ts` 2316 → **2181**；调用点 0 行 |
| A6-3 | `0115b5d`（**空记录提交**，代码实体在 `57b044e` 里） | `createTurnRuntime(deps)`（**22 个**显式 deps 字段）→ `chat/turn-runtime.ts`；`use-chat-loop.ts` 1274 → **799** |
| A7-3 | `c9a1961` | 关窗链路 5 段 116 行 → `app/use-window-close.ts`；`App.tsx` 466 → **366**；调用点 0 行 |
| E1 (6) | `51f0018` | 标签行排版常量 → `shared/layout/accessory.ts`（顺带消掉 `export/node.ts` 里裸的 `fontSize: 11`） |
| E1 (14) | `449b279` | `parseToolArguments` 原语（`shared/agent/args.ts` 30 行）；两个调用点各自保留文案与失败包装 |
| E1 (11) | `80b6049` | `MINDMAP_EXTENSIONS` + `MINDMAP_FILE_RE` 一处出（原来四处各写一份） |
| 文档 | `ecf625f` | 计划表任务表 / §七 执行记录 / §八 全部同步；E1 枚举来源订正 |

### 2.4 已完成（更早已打钩的项）

| 目标 | 结果 | 提交 |
|---|---|---|
| A1 `render/measure.ts` 723 | → **493** + `measure/*` | `9b5f077` |
| A2 `export/drawing.ts` 771 | → **162** + `export/{ops,node}.ts` | `8fdc8d6` |
| A3 `TopicNode.tsx` 619 | → **305**：`topic/` 11 个（外壳刻意不抽） | `64ed49e` + `0bb4812` `3fe548d` `329546a` |
| A4 `NodePanel.tsx` 814 | → **133**：`nodePanel/` 7 个（草稿 state 不下沉） | `8441f54` |
| A5 `Toolbar.tsx` 1059 | → **310**：`toolbar/` 11 个（按「整组」搬） | `c11e365` |
| A6 `ChatPanel.tsx` 1953 | → **386**：`chat/` 10 个展示/纯函数模块 | `fa7d843` + `a5bc249` |
| A7 `App.tsx` 1272 | → **443**：`app/` 8 个 hook | `394e1f1` + `f55a2af` |
| C1 `main/index.ts` 2498 | → **65**：`context.ts` + `ipc/` 14 域 + 10 个下沉模块 | 8 批 `a8aebe6`…`3a61e69` |
| D1 `scripts/selfcheck.ts` 11,844 | → **473**：`harness.ts` + `helpers.ts` + `domains/` 8 个 | 10 批 `a40bce9`–`dcacfb4` |
| F1 `styles.css` 3650 | → `styles/*.css` 21 个 + `index.css`（原顺序 @import） | `cca2c5b` |
| G1 `shared/import/markdown.ts` 807 | → **307** + `import/markdown/inline.ts` | `56e477d` |
| G2 文档收口 | CHANGELOG 增「解耦」小节、known-issues 增两表、refactor-audit 打勾 | `8527fa3` |

**契约全部保持**：`selfcheck` 入口未动、断言仍 2628 项、66 条通道名未动、`.xmind`/`.emmx` 字段未动、
`@import` 顺序未动；所有拆分项调用点改动 0–2 行。

### 2.5 两处必须知道的历史事实

1. **`57b044e` 里有两个不属于它的文件**：A6-3 与 B1 的 `git add` 落进同一个 index，A6-3 的
   `chat/turn-runtime.ts` + `chat/use-chat-loop.ts` 被 B1 的提交顺带带走。**已核实无内容丢失**
   （`git diff HEAD -- chat/` 为空、`git hash-object` 三处一致；A6-3 的终态与 HEAD 逐字节相同）。
   A6-3 补了一个 `--allow-empty --only -- <自己的两个路径>` 的**空记录提交** `0115b5d`。
   **决定不做历史重写**（其上已压 4 个别人的提交，rebase/amend 会让那些提交的门槛结论与实测字节脱钩）。
   要看 A6-3 的代码：`git show 57b044e -- src/renderer/src/components/chat/`。
2. **E1 的枚举来源**：逐条清单在 **`docs/shared-audit.md` §5「Duplicated implementations」**（编号 (1)–(18)），
   而 `docs/refactor-audit.md` §5 是「刻意不做」，不是这份清单；`refactor-audit.md` §2.4 另有 7 行重复项
   （含 2 条脚本侧）。**「余 18 组」这个说法对不上任何枚举**——18 组里已收 11 组，剩 7 组。

---

## 三、剩余工作与配方

> 细节与红线都在 `docs/decoupling-plan.md` §八（本会话已把五行全部改写成"已完成 + 残留 + 下一批配方"）。

### 3.1 A8 收尾（最大的一块）

**已完成 5 批**（落点几何与常量 / 闪一下与视口动作 / 视角锁定与折叠锚点与滚轮 / 拖动节点 /
画布交互手势），入口 **2951 → 1480**。**还差约 1230 行**，剩三块：

1. **展示层 memos**（先做这块，风险最低）：`dropPreview`（120 行）、`sideFlipPreview`、`groupBadge`、
   `dragFocus`、`visibleEdges` / `staticEdges` / `dragEdges` / `marqueeHits` / `searchHits` / `filterResult` /
   `visibleNodes`。纯计算、无 effect、无顺序语义 → 可整块搬进一个 `canvas/use-canvas-display.ts`
   （注意：它们读 `layout` / `dragVisual` / `dropIndex` 等，hook 调用点必须排在 `useCanvasGeometry(...)`
   与 `useNodeDrag(...)` **之后**，否则 TDZ）。
2. **JSX 装配与覆盖层组件**（唯一能把入口压到 250 的最后一公里，风险最高）：
   建议**先抽"层"**（静态连线层 / 拖拽层 / 覆盖层 / 提示层）再抽单个覆盖层；配方见 §四.3。
   抽完记得核对 `React.memo` 的浅比较面没变。
3. 剩余的零散 handler / 派生值：`pickOverlay`、节点回调一族（`handleNodeDoubleClick` /
   `handleNodeRichChange` / `handleNodeToggleCollapse` / `handleNodeToggleFoldSide` …）、
   `commitTitleEdit` 的收尾部分、`renderEdge`。它们体量小、可并入上面两块一起搬。

### 3.2 A6-4（可选，A6-3 的残留）

`use-chat-loop.ts` 仍 **799 行**、`chat/turn-runtime.ts` **636 行** > DoD 400。
`handleEvent`(220) / `resolvePending`(52) / `send`(99) / `runRound` / `stop` / `clearChat` / `update` / `dumpDiag`
**不能搬**（前者带 `useCallback([update, dumpDiag])` 且被订阅 effect 依赖 `[handleEvent]`；`resolvePending`
是 `useCallback([])`（带既有 disable）且要读 `pendingRef`/`patchAppSettings`；`send` 要读大量视图侧入参）。
可做的是把「写意图执行（`applyWriteIntent`+`noteAction`）」与「队列推进（`processQueue`）」再分两个模块
——它们之间已只通过显式 deps 与返回值耦合、不再有 ref 环。
另一条正解：把 `setPending` 留在 hook、以 deps 传进工厂（保持函数字面量，`exhaustive-deps` 重新认可稳定性），
代价是 12 行不搬——**A6-3 当时为了不改行为，在两处加了 `eslint-disable-next-line` + 理由注释**，
按这条正解重做就能去掉那两条 disable。

### 3.3 A7 剩余

`App.tsx` 366 行 > 250：剩下的是顶部 state/订阅 + Toolbar actions + 各面板与弹窗装配（属另一批）。
**不要顺手改关窗链路**——那条链路刚搬过、正等着人肉验收。

### 3.4 B1 剩余

1. **内联纯逻辑约 188 行**可抽成显式入参纯函数（实测清单）：`setImage` 尺寸归一 7 行 /
   `setSizeOverride` 钳制 36 / `moveSelectionByKey` 31 / `navigateSelection` 26 / `sortChildren` 17 /
   `deleteSelection` 删除后落点 16 / `mergeTopics` 字段并入 14 / 画布级元素查重 20 / `select` 的 reducer 9。
   **注意**：区分「算 minBox」（依赖 renderer 的 `../render/measure`、`../render/formula`，**要留在 store**）
   与「钳制」（纯，可下沉）。
2. **切片（`store/slices/` 6 个）最后做**。归属表（实测）：
   - `aiTurn` **必须与 `undoStack`/`redoStack`/`mutate` 同切片**（`beginAiTurn` 用 `undoStack.length` 当 depth、
     `commitAiTurn` 用 `undoStack.slice(depth)`，还被 3 处文档生命周期写）→ 历史切片拥有它、文档切片只调一个复位动作；
   - `viewLock` 归视图切片（localStorage 持久化 + 被 `tabs.ts` 快照纳入 + `newDocument`/`loadDocument`
     会按 `defaultViewLock` 重算）；
   - `lastFold` 在 `editor.ts` 内**只写不读**，唯一消费者是 Canvas 的镜头锚点。
3. **不要搬**：`snapshotForSave`（吃 store 的 `EditorState` 类型，改签名要动 8 处调用）、
   `patchAppSettings`（store + IPC）、`readPersistedViewLock` / `persistViewLock`（localStorage）、
   `createId` / `createTopic`（`Date.now` + `Math.random`）。

### 3.5 E1 剩 7 组

剩 (2) `normalizeDocPath` vs `documentKeyOf`、(3) `extensionOf`、(4) `bracePath`、(5) 概览/边界标题默认样式、
(10) 混合组、(12) resources 前缀、(15) 两种节点计数。
**建议先做 (5)**：原语放 `shared/model/overlay-style.ts`，消掉「布局按常量预留白、绘制按字面量画」的漂移
（注意它要动 `Canvas.tsx`，得排在 A8 之后）。
**建议不做**（实测"只是长得像"或有意外部契约）：(2)（快照键是持久化面）、(4)（同名不同义、无文件同时 import 两者）、
(15)（统计口径有意不同，`known-issues.md` 已写明别合并）、(10) 的颜色校验/文件名清理/activeSheet 空工作簿三子项。
另有 `refactor-audit.md` §2.4 的两条脚本侧待办：CRC32+PNG 抽 `scripts/lib/png.mjs`（**改完必须 sha256 比对产物**）、
三份 esbuild runner 合成一个（**它是五道门槛自己的执行器**，单独提交并改完立刻各跑一次）。

### 3.6 刻意不做 / 已论证不成立（沿用旧版结论）

- **`TopicNode` 的"外壳"不抽**：`.topic` 外层 div 依赖 `visualFor`/`branchColorOf`/`minNodeWidth` 一组值。
- **面板级 `useState` 不下沉**（A4 结论）：挂载点会变的组件不许接管草稿 state。
- **不批量剪除"死导出"**：清单条目是多余 `export` / barrel 冗余再导出，零运行时收益，且清单已被证伪多次。
- **不为让 lint 变绿去改高频路径的 ref 用法**（`refs`/`immutability`/`purity` 三条已实测留档）。

---

## 四、方法学（本战役最值钱的部分）

### 4.1 搬迁四步法 + 拆分判据

1. **只有 effect 有顺序语义，回调与 memo 没有**——这是判断"什么能拆"的硬判据。搬 effect 时
   **hook 的调用点必须落在原 effect 的位置上**（或让 hook 调用整体覆盖"从第一段代码到那条 effect"的整块）
   ——A7-3 就是靠这条把 `onCloseRequest` 的位置钉住的（搬迁前后都是 12 条 effect，顺序与正文指纹逐条一致）。
2. **函数身份（`useCallback` 依赖数组）也是行为的一部分**：订阅类 effect 的依赖一旦变化，cleanup 会跑
   （A6 的订阅 effect cleanup 会 `stop()` + `commitTurn()`，重跑＝掐掉正在跑的回合）。
   把组件作用域里的稳定值（React setter / RefObject / 模块级函数）改成 hook 入参时，
   **规则会要求把它们列进依赖数组——列进去是安全的**（身份恒定）；**但别把每渲染都新建的闭包列进去**。
3. **state 不下沉**：挂载点会变的地方（条件渲染 / 分支组件）草稿 state 必须留在最外层。
   **state 搬进 hook 时，hook 调用点必须排在它所有消费者（JSX / memo / 其它 handler）之前**（TDZ）。
4. **任务表与 DoD 冲突时**：正确性红线优先（如"ref 环不可跨文件拆"），把行数超限**如实记进 §八**并写配方。
5. **搬迁四步**：①用脚本扫顶层声明与块的精确起止行（别肉眼数）；②**一次扫描 + 一次改写**（所有区间基于
   同一份行号，结构上不可能漂移）；③**用门槛当簿记检查器**（`typecheck` 精确指出名字没导出/没导入/路径深度错）；
   ④固定收尾：`eslint --fix` 清无用导入 → 去它补的 `.ts` 后缀 → `prettier --write` → 五道门。

### 4.2 「薄绑定 hook」＝闭包逻辑去 ref 化的正确姿势（A8 四批验证）

把逻辑抽成**纯函数、收显式入参**（原来读 `layoutRef.current` / `rootRef.current` 的地方变成参数
`lay` / `rootTopic` / `dropIndex`），再写一个只负责「**调用那一刻**读 ref 再传进去」的薄 hook——
读到的值与搬迁前同源（这些函数都是同步纯计算，调用期间 ref 不会被改写），
且纯函数之间相互调用走**同一个入参 `lay`**（保证一次判定里"看到同一份布局"），
于是组件里几十处调用点**一行都不用改**（按名字解构）。
**依赖数组可以收敛但要逐条论证等价**：被依赖的回调身份只在某个值变化时才变，就能把 `[a, b, c]` 收成 `[x]`。
**反例**：`setPending` 这类**每渲染重建**的值**不能**为让 lint 变绿而补进依赖；这时才用
`eslint-disable-next-line` + 理由注释（仓库已有先例）。

### 4.3 JSX 抽取配方（A3-2 / A4 / A5 验证过）

1. **整块搬 JSX，一个字都不改**；2. 外面包一层 `<></>` Fragment（**不产生 DOM 节点**）；
3. **props 原样传**——子组件里用的名字与父组件局部**同名**，块体零改动；
4. **不给子组件加 `memo`**、父组件回调**不重新包装** → `React.memo` 的浅比较面**完全没变**；
5. 交互块照搬：`useState` 原 setter 直接当 prop 传，`useEditor.getState()` 仍在子组件里调用；
6. 类型只用推导式（`ReturnType<typeof f>`、`Props['x']`）并**如实跟随可空**，不手抄类型、不 `as`。

### 4.4 守卫（是证据，不是仪式）

- **行多重集守卫**：对比「旧文件」与「新文件 + 新模块」的 trim 后行多重集，
  **判据不是数量相等，而是"旧文件独有的每一行都能被解释"**。
  脚本 `.tmp-check/msguard.mjs`：`node .tmp-check/msguard.mjs <rev> <旧路径> <新文件1,新文件2>`。
- **搬迁脚本必备守卫**：①区间**首行与末行的连续序列**都要断言；②区间不重叠；③大括号配平 +
  **注释标记总数不变**；④**被搬走的每一行都要能在新文件里逐字找到**（找不到就拒绝落盘）；
  ⑤改写后不得残留旧声明；⑥目标文件已存在则拒绝；⑦**先全量校验、再统一落盘**；⑧dry-run 默认、`--apply` 才写。
- **effect 顺序**用脚本核（`.tmp-check/a7-3-effect-order.mjs`）：把「内联 effect + 所调 hook 展开的 effect」
  按注册顺序编号，逐条比对**正文首行指纹**。
- **区间依赖分析**用脚本（`.tmp-check/region-deps.mjs <file> <区间,区间...>`）算「要传进来/要返回的名字」。
  **注意盲区**：它只认 2 空格缩进的 `const/let/function` 声明，**看不见 hook 的解构入参**——
  A6-3 那次它算出 19 个 deps、实际 **22** 个（漏了 `onBeforeAiWrite` / `refreshLicense` / `docsRef`，
  漏了就是 TS2304）。做 deps 对象时要再用「自由标识符全量扫描」复算（`.tmp-check/a6-3-freescan.mjs` 可复用）。

### 4.5 必踩的坑（都已踩过）

| 坑 | 症状 | 正解 |
|---|---|---|
| **用 `Get-Content` 统计行数** | 数字比实际小（A7 完工时报 443、实际 466）；本机 `Get-Content` 按 GBK 解码，**吞掉 LF-only 文件里紧跟中文的换行符**（CRLF 文件不受影响） | 行数一律用 **node**：`fs.readFileSync(f,'utf8').split('\n').length-1`，或看 `read` 工具末行号；`.editorconfig` 要求 LF，所以新文件是 LF、旧文件是 CRLF |
| **CRLF 让 `/,\s*$/` 静默失配** | 扫描器行数/行号全对不上 | 扫描前 `.map(l => l.replace(/\r$/,''))`；读行用 `split(/\r?\n/)` |
| **正则字面量里的括号被当成结构括号** | `/^\s*\d+\s*[.、)]\s*/` 让深度变 −1，把后面 660 行全吞 | 数括号前先识别 `/.../` 字面量 |
| **「吃掉区间后的空行」误吞下一段的 `/**`** | 注释配平失衡；守卫查不出大括号问题 | `i = lines[r.e] === '' ? r.e + 1 : r.e`；用**注释标记配平守卫**（`/*` 与 `*/` 计数与原文相同） |
| 行范围切在注释中间 | 入口留孤立 `/**`，**它把后面的 `}` 注释掉** | 区间取"分节注释整行"或"声明行"为边界；首末行**都**断言 |
| **自写 body-scan 把下一段 doc 注释算进上一段** | 端点行号偏差 | 端点一律**按内容断言**，不靠扫描器推算的行号 |
| `useState(` 正则匹配不到 `useState<{…}>` | 条数守卫误报少 | 用 `useState[<(]` / `useRef[<(]` |
| **导入块的边界算错** | 把模块级助手复制进每个 hook，符号重复/未使用一片红 | 导入块边界＝**第一个模块级 doc 注释之前**；模块级助手必须落在 hook 函数**闭合之后** |
| **从入口现有导入推导 hook 的导入** | hook 里 `Cannot find name 'viewportActions'` 等；甚至自引用 | 入口的导入块**已被 eslint 裁剪**；按**门槛报告的名字**逐条补 |
| `String.replace` 只替换第一处 | 校验数出 3 处、落盘只改 1 处 | `expect` 与 `split/join` 配套 |
| 先写目标文件后校验父文件 | 守卫失败留下孤儿半成品 | **先全量校验、再统一落盘** |
| `prettier` 重排多行 JSX | 先量的行数与文档/提交信息不一致 | 行数在 prettier 之后统计 |
| 相对路径深度算错 | 先报 Cannot find module，**紧接着把导入值推成 any、别处报 TS7006** | 看到隐式 any 先查模块路径 |
| 门槛输出被截断 | 以为只有 3 个错，其实有 10 个 | 用 `Select-String -Pattern 'error TS'` 全量列，或看日志文件 |
| **`.tmp-check/` 下的脚本也只用 read/write/edit** | 用 `Get-Content -Raw \| Set-Content` 把脚本写坏编码 | 脚本坏了就删掉用文件工具重建（同样会重编码/乱码） |

### 4.6 审计结论已被证伪/纠偏（**不要照抄审计清单**）

| 审计说 | 实际 |
|---|---|
| "拖到中心主题前/后应报错" | **有意行为**，被自检断言钉住 |
| "`stop()` 应清 `requestIdRef`" | 清了会让终止 `aborted` 事件被 `handleEvent` 过滤掉，「已停止」标记与回合收尾一起消失 |
| "`runsToHtml` 是死代码" | **`scripts/selfcheck.ts` 的断言在用**（审计只 grep 了 `src/**`，漏了 `scripts/**`） |
| "快照单文档版本数无上限" | `prune` 本来就有上限（`SNAPSHOT_LIMITS.perDoc` + 手动版本优先） |
| "`FOLD_SIDE_LABELS` 直接复用 `@shared/agent`" | 让画布依赖 AI 层是错误方向 → 下沉到 `shared/model/fold-labels.ts` |
| "E1 的清单在 `refactor-audit.md` §5、余 18 组" | §5 是「刻意不做」；枚举在 `shared-audit.md` §5（(1)–(18)），已收 11 组 |

**规矩**：删死代码前 grep 必须**同时覆盖 `src/**` 与 `scripts/**`**。

### 4.7 可复用工具（`.tmp-check/`，gitignore）

| 脚本 | 用途 |
|---|---|
| `msguard.mjs` | **通用行多重集守卫**（`<rev> <旧路径> <新文件列表>`） |
| `region-deps.mjs` | 区间依赖分析（要传进来 / 要返回的名字；**有解构入参盲区**） |
| `a8-1..4-move.mjs` / `a6-3-move.mjs` / `a7-3-move.mjs` / `b1-pure-move.mjs` | 各批的搬迁脚本（端点断言 + 逐字命中 + 先校验后落盘） |
| `a7-3-effect-order.mjs` | effect 顺序指纹比对 |
| `a6-3-freescan.mjs` | 自由标识符全量扫描（补 `region-deps.mjs` 的盲区） |
| `line-guard.mjs` / `move-chat-loop.mjs` / `move-app-effects.mjs` / `extract-jsx.mjs` / `move-domains.mjs` | 前几轮的工具（A3/A6/A7/C1/D1） |

---

## 五、待用户人肉验收（自检不渲染 React，agent 无法自证）

**A8 四个批次（渲染层行为）**：一整轮真实 AI 对话（工具调用 / 确认 / 停止 / 切文档中止）、
面板三分支与草稿输入、工具栏收纳与禁用提示、菜单 / 快捷键 / 拖文件 / 自动保存与恢复提示、
拖拽吸附与落点提示（含多选整群拖、左右对调、贴边自动滚动）、折叠锚点（被折叠节点原地不动）、
视角锁定（跟随 / 让位 / 折叠后不丢中心）、滚轮平移与 Ctrl 缩放、窗口缩放后居中。

**A7-3（关窗链路，12 条）**：①取消后回执主进程并能**再次**询问；②单标签「保存 / 不保存」；
③多标签逐个询问、中途取消不丢标签；④「不保存」不重复询问（`forceCloseIds`）；⑤保存失败不关窗；
⑥启动即关窗直接放行且**不清自动存档**（`recoveryPendingRef`）；⑦崩溃恢复弹窗恢复/丢弃；
⑧关单个标签且释放文档资源（重开不缺图）；⑨历史快照恢复前仍先弹未保存确认；⑩菜单/快捷键关窗入口；
⑪拖文件与双击 `.xmind` 仍开新标签；⑫关窗后自动存档与版本快照行为不变。

**A6-3**：切到别的抽屉（面板卸载）时正在跑的回合要被收尾（`aiTurn` 不残留 → `undo/redo` 不被静默挡住）、
工具调用确认与「以后不再询问」、读工具与写工具各跑一次（参数非法时的报错文案应与以前一字不差）。

**A4–A7（更早那几批，同样尚未人眼验收）**：节点属性面板三条分支与四段；工具栏各组按下/禁用/提示与
「收进更多 ▾」；聊天面板一整轮对话（工具调用、破坏性确认、停止、切文档中止、清空、撤销合并成一步、
改动节点闪烁、思维链折叠、token 用量）；应用外壳菜单命令逐条、快捷键、拖文件三种去处、
自动保存与崩溃恢复提示、窗口标题与多窗口聚焦；A3 新抽的 9 个子组件 + 更早 4 项（带色文字、概要括号、
折叠镜头锚定、F1 后样式一致性）。

**已由用户验证通过**：C1 的主进程链路。

---

## 六、关键文档索引

| 文档 | 用途 |
|---|---|
| `docs/decoupling-plan.md` | **权威任务表**：任务表状态列 + §二 行数口径 + §三 各批手法与风险 + §六 风险预案 + §七 执行记录 + §八 剩余项配方 |
| `docs/known-issues.md` | 「仍未做」「经核对不成立」两张核对表；E1 收敛判据 |
| `docs/shared-audit.md` §5 | E1 重复实现的**逐条枚举**（(1)–(18)） |
| `docs/refactor-audit.md` | §3 拆分计划、§4 执行顺序、§5「刻意不做」、§2.4 重复项 7 行 |
| `CHANGELOG.md` | 「解耦 · 单文件拆分」小节 |
| `docs/handover.md`（本文件） | 自包含交接：提示词 + 现态 + 配方 + 方法学 + 验收清单 |
| `.tmp-check/*.mjs` | 可复用搬迁/守卫脚本（§4.7），gitignore，可自由改写 |

---

## 七、下一步建议（一句话）

**先把工作树里那 4 个文件（A8-5 手势族）处置干净**（跑门槛收下、或按 §六 纪律整块回退），
然后按 **展示层 memos → JSX 装配** 把 `Canvas.tsx` 从 1721 压向 250；
之后 B1 第二步（内联纯逻辑 + 切片，按 §3.4 的归属表）、E1 剩 7 组（先做 (5)）。