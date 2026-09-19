import { registerHistoryIpc } from '../ipc/history'
import { registerWindowIpc } from '../ipc/window'
import { registerThemeIpc } from '../ipc/theme'
import { registerSettingsIpc } from '../ipc/settings'
import { registerRecoveryIpc } from '../ipc/recovery'
import { registerDocumentIpc } from '../ipc/document'
import { registerMediaIpc } from '../ipc/media'
import { registerExportIpc } from '../ipc/export'
import { registerAiIpc } from '../ipc/ai'
import { registerLicenseIpc } from '../ipc/license'
import { registerChatHistoryIpc } from '../ipc/chat-history'
import { registerDiagnosticIpc } from '../ipc/diagnostic'
import { registerImportIpc } from '../ipc/import'
import { registerSnapshotIpc } from '../ipc/snapshot'
import type { MainContext } from '../context'

export function registerIpc(ctx: MainContext): void {
  /* ---- 窗口与文档壳（标签 / 新窗口 / 画布副本 / 关窗确认 / 外链） ---- */
  registerWindowIpc(ctx)

  /* ---- 打开 / 保存 / 自动保存 ---- */
  registerDocumentIpc(ctx)

  /* ---- 崩溃恢复 ---- */
  registerRecoveryIpc(ctx)

  /* ---- 应用设置（%APPDATA%\SMind\settings.json） ---- */
  registerSettingsIpc()

  /* ---- 主题 ---- */
  registerThemeIpc(ctx)

  /* ---- 图片与附件（P4） ---- */

  registerMediaIpc(ctx)

  /* ---- 大纲导出（P5） ---- */

  registerExportIpc(ctx)

  /* ---- AI（P8） ---- */

  registerAiIpc()

  /* ---- 许可与试用（商业化闸门：Pro 解锁写工具，免费送 30 个写回合） ---- */

  registerLicenseIpc()

  /* ---- AI 聊天记录（按文档持久化） ---- */

  registerChatHistoryIpc()

  /**
   * 卡死取证：渲染层节流落盘的现场（wire / workbook / 阶段）。
   *
   * 历次冻结都发生在「写意图落盘后的渲染」，而未命名文档没有自动存档、聊天也不落盘——
   * 强杀进程会把毒内容一起带走，下一轮只能从零猜。这份转储让任何一次冻结之后，
   * `%APPDATA%/smind/diag/last-state.json` 里都留着完整现场。
   */
  registerDiagnosticIpc()

  /* ---- 文档 → 导图（拖一份文档进来，AI 读完做成导图） ---- */

  registerImportIpc(ctx)

  /* ---- 大纲文件导入（Markdown / OPML） ---- */

  /* ---- 历史记录与常用（P9+） ---- */
  registerHistoryIpc(ctx)

  /* ---- 文档版本快照（P9+） ---- */

  registerSnapshotIpc(ctx)

  /**
   * 渲染层报告界面已损坏（错误边界触发）；页面重新加载完成时会自动清除。
   * 顺手把错误写进日志——渲染期异常以前只打在终端里，应用一重启就查不到了。
   */
}
