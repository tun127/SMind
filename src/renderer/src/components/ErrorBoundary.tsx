/**
 * 渲染期异常的兜底界面。
 *
 * 没有它的时候，任何一个渲染期异常都会让整棵 React 树卸载——用户看到的是**白屏**：
 * 没有提示、没有恢复入口，连"发生了什么"都说不出来。
 *
 * 这里刻意只提供**能兑现**的出口：重新加载界面、把错误信息复制走。
 * 不承诺"一键找回内容"——自动存档由主进程保管（每 30 秒一份），
 * 重新打开时会照常提示恢复，所以只要如实说明就够了。
 *
 * 样式全部内联：兜底界面**不能依赖**样式表——万一失败原因就在样式加载上。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  copied: boolean
}

const wrap: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px',
  background: '#f4f5f7',
  color: '#1f2430',
  fontFamily: 'system-ui, -apple-system, "Microsoft YaHei", sans-serif'
}

const card: React.CSSProperties = {
  width: '100%',
  maxWidth: '620px',
  background: '#fff',
  border: '1px solid #e3e6eb',
  borderRadius: '12px',
  padding: '28px 30px',
  boxShadow: '0 10px 30px rgba(16, 24, 40, 0.08)'
}

const button: React.CSSProperties = {
  padding: '9px 18px',
  borderRadius: '8px',
  border: '1px solid #d5d9e0',
  background: '#fff',
  color: '#1f2430',
  fontSize: '14px',
  cursor: 'pointer'
}

const primary: React.CSSProperties = {
  ...button,
  background: '#2f6fed',
  borderColor: '#2f6fed',
  color: '#fff'
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, copied: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 开发期主进程会把渲染进程的 console 转发到终端，这里至少把现场留下
    console.error('[renderer] 渲染异常：', error, info.componentStack)
    // 告诉主进程「界面坏了」：否则关窗时会一直等这个窗口回应未保存确认，
    // 而这块界面已经把 App 卸载了，**没人能回应**——窗口就关不掉了。
    try {
      // 连错误信息一起给主进程：写进日志文件，重启之后还能查（终端输出留不住）
      window.api.reportRendererError(
        error.message,
        `${error.stack ?? ''}\n\n组件栈：${info.componentStack ?? ''}`,
        true
      )
    } catch {
      /* 没有 preload 时忽略：这只影响主进程的关闭兜底 */
    }
  }

  private readonly reload = (): void => {
    // 请主进程刷新：渲染层自己发的 location.reload() 会被主进程的 will-navigate
    // 拦下，表现为「点了没反应」（这个坑真踩过）。
    try {
      window.api.reloadWindow()
      return
    } catch {
      /* 没有 preload（例如单测环境）时退回浏览器原生刷新 */
    }
    window.location.reload()
  }

  private readonly copy = (): void => {
    const { error } = this.state
    const text = [error?.message ?? '', error?.stack ?? ''].filter(Boolean).join('\n\n')
    void navigator.clipboard
      ?.writeText(text)
      .then(() => this.setState({ copied: true }))
      .catch(() => this.setState({ copied: false }))
  }

  render(): ReactNode {
    const { error, copied } = this.state
    if (!error) return this.props.children

    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={{ margin: '0 0 10px', fontSize: '19px' }}>界面遇到了一个错误</h1>
          <p style={{ margin: '0 0 16px', fontSize: '14px', lineHeight: 1.7, color: '#4a5262' }}>
            这块界面已经停止渲染，但你的文档没有被丢弃：自动存档每 30 秒保存一份，
            重新启动本软件时会提示恢复。建议先复制下面的错误信息，再点「重新加载界面」；
            直接关闭这个窗口也可以（这时的关闭不会再询问未保存内容）。
          </p>

          <details style={{ margin: '0 0 18px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '13px', color: '#2f6fed' }}>
              查看错误详情（反馈时请附上）
            </summary>
            <pre
              style={{
                margin: '10px 0 0',
                padding: '12px',
                background: '#f7f8fa',
                border: '1px solid #eceef2',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: 1.6,
                maxHeight: '220px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ''}
            </pre>
          </details>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button type="button" style={primary} onClick={this.reload}>
              重新加载界面
            </button>
            <button type="button" style={button} onClick={this.copy}>
              {copied ? '已复制' : '复制错误信息'}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
