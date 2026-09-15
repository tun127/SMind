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
