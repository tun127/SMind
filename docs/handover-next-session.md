# 交接：给下一个会话的提示词与现态（2026-09-21）

> 用法：**把 §1 整段粘给新会话的 agent**；它自己会读 §2–§6。
> 本文件自包含：入口、门槛、配方、坑、验收清单都在里面，不依赖上文。
> 权威顺序：仓库文档 > 本文件 > 记忆。任务表见 `docs/decoupling-plan.md`，发版/自动更新方案见
> `docs/auto-update-test-plan.md`（§9 分工 + §附 后的 T7 补记）。

---

## 1. 可直接粘贴的提示词

```
你接手 D:\Mind（产品名 SMind，Electron + React 桌面思维导图软件）与 D:\smind-site（官网，纯静态）。
先读 docs/handover-next-session.md（交接文件，含现态、配方、坑），再读 docs/auto-update-test-plan.md
（0.9.2 自动更新测试方案）。开工前先：
  1) 两个仓库各跑 git log --oneline -5 + git status --short，用仓库校正本文件的现态；
  2) 在 D:\Mind 跑一遍五道门槛，确认基线全绿：
     npm run typecheck && npm run lint && npm run format:check && npm run selfcheck && npm run verify
     （每道门**单独打印退出码**；日志重定向前先确认目录存在，否则会静默失败）
本轮的活（按顺序，一次做完一批再统一交付）：
  A. 修两个编辑器 bug（配方见 §3，已细到行号）：
     A1 行内代码 `code` 在提交时被丢弃（数据/格式真丢，最严重）
     A2 行内 markdown 的中文紧贴写法不触发（**粗体** 类），并修正 RichTextEditor.tsx:45 与实现矛盾的注释
     A3 输入法组词期编辑框宽度冻住（拼音折成多行）——用"组词期 DOM 层临时放宽"的最小改法
  B. 版本号推到 0.9.2 → 按 docs/auto-update-test-plan.md 走 D2/D3/D4（打 rt.x 验证 → 改回 OSS 源重打包 →
     用户上传真 0.9.2 → 真机首跑验收）
硬约束（违反即返工）：
  - 不动 AI 执行的事务语义（回合分组 / 撤销粒度 / 快照 / inverse 顺序 / 熔断）；不动试用计数、isPro 闸门、
    许可校验、IPC 通道契约（70 常量 / 66 注册，有静态断言守着）；
  - 不动任何对外口径（价格 / 发货方式 / 免费边界 / 退款条款）；
  - 每修一条 bug 补一条自检断言（自检数只增不减，现 2759）；每批过五道门槛；
  - 测试构建版本号一律带 -rt.N / -alpha.N 且从不上传；绝不覆盖线上 0.9.1 的四个资产。
汇报要求：每批给「提交号 + 五道门槛退出码 + 实测证据（不是"看起来没问题"）」；做不到或有偏离要明确交底。
```

---

## 2. 现态（2026-09-21 实测）

| 项 | 值 |
|---|---|
| `D:\Mind` | HEAD `3685e94`，**与 origin 同步**（工作树只有别人在飞的 `docs/ops.md` 未提交） |
| `D:\smind-site` | HEAD `e4ef236`，**与 origin 同步** |
| 自检 | **2759 项断言**全绿（`npm run selfcheck`）；五道门槛 + `npm run build` 全绿 |
| 官网线上 | 令牌 P0+P1 已上线、批次 A（脚注断词 / 徽章去 emoji / Pro 文字色 / 镜像探测 2.5s 超时）已上线、阶段 1+2（数字带字号修复 / 108MB / 25 样本 / WebP 图片）已推送 |
| 更新源 | `electron-builder.yml` = `generic` → **GitHub Releases 固定直链**；OSS 那行是注释（D3 要切回来） |
| 自动更新 | D1 的**两处修复已落地并推送**（`43aadc1`：`isUpdateAvailable` 判定 + updater 日志接 `logMain`，自检 2753→2759） |
| 站点构建 | 无 lint/format 门槛（纯 HTML + 内联 CSS/JS，无 package.json） |

**本次会话（我）完成的提交**：`43aadc1`（updater 两处修复）、站点 `b6d450f`（批次 A）、`7323269`（阶段 1+2）。
其余提交（`3685e94` 开发计划与测试方案、`e4ef236` 站点渠道改动、ops 台账若干）来自方案方/文书方。

