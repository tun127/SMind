/**
 * 纯分词器：一行文本 + 语言定义 → 一串 token。
 *
 * 单一职责：只做词法扫描，不做缓存、不做语言归一（见入口 highlight.ts）。
 * 四类扫描器对应四类语法族：代码 / 数据 / 标记语言 / CSS。
 */
import type { LanguageDef } from './lang-defs'

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

export interface ScanState {
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

export function scanCodeLine(line: string, def: LanguageDef, state: ScanState): CodeToken[] {
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

export function scanDataLine(line: string, def: LanguageDef): CodeToken[] {
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

export function scanMarkupLine(line: string): CodeToken[] {
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

export function scanCssLine(line: string): CodeToken[] {
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
