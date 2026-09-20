# 自动更新 + 自动发激活码 · 技术需求（交代码 agent 对接）

> 出方：商业化/文书 agent（本文件由非代码侧维护）｜落地：代码 agent
> 背景：0.9.0 已公开发布、写工具只送 30 回合试用，但**全站没有购买入口**（详见 `docs/ops.md` #12）。
> 本文件解决两件事：①用户装上之后**能自己升级**；②用户付钱之后**立刻自动拿到许可码**、不需要人工。
>
> 读法：§1 是已经做完的（**别重做**）；§2 是待你拍板的决策；§3/§4 是需求条目（带验收）；§5 是实测项。

---

> ## 实现进度（代码侧回填，2026-09-19 深夜）
>
> **已落地**：§4 的 **B1 / B2 / B3 / B5** + §3 的 **A3 / A4 / A5 / A6**，四条提交（五道门槛逐门退出码全绿）：
>
> | 提交 | 内容 |
> | --- | --- |
> | `4820e1e` | 许可：`serial`（可选，形状校验）+ 批量签发（**逐张真签**、逐张自查、唯一性守卫、CSV 台账）+ 从文件导入（`importText('license')` + `findLicenseKeyInText`）+ 持有人名可选 |
> | `20bcd71` | 更新：portable 守卫（A4）、6 小时复查（A5）、对话框显示 Release 正文（A6）、`publish` 换 generic 指向 `dl.smindapp.cn`（A3） |
> | `bfc4932` | 镜像脚本补传 `latest.yml` + `*.blockmap`（A3 的后半条） |
> | `6b09711` | CI 补 `format:check` 一道门 |
>
> - **D2 已按推荐口径 ① 实现**（portable 关闭更新检查 + 提示手动下载，并给「打开下载页」）；
> - **实测码长更新**（见 §5 表格，旧数字已过时）：批量码 **226 字符**（serial、无订单号）/ **249 字符**（serial + 订单号）；
> - **仍待用户拍板**：D1（卡密池 vs 服务端）、D3（要不要每单带名字）、**B6（吊销：做客户端名单，还是写"接受无法撤销"）**、B7（台账工具——当前 CSV 即台账）；
> - **发版前置**：R2 镜像必须先能提供 `latest.yml`（ops #7），否则 generic 渠道取不到更新（失败是静默的）；
> - B8 端到端验收仍属用户执行（见 `docs/ops.md` #19）。

---

## 1. 现状：这些已经做完了，不要重做

| 面 | 已实现 | 位置 |
| --- | --- | --- |
| 自动更新客户端 | 打包版才启用；启动 45s 后后台检查；`autoDownload=true`；`autoInstallOnAppQuit=true`；**例行检查失败静默**（只记日志）；帮助菜单「检查更新…」主动检查，有新版且已下载完可「立即重启并安装」 | `src/main/update/index.ts` |
| 发布渠道配置位 | `publish: github / owner: tun127 / repo: SMind / releaseType: release` | `electron-builder.yml` |
| 许可·纯逻辑 | 三段式格式、粘贴清洗（换行/空格/全角点）、结构校验、试用回合算术（30 次，唯一真相 `TRIAL_TURN_LIMIT`） | `src/shared/license.ts` |
| 许可·主进程 | 离线 Ed25519 验签、状态落盘、`isPro` 闸门（由主进程决定下发哪些工具）、激活/取消激活 | `src/main/license/` |
| 签发工具 | `license:keygen` / `license:issue` / `license:selftest`；私钥在仓库外，公钥内嵌（已实测配套） | `scripts/license-tool.ts` |

**真正缺的是这四样：**

