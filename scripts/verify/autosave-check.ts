/**
 * 主进程侧验证：**目录级**断言（报告里五条挂账中的两条就卡在这里）。
 *
 * 为什么必须单独一个脚本：`recoveryCheck` 注册在 `ipcMain` 上、还依赖 `ctx.stateOf(sender)`，
 * 纯 Node 自检跑不到它；而它背后的文件级行为（枚举哪些存档、兜底读哪一份、清理清掉哪些）
 * 恰恰是 D-19 与 D-18② 的全部内容。
 *
 * 做法：直接在 **Electron 主进程**里跑（`app.setPath('userData', 临时目录)`），
 * 复用**产品自己的** `main/autosave.ts` 与 `shared/recovery.ts`，不复制判据：
 *   场景 A（D-19）：目录里只有旧的 `${slot}.xmind` + `${slot}.json`
 *                   → 断言 per-doc 枚举为空（所以兜底必需）、且兜底能读到它的 meta
 *   场景 B（D-18②）：N 份 per-doc（含一个"正文已不在、只剩 .json"的孤儿）
 *                   → 走与 windows.ts 相同的清理逻辑 → 断言目录里本 slot 无任何残留
 *
 * 构建与运行见 scripts/verify/run-all.ps1（esbuild 打包成 cjs 后交给 electron 跑）。
 */
import { app } from 'electron'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autosaveDir,
  autosaveFile,
  autosaveMeta,
  listAutosaveDocIds,
  readAutosaveMeta
} from '../../src/main/autosave'
import { isPerDocAutosaveArtifact } from '../../src/shared/recovery'

interface Case {
  name: string
  ok: boolean
  detail: string
}

const results: Case[] = []
const record = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail })
}

/** 关窗清理的等价实现（与 main/windows.ts 同一套：按 per-doc 产物枚举，两份文件都删） */
function pruneSlot(slot: string): void {
  for (const name of readdirSync(autosaveDir())) {
    if (!isPerDocAutosaveArtifact(name, slot)) continue
    rmSync(join(autosaveDir(), name), { force: true })
  }
  rmSync(join(autosaveDir(), `${slot}.xmind`), { force: true })
  rmSync(join(autosaveDir(), `${slot}.json`), { force: true })
}

app
  .whenReady()
  .then(async () => {
    app.setPath('userData', mkdtempSync(join(tmpdir(), 'smind-verify-')))
    mkdirSync(autosaveDir(), { recursive: true })
    const slot = 'slot-1'

    /* ---------- 场景 A：升级前留下的旧存档（D-19） ---------- */
    writeFileSync(join(autosaveDir(), `${slot}.xmind`), 'legacy-bytes')
    writeFileSync(
      join(autosaveDir(), `${slot}.json`),
      JSON.stringify({ originalPath: null, title: '旧存档', savedAt: Date.now() })
    )
    const perDoc = await listAutosaveDocIds(slot)
    record(
      'D-19：旧格式不被 per-doc 枚举（所以 recoveryCheck 必须有兜底，否则升级后不再提示恢复）',
      perDoc.length === 0,
      `枚举到 ${JSON.stringify(perDoc)}`
    )
    const legacyMeta = await readAutosaveMeta(slot, '')
    record(
      'D-19：兜底能读到旧格式的 meta（读侧本来就支持，只差 check 侧那一处）',
      legacyMeta?.title === '旧存档',
      JSON.stringify(legacyMeta)
    )
    pruneSlot(slot)
    record(
      'D-19：清理后旧格式也不残留',
      readdirSync(autosaveDir()).filter((name) => name.startsWith(slot)).length === 0,
      JSON.stringify(readdirSync(autosaveDir()))
    )

    /* ---------- 场景 B：多份 per-doc + 只剩 meta 的孤儿（D-18②） ---------- */
    const docIds = ['doc-a', 'doc-b', 'doc-c']
    for (const docId of docIds) {
      writeFileSync(autosaveFile(slot, docId), `bytes-${docId}`)
      writeFileSync(
        autosaveMeta(slot, docId),
        JSON.stringify({ originalPath: null, title: docId, savedAt: 1 })
      )
    }
    // 孤儿：正文已不在，只剩 meta（上一版的枚举器只认 .xmind，会把它永久漏掉）
    writeFileSync(
      autosaveMeta(slot, 'doc-orphan'),
      JSON.stringify({ originalPath: null, title: '孤儿', savedAt: 1 })
    )
    writeFileSync(join(autosaveDir(), 'slot-2-other.xmind'), 'other-window')

    const listed = await listAutosaveDocIds(slot)
    record(
      'D-18②：枚举覆盖「只剩 meta」的那份（否则它的 meta 永久残留）',
      listed.includes('doc-orphan') && listed.length === 4,
      JSON.stringify(listed)
    )

    pruneSlot(slot)
    const left = readdirSync(autosaveDir())
    record(
      'D-18②：清理后本 slot 无任何残留（含 .json / 孤儿 / 最近一份）',
      left.filter(
        (name) => name.startsWith(`${slot}-`) || name === `${slot}.xmind` || name === `${slot}.json`
      ).length === 0,
      JSON.stringify(left)
    )
    record('D-18②：别的窗口槽位不受影响', left.includes('slot-2-other.xmind'), JSON.stringify(left))

    console.log('=== 主进程侧：自动存档目录级（D-19 / D-18②） ===')
    for (const item of results) {
      console.log(
        `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? '   << ' + item.detail : ''}`
      )
    }
    const failed = results.filter((item) => !item.ok).length
    console.log(`SUMMARY pass=${results.length - failed} fail=${failed}`)
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error('HARNESS_ERROR', error && error.stack ? error.stack : String(error))
    app.exit(3)
  })
