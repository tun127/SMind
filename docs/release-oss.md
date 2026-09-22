# 国内镜像发布指引（阿里云 OSS · 香港 + 自定义域名）

> **当前采用方案（2026-09-20 决定）**：Cloudflare R2 **搁置**（激活必须绑支付方式，当前无可用国际信用卡），
> 改用 **阿里云 OSS 香港地域 + 绑定 `dl.smindapp.cn`**。
>
> 背景（2026-09-20 实测，非推测）：GitHub Release 直链从国内下载 **0.02 MB/s**，
> 一个 108 MB 的安装包要 **90 分钟**；而下载页首选的 `dl.smindapp.cn` 当时是死的
> —— 也就是**用户根本装不上**。这比"有没有购买入口"更前置。
>
> 为什么是这套组合：**支付宝即可付款（不需要信用卡）+ 香港节点绑自定义域名免 ICP 备案
>
> - 地址与代码里现有配置一致（`dl.smindapp.cn`）**。
>
> 为什么不用 Cloudflare Workers 反代 GitHub：社区反馈此类反代可能被判滥用、严重时**封禁域名**；
> `smindapp.cn` 是主站域名，不值得冒险。

---

## 零、最终形态（先看清目标）

```
买家/用户的第一次下载    https://dl.smindapp.cn/SMind-0.9.1-x64-setup.exe     ← 阿里云 OSS 香港
官网下载页 <a> 的 MIRROR 那个常量                                               ← 已是这个地址，不用改
客户端自动更新（0.9.2 起） `publish.url` = https://dl.smindapp.cn/              ← 下个版本改回来

GitHub Release 仍然保留，作为兜底与源码归档（下载页在镜像不可用时自动回退到它）
```

**谁在什么时间点吃到镜像**：

| 消费者       | 地址来源                                     | 何时生效                                                  |
| ------------ | -------------------------------------------- | --------------------------------------------------------- |
| 官网手动下载 | 页面里的 `MIRROR` 常量                       | **镜像一通就生效**（无需改任何代码）                      |
| 自动更新     | **打包时写死在客户端里**（`app-update.yml`） | 需**重新打包**（0.9.2）；0.9.1 的用户要先手动装一次 0.9.2 |

---

## 一、开通 OSS 并建桶（约 5 分钟）

1. 登录**阿里云控制台** → 搜索框输「**对象存储 OSS**」→ **立即开通**
   - 个人实名账号即可，**用支付宝付款，不需要信用卡**。按量计费，开通本身不收费。
2. **创建 Bucket**（OSS 控制台 → Bucket 列表 → 创建 Bucket）：

   | 字段        | 填什么                     | 说明                                                                                |
   | ----------- | -------------------------- | ----------------------------------------------------------------------------------- |
   | Bucket 名称 | `smind-releases`           | 全局唯一；若被占用就换个名（脚本走环境变量，改名不用动代码）                        |
   | 地域        | **香港 `oss-cn-hongkong`** | **关键**：海外节点绑自定义域名**不需要 ICP 备案**                                   |
   | 读写权限    | **公共读**                 | 下载与自动更新都是**匿名** GET；⚠️ **绝不要选"公共读写"**（那会允许任何人匿名上传） |
   | 冗余类型    | 本地冗余 LRS               | 同城冗余 ZRS 更贵，用不上                                                           |
   | 其余        | 默认                       | 版本控制 / 日志 / 加密都不必开                                                      |

3. 建好后在 Bucket **概览**页记下 **Endpoint**：`oss-cn-hongkong.aliyuncs.com`

---

## 二、建 RAM 子账号拿 AccessKey（约 3 分钟）

> **不要用主账号 AccessKey**（它是账号最高权限，一旦泄露等于账号失守）。

1. 控制台搜索「**RAM 访问控制**」→ **用户** → **创建用户**
   - 登录名：`smind-oss-uploader`
   - 访问方式：**只勾「OpenAPI 调用访问」**（不要勾控制台登录）
   - 创建后**立刻复制 AccessKey ID / Secret**（Secret 只显示这一次）
2. 给它**最小权限策略**（RAM → 权限策略 → 创建策略 → 脚本编辑，粘下面这段）：

   ```json
   {
     "Version": "1",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["oss:PutObject", "oss:GetObject", "oss:ListObjects"],
         "Resource": ["acs:oss:*:*:smind-releases", "acs:oss:*:*:smind-releases/*"]
       }
     ]
   }
   ```

   回到用户 → **添加权限** → 选这条自定义策略。
   （只授这一个桶的读写；`GetObject` 是为了上传后的自检能用同凭证复核。）

---

## 三、上传 + 先实测速度（决策点）

