# 全量审读与解耦报告

> 范围：`src/**`、`scripts/**` 全部 **121 个文件 / 48,588 行**，逐文件读完（大文件分块读到末尾，未抽样）。
> 验收协议：每完成一批改动，必须 `typecheck` + `lint` + `format:check` + `selfcheck`（2522 项断言）+ `verify`（21 样本往返）全绿。

## 一、结论速览

| 维度 | 结论 |
|---|---|
| 分层方向 | `shared` 从不 import `renderer`/`main`；`main`/`preload` 不 import `renderer`；**无循环依赖** |
| 死代码总量 | 比预期少：真正零引用约 20 处（占 0.4%），另有约 12 处「仅内部使用却对外导出」 |
| 真正的问题 | **巨型文件**：9 个文件 ≥ 1000 行，承担 6–13 类互不相关职责 |
| 重复实现 | 19 组「同一件事两处以上实现」 |
| IPC 面 | 70 个通道常量中 69 个双向闭合，唯一孤儿 `documentReset` 已删 |

## 二、死代码：处置结果

### 2.1 已删除（零引用，机械复核过）

| 位置 | 符号 | 说明 |
|---|---|---|
| `shared/ipc.ts` | `IPC.documentReset` | 主进程无注册、preload 无调用、渲染层无引用 |
| `main/atomic-write.ts` | `ATOMIC_TEMP_SUFFIX` | 注释声称「供清理残留匹配」，但无任何实现 |
| `shared/layout/overlays.ts` | `boundsOfRange` / `accumulateBounds` / `EMPTY_BOUNDS` | 三者构成的死簇（旧版逐区间递归求包围盒，已被 `indexSubtreeBounds` 取代） |
| `shared/model/drop.ts` | `oppositeOf` | 拖拽方向推断已改用 `perpendicularOf` 系列 |
| `shared/xmind/parse.ts` | `isLegacyXmind` | `parseXmind` 内部按「有无 content.json」直接判定，不走它 |
| `shared/xmind/emmx.ts` | `EMMX_DOCUMENT_FILE` | 只有声明，`.emmx` 解析只读 `page.bin` |
| `shared/xmind/constants.ts` | `structureLabel` | 结构名取值统一走 `getStructureDef().label` |
| `shared/richtext/index.ts` | `DEFAULT_RICH_FONT_SIZE` / `makeRun` / `makeParagraph` / `titleTextOf` / `resolveWeight` / `textDecorationOf` | 6 个「展示辅助」类导出全无消费方 |
| `renderer/components/TabBar.tsx` | `tabDisplayName` | 注释写着「供自检判断」，实际自检从未使用 |
| `renderer/export/index.ts` | `EXPORT_FORMATS` / `EXPORT_SCALES` / `imageExportFormatDef` 再导出块、`ExportFormat` | 消费方全部直接从 `@shared/export/types` 导入 |
| `renderer/store/editor.ts` | `countTopics` / `countCharacters` 再导出 | 消费方全部直接从 `@shared/model/tree` 导入 |
| `shared/theme/index.ts` | `export { cloneColors }` | 冗余再导出（函数本身继续内部使用） |
| `renderer/components/Toolbar.tsx` | `estimatedHeight = 60 + 62 * 0 + 0` | 恒为 60 的死算术 |
| `renderer/export/raster.ts` | `op.kind === 'image' ? op.href : op.href` | 三元两侧字面相同 |
| `shared/ai/index.ts` | `const first = lines.shift() ?? ''; void first` | 取出即弃的死语句 |
| `shared/agent/index.ts` | `title.length === 0 ? '清空…' : '改名…'` | 空标题在上游已被拒绝 → 该分支不可达 |

### 2.2 收窄导出面（改为模块私有，行为不变）

`resources.RESOURCES_DIR`、`dragmove.parentMapOf`、`legacy.LEGACY_PROVIDER`、`code/highlight.normalizeCodeLanguage`、`dev/stage.clearStats/disarmDiag`、`ai.stripCodeFence/parseOutlineLine/looksLikeTopic/parseNoteLine`、`agent.normalizeTopicTitle/AGENT_TOOL_RESULT_MAX`、`export/index.ExportOptions/ExportResult`

### 2.3 保留（生产无调用，但有断言覆盖）

`window.findWindowForPath`、`drop.closestNodeWithin`、`drop.rectsIntersect`、`editor/typedChar.clearTypedChar`、`render/theme.withAlpha`、`export/katex-assets.KATEX_INLINED_FONTS`

这些是纯函数且被自检直接断言。删函数就得删断言（保护度下降），故保留并在此登记。

### 2.4 重复实现

| 重复项 | 处置 |
|---|---|
| `fileNameOf`（`App.tsx` 与 `StatusBar.tsx` 逐字两份） | ✅ 收敛到 `@shared/model/naming.fileNameOf` |
| 调色板 8 色（`RichFormatBar` 内 `DEFAULT_COLORS` 与 `COLORS` 逐字两份） | ✅ 保留一份 |
| `NodePanel.formatSize` vs `@shared/snapshot.formatBytes` | 待办 |
| XML 实体解码 3 份（`xmind/xml.ts`、`document/index.ts`、`import/markdown.ts`） | 待办 |
| CRC32 + PNG 编码 2 份（`make-samples.mjs`、`make-icon.mjs`） | 待办：抽 `scripts/lib/png.mjs` |
| esbuild 打包模板 3 份（`run-selfcheck` / `run-license-tool` / `run-diag-freeze`） | 待办：合成一个 runner |
| 概览文字默认样式（`Canvas` / `NodePanel` / `export/drawing` 三处） | 待办：收敛到 `@shared/model/overlay-style` |

