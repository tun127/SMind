# 待修问题清单（Known Issues）

> 生成时间：2026-09-14
> 最后处理：**2026-09-15**（见下方「处理结果」）
> 对应版本：0.6.0 起
> 排查方式：全仓只读审查（安全 / 健壮性 / 性能 / 资源泄漏 / 类型卫生 / 功能缺口），关键结论均已人工复核

每条含四项：**现象** → **证据（文件:行号）** → **建议改法** → **怎么验收**。
优先级：P0 会丢用户数据；P1 安全纵深；P2 性能；P3 工程规范；P4 分发；P5 功能缺口。

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

---

---

## P0 · 数据与健壮性（建议明天先做）

### P0-1 保存不是原子写，可能把用户原文件截断成坏包

- **现象**：保存时直接把字节写到目标路径（就地覆盖），没有"临时文件 + rename"。
- **证据**：`src/main/index.ts:284` —— `await fs.writeFile(path, Buffer.from(bytes))`（`writeDocument`）。
- **风险**：磁盘满 / 进程崩溃 / 断电发生在写入过程中，用户**原本能打开的 .xmind 会被截断**。序列化后的字节都在内存里，所以窗口很小，但后果是最严重的（丢的是原文件）。
- **建议改法**：写到同目录的 `xxx.xmind.tmp` → `fsync` → `fs.rename` 覆盖目标（同盘 rename 是原子操作）；任一步失败则删除临时文件，**原文件保持不动**并抛出可读错误。另存为/自动保存同样处理。
- **怎么验收**：①把目标目录设为只读或磁盘配额失败后，原文件仍能正常打开；②自检里对"临时文件名生成 + 失败清理"这段逻辑加断言。

### P0-2 没有错误边界，也没有进程级兜底 —— 出错就是白屏/静默退出

- **现象**：根渲染没有任何错误边界；主进程与渲染进程都没有崩溃兜底。
- **证据**：
  - `src/renderer/src/main.tsx:10` —— `createRoot(container).render(<App />)`，无 `ErrorBoundary`。
  - 全仓 `uncaughtException` / `unhandledRejection` / `render-process-gone` / `child-process-gone` / `componentDidCatch` **搜索零命中**。
  - 现实触发点举例：`src/shared/layout/core.ts:113` 的 `节点 X 尚未测量` 这类断言一旦抛出，整棵树卸载 → **白屏、无提示、无恢复**。
