# 非代码事务总账（ops.md）

> 唯一跟踪点：凡不属于代码的事务都登记在这里，状态与下一步随时更新。
> 分工：代码归重构 agent；**本总账归文书 agent 管**；需要用户本人身份的操作（注册 / 实名 /
> 支付 / 开店 / 发布）由用户执行，agent 备好材料与步骤。
> 规则：做完一项就更新状态；新增事项随手登记。
>
> **环境限制（2026-09-18 / 09-19 实测，影响本账能做的事）**：本会话沙箱内 **git 与 curl 建不了 TLS**
> （curl/schannel 报 `SEC_E_NO_CREDENTIALS`，git 换 openssl 后端也连不上 github.com:443），
> 而 **Node 的 fetch 可用**（实测 smindapp.cn 200、api.github.com 403 限流、npmmirror 200）。
> 结论：**代码可读、可改、可本地提交；但「推送 GitHub」「用 API 管 Release」当前做不到**——
> 需要用户提供 PAT / 由用户侧执行 push，或放行沙箱网络。另：站点仓库 `tun127/smind-site`
> **本机没有检出**，改官网文案前需要先 clone。
>
> **五道门槛里，本会话能独立跑通的只有四道**（2026-09-19 亲手复核）：
> `typecheck`（含 strict）✅ exit 0｜`lint --max-warnings 0` ✅ exit 0｜`format:check` ✅ exit 0｜
> `verify` ✅ exit 0（21 个 `.xmind` + 4 个 `.emmx` 全部往返一致）｜**`selfcheck` ⛔ 跑不了**——
> 它经 esbuild 起子进程，受限沙箱下 spawn `EPERM`（**不是断言失败，是环境限制**；
> 连「改用文件重定向避开管道」的绕法也无效）。所以自检那一项只能采信代码 agent 的实测声明。

## 一、发版事务

| # | 事项 | 状态 | 下一步 | 依赖 |
|---|---|---|---|---|
| 1 | 0.9.0 正式发布 | ✅ 已发布（GitHub Release + 官网直链下载） | 观察下载数与反馈 | — |
| 2 | **0.9.1 发版** | ⬜ 等 PDF 验收 | 用户人工验收 PDF（导出 → 选中文字 → 放大 400% 看锐利）→ `npm version 0.9.1` → `dist` → `mirror` → Release（agent 代跑，说明用户过目） | #6 验收通过 |
| 3 | 自动更新首跑 | ⬜ 随 0.9.1 | 需求见 `docs/auto-update-and-license-delivery.md` §3。Release 页上传 exe + `latest.yml` + blockmap，且必须是**已发布**（非 draft/prerelease）。⚠️ **已实测风险**：GitHub API 匿名限流（本机出口 IP 调 api.github.com 已 403），github provider 会随机静默失效 → 建议更新源改为 **generic provider 指向 `dl.smindapp.cn`**（R2 无 API 无限流），`npm run mirror` 需顺带传 `latest.yml` + blockmap | #2 |
| 4 | README 已知限制随 0.9.1 更新 | ⬜ | PDF 改矢量、自动更新渠道就绪——发 0.9.1 时一并改写 | #2 |
| 20 | **渲染层人肉验收**（阻塞 0.9.1 打包） | ⬜ **用户执行**（代码侧积压） | 解耦战役把约 40 个界面文件拆开了，而**自检不渲染 React**（只覆盖 shared/store）→ 所有界面行为都属「未验证」。清单见 `docs/handover.md` §五：A8 四批（整轮 AI 对话／面板三分支／工具栏收纳与禁用提示／菜单·快捷键·拖文件／拖拽吸附／折叠锚点／视角锁定／滚轮缩放）、A7-3 关窗链路 12 条、A6-3 回合收尾、A4–A7 更早各批。**当前 `release/` 仍是 09-18 打出的 0.9.0，此后 107 个提交没再打包过** → 现在直接发 0.9.1 等于把一批"只过了静态检查、没上过手"的界面改动发给用户 | #2、代码 agent |

## 二、分发与官网

