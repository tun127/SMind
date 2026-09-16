/**
 * 轻量语法高亮：**无依赖、无 DOM**的逐行分词器。
 *
 * 为什么自己写而不是引第三方：
 * - 画布（DOM）、导出（SVG / Canvas 绘制指令）、自检（Node）三处都要用同一份结果，
 *   带 DOM 依赖的库在这三处里至少有一个用不了；
 * - 代码块是**等宽排版**，颜色只影响观感、不影响几何，所以"够用的规则 + 稳定的分词"
 *   就足以满足需求，不必引入完整的语言解析器与大体积语言包。
 *
 * 铁律：把每行的 tokens 首尾拼起来必须**逐字节等于原行**——
 * 渲染与测量都按最终文本画，一旦分词改了空白或丢字，代码块就会和源码不一致。
 * （自检里有这条断言。）
 */

export type CodeTokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'function'
  | 'type'
  | 'builtin'
  | 'operator'
  | 'property'
  | 'tag'
  | 'attr'

export interface CodeToken {
  text: string
  kind: CodeTokenKind
}

export interface CodeLine {
  tokens: CodeToken[]
}

/** 配色（浅色卡片上的 GitHub 风），画布与导出共用 */
export const CODE_TOKEN_COLORS: Record<CodeTokenKind, string> = {
  plain: '#24292f',
  comment: '#6a737d',
  string: '#032f62',
  number: '#005cc5',
  keyword: '#d73a49',
  literal: '#005cc5',
  function: '#6f42c1',
  type: '#6f42c1',
  builtin: '#005cc5',
  operator: '#57606a',
  property: '#005cc5',
  tag: '#22863a',
  attr: '#6f42c1'
}

type Mode = 'code' | 'markup' | 'css' | 'data'

interface LanguageDef {
  mode: Mode
  /** 行注释起始串 */
  lineComment?: string[]
  /** 块注释：[开始, 结束] */
  blockComment?: Array<[string, string]>
  /** 可跨行的字符串（Python 三引号） */
  multilineString?: string[]
  /** 单行字符串引号 */
  strings?: string[]
  keywords?: string[]
  literals?: string[]
  builtins?: string[]
  /** 以大写字母开头的标识符当作类型（类名/结构体名） */
  upperAsType?: boolean
  /** 关键字不区分大小写（SQL） */
  ignoreCase?: boolean
  /** `$var`、`${...}`、`@decorator` 之类的记号 */
  sigils?: string[]
  /** data 模式：`key:` 形式的键（YAML）；JSON 由 `"key":` 规则识别 */
  yamlKeys?: boolean
}

const C_KEYWORDS = [
  'auto',
  'break',
  'case',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'else',
  'enum',
  'explicit',
  'export',
  'friend',
  'goto',
  'if',
  'import',
  'inline',
  'namespace',
  'new',
  'operator',
  'private',
  'protected',
  'public',
  'register',
  'return',
  'sizeof',
  'static',
  'struct',
  'switch',
  'template',
  'this',
  'throw',
  'try',
  'catch',
  'typedef',
  'typename',
  'union',
  'using',
  'virtual',
  'volatile',
  'while',
  'override',
  'final'
]