- **建议改法**：①渲染层加 `ErrorBoundary`（`getDerivedStateFromError`），兜底页给出「重新加载」「把当前内容另存一份」「恢复自动存档」三个出口；②主进程挂 `process.on('uncaughtException' | 'unhandledRejection')`，写日志到 `%APPDATA%\SMind\logs\`；③窗口上挂 `render-process-gone` / `did-fail-load` / `unresponsive`，提示并允许重开窗口。
- **怎么验收**：在某个组件里故意 `throw`，应看到可读错误页而不是白屏；杀掉渲染进程应看到提示而不是空窗口；`%APPDATA%\SMind\logs\` 里有记录。

### P0-3 自动保存失败被静默吞掉（"以为存上了，其实没存"）

- **现象**：自动保存的 Promise 没有 `.catch`，而旁边的版本快照有 —— 两边写法不一致。
- **证据**：`src/renderer/src/App.tsx:698` —— `void window.api.autosave(...)`（无 catch）；对照 `src/renderer/src/App.tsx:726` —— `.catch(() => undefined)`。
- **风险**：自动保存失败（磁盘满、目录只读、权限）完全不告知用户；叠加上 P0-2 连日志都没有。
- **建议改法**：加 `.catch`，并通过 toast/状态栏提示「自动保存失败（可能是磁盘空间不足）」；同时让主进程的 `autosave` 返回明确结果而不是抛裸错。
- **怎么验收**：把保存目录设为只读，30 秒内应看到失败提示，而不是毫无反应。

### P0-4 打开损坏文件时把 JSZip 的英文异常直接抛给用户

- **现象**：`.zip` 损坏时用户看到的是 JSZip 的原始英文异常。
- **证据**：`src/shared/xmind/parse.ts:314` —— `JSZip.loadAsync(data)` 未包 try/catch（其余情况如缺 `content.json`、JSON 非法、无画布都已有中文提示，见同文件 `:323`、`:334`、`:348`）。
- **建议改法**：包一层，抛出中文错误，例如「这个文件不是有效的 .xmind（压缩包已损坏）」，并在提示里给出「文件可能不完整，试试重新导出」。
- **怎么验收**：把任意 `.xmind` 截断一半后打开，应看到中文提示。

---

## P1 · 安全纵深

### P1-1 全仓没有 CSP

- **证据**：`src/renderer/index.html` 无 CSP meta；全仓无 `onHeadersReceived` / `Content-Security-Policy`。
- **影响**：渲染层一旦出现注入点就没有第二道防线（与 P1-2 叠加）。
- **建议改法**：生产构建下发 CSP，例如 `default-src 'self'; img-src 'self' data: blob: mind-resource:; style-src 'self' 'unsafe-inline'; font-src 'self' data:`。注意 KaTeX / TipTap 需要内联样式，**先在生产构建下把公式、富文本、图片、导出逐个回归**。
- **怎么验收**：DevTools 控制台无 CSP 违规；公式与富文本显示正常。

### P1-2 `sandbox: false`

- **证据**：`src/main/index.ts:436` —— 同时 `contextIsolation: true`、`nodeIntegration: false`（这两项是对的）。
- **建议改法**：试探性开启 `sandbox: true`（preload 只用 `contextBridge` + `ipcRenderer` 的话通常可行）；若被某个能力挡住，再单独评估并在此记录原因。
- **怎么验收**：功能全量回归（打开/保存/导出/导入/AI/历史）+ `selfcheck` 全绿。

### P1-3 IPC 入参校验不均，部分通道完全信任渲染进程

- **证据**：
  - `src/main/index.ts:689`（`openPath` 直接按传入路径读文件）
  - `src/main/index.ts:693`（`saveToPath` 直接按传入路径写文件）
  - `src/main/index.ts:1214`、`src/main/index.ts:1315`（`showItemInFolder` 任意路径）
  - `src/main/index.ts:1003`（`addImage` 只查 `byteLength === 0`，**没有大小上限**）
  - 对照做得好的：`src/main/index.ts:1306`（`openExternal` 只放行 `https?` / `mailto`）、`:842`/`:885`（设置与主题逐字段收敛）。
- **建议改法**：把这几处按 `openExternal` 的标准补齐 —— 路径校验（存在 / 是文件 / 扩展名白名单）、图片大小上限（例如 20 MB）与类型白名单；做成小工具函数以便复用与自检。
- **怎么验收**：自检里对校验函数写断言（超限、扩展名不符、路径不存在都要被拒）。

### P1-4 公式错误信息未转义就拼进 HTML 属性

- **现象**：全仓**唯一**一处未转义的 HTML 拼接。
- **证据**：`src/renderer/src/render/formula.ts:38` —— `title="${String(error.message)}"`，而这段 HTML 经 `dangerouslySetInnerHTML` 注入：`src/renderer/src/components/TopicNode.tsx:273`、`:322`。
- **影响**：异常消息里若含引号会逃逸出属性；理论上可由**外部导入的 .xmind 公式字段**触发（低危自 XSS）。
- **建议改法**：用已有的 `escapeHtml`（`src/shared/richtext/index.ts:88`）包一层，或改用 DOM API 设置 `title`。
- **怎么验收**：构造一个会报错且消息含 `"` 的公式，检查 DOM 属性未被逃逸。

### P1-5 导入的外部字段缺结构校验

- **证据**：`src/shared/xmind/parse.ts:123`、`:127` —— `titleRich` / `code` 用 `as unknown as` 直接强转，未逐字段校验。
- **影响**：坏数据会带着"未检类型"流进布局与渲染，可能引发 P0-2 的白屏。
- **建议改法**：项目已经有 `src/shared/guards.ts` 的 `isRecord`，把这两处补上逐字段校验，校验不过就丢弃该字段并保留纯文本兜底。
- **怎么验收**：自检加「坏 `titleRich` / 坏 `code` 不会让布局崩」的用例。

---

