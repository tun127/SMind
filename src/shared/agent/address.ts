/**
 * 寻址：模型只会给字符串，解析成具体节点是**应用的责任**。
 *
 * 支持序号短柄（#3）、标题、路径等写法；解析失败要给出「模型能读懂并自行纠正」的原因，
 * 而不是一句「找不到」。
 */
import type { Topic } from '../model/types'
import { allChildrenOf, ancestorsOf, findTopic } from '../model/tree'

/* ------------------------------------------------------------------ */
/* 寻址：模型只会给字符串，解析成具体节点是**应用的责任**               */
/* ------------------------------------------------------------------ */

export interface ResolvedTopic {
  topic: Topic
  /** 中心主题 → 该节点 的标题链 */
  path: string[]
}

export type AddressResult = { ok: true; resolved: ResolvedTopic } | { ok: false; error: string }

/**
 * 给模型用的**短句柄**：取节点 id 的最后一段（创建时生成的 6 个随机字符）。
 *
 * 为什么必须有它：大导图里同名节点能出现几十次（「创建 socket.socket()」这类），
 * 按标题寻址必然歧义；标题还可能带斜杠、超长、含奇怪符号。句柄是**唯一**的，
 * 模型从读工具里拿到它，就能一次把上百个节点搬完——这是「一回合整理完」的关键。
 */
export function shortHandleOf(id: string): string {
  const parts = id.split('-')
  const last = parts[parts.length - 1] ?? ''
  return last.length > 0 ? last : id.slice(-6)
}

/** 从中心主题到某节点的标题链；节点不存在返回 null */
export function topicPathOf(root: Topic, id: string): string[] | null {
  const self = findTopic(root, id)
  if (!self) return null
  const titles = ancestorsOf(root, id).map((item) => findTopic(root, item)?.title ?? '')
  return [...titles, self.title]
}

/** 某节点下的子主题清单（最多 8 个）：把候选回给模型，它下一步就能自己纠正 */
function describeChildren(topic: Topic, limit = 8): string {
  // 自由摆放的主题也能被地址找到（见 model/tree.ts 的 allChildrenOf），
  // 所以"这一层有哪些子主题"也要把它们列出来，不然纠错提示会漏掉正确答案
  const titles = allChildrenOf(topic)
    .map((child) => child.title)
    .filter((title) => title.length > 0)
  if (titles.length === 0) return `（「${topic.title}」下面没有子主题）`
  const shown = titles.slice(0, limit)
  const more = titles.length > shown.length ? ` 等 ${titles.length} 个` : ''
  return `（在「${topic.title}」下有：${shown.join('、')}${more}）`
}

/** 找不到精确标题时，给模型几条「你可能想找的是」 */
function suggestTitles(root: Topic, query: string, limit = 5): string[] {
  const out: string[] = []
  const visit = (topic: Topic): void => {
    if (out.length >= limit) return
    if (topic.title.length > 0 && topic.title !== query && topic.title.includes(query))
      out.push(topic.title)
    for (const child of topic.children) visit(child)
  }
  visit(root)
  return out
}

/**
 * 把模型给的 address 解析成具体节点。
 *
 * 支持三种写法，按可靠性从高到低尝试：**主题 id** → **标题路径** → **唯一标题**。
 * 失败时返回的话要能指导下一步动作（列出候选、提示改用路径），
 * 因为这段文字会原样回喂给模型让它自我纠正。
 */
