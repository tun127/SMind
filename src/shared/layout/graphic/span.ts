/**
 * 「实际占位」助手：节点尺寸 + 边界（上下）与概要（左右）在外侧的留白。
 *
 * 鱼骨、矩阵、放射这三种结构的行列与环间距全部按占位算出来，
 * 用裸 `size` 就会把留白算丢——加一个边界之后，边框与标题带会直接压到相邻的
 * 行 / 列 / 环上。所以三个算法共用这份口径。
 */
import type { Topic } from '../../model/types'
import type { LayoutBuilder } from '../core'

/**
 * 节点在布局里**实际**占的宽 / 高：尺寸加上边界（上下）与概要（左右）在外侧的留白。
 *
 * 这三种结构（鱼骨、矩阵、放射）的行列间距全部是"按占位算出来的"，
 * 用裸 `size` 算就会把留白算丢——加一个边界之后，边框与标题带会直接压到相邻的
 * 行 / 列 / 环上（用户之前看到的就是这类"压住"）。
 */
export function spanX(builder: LayoutBuilder, topic: Topic): number {
  return builder.size(topic.id).width + builder.reserveSpanX(topic)
}
export function spanY(builder: LayoutBuilder, topic: Topic): number {
  return builder.size(topic.id).height + builder.reserveSpanY(topic)
}
