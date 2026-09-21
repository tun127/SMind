/* global WebSocket */
/**
 * 用 CDP 驱动**真实打包版 App** 做验收：组词不折行（D-07）+ 清空不缩回探针（D-14）。
 *
 * 与 `renderer-geometry.cjs` 的分工（两份都要留，别互相替代）：
 *   · `renderer-geometry.cjs`：**复刻 DOM** + 产品自己的 CSS，验"CSS 约束机制"（A3 的做法为什么无效、
 *     D-07 的写法为什么有效）。快、无需打包产物，但**不经过产品的 React/测量链路**。
 *   · 本脚本：驱动 `release/win-unpacked/SMind.exe`，走**产品自己的**编辑器、测量与 IPC —— 真机证据。
 *     代价：要先打包、要起进程，且必须用真实 App 的窗口。
 *
 * 用法（两步）：
 *   1) 起 App 并打开调试端口：
 *        .\release\win-unpacked\SMind.exe --remote-debugging-port=9222
 *      ⚠️ 用完请**手动关掉**这个进程（脚本只关自己的 ws 连接，不杀 App）：
 *        Get-Process SMind | Where-Object { $_.Path -like '*release\win-unpacked*' } | Stop-Process
 *   2) 跑本脚本：
 *        node scripts/verify/app-cdp.cjs
 *      可选环境变量：CDP_PORT（默认 9222）、COMPOSE_TEXT（默认 'dawadawdwa'）
 *
 * 判据（来自报告 §15.2 / §3）：
 *   · D-07：**先清空编辑区**再合成组词（不清空会把拼音接在原标题前面 → 假 FAIL，§15.3 踩过），
 *           组词期 `rows <= 1` 即通过；节点框在组词期不变（文字短暂溢出框外）是**已知代价**。
 *   · D-14：清空标题后量节点的 inline width / 实际框宽 / 编辑器宽度，当场判定根因属于
 *           甲（测量没吃到空内容）/ 乙（被 CSS 或最小尺寸撑开）/ 丙（编辑器内联宽度残留）。
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)
const COMPOSING = process.env.COMPOSE_TEXT ?? 'dawadawdwa'

/** 非中心主题的最小宽度；中心主题是 120（见 render/render/measure.ts 的 MIN_WIDTH / MIN_WIDTH_ROOT） */
const MIN_WIDTH = 76
const MIN_WIDTH_ROOT = 120

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page)
    throw new Error(
      `端口 ${PORT} 上没有 page target（App 起了吗？--remote-debugging-port 对得上吗？）`
    )

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
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (response.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 300))
    }
    return response.result?.result?.value
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        modifiers,
        key: k,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk
      })
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  return { send, evalJs, wait, key, close: () => ws.close() }
}

