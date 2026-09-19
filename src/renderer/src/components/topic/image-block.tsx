/**
 * 从 `TopicNode.tsx` 抽出的「节点内图片块（含资源缺失占位）」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { BLOCK_GAP } from '@shared/layout/accessory'
import { resourceUrl } from '../../render/resource'
import type { TopicNodeProps } from './props'

export function TopicImageBlock({
  image,
  imageBox,
  imageFailed,
  setFailedImagePath
}: {
  image: TopicNodeProps['node']['topic']['image']
  imageBox: { width: number; height: number } | null | undefined
  imageFailed: boolean
  setFailedImagePath: (path: string) => void
}): ReactElement {
  return (
    <>
      {/* 节点内图片：显示框尺寸来自布局测量结果，保证「测量=显示」 */}
      {image && imageBox && (
        <div className="topic__image" style={{ marginTop: BLOCK_GAP }}>
          {imageFailed ? (
            <div
              className="topic__image-missing"
              style={{ width: imageBox.width, height: imageBox.height }}
              title={`图片资源缺失：${image.path}`}
            >
              图片缺失
            </div>
          ) : (
            <img
              src={resourceUrl(image.path)}
              alt=""
              draggable={false}
              width={imageBox.width}
              height={imageBox.height}
              style={{ width: imageBox.width, height: imageBox.height }}
              onError={() => setFailedImagePath(image.path)}
            />
          )}
        </div>
      )}
    </>
  )
}
