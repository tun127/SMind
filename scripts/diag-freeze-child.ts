/**
 * 子进程：对指定索引的代码块跑渲染同一套流水线（highlightCode / codeBlockMetrics /
 * 标题寻址的 includes 匹配），任一步死循环就由父进程的超时捕获。
 *
 * 这是「内容二分器」的执行端：父脚本 run-diag-freeze.mjs 逐块起进程，
 * 哪个块不返回，哪个块就是毒块。
 */
import { readFileSync } from 'node:fs'
import * as JSZip from 'jszip'
import { highlightCode } from '../src/shared/code/highlight'
import { codeBlockMetrics, codeMinNodeSize } from '../src/shared/layout/accessory'

const xmindPath = process.env.DIAG_XMIND ?? ''
const index = Number(process.env.DIAG_INDEX ?? '0')

async function main(): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(xmindPath))
  const content = JSON.parse(await zip.file('content.json')!.async('string'))
  const blocks: Array<{ title: string; language: string; text: string }> = []
  interface TopicLike {
    code?: { text?: string; language?: string }
    title?: string
    children?: { attached?: TopicLike[] }
  }
  const visit = (topic: TopicLike): void => {
    if (topic.code && typeof topic.code.text === 'string' && topic.code.text.length > 0) {
      blocks.push({
        title: String(topic.title ?? '?'),
        language: String(topic.code.language ?? ''),
        text: topic.code.text
      })
    }
    for (const child of topic.children?.attached ?? []) visit(child)
  }
  // content.json 是「画布数组」：元素直接带 rootTopic（兼容多包一层 .sheet 的写法）
  const sheets = (Array.isArray(content) ? content : [content]) as Array<{
    sheet?: { rootTopic: TopicLike }
    rootTopic?: TopicLike
  }>
  for (const sheet of sheets) {
    const root = sheet.sheet?.rootTopic ?? sheet.rootTopic
    if (root) visit(root)
  }

  const block = blocks[index]
  if (!block) {
    console.log(`索引 ${index} 不存在（共 ${blocks.length} 块）`)
    process.exit(0)
  }

  // 1) 分词（渲染时现场调用的那个）
  const lines = highlightCode(block.text, block.language)
  console.log(`分词 OK：${lines.length} 行`)

  // 2) 代码块指标（自然尺寸 / 1×1 逼下限 / 各种拉伸）
  const code = { language: block.language, text: block.text }
  codeBlockMetrics(code)
  console.log('自然指标 OK')
  codeBlockMetrics(code, { width: 1, height: 1 })
  codeMinNodeSize(code, { x: 8, y: 6 })
  console.log('缩放下限 OK')

  // 3) 标题寻址的 includes 匹配（全部两两组合）
  const titles = blocks.map((b) => b.title)
  for (const needle of titles) {
    for (const title of titles) title.toLowerCase().includes(needle.toLowerCase())
  }
  console.log('寻址匹配 OK')

  process.exit(0)
}

void main()
