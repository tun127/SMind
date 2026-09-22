/* global WebSocket */
/**
 * 清空卡顿的时序探针（长期资产，与 app-cdp.cjs 并列在 scripts/verify/）。
 *
 * 目的：真键盘复测反馈「全选删空后要顿一下才缩回期望大小，不超过 1s、不丝滑」。
 * 逐帧量两段：
 *   阶段 1（基线）：逐字输入 8 个字 —— 每次只小幅变尺寸；
 *   阶段 2（清空）：Ctrl+A + Backspace 一次删空 —— 尺寸变化很大。
 * 记录每帧的 t / 节点 inline width / 实际框宽高 / __layoutDiag.editingWidth / 文本长度，
 * 另收 longtask（>50ms）。哪段最长帧明显更大，卡就在"大尺寸变化"那一路。
 *
 * 用法：
 *   1) 起隔离实例：Start-Process 'D:\Mind\SMind\SMind.exe' -ArgumentList '--remote-debugging-port=9222', ("--user-data-dir=" + (Join-Path $env:TEMP 'smind-probe-ud'))
 *   2) node .tmp-check/jank-clear.cjs
 *   3) 用完关掉带 smind-probe-ud 的 SMind.exe
 *
 * 两条防坑（第一版就是栽在这两个上，实测确认）：
 *   · 窗口没获得焦点时 rAF **完全不跑** → 先开 CDP 的焦点模拟并 bringToFront，再自检"3 帧内有没有回帧"；
 *   · 焦点不在编辑区时键事件空放（app-cdp 的注释里已记过）→ 输入前先**真鼠标点一下编辑区内部**，
 *     并在每一步后**读文本长度核对**，不核对就会拿到"没变的宽度"这种假读数。
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)
const LONG_TEXT = process.env.LONG_TEXT ?? '这是一段用来把节点框撑宽的测试文字'

const INSTRUMENT = `(() => {
  if (window.__jank) window.__jank.stop = true
  const jank = { frames: [], longtasks: [], stop: false }
  window.__jank = jank
  const nodeOf = () => document.querySelector('.topic.topic--editing') || document.querySelector('.topic')
  const textLen = () => {
    const ed = document.querySelector('.rich-editor__content')
    return ed ? (ed.textContent ?? '').length : null
  }
  const sample = () => {
    const n = nodeOf()
    const r = n ? n.getBoundingClientRect() : null
    jank.frames.push({
      t: Math.round(performance.now()),
      w: n ? n.style.width : null,
      bw: r ? Math.round(r.width) : null,
      bh: r ? Math.round(r.height) : null,
      diag: window.__layoutDiag ? (window.__layoutDiag.editingWidth ?? null) : null,
      len: textLen()
    })
    if (!jank.stop) requestAnimationFrame(sample)
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        jank.longtasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) })
    }).observe({ entryTypes: ['longtask'] })
  } catch (error) {
    jank.longtaskError = String(error && error.message)
  }
  requestAnimationFrame(sample)
  return true
})()`

const TEXT_LEN = `(() => { const ed = document.querySelector('.rich-editor__content'); return ed ? (ed.textContent ?? '').length : -1 })()`
const HAS_TOPIC = `document.querySelectorAll('.topic').length`
const NODE_WIDTH = `(() => { const n = document.querySelector('.topic.topic--editing'); return n ? n.style.width : null })()`

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error(`端口 ${PORT} 上没有 page target（App 起了吗？）`)
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
    if (response.result?.exceptionDetails)
      throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 300))
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

/** rAF 自检：500ms 内回不到 3 帧就说明窗口没在绘制，读数会全部失效 */
async function rafSelfTest(cdp) {
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  } catch {
    /* 老版本 CDP 没有这个方法，不影响后面 */
  }
  try {
    await cdp.send('Page.bringToFront')
  } catch {
    /* 忽略 */
  }
  await cdp.wait(200)
  const frames = await cdp.evalJs(`new Promise((resolve) => {
    let n = 0
    const t0 = performance.now()
    const step = () => {
      n += 1
      if (n >= 3) return resolve({ frames: n, ms: Math.round(performance.now() - t0) })
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
    setTimeout(() => resolve({ frames: n, ms: Math.round(performance.now() - t0), timeout: true }), 500)
  })`)
  const state = await cdp.evalJs(
    `({ hidden: document.hidden, visibility: document.visibilityState, hasFocus: document.hasFocus() })`
  )
  return { ...frames, ...state }
}

async function ensureDocument(cdp) {
  let n = await cdp.evalJs(HAS_TOPIC)
  if (n > 0) return n
  await cdp.key('n', 'KeyN', 78, 2)
  await cdp.wait(1200)
  n = await cdp.evalJs(HAS_TOPIC)
  if (n === 0) throw new Error('页面上没有 .topic，且 Ctrl+N 也没新建出文档')
  return n
}