const DEFS: Record<string, LanguageDef> = {
  javascript: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'", '`'],
    keywords: [
      'async',
      'await',
      'break',
      'case',
      'catch',
      'class',
      'const',
      'continue',
      'debugger',
      'default',
      'delete',
      'do',
      'else',
      'export',
      'extends',
      'finally',
      'for',
      'from',
      'function',
      'get',
      'if',
      'import',
      'in',
      'instanceof',
      'let',
      'new',
      'of',
      'return',
      'set',
      'static',
      'super',
      'switch',
      'this',
      'throw',
      'try',
      'typeof',
      'var',
      'void',
      'while',
      'with',
      'yield',
      'as',
      'await'
    ],
    literals: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'],
    builtins: [
      'Array',
      'Boolean',
      'Date',
      'Error',
      'JSON',
      'Map',
      'Math',
      'Number',
      'Object',
      'Promise',
      'RegExp',
      'Set',
      'String',
      'Symbol',
      'console',
      'document',
      'window',
      'module',
      'require',
      'process',
      'exports'
    ]
  },
  typescript: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'", '`'],
    keywords: [
      'abstract',
      'any',
      'as',
      'asserts',
      'async',
      'await',
      'boolean',
      'break',
      'case',
      'catch',
      'class',
      'const',
      'constructor',
      'continue',
      'declare',
      'default',
      'delete',
      'do',
      'else',
      'enum',
      'export',
      'extends',
      'finally',
      'for',
      'from',
      'function',
      'get',
      'if',
      'implements',
      'import',
      'in',
      'infer',
      'instanceof',
      'interface',
      'is',
      'keyof',
      'let',
      'namespace',
      'never',
      'new',
      'number',
      'object',
      'of',
      'override',
      'private',
      'protected',
      'public',
      'readonly',
      'return',
      'satisfies',
      'set',
      'static',
      'string',
      'super',
      'switch',
      'symbol',
      'this',
      'throw',
      'try',
      'type',
      'typeof',
      'undefined',
      'unique',
      'unknown',
      'var',
      'void',
      'while',
      'yield'
    ],
    literals: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'],
    builtins: [
      'Array',
      'Boolean',
      'Date',
      'Error',
      'JSON',
      'Map',
      'Math',
      'Number',
      'Object',
      'Promise',
      'RegExp',
      'Set',
      'String',
      'Symbol',
      'WeakMap',
      'console',
      'document',
      'window',
      'process',
      'Record',
      'Partial',
      'Readonly'
    ],
    upperAsType: true
  },
  python: {
    mode: 'code',
    lineComment: ['#'],
    multilineString: ['"""', "'''"],
    strings: ['"', "'"],
    keywords: [
      'and',
      'as',
      'assert',
      'async',
      'await',
      'break',
      'case',
      'class',
      'continue',
      'def',
      'del',
      'elif',
      'else',
      'except',
      'finally',
      'for',
      'from',
      'global',
      'if',
      'import',
      'in',
      'is',
      'lambda',
      'match',
      'nonlocal',
      'not',
      'or',
      'pass',
      'raise',
      'return',
      'try',
      'while',
      'with',
      'yield'
    ],
    literals: ['True', 'False', 'None'],
    builtins: [
      'abs',
      'all',
      'any',
      'bool',
      'bytes',
      'dict',
      'dir',
      'enumerate',
      'filter',
      'float',
      'format',
      'frozenset',
      'getattr',
      'hasattr',
      'int',
      'isinstance',
      'issubclass',
      'iter',
      'len',
      'list',
      'map',
      'max',
      'min',
      'next',
      'object',
      'open',
      'print',
      'range',
      'repr',
      'reversed',
      'round',
      'self',
      'set',
      'setattr',
      'sorted',
      'str',
      'sum',
      'super',
      'tuple',
      'type',
      'zip'
    ],
    upperAsType: true
  },
  java: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'"],
    keywords: [
      'abstract',
      'assert',
      'boolean',
      'break',
      'byte',
      'case',
      'catch',
      'char',
      'class',
      'const',
      'continue',
      'default',
      'do',
      'double',
      'else',
      'enum',
      'extends',
      'final',
      'finally',
      'float',
      'for',
      'if',
      'implements',
      'import',
      'instanceof',
      'int',
      'interface',
      'long',
      'native',
      'new',
      'package',
      'private',
      'protected',
      'public',
      'record',
      'return',
      'sealed',
      'short',
      'static',
      'strictfp',
      'super',
      'switch',
      'synchronized',
      'this',
      'throw',
      'throws',
      'transient',
      'try',
      'var',
      'void',
      'volatile',
      'while',
      'yield'
    ],
    literals: ['true', 'false', 'null'],
    builtins: [
      'String',
      'System',
      'Integer',
      'Long',
      'Double',
      'Boolean',
      'Object',
      'List',
      'Map',
      'Set',
      'Math',
      'Override'
    ],
    upperAsType: true
  },
  csharp: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'"],
    keywords: [
      'abstract',
      'as',
      'async',
      'await',
      'base',
      'bool',
      'break',
      'byte',
      'case',
      'catch',
      'char',
      'checked',
      'class',
      'const',
      'continue',
      'decimal',
      'default',
      'delegate',
      'do',
      'double',
      'else',
      'enum',
      'event',
      'explicit',
      'extern',
      'finally',
      'fixed',
      'float',
      'for',
      'foreach',
      'get',
      'goto',
      'if',
      'implicit',
      'in',
      'int',
      'interface',
      'internal',
      'is',
      'lock',
      'long',
      'namespace',
      'new',
      'object',
      'operator',
      'out',
      'override',
      'params',
      'private',
      'protected',
      'public',
      'readonly',
      'record',
      'ref',
      'return',
      'sealed',
      'set',
      'short',
      'sizeof',
      'stackalloc',
      'static',
      'string',
      'struct',
      'switch',
      'this',
      'throw',
      'try',
      'typeof',
      'uint',
      'ulong',
      'unchecked',
      'unsafe',
      'ushort',
      'using',
      'var',
      'virtual',
      'void',
      'volatile',
      'while',
      'yield',
      'nameof',
      'when'
    ],
    literals: ['true', 'false', 'null'],
    builtins: [
      'Console',
      'String',
      'Int32',
      'Double',
      'Boolean',
      'Object',
      'List',
      'Dictionary',
      'Task',
      'Math',
      'Enumerable'
    ],
    upperAsType: true
  },
  c: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'"],
    keywords: C_KEYWORDS,
    literals: ['NULL', 'true', 'false'],
    builtins: [
      'printf',
      'scanf',
      'malloc',
      'free',
      'sizeof',
      'strlen',
      'memcpy',
      'FILE',
      'size_t',
      'uint8_t',
      'int32_t'
    ],
    upperAsType: true
  },
  cpp: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'"],
    keywords: [
      ...C_KEYWORDS,
      'nullptr',
      'constexpr',
      'noexcept',
      'concept',
      'requires',
      'co_await',
      'co_return'
    ],
    literals: ['true', 'false', 'nullptr', 'NULL'],
    builtins: [
      'std',
      'cout',
      'cin',
      'endl',
      'string',
      'vector',
      'map',
      'set',
      'unique_ptr',
      'shared_ptr',
      'size_t',
      'auto'
    ],
    upperAsType: true
  },
  go: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', '`', "'"],
    keywords: [
      'break',
      'case',
      'chan',
      'const',
      'continue',
      'default',
      'defer',
      'else',
      'fallthrough',
      'for',
      'func',
      'go',
      'goto',
      'if',
      'import',
      'interface',
      'map',
      'package',
      'range',
      'return',
      'select',
      'struct',
      'switch',
      'type',
      'var'
    ],
    literals: ['true', 'false', 'nil', 'iota'],
    builtins: [
      'append',
      'cap',
      'close',
      'complex',
      'copy',
      'delete',
      'error',
      'float32',
      'float64',
      'int',
      'int64',
      'len',
      'make',
      'new',
      'panic',
      'print',
      'println',
      'recover',
      'rune',
      'string',
      'uint',
      'uint64',
      'byte'
    ],
    upperAsType: true
  },
  rust: {
    mode: 'code',
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'"],
    keywords: [
      'as',
      'async',
      'await',
      'break',
      'const',
      'continue',
      'crate',
      'dyn',
      'else',
      'enum',
      'extern',
      'false',
      'fn',
      'for',
      'if',
      'impl',
      'in',
      'let',
      'loop',
      'match',
      'mod',
      'move',
      'mut',
      'pub',
      'ref',
      'return',
      'self',
      'static',
      'struct',
      'super',
      'trait',
      'true',
      'type',
      'unsafe',
      'use',
      'where',
      'while'
    ],
    literals: ['true', 'false', 'None', 'Some', 'Ok', 'Err'],
    builtins: [
      'String',
      'Vec',
      'Box',
      'Option',
      'Result',
      'println',
      'print',
      'format',
      'vec',
      'panic',
      'assert',
      'assert_eq'
    ],
    upperAsType: true,
    sigils: ['#']
  },
  sql: {
    mode: 'code',
    lineComment: ['--'],
    blockComment: [['/*', '*/']],
    strings: ["'", '"'],
    keywords: [
      'add',
      'all',
      'alter',
      'and',
      'as',
      'asc',
      'begin',
      'between',
      'by',
      'case',
      'cast',
      'column',
      'commit',
      'constraint',
      'create',
      'cross',
      'default',
      'delete',
      'desc',
      'distinct',
      'drop',
      'else',
      'end',
      'exists',
      'foreign',
      'from',
      'full',
      'group',
      'having',
      'if',
      'in',
      'index',
      'inner',
      'insert',
      'into',
      'is',
      'join',
      'key',
      'left',
      'like',
      'limit',
      'not',
      'null',
      'offset',
      'on',
      'or',
      'order',
      'outer',
      'primary',
      'references',
      'right',
      'select',
      'set',
      'table',
      'then',
      'union',
      'unique',
      'update',
      'values',
      'view',
      'when',
      'where',
      'with'
    ],
    literals: ['true', 'false', 'null'],
    builtins: [
      'avg',
      'count',
      'coalesce',
      'max',
      'min',
      'now',
      'sum',
      'int',
      'text',
      'varchar',
      'date',
      'timestamp'
    ],
    ignoreCase: true
  },
  json: { mode: 'data', strings: ['"'], literals: ['true', 'false', 'null'] },
  yaml: {
    mode: 'data',
    lineComment: ['#'],
    yamlKeys: true,
    strings: ['"', "'"],
    literals: ['true', 'false', 'null', 'yes', 'no', '~']
  },
  bash: {
    mode: 'code',
    lineComment: ['#'],
    strings: ['"', "'"],
    keywords: [
      'alias',
      'case',
      'cd',
      'do',
      'done',
      'echo',
      'elif',
      'else',
      'esac',
      'eval',
      'exec',
      'exit',
      'export',
      'fi',
      'for',
      'function',
      'if',
      'in',
      'local',
      'read',
      'readonly',
      'return',
      'set',
      'shift',
      'source',
      'then',
      'unset',
      'until',
      'while'
    ],
    literals: ['true', 'false'],
    builtins: [
      'awk',
      'cat',
      'chmod',
      'curl',
      'find',
      'git',
      'grep',
      'head',
      'ls',
      'mkdir',
      'npm',
      'printf',
      'rm',
      'sed',
      'sort',
      'sudo',
      'tail',
      'touch',
      'tr',
      'wc'
    ],
    sigils: ['$']
  },
  html: { mode: 'markup' },
  css: { mode: 'css' }
}

/** 别名 → 语言 id */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  cs: 'csharp',
  'c#': 'csharp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  htm: 'html',
  xml: 'html',
  scss: 'css',
  less: 'css',
  golang: 'go',
  rs: 'rust',
  postgres: 'sql',
  mysql: 'sql',
  text: '',
  plain: '',
  plaintext: ''
}

/** 归一化语言名：认别名，认不出来返回空串（＝不做高亮） */
export function normalizeCodeLanguage(language: string | undefined): string {
  const key = (language ?? '').trim().toLowerCase()
  if (key.length === 0) return ''
  if (key in DEFS) return key
  if (key in ALIASES) return ALIASES[key] ?? ''
  return ''
}

interface ScanState {
  /** 未闭合的块注释结束串 */
  blockEnd: string | null
  /** 未闭合的多行字符串引号 */
  multilineQuote: string | null
}

const IDENT_START = /[A-Za-z_$@\\]/
const IDENT_PART = /[A-Za-z0-9_$]/

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r'
}

/** 从 index 起找 needle，找不到返回 -1 */
function indexOfFrom(text: string, needle: string, from: number): number {
  return text.indexOf(needle, from)
}

/* ------------------------------------------------------------------ */
/* code 模式（大多数语言）                                             */
/* ------------------------------------------------------------------ */

function scanCodeLine(line: string, def: LanguageDef, state: ScanState): CodeToken[] {
  const tokens: CodeToken[] = []
  const push = (text: string, kind: CodeTokenKind): void => {
    if (text.length > 0) tokens.push({ text, kind })
  }
  const has = (list: string[] | undefined, word: string): boolean => Boolean(list?.includes(word))

  let i = 0
  /**
   * 推进保证（保险丝）：记录上一轮循环的起点。
   *
   * 下面每个分支都必须让 `i` 前进；一旦有分支没前进（`i <= lastI`），
   * 这里就强制吃掉一个字符——**绝不允许原地打转**。
   * 这条不是洁癖：真实事故就是某个分支匹配了却不前进，导致渲染进程
   * 100% CPU 死循环、界面永久冻死（`@` 触发的那个，见 IDENT_START/IDENT_PART 的注释）。
   */
  let lastI = -1
  while (i < line.length) {
    if (i <= lastI) {
      push(line[i] ?? '', 'operator')
      i += 1
      continue
    }
    lastI = i
    // 1) 跨行块注释 / 多行字符串的延续
    if (state.blockEnd) {
      const end = indexOfFrom(line, state.blockEnd, i)
      if (end < 0) {
        push(line.slice(i), 'comment')
        return tokens
      }
      push(line.slice(i, end + state.blockEnd.length), 'comment')
      i = end + state.blockEnd.length
      state.blockEnd = null
      continue
    }
    if (state.multilineQuote) {
      const end = indexOfFrom(line, state.multilineQuote, i)
      if (end < 0) {
        push(line.slice(i), 'string')
        return tokens
      }
      push(line.slice(i, end + state.multilineQuote.length), 'string')
      i = end + state.multilineQuote.length
      state.multilineQuote = null
      continue
    }

    // 取不到按空串处理：下面所有判断（空白/数字/标识符）对空串都为 false，
    // 也就是"这个位置没有字符可识别"，与原来的行为一致
    const ch = line[i] ?? ''

    // 2) 空白：原样保留（不合并成"可以丢的"东西，拼回去必须与源码一致）
    if (isSpace(ch)) {
      let j = i
      while (j < line.length && isSpace(line[j] ?? '')) j += 1
      push(line.slice(i, j), 'plain')
      i = j
      continue
    }

    // 3) 行注释
    const lineComment = (def.lineComment ?? []).find((mark) => line.startsWith(mark, i))
    if (lineComment) {
      push(line.slice(i), 'comment')
      return tokens
    }

    // 4) 块注释开始
    const block = (def.blockComment ?? []).find(([open]) => line.startsWith(open, i))
    if (block) {
      const [open, close] = block
      const end = indexOfFrom(line, close, i + open.length)
      if (end < 0) {
        push(line.slice(i), 'comment')
        state.blockEnd = close
        return tokens
      }
      push(line.slice(i, end + close.length), 'comment')
      i = end + close.length
      continue
    }

    // 5) 多行字符串（Python 三引号）
    const multiline = (def.multilineString ?? []).find((quote) => line.startsWith(quote, i))
    if (multiline) {
      const end = indexOfFrom(line, multiline, i + multiline.length)
      if (end < 0) {
        push(line.slice(i), 'string')
        state.multilineQuote = multiline
        return tokens
      }
      push(line.slice(i, end + multiline.length), 'string')
      i = end + multiline.length
      continue
    }

    // 6) 字符串
    if (def.strings?.includes(ch)) {
      let j = i + 1
      let closed = false
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2
          continue
        }
        if (line[j] === ch) {
          j += 1
          closed = true
          break
        }
        j += 1
      }
      // 未闭合的字符串按"到行尾"处理（不吞下一行，避免把后面的代码都染色）
      push(line.slice(i, Math.min(j, line.length)), 'string')
      i = Math.min(j, line.length)
      if (!closed) i = line.length
      continue
    }

    // 7) 数字（含 0x / 0b / 小数 / 科学计数 / 常见单位后缀）
    if (isDigit(ch) || (ch === '.' && isDigit(line[i + 1] ?? ''))) {
      let j = i
      while (j < line.length && /[0-9a-fA-FxXbBoO._eE+-]/.test(line[j] ?? '')) {
        // 只在科学计数法里允许 +/-，避免把 `1+2` 连成一个数字
        if ((line[j] === '+' || line[j] === '-') && !/[eE]/.test(line[j - 1] ?? '')) break
        j += 1
      }
      push(line.slice(i, j), 'number')
      i = j
      continue
    }

    // 8) 记号（$var / #include / @decorator）
    if (def.sigils?.includes(ch)) {
      let j = i + 1
      while (
        j < line.length &&
        (IDENT_PART.test(line[j] ?? '') || line[j] === '{' || line[j] === '}')
      ) {
        j += 1
      }
      push(line.slice(i, Math.max(j, i + 1)), 'builtin')
      i = Math.max(j, i + 1)
      continue
    }

    // 9) 标识符：关键字 / 字面量 / 内建 / 类型 / 函数调用
    if (IDENT_START.test(ch)) {
      let j = i
      while (j < line.length && IDENT_PART.test(line[j] ?? '')) j += 1
      /**
       * `IDENT_START` 认的字符 `IDENT_PART` 未必认——`@`（Python 装饰器、Java 注解、
       * JSDoc 的 `@param`）与 `\` 就是这种：**以前这里会让 `i` 原地不动**，
       * 于是整个分词器进入无限循环：渲染进程 100% CPU、界面永久冻死，而且
       * 只在「那块代码第一次进入视口（首次分词）」时才炸——所以表现得非常诡异。
       * 现在退化成「把这一个字符当作运算符吃掉」：既能推进，拼回去也仍是原文。
       */
      if (j === i) {
        push(ch, 'operator')
        i += 1
        continue
      }
      const word = line.slice(i, j)
      const probe = def.ignoreCase ? word.toLowerCase() : word
      let kind: CodeTokenKind = 'plain'
      if (has(def.keywords, probe)) kind = 'keyword'
      else if (has(def.literals, probe)) kind = 'literal'
      else if (has(def.builtins, probe)) kind = 'builtin'
      else {
        // 后面紧跟 `(` 的标识符当作函数名：`def foo(` / `foo()` 一眼能认出来
        let k = j
        while (k < line.length && isSpace(line[k] ?? '')) k += 1
        if (line[k] === '(') kind = 'function'
        else if (def.upperAsType && /^[A-Z]/.test(word)) kind = 'type'
      }
      // 关键字后面跟 `(` 仍是关键字（`if (`），上面已优先判断 ✓
      push(word, kind)
      i = j
      continue
    }

    // 10) 其余（运算符、标点、未识别字符）
    push(ch, 'operator')
    i += 1
  }
  return tokens
}

/* ------------------------------------------------------------------ */
/* data 模式（JSON / YAML）                                            */
/* ------------------------------------------------------------------ */

function scanDataLine(line: string, def: LanguageDef): CodeToken[] {
  const tokens: CodeToken[] = []
  const push = (text: string, kind: CodeTokenKind): void => {
    if (text.length > 0) tokens.push({ text, kind })
  }
  let i = 0
  let lastI = -1
  // YAML 的 `key:` 顶格写法：只在行首没缩进的键上算（缩进层也可能有键，所以按「: 之前是纯标识符」判断）
  const yamlKeyMatch = def.yamlKeys ? /^(\s*)([A-Za-z0-9_.$-]+)(\s*):/.exec(line) : null

  while (i < line.length) {
    // 推进保证（保险丝）：与 code 模式同款——任何分支都不许让 i 原地打转
    if (i <= lastI) {
      push(line[i] ?? '', 'operator')
      i += 1
      continue
    }
    lastI = i
    // 取不到按空串处理：下面所有判断（空白/数字/标识符）对空串都为 false，
    // 也就是"这个位置没有字符可识别"，与原来的行为一致
    const ch = line[i] ?? ''

    if (isSpace(ch)) {
      let j = i
      while (j < line.length && isSpace(line[j] ?? '')) j += 1
      push(line.slice(i, j), 'plain')
      i = j
      continue
    }

    if (def.lineComment?.length && def.lineComment.some((mark) => line.startsWith(mark, i))) {
      push(line.slice(i), 'comment')
      return tokens
    }

    // YAML 的键
    const yamlIndent = yamlKeyMatch?.[1] ?? ''
    const yamlKey = yamlKeyMatch?.[2] ?? ''
    if (yamlKeyMatch && i === yamlIndent.length) {
      push(yamlKey, 'property')
      i += yamlKey.length
      continue
    }

    if (def.strings?.includes(ch)) {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2
          continue
        }
        if (line[j] === ch) {
          j += 1
          break
        }
        j += 1
      }
      const text = line.slice(i, Math.min(j, line.length))
      // JSON / YAML 里「字符串后面跟冒号」就是键
      let k = Math.min(j, line.length)
      while (k < line.length && isSpace(line[k] ?? '')) k += 1
      push(text, line[k] === ':' ? 'property' : 'string')
      i = Math.min(j, line.length)
      continue
    }

    if (isDigit(ch) || (ch === '-' && isDigit(line[i + 1] ?? ''))) {
      let j = i + 1
      while (j < line.length && /[0-9.eE+-]/.test(line[j] ?? '')) j += 1
      push(line.slice(i, j), 'number')
      i = j
      continue
    }

    if (IDENT_START.test(ch)) {
      let j = i
      while (j < line.length && (IDENT_PART.test(line[j] ?? '') || line[j] === '~')) j += 1
      // 同 code 模式：IDENT_START 认的 `@` / `\` 不在 IDENT_PART 里，必须保证推进
      if (j === i) {
        push(ch, 'operator')
        i += 1
        continue
      }
      const word = line.slice(i, j)
      push(word, def.literals?.includes(word.toLowerCase()) ? 'literal' : 'plain')
      i = j
      continue
    }

    // `-` 列表项、`{}` `[]` `,` `:` 等
    push(ch, 'operator')
    i += 1
  }
  return tokens
}

/* ------------------------------------------------------------------ */
/* markup 模式（HTML / XML）                                           */
/* ------------------------------------------------------------------ */

function scanMarkupLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const push = (text: string, kind: CodeTokenKind): void => {
    if (text.length > 0) tokens.push({ text, kind })
  }
  let i = 0
  while (i < line.length) {
    if (line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4)
      push(line.slice(i, end < 0 ? line.length : end + 3), 'comment')
      i = end < 0 ? line.length : end + 3
      continue
    }
    if (line[i] === '<') {
      const end = line.indexOf('>', i)
      const seg = line.slice(i, end < 0 ? line.length : end + 1)
      // 标签名 + 属性名（属性值交给字符串分支）
      const tagMatch = /^(<\/?)([A-Za-z][\w:-]*)/.exec(seg)
      if (tagMatch) {
        const open = tagMatch[1] ?? ''
        const tag = tagMatch[2] ?? ''
        push(open, 'operator')
        push(tag, 'tag')
        let k = open.length + tag.length
        while (k < seg.length) {
          const attrMatch = /^(\s+)([A-Za-z][\w:-]*)/.exec(seg.slice(k))
          if (!attrMatch) break
          const gap = attrMatch[1] ?? ''
          const attrName = attrMatch[2] ?? ''
          push(gap, 'plain')
          push(attrName, 'attr')
          k += gap.length + attrName.length
          const eq = /^(\s*=\s*)/.exec(seg.slice(k))
          if (eq) {
            const around = eq[1] ?? ''
            push(around, 'operator')
            k += around.length
          }
          const value = /^("[^"]*"|'[^']*')/.exec(seg.slice(k))
          if (value) {
            const literal = value[1] ?? ''
            push(literal, 'string')
            k += literal.length
          }
        }
        push(seg.slice(k), 'plain')
      } else {
        push(seg, 'tag')
      }
      i += seg.length
      continue
    }
    // 标签外的文本
    const next = line.indexOf('<', i)
    push(line.slice(i, next < 0 ? line.length : next), 'plain')
    i = next < 0 ? line.length : next
  }
  return tokens
}

/* ------------------------------------------------------------------ */
/* css 模式                                                            */
/* ------------------------------------------------------------------ */

function scanCssLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const push = (text: string, kind: CodeTokenKind): void => {
    if (text.length > 0) tokens.push({ text, kind })
  }
  let i = 0
  while (i < line.length) {
    if (line.startsWith('/*', i)) {
      const end = line.indexOf('*/', i + 2)
      push(line.slice(i, end < 0 ? line.length : end + 2), 'comment')
      i = end < 0 ? line.length : end + 2
      continue
    }
    // 取不到按空串处理：下面所有判断（空白/数字/标识符）对空串都为 false，
    // 也就是"这个位置没有字符可识别"，与原来的行为一致
    const ch = line[i] ?? ''
    if (isSpace(ch)) {
      let j = i
      while (j < line.length && isSpace(line[j] ?? '')) j += 1
      push(line.slice(i, j), 'plain')
      i = j
      continue
    }
    if (def_startsWith(line, i, ['@'])) {
      const word = /^@[\w-]*/.exec(line.slice(i))
      push(word ? word[0] : '@', 'keyword')
      i += word ? word[0].length : 1
      continue
    }
    if (line[i] === '#' || line[i] === '.') {
      const word = /^[#.]-?[\w-]+/.exec(line.slice(i))
      if (word) {
        push(word[0], 'tag')
        i += word[0].length
        continue
      }
    }
    if (/[A-Za-z-]/.test(ch)) {
      const word = /^[\w-]+/.exec(line.slice(i))?.[0] ?? ch
      let j = i + word.length
      while (j < line.length && isSpace(line[j] ?? '')) j += 1
      // `color:` 形式的属性名
      const isProp = line[j] === ':' && !line.startsWith('::', j)
      push(word, isProp ? 'property' : 'plain')
      i += word.length
      continue
    }
    if (isDigit(ch)) {
      const num = /^[0-9.]+(\w+|%)?/.exec(line.slice(i))?.[0] ?? ch
      push(num, 'number')
      i += num.length
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1)
      push(line.slice(i, end < 0 ? line.length : end + 1), 'string')
      i = end < 0 ? line.length : end + 1
      continue
    }
    if (ch === '!') {
      const important = /^!\s*important/.exec(line.slice(i))
      if (important) {
        push(important[0], 'keyword')
        i += important[0].length
        continue
      }
    }
    push(ch, 'operator')
    i += 1
  }
  return tokens
}

function def_startsWith(line: string, i: number, marks: string[]): boolean {
  return marks.some((mark) => line.startsWith(mark, i))
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 逐行分词。认不出语言（`text` / 空 / 未知）时每行只有一个 plain token——
 * 也就是"不高亮"，行为与老版本完全一致。
 */
/**
 * 渲染热路径缓存。
 *
 * Canvas 的布局 useMemo 每次 workbook 变化都会产出全新 LayoutResult，
 * TopicNode 的 memo 随之整体失效——同一份代码在滚动、AI 批量写入、
 * 任何无关节点改动后都会被**重新分词一遍**（逐行逐字符，纯 CPU）。
 * 分词结果是只读的纯数据，按 `(language, code)` 复用即可，行为完全不变。
 */
const HIGHLIGHT_CACHE_LIMIT = 64
/**
 * 缓存的总字符预算。
 *
 * 早先的实现给「单个代码块」设了 20000 字符的上限（超了就不进缓存）——
 * 那是个**病理口子**：AI 往一个节点里写一整份文件时，此后每一次重排
 * （每次 store 改动、每敲一次字）都会把这段大代码**全量重新分词**，
 * 正好落在「内容依赖型冻结」的形状上。改成按总字符量限流：
 * 大代码块也能命中，内存仍有上界。
 */
const HIGHLIGHT_CACHE_CHAR_BUDGET = 4_000_000
const highlightCache = new Map<string, { lines: CodeLine[]; chars: number }>()
let highlightCacheChars = 0

export function highlightCode(code: string, language: string | undefined): CodeLine[] {
  const id = normalizeCodeLanguage(language)
  const cacheKey = `${id ?? ''}\u0000${code}`
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) {
    // Map 按插入序淘汰：命中后挪到末尾，近似 LRU
    highlightCache.delete(cacheKey)
    highlightCache.set(cacheKey, cached)
    return cached.lines
  }
  const result = highlightUncached(code, id)
  // 单块就超过总预算的（病态输入）：本次照常返回，只是不进缓存
  if (code.length <= HIGHLIGHT_CACHE_CHAR_BUDGET) {
    while (
      highlightCache.size > 0 &&
      (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT ||
        highlightCacheChars + code.length > HIGHLIGHT_CACHE_CHAR_BUDGET)
    ) {
      const oldest = highlightCache.keys().next().value
      if (oldest === undefined) break
      const evicted = highlightCache.get(oldest)
      highlightCache.delete(oldest)
      if (evicted) highlightCacheChars -= evicted.chars
    }
    highlightCache.set(cacheKey, { lines: result, chars: code.length })
    highlightCacheChars += code.length
  }
  return result
}

function highlightUncached(code: string, id: string | null): CodeLine[] {
  const lines = code.split('\n')
  const def = id ? DEFS[id] : undefined
  if (!def)
    return lines.map((line) => ({
      tokens: line.length > 0 ? [{ text: line, kind: 'plain' as const }] : []
    }))

  if (def.mode === 'markup') return lines.map((line) => ({ tokens: scanMarkupLine(line) }))
  if (def.mode === 'css') return lines.map((line) => ({ tokens: scanCssLine(line) }))
  if (def.mode === 'data') return lines.map((line) => ({ tokens: scanDataLine(line, def) }))

  // code 模式：块注释与多行字符串要跨行传递状态
  const state: ScanState = { blockEnd: null, multilineQuote: null }
  return lines.map((line) => ({ tokens: scanCodeLine(line, def, state) }))
}