## P2 · 性能（大文档）

### P2-1 布局每次击键全量重算（与需求书承诺不符）

- **证据**：`src/renderer/src/components/Canvas.tsx:260-272` —— 布局 `useMemo` 依赖 `[workbook, editingId, editingText, editingRich, fontEpoch]`；而 `editingText` / `editingRich` **每敲一个字都变**。
- **对照承诺**：`docs/requirements.md:135` —— 「布局结果缓存：仅子树变更时局部重算」。
- **影响**：万级节点下每次击键都重跑全量布局；且视口裁剪只作用在**渲染**层（`Canvas.tsx:1468`），布局、测量、吸附候选仍是全量，"只渲染可视区"救不了大文档。
- **建议改法**：把编辑态与布局解耦 —— 编辑中只对"被编辑节点的子树"做局部测量与重排，或至少在尺寸未真正变化时不触发全量；提交编辑后再全量一次。
- **怎么验收**：万级节点文档里连续打字不掉帧（用 Performance 面板量化长任务）。

### P2-2 大纲面板零虚拟化

- **证据**：`src/renderer/src/components/OutlinePanel.tsx:42`（生成全部行）、`:256`（逐行渲染）。
- **建议改法**：只渲染视口内的行（或先用 `content-visibility: auto` 顶一阵）。
- **怎么验收**：1 万节点文档打开大纲不卡。

### P2-3 搜索没有防抖

- **证据**：`src/renderer/src/components/SearchPanel.tsx:47-48` —— 随 `search.query` 每次输入即时全树扫描。
- **建议改法**：输入防抖 150–250ms，并对结果数设上限提示。
- **怎么验收**：大文档里连续快速输入不卡顿。

### P2-4 `applyTopicFilter` 每次递归都拷贝路径数组

- **证据**：`src/shared/search/index.ts:241-247` —— `visit(child, [...trail, topic.id])`，复杂度放大到 n × 深度。
- **建议改法**：改用父指针回溯或用可变数组 + 回溯时 `pop()`。
- **怎么验收**：构造「10 层 × 1 万节点」用例，对比筛选耗时。

### P2-5 测量缓存到上限是整体 `clear()`

- **证据**：`src/renderer/src/render/measure.ts:646`、`src/renderer/src/render/formula.ts:41`、`:91`。
- **影响**：不是泄漏，但会造成"周期性一次性全失效"的卡顿抖动。
- **建议改法**：换成 LRU 或分批淘汰。

---

## P3 · 工程规范

| 编号 | 问题 | 证据 / 现状 | 建议 |
|---|---|---|---|
| P3-1 | **没有 ESLint / Prettier / .editorconfig** | 根目录全无；`package.json` 也没有 `lint` 脚本（而代码里已有 3 处 `eslint-disable`，说明规则是需要的：`Canvas.tsx:271`、`NodePanel.tsx:123`、`shared/export/pdf.ts:53`） | 接入 eslint + `@typescript-eslint` + `eslint-plugin-react-hooks` + prettier，先只把 error 级别接进 CI，避免存量告警淹没 |
| P3-2 | **没有 CI** | 无 `.github/` | 加 workflow：`npm ci` → `npx tsc --noEmit` → `npm run selfcheck` → `npm run verify`（均为纯 Node，ubuntu runner 即可）。1474 项断言与样本往返已经很值钱，接上 CI 才真正发挥作用 |
| P3-3 | **类型只开了 `strict`** | `tsconfig.json:9` | 逐步加 `noUncheckedIndexedAccess`（预计 30–80 处报错，**单独一次提交专门修**，别和功能混在一起）、`noUnusedLocals` / `noUnusedParameters`（预计个位数） |
| P3-4 | 缺 CHANGELOG / CONTRIBUTING / SECURITY | 有 README 与 THIRD-PARTY-NOTICES，其余无 | 至少在公开发布前补 CHANGELOG（可从 59 条提交归纳） |
| P3-5 | 仍有重复实现 | 备注 HTML 派生表达式两处一字不差：`src/renderer/src/store/editor.ts:1301` 与 `src/shared/ai/index.ts:336`；XML 转义两份：`src/shared/outline/index.ts:170` 与 `src/renderer/src/export/svg.ts:16`；历史别名：`src/main/index.ts:303` 的 `isPlainRecord = isRecord` | 各抽一处公共实现；删掉别名 |
| P3-6 | 提交习惯 | 本次把一整个会话的多主题改动合成了一笔提交（`7a5cf53`，24 文件）—— 因为改动在文件间交织，无法干净拆分 | 以后按主题收尾即提交，别再攒 |

