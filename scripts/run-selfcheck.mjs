/**
 * 用 esbuild 把自检脚本连同项目源码打成 CJS 再交给 Node 执行，
 * 这样可以直接复用渲染层的别名与 TypeScript 写法。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, '.tmp-check')
const outFile = resolve(outDir, 'selfcheck.cjs')

mkdirSync(outDir, { recursive: true })

await esbuild.build({
  entryPoints: [resolve(here, 'selfcheck.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
  tsconfig: resolve(root, 'tsconfig.json'),
  alias: {
    '@shared': resolve(root, 'src/shared'),
    '@': resolve(root, 'src/renderer/src')
  }
})

const result = spawnSync(process.execPath, [outFile], { stdio: 'inherit' })
process.exit(result.status ?? 1)
