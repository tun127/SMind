/**
 * 写工具的 schema：能真正改画布的那一批。`description` 就是模型的 API 文档。
 *
 * 单一职责：只声明参数与约束；把参数解析成 WriteIntent 见 plan-write.ts。
 */
import { CODE_LANGUAGES } from '../code-language'
import { DEFAULT_STRUCTURE, STRUCTURES } from '../xmind/constants'
import { schema, type AgentToolDef } from './tools-read'

export const AGENT_WRITE_TOOLS: AgentToolDef[] = [
  {
    name: 'renameTopic',
    description:
      '修改一个主题的标题。address 可以是主题 id、标题路径（如 中心主题/成本/人力），或唯一的标题原文。' +
      '改名前先确认目标是谁（用 getSelection 或 searchNodes 看过的 id），不要用近似标题硬猜。' +
      '注意：改名会清掉该标题上的局部格式（加粗/颜色），与手工改名行为一致。',
    parameters: schema(
      {
        address: { type: 'string', description: '主题 id、标题路径或唯一标题' },
        title: { type: 'string', description: '新的标题文字（不要带引号）' }
      },
      ['address', 'title']
    )
  },
  {
    name: 'insertSubtree',
    description:
      '在指定主题下面**新增**内容。outline 用缩进大纲写、每行以「- 」开头：' +
      '并列的多行会成为多个**同级**新主题，缩进两格表示更深一级。' +
      'outline 里只放要新增的主题文字，不要把解释说明或开场白写进去。' +
      '每个节点的文字要**自带信息量**（具体事实、数字、条件、例子），不要写「XX 的概述」这类空标题；' +
      '解释与细节**直接写成子节点**（「要点：…」「例：…」），不要用 `> ` 备注行——备注在画布上不显眼。' +
      '**它只用于真正的新内容**：把画布上已有的节点「重写一遍」等于复制一份（整理 / 归类已有内容请用 moveTopics 移动）。',
    parameters: schema(
      {
        address: { type: 'string', description: '挂在哪个主题下面' },
        outline: { type: 'string', description: '缩进大纲文本' },
        allowDuplicate: {
          type: 'boolean',
          description: 'outline 的标题在文档里大多已存在时会被拦下；确实要新增同名内容才传 true'
        }
      },
      ['address', 'outline']
    )
  },
  {
    name: 'deleteTopic',
    description:
      '删除一个主题**连同它的整棵子树**。这是破坏性操作，界面上会先请你（用户）确认。' +
      '删除前务必确认目标正确——宁可先用 searchNodes 查清楚。',
    parameters: schema({ address: { type: 'string', description: '要删除的主题' } }, ['address'])
  },
  {
    name: 'moveTopic',
    description:
      '把**一个**主题（连同子树）移动到另一个主题下面。index 是插到第几个子节点（从 0 开始；省略表示放到最后）。' +
      '不能移动到自己的子孙下面。' +
      '要移动**很多**主题时（整理、归类）请改用 moveTopics——一次调用批量移动，别一个个搬。' +
      '注意：用户**手动摆过位置**的主题默认不能移动——那会打乱他自己排好的版面；' +
      '确实必要（例如用户明确要求重新排列）时，再带上 allowMoved: true 重新调用。',
    parameters: schema(
      {
        address: { type: 'string', description: '要移动的主题' },
        toAddress: { type: 'string', description: '新的父主题' },
        index: { type: 'integer', description: '插到第几个位置（可省略）' },
        allowMoved: {
          type: 'boolean',
          description: '目标主题是用户手动摆过位置时，必须显式传 true 才允许移动'
        }
      },
      ['address', 'toAddress']
    )
  },
  {
    name: 'moveTopics',
    description:
      '**批量**移动多个主题——整理 / 归类大导图时务必用它：一次调用可以移动很多节点，' +
      '比逐个 moveTopic 省得多（调用次数上限按「调用」算，不按节点算）。' +
      'moves 里每一项的语义与 moveTopic 完全相同（address / toAddress / index?）；' +
      '**address 优先填句柄**（读工具给的 `#xxxxxx`）——同名节点、超长标题、带斜杠标题都靠它。' +
      '个别条目解析失败会被**跳过**（摘要里说明是哪几条），其余照常执行；全都不行才整体报错。' +
      '列表里有用户手动摆过位置的主题时，同样需要 allowMoved: true。',
    parameters: schema(
      {
        moves: {
          type: 'array',
          description: '要执行的移动列表（一次最多 200 项；更多请分批）',
          items: {
            type: 'object',
            properties: {
              address: { type: 'string', description: '要移动的主题' },
              toAddress: { type: 'string', description: '新的父主题' },
              index: { type: 'integer', description: '插到第几个位置（可省略，省略放到最后）' }
            },
            required: ['address', 'toAddress']
          }
        },
        allowMoved: {
          type: 'boolean',
          description: '列表里有用户手动摆过位置的主题时，必须显式传 true 才允许整批移动'
        }
      },
      ['moves']
    )
  },
  {
    name: 'setCollapsed',
    description:
      '折叠或展开一个主题（**只影响显示，不改任何内容**）。' +
      '**思维导图（平衡 / 顺时针）的中心主题**还支持**按侧收起**：' +
      '带上 side 只收起或展开那一侧，左右互不影响' +
      '（用户说「先把左边收起来」「左右分别收起」就是它）；不传 side 就是整体折叠 / 展开。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        collapsed: { type: 'boolean', description: 'true = 折叠 / 收起，false = 展开' },
        side: {
          type: 'string',
          enum: ['left', 'right'],
          description:
            '只对「思维导图（平衡 / 顺时针）的中心主题」有效：只收起 / 展开这一侧。' +
            '其余结构（逻辑图 / 时间轴 / 鱼骨图 / 矩阵图…）不要传（传了会被拒绝）。'
        }
      },
      ['address', 'collapsed']
    )
  },
  {
    name: 'setNotes',
    description: '写主题的备注（多行纯文本）。传空字符串即清空备注。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        text: { type: 'string', description: '备注正文' }
      },
      ['address', 'text']
    )
  },
  {
    name: 'setCode',
    description:
      '写主题的代码块（会按语言语法高亮）。text 传空字符串即移除代码块。' +
      // 语言清单**从唯一来源取**：以前这里手写一遍散文清单，与 UI 的下拉选项
      // （`CODE_LANGUAGES`）和 `lang-defs` 的定义表三处并存，加一种语言就得改三处、
      // 漏一处就出现"下拉里有、模型却被告知不支持"这类不一致
      `language 用常见名：${CODE_LANGUAGES.join(' / ')}（js / ts / py 等简写也认）。`,
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        language: { type: 'string', description: '语言（可省略，默认 text）' },
        text: { type: 'string', description: '代码正文' }
      },
      ['address', 'text']
    )
  },
  {
    name: 'setFormula',
    description:
      '写主题的 LaTeX 公式。formula 只填正文（如 \\frac{a}{b}），**不要**带 $ 或 $$ 包裹。传空字符串即移除公式。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        formula: { type: 'string', description: 'LaTeX 正文' }
      },
      ['address', 'formula']
    )
  },
  {
    name: 'askUser',
    description:
      '当指令指向不明、有多个候选、或你不确定用户想改哪一支（哪张分支）时，用这个工具提问，' +
      '**不要猜着改**。一次只问一个问题，问题要短；能给出候选就放到 options 里。',
    parameters: schema(
      {
        question: { type: 'string', description: '要问用户的问题' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的候选答案（最多 5 个）'
        }
      },
      ['question']
    )
  },
  {
    name: 'addRelationship',
    description:
      '在两个主题之间连一条关系线（可选标注文字）。两端用 address 指定（id / 句柄 / 标题路径 / 唯一标题）。' +
      '已经连过就复用原来那条，不会重复连。',
    parameters: schema(
      {
        from: { type: 'string', description: '起点主题' },
        to: { type: 'string', description: '终点主题' },
        label: { type: 'string', description: '线上的标注文字（可省略）' }
      },
      ['from', 'to']
    )
  },
  {
    name: 'addBoundary',
    description:
      '给一组**同级**主题加边界（圈出一个范围），可带标题。addresses 传多个时表示「第一个到最后一个」的连续区间，' +
      '所以这些主题必须是同一级且相邻。范围已经存在就复用。',
    parameters: schema(
      {
        addresses: {
          type: 'array',
          items: { type: 'string' },
          description: '要圈进去的主题（1 个或连续几个）'
        },
        title: { type: 'string', description: '边界的标题（可省略）' }
      },
      ['addresses']
    )
  },
  {
    name: 'addSummary',
    description:
      '给一组**同级**主题加概要（标在右侧的概括框），可带标题。要求与 addBoundary 相同。',
    parameters: schema(
      {
        addresses: {
          type: 'array',
          items: { type: 'string' },
          description: '要概括的主题（1 个或连续几个）'
        },
        title: { type: 'string', description: '概要文字（可省略，默认「概要」）' }
      },
      ['addresses']
    )
  },
  {
    name: 'setAttachmentTitle',
    description:
      '改画布元素上的文字：关系线的标注 / 边界的标题 / 概要的文字。' +
      'id 必须先用 listAttachments 拿到（这些元素没有标题可寻址）。',
    parameters: schema(
      {
        target: {
          type: 'string',
          enum: ['relationship', 'boundary', 'summary'],
          description: '元素种类'
        },
        id: { type: 'string', description: '元素 id（来自 listAttachments）' },
        title: { type: 'string', description: '新的文字（空串表示清空）' }
      },
      ['target', 'id', 'title']
    )
  },
  {
    name: 'removeAttachment',
    description:
      '删除一个画布元素（关系线 / 边界 / 概要）。id 来自 listAttachments。' +
      '这是破坏性操作，用户会被问一次——只有用户确实要删时才用它。',
    parameters: schema(
      {
        target: {
          type: 'string',
          enum: ['relationship', 'boundary', 'summary'],
          description: '元素种类'
        },
        id: { type: 'string', description: '元素 id（来自 listAttachments）' }
      },
      ['target', 'id']
    )
  },
  {
    name: 'setMarkers',
    description:
      '设置主题的标记图标（**整体替换**，不是追加；传空数组就是清空）。' +
      '**同一类别只能有一个**（优先级 / 进度 / 星标 / 旗帜 / 表情 / 符号 / 趋势 / 其他），' +
      '同一类别里给多个会被拒绝。' +
      'markerId 必须来自 listAttachments 返回的清单，**不要自己编**（编出来的 id 会被拒绝）。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        markers: {
          type: 'array',
          items: { type: 'string' },
          description: '标记 id 列表（整体替换）'
        }
      },
      ['address', 'markers']
    )
  },
  {
    name: 'addLabel',
    description: '给主题加一个标签（短词，例如「重点」「待办」「疑问」）。已经有的标签不会重复加。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        label: { type: 'string', description: '标签文字（短）' }
      },
      ['address', 'label']
    )
  },
  {
    name: 'removeLabel',
    description: '去掉主题上的一个标签。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        label: { type: 'string', description: '要移除的标签文字' }
      },
      ['address', 'label']
    )
  },
  {
    name: 'setStructure',
    description:
      '切换**整张画布**的结构类型：从逻辑图改成思维导图 / 鱼骨图 / 时间轴 / 括号图 / 矩阵图等。' +
      `可选结构：${STRUCTURES.filter((s) => s.supported)
        .map((s) => (s.class === DEFAULT_STRUCTURE ? `${s.class}（默认）` : s.class))
        .join('、')}。` +
      '结构是整张画布的属性（住在中心主题上），**不要传 address**——' +
      '只改某一支会被拒绝（那会让一棵树混着几套结构、画面乱）。' +
      '用户说"换成鱼骨图 / 改成时间轴 / 排成矩阵"时就调它——**不要**手动搬节点去模拟结构。',
    parameters: schema(
      {
        address: { type: 'string', description: '要改哪个主题，不填 = 中心主题（整张图）' },
        structure: {
          type: 'string',
          description:
            '结构 id（如 org.xmind.ui.fishbone.leftHeaded），也可以直接用中文名（如 鱼骨图）'
        }
      },
      ['structure']
    )
  },
  {
    name: 'sortSiblings',
    description:
      '给某个主题的**同级子主题排序**（默认按标题），可选**自动编号**（1. 2. 3. …，会先去掉旧编号）。' +
      '整理类任务的收尾常用：把并列的分支按顺序排好、或给步骤类内容编号。' +
      'by 可选 title（默认，按标题）/ length（按标题长度）；order 可选 asc（默认）/ desc。' +
      '注意：编号会重写子主题标题，**该标题上的局部格式（加粗/颜色）会跟着被清掉**（与手工改名一致）。',
    parameters: schema(
      {
        address: { type: 'string', description: '排谁的子主题，不填 = 中心主题' },
        by: { type: 'string', description: 'title（默认）/ length' },
        order: { type: 'string', description: 'asc（默认）/ desc' },
        renumber: { type: 'boolean', description: 'true = 顺带加「1. 2. 」编号' }
      },
      []
    )
  },
  {
    name: 'mergeDuplicates',
    description:
      '合并**同名重复**的主题（同名判定同 findDuplicates：忽略空白/标点/全角半角/尾部编号与"（补充）"后缀）。' +
      '保留内容最完整的那个，把其余的**子主题搬过来、缺的备注/代码/公式/标签补上**，再删掉多余节点。' +
      '**这是删节点的操作**，界面上会先请用户确认。要精确控制就先 findDuplicates 看清有哪些组，' +
      '用 titles 只合并指定的那几组，否则合并范围内全部同名组。',
    parameters: schema(
      {
        scope: { type: 'string', description: '限定在哪一支里合并，不填 = 整篇' },
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: '只合并这些标题（原文照抄），不填则合并全部同名组'
        }
      },
      []
    )
  }
]
