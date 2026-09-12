import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到根节点 #root')

createRoot(container).render(<App />)
