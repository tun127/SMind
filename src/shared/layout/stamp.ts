/**
 * 子树戳：判断「某棵子树还能不能沿用上一轮算出来的东西」的唯一凭据。
 *
 * 增量布局要能安全复用，就必须能回答一个问题：**这棵子树和上一轮相比变了吗？**
 * `subtreeExtent`（子树占用）、`verticalExtent`、`maxDepth`、`measure` 的结果
 * 都只取决于「子树的内容 + 每个节点的尺寸 + 布局参数 + 边界/概要预留」，
 * 所以把这几样混成一个 32 位整数当版本号，比字符串键便宜得多，
 * 也避免了「每轮给每个节点拼一次缓存键」的开销（那正是全量重算里最白烧的一段）。
 *
 * 三条设计约束：
 * ① **内容用对象身份**：zustand + immer 保证「没被改动的主题，对象引用不变」，
 *    所以身份就是最可靠的版本号（渲染层的测量缓存用的也是这套前提）；
 * ② **子节点戳按顺序参与**：兄弟增删、换序都会改变父节点的戳，
 *    占用与摆放因此一定会重算；
 * ③ **只做单向哈希**：不追求抗碰撞到密码学强度——万分之一的重叠概率换来的是
 *    「每节点几次整数运算」，而且自检里有一条「增量结果必须逐字段等于全量结果」的
 *    硬断言兜底（真撞上了会当场失败，不会静默出错）。
 */
import type { StructureClass, Topic } from '../model/types'

/** 对象身份 → 自增编号（WeakMap 不阻碍旧对象回收） */
const objectIdentity = new WeakMap<object, number>()
/** 字符串（结构名这类枚举值）单独一张表：它们数量极少，且需要长期持有 */
const textIdentity = new Map<string, number>()
let nextIdentity = 1

export function identityId(value: object | string): number {
  if (typeof value === 'string') {
    const hit = textIdentity.get(value)
    if (hit !== undefined) return hit
    const id = nextIdentity
    nextIdentity += 1
    textIdentity.set(value, id)
    return id
  }
  const hit = objectIdentity.get(value)
  if (hit !== undefined) return hit
  const id = nextIdentity
  nextIdentity += 1
  objectIdentity.set(value, id)
  return id
}

/** FNV-1a 的 32 位混合：便宜、够用 */
export function mix(values: number[]): number {
  let hash = 2166136261
  for (const value of values) {
    hash ^= value | 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * 一个主题的子树戳。
 *
 * ⚠️ **尺寸必须参与**：正在编辑的节点，工作簿里的对象可能一个字节都没变
 * （文字还在编辑态、没提交），但它的宽度每敲一个键就会变。
 * 只按对象身份算戳的话，这棵子树会被判成"没变"，
 * 祖先的子树占用就会拿上一轮（旧宽度）的结果去摆——那正是"打字时布局不跟手"。
 *
 * @param reserves 这个主题上的四向预留（上、下、左、右）：给某几支加边界/概要，
 *   就是靠它把受影响的那几棵子树标脏的
 * @param cls 画布级结构：结构一变，同一棵子树也要按不同家族重排
 */
export function subtreeStamp(input: {
  topic: Topic
  width: number
  height: number
  childStamps: readonly number[]
  reserves: readonly number[]
  cls: StructureClass | undefined
}): number {
  const values = [
    identityId(input.topic),
    // 折叠会改变"可见子节点"，而布局只看可见的那套
    input.topic.collapsed ? 1 : 0,
    input.width,
    input.height,
    ...input.reserves
  ]
  if (input.cls !== undefined) values.push(identityId(input.cls))
  for (const stamp of input.childStamps) values.push(stamp)
  return mix(values)
}
