/**
 * 用 esbuild 把自检脚本连同项目源码打成 CJS 再交给 Node 执行，
 * 这样可以直接复用渲染层的别名与 TypeScript 写法。
 *
 * 打包与执行的原语在 `scripts/lib/esbuild-runner.mjs`（三份 runner 共用）；
 * 本脚本只留自己的策略：入口 `scripts/selfcheck.ts`、产物 `.tmp-check/selfcheck.cjs`、
 * 别名 `@shared` + `@`、带 `sourcemap: 'inline'`。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleTs, runNode } from './lib/esbuild-runner.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const outFile = await bundleTs(resolve(here, 'selfcheck.ts'), {
  outName: 'selfcheck.cjs',
  aliases: {
    '@shared': resolve(root, 'src/shared'),
    '@': resolve(root, 'src/renderer/src')
  },
  sourcemap: 'inline'
})

const result = runNode(outFile)
process.exit(result.status ?? 1)
