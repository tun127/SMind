# 交接文档：解耦战役（给新 agent 的提示词与现态总结）

> 更新：2026-09-19（第二次交接）｜ 仓库：`D:\Mind`（产品名 SMind）｜ 当前 HEAD：`f63c915`
> **本文件是自包含的**：新 agent 只读它 + 仓库本身即可继续，不需要回看之前的对话。
> 上一版（2026-09-19 早）写在 `git show 09bc991:docs/handover.md`，两版之间的进展：**C1 与 A3 已做完**。

---

## 一、可直接粘贴的提示词（建议整段发给新 agent）

```
你是 Mind（应用名 smind，仓库 D:\Mind）的**专业代码架构师**，对代码块的管理与修正更新负全责。
本次任务：继续执行 `docs/decoupling-plan.md` 里的**解耦任务表**，把剩余项按批次做完。
（主进程侧 C1 已完成、TopicNode 的 A3 已完成，剩下的都在渲染层：A4→A5→A6→A7→A8，最后 B1 与 E1 余项。）

【硬约束】
1. 只允许在工作区内改动；工作区外的操作必须先说明影响与可逆性并征得用户同意。
2. 每完成一项 = 一个提交，提交前必须过**五道门槛**且每道门单独打印退出码：
   npm run typecheck（含 tsconfig.strict.json）/ npm run lint（--max-warnings 0）/
   npm run format:check / npm run selfcheck / npm run verify
   —— 不要用 `;` 串联后只读一次 $LASTEXITCODE（会吞掉前面失败的门）；日志文件名别含冒号
   （`format:check` 会被 PowerShell 当成 drive，重定向失败后退出码是陈旧值）。
3. 行为零变化：拆分只搬代码；任何"顺手该修"的东西**另开提交**。
4. 每批提交信息写清：搬了什么、调用点改了几行、门槛结论、"未做行为改动"。
5. 汇报前必须亲手跑验证，并说清哪些验证过、哪些是推断；未验证的必须标注。
6. 源码编辑一律用 read/write/edit 工具；**绝不用 PowerShell 的 Get-Content+Set-Content 改源码**
   （会重编码整份文件、把中文注释写成乱码）。shell 只用于跑门槛、git、统计与核对。
7. 用户是中文交流，所有面向用户的输出用中文；内部推理用英文。

【固定动作】
- 开工前：`git status --short`（要干净）、`git log --oneline -5`，并读 `docs/decoupling-plan.md`
  的状态列与 `docs/known-issues.md` 的核对表——**不要只信记忆里的待办清单**（它会被压缩滞后）。
- 每批结束：提交 + 更新 `docs/decoupling-plan.md` 对应行的状态/提交号（状态列滞后会让下一个人白做）。
- 记忆：项目归属统一写 `Mind`；新踩的坑写进 lesson。

【已知约束（不要动）】
- `scripts/selfcheck.ts` 必须仍是自检入口（`scripts/run-selfcheck.mjs` 不依赖别的路径）。
- IPC 通道名（共 66 条）、`.xmind`/`.emmx` 写出字段、`styles/index.css` 的 @import 顺序都属"行为"，不许改。
- `React.memo` 的浅比较面不许扩大（见 §3.2 的 JSX 抽取配方）。
- `.tmp-check/` 是 gitignore 的脚本暂存区，可自由使用；`.dsh-meow/` 是记忆库，别碰。
```

---

## 二、现态总结

### 2.1 仓库与门槛

| 项 | 现状 |
|---|---|
| 技术栈 | Electron + electron-vite 5 + React 19 + zustand 5 + immer（patch/undo）+ TS 5.9 strict + ESLint 10 + Prettier 3 |
| 分层 | `src/shared`（纯逻辑）← `src/main`（IPC 注册）/ `src/preload` ↔ `src/renderer/src`（React） |
| IPC 面 | **66 条注册**，主进程侧与 preload 侧逐条核对无缺失 |
| 自检 | `scripts/selfcheck.ts` → **2628 项断言**，全绿（⚠️ 它只测 shared 逻辑与 store，**不渲染 React 组件**） |
| 往返 | `npm run verify`：21 个 `.xmind` + 4 个 `.emmx` 样本往返一致 |
| 提交 | 解耦战役累计 **20 个提交**，最新 `f63c915` |

**门槛运行注意点**（实测）：`selfcheck` 经 esbuild 起子进程，受限沙箱下会 `EPERM`（授权放开后直接跑即可）；
`format:check` 只覆盖 `src/**/*.{ts,tsx,css}`，**不管 `scripts/**` 与 `docs/**`**；
行数要在 `prettier` 之后再统计（它会把多行 JSX 重排）。

