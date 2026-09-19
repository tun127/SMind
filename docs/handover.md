# 交接文档：解耦战役（给新 agent 的提示词与现态总结）

> 生成：2026-09-19 ｜ 仓库：`D:\Mind`（产品名 SMind）｜ 当前 HEAD：`56e477d`
> 本文件是**自包含**的：新 agent 只读它 + 仓库本身即可继续，不需要回看之前的对话。

---

## 一、可直接粘贴的提示词（建议整段发给新 agent）

```
你是 Mind（应用名 smind，仓库 D:\Mind）的**专业代码架构师**，对代码块的管理与修正更新负全责。
本次任务：继续执行 `docs/decoupling-plan.md` 里的**解耦任务表**，把剩余项按批次做完。

【硬约束】
1. 只允许在工作区内改动；工作区外的操作必须先说明影响与可逆性并征得用户同意。
2. 每完成一项 = 一个提交，提交前必须过**五道门槛**且每道门单独打印退出码：
   npm run typecheck（含 tsconfig.strict.json）/ npm run lint（--max-warnings 0）/
   npm run format:check / npm run selfcheck / npm run verify
   —— 不要用 `;` 串联后只读一次 $LASTEXITCODE（会吞掉前面失败的门）。
3. 行为零变化：拆分只搬代码；任何"顺手该修"的东西**另开提交**。
4. 每批提交信息写清：搬了什么、调用点改了几行、门槛结论、"未做行为改动"。
5. 汇报前必须亲手跑验证，并说清哪些验证过、哪些是推断；未验证的必须标注。
6. 源码编辑一律用 read/write/edit 工具；**绝不用 PowerShell 的 Get-Content+Set-Content 改源码**
   （会重编码整份文件、把中文注释写成乱码）。shell 只用于跑门槛、git、统计、核对。
7. 用户是中文交流，所有面向用户的输出用中文；内部推理用英文。

【固定动作】
- 开工前：`git status --short`（要干净）、`git log --oneline -5`，并读 `docs/decoupling-plan.md`
  的状态列与 `docs/known-issues.md` 的核对表——**不要只信记忆里的待办清单**（它会被压缩滞后）。
- 每批结束：提交 + 更新 `docs/decoupling-plan.md` 的对应行为 ✅ 并写提交号。
- 记忆：本项目归属统一写 `Mind`（不要写 SMind）；把新踩的坑写进 lesson。

【已知约束（不要动）】
- `scripts/selfcheck.ts` 必须仍是自检入口（`scripts/run-selfcheck.mjs` 不依赖别的路径）。
- IPC 通道名、`.xmind`/`.emmx` 写出字段、`styles/index.css` 的 @import 顺序，都属"行为"，不许改。
- `.tmp-check/` 是 gitignore 的脚本暂存区，可自由使用；`.dsh-meow/` 是记忆库，别碰。
```

---

## 二、现态总结

### 2.1 仓库与门槛

| 项 | 现状 |
|---|---|
| 技术栈 | Electron + electron-vite 5 + React 19 + zustand 5 + immer（patch/undo）+ TS 5.9 strict + ESLint 10 + Prettier 3 |
| 分层 | `src/shared`（纯逻辑，不 import renderer/main）← `src/main`（65+ IPC 注册）/ `src/preload`（contextBridge）↔ `src/renderer/src`（React）。**无循环依赖**（唯一一个是类型态可擦除的 `layout/types ↔ layout/accessory`） |
| IPC 面 | **70 条通道，主进程侧与 preload 侧逐条核对无缺失** |
| 自检 | `scripts/selfcheck.ts` → **2628 项断言**，全绿 |
| 往返 | `npm run verify`：21 个 `.xmind` + 4 个 `.emmx` 样本往返一致 |
| 规模 | `src/**` + `scripts/**` 共约 5.6 万行（拆分前 144 文件 / 56,681 行） |
| 提交 | 本战役累计 **55 个提交**，最新 `56e477d` |

### 2.2 已完成（任务表打钩项）

| 目标 | 结果 | 提交 |
|---|---|---|
| A1 `render/measure.ts` 724 | → **493** + `measure/{text-metrics,wrap,segments,style}.ts` | `9b5f077` |
| A2 `export/drawing.ts` 771 | → **162** + `export/{ops,node}.ts`（类型经 `export *` 兜住） | `8fdc8d6` |
| A3-1 `TopicNode.tsx` 619 | → **542** + `topic/{props,segment-style}.ts`（纯搬动部分） | `64ed49e` |
| D1 `scripts/selfcheck.ts` 11,844 | → **473**（−96%）：`harness.ts` 76 + `helpers.ts` 853（34 个共享助手）+ `domains/{edit,canvas,layout,ai,agent,io,ui,xmind}.ts` 8 个 | `a40bce9` / `1357011` / `72b35cf` / `b12c0f7` / `e45774b` / `8247a9d` / `232ca88` / `23bbf5f` / `e075a84` / `dcacfb4` |
| F1 `styles.css` 3650 | → `styles/*.css` **21 个** + `index.css`（按原顺序 @import；`main.tsx` 1 行改动） | `cca2c5b` |
| G1 `shared/import/markdown.ts` 807 | → **307** + `import/markdown/inline.ts`（内联解析连同类型一起搬） | `56e477d` |
| G2 文档 | `CHANGELOG.md` 增「解耦 · 单文件拆分」小节；`known-issues.md` 增「仍未做」与「经核对不成立的审计建议」表 | `8527fa3` 等 |
| E1（1 组） | `FOLD_SIDE_LABELS` 收敛到 `shared/model/fold-labels.ts` | `0054b68` |

