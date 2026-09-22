/**
 * LaTeX 公式渲染与尺寸测量。
 *
 * 尺寸有两套来源：
 * 1. 渲染层能拿到 DOM 时，用 KaTeX 真实的排版结果量一次并缓存（sizeCache）；
 * 2. 拿不到 DOM（自检 / Node 环境）时，退回 shared 里的纯估算。
 *
 * 布局（measure.ts）与渲染（TopicNode）用的是同一个 formulaSize，
 * 因此「布局算出来的框」与「实际画出来的内容」不会打架。
 */
import katex from 'katex'
import { pureFormulaSize, FORMULA_HARD_MAX_WIDTH, type Size } from '@shared/layout/accessory'
import { escapeHtml } from '@shared/richtext'
import { evictOldest } from '@shared/cache'

const htmlCache = new Map<string, string>()
const sizeCache = new Map<string, Size>()
const CACHE_LIMIT = 2000

let measureHost: HTMLDivElement | null = null

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined'
}

/** 把 LaTeX 源码渲染成 HTML（失败时给出可读的错误提示，而不是抛异常打断整个画布） */
export function formulaHtml(source: string): string {
  const cached = htmlCache.get(source)
  if (cached !== undefined) return cached

  let html: string
  try {
    html = katex.renderToString(source, {
      throwOnError: false,
      displayMode: false,
      output: 'html',
      errorColor: '#d9534f'
    })
  } catch (error) {
    // 异常消息必须转义：这段 HTML 是交给 dangerouslySetInnerHTML 注入的，
    // 而公式文本来自文件（是可以被构造的外部输入），未转义就等于给它一条逃逸出属性的路
    const detail = escapeHtml(String((error as Error).message ?? ''))
    html = `<span class="formula-error" title="${detail}">公式无法解析</span>`
  }

  evictOldest(htmlCache, CACHE_LIMIT)
  htmlCache.set(source, html)
  return html
}

function host(): HTMLDivElement | null {
  if (measureHost) return measureHost
  if (!document.body) return null
  const el = document.createElement('div')
  el.className = 'formula-measure'
  el.setAttribute('aria-hidden', 'true')
  document.body.appendChild(el)
  measureHost = el
  return measureHost
}

/**
 * 公式显示框尺寸。
 * @param fontSize 公式所在节点的基准字号，保证公式与节点文字成比例
 */
export function formulaSize(source: string, fontSize: number): Size {
  const key = `${fontSize}\u0000${source}`
  const cached = sizeCache.get(key)
  if (cached) return cached

  let size = pureFormulaSize(source, fontSize)
  const el = hasDom() ? host() : null
  if (el) {
    try {
      el.style.fontSize = `${fontSize}px`
      el.innerHTML = formulaHtml(source)
      const child = el.firstElementChild
      // 用 getBoundingClientRect 拿**亚像素**尺寸，再向上取整 + 2px 余量：
      // offsetWidth 是取整值，渲染又是亚像素的，差值会恰好把右/下边缘切掉一点点
      const rect =
        child instanceof HTMLElement ? child.getBoundingClientRect() : el.getBoundingClientRect()
      const width = rect.width
      const height = rect.height
      if (width > 0 && height > 0) {
        size = {
          // 公式是**原子内容**：它多宽，节点框就该多宽（报告 §23 —— 原来这里截到
          // FORMULA_HARD_MAX_WIDTH * 2 = 520px，实测 870px 的公式于是左右各溢出 161px，
          // 块级公式还被 .topic__formula 的 overflow:hidden 直接裁掉）。
          // 只保留一个"防呆"上限，避免病态输入把画布撑到不可用。
          width: Math.max(1, Math.min(Math.ceil(width) + 2, FORMULA_HARD_MAX_WIDTH)),
          height: Math.max(1, Math.ceil(height) + 2)
        }
      }
    } catch {
      // 量不出来就用估算值，不影响其它功能
    } finally {
      el.innerHTML = ''
    }
  }

  evictOldest(sizeCache, CACHE_LIMIT)
  sizeCache.set(key, size)
  return size
}

/**
 * 字体加载完成后 KaTeX 的真实字宽才会稳定。
 * 调用方（画布）在 document.fonts.ready 之后调用它并触发一次重新布局。
 */
export function clearFormulaCache(): void {
  sizeCache.clear()
  htmlCache.clear()
}
