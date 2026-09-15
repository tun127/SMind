/**
 * 跑许可签发工具：与自检同一套做法（esbuild 打包 TS 再交给 Node），
 * 这样签发脚本能直接复用 `src/shared/license.ts` 的格式定义——
 * 签发与验签共用一份实现，才不会出现"签的时候一种、验的时候另一种"。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, '.tmp-check')
const outFile = resolve(outDir, 'license-tool.cjs')

mkdirSync(outDir, { recursive: true })

await esbuild.build({
  entryPoints: [resolve(here, 'license-tool.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  tsconfig: resolve(root, 'tsconfig.json'),
  alias: {
    '@shared': resolve(root, 'src/shared'),
    '@': resolve(root, 'src/renderer/src')
  }
})

// 透传参数：keygen / issue --to 名字 …
const result = spawnSync(process.execPath, [outFile, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
