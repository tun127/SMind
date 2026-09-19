# 国内镜像发布指引（Cloudflare R2）

> 预推行阶段的零成本方案：exe 镜像走 Cloudflare R2（每月免费 10GB 存储 + 下行流量免费），
> 官网下载页**自动优先走镜像、失败回退 GitHub 直链**——镜像没配好也不影响用户下载。

## 一次性配置（约 15 分钟）

1. **注册 Cloudflare** → 把 `smindapp.cn` 的 DNS 托管迁到 Cloudflare（免费计划；
   在域名注册商处把 NS 改成 Cloudflare 分配的两个地址，几分钟~24h 生效）。
2. **建 R2 桶**：控制台 → R2 → Create bucket，名字 `smind-releases`（区域随意）。
3. **绑定自定义域**：桶 → Settings → Custom Domains → 绑 `dl.smindapp.cn`
   （域名 NS 已在 Cloudflare 时是一键操作）。
4. **建 API Token**：R2 → Manage R2 API Tokens → 权限 `Object Read & Write`，
   记下 `CLOUDFLARE_ACCOUNT_ID` 与 Token。

## 每次发版的镜像步骤

```powershell
npm run dist                 # 打包（顺带生成 latest.yml 与 *.blockmap）
npm run mirror               # 上传 2 个 exe + latest.yml + *.blockmap 到 R2，并自动校验 dl.smindapp.cn 直链
```

然后把 GitHub Release 建好（`docs/release-0.9.md` 的流程）。

> ⚠️ **`latest.yml` 与 `*.blockmap` 现在是自动更新的命脉**：客户端的更新源已从 GitHub API
> 换成 **generic provider 指向 `https://dl.smindapp.cn/`**（`electron-builder.yml` 的 `publish`），
> 它读的就是镜像上的这两个文件。少传 → 客户端**静默**查不到更新（`npm run mirror` 会打显眼的 ⚠ 警告）。
> 发版时顺手把该版本的 CHANGELOG 段落写进 Release 正文——`latest.yml` 的 `releaseNotes`
> 会显示在「发现新版本」对话框里。

## 改官网下载入口（两个文件各两行）

站点仓库 `tun127/smind-site`：

- `download/setup/index.html` → 改 `MIRROR` 与 `FALLBACK` 两条 URL 为新版本
- `download/portable/index.html` → 同上

改完 push，Pages 自动部署（约 1 分钟）。

## 行为说明

- 下载入口页先 `HEAD` 探测 `dl.smindapp.cn`（2.5 秒超时）：
  - 镜像可用 → 跳镜像直链（R2 走 Cloudflare 边缘，国内一般明显快于 GitHub）；
  - 不可用 → 自动回退 GitHub 直链。**镜像挂了不会断下载**。
- R2 存储预算：每版 2 个 exe ≈ 216MB，保留最近 3 版 ≈ 650MB，远低于 10GB 免费额度；
  旧版本可在桶里手动清理。
