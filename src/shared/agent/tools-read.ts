/**
 * 只读工具的 schema：模型的唯一接口，`description` 就是它的 API 文档。
 *
 * 单一职责：只声明「有哪些工具、参数长什么样」，不负责执行（见 run-read.ts）、
 * 不负责可见性（见 availability.ts）。
 */
/* ------------------------------------------------------------------ */
/* 工具定义：模型的唯一接口，description 就是它的 API 文档              */
/* ------------------------------------------------------------------ */

export interface AgentToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 拼 JSON Schema 的小工具：少一层括号，schema 一眼能读 */
export function schema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties, required }
}

/** 三期 1b 只注册**只读**工具：模型物理上做不了改画布的事 */
export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: 'listAttachments',
    description:
      '列出画布上的**元素**：关系线（含两端主题与元素 id）、边界、概要，以及可用的标记 id 清单。' +
      '要给某个分支加边界/概要、要连关系线、或要改/删已有的这些元素时，先用它拿到 id——' +
      '这些元素**没有标题可寻址**，改它们必须用返回的 id。',
    parameters: schema({
      address: { type: 'string', description: '只列与这个主题相关的元素（可省略；省略则列全部）' }
    })
  },
  {
    name: 'getSelection',
    description:
      '读取用户当前在画布上选中的主题（标题、从中心主题起的路径、子节点数、是否有备注/代码块/公式）。' +
      '用户说「这里」「这个」「选中的」时先用它确认指的是谁，不要凭猜测。',
    parameters: schema({})
  },
  {
    name: 'searchNodes',
    description:
      '在全部主题标题里按关键词搜索（不区分大小写），返回命中节点的标题、所在路径与**句柄**。' +
      '用户提到一个记不清位置的节点时用它定位；同名节点多时用返回的句柄继续寻址。',
    parameters: schema(
      {
        query: { type: 'string', description: '关键词（用较短的核心词，命中率更高）' },
        limit: { type: 'integer', description: '最多返回几条，默认 20，最多 50' }
      },
      ['query']
    )
  },
  {
    name: 'getSubtree',
    description:
      '读取某个主题下面的结构（缩进大纲，含每个节点的子节点数与**句柄**）。' +
      'address 可以是主题 id、**句柄**（`#xxxxxx`）、从中心主题起的标题路径（用 / 分隔），或唯一的标题原文。' +
      '返回的每行形如 `- [#a1b2c3] 标题（3 个子节点）`，方括号里的就是句柄：' +
      '**同名节点、超长标题、标题里带斜杠的情况一律用句柄寻址**（这些东西用标题都定位不了）。' +
      '整理 / 归类大导图时先用它一次读到位。',
    parameters: schema(
      {
        address: { type: 'string', description: '主题 id、标题路径或唯一标题' },
        depth: { type: 'integer', description: '展开到第几层，默认 2，最多 4' }
      },
      ['address']
    )
  },
  {
    name: 'getDocStats',
    description:
      '读取当前文档的规模与构成：画布数、节点总数、一级分支数、最大层级、带备注/代码块/公式的节点数。',
    parameters: schema({})
  },
  {
    name: 'updatePlan',
    description:
      '写下**执行计划**，并在每完成一步后更新进度（**不改画布**）。' +
      '动手前先调用它：steps 给 2~6 步的清单，一步一件事、每步能对应到具体操作；' +
      '之后**每完成一步再调用一次**，steps 传同一份清单、done 传已完成的数量（1、2、3…）。' +
      '用户会在聊天里看到这份清单与进度。大任务（新建整张图、批量补内容、重构结构）先写计划，' +
      '比直接开干更容易做全，也更容易被发现有遗漏。小改动（改个标题、搬一个节点）不需要计划。',
    parameters: schema(
      {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '计划步骤（2~6 条，按执行顺序）'
        },
        done: { type: 'integer', description: '已完成几步（0 = 刚开始；做到第 k 步就传 k）' }
      },
      ['steps']
    )
  },
  {
    name: 'readDocument',
    description:
      '读取**用户挂在这个会话上的文档**（聊天面板里拖进来的 / 点 📎 选的）。' +
      '用户的要求与某份文档有关、或你需要原文依据时用它，**不要凭空作答**。' +
      '用法：不填 name 时只有一份文档就直接读；填 name 选指定文档（先不填 query 调一次可看到' +
      '可用文档清单与本段范围）；填 query 就返回包含该关键词的片段（带行号，最适合问答）；' +
      '不填 query 则按 offset/limit 返回一段（默认从头 6000 字）。',
    parameters: schema(
      {
        name: { type: 'string', description: '文档名（可只写一部分），不填 = 唯一的那份' },
        query: { type: 'string', description: '要查找的关键词（推荐：比整篇读更省更快）' },
        offset: { type: 'integer', description: '从第几个字符开始（默认 0）' },
        limit: { type: 'integer', description: '最多返回多少字符（默认 6000，最多 12000）' }
      },
      []
    )
  },
  {
    name: 'exportOutline',
    description:
      '把当前画布导出成大纲文件：txt（纯文本）/ md（Markdown）/ opml（可导入其它导图软件）。' +
      '会弹出系统的「保存到…」对话框，用户自己选位置——**不要在用户没要求时主动导出**。' +
      '用户说"导出大纲 / 存成 Markdown / 给我 OPML"时用它。',
    parameters: schema(
      {
        format: { type: 'string', description: 'txt / md / opml，默认 md' }
      },
      []
    )
  },
  {
    name: 'findIncompleteNodes',
    description:
      '按「完整性」筛查节点，用来**自检有没有漏**：哪些节点缺备注（解释）、缺子节点（叶子）、缺代码块。' +
      '写完一大片内容后调用它核对覆盖度，再针对性补齐——比凭印象说"都写好了"可靠得多。' +
      'missing 选一种：notes（缺备注，默认）/ children（叶子节点）/ code（缺代码块）；' +
      'scope 可限定某一支（标题路径或句柄），不填就是整篇。返回带**句柄**，可以直接拿去继续写。',
    parameters: schema(
      {
        missing: { type: 'string', description: 'notes / children / code，默认 notes' },
        scope: { type: 'string', description: '限定在哪一支下面查，不填 = 整篇' },
        limit: { type: 'integer', description: '最多列出几个（默认 20，最多 50）' }
      },
      []
    )
  },
  {
    name: 'findDuplicates',
    description:
      '按「同名」查重：找出**规范化后标题相同**的节点（忽略空白、标点、全角半角、尾部编号与' +
      '「（补充）/ 副本」后缀），并给出每组的句柄与路径；另外列出「疑似近义」（一个标题是另一个的一部分）。' +
      'AI 分批写入后最容易留下重复，整理收尾时用它先看清楚，再决定要不要调 mergeDuplicates 合并。',
    parameters: schema(
      { scope: { type: 'string', description: '限定在哪一支下面查，不填 = 整篇' } },
      []
    )
  }
]

/** 转成请求体里的 tools 字段 */
export function toWireTools(tools: AgentToolDef[] = AGENT_TOOLS): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))
}
