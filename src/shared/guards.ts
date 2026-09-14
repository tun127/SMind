/**
 * 解析外部数据时的通用判断。
 *
 * 项目里到处都要从"未知形状"的数据里取值——文件格式、设置文件、AI 返回、
 * 自动存档……于是「这是不是一个普通对象」这个判断一度在 8 个文件里各写了一遍，
 * 是典型的"改一处漏七处"隐患，所以收敛到这里。
 */

/** 是不是一个普通对象（非 null、非数组的对象） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
