/**
 * PNG 编码原语（脚本之间共用）。
 *
 * 收敛依据：`docs/refactor-audit.md` §2.4 —— `make-icon.mjs` 与 `make-samples.mjs`
 * 各自抄了一份 CRC32 表 / `crc32` / `pngChunk` / 「signature + IHDR + IDAT + IEND」装订。
 *
 * 这里**只放纯原语**：CRC32（PNG chunk 用的那个多项式）、chunk 拼装、以及把
 * 「已经带好行过滤器前缀的原始像素数据」装订成 PNG。各脚本自己的策略留在调用点：
 * 产物文件名、画布尺寸、调色板、颜色类型（RGBA 还是 RGB）、每行过滤器字节怎么填、
 * 拉链压缩等级之外的东西——都不进来。
 *
 * 为什么自己拼而不是引图像库：这些脚本要在只有 Node 内置模块的环境里跑
 * （`npm run icon` / `npm run samples` 都是零图形依赖）。
 *
 * 字节等价有硬证据：抽出前后各跑一次 `npm run icon` 与 `npm run samples`，
 * 产物逐文件 sha256 一致（见该次提交信息里的比对表）。
 */
import { deflateSync } from 'node:zlib'

/** PNG 文件头：8 字节魔数 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32 查表（反射多项式 0xedb88320，PNG / zlib 用的就是这一个） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** PNG chunk 的 CRC32：算在「chunk 类型 + 数据」上 */
export function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 拼一个 chunk：长度 + 类型 + 数据 + CRC */
export function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * 把原始扫描行装订成 PNG（signature + IHDR + IDAT + IEND，非隔行）。
 *
 * `raw` 必须是**已经按 PNG 要求每行首字节写过滤器的**字节流——怎么画、过滤器填几
 * 是调用点的策略；这里只按 `width` / `height` / `colorType` 写 IHDR，并用 zlib
 * deflate（等级 9，与抽出前的两份实现一致）压成 IDAT。
 */
export function pngFromRaw({ width, height, colorType, raw, bitDepth = 8 }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0 // 压缩方法：deflate
  ihdr[11] = 0 // 过滤器方法：0（本项目两份调用点都只用过滤器 0）
  ihdr[12] = 0 // 非隔行

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
