/* global WebSocket */
/**
 * D-07 验收（报告 §22 的四组数字）—— v2。
 *
 * v1 的测法缺陷（跑出来 text 一直是"分支主题 1"）：只双击进编辑态就跑
 * `Input.dispatchKeyEvent` / `Input.insertText`，**没有确保焦点落在编辑区** ——
 * 键事件发给的是当前焦点元素，焦点不对时清空与打字都无效，读出的四组数字自然都一样。
 * v2 补两件事：① 进编辑态后显式 `focus()` 编辑区；② 每次清空后**校验文本真的为空**，
 * 否则直接报"测法不可信"并退出 2（而不是给出一个看起来像 FAIL 的结论）。
 *
 * 用法：先起打包版 App（带调试端口），再 node scripts/verify/d07-accept.cjs
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)
const ASCII = process.env.ASCII_TEXT ?? 'dddddddddddddddddddd' // 20 个字符，无空格

const readExpr = `(() => {
  const list = document.querySelectorAll('.topic')
  const el = list[1] ?? list[0]
  if (!el) return null
  const ed = document.querySelector('.rich-editor__content')
  const cs = ed ? getComputedStyle(ed) : null
  const lineHeight = cs ? parseFloat(cs.lineHeight) || 0 : 0
  return {
    inlineWidth: el.style.width,
    boxWidth: Math.round(el.getBoundingClientRect().width),
    focused: ed ? document.activeElement === ed : null,
    rows: ed && lineHeight > 0 ? Math.round(ed.scrollHeight / lineHeight) : null,
    text: ed ? ed.textContent : null
  }
})()`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error(`端口 ${PORT} 上没有 page target`)
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

  /* ① 进编辑态：双击**非中心主题**（中心主题最小宽度是 120px，判据不同） */
  const box = await evalJs(`(() => {
    const list = document.querySelectorAll('.topic')
    const el = list[1] ?? list[0]
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  const mouse = (type, clickCount) =>
    send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount,
      buttons: type === 'mousePressed' ? 1 : 0
    })
  await mouse('mousePressed', 1)
  await mouse('mouseReleased', 1)
  await wait(80)
  await mouse('mousePressed', 2)
  await mouse('mouseReleased', 2)
  await wait(800)

  /* ② v2 的关键补丁：把焦点显式放进编辑区，否则后面的键事件全是空放 */
  const focused = await evalJs(`(() => {
    const ed = document.querySelector('.rich-editor__content')
    if (!ed) return false
    ed.focus()
    return document.activeElement === ed
  })()`)
  console.log('焦点已在编辑区:', focused)
  if (!focused) {
    console.log('无法进入编辑态/拿到焦点 → 测法不可信，本次不给出结论')
    process.exit(2)
  }

  const clear = async () => {
    await key('a', 'KeyA', 65, 2)
    await wait(150)
    await key('Backspace', 'Backspace', 8)
    await wait(500)
    const state = await evalJs(readExpr)
    return state
  }

  const w0 = await clear()
  console.log('W0 空标题     :', JSON.stringify(w0))
  if (w0?.text !== '') {
    console.log('编辑区没被清空 → 测法不可信，本次不给出结论（§15.3：红了先怀疑脚本）')
    process.exit(2)
  }

  await send('Input.insertText', { text: ASCII })
  await wait(700)
  const w1 = await evalJs(readExpr)
  console.log(`W1 打满 ${ASCII.length} 字符:`, JSON.stringify(w1))

  const w2 = await clear()
  console.log('W2 再次清空   :', JSON.stringify(w2))

  await key('Enter', 'Enter', 13)
  await wait(800)
  const w3 = await evalJs(readExpr)
  console.log('W3 Enter 提交 :', JSON.stringify(w3))

  const num = (value) => Number.parseFloat(String(value ?? '').replace('px', ''))
  const results = [
    {
      name: '② 打字后框变宽（W1 > W0 + 60px）',
      ok: num(w1?.inlineWidth) > num(w0?.inlineWidth) + 60,
      note: `${w0?.inlineWidth} → ${w1?.inlineWidth}`
    },
    {
      name: '③ 清空后缩回（W2 ≈ W0）',
      ok: Math.abs(num(w2?.inlineWidth) - num(w0?.inlineWidth)) <= 2,
      note: `${w0?.inlineWidth} vs ${w2?.inlineWidth}`
    },
    {
      name: '④ 提交后不跳（W3 ≈ W2）',
      ok: Math.abs(num(w3?.inlineWidth) - num(w2?.inlineWidth)) <= 2,
      note: `${w2?.inlineWidth} vs ${w3?.inlineWidth}`
    }
  ]
  console.log('\n==== 判定 ====')
  for (const item of results)
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  << ${item.note}`)
  const failed = results.filter((item) => !item.ok).length
  console.log(`SUMMARY pass=${results.length - failed} fail=${failed}`)
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERR', error && error.message ? error.message : String(error))
  process.exit(2)
})
