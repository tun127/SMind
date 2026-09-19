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
| 未完成（2026-09-19 本轮实测同步） | 剩 **7 个 600+ 行文件**，全在 `renderer` / `main`：`Canvas.tsx` 2951、`main/index.ts` 2498、`store/editor.ts` 2316、`ChatPanel.tsx` 1953、`App.tsx` 1272、`Toolbar.tsx` 1059、`NodePanel.tsx` 814；`scripts` 侧已全部拆完（入口 473 行） |
| 安全网 | `selfcheck` **2628 项断言**（本轮从 2522 涨上来的），`verify` 21 个 `.xmind` + 4 个 `.emmx` 往返一致 |

---

## 三、任务表

顺序＝依赖顺序＋风险从低到高。**每一行都是一批、一个提交。**

### Step A · 渲染层（8 项）

| # | 现状 | 目标结构 | 手法 | 调用点改动 | 主要风险 | 状态 |
|---|---|---|---|---|---|---|
| A1 | `render/measure.ts` 723 | `render/measure.ts` 入口 + `measure/{cache,formula-size,wrap,style,main}.ts` | 先把「字宽缓存」「公式尺寸」「断行」「样式解析」四块按行范围搬出，入口保留同名再导出 | 0 | `cssFontOf` / `ResolvedStyle` 刚被导出过，注意别丢公开面 | ✅ 9b5f077 |
| A2 | `export/drawing.ts` 741 | `export/drawing.ts` 入口 + `export/ops.ts`（类型）+ `drawNode.ts` + `drawOverlay.ts` + `compose.ts` | 类型先搬到 `ops.ts`，`svg.ts`/`raster.ts` 改从 `ops` 引类型 | 2（svg、raster 的 import） | 类型搬动后 `strict` 配置下的 `noUncheckedIndexedAccess` 可能报新错 → 逐处按语义处理 | ✅ 8fdc8d6 |
| A3 | `components/TopicNode.tsx` 618 | `topic/` 5 个（外壳 / 文本 / 装饰 / 附件与指示器 / 内联公式） | 抽子组件，props 原样传 | 0 | `React.memo` 的浅比较：回调 props 必须是稳定引用，别在拆分时引入内联箭头函数 | 🟡 `64ed49e` 只做了 **A3-1 纯搬动**（619 → 542 + `topic/{props,segment-style}.ts`）；**A3-2 抽子组件仍未做** ⬜ |
| A4 | `components/NodePanel.tsx` 814 | `nodePanel/` 4 个（两条独立分支各拆组件 + 公共控件） | 按"选到节点 / 选到画布元素"两条分支拆 | 0 | 面板内草稿状态（`useState`）跨组件后要确认没有重复初始化 | ⬜ |
| A5 | `components/Toolbar.tsx` 1059 | `toolbar/` 3 个（主栏 / 结构切换 / 视图与缩放） | 自洽组件直接搬家 | 0 | 工具栏项数组里有彼此依赖的禁用条件，搬完要手点一遍逻辑分支 | ⬜ |
| A6 | `components/ChatPanel.tsx` 1953 | `chat/` 5 个（runtime 状态机 / 纯函数 / 消息列表 / 工具条目 / 确认弹层） | 先抽纯函数与 runtime（本轮修过 `aiTurn` 收尾，`commitTurnRef` 一族必须整体搬、不能拆开） | 0 | **最高风险之一**：`runRoundRef`/`processQueueRef`/`commitTurnRef`/`stopRef` 是"打破循环引用"的一组 ref，拆散的瞬间会变成"用到未初始化" | ⬜ |
| A7 | `App.tsx` 1272 | `app/` 8 个 hooks（菜单事件 / 快捷键 / 自动保存 / 窗口关闭 / 标签同步 / 主题 / 剪贴板 / 启动） | 逐类副作用抽 hook | 0 | 窗口关闭与未保存确认这条链路刚修过（`closeCancel`），拆时要保证 effect 顺序与依赖不变 | ⬜ |
| A8 | `components/Canvas.tsx` 2951 | `canvas/` 11 个（4 hooks + 3 纯函数 + 4 组件） | 先抽纯函数（命中测试、落点、手势数学），再抽 hooks（视口/跟随/拖拽/框选） | 0 | **最高风险**：`viewportActions` 注册与 `useLayoutEffect` 锚点补偿依赖挂载顺序；`refs` 一族是"指针跟手"的前提，不许改成 state | ⬜ |

### Step B · `store/editor.ts`（1 项）

| # | 现状 | 目标 | 手法 | 调用点改动 | 风险 | 状态 |
|---|---|---|---|---|---|---|
| B1 | `store/editor.ts` 2316 | 纯逻辑下沉 `shared/model`（撤销栈合成、排序、移动、派生值）+ `store/slices/` 6 个 | **先下沉纯函数**（可被 selfcheck 直接覆盖），切片放最后一步 | 0 | zustand 切片组合会改变 `set/get` 的书写方式；`aiTurn`/`viewLock`/`lastFold` 这些跨域状态必须先想清楚归哪个切片 | ⬜ |

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
| E1 | 审计 §5 里尚未收敛的组（每收敛一组＝一个提交；判据见 `known-issues.md`：**抽原语、调用点各留策略**，不是强行合一） | 🟡 已收 1 组：`FOLD_SIDE_LABELS`（`0054b68`，下沉到 `shared/model/fold-labels.ts`；审计建议的"复用 @shared/agent"**不成立**，改为放中立模型层）。余项待续 |

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