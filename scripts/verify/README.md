# 两套验证资产：一条命令的门槛外验证

门槛（typecheck / lint / format:check / selfcheck / verify）覆盖的是**纯函数**；
下面两类缺陷它天然查不到，历史上也因此出过三次「全绿却不正确」：

| 类别 | 代表条目 | 为什么门槛查不到 |
|---|---|---|
| CSS × DOM 的约束 | **D-07**（组词期宽度被 flex-shrink 压回）、**D-14**（清空不缩回） | 自检没有 DOM，量不到 `getBoundingClientRect` |
| 主进程目录级行为 | **D-19**（旧存档不再被提示）、**D-18②**（存档目录残留） | `recoveryCheck` 在 `ipcMain` 上、依赖 `ctx.stateOf(sender)`，纯 Node 跑不到 |

## 三个脚本的分工（别互相替代）

| 脚本 | 跑什么 | 证明什么 | 代价 |
|---|---|---|---|
| `renderer-geometry.cjs` + `renderer-probe.js` | **复刻 DOM** + 产品自己的 CSS（真窗口） | CSS 约束机制：A3 的做法为什么无效、D-07 的写法为什么有效；composition 事件管线；`__probeD14()` 可执行 | 无需打包产物，秒级 |
| `autosave-check.ts` | Electron 主进程 + 临时 userData | 自动存档的目录级行为（枚举 / 兜底 / 清理） | 需 esbuild 打包一次 |
| `app-cdp.cjs` | **真实打包版 App**（CDP 驱动） | 走产品自己的编辑器 / 测量 / IPC：组词不折行（D-07）、清空不缩回探针（D-14） | 要先打包、起进程，读完要自己关进程 |

前两个由下面这条命令一起跑；第三个要手动起 App（见下）。

## 一条命令（前两个）

```powershell
& '.\scripts\verify\run-all.ps1'
```

两条各自打印 `PASS/FAIL` 与 `SUMMARY pass=N fail=M`，整体退出码非 0 即失败。

## 真实 App（D-07 / D-14）

```powershell
# 1) 起打包版 App 并打开调试端口
.\release\win-unpacked\SMind.exe --remote-debugging-port=9222
# 2) 另一个窗口里跑
node scripts/verify/app-cdp.cjs
# 3) 用完自己关掉那个进程（脚本只关自己的连接，不杀 App）
Get-Process SMind | Where-Object { $_.Path -like '*release\win-unpacked*' } | Stop-Process
```

可选环境变量：`CDP_PORT`（默认 9222）、`COMPOSE_TEXT`（默认 `dawadawdwa`）。
判据见 `docs/defect-report-2026-09-21.md` §15.2（D-07）与 §3（D-14 的甲/乙/丙）。

### 两条踩过的坑（写进脚本注释了，这里再记一次）

1. **组词前必须先清空编辑区**：直接双击已有标题的节点，拼音会接在原标题前面，读数含原有文字 →
   得出**假 FAIL**（§15.3 就是这么来的）。
2. **脚本红了先怀疑脚本**：真机读数与复刻 DOM 的结论可能不同（例如 flex-shrink 在真实布局里
   并不起收缩作用），别急着改产品代码。

## 仍需人手的三项（脚本替代不了）

真实输入法连打 8 音节（合成分词与真人敲键盘还有最后一毫米）、两标签→强杀→重启看候选、
保存中切标签 —— 见报告 §12.4。