1. **自动更新从未跑过** —— 没有任何 Release 同时带 `latest.yml` + exe + blockmap（0.9.0 是手工上传的 exe）。
2. **发码是纯人工** —— 面包多出兑换码 → 用户发兑换码+邮箱 → 店主跑脚本 → 手动邮件回许可码。**这不是"自动发"**。
3. 🔴 **许可码不唯一（最大障碍）** —— `LicensePayload` 没有序列号字段，签名覆盖的就是 payload 字节，因此**同一 payload 签出来的码逐字相同**。批量预生成 200 个首批卡密码会得到 **200 个一模一样的码**：限量 200 形同虚设、泄露无法定位、对账无从谈起。**卡密池方案没有这一项就不能开工。**
4. **免安装版（portable）自更新语义未定义** —— portable 是自解压 exe，`nsisOptions` 里 `unpackDirName` 默认按构建 uuid、每次启动解压到独立目录；而 electron-updater 里**完全没有** portable 相关处理（实测 grep 零命中）。它会把新版本装进那个临时目录，用户下次启动还是旧版。需要决策 + 客户端显式守卫。

---

## 2. 需要先拍板的 3 个决策

| # | 决策 | 选项与建议 |
| --- | --- | --- |
| **D1** | 发码架构 | **A. 卡密池预生成**（推荐）：离线批量签一批码，整批上传面包多卡密池 → 付款即自动发货，**零服务器、零人工**，与"无服务器"卖点一致。<br>B. 服务端按需签发：需要一台常驻服务 + 面包多 webhook，能带买家名字，但与 local-first 叙事冲突、且多一份运维成本。 |
| **D2** | 免安装版怎么更新 | **①更新检查对 portable 直接关闭**，改为提示"免安装版请到官网下载新版本"（推荐：诚实、省事、零风险）。<br>②让 portable 也能自更新：语义勉强、工作量大（要自己搬 exe + 处理解压目录），不建议。 |
| **D3** | 要不要"每单带买家名字" | 要 → 只能走 D1-B 或继续人工；**卡密池方案只能给通用持有人名**（见 §4 B2）。建议接受通用名，把"名字自定义"放到以后再说。 |

---

## 3. 需求 A：自动更新

### A1｜0.9.1 首跑（这一版必须做，否则整条链路永远是"没验过的代码"）

发布 Release 时必须同时上传四个文件：

```
SMind-0.9.1-x64-setup.exe
SMind-0.9.1-x64-setup.exe.blockmap
SMind-0.9.1-x64-portable.exe
latest.yml
```

- `latest.yml` 里的 `version` 必须与 `package.json` 一致（先 `npm version 0.9.1` 再打包）。
- **验收**：在一台**已装 0.9.0** 的机器上启动 → 45 秒内日志出现检查结果 → 退出重开确认已是 0.9.1；帮助菜单「检查更新…」显示新版并能「立即重启并安装」。

### A2｜Release 必须是"已发布"状态

`releaseType: release` 且**不能是 draft、不能标 prerelease**——草稿态在更新接口里查不到，客户端会一直认为"已是最新"。这条要写进发版检查清单。

### A3｜🔴 换掉 GitHub API 作为更新源（已实测的真实风险）