async function enterEditing(cdp) {
  const box = await cdp.evalJs(`(() => {
    const list = document.querySelectorAll('.topic')
    const el = list[1] ?? list[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  if (!box) throw new Error('没有可编辑的 .topic')
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
  if (!(await cdp.evalJs(`!!document.querySelector('.rich-editor__content')`)))
    throw new Error('没进编辑态（双击没生效）')
  return box
}

/** 真鼠标点进编辑区内部：键事件空放就是焦点不在里面 */
async function focusEditor(cdp) {
  const box = await cdp.evalJs(`(() => {
    const ed = document.querySelector('.rich-editor__content')
    if (!ed) return null
    const r = ed.getBoundingClientRect()
    return { x: Math.round(r.left + Math.max(6, r.width / 2)), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!box) throw new Error('编辑区不在')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0
    })
  }
  await cdp.wait(120)
}

/** 清空编辑区，并**核对**真的空了 */
async function clearText(cdp) {
  await focusEditor(cdp)
  await cdp.key('a', 'KeyA', 65, 2)
  await cdp.wait(120)
  await cdp.key('Backspace', 'Backspace', 8)
  await cdp.wait(150)
  return cdp.evalJs(TEXT_LEN)
}

function summarize(label, frames, longtasks) {
  if (!frames || frames.length === 0) return `${label}：没有采到帧`
  const gaps = []
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i].t - frames[i - 1].t)
  const maxGap = Math.max(...gaps)
  const avgGap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
  const w0 = frames[0].w
  const changeIdx = frames.findIndex((f) => f.w !== w0)
  const change = changeIdx > 0 ? frames[changeIdx] : null
  const lt = longtasks ?? []
  const maxLt = lt.length > 0 ? Math.max(...lt.map((x) => x.d)) : 0
  // 变化点前后各取几帧：用来判断「缩回是当帧完成，还是顿了几帧」
  const from = Math.max(0, changeIdx - 5)
  const around =
    changeIdx > 0
      ? frames
          .slice(from, changeIdx + 3)
          .map((f, i) => {
            const idx = from + i
            return `          #${idx}  +${f.t - frames[0].t}ms  w=${f.w}  len=${f.len}`
          })
          .join('\n')
      : '          （整段无变化点）'
  return [
    `${label}：帧数=${frames.length}  最长帧=${maxGap}ms  平均帧=${avgGap}ms  长任务=${lt.length} 个（最长 ${maxLt}ms）`,
    change
      ? `         尺寸变化在第 ${changeIdx} 帧（距上一帧 ${change.t - frames[changeIdx - 1].t}ms）：${w0} → ${change.w}`
      : `         整段宽度未变（始终 ${w0}）`,
    around
  ].join('\n')
}

async function main() {
  console.log(`CDP 端口 ${PORT}`)
  const cdp = await connect()
  try {
    const raf = await rafSelfTest(cdp)
    console.log(
      `环境自检：3 帧耗时 ${raf.ms}ms${raf.timeout ? '（超时）' : ''}｜document.hidden=${raf.hidden}｜hasFocus=${raf.hasFocus}`
    )
    if (raf.timeout || raf.frames < 3) {
      console.log('⚠️ 窗口没在绘制（rAF 不回帧）→ 逐帧读数会全部失效，先解决这个再跑')
      return
    }

    const topics = await ensureDocument(cdp)
    console.log(`文档里有 ${topics} 个主题`)
    await enterEditing(cdp)
    console.log('已进入编辑态')

    const cleared0 = await clearText(cdp)
    console.log(`清空后文本长度 = ${cleared0}（应为 0）`)
    await cdp.send('Input.insertText', { text: LONG_TEXT })
    await cdp.wait(400)
    const len1 = await cdp.evalJs(TEXT_LEN)
    const wide = await cdp.evalJs(NODE_WIDTH)
    console.log(`填入 ${LONG_TEXT.length} 字后：文本长度 = ${len1}，节点宽 = ${wide}`)
    if (len1 !== LONG_TEXT.length) console.log('⚠️ 输入没完全落进编辑区，下面的读数只当参考')

    await cdp.evalJs(INSTRUMENT)

    await cdp.evalJs(`window.__jank.frames.length = 0; window.__jank.longtasks.length = 0`)
    for (let i = 0; i < 8; i += 1) {
      await cdp.send('Input.insertText', { text: '字' })
      await cdp.wait(90)
    }
    await cdp.wait(300)
    const base = await cdp.evalJs(
      `({ frames: window.__jank.frames.slice(), longtasks: window.__jank.longtasks.slice() })`
    )

    await cdp.evalJs(`window.__jank.frames.length = 0; window.__jank.longtasks.length = 0`)
    const cleared = await clearText(cdp)
    await cdp.wait(900)
    const after = await cdp.evalJs(
      `({ frames: window.__jank.frames.slice(), longtasks: window.__jank.longtasks.slice() })`
    )
    const finalW = await cdp.evalJs(NODE_WIDTH)

    console.log('\n==== 读数 ====')
    console.log(summarize('[打字基线 8 字]', base.frames, base.longtasks))
    console.log(summarize('[清空那一下]', after.frames, after.longtasks))
    console.log(`清空后最终：文本长度 ${cleared}，节点宽 ${finalW}`)
    const ltErr = await cdp.evalJs(`window.__jank.longtaskError ?? null`)
    if (ltErr) console.log(`（长任务观察不可用：${ltErr}）`)
  } finally {
    cdp.close()
  }
}

main().catch((error) => {
  console.error('ERR', error && error.message ? error.message : String(error))
  process.exit(2)
})