### 2.2 已完成（任务表打钩项）

| 目标 | 结果 | 提交 |
|---|---|---|
| A1 `render/measure.ts` 723 | → **493** + `measure/*` | `9b5f077` |
| A2 `export/drawing.ts` 771 | → **162** + `export/{ops,node}.ts` | `8fdc8d6` |
| **A3** `TopicNode.tsx` 619 | → **305**：`topic/` **11 个文件**（props / segment-style / markers / accessories / text-lines / label-row / image-block / formula-block / code-block / resize-handle / collapse-badges）。**外壳刻意不抽**（理由见 §2.4） | A3-1 `64ed49e`；A3-2 `0bb4812` `3fe548d` `329546a` |
| **C1** `main/index.ts` 2498 | → **65 行**（纯装配）：`context.ts`（跨域状态）+ `ipc/` **14 个域** + `ipc/index.ts` 调度器 + `windows/files/ai/autosave/themes/doc-resources/dialogs/env/resource-protocol/lifecycle.ts` | 8 批：`a8aebe6` `cdf8cff` `b2b0647` `e3aaf3c` `a7af884` `230d4c9` `7d7cbe8` `3a61e69`；文档 `7b3f2d1` |
| D1 `scripts/selfcheck.ts` 11,844 | → **473**（−96%）：`harness.ts` + `helpers.ts` + `domains/` 8 个 | 10 批 `a40bce9`–`dcacfb4` |
| F1 `styles.css` 3650 | → `styles/*.css` **21 个** + `index.css`（原顺序 @import） | `cca2c5b` |
| G1 `shared/import/markdown.ts` 807 | → **307** + `import/markdown/inline.ts` | `56e477d` |
| G2 文档收口 | CHANGELOG 增「解耦」小节、known-issues 增两表、refactor-audit 打勾 | `8527fa3` |
| E1（1 组） | `FOLD_SIDE_LABELS` 收敛到 `shared/model/fold-labels.ts` | `0054b68` |

**契约全部保持**：`selfcheck` 入口未动、断言仍 2628 项、66 条通道名未动、所有拆分项调用点改动 0–2 行。
**C1 的运行期已由用户目视验证通过**（关窗确认链路、多窗口、恢复提示、对话框、AI 回合）。

### 2.3 剩余项（按建议顺序）——**全在渲染层**

| 项 | 现状规模 | 性质与做法 | 高危点 |
|---|---|---|---|
| **A4** `NodePanel.tsx` | **814** | 按「选到节点 / 选到画布元素」两条分支拆组件 + 公共控件 | 面板内草稿 `useState` 跨组件后**不能重复初始化** |
| **A5** `Toolbar.tsx` | **1059** | 自洽组件直接搬家（主栏 / 结构切换 / 视图缩放） | 工具栏项数组里有**彼此依赖的禁用条件**，搬完要手点一遍逻辑分支 |
| **A6** `ChatPanel.tsx` | **1953** | 先抽纯函数与 runtime，再拆消息列表 / 工具条目 / 确认弹层 | **最高风险**：`runRoundRef` / `processQueueRef` / `commitTurnRef` / `stopRef` 是**打破循环引用的一组 ref，必须整体搬进同一模块**，拆散即"用到未初始化" |
| **A7** `App.tsx` | **1272** | 逐类副作用抽 hook（菜单事件 / 快捷键 / 自动保存 / 窗口关闭 / 标签同步 / 主题 / 剪贴板 / 启动） | 窗口关闭与未保存确认链路的 **effect 顺序与依赖数组不许变** |
| **A8** `Canvas.tsx` | **2951** | 先抽纯函数（命中测试 / 落点 / 手势数学），再抽 hooks，最后拆组件 | **最高风险**：`viewportActions` 注册（模块级单例，卸载须复位 `NOOP_VIEWPORT_ACTIONS`）与 `useLayoutEffect` 锚点补偿**依赖挂载顺序**；`refs` 一族是"指针跟手"的前提，**不许改成 state** |
| **B1** `store/editor.ts` | **2316** | 先下沉纯逻辑到 `shared/model`（有 selfcheck 断言保护），切片最后做 | 可机械搬走的只有约 10 个纯函数 / **99 行（4%）**；`aiTurn`/`viewLock`/`lastFold` 跨域状态要先画归属表 |
| **E1 余项** | 19 组里的其余 | 判据：**抽原语，让调用点各自表达策略**，不是强行合一 | 差异可能是有意的（见 §3.5） |

### 2.4 刻意不做 / 已论证不成立

