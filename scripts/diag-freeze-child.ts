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

  /**
   * 自测钩子：故意让指定索引**永不返回**，用来把父进程的「超时判毒块」分支真的跑一遍。
   *
   * 为什么需要它：这条分支是整个工具的**判决路径**（"哪个块是毒块"），
   * 但正常文档里已经很难再触发它了——真触发过它的自旋 bug（`@` / `\`）已经修掉，
   * 于是这条路径长期处于「逻辑上应该对、从没被真正执行过」的状态。
   * 用法：`$env:DIAG_FAKE_SPIN='1'; node scripts/run-diag-freeze.mjs <xmind>`
   * 预期：#1 通过、#2 判为毒块并把内容写进 .tmp-check/poison-2.txt。
   */
  if ((process.env.DIAG_FAKE_SPIN ?? '') === String(index)) {
    console.log(`自测：索引 ${index} 故意制造死循环，父进程应当判它为毒块`)
    let spin = 0
    for (;;) {
      spin = (spin + 1) % 1_000_000
      if (spin < 0) break
    }
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
