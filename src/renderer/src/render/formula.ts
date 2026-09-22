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
import {
  formulaRowCount,
  pureFormulaSize,
  FORMULA_HARD_MAX_WIDTH,
  type Size
} from '@shared/layout/accessory'
import { escapeHtml } from '@shared/richtext'
import { evictOldest } from '@shared/cache'

const htmlCache = new Map<string, string>()
const sizeCache = new Map<string, Size>()
const CACHE_LIMIT = 2000

/**
 * 公式实测尺寸版本。
 *
 * 布局缓存会在主题对象没变时沿用旧测量/旧子树占用；但 `formulaSize` 的真实尺寸
 * 依赖 DOM 与字体，可能在两次布局之间从估算切到实测。拿到新的实测值后把版本号 +1，
 * 画布把它并入布局的 extras，让 `layoutSheetCached` 走「排版环境变了」的分支
 *（resetLayoutMemo + 全量重排），而不是留在增量 pass 里继续读旧高度。
 */
let measureVersion = 0
let bumpScheduled = false
const measureListeners = new Set<() => void>()
const measuredSizes = new Map<string, Size>()

function scheduleMeasureVersionBump(): void {
  if (bumpScheduled) return
  bumpScheduled = true
  queueMicrotask(() => {
    bumpScheduled = false
    measureVersion += 1
    for (const listener of measureListeners) listener()
  })
}

/** 当前公式实测尺寸版本，供 useSyncExternalStore / 布局 extras 使用 */
export function formulaMeasureVersion(): number {
  return measureVersion
}

/** 订阅公式实测尺寸变化；返回值取消订阅 */
export function subscribeFormulaMeasure(listener: () => void): () => void {
  measureListeners.add(listener)
  return () => {
    measureListeners.delete(listener)
  }
}

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
  /**
   * 必须复制 `.topic__formula` 的 flex 布局上下文：否则 `.katex` 在测量宿主里
   * 是 inline 元素，`getBoundingClientRect`/`scrollHeight` 都量不到真实块高
   *（实测盒高 21、scrollHeight 0；同一节点在 `.topic__formula` 里实际 54）。
   */
  el.style.display = 'flex'
  el.style.alignItems = 'flex-start'
  el.style.lineHeight = '1'
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
  let measured = false
  const el = hasDom() ? host() : null
  if (el) {
    try {
      el.style.fontSize = `${fontSize}px`
      el.innerHTML = formulaHtml(source)
      const child = el.firstElementChild
      /**
       * 不能只信 `getBoundingClientRect()`：实测 .katex 的盒高 25px，
       * 而内容实际 29px（scrollHeight），盒子比内容矮 4px；
       * 外层 `.topic__formula` 还是 overflow:hidden + 居中，于是上下各切一截，
       * 多行 cases 会把差距放大到整行被切。
       *
       * 宽度同理取 scrollWidth 兜底——盒宽可能比真实排版窄 1px，
       * 和 Bug 2 的 `.topic__text` 是同一类问题。
       */
      const childEl = child instanceof HTMLElement ? child : null
      const rect = childEl ? childEl.getBoundingClientRect() : el.getBoundingClientRect()
      const width = Math.max(rect.width, childEl?.scrollWidth ?? 0)
      const height = Math.max(rect.height, childEl?.scrollHeight ?? 0)
      if (width > 0 && height > 0) {
        size = {
          // 公式是**原子内容**：它多宽，节点框就该多宽（报告 §23 —— 原来这里截到
          // FORMULA_HARD_MAX_WIDTH * 2 = 520px，实测 870px 的公式于是左右各溢出 161px，
          // 块级公式还被 .topic__formula 的 overflow:hidden 直接裁掉）。
          // 只保留一个"防呆"上限，避免病态输入把画布撑到不可用。
          width: Math.max(1, Math.min(Math.ceil(width) + 2, FORMULA_HARD_MAX_WIDTH)),
          // 多行时 +2 的余量不够：每多一行再补 2px（与估算路径的 formulaRowCount 同一口径）。
          height: Math.max(1, Math.ceil(height) + 2 + (formulaRowCount(source) - 1) * 2)
        }
        measured = true
      }
    } catch {
      // 量不出来就用估算值，不影响其它功能
    } finally {
      el.innerHTML = ''
    }
  }

  /**
   * 只缓存 **DOM 实测值**。
   *
   * 以前无论有没有走通 DOM 都把 `size` 写进缓存；字体未就绪、量到 0 或 Node 环境时
   * 写进去的是估算值，之后字体就绪也不会再变（多行公式因此被 overflow:hidden 裁掉）。
   * 估算值轻量、可重复计算，不缓存反而保证下一帧 / 字体就绪后能重新量。
   */
  if (measured) {
    const previous = measuredSizes.get(key)
    measuredSizes.set(key, size)
    evictOldest(sizeCache, CACHE_LIMIT)
    evictOldest(measuredSizes, CACHE_LIMIT)
    sizeCache.set(key, size)
    if (!previous || previous.width !== size.width || previous.height !== size.height) {
      scheduleMeasureVersionBump()
    }
  }
  return size
}

/**
 * 字体加载完成后 KaTeX 的真实字宽才会稳定。
 * 调用方（画布）在 document.fonts.ready 之后调用它并触发一次重新布局。
 */
export function clearFormulaCache(): void {
  sizeCache.clear()
  htmlCache.clear()
  measuredSizes.clear()
  // 字体等外部条件变了：即使布局 extras 没变，也要让画布重新走一次全量布局。
  scheduleMeasureVersionBump()
}
