/**
 * 生成 .xmind 样本文件，用于兼容性验证与手工测试。
 * 运行：npm run samples
 *
 * 生成的文件遵循 Xmind 2020+ 的包结构：
 *   manifest.json / metadata.json / content.json / Thumbnails/thumbnail.png
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'samples')

let counter = 0
const id = (prefix) => `${prefix}-${(counter += 1).toString(36).padStart(4, '0')}`

/** 创建主题节点 */
function topic(title, options = {}) {
  const node = { id: id('topic'), class: 'topic', title }
  if (options.structureClass) node.structureClass = options.structureClass
  if (options.labels) node.labels = options.labels
  if (options.markers) node.markers = options.markers.map((markerId) => ({ markerId }))
  if (options.notes) node.notes = { plain: { content: options.notes } }
  if (options.href) node.href = options.href
  if (options.branch === 'folded') node.branch = 'folded'
  if (options.position) node.position = options.position

  const attached = (options.children ?? []).map((child) => child.raw ?? child)
  if (attached.length > 0) {
    node.children = { attached, detached: [] }
  }
  return node
}

/** 记录节点 id，便于后续生成关系线 / 边界 / 概要 */
function track(store, key, node) {
  store[key] = node.id
  return node
}

function sheet({ title, root, relationships, boundaries, summaries, topicPositioning, theme }) {
  const data = {
    id: id('sheet'),
    class: 'sheet',
    title,
    rootTopic: root
  }
  if (theme) data.theme = theme
  if (relationships?.length) data.relationships = relationships
  if (boundaries?.length) data.boundaries = boundaries
  if (summaries?.length) data.summaries = summaries
  if (topicPositioning) data.topicPositioning = topicPositioning
  return data
}

/** 1x1 透明 PNG，占位缩略图 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

async function writeXmind(fileName, sheets, activeSheetId) {
  const zip = new JSZip()
  zip.file('content.json', JSON.stringify(sheets))
  zip.file(
    'metadata.json',
    JSON.stringify({
      creator: { name: 'MindMap Samples', version: '0.1.0' },
      activeSheetId: activeSheetId ?? sheets[0].id
    })
  )
  zip.file('Thumbnails/thumbnail.png', TINY_PNG)
  zip.file(
    'manifest.json',
    JSON.stringify({
      'file-entries': {
        'content.json': {},
        'metadata.json': {},
        'Thumbnails/thumbnail.png': {}
      }
    })
  )

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const target = join(outDir, fileName)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, buffer)
  console.log(`已生成 ${fileName}（${(buffer.length / 1024).toFixed(1)} KB）`)
}

/* ------------------------------------------------------------------ */

async function sample1() {
  const root = topic('产品路线图', {
    structureClass: 'org.xmind.ui.map.unbalanced',
    children: [
      topic('第一季度', {
        children: [
          topic('需求调研', { markers: ['task-done'] }),
          topic('竞品分析', { markers: ['task-done'] })
        ]
      }),
      topic('第二季度', {
        children: [
          topic('核心编辑能力', { markers: ['task-3quar'] }),
          topic('主题样式系统', { markers: ['task-half'] })
        ]
      }),
      topic('第三季度', {
        children: [
          topic('导入导出', { markers: ['task-start'], labels: ['重点'] }),
          topic('性能优化', { markers: ['task-start'] })
        ]
      }),
      topic('第四季度', {
        children: [topic('正式发布', { labels: ['里程碑'] })]
      })
    ]
  })
  await writeXmind('01-产品路线图.xmind', [
    sheet({ title: '路线图', root, topicPositioning: 'fixed' })
  ])
}

async function sample2() {
  const root = topic('周会纪要 2026-09-12', {
    structureClass: 'org.xmind.ui.logic.right',
    notes: '本文件用于验证逻辑图布局与备注字段。',
    children: [
      topic('本周进展', {
        children: [topic('完成画布渲染'), topic('完成撤销重做'), topic('完成 .xmind 读写')]
      }),
      topic('遇到的问题', {
        children: [
          topic('大文件渲染卡顿', { labels: ['待优化'] }),
          topic('附件体积偏大', { labels: ['待讨论'] })
        ]
      }),
      topic('下周计划', {
        children: [topic('富文本编辑'), topic('主题系统'), topic('SVG 导出')]
      }),
      topic('参考链接', {
        href: 'https://www.xmind.cn/',
        children: [topic('Xmind 官网')]
      })
    ]
  })
  await writeXmind('02-会议纪要-逻辑图.xmind', [sheet({ title: '会议纪要', root })])
}

