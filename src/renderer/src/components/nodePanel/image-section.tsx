/**
 * 面板「选到节点」分支里的「节点内图片」段。
 *
 * 整块 JSX 与原处理器 `insertImage` 一起搬出（处理器不碰草稿，可以整段跟着走），
 * props 原样传，store 订阅随块一起搬进本模块。
 */

import { Image as ImageIcon, X } from 'lucide-react'
import type { ReactElement } from 'react'
import { imageBoxSize } from '@shared/layout/accessory'
import type { Topic } from '@shared/model/types'
import { resourceUrl } from '../../render/resource'
import { useEditor } from '../../store/editor'
import { activeDocId } from '../../store/tabs'

interface Props {
  topic: Topic
  topicId: string
  onNotify(message: string): void
}

export default function ImageSection({ topic, topicId, onNotify }: Props): ReactElement {
  const setImage = useEditor((s) => s.setImage)

  const insertImage = async (): Promise<void> => {
    try {
      const picked = await window.api.pickImage(activeDocId())
      if (!picked) return
      setImage(topicId, { path: picked.path, width: picked.width, height: picked.height })
      onNotify(
        picked.width > 0
          ? `已插入图片 ${picked.name}（${picked.width}×${picked.height}）`
          : `已插入图片 ${picked.name}（未取到像素尺寸，按默认大小显示）`
      )
    } catch (error) {
      onNotify(`插入图片失败：${(error as Error).message}`)
    }
  }

  return (
    <>
      <div className="side-panel__title">节点内图片</div>
      {topic.image ? (
        <div className="image-row">
          <img
            className="image-row__thumb"
            src={resourceUrl(topic.image.path)}
            alt=""
            style={{ width: 64, height: 48 }}
          />
          <div className="image-row__meta">
            <div className="image-row__name" title={topic.image.path}>
              {topic.image.path.split('/').pop()}
            </div>
            <div className="side-panel__hint">
              {topic.image.width && topic.image.height
                ? `${topic.image.width}×${topic.image.height}`
                : '尺寸未知'}
              {' · 显示 '}
              {imageBoxSize(topic.image).width}×{imageBoxSize(topic.image).height}
            </div>
            <div className="side-panel__row">
              <button
                type="button"
                className="btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void insertImage()}
              >
                <ImageIcon size={14} />
                更换
              </button>
              <button
                type="button"
                className="btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setImage(topicId, null)}
              >
                <X size={14} />
                移除
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="side-panel__row">
          <button
            type="button"
            className="btn btn--primary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void insertImage()}
          >
            <ImageIcon size={14} />
            插入图片…
          </button>
        </div>
      )}
    </>
  )
}