**契约全部保持**：`scripts/selfcheck.ts` 仍是入口、`run-selfcheck.mjs` 一行未改、断言仍 2628 项、
所有拆分项的**调用点改动 0–1 行**。

### 2.3 剩余项（按建议顺序）

| 项 | 现状规模 | 性质 | 建议做法 |
|---|---|---|---|
| **C1** `src/main/index.ts` | **2,498** | 语义（需先建 `ctx`） | 通读文件 → 列出跨 IPC 域共享的状态（`stateOf`/`docOf`/窗口表/`allowClose`/`quitRequested`/`streamAborters`/自动保存槽位…）→ 定义 `interface MainContext`（**不放模块级可变单例**）→ 先让现有代码适配 `ctx`（单独一批、不改通道名）→ 再按 12 个 IPC 域搬进 `main/ipc/*`。**高危**：窗口关闭确认链路（`closeRequest`/`closeCancel`/`quitRequested`）与单实例心跳是跨域的，适配阶段必须保证回调顺序不变 |
| **B1** `src/renderer/src/store/editor.ts` | **2,316** | 语义为主 | 实测可机械搬走的只有约 10 个纯函数 / **99 行（4%）**；真正的工作是**纯逻辑下沉 `shared/model` + `store/slices/` 6 个**。注意 `aiTurn`/`viewLock`/`lastFold` 等跨域状态的归属要先画表 |
| **A4–A8** 渲染层 | `NodePanel.tsx` 814 / `Toolbar.tsx` 1059 / `ChatPanel.tsx` 1953 / `App.tsx` 1272 / `Canvas.tsx` 2951 | 纯语义 | 这些文件**主体都是一整个大函数/组件**（TopicNode 的 `TopicNodeInner` 480 行、NodePanel 组件 760 行），按"只搬不改"收益仅 2–4%。要**逐个整轮**做：抽子组件 / 抽 hooks。**守 `React.memo`**：回调 props 必须稳定引用，不许在拆分中引入内联箭头函数（该 memo 曾因 8 个内联箭头整体失效） |
| **A6 特别提示** | — | 高危 | `ChatPanel` 里 `runRoundRef`/`processQueueRef`/`commitTurnRef`/`stopRef` 是**打破循环引用的一组 ref**，必须**整体搬进同一模块**，拆散会变成"用到未初始化" |
| **A8 特别提示** | — | 高危 | `Canvas` 的 `viewportActions` 注册（模块级单例，卸载须复位为 `NOOP_VIEWPORT_ACTIONS`）与 `useLayoutEffect` 锚点补偿**依赖挂载顺序**；`refs` 一族是"指针跟手"的前提，不许改成 state |
| **A3-2 / A2 尾巴** | — | 语义 | TopicNode 抽子组件（外壳/文本/装饰/附件指示器/内联公式）；`export/drawing.ts` 的 `drawNode`/`drawOverlay`/`compose`（`nodeOps` 287 行、`buildDrawing` 114 行各是一个整函数） |
| **E1 余项** | 19 组里的其余 | 混合 | 判据：**抽原语，让调用点各自表达策略**，不是强行合一（差异可能是有意的） |
| **快照配额** | 已核实**本来就有**（`SNAPSHOT_LIMITS.perDoc`） | — | 无需改 |

---

## 三、方法学（这是本战役最值钱的部分）

### 3.1 拆分四步法（已验证 10+ 次）

1. **结构图**：`grep "^(export )?(async )?function [A-Za-z0-9_]+|^(export )?const [A-Za-z0-9_]+ =|^/\* -{10,}"` 拿到声明与行号。
2. **搬迁脚本**（放 `.tmp-check/`，node 显式 UTF-8 读写）：
   - **边界由结构决定**：`start = 声明行`，`end = 下一个边界行 − 1`，去掉尾部空行。**绝不手挑行号**。
   - 入口删这些区间，补 `import` / `export *`（保公开面，含类型）。
   - 新文件头 = 段注释 + **复制入口的导入块**（相对路径按新深度改写）。
3. **用门槛当簿记检查器**：`typecheck` 会精确指出"名字没导出/导入没人用/名字找不到/路径深度错"。
4. **固定收尾**：`npx eslint --fix <改动文件>` 清无用导入 → 去掉它给入口导入补的 `.ts` 后缀（`TS5097`）→ `npx prettier --write` → 五道门。

