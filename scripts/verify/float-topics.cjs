/* global WebSocket */
/**
 * 独立主题（detachedChildren）画布渲染验收探针。
 *
 * 用法（两步）：
 *   1) 起应用并打开含独立主题的 .xmind，带 remote debugging：
 *        electron --remote-debugging-port=9222 . .tmp-check/浮动主题测试.xmind
 *   2) node scripts/verify/float-topics.cjs
 *
 * 通过条件：页面上至少存在一个可见的 `.topic` 元素，文本包含 FLOAT_TEXT
 *（默认「第四季度」）。同时把每个 `.topic` 的文字与包围盒打出来，便于独立复核。
 *
 * 环境变量：CDP_PORT（默认 9222）、FLOAT_TEXT（默认「第四季度」）。
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)
const FLOAT_TEXT = process.env.FLOAT_TEXT ?? '第四季度'

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error('没有 page target（App 起了吗？端口对吗？）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.result?.exceptionDetails)
      throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300))
    return res.result?.result?.value
  }
  await send('Runtime.enable')
  await send('Page.enable')
  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  } catch {
    /* 忽略 */
  }
  try {
    await send('Page.bringToFront')
  } catch {
    /* 忽略 */
  }
  return { evalJs, wait: (ms) => new Promise((r) => setTimeout(r, ms)), close: () => ws.close() }
}

const READ = `(() => {
  const nodes = [...document.querySelectorAll('.topic')]
  const rects = nodes.map((el) => {
    const r = el.getBoundingClientRect()
    return {
      text: (el.textContent ?? '').trim().slice(0, 14),
      left: Math.round(r.left),
      top: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible:
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth,
      inlineLeft: el.style.left,
      inlineTop: el.style.top
    }
  })
  return {
    topicCount: nodes.length,
    viewport: { w: innerWidth, h: innerHeight },
    rects,
    matched: rects.filter((r) => r.text.includes(${JSON.stringify(FLOAT_TEXT)})),
    diag: window.__layoutDiag ? JSON.parse(JSON.stringify(window.__layoutDiag)) : null
  }
})()`

async function main() {
  const cdp = await connect()
  try {
    await cdp.wait(1500)
    const data = await cdp.evalJs(READ)
    console.log('视口:', JSON.stringify(data.viewport))
    console.log('画布上的 .topic 元素数:', data.topicCount)
    console.log('每个节点的文字与位置：')
    for (const r of data.rects) {
      console.log(
        `  ${String(r.text).padEnd(14)} left=${String(r.left).padStart(6)} top=${String(r.top).padStart(6)} ${r.w}x${r.h}  可见=${r.visible}  inline=${r.inlineLeft}/${r.inlineTop}`
      )
    }
    console.log(`\n匹配「${FLOAT_TEXT}」的元素：`, JSON.stringify(data.matched))
    if (data.diag) console.log('__layoutDiag:', JSON.stringify(data.diag).slice(0, 300))
    const visible = data.matched.filter((item) => item.visible)
    if (visible.length === 0) {
      console.error(`\nFAIL：没有可见的「${FLOAT_TEXT}」.topic 元素`)
      process.exitCode = 1
      return
    }
    console.log(`\nPASS：可见的「${FLOAT_TEXT}」元素 ${visible.length} 个`)
  } finally {
    cdp.close()
  }
}

main().catch((error) => {
  console.error('ERR', error && error.message ? error.message : String(error))
  process.exit(2)
})