## 三、巨型文件拆分计划

统一原则：**用 barrel（`index.ts` 再导出）或原文件保留入口，让调用点改动为 0–2 行**。

| 现存文件 | 行数 | 目标 | 手法 | 调用点改动 |
|---|---|---|---|---|
| `scripts/selfcheck.ts` | 11,317 | `scripts/selfcheck/` 16 域文件 + `harness.ts` | 先抽 helper，再按域搬节，`main()` 顺序不变 | 0 |
| `renderer/components/Canvas.tsx` | 2,869 | `canvas/` 11 个（4 hooks + 3 纯函数 + 4 组件） | 抽 hooks / 纯函数 / 子组件 | 0 |
| `main/index.ts` | 2,417 | `main/` 18 个（ipc/* 12 + windows/files/ai/lifecycle） | IPC 回调按域搬迁 + 注入 `ctx`，**通道名不变** | 0 |
| `shared/agent/index.ts` | 2,308 | `agent/` 7 个 | barrel 保留 | 0 |
| `renderer/store/editor.ts` | 2,283 | `store/slices/` 6 个 + 纯逻辑下沉 `shared/model` | zustand 切片组合 | 0 |
| `renderer/components/ChatPanel.tsx` | 1,934 | `chat/` 5 个 | 抽 runtime / 纯函数 / 子组件；许可 UI 与 `AiSettingsDialog` 合并 | 0 |
| `shared/ai/index.ts` | 1,786 | `ai/` 6 个 + `ai/prompts/` 3 个 | barrel 保留；提示词文本独立成文件 | 0 |
| `shared/code/highlight.ts` | 1,484 | `code/` 3 个 | 入口文件保留转发 | 0 |
| `renderer/components/App.tsx` | 1,270 | `app/` 8 个 hooks | 逐类副作用抽 hook | 0 |
| `shared/layout/core.ts` | 1,252 | `core/` 5 个（cache/extents/reserves/connect/builder） | 原文件改聚合再导出 | 0 |
| `renderer/components/Toolbar.tsx` | 1,060 | `toolbar/` 3 个 | 自洽组件直接搬家 | 0 |
| `renderer/components/NodePanel.tsx` | 815 | `nodePanel/` 4 个 | 两条独立分支拆组件 | 0 |
| `shared/layout/overlays.ts` | 789 | `overlays/` 5 个 | `overlays/index.ts` 汇总 | 0 |
| `shared/import/markdown.ts` | 779 | `import/markdown/` 2 个 | index 再导出 | 0 |
| `renderer/export/drawing.ts` | 739 | `export/` 4 个（ops/drawNode/drawOverlay/组合器） | svg/raster 改从 `ops` 引类型 | 2 |
| `renderer/render/measure.ts` | 698 | `render/` 6 个 | 原文件 `export *` 兼容 | 0 |
| `shared/layout/graphic.ts` | 669 | `graphic/` 4 个 | `run.ts` 改 import 路径 | 3 |
| `renderer/components/TopicNode.tsx` | 619 | `topic/` 5 个 | 抽子组件 | 0 |
| `renderer/styles.css` | 3,650 | `styles/*.css` 12 个 | 按现有区块切分，`main.tsx` 按原顺序 import | 1 |

## 四、执行顺序（每步都要过五道门槛）

1. ✅ **死代码清理**（§2）——已全绿
2. `shared` 层：`layout/core` → `overlays` → `graphic` → `agent` → `ai` → `highlight`
3. 渲染层：`measure` → `drawing` → `TopicNode` → `NodePanel` → `Toolbar` → `ChatPanel` → `App` → `Canvas`
4. `store/editor.ts` 切片 + 纯逻辑下沉（撤销/排序/移动/派生值）
5. `main/index.ts` 按 IPC 域拆分（注入 `ctx`，通道名不动）
6. `selfcheck.ts` 按域拆分（harness 先落地，再逐域搬）
7. 重复实现收敛（§2.4 剩余项）+ `styles.css` 拆分
8. 文档与门槛收口（CHANGELOG / known-issues 状态更新）

## 五、刻意不做

- **不合并** `shared/cache.ts`、`code-language.ts`、`export/types.ts` 等小文件——它们正是「跨 `main`+`renderer` 复用的单一用途文件」，合并反而破坏分层。
- **不动** `katex-assets.ts`（361 KB 生成物）：只记录「建议后续移出 `src`」，本轮不搬以免打断构建。
- **不改 UI 行为**：`NodePanel` 的 7 色画布元素调色板是对正文 8 色的有意子集。

## 六、本轮验收（已实测）

```
typecheck    零错误（含 strict）
lint         零 error / 零 warning
format:check 全部通过
selfcheck    2522 项断言全绿
verify       21 个样本往返一致
工作树       25 个文件有改动（含此前 A 档未提交的 3 个）
```
