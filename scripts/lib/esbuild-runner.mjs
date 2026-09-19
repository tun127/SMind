/**
 * 脚本侧的「esbuild 打包 → node 执行」原语。
 *
 * 收敛依据：`docs/refactor-audit.md` §2.4 第 2 条 + `docs/decoupling-plan.md` §八 E1 行末段
 * （"三份 esbuild runner 合成一个"）。`run-selfcheck` / `run-license-tool` / `run-diag-freeze`
 * 原来各自抄了一遍同样的样板：推导 root → mkdirSync(.tmp-check) → `esbuild.build({...})`
 * → `spawnSync(process.execPath, [outFile, ...])`。
 *
 * 这里**只放原语**（怎么打包、怎么起子进程）。各脚本的**入口文件、别名集合、输出文件名、
 * 是否透传 argv、以及 diag-freeze 那种"打完包不立刻跑、自己逐块编排"**全部留在调用点。
 *
 * ## 受限沙箱下的两条路线
 *
 * esbuild 的 **JS API 会 spawn 一个服务进程、并且用管道 stdio**——本机审批策略为 never、
 * 不能提权，所以这条路在受限沙箱里必然 `EPERM`（`ensureServiceIsRunning`）。
 * 于是这里按"先原路、后回退"处理：
 *
 * 1. **JS API 优先**（默认）：在有 spawn 权限的环境里与改动前的三份 runner **逐字同路**
 *    （同一批 options 对象），行为不变；
 * 2. 失败（受限沙箱 EPERM 等）时**自动回退到 esbuild CLI**：`node_modules/esbuild/bin/esbuild`
 *    的 shim 用 `stdio: 'inherit'` 起平台二进制（`@esbuild/win32-x64/esbuild.exe`），这条路在受限沙箱下可用。
 *    回退时的 CLI 参数与上面那批 options **一一对应**（对照表见提交信息）：
 *    `--bundle --platform=node --format=cjs --target=node20 --log-level=warning
 *     --tsconfig=<root>/tsconfig.json --alias:<名>=<路径>… [--sourcemap=<值>] --outfile=<产物>`。
 *
 * 需要强制走 CLI（例如两条路线做产物比对）时设 `SMIND_ESBUILD_CLI=1`。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

/** 打包产物统一落在这里（与三份 runner 原来的习惯一致） */
export const OUT_DIR = resolve(root, '.tmp-check')

/** CLI 回退用的入口：esbuild 自带的 CLI（会自己找到当前平台的二进制） */
const ESBUILD_CLI = resolve(root, 'node_modules', 'esbuild', 'bin', 'esbuild')

/** JS API 用到的选项（三份 runner 原来是同一套字面量，这里只把它写成一处） */
const BUILD_TARGET = 'node20'

function cliArgsFor(entry, outFile, { aliases, sourcemap, tsconfig }) {
  return [
    ESBUILD_CLI,
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--target=${BUILD_TARGET}`,
    '--log-level=warning',
    `--tsconfig=${tsconfig}`,
    ...Object.entries(aliases).map(([name, target]) => `--alias:${name}=${target}`),
    ...(sourcemap ? [`--sourcemap=${sourcemap}`] : []),
    `--outfile=${outFile}`
  ]
}

/**
 * 把一个 TS 入口打成 CJS，返回产物路径（`.tmp-check/<outName>`）。
 *
 * @param entry 入口 .ts 的**绝对路径**（各脚本自己决定，原样传入）
 * @param outName 产物文件名，例如 `selfcheck.cjs`
 * @param aliases 别名表，例如 `{ '@shared': …, '@': … }`（**各脚本自己决定集合**）
 * @param sourcemap 传给 esbuild 的 sourcemap 值（只有自检用 `'inline'`）
 */
export async function bundleTs(entry, { outName, aliases = {}, sourcemap = false } = {}) {
  const tsconfig = resolve(root, 'tsconfig.json')
  const outFile = resolve(OUT_DIR, outName)
  mkdirSync(OUT_DIR, { recursive: true })

  const forceCli = (process.env.SMIND_ESBUILD_CLI ?? '') !== ''
  if (!forceCli) {
    try {
      await esbuild.build({
        entryPoints: [entry],
        outfile: outFile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: BUILD_TARGET,
        logLevel: 'warning',
        tsconfig,
        alias: aliases,
        ...(sourcemap ? { sourcemap } : {})
      })
      return outFile
    } catch (error) {
      // 受限沙箱：JS API 起服务进程要管道 stdio → EPERM（审批 never、不能提权）。
      // 这不是脚本的错，回退到 CLI（stdio:'inherit'）即可；两条路线的产物逐字节相同，
      // 等价实测见提交信息与 `.tmp-check/` 里的日志。
      try {
        esbuild.stop()
      } catch {
        /* 停不掉也无所谓：下面不再用 JS API */
      }
      console.error(
        `[esbuild-runner] JS API 打包失败（受限沙箱常见：EPERM），改用 CLI 路线：${String(error).split('\n')[0]}`
      )
    }
  }

  const result = spawnSync(
    process.execPath,
    cliArgsFor(entry, outFile, { aliases, sourcemap, tsconfig }),
    {
      stdio: 'inherit'
    }
  )
  if (result.status !== 0) {
    throw new Error(`esbuild CLI 打包失败（退出码 ${result.status ?? 1}）：${entry}`)
  }
  return outFile
}

/**
 * 用 node 跑一个已打好的 `.cjs`。
 *
 * 默认 `stdio: 'inherit'`（三份 runner 原来起主进程时都是这个姿势），
 * 需要"捕获子进程输出 / 加超时 / 注入 env"时用 `options` 覆盖——语义与 `spawnSync` 完全一致，
 * 返回值就是 `spawnSync` 的结果对象，所以调用点照旧写 `process.exit(result.status ?? 1)`。
 */
export function runNode(outFile, args = [], options = {}) {
  return spawnSync(process.execPath, [outFile, ...args], { stdio: 'inherit', ...options })
}
