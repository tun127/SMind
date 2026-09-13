# 第三方组件与许可声明（THIRD-PARTY NOTICES）

本项目（Mind）使用了下列优秀的开源组件，向这些项目的作者与贡献者致谢。
本文件用于满足各许可证的署名要求；**各组件的完整许可证文本以对应 npm 包内的
LICENSE / README 文件为准**，版本号以仓库的 `package.json` / `package-lock.json` 为准。

## 运行时依赖（会打包进应用）

| 组件 | 已发布版本 | 许可证 |
|---|---|---|
| electron | 44.3.0 | MIT |
| react / react-dom | 19.3.x | MIT |
| zustand | 5.0.x | MIT |
| immer | 11.1.x | MIT |
| @tiptap/react、@tiptap/starter-kit、@tiptap/extension-text-align、@tiptap/extension-text-style、@tiptap/extension-underline、@tiptap/pm | 3.31.x | MIT（@tiptap/pm 基于 ProseMirror，MIT） |
| jszip | 3.10.2 | MIT 或 GPL-3.0-or-later（本项目按 MIT 使用） |
| katex（含其内置字体，见下方「字体」一节） | 0.18.x | MIT |

## 开发 / 构建依赖（不随应用分发）

| 组件 | 已发布版本 | 许可证 |
|---|---|---|
| electron-vite | 5.0.x | MIT |
| vite | 7.3.x | MIT |
| @vitejs/plugin-react | 5.2.x | MIT |
| electron-builder | 26.15.x | MIT |
| typescript | 5.9.x | Apache-2.0 |
| lucide-react（工具栏图标） | 1.45.0 | ISC |
| @types/node、@types/react、@types/react-dom | — | MIT |

## 字体

应用内嵌的数学公式排版字体来自 [KaTeX](https://katex.org)。
KaTeX 的代码按 MIT 许可证授权（Copyright (c) 2013-2020 Khan Academy and other contributors）；
其字体文件源自 KaTeX 项目，按 **SIL Open Font License 1.1** 授权：
可以随软件自由再分发；若单独修改这些字体文件后再分发，需遵守 OFL 的字体改名要求
（**本项目未对字体做任何修改**，按原始文件打包）。

## 商标声明

Xmind、EdrawMind（亿图脑图）、MindMaster、知犀 等名称均为其各自所有者的商标。
本项目与上述产品**无任何隶属、合作或背书关系**；文档与界面中提及这些名称，
仅用于说明**文件格式的兼容性**与交互方式参照，不构成对任何产品的评价或比较性宣传。
