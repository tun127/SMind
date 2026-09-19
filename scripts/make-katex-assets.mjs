/**
 * 生成「导出公式」要用的 KaTeX 资源模块（CSS + 内联成 base64 的字体）。
 *
 * 为什么需要它：导出的 SVG/位图是**独立文档**，KaTeX 的 CSS 与字体不会跟着过去，
 * 公式就会退化成难看的默认字体。所以把 CSS 和 woff2 字体在构建期打包成字符串，
 * 导出时按需（动态 import）加载。这样开发环境与打包后行为一致，也不受 file:// 取不到字体文件的影响。
 *
 * 运行：npm run fonts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import prettier from 'prettier'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const katexDir = join(root, 'node_modules', 'katex', 'dist')
const outFile = join(root, 'src', 'renderer', 'src', 'export', 'katex-assets.ts')

const MIME = {
  woff2: 'font/woff2'
}

function readFonts() {
  const dir = join(katexDir, 'fonts')
  const fonts = {}
  for (const name of readdirSync(dir)) {
    const ext = name.split('.').pop()
    if (!MIME[ext]) continue
    fonts[name] = readFileSync(join(dir, name)).toString('base64')
  }
  return fonts
}

const fonts = readFonts()
const fontNames = Object.keys(fonts).sort()
if (fontNames.length === 0) {
  console.error('没有找到 KaTeX 的 woff2 字体，请确认依赖已安装')
  process.exit(1)
}

let css = readFileSync(join(katexDir, 'katex.min.css'), 'utf8')

// 1. 把 woff2 换成内联 data URL
let inlined = 0
css = css.replace(/url\(fonts\/([^)]+?)\)/g, (whole, file) => {
  const base64 = fonts[file]
  if (!base64) return whole
  inlined += 1
  return `url(data:${MIME.woff2};base64,${base64})`
})

// 2. 去掉 woff / ttf 的备用来源：它们的 data URL 只会让体积翻倍，Chromium 用 woff2 就够了
css = css.replace(/,\s*url\(fonts\/[^)]+?\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '')

const banner = `/**
 * 由 scripts/make-katex-assets.mjs 自动生成，请勿手工修改。
 * 重新生成：npm run fonts
 *
 * 内容：KaTeX 的样式表（字体已内联为 base64 的 woff2）。
 * 导出含公式的图片时按需动态 import 这个模块。
 */

/** 已内联字体的 KaTeX 样式表 */
export const KATEX_INLINE_CSS = ${JSON.stringify(css)}

/** 内联了哪些字体（自检用） */
export const KATEX_INLINED_FONTS: string[] = ${JSON.stringify(fontNames, null, 2)}
`

// 直接按项目的 Prettier 规则出格式：生成物不必再被 `format:check` 追着改一遍。
// ⚠️ Prettier 3 的程序化调用**不会自己读配置文件**（要用 resolveConfig 显式取一次），
// 只传 filepath 会落回默认值 `semi: true / singleQuote: false`——与仓库的 .prettierrc 相反。
// 少了这一步的后果（2026-09-19 实测）：本脚本写出的 katex-assets.ts 是"未格式化版"，
// 别人一跑 `npm run fonts` 就会把 src 下的产物弄脏、并且踩红 `format:check`
// （该文件在 `prettier --check "src/**/*.{ts,tsx,css}"` 覆盖范围内，仓库没有 .prettierignore）。
const prettierOptions = await prettier.resolveConfig(outFile)
writeFileSync(
  outFile,
  await prettier.format(banner, { ...prettierOptions, filepath: outFile }),
  'utf8'
)
console.log(`已生成 ${outFile}`)
console.log(
  `内联字体 ${fontNames.length} 个、替换 url() ${inlined} 处，CSS 体积 ${Math.round(css.length / 1024)} KB`
)