---

## 3. 待办 A：两个编辑器 bug（配方到行号；本轮**一行代码都没改**）

### A1 行内代码在提交时被丢弃（最严重：格式真丢）

- 机制：`shared/richtext/index.ts:264-280` 的 `marksToStyle()` 只认 `color / fontSize / fontFamily`
  （+粗斜删上标下标高亮），**不认 TipTap 的 `code` mark**；而同一文件 `:108-112` 的注释已写明
  「代码库里**等宽的唯一表示是 `fontFamily`**……哪天真要走到 `<code>`，先把类型对齐到 fontFamily 口径」。
- 后果：`神经网络\`前向传播\``（行内代码是**唯一中文紧贴也触发**的写法）→ 反引号被输入规则吃掉、
  格式在提交时被丢 → 字面什么都不剩。
- 修法：① `marksToStyle` 见到 `code` → 输出等宽 `fontFamily`；② 反向（`runToMarks`）见到那个等宽值
  → 还原成 `code`（否则再进编辑态就不是代码格式、工具条状态也不对）。
  等宽常量现在在 `shared/import/markdown/inline.ts`（`MD_MONO_FONT`）；richtext 反向依赖它要留意方向，
  建议把它提到中立模块再由两边引用。
- 断言：TipTap doc 带 `code` mark → `tiptapToRich` 后 `fontFamily` 在；`rich → tiptap → rich` 往返不丢。

### A2 中文紧贴的行内 markdown 不触发

- 机制：自定义规则全部要求**行首或空格**——`RichTextEditor.tsx:30`（`==` 高亮）、`:46`/`:47`
  （`^上标^` / `[^脚注]`）、`:60`（`~删除~`），形态都是 `(?:^|\s)` / `(?<=^|\s)`；StarterKit 的粗斜体同理。
  所以 `神经网络**粗体**`、`a^2^`、`a~1~` 都不触发（星号/波浪号留在文字里）。
- **同时发现注释与实现矛盾**：`RichTextEditor.tsx:45` 写着"紧贴写法也要生效"，与正则不符——二选一。
- 修法：把前导边界放宽到「行首 / 空白 / **CJK 字符**」（**不要**放宽到字母数字，否则 `2*3` 那类会误触发）；
  或明确改注释说明"紧贴不生效"。要动就动成一致的。

### A3 输入法组词期编辑框宽度冻住（拼音折成多行）

- 机制（已用代码确认）：布局**确实吃草稿**——`use-canvas-layout.ts:90` 用
  `{ ...topic, title: editingText, titleRich: editingRich }` 测量，依赖数组 `:114` 也含它们；
  `RichTextEditor.tsx:228-235` 每次 `node.width` 变就把编辑框宽度重设成「节点宽 − 2×paddingX」（上限 `TEXT_MAX`）。
  但**组词文本只存在于 DOM**：`RichTextEditor.tsx:271-289` 的 composition 处理器只处理被预注入的首字母，
  不同步组词文本；ProseMirror 到 `compositionend` 才同步 → 组词那几百毫秒 `editingText` 不变 → 宽度冻住。
  纯 ASCII 直接敲是**会**跟着变宽的（所以这条是组词专属，不是另一条路径）。
- 修法（推荐 A）：`compositionupdate` 期按 `event.data` 长度算一个**纯 DOM 宽度提示**临时放宽
  （`dom.style.width = 现宽 + 组词语宽`），`compositionend` 立即还原；**不碰测量链路、不进文档**。
  备选 B：让测量也吃 DOM 组词文本（彻底但要改测量链路）；C：允许溢出节点（会把 `2c172b3` 修掉的长 URL 撑框放回来）。

---

## 4. 待办 B：0.9.2 发版 + 自动更新首跑

照 `docs/auto-update-test-plan.md`（**先读它**，含 14 条用例、通过判据、回滚、分工）：

