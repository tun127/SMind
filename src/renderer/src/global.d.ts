import type { MindApi } from '@shared/ipc'

declare global {
  interface Window {
    api: MindApi
  }
}

export {}
