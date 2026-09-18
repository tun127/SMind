/**
 * 布局几何原语：坐标取整与锚点取点。
 *
 * 单一职责、零状态——摆放、连线、装饰都要用它，它不依赖任何布局状态。
 */
import type { NodeLayout } from '../types'

export function round(n: number): number {
  return Math.round(n * 10) / 10
}

export type Anchor = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface Point {
  x: number
  y: number
}

export function anchorPoint(node: NodeLayout, anchor: Anchor): Point {
  switch (anchor) {
    case 'left':
      return { x: node.x, y: round(node.y + node.height / 2) }
    case 'right':
      return { x: round(node.x + node.width), y: round(node.y + node.height / 2) }
    case 'top':
      return { x: round(node.x + node.width / 2), y: node.y }
    case 'bottom':
      return { x: round(node.x + node.width / 2), y: round(node.y + node.height) }
    default:
      return { x: round(node.x + node.width / 2), y: round(node.y + node.height / 2) }
  }
}