在本仓库跑（四个环境变量只在**当前终端会话**里设，别写进仓库）：

```powershell
cd d:\Mind
$env:OSS_BUCKET = 'smind-releases'
$env:OSS_ENDPOINT = 'oss-cn-hongkong.aliyuncs.com'
$env:OSS_ACCESS_KEY_ID = '<AccessKey ID>'
$env:OSS_ACCESS_KEY_SECRET = '<AccessKey Secret>'
npm run mirror:oss
```

脚本会传 **4 个文件**（两个 exe + `latest.yml` + `*.blockmap`）并**自动 HEAD 校验直链**。
此时对外地址是 **OSS 默认域名**（自带 HTTPS，零配置）：

```
https://smind-releases.oss-cn-hongkong.aliyuncs.com/latest.yml
```

**⚠️ 这是决策点**：拿这个地址**实测国内下载速度**（108 MB 走一次计时）。
如果速度和 GitHub 的 90 分钟没有量级差别，就**不要再往下做**，回来重新选方案。

```powershell
# 实测（在任意一台国内机器上跑）
curl.exe -sS -L -o NUL -r 0-104857600 -w "HTTP %{http_code} | %{size_download} 字节 | %{time_total}s | %{speed_download} B/s" `
  https://smind-releases.oss-cn-hongkong.aliyuncs.com/SMind-0.9.1-x64-setup.exe
```

---

## 四、绑定 `dl.smindapp.cn`（约 10 分钟）

### 4.1 绑定域名

OSS Bucket → **数据管理 → 域名管理** → **绑定域名** → 填 `dl.smindapp.cn`
→ 系统会给一个 CNAME 目标（形如 `smind-releases.oss-cn-hongkong.aliyuncs.com`）

### 4.2 在 Cloudflare 加 CNAME

`smindapp.cn` 的 DNS 现在托管在 Cloudflare（NS = `deborah` / `javon.ns.cloudflare.com`）：

> Cloudflare 控制台 → 选中 `smindapp.cn` → **DNS → 记录 → 添加记录**
> 类型 `CNAME`｜名称 `dl`｜目标 `<bucket>.oss-cn-hongkong.aliyuncs.com`｜**代理状态 = DNS only（灰云）**

⚠️ **必须灰云**：OSS 侧需要直连（橙云会改变源站身份、也可能触发 ToS 问题）。

### 4.3 上 HTTPS（重要，别跳）

官网是 https，下载页的 `fetch(MIRROR, {method:'HEAD'})` 探测**必须能拿到状态码**，
所以 `dl.smindapp.cn` 必须支持 HTTPS。

1. 控制台搜索「**数字证书管理服务**」→ **免费证书** → **申请证书**
   - 域名 `dl.smindapp.cn`（DV 单域名；**免费证书每年 20 张额度**，足够）
   - 验证方式选 **DNS 验证** → 按提示在 **Cloudflare** 加一条 **TXT** 记录 → 等待签发（一般几分钟）
2. 回到 OSS → 域名管理 → `dl.smindapp.cn` → **上传/选择证书** → 选刚签发的那张 → 确认
3. 等几分钟，`https://dl.smindapp.cn/latest.yml` 应该能打开

---

## 五、**必配 CORS**（最容易漏的一步，漏了下载页会一直走 GitHub）

官网下载页用 JS 探测镜像是否可用：

```js
fetch(MIRROR, { method: 'HEAD' }).then((r) => {
  if (r.ok) btn.href = MIRROR
})
```

这是**跨域请求**（`smindapp.cn` → `dl.smindapp.cn`）。OSS 不返回 CORS 头 → 浏览器拦截 →
探测失败 → 页面**永远回退 GitHub 直链**（慢 90 分钟），而且**看不出哪里错了**。

> OSS Bucket → **数据安全 → 跨域设置（CORS）** → 添加规则：
>
> - 来源（AllowedOrigin）：`https://smindapp.cn`、`https://www.smindapp.cn`
> - 允许方法（AllowedMethod）：`GET`、`HEAD`
> - 允许 Headers：`*`
> - 暴露 Headers：`Content-Length`、`Content-Type`（可选）

---

## 六、验证清单（做完逐条打勾）

- [ ] `https://dl.smindapp.cn/latest.yml` → **200**，且内容里 `version: 0.9.1`
- [ ] `https://dl.smindapp.cn/SMind-0.9.1-x64-setup.exe` → **206**，下载速度对比 GitHub 有量级差别
- [ ] `https://dl.smindapp.cn/SMind-0.9.1-x64-portable.exe` → **206**
- [ ] `https://dl.smindapp.cn/SMind-0.9.1-x64-setup.exe.blockmap` → **206**
- [ ] 打开官网 `https://smindapp.cn/download/setup/`，点大按钮 → **从 dl.smindapp.cn 下载**（不是 GitHub）
- [ ] 上面这条在**手机 4G/5G**下也试一次（不同运营商链路差别很大）

