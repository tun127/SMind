# 参与开发

## 环境

- Node.js 20+
- Windows / macOS / Linux 均可开发，打包目前只配了 Windows x64

```bash
npm install
npm run dev          # 开发模式（热更新）
```

## 提交前请确保这四条都过

```bash
npm run typecheck    # TypeScript 零错误
npm run lint         # ESLint 零 error（warning 允许）
npm run selfcheck    # 内核自检：1500+ 项断言
npm run verify       # 用 samples/ 里的真实文件做往返比对
```

这四条也正是 CI 跑的内容（`.github/workflows/ci.yml`），本地先跑一遍能省一次往返。

## 改代码时的几条约定

| 约定 | 为什么 |
|---|---|
| **改了行为就补 `selfcheck` 断言** | 这个项目最有效的质量手段就是它：每次改动都靠它守住内核。历史上多个真缺陷（撤销合并会改坏数组、拖拽落点错位、落点裁决在缩放后失效）都是先被自检抓出来的 |
| **能抽成纯函数就别留在组件里** | 纯函数才能被自检覆盖。落点裁决（`shared/model/drop.ts`）、打开文件参数识别（`shared/openfile.ts`）、原子写（`main/atomic-write.ts`）都是这么拆出来的 |
| **重复实现要么统一、要么写清原因** | 项目里已经统一过：`isRecord` 收敛到 `shared/guards.ts`、HTML 转义收敛到 `shared/richtext`、编辑态收敛到 `NO_EDITING` + `editingContent`。发现第三份实现时，先想想能不能合并 |
| **注释写"为什么"，不写"做了什么"** | 代码本身说明做了什么；注释要留住的是取舍、被否决的方案、以及"看起来多余但删了会出事"的原因 |
| **提交按主题拆开** | 一次提交一件事。改动在文件间交织时应拆分为多次提交，别把一整个会话攒成一笔 |
| **格式交给 Prettier** | `npm run format`。不要为了格式去手改大段代码，那会淹没真正的改动 |

## 目录速览

```
src/main/        Electron 主进程（窗口、IPC、文件读写、菜单、日志、原子写）
src/preload/     contextBridge 暴露的 api（渲染进程能调用的全部能力）
src/shared/      两侧共用的纯逻辑：模型、布局、xmind 读写、搜索、导入导出
src/renderer/    React 界面（画布、面板、编辑态 store）
scripts/         自检、样本生成、图标生成、往返验证
samples/         真实 .xmind / .emmx 样本（往返验证的输入）
docs/            需求、验收清单、待修问题清单、分发说明
```

## 已知待办

见 [`docs/known-issues.md`](docs/known-issues.md)：那里按 P0–P5 列了当前还欠缺什么、
每条的证据（文件:行号）、建议改法与验收方式。