/** 双击中心主题进编辑态 */
async function enterEditing(cdp) {
  const box = await cdp.evalJs(`(() => {
    // 优先挑**非中心主题**：中心主题的最小宽度是 120px，与非中心的 76px 不是一回事，
    // 拿它去比 76px 会把正常读数误判成"甲"（本轮就误判过一次）
    const list = document.querySelectorAll('.topic')
    const el = list[1] ?? list[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  if (!box) throw new Error('页面上没有 .topic（文档没打开？）')
  console.log('  目标主题(静止):', JSON.stringify(box))
  const mouse = (type, clickCount) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount,
      buttons: type === 'mousePressed' ? 1 : 0
    })
  await mouse('mousePressed', 1)
  await mouse('mouseReleased', 1)
  await cdp.wait(80)
  await mouse('mousePressed', 2)
  await mouse('mouseReleased', 2)
  await cdp.wait(700)
  const picked = await cdp.evalJs(`(() => {
    const list = document.querySelectorAll('.topic')
    return { index: list[1] ? 2 : 1, total: list.length }
  })()`)
  console.log('  本次编辑的是第', picked.index, '个主题（共', picked.total, '个）')
  const inEditing = await cdp.evalJs(`!!document.querySelector('.rich-editor__content')`)
  if (!inEditing) throw new Error('没进编辑态（双击没生效）')
  return box
}

/** 清空编辑区：不清空的话组词文本会接在原标题前面，读数不可信（§15.3 的假 FAIL 就是这么来的） */
async function clearEditor(cdp) {
  await cdp.key('a', 'KeyA', 65, 2)
  await cdp.wait(120)
  await cdp.key('Backspace', 'Backspace', 8)
  await cdp.wait(250)
  const text = await cdp.evalJs(
    `(() => { const ed = document.querySelector('.rich-editor__content'); return ed ? JSON.stringify(ed.textContent) : null })()`
  )
  return text === '""'
}

/** 通用读数：节点框 / 编辑框 / 行数 / 文本所需宽度 */
const READ_EXPRESSION = (text) => `(() => {
  const ed = document.querySelector('.rich-editor__content')
  if (!ed) return { error: '没有 .rich-editor__content' }
  const node = document.querySelector('.topic.topic--editing') || document.querySelector('.topic')
  const cs = getComputedStyle(ed)
  const lineHeight = parseFloat(cs.lineHeight) || 0
  const probeEl = document.createElement('span')
  probeEl.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre;font:' + cs.font
  probeEl.textContent = ${JSON.stringify(text)}
  document.body.appendChild(probeEl)
  const textNeedsWidth = Math.ceil(probeEl.getBoundingClientRect().width)
  probeEl.remove()
  return {
    nodeInlineWidth: node ? node.style.width : null,
    nodeInlineMinWidth: node ? node.style.minWidth : null,
    nodeBoxWidth: node ? Math.round(node.getBoundingClientRect().width) : null,
    editorInlineWidth: ed.style.width,
    editorInlineFlex: ed.style.flex,
    editorInlineMaxWidth: ed.style.maxWidth,
    editorBoxWidth: Math.round(ed.getBoundingClientRect().width),
    textNeedsWidth,
    scrollHeight: ed.scrollHeight,
    lineHeight,
    rows: lineHeight > 0 ? Math.round(ed.scrollHeight / lineHeight) : null,
    text: ed.textContent
  }
})()`

async function caseD07(cdp) {
  console.log(
    `\n[场景 1] D-07 组词不折行（文本 ${JSON.stringify(COMPOSING)}，${COMPOSING.length} 字符）`
  )
  if (!(await clearEditor(cdp))) {
    console.log('  警告：编辑区没被清空，本次读数含原有文字，判定不可信')
  }
  await cdp.send('Input.imeSetComposition', {
    text: COMPOSING,
    selectionStart: COMPOSING.length,
    selectionEnd: COMPOSING.length
  })
  await cdp.wait(400)
  const probe = await cdp.evalJs(READ_EXPRESSION(COMPOSING))
  console.log('  组词中读数:', JSON.stringify(probe))
  const landed = typeof probe.text === 'string' && probe.text.includes(COMPOSING.slice(0, 4))
  if (!landed || typeof probe.rows !== 'number') {
    return { ok: false, note: '组词文本没落进编辑区或拿不到行数（不确定）' }
  }
  const ok = probe.rows <= 1
  return {
    ok,
    note: ok
      ? `PASS rows=1（编辑框 ${probe.editorBoxWidth}px，文本需 ${probe.textNeedsWidth}px，节点框 ${probe.nodeBoxWidth}px）`
      : `FAIL rows=${probe.rows}（编辑框 ${probe.editorBoxWidth}px，文本需 ${probe.textNeedsWidth}px）`
  }
}

async function caseD14(cdp) {
  console.log('\n[场景 2] D-14 探针：清空标题后节点框是否缩回')
  // 退出组词（Esc 会取消编辑，这里用 Shift+Enter? 不用：直接清空后量即可）
  await clearEditor(cdp)
  await cdp.wait(600) // 等测量与重排落定（清空会走一遍 editingText → 布局）
  const probe = await cdp.evalJs(READ_EXPRESSION(''))
  console.log('  清空后读数:', JSON.stringify(probe))
  const inline = Number.parseFloat(probe.nodeInlineWidth)
  // 期望值：非中心主题 76px、中心主题 120px（脚本已优先挑非中心主题）
  const expect = MIN_WIDTH
  let verdict
  if (!Number.isFinite(inline)) {
    verdict = '无法判定：节点没有 inline width（可能是中心主题或样式来源不同）'
  } else if (inline > expect + 6) {
    verdict = `甲：布局/测量没吃到空内容（inline width=${inline}px，期望 ${expect}px；中心主题期望 ${MIN_WIDTH_ROOT}px）`
  } else if ((probe.nodeBoxWidth ?? 0) > expect + 12) {
    verdict = `乙：被 CSS 或内联最小尺寸撑开（inline=${inline}px 但实际框 ${probe.nodeBoxWidth}px）`
  } else if (Number.parseFloat(probe.editorInlineWidth) > expect - 28 + 8) {
    verdict = `丙：编辑器内联宽度残留（inline=${inline}px 且编辑框 ${probe.editorInlineWidth}）`
  } else {
    verdict = `正常：节点框与编辑框都缩回了（inline=${inline}px）`
  }
  console.log('  → 判定:', verdict)
  return { ok: verdict.startsWith('正常'), note: verdict, probe }
}

async function main() {
  console.log(`CDP 端口 ${PORT}；组词文本 ${JSON.stringify(COMPOSING)}`)
  const cdp = await connect()
  const results = []
  try {
    await enterEditing(cdp)
    results.push({ name: 'D-07 组词不折行', ...(await caseD07(cdp)) })
    results.push({ name: 'D-14 清空不缩回探针', ...(await caseD14(cdp)) })
  } finally {
    cdp.close()
  }
  console.log('\n==== 汇总 ====')
  for (const item of results)
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  << ${item.note}`)
  const failed = results.filter((item) => !item.ok).length
  console.log(`SUMMARY pass=${results.length - failed} fail=${failed}`)
  console.log('提醒：本次用的那个 App 进程要自己关（脚本不杀进程）。')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERR', error && error.message ? error.message : String(error))
  console.log(
    '排查顺序：① App 起了吗、端口对吗；② 文档打开了吗；③ 脚本自己的测法（§15.3：红了先怀疑脚本）'
  )
  process.exit(2)
})
