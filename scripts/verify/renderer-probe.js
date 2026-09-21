/* global document, window, CompositionEvent */
/**
 * 渲染侧验证：真窗口里跑 DOM/CSS 断言（**不依赖整个 App**）。
 *
 * 这一段专门回答一个已经被证明"靠读代码会看错"的问题（报告 D-07）：
 * `.rich-editor__content` 是 `.topic__editor` 的 flex 子项、自身 `min-width: 0`，
 * 所以**只放开 max-width 是没用的** —— 宽度会被 flex-shrink 压回节点内宽，
 * 拼音照样在窄宽度上折行（515aac2 的 A3 就是这么无效的）。
 *
 * 做法：用**真实 CSS**（直接读 src/renderer/src/styles/09-section.css）搭出
 * `.topic > .topic__editor > .rich-editor__content` 结构，分别量两种写法的实际宽度：
 *   ① 复刻 A3：只设 maxWidth + width        → 期望"被压回"（证明 A3 无效）
 *   ② 复刻 D-07：再设 flex: 0 0 auto        → 期望"宽度真的生效"（证明修法有效）
 * 另外把 D-14 的甲/乙/丙探针**代码化**成 `window.__probeD14()`，不必再靠人手往
 * DevTools 里粘（在真 App 的控制台里 `__probeD14()` 也能直接用，见 README 说明）。
 *
 * 注意边界（别把它当整机验收）：这里验证的是 **CSS × DOM 的约束机制**；
 * 真正"输入法连打 8 个音节不折行"仍需在 App 里用真实输入法跑一次。
 */
;(() => {
  const results = []
  const record = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' })

  // 清场并搭出与 TopicNode 一致的三层结构
  document.body.innerHTML = ''
  const topic = document.createElement('div')
  topic.className = 'topic'
  topic.style.width = '120px' // 模拟布局给出的节点宽度（非中心主题的最小宽度就是 76～120 之间）
  const editor = document.createElement('div')
  editor.className = 'topic__editor'
  const content = document.createElement('div')
  content.className = 'rich-editor__content'
  content.textContent = 'dawadawdwa dawadawdwa dawadawdwa'
  editor.appendChild(content)
  topic.appendChild(editor)
  document.body.appendChild(topic)

  const widthOf = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)

  // ① 复刻 A3：只放开 max-width
  content.style.maxWidth = 'none'
  content.style.width = '600px'
  const a3Width = widthOf(content)
  record(
    'A3 复刻：只放开 maxWidth → 宽度被 flex-shrink 压回节点内宽',
    a3Width !== null && a3Width <= 130,
    `实际=${a3Width}px（期望 ≤130px，即被压回）`
  )

  // ② 复刻 D-07：同时解除 flex 收缩
  content.style.flex = '0 0 auto'
  const fixedWidth = widthOf(content)
  record(
    'D-07 复刻：flex: 0 0 auto → 宽度真的生效',
    fixedWidth !== null && fixedWidth > 500,
    `实际=${fixedWidth}px（期望 >500px）`
  )

  // ③ 组词事件管线：合成 composition 事件必须能到达编辑区（宽度由组件决定，这里只验管线）
  let seen = []
  content.addEventListener('compositionupdate', (event) => seen.push(event.data), true)
  content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  content.dispatchEvent(
    new CompositionEvent('compositionupdate', { bubbles: true, data: 'dawadawdwa' })
  )
  content.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true, data: 'dawadawdwa' })
  )
  record(
    '合成 composition 事件能到达编辑区（管线可用）',
    seen.length === 1 && seen[0] === 'dawadawdwa',
    JSON.stringify(seen)
  )

  // ④ D-14 探针：代码化，甲/乙/丙三类的判据与报告 §3 一致
  window.__probeD14 = () => {
    const box = document.querySelector('.topic.topic--editing, .topic')
    const ed = box && box.querySelector('.rich-editor__content')
    const rect = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)
    return {
      nodeInlineWidth: box ? box.style.width : null,
      nodeBoxWidth: rect(box),
      nodeInlineMinWidth: box ? box.style.minWidth : null,
      editorInlineWidth: ed ? ed.style.width : null,
      editorInlineMaxWidth: ed ? ed.style.maxWidth : null,
      editorInlineFlex: ed ? ed.style.flex : null,
      editorBoxWidth: rect(ed),
      editorText: ed ? JSON.stringify(ed.textContent) : null
    }
  }
  const probe = window.__probeD14()
  record(
    'D-14 探针可执行（返回甲/乙/丙判据所需的全部读数）',
    probe && typeof probe.editorBoxWidth === 'number',
    JSON.stringify(probe)
  )

  return { results, failures: results.filter((item) => !item.ok) }
})()
