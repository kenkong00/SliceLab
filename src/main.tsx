import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// 开发环境才加载：dev server 重启导致 HMR WebSocket token 失效时自动刷新页面
if (import.meta.env.DEV) {
  void import('./dev/hmrGuard').then((m) => m.installHmrGuard())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
