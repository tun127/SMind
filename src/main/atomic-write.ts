/**
 * 原子写文件。
 *
 * 直接 `fs.writeFile` 就地覆盖是有风险的——写到一半被打断（磁盘满、进程被杀、断电），
 * 磁盘上留下的是**被截断的半截文件**，而这里覆盖的往往是用户的原稿。
 * 同盘 `rename` 是原子操作，所以目标文件永远处于「要么旧内容、要么新内容」的状态。
 *
 * 先 fsync 再 rename：否则断电场景下，rename 可能先于数据落盘，仍然会丢内容。
 *
 * 单独成一个文件（而不是留在主进程入口里）是为了能被自检直接覆盖——
 * 这条路径一旦出错丢的是用户原文件，值得有断言盯着；同理它也不能 import electron，
 * 否则自检（Node 环境）没法加载它。
 */
import { promises as fs } from 'node:fs'

/** 临时文件后缀：一眼能看出是残留物，也便于将来清理 */
const TEMP_SUFFIX = '.tmp'

export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${process.pid}${TEMP_SUFFIX}`
  try {
    const handle = await fs.open(temp, 'w')
    try {
      await handle.writeFile(Buffer.from(bytes))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, path)
  } catch (error) {
    // 失败必须清掉临时文件：否则用户目录里会攒下一堆半截文件
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
