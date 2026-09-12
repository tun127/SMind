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
import { deflateSync } from 'node:zlib'
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
  if (options.image) node.image = options.image
  if (options.attachments) node.attachments = options.attachments
  // 公式是本软件自己的扩展字段（Xmind 会忽略，但不影响往返保真）
  if (options.formula) {
    node.extensions = [{ provider: 'com.mindmap.local', content: { formula: options.formula } }]
  }

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

/* ------------------------------------------------------------------ */
/* 真实 PNG 生成（不依赖任何图像库，用来给样本做一张看得见的插图）        */
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

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 生成一张带边框与斜条纹的 RGB PNG，肉眼可见，便于验证图片渲染 */
function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // 每行的过滤器类型
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const border = x < 3 || y < 3 || x >= width - 3 || y >= height - 3
      const stripe = (x + y) % 28 < 12
      const r = border ? 34 : stripe ? 96 : 214
      const g = border ? 40 : stripe ? 150 : 226
      const b = border ? 48 : stripe ? 214 : 236
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      offset += 3
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型：真彩色
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 为了让样本可复现（重复生成得到完全相同的字节），zip 条目用固定的时间戳。
 * JSZip 默认写入当前时间，而且会自动为目录建条目（目录条目同样带当前时间），
 * 所以这里同时固定 date 并关掉 createFolders。
 */
const FIXED_DATE = new Date('2026-01-01T00:00:00Z')
const FILE_OPTIONS = { date: FIXED_DATE, createFolders: false }

