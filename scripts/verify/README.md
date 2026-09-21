# 一条命令跑完两类「门槛查不到」的验证

门槛（typecheck / lint / format:check / selfcheck / verify）覆盖的是**纯函数**；
下面这两类缺陷它天然查不到，历史上也因此出过三次「全绿却不正确」：

| 类别 | 代表条目 | 为什么门槛查不到 |
|---|---|---|
| CSS × DOM 的约束 | **D-07**（组词期宽度被 flex-shrink 压回）、**D-14**（清空不缩回） | 自检没有 DOM，量不到 `getBoundingClientRect` |
| 主进程目录级行为 | **D-19**（旧存档不再被提示）、**D-18②**（存档目录残留） | `recoveryCheck` 在 `ipcMain` 上、依赖 `ctx.stateOf(sender)`，纯 Node 跑不到 |

## 跑法

```powershell
pwsh scripts/verify/run-all.ps1
```

两条各自打印 `PASS/FAIL` 与 `SUMMARY pass=N fail=M`，整体退出码非 0 即失败。

## 它验的是什么（别当成整机验收）

- `renderer-geometry.cjs`：真窗口 + **产品自己的 CSS**（直接读 `src/renderer/src/styles/09-section.css`）
  搭出 `.topic > .topic__editor > .rich-editor__content`，然后
  ① 复刻 A3 的写法（只放开 `maxWidth`）→ 断言**宽度被压回**（这就是 A3 无效的原因）；
  ② 复刻 D-07 的写法（`flex: 0 0 auto`）→ 断言**宽度真的生效**；
  ③ 合成 `compositionstart/update/end` 验证事件管线可用；
  ④ 把 **D-14 的甲/乙/丙探针**代码化成 `window.__probeD14()`。
- `autosave-check.ts`：在 Electron 主进程里 `app.setPath('userData', 临时目录)`，
  复用产品自己的 `main/autosave.ts` / `shared/recovery.ts` 断言目录级行为
  （旧格式不被枚举但兜底可读；清理后本 slot 无残留、别的窗口不受影响）。

**仍需人手**的三项（脚本替代不了）：真实输入法连打 8 音节不折行、两标签→强杀→重启看候选、
保存中切标签。这三项见 `docs/defect-report-2026-09-21.md` §12.4。

## D-14 探针在真 App 里怎么用

`renderer-probe.js` 里的 `window.__probeD14()` 不依赖本脚本的 DOM —— 在 App 的 DevTools 控制台里
把那个函数体粘进去即可；判据（甲/乙/丙）见报告 §3 的表。