- **`TopicNode` 的"外壳"不抽**：`.topic` 外层 div 的 `className` 数组与 `style` 对象依赖
  `visualFor` / `branchColorOf` / `dragPrimary` / `minNodeWidth` 等一组值，其中 `color`、
  `minNodeWidth`/`minNodeHeight` 折叠徽标与拉伸手柄也要用——抽出去要么重复计算、要么只剩一个空壳 div。
- **不批量剪除"死导出"**：清单条目是多余 `export` / barrel 冗余再导出，零运行时收益，且清单已被证伪多次。
- **不为让 lint 变绿去改高频路径的 ref 用法**（`refs`/`immutability`/`purity` 三条已实测留档）。

---

## 三、方法学（本战役最值钱的部分）

### 3.1 搬迁四步法（C1 十四个域 + D1 十批验证过）

1. **结构图**：用脚本扫顶层声明与**每一处注册的精确起止行**（多行写法靠括号配平识别，别肉眼数）。
2. **搬迁脚本**（放 `.tmp-check/`，node 显式 UTF-8 读写）：
   - **一次扫描 + 一次改写**：所有区间基于**同一份**行号，结构上不可能漂移。
     （教训：搬完一段会改变行号，手工推算连错两次。）
   - 连续相邻的注册**并成整段**（处理器之间常夹着共用的局部助手，只切处理器会把助手留在入口）。
   - 新文件头 = 段注释 + 复制入口的导入块（**深一层目录要把所有相对导入各多一层 `../`**，
     只改 `'./x'` 不够，漏改会以 TS2307 或"隐式 any"在别处炸）。
3. **用门槛当簿记检查器**：`typecheck` 精确指出"名字没导出 / 没导入 / 找不到 / 路径深度错"。
4. **固定收尾**：`eslint --fix` 清无用导入 → 去它补的 `.ts` 后缀（TS5097）→ `prettier --write` → 五道门。

**必备守卫**：①大括号配平；②**区间首尾不得落在块注释中间**、区间内 `/*` 与 `*/` 等量、
改写后入口注释标记仍平衡；③通道数/声明数相符；④**先全量校验、再统一落盘**（否则守卫失败会留下孤儿文件）；
⑤`expect` 校验必须与 `split/join`（replaceAll）配套——`String.replace(from,to)` **只替换第一处**。

### 3.2 JSX 抽取配方（A3-2 三批验证，A4–A8 直接复用）

1. **整块搬 JSX，一个字都不改**；
2. 外面包一层 `<></>` Fragment（**不产生 DOM 节点**，DOM 结构与层叠关系不变）；
3. **props 原样传**——子组件里用的名字与父组件局部**同名**（`markerColumns`/`side`/整个 `node`），
   所以块体零改动；
4. **不给子组件加 `memo`**、父组件回调**不重新包装** → `React.memo` 的浅比较面**完全没变**
   （该 memo 曾因 8 个内联箭头整体失效）；
5. 交互块照搬：`useState` 原 setter 直接当 prop 传，`useEditor.getState()` 仍在子组件里调用；
6. 类型只用推导式（`ReturnType<typeof f>`、`Props['x']`）并**如实跟随可空**（`boolean | undefined`），
   不手抄类型、不 `as`。

### 3.3 可复用工具（`.tmp-check/`，gitignore）

| 脚本 | 用途 |
|---|---|
| `ipc-map.mjs` | 扫出 `registerIpc` 内每一处注册的精确起止行与通道名 |
| `move-domains.mjs` | **批量**域搬迁：一次扫描一次改写 + 五道守卫 + 自动插 import 与注册调用 |
| `move-raw.mjs` | 顶层声明的整块搬迁（助手/常量，含 `--append`、`--allow-const-end`） |
| `extract-jsx.mjs` | **JSX 子组件抽取**（3.2 的配方），带括号/注释配平与"注释数量不变量"守卫 |
| `add-export.mjs` / `ensure-maincontext.mjs` / `fix-ipc-imports.mjs` | 补 `export`、补 `MainContext` 导入、修相对路径 |

### 3.4 必踩的坑（都已踩过）