| 步 | 内容 | 谁 |
|---|---|---|
| D1 | 两处代码修复 + 自检断言 + 五道门槛 | ✅ 已完成（`43aadc1`） |
| D1 | T1 静态核查（app-update.yml / sha512） | ✅ 基线已做（sha512 ✅ 一致；产物里的源确为 GitHub 直链） |
| D2 | 打 rt.1/rt.2/rt.3（独立输出目录 + `--publish never`）→ 本机 8099 服务器 → 自动跑 T2/T3/T5/T6/T9–T13 | **A**（`/S` 静默安装 + 命令行版，见方案 §9 修订） |
| D3 | `publish.url` 改回 `https://dl.smindapp.cn/` → **重打包**（不重打等于没改） | A |
| D4 | 上传真 0.9.2 到 OSS → 真机首跑验收 = 台账 #3 收口 | U（AK 在用户环境） |
| — | 人眼部分：T4/T7/T8 的对话框文案、T14 数据完整性、断网 / 系统时间 +7h | U |

T7 已静态确证（见方案 §附 后补记）：`quitAndInstall()` 走可打断的 `app.quit()`，我们的 `before-quit`
会 `preventDefault` 并弹「保存吗」→ **取消不会丢数据**；唯一瑕疵是安装器在弹窗前已 spawn（不丢数据，
若要"先问后装"需抑制 `window-all-closed → app.quit()`，属需真机验证的单独一批）。

---

## 5. 环境坑与可复用工具（本会话踩过/建的）

**坑（都真实踩过）**：
1. **中文提交信息别用 PowerShell 写**：`Set-Content -Encoding UTF8` 在 Windows PowerShell 下带 BOM，
   `git commit -F` 会把 `\uFEFF` 读进标题首字符 → 用文件工具写 `.tmp-check/commit-msg-N.txt` 再 `-F`（踩过一次，靠 `amend` 修掉）。
2. **长中文内联 PowerShell 命令会被解析坏**（`node -e "…"` 里带中文与引号尤其）→ 写成文件再跑。
3. **重定向到不存在的目录会静默失败**：`.tmp-check/gates` 被清掉那次，五道门**一道都没跑**却以为跑了
   （`$LASTEXITCODE` 是陈旧值）。跑门槛前先 `New-Item -ItemType Directory -Force`，并检查日志文件确实生成。
4. **沙箱内 `git push` 失败**（`Recv failure: Connection was reset`，重试 3 次无效）→ 提交在本地是安全的，
   推送交给用户（本会话两个仓库都是用户推的，现已同步）。
5. 站点仓库**没有** lint/format 门槛；它的"验收"就是下面那套 Electron 实测 + grep 残留扫描。
6. `.tmp-check` 会被别的会话清理 → 里面的脚本不是长期资产，重建很快（清单见下）。

**可复用工具**（`D:\Mind\.tmp-check\`，gitignored，本会话新建）：
- `shot.cjs` —— 用 Electron 把本地页面截成 PNG（`electron .tmp-check/shot.cjs <page> <out.png> <宽> <高>`），官网改动的 before/after 留档就靠它；
- `site-verify.cjs` / `site-verify-batchA.cjs` / `site-verify-p1.cjs` / `site-verify-p2.cjs` —— 官网自动体检
  （横向滚动、图片是否加载、旧令牌命中数、计算样式、`img.currentSrc` 是否取到 WebP、CDP 模拟 `prefers-reduced-motion`）；
- `site-images.cjs` —— 实测渲染宽度 + 生成 WebP/PNG（用 `data:` URL 喂图避开 file:// canvas 污染）；
- `live-check.mjs` —— **线上核验**（带 `?v=` 穿透缓存，打印新旧令牌命中数与批次标记）；
- `t1-static-check.mjs` —— latest.yml ↔ exe 的 sha512 比对 + 读产物里的 app-update.yml；
- `t7-quit-semantics.cjs` —— 20 行 harness，证明 `app.quit()` 会尊重窗口 `close` 的 `preventDefault`。

---

## 6. 待人眼验收（agent 无法自证的部分）

1. **A3 修完后**：中文输入法组词时编辑框不再折行（纯 ASCII 打字的对照：会跟着变宽）。
2. **A1/A2 修完后**：`神经网络**粗体**`、`a^2^`、`神经网络\`代码\`` 三种写法各自的效果；提交后再进编辑态格式还在。
3. **自动更新**（方案 §4.4）：T4/T7/T8 的对话框文案；T7 真机按"故意不保存 → 点立即重启并安装 → 应弹保存吗 → 取消 → 应用不退出、内容还在"走一遍；T14 升级后最近文件/文档/许可/设置一项不少。
4. 官网：`smindapp.cn` 首屏数字带（三个数字应为 30px ink 色、说明 13.5px）、首屏图是否明显更清晰/更快（WebP）。