- **实测证据**：本机出口 IP 调 `api.github.com` 返回 **403 `API rate limit exceeded`**。electron-updater 的 github provider 走 GitHub API，匿名额度 60 次/小时/**IP**，国内共享出口 IP 极易 403 → **自动更新会随机失效**，而且失败是静默的（现在设计就是静默），你根本不会知道。
- **需求**：改用（或并列）**generic provider 指向 `https://dl.smindapp.cn/`**（Cloudflare R2：无 API、无速率限制、国内快）。
  - `electron-builder.yml` 的 `publish` 增加/切换 `provider: generic` + `url: https://dl.smindapp.cn/`；
  - `npm run mirror`（`scripts/upload-mirror.mjs`）扩展为上传 **exe + `latest.yml` + `.blockmap`**（现在只传两个 exe）；
  - 客户端**不用改**：electron-updater 原生支持 generic provider。
- **验收**：把 `dl.smindapp.cn` 的站点目录断掉后，主动检查给出可读的失败提示；恢复后能查到新版本。

### A4｜portable 守卫（取决于 D2）

`src/main/update/index.ts` 的 `startAutoUpdate()` 里检测 `process.env.PORTABLE_EXECUTABLE_DIR`（NSIS portable 目标会设置它）：

- 命中 → 不进入自动下载/安装流程；帮助菜单的「检查更新…」改为提示"你用的是免安装版，请到官网下载新版本替换"。
- **要求有自检断言**（纯函数判定 + 环境变量分支）。

### A5｜检查时机（低优先，可后置）

现在只在启动 45s 后查一次 + 手动。应用长期开着就再也查不到。建议补：**距上次检查 > 6 小时且窗口重新获得焦点**时再查一次（失败照旧静默）。

### A6｜让用户看见"这版改了什么"

`latest.yml` 的 `releaseNotes` 会显示在「发现新版本」对话框里。要求发版时把该版本的 CHANGELOG 段落写进 Release 正文，保证对话框里有内容可显示。

### A7｜版本号零点

`app.getVersion()` 必须与 git tag 一致，否则 electron-updater 判定"无变化"。

---

## 4. 需求 B：自动发激活码

### B1｜🔴 给许可 payload 加唯一序列号（**阻塞性前置**）

- `LicensePayload` 增加**可选**字段：`serial?: string`（如 `EB-000123`）、`batch?: string`（如 `EB`）。
- `normalizeLicensePayload` 接受并原样保留它们。
- **向后兼容是硬要求**：已手工签发的码没有 serial，**必须仍然验得过**——字段可选、且验签覆盖的是**原始 `payloadSegment` 字节**（现有实现就是如此，不要改成"重新序列化再验"）。
- **唯一性来自"逐码真签"**：serial 不同 → payload 不同 → 签名不同 → 码不同。**禁止**"签一次然后把字符串改一改"这种伪批量。
- **验收（自检）**：①同批 200 个码**两两不等**；②改动 serial 任一字符即验签失败；③无 serial 的旧格式码仍能激活。

### B2｜批量码的持有人名

批量码没有买家名字。二选一：

- **①** holder 固定为通用值（如 `SMind Pro`）——客户端**零改动**；界面会显示「已激活 Pro（SMind Pro）」，略怪但可接受。
- **②（推荐）** 把 `holder` 改成**可选**，界面显示「已激活 Pro」（不带括号名字）——更干净，但要同步改 `licenseViewOf` / `licenseSummary` 文案与相关自检。

### B3｜批量签发工具

`scripts/license-tool.ts` 增加 `batch` 子命令 + `package.json` 加 `license:batch`：

```powershell
npm run license:batch -- --count 200 --batch EB --start 1 --holder "SMind Pro" [--date 2026-09-18] [--out license-batch-EB.csv]
```

要求：

1. **逐码真签**（见 B1）；
2. 输出 `serial,许可码` 的 CSV —— 既是**上传面包多的原料**，也是**本地台账**；
3. serial 连续可读（`EB-000001`），批次前缀区分首月促销 / 正价；
4. **绝不覆盖已存在的 CSV**（防重复发放，这是最容易出的事故）；
5. 私钥缺失时明确报错并指向 `license:keygen`。

### B4｜面包多卡密池对接（这是"自动发货"的落点）

把 B3 的许可码**逐行**上传为面包多的**卡密池**，付款即自动把一条卡密发给买家。

> ⚠️ **开工前必须先实测面包多卡密字段的长度上限**。许可码实测长度（本机实算，见 §5）：
>
> | 形态 | payload 段 | 签名段 | **总长** |
> | --- | --- | --- | --- |
> | 当前人工签发（含订单号） | 123 | 86 | **217 字符** |
> | 批量卡密池（+serial） | 116–119 | 86 | **210–213 字符** |
> | 压缩 payload（去 `edition`/`v`、字段名缩写） | 67 | 86 | **161 字符** |
>
> 若平台卡密字段容不下 213 字符，备选：①压缩 payload（属**格式变更**，需按版本兼容处理，见 B1 的兼容要求）；②改走"发一个含许可码的 `.txt` / `.smindkey` 文件"（需要 B5）。

### B5｜客户端支持「导入许可文件」（强烈建议）

「AI 设置 → 许可（Pro）」增加一个 **「从文件导入…」**按钮：接受任意文本文件，自动抽取其中 `SMIND1.` 开头的串，经 `normalizeLicenseKey` 清洗后走**同一条**激活路径。

理由有两条，都真实：

1. 213 字符的长串在邮件/聊天里**极易断行或漏字符**，文件形态最稳；
2. 换电脑时"许可文件存网盘再导入"比"回头找那串文本"体验好得多——而 EULA 承诺的就是"重装不锁机"。

### B6｜退款 / 吊销：必须给个明确结论

离线验签**无法远程撤销**已发出的码。可选补强：客户端内置**吊销名单**（serial 列表）随版本更新下发，`license:activate` 时命中即拒绝。

- 要求：名单为空时行为与现在**完全一致**（零回归）；
- 名单只能靠发新版更新 —— 正好复用 A 的自动更新链路；
- **若决定不做，请在文档里白纸黑字写"接受无法撤销"**，不要留模糊地带（现在的商业化文档对此没有表态）。

### B7｜台账与对账

B3 的 CSV 就是唯一台账。建议让工具顺带维护（或加 `npm run license:ledger`）：`批次 / serial / 许可码 / 生成时间 / 投放平台 / 是否已售（人工回填）`。

支撑两件事：① KPI 表「许可签发数 ≈ 付费单数」的对账；② **首批 200 张的余量统计**（库存即销量上限，必须数得清）。

### B8｜端到端验收（本人走一遍）

店里下一单 → 拿到卡密（= 许可码）→ 应用内激活 → 显示「已激活 Pro」→ 写回合不限量生效 → 取消激活后回到试用计数。

`commercialization/05-ongoing/release-day-checklist.md` 已列这条，但需**在自动发货形态下重跑一遍**（原来的写法是人工发码流程）。

---

## 5. 实测数字与涉及文件

**本机实测（可直接引用）**

- 许可码长度：见 B4 表格（逐形态实算，非估算）。
- GitHub API：本机出口 IP `api.github.com` → **403 rate limit exceeded**（A3 的依据）。
- electron-updater 6.8.9；`app-builder-lib` 的 portable 解压目录默认按构建 uuid（`nsisOptions` 注释）。
- electron-updater 源码中 `portable` / `PORTABLE_EXECUTABLE` **零命中**（现状 4 依据）。
- 沙箱限制：本会话内 `git` / `curl` 建不了 TLS，查线上用 **Node 的 fetch**；经 esbuild 的 npm 脚本（`selfcheck` / `license:selftest`）会 spawn EPERM。

**预计涉及文件**

| 文件 | 改动 |
| --- | --- |
| `src/shared/license.ts` | payload 加 `serial` / `batch`（可选）；B2 若选 ② 则 holder 改可选 |
| `scripts/license-tool.ts` | 新增 `batch` 子命令 |
| `package.json` | 新增 `license:batch`（可选 `license:ledger`） |
| `src/main/update/index.ts` | portable 守卫（A4）；检查时机（A5） |
| `electron-builder.yml` | generic provider 指向 `dl.smindapp.cn`（A3） |
| `scripts/upload-mirror.mjs` | 上传 `latest.yml` + blockmap（A3） |
| `src/renderer/src/components/AiSettingsDialog.tsx` | 「从文件导入…」（B5） |
| `src/main/license/index.ts` | 吊销名单校验（B6，若做） |
| `scripts/selfcheck.ts` | B1 三条断言、A4 断言 |

---

## 6. 明确不做（写清楚，以免反复讨论）

- ❌ **不做在线激活 / 账号体系** —— 违背 local-first 卖点，且引入服务器成本；
- ❌ **不做"短兑换码换许可码"** —— 离线验签无法把短码换成许可码，除非上服务端（= D1-B）；
- ❌ **不把许可写进 `.xmind`** —— 格式保真是产品立身之本（红线）；
- ❌ **不为自动更新引入 electron-updater 之外的新依赖**。

---

## 7. 建议的落地顺序

1. **B1 + B3** —— 发码自动化的地基（卡密池没它不能开工）；
2. **B4** —— 实测面包多卡密长度（可能反过来影响 B1 的 payload 设计）；
3. **A1 + A3** —— 0.9.1 发版时顺带首跑自动更新 + 换镜像源；
4. **A4** —— portable 守卫；
5. **B5** —— 导入许可文件（体验 + 兜底交付形态）；
6. **B6** —— 吊销名单（可延后，但**结论必须有**）；
7. **B7** —— 台账与余量统计。