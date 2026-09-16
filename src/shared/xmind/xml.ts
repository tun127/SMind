/**
 * 极简 XML 解析器（只为读 Xmind 8 的 content.xml 服务）。
 *
 * 为什么不引第三方库：项目其它部分（布局、序列化、导出）都是自研，
 * 而这里需要的只是「把一棵 XML 树读出来」，用不着完整实现 XML 规范。
 *
 * 支持：声明、注释、DOCTYPE、CDATA、自闭合标签、单双引号属性、实体、命名空间前缀。
 * 不支持（用不到的）：DTD 实体定义、处理指令以外的 Parser 扩展。
 */

export interface XmlNode {
  /** 完整标签名（含命名空间前缀，如 xhtml:img） */
  name: string
  /** 去掉前缀的标签名 */
  local: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** 本节点内的文本（CDATA 内容原样保留） */
  text: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0'
}

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 解码 XML 实体（&amp; / &#65; / &#x41; …） */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X'))
      return fromCodePoint(parseInt(body.slice(2), 16)) || whole
    if (body.startsWith('#')) return fromCodePoint(parseInt(body.slice(1), 10)) || whole
    return NAMED_ENTITIES[body] ?? whole
  })
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

/** 把属性串拆成键值对 */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const key = match[1]
    if (!key) continue
    const raw = match[3] !== undefined ? match[3] : (match[4] ?? '')
    attrs[key] = decodeEntities(raw)
    // 同时用去前缀的名字存一份，方便 <xhtml:img> 这类带前缀的属性
    const short = localName(key)
    if (!(short in attrs)) attrs[short] = attrs[key] ?? ''
  }
  return attrs
}

/** 找出标签结束的 '>'（跳过引号里的内容） */
function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i
  }
  return -1
}

/** 解析一段 XML，返回根节点；解析不出根节点时返回 null */
export function parseXml(source: string): XmlNode | null {
  let root: XmlNode | null = null
  const stack: XmlNode[] = []
  let pos = 0

  const appendText = (raw: string, decoded: boolean): void => {
    const current = stack[stack.length - 1]
    if (!current || raw.length === 0) return
    current.text += decoded ? decodeEntities(raw) : raw
  }

  while (pos < source.length) {
    const lt = source.indexOf('<', pos)
    if (lt < 0) {
      appendText(source.slice(pos), true)
      break
    }
    if (lt > pos) appendText(source.slice(pos, lt), true)
    pos = lt

    // 注释
    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos + 4)
      pos = end < 0 ? source.length : end + 3
      continue
    }
    // CDATA：内容原样保留，不再解码
    if (source.startsWith('<![CDATA[', pos)) {
      const end = source.indexOf(']]>', pos + 9)
      appendText(source.slice(pos + 9, end < 0 ? source.length : end), false)
      pos = end < 0 ? source.length : end + 3
      continue
    }
    // 声明 / DOCTYPE / 其它 <! ... >
    if (source.startsWith('<?', pos) || source.startsWith('<!', pos)) {
      const end = findTagEnd(source, pos)
      pos = end < 0 ? source.length : end + 1
      continue
    }
    // 闭合标签
    if (source.startsWith('</', pos)) {
      const end = findTagEnd(source, pos)
      if (end < 0) break
      stack.pop()
      pos = end + 1
      continue
    }

    // 开始标签
    const end = findTagEnd(source, pos)
    if (end < 0) break
    let inner = source.slice(pos + 1, end)
    const selfClosing = inner.endsWith('/')
    if (selfClosing) inner = inner.slice(0, -1)

    const spaceAt = inner.search(/[\s/]/)
    const name = (spaceAt < 0 ? inner : inner.slice(0, spaceAt)).trim()
    const attrs = spaceAt < 0 ? {} : parseAttrs(inner.slice(spaceAt))

    if (name.length > 0) {
      const node: XmlNode = { name, local: localName(name), attrs, children: [], text: '' }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(node)
      else if (!root) root = node

      if (!selfClosing) stack.push(node)
    }

    pos = end + 1
  }

  return root
}

/* ------------------------------------------------------------------ */
/* 查询辅助                                                            */
/* ------------------------------------------------------------------ */

export function childrenOf(node: XmlNode | null, local: string): XmlNode[] {
  if (!node) return []
  return node.children.filter((child) => child.local === local)
}

export function childOf(node: XmlNode | null, local: string): XmlNode | null {
  return childrenOf(node, local)[0] ?? null
}

/** 取节点文本（含 CDATA），并去掉首尾空白 */
export function textOf(node: XmlNode | null): string | undefined {
  if (!node) return undefined
  const text = node.text.trim()
  return text.length > 0 ? text : undefined
}

/** 取子元素的文本 */
export function childText(node: XmlNode | null, local: string): string | undefined {
  return textOf(childOf(node, local))
}
