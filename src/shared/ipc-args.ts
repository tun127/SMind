/**
 * IPC 入参校验。
 *
 * 渲染进程与主进程之间**不是**天然的信任边界终点：渲染层一旦被注入（外部文件、
 * 粘贴内容、第三方依赖），它能做的就只有"调用这些 IPC"。所以主进程侧该拦的必须拦——
 * 尤其"读任意路径 / 写任意路径 / 显示任意路径"这几个放大器的开关，不能只靠渲染层自觉。
 *
 * 这里的尺度刻意保守：**只拦能确定是错的**，业务层该给的提示留给业务层。
 * 比如路径的扩展名校验不在这里做——用户完全可能把文件改名后再打开，
 * 那应该得到"这个文件解析失败"，而不是"路径非法"这种技术味很重的提示。
 *
 * 本模块不引 `node:path`：渲染进程也会打包它，得保持纯字符串判断。
 */

/** 路径长度上限：够容纳 Windows 长路径，又不至于让异常输入撑爆日志与提示框 */
const MAX_PATH_LENGTH = 4096

/** 单张图片上限 20MB：够放高清截图，又不至于让一份 .xmind 变成几百 MB */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 绝对路径判定（Windows 盘符 / UNC / POSIX 三种写法） */
function isAbsoluteLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/**
 * 是不是一个"可以拿去做文件操作"的路径。
 * 只做能确定的检查：非空、长度合理、绝对路径、不含 NUL。
 */
export function isPlausibleFilePath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false
  if (value.includes('\0')) return false
  return isAbsoluteLike(value)
}

/**
 * 图片入参检查。
 * @returns 通过时返回 null，否则返回给用户看的原因
 */
export function checkImagePayload(bytes: unknown, name?: unknown): string | null {
  if (!(bytes instanceof Uint8Array)) return '图片数据无效'
  if (bytes.byteLength === 0) return '这张图片是空文件，无法插入'
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1)
    return `图片太大（${mb}MB），单张上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`
  }
  if (typeof name === 'string' && name.length > 255) return '图片名称过长'
  return null
}