async function sample3() {
  const store = {}
  const root = topic('学习计划', {
    structureClass: 'org.xmind.ui.map.unbalanced',
    children: [
      track(
        store,
        'frontend',
        topic('前端', {
          children: [
            track(store, 'react', topic('React', { labels: ['核心'], markers: ['priority-1'] })),
            track(store, 'typescript', topic('TypeScript', { labels: ['核心'], markers: ['priority-2'] })),
            topic('Canvas 图形学', { markers: ['priority-3'] })
          ]
        })
      ),
      track(
        store,
        'backend',
        topic('后端', {
          children: [
            topic('Node.js', { markers: ['priority-2'] }),
            topic('文件格式设计', { notes: '重点研究 ZIP + JSON 的打包方案。' })
          ]
        })
      ),
      track(
        store,
        'design',
        topic('设计', {
          branch: 'folded',
          children: [topic('配色理论'), topic('排版与字体')]
        })
      )
    ]
  })

  const data = sheet({
    title: '学习计划',
    root,
    relationships: [
      {
        id: id('rel'),
        class: 'relationship',
        end1Id: store.react,
        end2Id: store.backend,
        title: '需要配合'
      }
    ],
    // 边界：包住「后端」与「设计」这一对同级主题（含各自子树）
    boundaries: [
      {
        id: id('boundary'),
        class: 'boundary',
        range: `(${store.backend},${store.design})`,
        title: '后续推进'
      }
    ],
    // 概要：覆盖「前端」下的 React 与 TypeScript 两个同级主题
    summaries: [
      {
        id: id('summary'),
        class: 'summary',
        topicId: store.react,
        range: `(${store.react},${store.typescript})`,
        title: '优先攻克'
      }
    ]
  })

  await writeXmind('03-标签标记与关系线.xmind', [data])
}

async function sample4() {
  const first = sheet({
    title: '画布 1：需求',
    root: topic('需求梳理', {
      children: [
        topic('用户痛点', { children: [topic('布局调整麻烦'), topic('导出的图不清晰')] }),
        topic('核心价值', { children: [topic('快'), topic('好看'), topic('可迁移')] })
      ]
    })
  })

  const second = sheet({
    title: '画布 2：技术方案',
    root: topic('技术选型', {
      structureClass: 'org.xmind.ui.logic.right',
      children: [
        topic('渲染', { children: [topic('节点使用 DOM'), topic('连线使用 SVG')] }),
        topic('数据', { children: [topic('.xmind 作为原生格式'), topic('未知字段原样保留')] }),
        topic('导出', { children: [topic('SVG 矢量'), topic('PNG 栅格'), topic('PDF 文档')] })
      ]
    })
  })

  await writeXmind('04-多画布工作簿.xmind', [first, second], second.id)
}

async function sample5() {
  const root = topic('自由布局演示', {
    structureClass: 'org.xmind.ui.map.unbalanced',
    children: [
      topic('自动排布节点 A', {
        children: [topic('A-1'), topic('A-2')]
      }),
      topic('被拖走的节点 B', {
        position: { x: 120, y: -90 },
        children: [topic('B-1')]
      }),
      topic('自动排布节点 C', {
        children: [topic('C-1')]
      })
    ]
  })
  await writeXmind('05-自由定位.xmind', [
    sheet({ title: '自由定位', root, topicPositioning: 'fixed' })
  ])
}

/* ------------------------------------------------------------------ */

/** 每种结构一个样本，方便逐个目视检查布局是否合理 */
const STRUCTURE_SAMPLES = [
  ['org.xmind.ui.map.unbalanced', '思维导图-平衡'],
  ['org.xmind.ui.map.clockwise', '思维导图-顺时针'],
  ['org.xmind.ui.logic.right', '逻辑图-向右'],
  ['org.xmind.ui.logic.left', '逻辑图-向左'],
  ['org.xmind.ui.tree.right', '树形图-向右'],
  ['org.xmind.ui.tree.left', '树形图-向左'],
  ['org.xmind.ui.org-chart.down', '组织架构图-向下'],
  ['org.xmind.ui.org-chart.up', '组织架构图-向上'],
  ['org.xmind.ui.fishbone.leftHeaded', '鱼骨图'],
  ['org.xmind.ui.timeline.horizontal', '时间轴-水平'],
  ['org.xmind.ui.timeline.vertical', '时间轴-垂直'],
  ['org.xmind.ui.brace.right', '括号图'],
  ['org.xmind.ui.spreadsheet', '树状表格'],
  ['org.xmind.ui.matrix', '矩阵图']
]

function structureTree(structureClass) {
  return topic('产品规划', {
    structureClass,
    children: [
      topic('市场分析', {
        children: [
          topic('目标用户'),
          topic('竞品对比'),
          topic('规模估算', { children: [topic('TAM'), topic('SAM')] })
        ]
      }),
      topic('产品设计', {
        children: [topic('信息架构'), topic('交互原型'), topic('视觉规范')]
      }),
      topic('研发计划', {
        children: [topic('技术选型'), topic('迭代节奏'), topic('风险评估')]
      }),
      topic('上线运营', {
        children: [topic('灰度发布'), topic('数据埋点')]
      })
    ]
  })
}

async function structureSamples() {
  let index = 6
  for (const [structureClass, label] of STRUCTURE_SAMPLES) {
    const order = String(index).padStart(2, '0')
    await writeXmind(`${order}-结构-${label}.xmind`, [
      sheet({ title: label, root: structureTree(structureClass), topicPositioning: 'fixed' })
    ])
    index += 1
  }
}

async function main() {
  await mkdir(outDir, { recursive: true })
  await sample1()
  await sample2()
  await sample3()
  await sample4()
  await sample5()
  await structureSamples()
  console.log(`\n样本已写入：${outDir}`)
}

main().catch((error) => {
  console.error('生成样本失败：', error)
  process.exitCode = 1
})