export function resolveTopicAddress(root: Topic, address: string): AddressResult {
  const raw = address.trim()
  if (raw.length === 0) return { ok: false, error: 'address 不能为空' }

  // 1) 主题 id：最可靠，模型从 getSelection / searchNodes 拿到过 id 时走这条
  const byId = findTopic(root, raw)
  if (byId) {
    const path = topicPathOf(root, raw)
    if (path) return { ok: true, resolved: { topic: byId, path } }
  }

  // 1b) 短句柄（读工具每行都会打出的 `#xxxxxx`）：重名 / 超长 / 带斜杠的标题全靠它寻址
  const bare = raw.startsWith('#') ? raw.slice(1) : raw
  if (/^[0-9a-z]{4,10}$/.test(bare)) {
    const matched: Topic[] = []
    const scan = (topic: Topic): void => {
      if (shortHandleOf(topic.id) === bare) matched.push(topic)
      for (const child of topic.children) scan(child)
    }
    scan(root)
    const only = matched[0]
    if (matched.length === 1 && only) {
      const path = topicPathOf(root, only.id)
      if (path) return { ok: true, resolved: { topic: only, path } }
    }
    if (matched.length > 1) {
      return {
        ok: false,
        error: `句柄「${raw}」在文档里出现了 ${matched.length} 次（极罕见）。请改用完整的主题 id 或标题路径。`
      }
    }
  }

  // 2) 标题路径：中心主题/成本/人力。
  //    模型很爱把**文档名**或中心主题也写进开头（「体检报告/分支/子」），
  //    所以允许从开头跳掉一到两段再试；只要能走到底就算命中。
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  /** 路径解析的失败原因：先留着，等「整串标题精确匹配」也失败才报——见第 3 步的注释 */
  let pathError = ''
  if (parts.length > 1) {
    let bestDepth = -1
    let bestError = ''
    for (let skip = 0; skip <= Math.min(2, parts.length - 1); skip += 1) {
      const steps = parts.slice(skip)
      let cursor: Topic = root
      let depth = 0
      let failed = false
      for (const step of steps) {
        const next = allChildrenOf(cursor).find((child) => child.title === step)
        if (!next) {
          // 记下「走得最深」的那次失败：它离答案最近，对模型最有指导性
          if (depth >= bestDepth) {
            bestDepth = depth
            bestError = `路径「${raw}」中找不到「${step}」${describeChildren(cursor)}`
          }
          failed = true
          break
        }
        cursor = next
        depth += 1
      }
      if (!failed) {
        const path = topicPathOf(root, cursor.id)
        if (path) return { ok: true, resolved: { topic: cursor, path } }
      }
    }
    if (bestError.length > 0) {
      // 不在这里直接报错：标题里**本身带斜杠**的节点（「class A: /A ()」这类，
      // 编程笔记里一抓一把）路径一定走不通，但整串标题精确匹配能救回来——
      // 先让第 3 步试，第 3 步也失败才把路径错误报出去
      pathError = `${bestError}。也可以直接用 searchNodes 按标题搜索。`
    }
  }

  // 3) 唯一标题
  const matches: Topic[] = []
  const collect = (topic: Topic): void => {
    if (topic.title === raw) matches.push(topic)
    for (const child of topic.children) collect(child)
  }
  collect(root)

  if (matches.length === 1) {
    const only = matches[0]
    if (only) {
      const path = topicPathOf(root, only.id)
      if (path) return { ok: true, resolved: { topic: only, path } }
    }
  }
  if (matches.length > 1) {
    // 重名必须问清楚：硬选一个就是「自信地改错节点」的源头
    const paths = matches
      .map((topic) => topicPathOf(root, topic.id)?.join('/') ?? '')
      .filter((item) => item.length > 0)
      .slice(0, 5)
    return {
      ok: false,
      error: `标题「${raw}」在文档里出现了 ${matches.length} 次，无法确定是哪一个。请改用路径指定，例如：${paths.join('、')}`
    }
  }

  // 标题精确匹配也没救回来，路径错误才是真正要报的
  if (matches.length === 0 && pathError.length > 0) {
    return { ok: false, error: pathError }
  }

  const hints = suggestTitles(root, raw)
  return {
    ok: false,
    error:
      hints.length > 0
        ? `没有找到标题为「${raw}」的主题。标题里包含「${raw}」的有：${hints.join('、')}——请确认要用哪一个。`
        : `没有找到标题为「${raw}」的主题，可先用 searchNodes 搜索关键词。`
  }
}