async function writeXmind(fileName, sheets, activeSheetId, resources = {}) {
  const zip = new JSZip()
  zip.file('content.json', JSON.stringify(sheets), FILE_OPTIONS)
  zip.file(
    'metadata.json',
    JSON.stringify({
      creator: { name: 'MindMap Samples', version: '0.1.0' },
      activeSheetId: activeSheetId ?? sheets[0].id
    }),
    FILE_OPTIONS
  )
  zip.file('Thumbnails/thumbnail.png', TINY_PNG, FILE_OPTIONS)

  const entries = {
    'content.json': {},
    'metadata.json': {},
    'Thumbnails/thumbnail.png': {}
  }
  for (const [path, bytes] of Object.entries(resources)) {
    zip.file(path, bytes, FILE_OPTIONS)
    entries[path] = {}
  }
  zip.file('manifest.json', JSON.stringify({ 'file-entries': entries }), FILE_OPTIONS)

  // 真实 Xmind 包里带目录条目，这里显式补上（同样用固定时间，保持可复现）
  const dirs = new Set()
  for (const path of Object.keys(entries)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/') + '/')
  }
  for (const dir of dirs) {
    zip.file(dir, null, { dir: true, date: FIXED_DATE })
  }

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

/** 20：图片 / 附件 / 公式（P4 收口后的新增能力，打开就能看到效果） */
async function sample20() {
  const png = makePng(240, 160)
  const csv = Buffer.from('季度,收入,同比\nQ1,120,12%\nQ2,180,25%\nQ3,210,31%\n', 'utf8')

  const root = topic('图片 / 附件 / 公式演示', {
    structureClass: 'org.xmind.ui.map.unbalanced',
    children: [
      topic('节点内图片', {
        image: { src: 'xap:resources/demo-chart.png', width: 240, height: 160 },
        notes: '这张图是脚本按 PNG 规范生成的，用来验证图片的插入、渲染与打包。'
      }),
      topic('LaTeX 公式', {
        formula: '\\sum_{i=1}^{n} \\frac{x_i^2}{\\sigma} = \\sqrt[3]{y}',
        notes: '公式渲染成节点里的一块内容，尺寸参与布局测量。'
      }),
      topic('附件', {
        attachments: [
          {
            id: 'att-demo-0001',
            path: 'xap:resources/demo-data.csv',
            name: 'demo-data.csv',
            size: csv.length,
            mime: 'text/csv'
          }
        ],
        notes: '附件随 .xmind 一起打包，可以在节点属性面板里打开或导出。'
      }),
      topic('图片 + 公式同时存在', {
        image: { src: 'xap:resources/demo-chart.png', width: 240, height: 160 },
        formula: 'E = mc^2',
        labels: ['组合']
      })
    ]
  })

  await writeXmind(
    '20-图片公式附件.xmind',
    [sheet({ title: '媒体元素', root, topicPositioning: 'fixed' })],
    undefined,
    {
      'resources/demo-chart.png': png,
      'resources/demo-data.csv': csv
    }
  )
}

/** 21：Xmind 8 旧版格式（content.xml），用来验证旧版读取与兼容提示 */
async function sample21() {
  const png = makePng(200, 120)
  const csv = Buffer.from('阶段,负责人,状态\n需求,张三,完成\n开发,李四,进行中\n', 'utf8')

  const contentXml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" modified-by="samples" timestamp="1704067200000" version="2.0">
  <sheet id="sheet-legacy-0001" theme="theme-legacy-0001" timestamp="1704067200000">
    <topic id="topic-legacy-0001" structure-class="org.xmind.ui.map.unbalanced" style-id="style-root" timestamp="1704067200000">
      <title>旧版文件 &amp; 兼容测试</title>
      <children>
        <topics type="attached">
          <topic id="topic-legacy-0002" timestamp="1704067200000">
            <title>带标记与标签</title>
            <labels>
              <label>重点</label>
              <label>旧版</label>
            </labels>
            <marker-refs>
              <marker-ref marker-id="priority-1"/>
              <marker-ref marker-id="task-half"/>
            </marker-refs>
            <notes>
              <plain>这是一条备注，来自 Xmind 8 的 plain 字段。</plain>
              <html><![CDATA[<p>这是一条备注，来自 Xmind 8 的 <b>html</b> 字段。</p>]]></html>
            </notes>
            <href>https://xmind.app/</href>
          </topic>
          <topic id="topic-legacy-0003" timestamp="1704067200000">
            <title>已折叠的分支</title>
            <branch>folded</branch>
            <children>
              <topics type="attached">
                <topic id="topic-legacy-0004" timestamp="1704067200000">
                  <title>折叠里的子主题</title>
                </topic>
              </topics>
            </children>
          </topic>
          <topic id="topic-legacy-0005" timestamp="1704067200000">
            <title>带图片与附件</title>
            <image src="xap:resources/legacy-chart.png" width="200" height="120"/>
            <attachments>
              <attachment id="att-legacy-0001" path="xap:attachments/legacy-data.csv" name="legacy-data.csv" size="${csv.length}" mime="text/csv"/>
            </attachments>
          </topic>
          <topic id="topic-legacy-0006" timestamp="1704067200000" structure-class="org.xmind.ui.logic.right">
            <title>自带结构类型的子分支</title>
            <children>
              <topics type="attached">
                <topic id="topic-legacy-0007" timestamp="1704067200000">
                  <title>三级主题</title>
                </topic>
              </topics>
            </children>
          </topic>
          <topic id="topic-legacy-0008" timestamp="1704067200000">
            <title>带未知元素的分支</title>
            <extensions>
              <extension provider="org.example.custom" content="本软件不认识这段数据，但必须原样保留"/>
            </extensions>
          </topic>
        </topics>
        <topics type="detached">
          <topic id="topic-legacy-0009" timestamp="1704067200000">
            <title>浮动主题</title>
            <position svg:x="120" svg:y="-80"/>
          </topic>
        </topics>
      </children>
    </topic>
    <relationships>
      <relationship id="rel-legacy-0001" end1="topic-legacy-0002" end2="topic-legacy-0005">
        <title>关联</title>
      </relationship>
    </relationships>
    <summaries>
      <summary id="summary-legacy-0001" topic-id="topic-legacy-0002" range="(topic-legacy-0002,topic-legacy-0003)">
        <title>阶段总结</title>
      </summary>
    </summaries>
    <boundaries>
      <boundary id="boundary-legacy-0001" range="(topic-legacy-0005,topic-legacy-0006)">
        <title>边界</title>
      </boundary>
    </boundaries>
  </sheet>
</xmap-content>
`

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-styles xmlns="urn:xmind:xmap:xmlns:style:2.0" version="2.0">
  <styles>
    <style id="style-root" type="topic">
      <topic-properties fo:font-size="24pt" fo:font-weight="bold" svg:fill="#3f51b5"/>
    </style>
  </styles>
  <themes>
    <theme id="theme-legacy-0001">
      <theme-properties>
        <default-style ref="theme-legacy-0001.default"/>
      </theme-properties>
    </theme>
  </themes>
</xmap-styles>
`

  const metaXml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<meta xmlns="urn:xmind:xmap:xmlns:meta:2.0" version="2.0">
  <Author><Name>samples</Name></Author>
  <Create><Time>2024-01-01 00:00:00</Time></Create>
</meta>
`

  const zip = new JSZip()
  zip.file('content.xml', contentXml, FILE_OPTIONS)
  zip.file('styles.xml', stylesXml, FILE_OPTIONS)
  zip.file('meta.xml', metaXml, FILE_OPTIONS)
  zip.file('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0"/>\n', FILE_OPTIONS)
  zip.file('Thumbnails/thumbnail.png', TINY_PNG, FILE_OPTIONS)
  zip.file('resources/legacy-chart.png', png, FILE_OPTIONS)
  zip.file('attachments/legacy-data.csv', csv, FILE_OPTIONS)
  for (const dir of ['Thumbnails/', 'resources/', 'attachments/', 'META-INF/']) {
    zip.file(dir, null, { dir: true, date: FIXED_DATE })
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await writeFile(join(outDir, '21-Xmind8旧版格式.xmind'), buffer)
  console.log(`已生成 21-Xmind8旧版格式.xmind（${(buffer.length / 1024).toFixed(1)} KB）`)
}

async function main() {
  await mkdir(outDir, { recursive: true })
  await sample1()
  await sample2()
  await sample3()
  await sample4()
  await sample5()
  await structureSamples()
  await sample20()
  await sample21()
  console.log(`\n样本已写入：${outDir}`)
}

main().catch((error) => {
  console.error('生成样本失败：', error)
  process.exitCode = 1
})
