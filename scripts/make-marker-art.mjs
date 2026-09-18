/**
 * 从 `lucide-react` 提取标记图标的**矢量数据**，生成 `src/shared/marker-art.ts`。
 *
 * 为什么要生成一份而不是直接引用：
 * - 导出层（SVG 字符串与 Canvas 位图两个后端）都需要**在没有 React 的环境里**
 *   拿到同一份图形（自检在 Node 里跑、位图后端用 Path2D）；
 * - 而 lucide-react 的图标节点数据在包内部（`dist/esm/icons/*.mjs` 的 `__iconData`），
 *   不是公开入口——直接 import 包内部路径太脆，生成一份就把它固定下来了。
 *
 * 与 `npm run fonts`（生成 katex-assets.ts）是同一套路：
 * **生成物进仓库**，`npm run marker-art` 只在升级 lucide 时需要重跑。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import prettier from 'prettier'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** 图形名 → lucide 图标文件名（与 `render/markers.ts` 的 MarkerGlyph 一一对应） */
const ICONS = {
  star: 'star',
  flag: 'flag',
  smile: 'smile',
  laugh: 'laugh',
  angry: 'angry',
  frown: 'frown',
  plus: 'plus',
  minus: 'minus',
  question: 'circle-help',
  exclam: 'triangle-alert',
  'arrow-up': 'arrow-up',
  'arrow-down': 'arrow-down',
  people: 'users',
  'light-bulb': 'lightbulb',
  crown: 'crown',
  finance: 'circle-dollar-sign',
  award: 'award'
}

const SUPPORTED_TAGS = new Set(['path', 'circle', 'line', 'polyline', 'polygon', 'rect'])
const SUPPORTED_ATTRS = new Set([
  'd',
  'cx',
  'cy',
  'r',
  'x',
  'y',
  'width',
  'height',
  'rx',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'key',
  // lucide 里偶见显式声明的绘制属性：我们的默认值就是 stroke-only，
  // 这几个值与默认一致，允许出现但不写进产物
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin'
])

function num(value, where) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${where}: 期望数字，得到 ${String(value)}`)
  return Math.round(parsed * 1000) / 1000
}

/** 把 lucide 的图标节点压成最小的图元列表（只保留坐标） */
function normalize(name, node) {
  if (!Array.isArray(node) || node.length === 0) throw new Error(`${name}: 图标节点为空`)
  return node.map(([tag, attrs], index) => {
    const where = `${name}[${index}] <${String(tag)}>`
    if (!SUPPORTED_TAGS.has(tag)) throw new Error(`${where}: 未支持的图元`)
    for (const key of Object.keys(attrs)) {
      if (!SUPPORTED_ATTRS.has(key)) throw new Error(`${where}: 未支持的属性 ${key}`)
    }
    switch (tag) {
      case 'path':
        if (typeof attrs.d !== 'string') throw new Error(`${where}: 缺 d`)
        return { k: 'path', d: attrs.d }
      case 'circle':
        return { k: 'circle', cx: num(attrs.cx, where), cy: num(attrs.cy, where), r: num(attrs.r, where) }
      case 'line':
        return {
          k: 'line',
          x1: num(attrs.x1, where),
          y1: num(attrs.y1, where),
          x2: num(attrs.x2, where),
          y2: num(attrs.y2, where)
        }
      case 'polyline':
        return { k: 'polyline', points: String(attrs.points) }
      case 'polygon':
        return { k: 'polygon', points: String(attrs.points) }
      default:
        return {
          k: 'rect',
          x: num(attrs.x, where),
          y: num(attrs.y, where),
          w: num(attrs.width, where),
          h: num(attrs.height, where),
          ...(attrs.rx === undefined ? {} : { rx: num(attrs.rx, where) })
        }
    }
  })
}

/**
 * 图标文件名并不总是直接带着数据：lucide 里 `smile.mjs` 只是
 * `export { default } from './face-slightly-smiling.mjs'` 的转发，
 * 真正导出 `__iconData` 的是被转发的那个文件。这里顺着转发链找到实体。
 */
function resolveIconFile(file) {
  let current = file
  for (let depth = 0; depth < 8; depth += 1) {
    const modulePath = path.join(root, 'node_modules/lucide-react/dist/esm/icons', `${current}.mjs`)
    const source = readFileSync(modulePath, 'utf8')
    if (source.includes('__iconData')) return modulePath
    const forwarded = /from '\.\/([\w-]+)\.mjs'/.exec(source)
    if (!forwarded) throw new Error(`${current}: 既没有 __iconData 也没有转发目标`)
    current = forwarded[1]
  }
  throw new Error(`${file}: 转发链过深`)
}

const art = {}
for (const [glyph, file] of Object.entries(ICONS)) {
  const mod = await import(pathToFileURL(resolveIconFile(file)).href)
  const data = mod.__iconData
  if (!data) throw new Error(`${file}: 没有找到 __iconData（lucide 版本变了？）`)
  art[glyph] = normalize(glyph, data.node)
}

const header = `/**
 * 标记图标的矢量数据。
 *
 * ⚠️ **自动生成，不要手改**：\`npm run marker-art\`（脚本见 \`scripts/make-marker-art.mjs\`）。
 * 数据来自 lucide-react（ISC 许可，见 THIRD-PARTY-NOTICES），
 * 去掉了一切与坐标无关的属性——默认绘制方式就是"只描边、圆头、不填充"，
 * 与画布上 \`MarkerIcon\` 的 \`strokeWidth\` 一致（见 MARKER_STROKE_WIDTH）。
 */

/** 一块图元：坐标都在 24×24 的视图盒里 */
export type IconShape =
  | { k: 'path'; d: string }
  | { k: 'circle'; cx: number; cy: number; r: number }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { k: 'polyline'; points: string }
  | { k: 'polygon'; points: string }
  | { k: 'rect'; x: number; y: number; w: number; h: number; rx?: number }

/** 所有图标共用的视图盒边长 */
export const ICON_VIEWBOX = 24

/**
 * 与画布 \`MarkerIcon\` 的 \`strokeWidth\` 保持一致的线宽。
 * 两者不一致的话，导出的图标会比屏幕上的粗/细一圈。
 */
export const MARKER_STROKE_WIDTH = 2.2

/**
 * 图形名 → 图元列表。
 *
 * 键与 \`render/markers.ts\` 的 \`MarkerGlyph\` 一一对应；
 * 自检里有一条断言逐个核对"每个图形都有数据"，漏一个会当场失败。
 */
export const ICON_ART: Record<string, readonly IconShape[]> = ${JSON.stringify(art, null, 2)}
`

const target = path.join(root, 'src/shared/marker-art.ts')
// 直接按项目的 Prettier 规则出格式：生成物不必再被 `format:check` 追着改一遍
writeFileSync(target, await prettier.format(header, { filepath: target }), 'utf8')
console.log(`已生成 ${path.relative(root, target)}：${Object.keys(art).length} 个图形`)
for (const [glyph, shapes] of Object.entries(art)) {
  console.log(`  ${glyph.padEnd(12)} ${shapes.length} 个图元`)
}
