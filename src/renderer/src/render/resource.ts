/**
 * 包内资源（resources/…）在界面上的访问地址。
 *
 * 主进程用自定义协议 mind-resource 提供这些字节，
 * 画布上的 <img> 直接用这个地址，不必把二进制搬进渲染进程。
 */
const SCHEME = 'mind-resource'

export function resourceUrl(packPath: string): string {
  const encoded = packPath
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${SCHEME}://local/${encoded}`
}
