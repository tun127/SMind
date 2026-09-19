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

/**
 * 思维导图文件的扩展名（**不带点**，小写）——这是唯一来源。
 *
 * E1 收敛：以前同一份「xmind / emmx / emm」在四处各写一遍——打开对话框的过滤器
 * （`main/ipc/document.ts`）、拖拽判定（`app/use-file-drop.ts`）、聊天面板两次附件判定
 * （`components/ChatPanel.tsx`）——新增一种格式时漏改一处就会"某种入口不认这个文件"。
 */
export const MINDMAP_EXTENSIONS = ['xmind', 'emmx', 'emm'] as const

/** 判定「这是不是一个思维导图文件」。带 `i`，文件名大小写不敏感；共享带 `g` 的正则有 lastIndex 陷阱，这里刻意不带 */
export const MINDMAP_FILE_RE = /\.(xmind|emmx|emm)$/i

/**
 * 带点的小写后缀（`pickDocumentArg` 用 `endsWith` 判定，所以要带点）——由上面那份清单派生。
 *
 * 名字**不叫** `DOCUMENT_EXTENSIONS`：`main/document.ts` 里曾有一个同名导出，那是**另一件事**
 * （可读取/导入的 docx/xlsx/md… 清单），两者只是撞名、语义完全不同（E1 尾巴，仅改名 + 派生）。
 */
export const MINDMAP_SUFFIXES = MINDMAP_EXTENSIONS.map((ext) => `.${ext}`)

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
    if (!MINDMAP_SUFFIXES.some((ext) => lower.endsWith(ext))) continue
    if (!exists(arg)) continue
    return arg
  }
  return null
}