| 坑 | 症状 | 正解 |
|---|---|---|
| 行范围切在注释中间 | 入口留孤立 `/**`，**它把后面的 `}` 注释掉**；大括号配平守卫**查不出来**（丢的 `}` 还在文件里） | 区间取"分节注释整行"或"声明行"为边界；加注释状态不变量 |
| 每删一段行号就变 | 手工推算的行号连错两次，切偏一行 | **一次扫描 + 一次改写**，别分段搬 |
| 占位调用被后续搬迁吞掉 | `registerXxxIpc(ctx)` 落进别人的区间被删，而通道数守卫看不出少一行 | 占位插在该域**最靠上**的区间处；每批 grep 数一遍调用行 |
| `String.replace` 只替换第一处 | 校验数出 3 处、落盘只改 1 处 | `expect` 与 `split/join` 配套 |
| 先写目标文件后校验父文件 | 守卫失败时已留下孤儿半成品文件 | **先全量校验、再统一落盘** |
| `prettier` 重排多行 JSX | 先量的行数与提交信息/文档不一致 | 行数在 prettier 之后统计 |
| 相对路径深度算错 | 先报 Cannot find module，**紧接着把导入值推成 any、在别处报 TS7006** | 看到隐式 any 先查模块路径 |
| `export *` 不产生本地绑定 | 入口仍报 `Cannot find name Xxx` | 入口另写 `import type { Xxx }` |
| CRLF | `$` 锚定的正则全部失效 | 读行用 `split(/\r?\n/)`；写回按原文行尾 |
| 自创"部分保留"逻辑 | 边界判断复杂 → 出错 | 要么整块搬（连依赖的类型/常量），要么整块留 |

### 3.5 审计结论已被证伪/纠偏（**不要照抄审计清单**）

| 审计说 | 实际 |
|---|---|
| "拖到中心主题前/后应报错" | **有意行为**，被自检断言钉住 |
| "`stop()` 应清 `requestIdRef`" | 清了会让终止 `aborted` 事件被 `handleEvent` 过滤掉，「已停止」标记与回合收尾一起消失 |
| "`runsToHtml` 是死代码" | **`scripts/selfcheck.ts` 的断言在用**（审计只 grep 了 `src/**`，漏了 `scripts/**`） |
| "快照单文档版本数无上限" | `prune` 本来就有上限（`SNAPSHOT_LIMITS.perDoc` + 手动版本优先） |
| "边界落在连续同级之间依赖调用方自觉" | 布局侧本来就强制（`resolveRange` 只在两端同一父级时展开连续兄弟） |
| "`FOLD_SIDE_LABELS` 直接复用 `@shared/agent`" | `TopicNode.tsx` 没有 `@shared/agent` 导入；让画布依赖 AI 层是错误方向 → 下沉到 `shared/model/fold-labels.ts` |

**规矩**：删死代码前 grep 必须**同时覆盖 `src/**` 与 `scripts/**`**。

---

## 四、待用户目视确认（agent 无法自证）

自检**不渲染 React 组件**，所以渲染层的验收只能靠眼睛：

1. **A3（本轮新抽的 9 个子组件）**：折叠徽标（双向展开结构左右各一根、分别收起；收起时显示后代数）、
   标记条（左/右竖排、两列规则）、附件/备注/链接三个指示图标（点击跳对应面板）、文本行与**行内公式**、
   底部标签行、节点内图片（含"图片缺失"占位）、公式块、代码块（语言下拉 + 高亮 + 拉伸等比缩放）、
   拉伸手柄（拖右下角改尺寸、双击恢复）；顺手回归选中/拖拽/AI 闪烁等类名效果。
2. 带颜色的文字提交后是否正常显示（`measure.ts` 的 `resolveRun` 曾漏 `color`）；
3. 加概要后括号是否稳定在结构外侧；4. 折叠大树时被折叠节点是否在原地不动、点空白取消选择时镜头是否停住；
5. **F1 之后界面样式是否与之前一致**（画布 / 侧面板 / 对话框）——层叠顺序风险由 `index.css` 的原顺序 @import 保证。

**已由用户验证通过**：C1 的主进程链路（关窗确认、多窗口、崩溃恢复提示、对话框挂当前窗口、AI 回合与终止）。

---

## 五、关键文档索引

| 文档 | 用途 |
|---|---|
| `docs/decoupling-plan.md` | **任务表**（含每项状态/提交号 + 执行记录） |
| `docs/refactor-audit.md` | 全仓审读与解耦报告（§四 执行顺序已逐条打勾） |
| `docs/known-issues.md` | 待修清单 + 处理结果表 + 「经核对不成立」表 + 「仍未做」 |
| `CHANGELOG.md` | 「未发布」段含本轮审计修复与「解耦 · 单文件拆分」小节 |
| `.tmp-check/*.mjs` | 本战役的可复用搬迁/抽取脚本（见 §3.3），gitignore，可自由改写 |

---

## 六、下一步建议（一句话）

**从 A4 `NodePanel.tsx`（814 行）开工**：按「选到节点 / 选到画布元素」两条分支拆组件，
先看面板内草稿 `useState`（跨组件后不能重复初始化），再套 §3.2 的 JSX 抽取配方；
之后 A5 → A6（先做 ref 环整体搬迁，单独一批）→ A7 → A8（独立留时间），最后 B1 与 E1 余项。