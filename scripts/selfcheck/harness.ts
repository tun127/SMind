/**
 * 自检的**断言原语**（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
 *
 * 三件事：分组标题（group）、断言（check / eq，失败会带上实际值）、汇总计数。
 * 状态（passed / failures）留在这个模块里，退出码由调用方按 stats() 决定——
 * 这样按域拆出的各个 `selfcheck/*.ts` 只需要 import 这套原语。
 */

/** 算完所有断言后取一次汇总 */
export interface SelfcheckStats {
  passed: number
  failures: string[]
}

export function stats(): SelfcheckStats {
  return { passed, failures }
}

/* ------------------------------------------------------------------ */
/* 断言工具                                                            */
/* ------------------------------------------------------------------ */

let passed = 0
const failures: string[] = []
let currentGroup = ''

export function group(name: string): void {
  currentGroup = name
  console.log(`\n【${name}】`)
}

export function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${currentGroup} > ${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 深比较：对象键排序后比较，避免键顺序造成误判 */
export function normalize(value: unknown, indent = 0): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val === undefined) return undefined
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(val as Record<string, unknown>).sort()) {
          sorted[key] = (val as Record<string, unknown>)[key]
        }
        return sorted
      }
      return val
    },
    indent
  )
}

/** 逐行找出首个差异，方便定位「哪个字段丢了」 */
export function firstDiff(before: string, after: string): string {
  const linesA = before.split('\n')
  const linesB = after.split('\n')
  for (let i = 0; i < Math.max(linesA.length, linesB.length); i += 1) {
    if (linesA[i] !== linesB[i]) {
      return `首个差异在第 ${i + 1} 行\n      前: ${String(linesA[i]).trim()}\n      后: ${String(linesB[i]).trim()}`
    }
  }
  return '无差异'
}

export function eq(name: string, actual: unknown, expected: unknown): void {
  const same = normalize(actual) === normalize(expected)
  check(name, same, same ? '' : `实际=${normalize(actual)} 期望=${normalize(expected)}`)
}