| # | 事项 | 状态 | 下一步 | 依赖 |
|---|---|---|---|---|
| 5 | 官网下载直链 | ✅ /download/setup·portable/ 点按钮直下 | — | — |
| 6 | PDF 矢量人工验收 | ⬜ 用户执行 | 见 #2 | — |
| 7 | **R2 国内镜像** | ⬜ 等用户配置 Cloudflare | 用户：迁 DNS → 建 `smind-releases` 桶 → 绑 `dl.smindapp.cn` → 拿 API Token；然后 `npm run mirror` 验证（手册：docs/release-mirror.md） | 用户 |
| 8 | 官网下载页 | ✅ 镜像优先 + GitHub 回退（已上线） | 镜像就绪后无需改页面 | #7 |
| 18 | 官网「结构数」口径 | 🟡 待统一（小） | 官网写「**9 种结构**」（自测：按结构**族**数），README / CHANGELOG 写「**14 种**」（按 Xmind class 数，源码 `STRUCTURES` 实测 14 项 / 9 族）。两个数都对，但对外应统一——建议官网改「14 种结构（9 大族）」；属站点仓库 `tun127/smind-site` | 站点仓库 |

## 三、商业化（Pro 侧）

| # | 事项 | 状态 | 下一步 | 依赖 |
|---|---|---|---|---|
| 9 | **价格口径拍板** | ✅ 已定稿（2026-09-18） | **正价 ¥39 / 早鸟 ¥19（限量 200）**；phase3-plan 已回写改价记录，材料库 10 个文件全量统一，官网本就一致——三方对齐 | — |
| 10 | 一页纸 EULA | 🔶 草稿已有 | `commercialization/04-release-0.9/eula.md` 九条完整草案——待①填占位符（发布日/主体）②法律人士过目 | #9 定价无关 |
| 11 | 软著 | ⬜ 未办 | 用户向版权局申请（个人可办）；agent 可整理申请材料清单与 60 页源码文档 | — |
| 12 | 面包多开店 | 🔴 **已发售但无购买入口**（当前最高优先级） | **已实测**官网首页（抓取 smindapp.cn，HTTP 200）：挂牌 v0.9.0、Pro / ¥39 / 早鸟 ¥19、「Pro 买断解锁」徽标，FAQ 写明「买断 ¥39…解锁不限量写回合」——但**全页外链只有 GitHub 仓库 / Releases / Issues 三个，没有任何购买入口**（无面包多、无爱发电）→ 用户烧完 30 个写回合后无处可买。商品页文案与发货流程已于 2026-09-18 校正（许可码口径 + `license:issue` 真实命令）；只等用户开店上架即可打通闭环 | 用户 |
| 13 | 60 秒演示视频 | 🔶 分镜已有 | `commercialization/04-release-0.9/video-60s-script.md` 完整分镜——待录制剪辑（走剪映流程） | — |
| 19 | **自动发激活码（卡密池）** | ⬜ 需求已交接（2026-09-18） | 目标：**付款即自动发货、零人工**。需求见 `docs/auto-update-and-license-delivery.md` §4。🔴 **阻塞性前置＝许可码目前不唯一**：payload 无序列号，同一 payload 签出的码**逐字相同**，批量预生成会得到 N 个一样的码（限量 200 形同虚设、泄露无法定位）→ 必须先加 `serial` + 批量签发工具，再实测**面包多卡密字段能否容纳 210–217 字符**（实算长度见该文件 §5） | 代码 agent |

## 四、获客与运营

| # | 事项 | 状态 | 下一步 |
|---|---|---|---|
| 14 | 三期两条真模型端到端验收 | ⬜ | ①一句话重塑三层结构全程可撤 ②长对话压缩后仍正确引用现状——跑通即「三期交付完」 |
| 15 | 少数派 / 小众软件 / V2EX 首发 | 🔶 文案已有 | 0.9 发布帖草稿在 `commercialization/04-release-0.9/posts-0.9.md`——0.9.1 发后按此发帖（带演示视频效果最佳） |
| 16 | 前 100 用户逐个访谈 | ⬜ | 用户群建好后开始，决定付费转化 |
| 17 | ICP 备案（远期） | ⬜ 暂缓 | 预推行不花钱；正式推广期再办（主站迁 EdgeOne Pages 用） |

## 五、已完成存档

