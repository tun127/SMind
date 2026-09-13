/**
 * 生成应用图标（零依赖）。
 *
 * 造型仿 Typora：几张叠在一起的纸，纸上一枚大字母，左下角一个蓝色小徽标。
 * 这里字母用「M」（应用名 mind）。
 *
 * 全过程自己画、自己编码，不引任何图形库：
 *   1. 在放大 SS 倍的画布上用「点是否在形状内」逐像素作画，再降采样得到抗锯齿；
 *   2. 按 PNG 规范自己拼 IHDR / IDAT / IEND（zlib 用 Node 内置的）；
 *   3. 按 ICO 规范把多尺寸 PNG 打进一个 .ico（Vista 以后支持 PNG 条目）。
 *
 * 产物：build/icon.ico（多尺寸）、build/icon.png（256）、build/icon-512.png
 * 运行：npm run icon
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

/* ------------------------------------------------------------------ */
/* 配色                                                                */
/* ------------------------------------------------------------------ */

const PAPER = [255, 255, 255]
const PAPER_EDGE = [198, 205, 216]
const INK = [31, 35, 40]
const BADGE = [47, 107, 255]
const SHADOW = [23, 32, 56]

/* ------------------------------------------------------------------ */
/* 画布与画笔                                                          */
/* ------------------------------------------------------------------ */

class Canvas {
  constructor(size) {
    this.size = size
    this.data = new Float32Array(size * size * 4) // 直存 0..1 的 alpha，方便降采样
  }

  /**
   * source-over 混合一个像素。
   * 颜色与 alpha 一律按 **0..1** 存放（与降采样保持一致），
   * 传进来的颜色是 0..255，这里先归一化。
   */
  blend(x, y, color, alpha) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || alpha <= 0) return
    const i = (y * this.size + x) * 4
    const dstA = this.data[i + 3]
    const outA = alpha + dstA * (1 - alpha)
    if (outA <= 0) return
    for (let c = 0; c < 3; c += 1) {
      const src = color[c] / 255
      this.data[i + c] = (src * alpha + this.data[i + c] * dstA * (1 - alpha)) / outA
    }
    this.data[i + 3] = outA
  }

  /** 用「点是否在形状内」的判定函数填充，bounds 限定扫描范围 */
  fill(bounds, inside, color, alpha = 1) {
    const x0 = Math.max(0, Math.floor(bounds[0]))
    const y0 = Math.max(0, Math.floor(bounds[1]))
    const x1 = Math.min(this.size - 1, Math.ceil(bounds[2]))
    const y1 = Math.min(this.size - 1, Math.ceil(bounds[3]))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (inside(x + 0.5, y + 0.5)) this.blend(x, y, color, alpha)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 形状判定                                                            */
/* ------------------------------------------------------------------ */

/** 射线法判断点是否在多边形内 */
function pointInPolygon(px, py, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 圆角矩形判定；cx/cy 为中心，w/h 为边长，r 为圆角，angle 为旋转弧度 */
function insideRoundedRect(px, py, cx, cy, w, h, r, angle) {
  let dx = px - cx
  let dy = py - cy
  if (angle !== 0) {
    const cos = Math.cos(-angle)
    const sin = Math.sin(-angle)
    const rx = dx * cos - dy * sin
    const ry = dx * sin + dy * cos
    dx = rx
    dy = ry
  }
  const hw = w / 2
  const hh = h / 2
  const qx = Math.abs(dx) - (hw - r)
  const qy = Math.abs(dy) - (hh - r)
  if (qx <= 0 && qy <= 0) return true
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return ox * ox + oy * oy <= r * r && Math.abs(dx) <= hw && Math.abs(dy) <= hh
}

/** 在画布坐标里画一个「以图标比例描述」的圆角矩形 */
function paper(canvas, shape, color, alpha = 1) {
  const S = canvas.size
  const cx = shape.cx * S
  const cy = shape.cy * S
  const w = shape.w * S
  const h = shape.h * S
  const r = (shape.r ?? 0.06) * S
  const angle = shape.angle ?? 0
  const reach = Math.hypot(w, h) / 2 + 2
  canvas.fill(
    [cx - reach, cy - reach, cx + reach, cy + reach],
    (x, y) => insideRoundedRect(x, y, cx, cy, w, h, r, angle),
    color,
    alpha
  )
}

/** 圆角矩形的描边（用「大的减小的」构造） */
function paperEdge(canvas, shape, color, width, alpha = 1) {
  const S = canvas.size
  const cx = shape.cx * S
  const cy = shape.cy * S
  const w = shape.w * S
  const h = shape.h * S
  const r = (shape.r ?? 0.06) * S
  const angle = shape.angle ?? 0
  const reach = Math.hypot(w, h) / 2 + 2
  canvas.fill(
    [cx - reach, cy - reach, cx + reach, cy + reach],
    (x, y) =>
      insideRoundedRect(x, y, cx, cy, w, h, r, angle) &&
      !insideRoundedRect(x, y, cx, cy, w - width * 2, h - width * 2, Math.max(0, r - width), angle),
    color,
    alpha
  )
}

/* ------------------------------------------------------------------ */
/* 造型                                                                */
/* ------------------------------------------------------------------ */

/** 字母 M 的轮廓（归一化到 0..1 的方框里） */
const LETTER_M = [
  [0.0, 1.0],
  [0.0, 0.0],
  [0.19, 0.0],
  [0.5, 0.54],
  [0.81, 0.0],
  [1.0, 0.0],
  [1.0, 1.0],
  [0.79, 1.0],
  [0.79, 0.33],
  [0.5, 0.86],
  [0.21, 0.33],
  [0.21, 1.0]
]

/** 徽标里的箭头（↗）：一根斜杠 + 一个三角头 */
const ARROW_BAR = [
  [0.247, 0.647],
  [0.353, 0.753],
  [0.693, 0.413],
  [0.587, 0.307]
]
const ARROW_HEAD = [
  [0.44, 0.28],
  [0.72, 0.28],
  [0.72, 0.56]
]

const SHEETS = [
  { cx: 0.47, cy: 0.46, w: 0.6, h: 0.66, r: 0.055, angle: -0.21 },
  { cx: 0.5, cy: 0.49, w: 0.6, h: 0.66, r: 0.055, angle: -0.1 },
  { cx: 0.53, cy: 0.52, w: 0.6, h: 0.66, r: 0.055, angle: 0 }
]

const BADGE_SHAPE = { cx: 0.235, cy: 0.765, w: 0.3, h: 0.3, r: 0.075 }
const LETTER_BOX = { cx: 0.53, cy: 0.52, w: 0.3, h: 0.34 }

/** 画一张图标（RGBA，尺寸 size×size） */
function drawIcon(size) {
  const SS = size <= 64 ? 6 : 3 // 小尺寸多超采样，保证 16px 也清晰
  const S = size * SS
  const canvas = new Canvas(S)
  const shadowScale = 1 / SS

  // 1. 叠纸：每张先画一层柔和的投影，再画纸本身与描边
  for (const sheet of SHEETS) {
    for (let pass = 3; pass >= 1; pass -= 1) {
      paper(
        canvas,
        {
          ...sheet,
          w: sheet.w + pass * 0.03 * shadowScale * SS,
          h: sheet.h + pass * 0.03 * shadowScale * SS,
          cx: sheet.cx + pass * 0.012,
          cy: sheet.cy + pass * 0.02
        },
        SHADOW,
        0.035
      )
    }
    paper(canvas, sheet, PAPER)
    paperEdge(canvas, sheet, PAPER_EDGE, Math.max(1.2, S * 0.0035))
  }

  // 2. 正面那张纸上的字母 M
  const box = LETTER_BOX
  const bx = (box.cx - box.w / 2) * S
  const by = (box.cy - box.h / 2) * S
  const bw = box.w * S
  const bh = box.h * S
  canvas.fill(
    [bx - 2, by - 2, bx + bw + 2, by + bh + 2],
    (x, y) => pointInPolygon((x - bx) / bw, (y - by) / bh, LETTER_M),
    INK
  )

  // 3. 左下角的蓝色徽标 + 白色箭头
  paper(canvas, BADGE_SHAPE, BADGE)
  const badge = BADGE_SHAPE
  const ax = (badge.cx - badge.w / 2) * S
  const ay = (badge.cy - badge.h / 2) * S
  const aw = badge.w * S
  const ah = badge.h * S
  canvas.fill(
    [ax, ay, ax + aw, ay + ah],
    (x, y) => {
      const nx = (x - ax) / aw
      const ny = (y - ay) / ah
      return pointInPolygon(nx, ny, ARROW_BAR) || pointInPolygon(nx, ny, ARROW_HEAD)
    },
    [255, 255, 255]
  )

  return downsample(canvas, size, SS)
}

/** 盒式降采样：把超采样的画布缩回目标尺寸，同时得到抗锯齿 */
function downsample(canvas, size, SS) {
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * canvas.size + (x * SS + sx)) * 4
          const alpha = canvas.data[i + 3]
          r += canvas.data[i] * alpha
          g += canvas.data[i + 1] * alpha
          b += canvas.data[i + 2] * alpha
          a += alpha
        }
      }
      const count = SS * SS
      const outA = a / count
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round((r / a) * 255)
        out[o + 1] = Math.round((g / a) * 255)
        out[o + 2] = Math.round((b / a) * 255)
      }
      out[o + 3] = Math.round(outA * 255)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* PNG 编码                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 把 RGBA 像素编码成 PNG（真彩 + alpha，过滤器全用 0） */
