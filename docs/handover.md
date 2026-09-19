# 交接文档：解耦战役（给新 agent 的提示词与现态总结）

> 更新：2026-09-19（第三次交接）｜ 仓库：`D:\Mind`（产品名 SMind）｜ 当前 HEAD：`a87ff82`
> **本文件是自包含的**：新 agent 只读它 + `docs/decoupling-plan.md` + 仓库本身即可继续。
> 上一版（HEAD `f63c915`）写在 `git show f63c915:docs/handover.md`，两版之间的进展：
> **A4 / A5 / A6 / A7 全部做完（A3 与 C1 更早）**，renderer 层仅剩 A8。

---

## 一、可直接粘贴的提示词（建议整段发给新 agent）

```
你是 Mind（应用名 smind，仓库 D:\Mind）的**专业代码架构师**，对代码块的管理与修正更新负全责。
本次任务：继续执行 `docs/decoupling-plan.md` 里的**解耦任务表**，把剩余项按批次做完。
（C1 / A1–A7 已完成，剩下的按建议顺序：A8 → A6-3 / A7-3 → B1 → E1 余项；
计划表 §八「仍未做」里每一项都写了配方与红线，先读它再动手。）

【硬约束】
1. 只允许在工作区内改动；工作区外的操作必须先说明影响与可逆性并征得用户同意。
2. 每完成一项 = 一个提交，提交前必须过**五道门槛**且每道门单独打印退出码：
   npm run typecheck（含 tsconfig.strict.json）/ npm run lint（--max-warnings 0）/
   npm run format:check / npm run selfcheck / npm run verify
   —— 不要用 `;` 串联后只读一次 $LASTEXITCODE（会吞掉前面失败的门）；日志文件名别含冒号
   （`format:check` 会被 PowerShell 当成 drive，重定向失败后退出码是陈旧值）。
   —— 受限沙箱下 `npm run selfcheck` 经管道（`| Tee-Object`）会 EPERM；
      改用文件重定向 `npm run selfcheck *> 日志文件` 即可，不必提权。
   —— **看门槛输出别截断**：`Select-Object -Last N` 会吞掉前面的错误，本轮因此漏看过 3 处 TS 报错。
3. 行为零变化：拆分只搬代码；任何"顺手该修"的东西**另开提交**。
4. 每批提交信息写清：搬了什么、调用点改了几行、门槛结论、"未做行为改动"。
5. 汇报前必须亲手跑验证，并说清哪些验证过、哪些是推断；未验证的必须标注。
6. 源码编辑一律用 read/write/edit 工具；**绝不用 PowerShell 的 Get-Content+Set-Content 改源码**
   （会重编码整份文件、把中文注释写成乱码）。shell 只用于跑门槛、git、统计与核对。
   （搬迁脚本可以写在 `.tmp-check/*.mjs` 里用 node 显式 UTF-8 读写——这是本战役验证过的做法。）
7. 用户是中文交流，所有面向用户的输出用中文；内部推理用英文。

【固定动作】
- 开工前：`git status --short`（要干净）、`git log --oneline -5`，并读 `docs/decoupling-plan.md`
  的**任务表状态列 + §八 仍未做** 与 `docs/known-issues.md` 的核对表——不要只信记忆里的待办清单。
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
| IPC 面 | **66 条注册**，主进程侧与 preload 侧逐条核对无缺失（C1 后未变） |
| 自检 | `scripts/selfcheck.ts` → **2628 项断言**，全绿（⚠️ 它只测 shared 逻辑与 store，**不渲染 React 组件**） |
| 往返 | `npm run verify`：21 个 `.xmind` + 4 个 `.emmx` 样本往返一致 |
| 提交 | 解耦战役累计 **33 个提交**，最新 `a87ff82` |
| 门槛注意 | `format:check` 只覆盖 `src/**/*.{ts,tsx,css}`；**行数统计别用 PowerShell 的 `Get-Content`**（见 §3.4 第一条坑），也别在 `prettier` 之前统计 |

> **行数口径（node 实测，2026-09-19 更正）**：A4 `NodePanel.tsx` **142**（814 →）、A5 `Toolbar.tsx` **322**（1059 →）、
> A6 `ChatPanel.tsx` **417**（1953 →，另 `chat/use-chat-loop.ts` 1274）、A7 `App.tsx` **466**（1272 →）；
> A3 `TopicNode.tsx` 305、`main/index.ts` 54、`scripts/selfcheck.ts` 473、`Canvas.tsx` 2951、`store/editor.ts` 2316。
> 各提交信息里写的 133 / 310 / 386 / 443 是 `Get-Content` 口径（偏小），**以本表为准**。

### 2.2 已完成（任务表打钩项）

| 目标 | 结果 | 提交 |
|---|---|---|
| A1 `render/measure.ts` 723 | → **493** + `measure/*` | `9b5f077` |
| A2 `export/drawing.ts` 771 | → **162** + `export/{ops,node}.ts` | `8fdc8d6` |
| A3 `TopicNode.tsx` 619 | → **305**：`topic/` 11 个文件（外壳刻意不抽） | `64ed49e` + `0bb4812` `3fe548d` `329546a` |
| A4 `NodePanel.tsx` 814 | → **133**：`nodePanel/` 7 个（草稿 state 不下沉） | `8441f54` |
| A5 `Toolbar.tsx` 1059 | → **310**：`toolbar/` 11 个（按「整组」搬） | `c11e365` |
| A6 `ChatPanel.tsx` 1953 | → **386**：`chat/` 10 个展示/纯函数模块 + `use-chat-loop.ts`（runtime 整块） | `fa7d843` + `a5bc249` |
| A7 `App.tsx` 1272 | → **443**：`app/` 8 个 hook（关窗链路刻意不搬） | `394e1f1` + `f55a2af` |
| C1 `main/index.ts` 2498 | → **65**：`context.ts` + `ipc/` 14 域 + 10 个下沉模块 | 8 批 `a8aebe6`…`3a61e69` |
| D1 `scripts/selfcheck.ts` 11,844 | → **473**：`harness.ts` + `helpers.ts` + `domains/` 8 个 | 10 批 `a40bce9`–`dcacfb4` |
| F1 `styles.css` 3650 | → `styles/*.css` 21 个 + `index.css`（原顺序 @import） | `cca2c5b` |
| G1 `shared/import/markdown.ts` 807 | → **307** + `import/markdown/inline.ts` | `56e477d` |
| G2 文档收口 | CHANGELOG 增「解耦」小节、known-issues 增两表、refactor-audit 打勾 | `8527fa3` |
| E1（1 组） | `FOLD_SIDE_LABELS` 收敛到 `shared/model/fold-labels.ts` | `0054b68` |

**契约全部保持**：`selfcheck` 入口未动、断言仍 2628 项、66 条通道名未动、所有拆分项调用点改动 0–2 行。
**C1 的运行期已由用户目视验证通过**（关窗确认链路、多窗口、恢复提示、对话框、AI 回合）。
**A4–A7 只过了自动化门槛**，渲染层行为仍需人眼验收（见 §四）。

### 2.3 剩余项（按建议顺序）

| 项 | 现状规模 | 性质与做法 | 高危点 |
|---|---|---|---|
| **A8** `Canvas.tsx` | **2951** | 先抽纯函数（命中测试 / 落点 / 手势数学），再抽 hooks（视口 / 跟随 / 拖拽 / 框选），最后拆组件 | **最高风险**：`viewportActions` 注册（模块级单例，卸载须复位 `NOOP_VIEWPORT_ACTIONS`）与 `useLayoutEffect` 锚点补偿**依赖挂载顺序**；`refs` 一族是"指针跟手"的前提，**不许改成 state** |
| **A6-3** `chat/use-chat-loop.ts` | **1274** | 按域函数收显式 deps 对象（函数体用解构还原局部名，逐字不动） | `handleEvent`/`send` 带 `useCallback` 依赖数组：deps 对象必须稳定，否则订阅 effect 重跑会掐掉正在跑的 AI 回合 |
| **A7-3** `App.tsx` 入口 | **466** | 关窗链路 + `pending` 弹窗 + JSX 装配 | 数据安全关键路径：改完只能人肉验收（自动存档、逐个标签询问、取消回执主进程） |
| **B1** `store/editor.ts` | **2316** | 先下沉纯逻辑到 `shared/model`（有 selfcheck 断言保护），切片最后做 | 可机械搬的只有约 10 个纯函数 / **99 行（4%）**；`aiTurn`/`viewLock`/`lastFold` 跨域状态要先画归属表 |
| **E1 余 18 组** | — | 判据：**抽原语，让调用点各自表达策略**，不强行合一 | 差异可能是有意的（见 §3.5） |

### 2.4 刻意不做 / 已论证不成立

- **`TopicNode` 的"外壳"不抽**：`.topic` 外层 div 依赖 `visualFor`/`branchColorOf`/`minNodeWidth` 一组值，
  抽出去要么重复计算、要么只剩空壳 div。
- **面板级 `useState` 不下沉**（A4 的结论，A6/A7 沿用）：挂载点会变的组件不许接管草稿 state。
- **不批量剪除"死导出"**：清单条目是多余 `export` / barrel 冗余再导出，零运行时收益，且清单已被证伪多次。
- **不为让 lint 变绿去改高频路径的 ref 用法**（`refs`/`immutability`/`purity` 三条已实测留档）。

---

## 三、方法学（本战役最值钱的部分）

### 3.1 搬迁四步法（C1 14 个域 + D1 10 批 + A6/A7 验证过）

1. **结构图**：用脚本扫顶层声明与**每一处块的精确起止行**（靠括号配平与标记识别，别肉眼数）。
2. **搬迁脚本**（放 `.tmp-check/`，node 显式 UTF-8 读写）：
   - **一次扫描 + 一次改写**：所有区间基于**同一份**行号，结构上不可能漂移。
   - 新文件头 = 段注释 + 导入块（**深一层目录要把所有相对导入各多一层 `../`**）。
   - **路线选择**：单文件内整块切分用**行区间**（A6-2/A7）；跨文件按名字挑代码用**标记匹配**（A7 的导入修复）。
3. **用门槛当簿记检查器**：`typecheck` 精确指出"名字没导出 / 没导入 / 找不到 / 路径深度错"。
   （⚠️ **别截断门槛输出**，`-Last N` 会吞掉真正的错误。）
4. **固定收尾**：`eslint --fix` 清无用导入 → 去它补的 `.ts` 后缀（TS5097）→ `prettier --write` → 五道门。

**必备守卫**：①区间**首行与末行的连续序列**都要断言（A7-2 就是靠这条拦下"末行停在 `)`"）；
②区间不重叠；③**先全量校验、再统一落盘**（否则守卫失败会留下孤儿文件）；
④`expect` 校验必须与 `split/join`（replaceAll）配套——`String.replace(from,to)` **只替换第一处**；
⑤**行多重集守卫**（`.tmp-check/line-guard.mjs <旧文件> <新文件...>`）：把「拆分前 vs 拆分后」的
trimmed 行做多重集 diff，旧文件独有的行**必须逐条能解释**。这是 1000 行级搬迁唯一可信的"没搬丢"证据。

### 3.2 JSX 抽取配方（A3-2 / A4 / A5 验证过）

1. **整块搬 JSX，一个字都不改**；
2. 外面包一层 `<></>` Fragment（**不产生 DOM 节点**）；
3. **props 原样传**——子组件里用的名字与父组件局部**同名**，所以块体零改动；
4. **不给子组件加 `memo`**、父组件回调**不重新包装** → `React.memo` 的浅比较面**完全没变**；
5. 交互块照搬：`useState` 原 setter 直接当 prop 传，`useEditor.getState()` 仍在子组件里调用；
6. 类型只用推导式（`ReturnType<typeof f>`、`Props['x']`）并**如实跟随可空**，不手抄类型、不 `as`。

### 3.3 可复用工具（`.tmp-check/`，gitignore）

| 脚本 | 用途 |
|---|---|
| `line-guard.mjs` | **行多重集守卫**（通用参数化：旧文件 + 任意个新文件） |
| `move-chat-loop.mjs` | A6-2：runtime 整块下沉（15 段区间 + 首末行标记守卫） |
| `move-app-effects.mjs` | A7-1：7 个 hook（9 段区间，每段首行 + 末行序列） |
| `move-app-doc-actions.mjs` | A7-2：回调组整组下沉 |
| `fix-app-hook-imports.mjs` / `fix-app-hook-imports2.mjs` | 生成 hook 导入块（后者＝按门槛报告的名字逐条补） |
| `fix-app-hook-deps.mjs` | 依赖数组按期望次数替换（补稳定项） |
| `extract-jsx.mjs` / `move-domains.mjs` / `move-raw.mjs` / `ipc-map.mjs` | 前几轮的工具（A3/D1/C1） |

### 3.4 必踩的坑（都已踩过）

| 坑 | 症状 | 正解 |
|---|---|---|
| **用 `Get-Content` 统计行数** | 数字比实际小（本轮 A7 完工时报 443，实际 **466**）；因为本机 `Get-Content` 按 GBK 解码，**吞掉 LF-only 文件里紧跟中文的换行符**（实测 5 行临时文件被数成 2 行；CRLF 文件不受影响，所以仓库里旧文件量得准、新文件量不准） | 行数一律用 **node**：`fs.readFileSync(f,'utf8').split('\n').length`，或直接看 `read` 工具的末行号。`.editorconfig` 要求 LF，所以新文件是 LF、旧文件是 CRLF，两者混用是现状（不是本轮引入的问题） |
| 行范围切在注释中间 | 入口留孤立 `/**`，**它把后面的 `}` 注释掉**；配平守卫查不出来 | 区间取"分节注释整行"或"声明行"为边界；首末行**都**断言 |
| 每删一段行号就变 | 手工推算的行号连错两次 | **一次扫描 + 一次改写**，别分段搬 |
| **导入块的边界算错** | 把**模块级助手**（`applyRenderDefaults` 等）当成导入块复制进每个 hook，符号重复定义/未使用一片红 | 导入块边界＝**第一个模块级 doc 注释之前**，不是「到组件函数那一行」 |
| **助手函数被搬进 hook 体内** | lint 报 `exhaustive-deps`："该函数让依赖每次渲染都变" | 模块级助手必须落在 hook 函数**闭合之后**；搬完 grep 一眼确认缩进层级 |
| **从入口现有导入推导 hook 的导入** | hook 里 `Cannot find name 'viewportActions'/'beginCost'/'stageTypedChar'`；甚至把入口对 hook 自身的导入复制进 hook（自引用） | 入口的导入块**已被 eslint 裁剪**，推不出来；按**门槛报告的名字**逐条补 |
| `String.replace` 只替换第一处 | 校验数出 3 处、落盘只改 1 处 | `expect` 与 `split/join` 配套 |
| 先写目标文件后校验父文件 | 守卫失败时已留下孤儿半成品文件 | **先全量校验、再统一落盘** |
| `prettier` 重排多行 JSX | 先量的行数与提交信息/文档不一致 | 行数在 prettier 之后统计 |
| 相对路径深度算错 | 先报 Cannot find module，**紧接着把导入值推成 any、在别处报 TS7006** | 看到隐式 any 先查模块路径 |
| CRLF | `$` 锚定的正则全部失效 | 读行用 `split(/\r?\n/)`；写回按原文行尾 |
| 门槛输出被截断 | 以为只有 3 个错，其实有 10 个 | 用 `Select-String -Pattern 'error TS'` 全量列，或看日志文件 |

### 3.5 审计结论已被证伪/纠偏（**不要照抄审计清单**）

| 审计说 | 实际 |
|---|---|
| "拖到中心主题前/后应报错" | **有意行为**，被自检断言钉住 |
| "`stop()` 应清 `requestIdRef`" | 清了会让终止 `aborted` 事件被 `handleEvent` 过滤掉，「已停止」标记与回合收尾一起消失 |
| "`runsToHtml` 是死代码" | **`scripts/selfcheck.ts` 的断言在用**（审计只 grep 了 `src/**`，漏了 `scripts/**`） |
| "快照单文档版本数无上限" | `prune` 本来就有上限（`SNAPSHOT_LIMITS.perDoc` + 手动版本优先） |
| "`FOLD_SIDE_LABELS` 直接复用 `@shared/agent`" | 让画布依赖 AI 层是错误方向 → 下沉到 `shared/model/fold-labels.ts` |

**规矩**：删死代码前 grep 必须**同时覆盖 `src/**` 与 `scripts/**`**。

### 3.6 拆分判据（A5–A7 攒下来的，动手前先过一遍）

1. **effect 有顺序语义，回调没有**：只有 `useEffect`/`useLayoutEffect` 的**声明顺序**是行为的一部分。
   所以「一组回调」可以整组搬走而不影响行为，但**每个 hook 的调用点必须落在它原来那个 effect 的位置**，
   否则 effect 顺序就变了（A7 全程按这条做，effect 顺序与拆分前逐一对应）。
2. **函数身份（`useCallback` 依赖数组）也是行为的一部分**：订阅类 effect 的依赖一旦变化，
   cleanup 会跑（A6 的订阅 effect cleanup 会 `stop()` + `commitTurn()`，重跑＝掐掉正在跑的回合）。
   把组件作用域里的稳定值（React setter / RefObject / 模块级函数）改成 hook 入参时，
   **规则会要求把它们列进依赖数组——列进去是安全的**（身份恒定），但**别把每渲染都新建的闭包列进去**。
3. **state 不下沉**：挂载点会变（条件渲染 / 分支组件）的地方，草稿 state 必须留在最外层；
   搬进去会让 remount 重置它（这是"等价性"推理最容易出错的地方，直接按位置取胜）。
4. **任务表与 DoD 冲突时**：正确性红线优先（如"ref 环不可跨文件拆"），把行数超限**如实记进 §八**并写配方，
   不要为了对齐行数去冒行为变化的风险。

---

## 四、待用户目视确认（agent 无法自证）

自检**不渲染 React 组件**，所以渲染层的验收只能靠眼睛。**A4–A7 的改动尚未经过任何人眼验收**：

1. **A4 节点属性面板**：三条分支（选到节点 / 选到画布元素 / 未选中）+ 四段（标记图标 / 图片 /
   附件 / 画布元素列表）；草稿类输入（备注、超链接、公式、代码、标签）编辑中途切选中对象的行为。
2. **A5 工具栏**：各组按下态/禁用态/提示语、右键"收进更多 ▾"、更多菜单里的"移回快捷栏 / 拿出到快捷栏"、
   导入导出与 AI 下拉菜单的弹出位置。
3. **A6 聊天面板**：一整轮 AI 对话（工具调用、破坏性操作确认、停止、切文档中止、清空对话、
   撤销合并成一步、改动节点闪烁、思维链折叠、token 用量）。
4. **A7 应用外壳**：菜单命令逐条、快捷键（选中后直接打字进入编辑、粘贴 Markdown、粘贴图片）、
   拖文件三种去处、自动保存与崩溃恢复提示、窗口标题与多窗口聚焦、
   **关窗与未保存确认（含多标签逐个询问、取消回执）**。
5. A3 新抽的 9 个子组件（折叠徽标双向、标记条、三个指示图标、文本行与行内公式、标签行、
   图片/公式/代码块、拉伸手柄），外加原有的 4 项（带色文字、概要括号、折叠镜头锚定、F1 后样式一致性）。

**已由用户验证通过**：C1 的主进程链路（关窗确认、多窗口、崩溃恢复提示、对话框挂当前窗口、AI 回合与终止）。

---

## 五、关键文档索引

| 文档 | 用途 |
|---|---|
| `docs/decoupling-plan.md` | **任务表**（状态/提交号 + 执行记录 + §八 仍未做＝下一批的配方） |
| `docs/refactor-audit.md` | 全仓审读与解耦报告（§四 执行顺序已逐条打勾） |
| `docs/known-issues.md` | 待修清单 + 处理结果表 + 「经核对不成立」表 + 「仍未做」 |
| `CHANGELOG.md` | 「未发布」段含本轮审计修复与「解耦 · 单文件拆分」小节 |
| `.tmp-check/*.mjs` | 本战役的可复用搬迁/守卫脚本（见 §3.3），gitignore，可自由改写 |

---

## 六、下一步建议（一句话）

**从 A8 `Canvas.tsx`（2951 行）开工**：先只做「纯函数」（`clipText`、`GROWTH_REACH` 一族常量、
`screenToWorld`/`hitTest`/`dropIndex`/`axesOf`/`snapRegionOf`/`zoneForPointer`/`sideFlipTarget`/
`childGrowth`/`insertAxis`）——**一案一批**，每批都跑五道门 + 行多重集守卫；
`viewportActions` 注册、`useLayoutEffect` 锚点补偿、`refs` 一族三条红线在计划表 §八 里写清了，
碰它们之前先想清楚挂载顺序。A8 做完再回去收 A6-3 / A7-3，最后 B1 与 E1 余项。