---

## 七、加固：费用告警（**必做**）

OSS 下行按量计费，**被刷就是真金白银**。当前量级每月不到 1 元，但要有兜底：

- 控制台 → **费用中心 → 预算与预警**（或「云监控 → 报警规则」）→ 设 **OSS 月度费用阈值**（如 20 元）
  → 触发时短信/邮件通知
- 可以顺手买个**下行流量包**（比按量便宜）

**为什么不开防盗链**：`electron-updater` 请求时不带 `Referer`，开 Referer 白名单会
**直接掐断自动更新**；要兼容就必须放行「空 Referer」，那对直连攻击者等于没设。
所以这里选择 **费用告警** 而不是防盗链。

---

## 八、每次发版

```powershell
npm run dist          # 打包，产出 2 个 exe + latest.yml + *.blockmap
npm run mirror:oss    # 传到 OSS 并校验直链
```

- 上传清单与 R2 那套完全一致：**两个 exe + `latest.yml` + `*.blockmap`**，
  缺后两个 → 客户端**静默**收不到更新（脚本会打显眼的 ⚠）
- 顺手把该版本的 CHANGELOG 段落写进 GitHub Release 正文（`latest.yml` 的 `releaseNotes`
  会显示在「发现新版本」对话框里）

### 下个版本（0.9.2）要恢复的一行

`electron-builder.yml` 的 `publish.url` 当前是 GitHub 直链（0.9.1 时为了不指向死域名临时改的），
**0.9.2 要改回镜像**：

```yaml
publish:
  provider: generic
  url: https://dl.smindapp.cn/
```

改完**必须重新打包**（更新地址写在打包生成的 `app-update.yml` 里）。
**此后不需要再改** —— 无论后端换 OSS 还是 R2，地址都是这一个，客户端无感。

---

## 九、成本量级（以官方价目为准）

| 项       | 单价量级                          | 实际用量                                     |
| -------- | --------------------------------- | -------------------------------------------- |
| 存储     | 约 0.12 元/GB/月（标准·本地冗余） | 每版 2 个 exe ≈ **216 MB**，留 3 版 ≈ 650 MB |
| 外网下行 | 约 0.5 元/GB                      | 100 次下载 ≈ 10.8 GB ≈ **5 元**              |

预热期**每月不到 1 元**。

---

## 十、回退路径（真出问题怎么办）

| 情况              | 处理                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 香港速度不理想    | ① 先确认是 DNS 还是线路问题；② 可选叠加阿里云 **CDN 加速**（海外节点，但效果一般）；③ 退回**子路 A**（OSS 默认域名）+ 接受地址不在自有域名上 |
| 证书/域名绑定卡住 | 先用**子路 A** 的默认域名把下载跑快（下载页改一次 `MIRROR` 即可），域名侧慢慢弄                                                              |
| OSS 整体不可用    | **什么都不用改**：下载页探测失败会自动回退 GitHub 直链（慢，但能下）                                                                         |
| 想换回 R2         | 把 `publish.url` 保持 `https://dl.smindapp.cn/` 不变，把 DNS 从 OSS 指到 R2，上传脚本换回 `npm run mirror` —— **客户端无感**                 |

> 与 R2 的完整对比见 `docs/release-mirror.md`（R2 已搁置，但手册仍然有效）。

### 本机环境的两个坑（2026-09-22 实测，别重复踩）

1. **git 不走系统代理**：本机系统代理是 `127.0.0.1:7892`（注册表 ProxyServer），但 git 自己没配代理 → 直连 GitHub 表现为 `Recv failure: Connection was reset` / 443 超时（TCP 能通、TLS 被 RST）。做法：**只在本会话设环境变量、不改 git 配置** —— `='http://127.0.0.1:7892'`，推完即弃。顺带：OSS 域名不需要代理。
2. **线上核验要用「重复的 range GET」，别用 `-I`**：本机网络路径会瞬时抖动 —— 同一条 URL 用 `curl -I` 或单次请求可能返回 404（356/367 字节的 NoSuchKey XML），而改 `curl -r 0-0` 连打三次稳定 206。判据：`Content-Range: bytes 0-0/<总字节>` 与 `latest.yml` 的 `version` 各连打 3 次一致才算过。
3. **HEAD 本身是好的**：两个域名上 HEAD 都返回 200（已实测），所以官网下载页用 HEAD 探测镜像不受影响。