---

## P4 · 分发

| 编号 | 问题 | 影响 | 备注 |
|---|---|---|---|
| P4-1 | 无代码签名 | 对方首次运行会看到 SmartScreen「未知发布者」，需点「仍要运行」 | 消除必须购买证书；过渡期可在 README 里写明这一点 |
| P4-2 | 无自动更新 | 升级要重新分发 exe | 可选 `electron-updater` + GitHub Releases |
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

## 附一 · 图标收尾（独立待办）

`scripts/make-icon.mjs` 画的仍是字母 **M**、注释写着「应用名 mind」，而产品名已是 **SMind**。
该文件当前与 HEAD 一致（未被改动）。收尾动作：把字母改成 **S**（含注释）→ `npm run icon` 重新生成各尺寸 PNG/ICO → 重新打包验证图标已嵌入 exe。
> 注意：`electron-builder.yml` 的 `productName`、`appId`、快捷方式名都已是 SMind，**只有图标字母没跟上**。

---

## 附二 · 已核查确认"没问题"的（明天不必再查）

| 项 | 结论 | 证据 |
|---|---|---|
| `mind-resource` 协议是否存在路径穿越 | **安全**。不是"按路径读文件"，而是拿路径当 key 查**内存资源表**，`../../` 匹配不到任何 key | `src/main/index.ts:567`、`:579` |
| 窗口导航/弹窗 | `setWindowOpenHandler` 一律 deny 并转 `shell.openExternal`；`will-navigate` 一律 `preventDefault` | `src/main/index.ts:470`、`:480` |
| 外部外链 | 只放行 `https?` / `mailto` | `src/main/index.ts:1306` |
| 类型逃逸 | `as any` / `@ts-ignore` / `@ts-expect-error` **零** | 全仓搜索 |
| 技术债标记 | `TODO` / `FIXME` / `HACK` **零**（注意 `src/renderer/src/export/katex-assets.ts` 的 base64 会造成误报） | 全仓搜索 |
| 定时器与 IPC 监听泄漏 | 均有清理；`ipcMain.handle` 只在启动注册一次，多窗口不会重复注册 | `App.tsx:705`、`:728`；`preload/index.ts:34-86`；`src/main/index.ts:606`、`:1355` |
| 外部数据的 HTML 入口 | 都不当 HTML 执行：备注只渲染纯文本、Markdown 导入丢弃整行 HTML、粘贴交给 ProseMirror schema 过滤、正文走 React 转义 | `NodePanel.tsx:502`；`shared/import/markdown.ts:562`；`RichTextEditor.tsx:126`；`TopicNode.tsx:276` |
| 渲染进程外壳 | `contextIsolation: true`、`nodeIntegration: false`（仅 `sandbox` 待议） | `src/main/index.ts:437`、`:438` |

---

## 附三 · 明天的建议顺序

1. **P0-1 原子保存** —— 改动最小、直接防丢数据。
2. **P0-2 + P0-3 错误边界 / 进程兜底 / autosave 加 catch** —— 可放同一笔提交，把"白屏与静默失败"变成"有提示、能恢复"。
3. **P0-4 + P1-4 + P1-5 三处小修** —— 损坏文件中文提示、公式 title 转义、导入字段结构校验（都小、都独立）。
4. **P3-2 + P3-1 接 CI 再补 lint** —— 一次投入长期受益，之后每次改动都有守门。
5. **P1-1 + P1-2 + P1-3 安全纵深** —— 需要回归验证，单独留出时间。

**P2 性能建议单独排一轮**（涉及布局与编辑态解耦，改动面最大，别和上面混做）。

改完任一项，记得同步更新 `docs/P1-acceptance.md` 的 §六 缺陷修复记录，并保持 `npm run selfcheck` 全绿。
