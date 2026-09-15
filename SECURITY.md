# 安全说明

## 报告问题

发现安全问题时，请**不要**开公开 Issue，直接私下联系作者（见 `package.json` 的 `author` 字段）。
请附上：复现步骤、影响范围、以及能证明问题的样本文件（如恶意构造的 `.xmind`）。

## 这个软件的安全姿态

它是**本地优先**的桌面应用：文档、主题、设置、AI Key 都只存在本机，不上传任何服务器。
因此威胁模型里最需要认真对待的不是"远端的攻击者"，而是**恶意文件**——

**别人发来的 `.xmind` / `.emmx` 是不受信任的输入。** 打开这类文件时，内容会流经解析、
测量、渲染、导出四段代码。项目为此做了这些：

| 措施 | 位置 |
|---|---|
| 渲染进程跑在沙箱里，且关掉了 Node 集成 | `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` |
| 生产构建注入 CSP（`script-src 'self'`，禁 object / base / form） | `electron.vite.config.ts` 的 `smind-csp` |
| 外部字段**逐字段校验**后才进模型（富文本 run、代码块） | `src/shared/model/coerce.ts` |
| 富文本里的颜色/字体等会写进导出物的字符串，限定字符范围 | 同上（不允许引号、分号） |
| 公式出错时的消息经 `escapeHtml` 再拼进 HTML 属性 | `src/renderer/src/render/formula.ts` |
| 渲染层只能通过 preload 暴露的固定 IPC 通道触达主进程 | `src/preload/index.ts` |
| 主进程校验 IPC 入参（路径合法性、图片大小上限 20MB） | `src/shared/ipc-args.ts` |
| 外链只放行 `https?` / `mailto`；窗口导航与弹窗一律拦截 | `src/main/index.ts` |
| 包内资源走内存资源表，而不是按路径直读文件 | `src/main/index.ts` 的 `mind-resource` 协议 |

## 已知的薄弱处（尚未解决）

- **安装包未做代码签名**：首次运行会出现 SmartScreen「未知发布者」提示。
- **AI 配置以明文存在本机设置文件里**（`%APPDATA%\SMind\settings.json`）。
  这是本地应用常见的取舍：只要本机被攻破就等同于拿到 Key。
  如果介意，建议用权限受限的 API Key。
- `sandbox` 已开启，但 `webSecurity` 依赖默认值；如需更严可自行调整。

## 与 AI 功能相关的提醒

调用 AI 时，**你选中的文本会发送到你配置的那个 API 服务**（可以是官方服务、也可以是自建/中转）。
软件不代理、不缓存这些请求内容；请自行确认所用服务的隐私政策。
Key 只存在本机，软件不会把它发往所配置的 BaseURL 以外的任何地方。
