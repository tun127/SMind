import type { RecoveryInfo, RecoveryList } from '@shared/ipc'

/**
 * 恢复候选的界面状态（纯函数）。
 *
 * 数据层已经从 `recoveryCheck` 返回逐份候选列表；这一层只负责把列表稳定地交给 UI，
 * 并让“两份候选都会出现在列表里”变成可自检的状态断言，而不是只能靠真机点出来。
 */
export interface RecoveryState {
  items: RecoveryInfo[]
}

/** 最近保存的排在最前；主进程已排序，这里再兜一层，别让 UI 依赖调用顺序。 */
export function recoveryStateFromList(list: Pick<RecoveryList, 'items'>): RecoveryState {
  return {
    items: [...list.items].sort((left, right) => right.savedAt - left.savedAt)
  }
}

/** 按对象身份移除一份候选；恢复/忽略成功后只动它自己，不碰别的标签。 */
export function removeRecoveryItem(state: RecoveryState, item: RecoveryInfo): RecoveryState {
  return { items: state.items.filter((candidate) => candidate !== item) }
}

/** 文案统一说清“有几份候选”，列表与 toast 共用。 */
export function recoveryCountText(total: number): string {
  return `发现 ${total} 份未保存的内容`
}

/** React 列表 key：旧格式没有 docId 时用时间戳+标题兜底。 */
export function recoveryItemKey(info: RecoveryInfo): string {
  return info.docId ?? `${info.savedAt}:${info.title}`
}
