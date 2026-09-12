import { createRoot } from 'react-dom/client'
import App from './App'
// KaTeX 的样式与字体：公式节点靠它排版，必须在渲染前就位
import 'katex/dist/katex.min.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到根节点 #root')

createRoot(container).render(<App />)
