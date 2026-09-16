/**
 * 临时验证脚本：对 samples/ 下的 .xmind 做「解析 -> 序列化 -> 再解析」往返一致性校验。
 * 用法：node scripts/verify-roundtrip.cjs（需先执行 npx tsc -p tsconfig.check.json）
 */
const { readFileSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const { parseXmind } = require(join(root, '.tmp-check/xmind/parse.js'))
const { serializeXmind } = require(join(root, '.tmp-check/xmind/serialize.js'))

function signature(workbook) {
  const lines = []
  const walk = (topic, depth) => {
    lines.push(
      [
        depth,
        topic.title,
        topic.structureClass ?? '',
        topic.labels.join('|'),
        topic.markers.map((m) => m.markerId).join('|'),
        topic.notes ?? '',
        topic.href ?? '',
        topic.collapsed ? 'folded' : '',
        topic.position ? 'position' : ''
      ].join('~')
    )
    topic.children.forEach((child) => walk(child, depth + 1))
  }
  for (const sheet of workbook.sheets) {
    lines.push(`SHEET:${sheet.title}:${sheet.topicPositioning ?? ''}`)
    walk(sheet.rootTopic, 0)
    lines.push(
      `EXTRA:${sheet.relationships.length}:${sheet.boundaries.length}:${sheet.summaries.length}`
    )
  }
  return lines.join('\n')
}

async function main() {
  const dir = join(root, 'samples')
  const files = readdirSync(dir).filter((f) => f.endsWith('.xmind'))
  if (files.length === 0) {
    console.log('samples/ 下没有 .xmind 文件')
    return
  }

  let failed = 0
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(join(dir, file)))
    const parsed = await parseXmind(bytes)
    const before = signature(parsed.workbook)

    const out = await serializeXmind({ workbook: parsed.workbook, resources: {} })
    const again = await parseXmind(out)
    const after = signature(again.workbook)

    const ok = before === after
    if (!ok) failed += 1

    const summary = parsed.workbook.sheets
      .map(
        (s) =>
          `${s.title}[结构=${s.rootTopic.structureClass ?? '默认'},关系=${s.relationships.length},边界=${s.boundaries.length},概要=${s.summaries.length}]`
      )
      .join(' ')

    console.log(
      `${ok ? '通过' : '失败'}  ${file}  画布数=${parsed.workbook.sheets.length}  ${summary}`
    )
    if (!ok) {
      console.log('  往返前：\n' + before)
      console.log('  往返后：\n' + after)
    }
    if (parsed.warnings.length > 0) console.log('  提示：' + parsed.warnings.join(' '))
  }

  console.log(failed === 0 ? '\n全部样本往返一致' : `\n有 ${failed} 个样本往返不一致`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