**两道守卫（必须带）**：①名单里的名字一个都不能找不到，否则不动源文件；②搬走的行数必须等于删除的行数。
（来历：一次 `styles.css` 拆分里，正则被 CRLF 挡掉、**一个区块都没匹配到却照样删了源文件**，靠 `git checkout` 恢复。）

### 3.2 必踩的坑（都已踩过）

| 坑 | 症状 | 正解 |
|---|---|---|
| 行范围切在注释中间 | 入口留孤立 `*/`、新文件未闭合 `/*`（`TS1109`/`TS1010`） | 用"顶层声明边界"算法，别手挑行号 |
| 相对路径深度算错 | 先报 `Cannot find module`，**紧接着把导入值推成 any、在别处报 `TS7006`** | **看到隐式 any 先查模块路径**；新文件深一层就把 `'../x'` 全改成 `'../../x'` |
| `export *` 不产生本地绑定 | 入口仍报 `Cannot find name Xxx` | 入口另写 `import type { Xxx } from './新模块'` |
| 类型没跟着走 | 子模块反向依赖入口 → 循环导入 | **类型跟着函数一起搬**（入口 `import type` 取用） |
| `eslint --fix` 的副产品 | 给入口导入补 `.ts` 后缀（`TS5097`） | 用正则去掉；用它之后必须再过一次 typecheck |
| CRLF | `$` 锚定的正则全部失效 | 读行用 `split(/\r?\n/)`；写回按原文行尾 |
| 自创"部分保留"逻辑 | 边界判断复杂 → 出错 | 要么整块搬（连依赖的类型/常量），要么整块留 |

### 3.3 审计结论已被证伪/纠偏 6 条（**不要照抄审计清单**）

| 审计说 | 实际 |
|---|---|
| "拖到中心主题前/后应报错" | **有意行为**，被自检断言钉住 |
| "`stop()` 应清 `requestIdRef`" | 清了会让终止 `aborted` 事件被 `handleEvent` 过滤掉，「已停止」标记与回合收尾一起消失 |
| "`runsToHtml` 是死代码" | **`scripts/selfcheck.ts` 的断言在用**（审计只 grep 了 `src/**`，漏了 `scripts/**`） |
| "快照单文档版本数无上限" | `prune` **本来就有**上限（`SNAPSHOT_LIMITS.perDoc` + 手动版本优先） |
| "边界落在连续同级之间依赖调用方自觉" | **布局侧本来就强制**（`resolveRange` 只在两端同一父级时展开连续兄弟） |
| "`FOLD_SIDE_LABELS` 直接复用 `@shared/agent`" | `TopicNode.tsx` **没有** `@shared/agent` 导入；且让画布依赖 AI 层是错误方向 → 下沉到 `shared/model/fold-labels.ts` |

**规矩**：删死代码前 grep 必须**同时覆盖 `src/**` 与 `scripts/**`**；审计给的"A 类 72 / B 类 129 死导出"要逐条自行复核后再删（已复核为"多余 export / barrel 冗余再导出"，**决定不做批量剪除**，理由见 `docs/known-issues.md`）。

---

## 四、待用户目视确认（agent 无法自证）

GUI 截图无法验证（本会话模型不声明图片输入、modlens 桥不可用），以下四项需要用户看一眼：

1. 带颜色的文字提交后是否正常显示（`measure.ts` 的 `resolveRun` 曾漏 `color`）；
2. 加概要后括号是否稳定在结构外侧（曾随节点尺寸翻边）；
3. 折叠大树时被折叠节点是否在原地不动、点空白取消选择时镜头是否停住（镜头锚定改动）；
4. **F1 之后界面样式是否与之前一致**（画布 / 侧面板 / 对话框）——拆分的风险在层叠顺序，理论上已由 `index.css` 的原顺序 @import 保证。

---

## 五、关键文档索引

| 文档 | 用途 |
|---|---|
| `docs/decoupling-plan.md` | **任务表**（15 项，含每项的目标结构/手法/调用点改动/风险/状态） |
| `docs/refactor-audit.md` | 全仓审读与解耦报告（分层结论、巨型文件拆分计划、执行顺序） |
| `docs/shared-audit.md` | `src/shared/**` 三遍独立审计（注意：多条结论已被证伪，见 §3.3） |
| `docs/known-issues.md` | 待修清单 + 本轮「处理结果」表 + 「经核对不成立的审计建议」表 + 「仍未做」 |
| `CHANGELOG.md` | 「未发布」段含本轮审计修复与「解耦 · 单文件拆分」小节 |
| `.tmp-check/*.mjs` | 本战役的可复用脚本（搬迁、补丁、守卫），gitignore，可自由改写 |

---

## 六、下一步建议（一句话）

**先做 C1**（`main/index.ts` 2,498 行，收益最大：解锁 12 个 IPC 域文件），按 §2.3 的 C1 步骤走；
若想先拿一个稳的，就做 **A3-2**（TopicNode 抽子组件，文件最小、上下文最好掌握）。