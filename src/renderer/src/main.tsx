import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
// KaTeX 的样式与字体：公式节点靠它排版，必须在渲染前就位
import 'katex/dist/katex.min.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到根节点 #root')

// 用错误边界包住：否则任何渲染期异常都会让整棵树卸载，用户只看到白屏
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)

/**
 * 兜底留痕：**异步 / 事件里抛出的错误不会被错误边界接住**，
 * 但它们同样会让用户觉得"应用坏了"，而事后我们手里什么都没有（日志里一片空白）。
 *
 * `uiBroken` 传 false：这类错误不影响界面可用性，不该跳过关窗前的未保存确认。
 */
window.addEventListener('error', (event) => {
  try {
    const error: unknown = event.error
    window.api.reportRendererError(event.message, error instanceof Error ? error.stack : undefined)
  } catch {
    /* 上报失败就算了，别在兜底里再抛一次 */
  }
})

window.addEventListener('unhandledrejection', (event) => {
  try {
    const reason: unknown = event.reason
    window.api.reportRendererError(
      `未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`,
      reason instanceof Error ? reason.stack : undefined
    )
  } catch {
    /* 同上 */
  }
})
