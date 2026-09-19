/**
 * 面板「选到节点」分支里的「附件」段。
 *
 * 整块 JSX 与三个处理器（打开 / 导出 / 添加）一起搬出——它们都不碰草稿，
 * 可以整段跟着走；props 原样传，store 订阅随块一起搬进本模块。
 */

import { Download, FolderOpen, Paperclip, X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { Topic } from '@shared/model/types'
import { useEditor } from '../../store/editor'
import { activeDocId } from '../../store/tabs'

/** 附件大小显示成 KB/MB，列表里一眼能看出体积 */
function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface Props {
  topic: Topic
  topicId: string
  onNotify(message: string): void
}

export default function AttachmentSection({ topic, topicId, onNotify }: Props): ReactElement {
  const addAttachment = useEditor((s) => s.addAttachment)
  const removeAttachment = useEditor((s) => s.removeAttachment)

  const attachFile = async (): Promise<void> => {
    try {
      const picked = await window.api.pickAttachment(activeDocId())
      if (!picked) return
      addAttachment(topicId, picked)
      onNotify(`已添加附件 ${picked.name}，保存时会打包进 .xmind`)
    } catch (error) {
      onNotify(`添加附件失败：${(error as Error).message}`)
    }
  }

  const openAttachment = async (path: string, name: string): Promise<void> => {
    try {
      const ok = await window.api.openAttachment(path, name)
      if (!ok) onNotify('打不开这个附件：它可能只是文件里的记录，内容已经丢失')
    } catch (error) {
      onNotify(`打开附件失败：${(error as Error).message}`)
    }
  }

  const exportAttachment = async (path: string, name: string): Promise<void> => {
    try {
      const ok = await window.api.saveAttachmentAs(path, name)
      if (ok) onNotify('附件已导出')
    } catch (error) {
      onNotify(`导出附件失败：${(error as Error).message}`)
    }
  }

  return (
    <>
      <div className="side-panel__title">附件</div>
      {topic.attachments.length > 0 && (
        <div className="attachment-list">
          {topic.attachments.map((item) => (
            <div key={item.id} className="attachment-row">
              <Paperclip size={13} />
              <span className="attachment-row__name" title={item.name}>
                {item.name}
              </span>
              <span className="attachment-row__size">{formatSize(item.size)}</span>
              <button
                type="button"
                className="chip__del"
                title="用系统默认程序打开"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void openAttachment(item.path, item.name)}
              >
                <FolderOpen size={12} />
              </button>
              <button
                type="button"
                className="chip__del"
                title="导出到其他位置"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void exportAttachment(item.path, item.name)}
              >
                <Download size={12} />
              </button>
              <button
                type="button"
                className="chip__del"
                title="移除附件"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => removeAttachment(topicId, item.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="side-panel__row">
        <button
          type="button"
          className="btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void attachFile()}
        >
          <Paperclip size={14} />
          添加附件…
        </button>
      </div>
    </>
  )
}
