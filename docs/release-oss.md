# 国内镜像发布指引（阿里云 OSS）

> **当前采用方案（2026-09-20 决定）**：Cloudflare R2 **搁置**（激活必须绑支付方式，当前无可用国际信用卡），
> 改用 **阿里云 OSS** —— 用**支付宝**即可付费，**不需要信用卡**；选**香港地域**绑自定义域名
> **不需要 ICP 备案**。
>
> 背景（2026-09-20 实测，非推测）：GitHub Release 直链从国内下载 **0.02 MB/s**，
> 一个 108 MB 的安装包要 **90 分钟**；而下载页首选的 `dl.smindapp.cn` 当时是死的
> —— 也就是**用户根本装不上**。这是比"有没有购买入口"更前置的问题。
>
> 为什么不用 Cloudflare Workers 反代 GitHub：Community 反馈此类反代可能被判定滥用、
> 严重时**封禁域名**；`smindapp.cn` 是主站域名，不值得拿它冒这个险。

## 一、一次性配置（约 15 分钟，全在阿里云控制台）

1. **开通 OSS**：阿里云控制台 → 对象存储 OSS → 立即开通（个人实名账号即可，**无需信用卡**）。
2. **建 Bucket**：
   - 名称 `smind-releases`
   - 地域 **香港（`oss-cn-hongkong`）** ← **关键**：海外节点绑自定义域名不需要备案
   - 读写权限 **公共读**（下载页与自动更新都是匿名 GET）
   - 其余默认
3. **建 RAM 子账号拿 AccessKey**（别用主账号 AK）：
   - RAM 控制台 → 用户 → 创建用户 → 勾「OpenAPI 调用访问」→ 记下 **AccessKey ID / Secret**
   - 授权：自定义策略，只允许该桶的读写。最小权限策略示例：
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
4. **上传**（本仓库的脚本，零依赖，走 OSS 原生 V1 签名）：
   ```powershell
   $env:OSS_BUCKET = 'smind-releases'
   $env:OSS_ENDPOINT = 'oss-cn-hongkong.aliyuncs.com'
   $env:OSS_ACCESS_KEY_ID = '<AccessKey ID>'
   $env:OSS_ACCESS_KEY_SECRET = '<AccessKey Secret>'
   npm run mirror:oss
   ```
   脚本会传 4 个文件并**自动 HEAD 校验直链**；`latest.yml` / `*.blockmap` 缺失时只警告不中断。

## 二、对外访问地址：两条子路，选一条

### 子路 A · 用 OSS 默认域名（**今天就能通，零配置**）

```
https://smind-releases.oss-cn-hongkong.aliyuncs.com/SMind-0.9.1-x64-setup.exe
```

- `aliyuncs.com` 自带 HTTPS 证书，**不用申请证书、不用绑域名**，上传完即可用
- 代价：① 地址不好看；② 下载页的 `MIRROR` 常量要改成这个地址（一次站点改动）；
  ③ 将来把自动更新源切回镜像时，`electron-builder.yml` 的 `publish.url` 也要写这个地址

### 子路 B · 绑 `dl.smindapp.cn`（**推荐，与代码里现有配置完全一致**）

```
https://dl.smindapp.cn/SMind-0.9.1-x64-setup.exe
```

- 步骤：Bucket → **域名管理** → 绑定域名 → 填 `dl.smindapp.cn`
  → 按提示到 **Cloudflare** 加一条 `dl` 的 **CNAME**（指向 OSS 给的 CNAME 目标，**保持灰云 DNS only**）
  → 回 OSS 绑定页确认
- **HTTPS**：用阿里云**免费 DV 证书**，或上传自有证书到 OSS；证书签发要做 DNS 校验
  （域名在 Cloudflare，按提示加一条 TXT 即可）
- **好处**：下载页的 `MIRROR`、`electron-builder.yml` 的 `publish.url`
  **一个字符都不用改**——两边本来就写着 `https://dl.smindapp.cn/`，镜像一通就自动生效

> ⚠️ 别在 Cloudflare 上给 `dl` 开橙云代理：OSS 侧要做的是直连下载，
> 套一层代理既改变源站身份又可能触发 ToS 问题。**灰云**即可。

## 三、每次发版

```powershell
npm run dist          # 打包，产出 2 个 exe + latest.yml + *.blockmap
npm run mirror:oss    # 传到 OSS 并校验直链
```

- 上传清单与 R2 那套一致：**两个 exe + `latest.yml` + `*.blockmap`**，缺后两个 → 客户端**静默**收不到更新
- 传完顺手把该版本的 CHANGELOG 段落写进 GitHub Release 正文（`latest.yml` 的 `releaseNotes` 会显示在「发现新版本」对话框里）

## 四、成本（以官方价目为准）

| 项 | 单价量级 | 你的实际用量 |
|---|---|---|
| 存储 | 约 0.12 元/GB/月（标准） | 每版 2 个 exe ≈ **216 MB**，留 3 版 ≈ 650 MB |
| 外网下行 | 约 0.5 元/GB | 100 次下载 ≈ 10.8 GB ≈ **5 元** |

结论：以预热期的下载量，**每月不到 1 元**。想再省可以买流量包。

## 五、与 R2 方案的取舍

| | 阿里云 OSS（当前采用） | Cloudflare R2（搁置） |
|---|---|---|
| 开户门槛 | **支付宝即可，无需信用卡** | **必须绑支付方式**（当前无可用卡） |
| 自定义域名 | 香港地域**免备案** | 免备案（但需 zone 在 Cloudflare，此步已完成） |
| 国内速度 | 好（香港节点） | 好（Cloudflare 边缘） |
| 下行流量费 | 约 0.5 元/GB | **免费** |
| 现状 | 本文 | 见 `docs/release-mirror.md` |

> 将来若拿到可用的支付方式，切回 R2 只需把 `publish.url` 保持 `https://dl.smindapp.cn/`
> 不变、把上传脚本换成 `npm run mirror` 即可——**客户端无感**（地址没变）。
