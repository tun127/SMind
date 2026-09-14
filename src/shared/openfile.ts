/**
 * 「从文件管理器打开」的入口判定。
 *
 * 双击 `.xmind`、把文件拖到 exe 上、右键「打开方式 → SMind」，最终都是同一件事：
 * **系统把文件路径塞进命令行**。主进程要做的就是从 `process.argv` 里把那个路径认出来。
 *
 * 为什么要这么小心地过滤：
 * - 打包后 `argv[0]` 是 exe 自己（扩展名 `.exe`，天然不匹配），
 * - 开发模式下 `argv` 里还会有工程目录、`--inspect` 之类的参数，
 * - Electron 自己也可能加 `--allow-file-access-from-files` 这类开关。
 *
 * 所以规则只有一条：**从后往前找第一个"扩展名是我们的格式、且文件真的存在"的参数**，
 * 以 `-` 开头的开关一律跳过。这样上面那些噪音都自然被过滤掉。
 */

/** 能被本软件直接打开的文档扩展名（.emmx/.emm 是亿图脑图） */
export const DOCUMENT_EXTENSIONS = ['.xmind', '.emmx', '.emm'] as const

/**
 * 从命令行参数里挑出要打开的文档路径。
 *
 * `exists` 由调用方注入（主进程传 `existsSync`）：
 * 这样这个模块就是**纯函数**，渲染进程也能安全地引它，自检里更好造用例。
 */
export function pickDocumentArg(
  argv: readonly string[],
  exists: (path: string) => boolean
): string | null {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const arg = argv[index]
    if (!arg || arg.startsWith('-')) continue
    const lower = arg.toLowerCase()
    if (!DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
    if (!exists(arg)) continue
    return arg
  }
  return null
}
