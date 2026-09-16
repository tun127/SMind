/**
 * 冻结内容二分器：对自动存档文档里的**每个代码块**跑与渲染同一套流水线，
 * 每块一个独立进程 + 4 秒超时——哪个块不回来，哪个块就是毒块。
 *
 * 用法：node scripts/run-diag-freeze.mjs [xmind 路径]
 * 不传路径时取应用自动存档（%APPDATA%/smind/autosave/slot-1.xmind）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, '.tmp-check')
mkdirSync(outDir, { recursive: true })
const outFile = resolve(outDir, 'diag-freeze-child.cjs')

await esbuild.build({
  entryPoints: [resolve(here, 'diag-freeze-child.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  tsconfig: resolve(root, 'tsconfig.json'),
  alias: { '@shared': resolve(root, 'src/shared') }
})

const defaultXmind = process.env.APPDATA
  ? join(process.env.APPDATA, 'smind', 'autosave', 'slot-1.xmind')
  : ''
const xmindPath = process.argv[2] ?? defaultXmind

const { default: JSZip } = await import('jszip')
const zip = await JSZip.loadAsync(readFileSync(xmindPath))
const contentFile = zip.file('content.json')
if (!contentFile) {
  console.log('content.json 不存在，文件列表：', Object.keys(zip.files).join(', '))
  process.exit(1)
}
const content = JSON.parse(await contentFile.async('string'))
const blocks = []
const visit = (topic) => {
  if (topic.code && typeof topic.code.text === 'string' && topic.code.text.length > 0) {
    blocks.push({
      title: String(topic.title ?? '?'),
      language: String(topic.code.language ?? ''),
      text: topic.code.text
    })
  }
  for (const child of topic.children?.attached ?? []) visit(child)
}
// content.json 是「画布数组」：元素直接带 rootTopic（旧实现多包了一层 .sheet，踩过）
const sheets = Array.isArray(content) ? content : [content]
for (const sheet of sheets) {
  const root = sheet?.sheet?.rootTopic ?? sheet?.rootTopic
  if (root) visit(root)
}

console.log(`文档里共 ${blocks.length} 个非空代码块，逐块测试（每个 4 秒超时）…`)

let poison = 0
for (const [index, block] of blocks.entries()) {
  const child = spawnSync(process.execPath, [outFile, String(index)], {
    timeout: 4000,
    env: { ...process.env, DIAG_XMIND: xmindPath, DIAG_INDEX: String(index) },
    encoding: 'utf8'
  })
  if (child.status === 0) {
    console.log(`  #${index + 1} 「${block.title}」（${block.text.length} 字符）OK`)
  } else {
    poison += 1
    console.log(
      `  #${index + 1} 「${block.title}」（${block.text.length} 字符）★★★ 毒块：超时/崩溃`
    )
    writeFileSync(resolve(outDir, `poison-${index + 1}.txt`), block.text, 'utf8')
    console.log(`      内容已存到 .tmp-check/poison-${index + 1}.txt（前 200 字符）：`)
    console.log('      ' + block.text.slice(0, 200).replace(/\n/g, '\\n'))
  }
}
console.log(poison === 0 ? '全部通过：冻结不在代码块内容这条线上。' : `发现 ${poison} 个毒块。`)
