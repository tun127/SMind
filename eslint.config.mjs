import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import unusedImports from 'eslint-plugin-unused-imports'

/**
 * ESLint 配置（flat config）。
 *
 * 取向：**只留真正能挡住 bug 的规则**，不用格式化规则堆噪音——
 * 格式交给 Prettier（见 .prettierrc），两者不互相打架。
 * 首次接入就开一堆风格规则，结果只会是"满屏告警、没人再看"。
 *
 * 注意 `react-hooks/exhaustive-deps`：仓库里有 3 处刻意的 eslint-disable
 * （布局 memo 依赖了非输入值，属于有意为之），保留 disable 注释即可。
 *
 * 用 `.mjs` 后缀而不是 `.js`：package.json 没有 `"type": "module"`，
 * 用 .js 会让 Node 每次都要"猜"一遍模块类型并打印警告。
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'release/**',
      'dist/**',
      '.tmp-check/**',
      // 自动生成：内联字体与样式表，体积巨大且无需检查
      'src/renderer/src/export/katex-assets.ts',
      'docs/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'unused-imports': unusedImports },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 类型由 TypeScript 负责，ESLint 再判一次只会误伤（DOM 全局都在类型里）
      'no-undef': 'off',
      // 正则里出现控制字符是**故意**的：清洗文件名/包内路径时要按 \x00-\x1f 过滤
      'no-control-regex': 'off',
      /**
       * 这三条是 react-hooks 附带的「React Compiler 规则」——不是 bug 检查，
       * 而是「你的写法能不能被静态推断」。本项目画布的**高频路径刻意不走 state**：
       * 原生 pointermove、拖拽中每帧改 transform、视口/选择的镜像 ref
       * （见 `Canvas.tsx` 的 `zoomRef.current = zoom` 一族），这是"指针跟手"的前提。
       *
       * 2026-09-18 实测（`npx eslint src --rule "react-hooks/refs:error" …`）共 **19 处**：
       *   refs 10        渲染期读写视口/选择镜像（Canvas 9）+ RichTextEditor 的 handlers 镜像（1）
       *   immutability 8 画布 `viewGestureAtRef.current += 1` 一族（5）+ 改 DOM style（1）
       *                  + 「变量在声明前被使用」（2，见右）
       *   purity 1       渲染期 `Date.now()` —— **已修**（Dialogs.tsx 改成"时间未知"）
       *
       * 那 2 处「声明前使用」经核查**语义正确、只是编译器证明不了**：
       * `App.tsx` 是 useCallback 自引用（注册它的 effect 依赖就是它本身，拿到的一直是当前那份），
       * `ChatPanel.tsx` 里被引用的 `setPending` 是普通局部函数（只写 ref 与稳定 setter）。
       * 它们没有被"顺手修掉"——为了 lint 绿灯去动窗口关闭 / AI 回合流程才是真的风险。
       *
       * 要开这三条（也是开 React Compiler 的前置）时的做法，按性价比排序：
       * ① 视口镜像改成「在写入点就近写 ref」（`setZoom`/`setPan` 里同步写）→ 命中能降到个位数；
       * ② 高频状态搬进外部 store + `useSyncExternalStore`，命令式 DOM 写入规范化。
       * 那是"把画布状态模型搬一次家"的独立任务，见 `docs/known-issues.md` 的遗留表。
       */
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      // 这条价值有限但误报在 try/catch 兜底里很常见（初始值就是兜底默认值），先关
      'no-useless-assignment': 'off',
      // 在 effect 里同步 setState 确实不够优雅，但存量有 4 处且都能跑，先当提醒
      'react-hooks/set-state-in-effect': 'warn',
      // 未使用的导入与变量：交给可**自动修复**的插件（`npm run lint:fix` 一键清掉），
      // 允许下划线开头的占位参数（事件回调里常见）
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  },
  {
    // 构建脚本是 Node 环境（.cjs 就是 CommonJS，require 在这里是正当写法）
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)
