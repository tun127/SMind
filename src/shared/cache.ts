/**
 * 固定容量缓存的淘汰策略。
 *
 * 为什么不是「满了就整体清空」：整体清空会让**所有**条目在同一瞬间失效——
 * 用户感受到的就是"用着用着突然卡一下"，之后还要一点点把缓存重新建起来
 * （大文档下这个尖峰很明显）。淘汰最旧的一批则只损失一小部分命中率，
 * 代价被平摊掉，没有尖峰。
 *
 * Map 保持插入顺序，所以"最旧"就是最先写入的那些，不需要另外维护链表。
 */
export function evictOldest<K, V>(cache: Map<K, V>, limit: number, ratio = 0.25): void {
  if (cache.size < limit) return
  const drop = Math.max(1, Math.floor(limit * ratio))
  let removed = 0
  for (const key of cache.keys()) {
    cache.delete(key)
    removed += 1
    if (removed >= drop) break
  }
}