function encodePng(rgba, size) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 真彩 + alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ */
/* ICO 打包                                                            */
/* ------------------------------------------------------------------ */

/** 把多张 PNG 打成 ICO（每一条都是 PNG 压缩数据，Vista 起支持） */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = 图标
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries = images.map((image) => {
    const entry = Buffer.alloc(16)
    entry[0] = image.size >= 256 ? 0 : image.size
    entry[1] = image.size >= 256 ? 0 : image.size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += image.png.length
    return entry
  })

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

mkdirSync(outDir, { recursive: true })

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const images = SIZES.map((size) => {
  const png = encodePng(drawIcon(size), size)
  console.log(`  绘制 ${String(size).padStart(3)}×${size}  ${String(png.length).padStart(6)} B`)
  return { size, png }
})

const icoPath = join(outDir, 'icon.ico')
writeFileSync(icoPath, buildIco(images))
console.log(`\n已生成 ${icoPath}（${SIZES.length} 个尺寸，${(buildIco(images).length / 1024).toFixed(1)} KB）`)

// 各尺寸再单独存一份 PNG：便于检查小尺寸是否清晰，也能直接拿去别处用
for (const image of images) {
  writeFileSync(join(outDir, `icon-${image.size}.png`), image.png)
}
writeFileSync(join(outDir, 'icon.png'), images.find((image) => image.size === 256).png)
writeFileSync(join(outDir, 'icon-512.png'), encodePng(drawIcon(512), 512))
console.log(`已生成 build/icon.png（256）与 build/icon-512.png`)
