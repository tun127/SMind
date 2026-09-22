import type { Dispatch, ReactElement, SetStateAction } from 'react'
import { defaultDocumentName } from '@shared/model/naming'
import Canvas from '../components/Canvas'
import ChatPanel from '../components/ChatPanel'
import NodePanel from '../components/NodePanel'
import OutlinePanel from '../components/OutlinePanel'
import SearchPanel from '../components/SearchPanel'
import ThemePanel from '../components/ThemePanel'
import { snapshotForSave, useEditor } from '../store/editor'
import { activeDocId } from '../store/tabs'
import type { useDocumentActions } from './use-document-actions'
import type { useKeyboardShortcuts } from './use-keyboard-shortcuts'

/**
 * 左侧大纲 + 画布 + 右侧抽屉（自 App.tsx 整块搬出，JSX 块体逐字未改）。
 *
 * - 外层是 <></> Fragment：不产生 DOM 节点，DOM 结构与搬迁前一致；
 * - props 原样传（子组件里的名字与 App 局部同名）→ 块体一个字都没改；
 * - 不给它加 memo、父组件回调也不重新包装 → React 的浅比较面完全没变；
 * - onBeforeAiWrite 里「AI 动手前先存一份盘上的快照」那条链路（含注释与 reason: 'manual'）逐字保留。
 *
 * 它对 App 的 effect 序列没有贡献（本组件里没有 effect），所以位置不影响顺序语义。
 */

/** 右侧抽屉的取值集合：派生自 useKeyboardShortcuts 的入参声明，避免手抄联合类型 */
export type SidePanelId = Parameters<Parameters<typeof useKeyboardShortcuts>[0]['setSidePanel']>[0]

interface Props {
  showOutline: boolean
  setShowOutline: Dispatch<SetStateAction<boolean>>
  sidePanel: SidePanelId
  setSidePanel: Dispatch<SetStateAction<SidePanelId>>
  showToast(message: string): void
  handleSetDefaultTheme: ReturnType<typeof useDocumentActions>['handleSetDefaultTheme']
  setShowAiSettings: Dispatch<SetStateAction<boolean>>
}

export function AppSidePanels({
  showOutline,
  setShowOutline,
  sidePanel,
  setSidePanel,
  showToast,
  handleSetDefaultTheme,
  setShowAiSettings
}: Props): ReactElement {
  return (
    <>
      <div className={showOutline ? 'app__body app__body--with-outline' : 'app__body'}>
        {showOutline && <OutlinePanel onClose={() => setShowOutline(false)} onNotify={showToast} />}
        <Canvas onNotify={showToast} />
        {sidePanel === 'theme' && (
          <ThemePanel
            onClose={() => setSidePanel('none')}
            onNotify={showToast}
            onSetDefaultTheme={handleSetDefaultTheme}
          />
        )}
        {sidePanel === 'node' && (
          <NodePanel onClose={() => setSidePanel('none')} onNotify={showToast} />
        )}
        {sidePanel === 'search' && (
          <SearchPanel onClose={() => setSidePanel('none')} onNotify={showToast} />
        )}
        {sidePanel === 'chat' && (
          <ChatPanel
            onClose={() => setSidePanel('none')}
            onOpenSettings={() => setShowAiSettings(true)}
            onBeforeAiWrite={() => {
              const store = useEditor.getState()
              // 撤销栈在内存里，崩溃就没了：AI 动手前先存一份盘上的（未保存的文档不进版本快照）
              if (!store.filePath) return
              void window.api
                .snapshotCreate(activeDocId(), {
                  workbook: snapshotForSave(store),
                  path: store.filePath,
                  title: defaultDocumentName(store.workbook),
                  reason: 'manual',
                  note: 'AI 动手前的自动存档'
                })
                .catch(() => undefined)
            }}
          />
        )}
      </div>
    </>
  )
}