- ✅ **2026-09-19 状态复核（文书侧亲手实测，非转述）**：四道门槛自跑全绿——`typecheck`（含 strict）／
  `lint --max-warnings 0`／`format:check`／`verify`（21 `.xmind` + 4 `.emmx` 往返一致）；
  `selfcheck` 因沙箱 EPERM 跑不了（见页首环境限制）。**官网复抓：仍是 v0.9.0、仍无任何购买入口、
  下载页仍指向 v0.9.0** → **商业化侧 24 小时内零进展**，全部待办原地不动。
  代码侧同期很猛：当日 93 个提交、累计 **107 个未推送**；`release/` 仍是 09-18 打出的 0.9.0
  （此后 107 个提交没再打包过）。
- ✅ **口径核对：IPC 通道数「66 vs 70」两者都对**，量的不是一回事——`shared/ipc.ts` 有 **70 条通道常量**
  （＝preload 侧调用点也是 70），主进程侧 `ipcMain.handle/on` 注册是 **66 条**，差的 4 条是**主→渲染方向**
  （`fileOpenRequest`／`menuCommand`／`closeRequest`／`aiStreamEvent`）。登记以免后续谁把其中一个"改错"。
- ✅ **线上状态核查（2026-09-18，实测非推测）**：官网 smindapp.cn 返回 200，首页挂牌 **v0.9.0**；
  `/download/portable/` 与 `/download/setup/` 两页均指向 **v0.9.0** 的 GitHub Release 资产
  （`SMind-0.9.0-x64-portable/setup.exe`）并带镜像址 `dl.smindapp.cn`——与 #5 / #8 登记一致。
  同期实测 GitHub API 从本机 IP 返回 **403（rate limit，未配 token）**，故 Release 资产数与下载量本次未能核到。
- ✅ **商业化材料库「许可码口径」全校正（2026-09-18）**：全库 6 个文件写着不存在的
  `.smindkey` **许可文件**与不存在的 `scripts/sign-license.mjs`——与实机不符（**本产品只发许可码字符串**：
  `SMIND1.<payload>.<签名>`，在「AI 设置 → 许可（Pro）」粘贴激活，离线验签、不锁机、无文件）。
  已按实机口径改正：`eula.md`（定义/授予/退款/禁止/终止五处）、`mianbaoduo-page.md`（购买三步 +
  发货流程真命令 `npm run license:issue -- --to 称呼 --order 单号` + 新的邮件模板——**许可码进正文**而非附件）、
  `master-plan.md` W2、`kpi-tracker.md` 对账口径、`release-day-checklist.md` 激活链路、
  `bilibili-calendar.md` W2 素材。风险等级高：这是**唯一直接决定买家能不能用上**的链路，
  按旧文案发货会让每个买家都收到一份不存在的附件、并照着不存在的菜单路径去找激活入口。
- ✅ **材料库事实核对**：`templates.md` 周报模板「往返样本 25 个」→ **21 个**（实测 21 个 `.xmind`
  + 4 个 `.emmx` 兼容样本）；新增 **Q10 激活 FAQ**（买了 Pro 怎么激活 / 换电脑怎么办）——
  开店后最高频的客服问题，原先弹药库里没有。
- ✅ **许可链路预检通过**：实测 `C:\Users\s2544\SMind-keys\license-private.pem`（签发私钥）与客户端内嵌
  `src/main/license/public-key.ts` **配套**（Ed25519 真签真验）→ 付费发放链路技术上就绪，开店即可发货。
  （沙箱内 `npm run license:selftest` 因 esbuild 子进程 EPERM 跑不起来，改用等价的 node:crypto 直验。）
- ✅ 全仓检查与清理（2026-09-18）：清掉 8 个散落日志、.tmp-check 诊断残留、release/ 旧产物
  （0.8.0 / beta.1 / beta.2 共 9 个文件约 650MB，保留 0.9.0 四件套 + latest.yml）；
  确认 `.dsh-meow/`（重构 agent 记忆库）与 `.tmp-split-highlight.mjs`（其迁移脚本）**不得清理**；
  发现并接管 `commercialization/` 材料库（gitignored，本地资产），免费边界旧措辞 5 处已统一
- ✅ 0.9.0 商业口径修正（0.9 整版免费、仅 AI 写工具收费）
- ✅ 官网下载按钮：跳转页 → 直链秒跳 → 点击下载（三迭代，最终形态 = 点击才下载）
- ✅ 文书清理：删 structure-specs / project-review，requirements 标历史存档
- ✅ R2 上传脚本 + 镜像回退逻辑（等 #7 配置即生效）
