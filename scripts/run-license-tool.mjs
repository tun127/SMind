/**
 * 跑许可签发工具：与自检同一套做法（esbuild 打包 TS 再交给 Node），
 * 这样签发脚本能直接复用 `src/shared/license.ts` 的格式定义——
 * 签发与验签共用一份实现，才不会出现"签的时候一种、验的时候另一种"。
 *
 * 打包与执行的原语在 `scripts/lib/esbuild-runner.mjs`；本脚本只留自己的策略：
 * 入口 `scripts/license-tool.ts`、产物 `.tmp-check/license-tool.cjs`、
 * 别名 `@shared` + `@`、**透传 argv**（无 sourcemap）。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleTs, runNode } from './lib/esbuild-runner.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const outFile = await bundleTs(resolve(here, 'license-tool.ts'), {
  outName: 'license-tool.cjs',
  aliases: {
    '@shared': resolve(root, 'src/shared'),
    '@': resolve(root, 'src/renderer/src')
  }
})

// 透传参数：keygen / issue --to 名字 …
const result = runNode(outFile, process.argv.slice(2))
process.exit(result.status ?? 1)
