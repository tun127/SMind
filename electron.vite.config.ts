import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const sharedDir = resolve(__dirname, 'src/shared')

/**
 * 内容安全策略。
 *
 * 为什么是 meta 而不是响应头：生产环境的页面是 `file://` 加载的，
 * `webRequest.onHeadersReceived` 拦不到这类请求，只有页面里的 meta 生效。
 *
 * 为什么只在构建时注入：开发模式下 Vite 会往页面里插内联脚本（React Refresh 的
 * 预置代码），严格的 `script-src` 会直接把开发环境打死。生产包里没有内联脚本，
 * 所以"允许内联脚本"这个口子只需要在开发期存在。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // KaTeX 与富文本编辑器会写内联 style 属性，样式源必须放开 inline
  "style-src 'self' 'unsafe-inline'",
  // 图片来自包内资源协议与 data:/blob: 预览
  "img-src 'self' data: blob: mind-resource:",
  "font-src 'self' data:",
  // 渲染层不发网络请求：AI 调用走主进程 IPC
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'smind-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head-prepend'
      }
    ]
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': sharedDir }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': sharedDir }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': sharedDir
      }
    },
    plugins: [react(), cspPlugin()],
    define: {
      /**
       * 构建时间戳。
       *
       * 只为一个目的：开发期能一眼看出「这个窗口是不是旧的」。
       * 最气人的情况是改了代码、窗口却还停在两小时前那份，白跑一轮复验（真发生过）。
       */
      __BUILD_STAMP__: JSON.stringify(new Date().toISOString())
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
