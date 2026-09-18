/**
 * 标记图标的矢量数据。
 *
 * ⚠️ **自动生成，不要手改**：`npm run marker-art`（脚本见 `scripts/make-marker-art.mjs`）。
 * 数据来自 lucide-react（ISC 许可，见 THIRD-PARTY-NOTICES），
 * 去掉了一切与坐标无关的属性——默认绘制方式就是"只描边、圆头、不填充"，
 * 与画布上 `MarkerIcon` 的 `strokeWidth` 一致（见 MARKER_STROKE_WIDTH）。
 */

/** 一块图元：坐标都在 24×24 的视图盒里 */
export type IconShape =
  | { k: 'path'; d: string }
  | { k: 'circle'; cx: number; cy: number; r: number }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { k: 'polyline'; points: string }
  | { k: 'polygon'; points: string }
  | { k: 'rect'; x: number; y: number; w: number; h: number; rx?: number }

/** 所有图标共用的视图盒边长 */
export const ICON_VIEWBOX = 24

/**
 * 与画布 `MarkerIcon` 的 `strokeWidth` 保持一致的线宽。
 * 两者不一致的话，导出的图标会比屏幕上的粗/细一圈。
 */
export const MARKER_STROKE_WIDTH = 2.2

/**
 * 图形名 → 图元列表。
 *
 * 键与 `render/markers.ts` 的 `MarkerGlyph` 一一对应；
 * 自检里有一条断言逐个核对"每个图形都有数据"，漏一个会当场失败。
 */
export const ICON_ART: Record<string, readonly IconShape[]> = {
  star: [
    {
      k: 'path',
      d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z'
    }
  ],
  flag: [
    {
      k: 'path',
      d: 'M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528'
    }
  ],
  smile: [
    {
      k: 'path',
      d: 'M15 10V9'
    },
    {
      k: 'path',
      d: 'M16.472 15a6 6 0 01-8.943 0'
    },
    {
      k: 'path',
      d: 'M9 10V9'
    },
    {
      k: 'circle',
      cx: 12,
      cy: 12,
      r: 10
    }
  ],
  laugh: [
    {
      k: 'path',
      d: 'M15 10V9'
    },
    {
      k: 'path',
      d: 'M7.084 14.302a5.12 5.12 0 009.833 0 .24.24 0 00-.235-.302H7.32a.24.24 0 00-.235.302'
    },
    {
      k: 'path',
      d: 'M9 10V9'
    },
    {
      k: 'circle',
      cx: 12,
      cy: 12,
      r: 10
    }
  ],
  angry: [
    {
      k: 'path',
      d: 'M15 12v-1.584'
    },
    {
      k: 'path',
      d: 'M17 10a5 5 0 00-3 1'
    },
    {
      k: 'path',
      d: 'M7 10a5 5 0 013 1'
    },
    {
      k: 'path',
      d: 'M9 12v-1.584'
    },
    {
      k: 'path',
      d: 'M9 17a5 5 0 016.001 0'
    },
    {
      k: 'circle',
      cx: 12,
      cy: 12,
      r: 10
    }
  ],
  frown: [
    {
      k: 'path',
      d: 'M15 10V9'
    },
    {
      k: 'path',
      d: 'M9 10V9'
    },
    {
      k: 'path',
      d: 'M9 16a5 5 0 016 0'
    },
    {
      k: 'circle',
      cx: 12,
      cy: 12,
      r: 10
    }
  ],
  plus: [
    {
      k: 'path',
      d: 'M5 12h14'
    },
    {
      k: 'path',
      d: 'M12 5v14'
    }
  ],
  minus: [
    {
      k: 'path',
      d: 'M5 12h14'
    }
  ],
  question: [
    {
      k: 'circle',
      cx: 12,
      cy: 12,
      r: 10
    },
    {
      k: 'path',
      d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'
    },
    {
      k: 'path',
      d: 'M12 17h.01'
    }
  ],
  exclam: [
    {
      k: 'path',
      d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'
    },
    {
      k: 'path',
      d: 'M12 9v4'
    },
    {
      k: 'path',
      d: 'M12 17h.01'
    }
  ],
  'arrow-up': [
    {
      k: 'path',
      d: 'm5 12 7-7 7 7'
    },
    {
      k: 'path',
      d: 'M12 19V5'
    }
  ],
  'arrow-down': [
    {
      k: 'path',
      d: 'M12 5v14'
    },
    {
      k: 'path',
      d: 'm19 12-7 7-7-7'
    }
  ],
  people: [
    {
      k: 'path',
      d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'
    },
    {
      k: 'path',
      d: 'M16 3.128a4 4 0 0 1 0 7.744'
    },
    {
      k: 'path',
      d: 'M22 21v-2a4 4 0 0 0-3-3.87'
    },
    {
      k: 'circle',
      cx: 9,
      cy: 7,
      r: 4
    }
  ],
  'light-bulb': [
    {
      k: 'path',
      d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5'
    },
    {
      k: 'path',
      d: 'M9 18h6'
    },
    {
      k: 'path',
      d: 'M10 22h4'
    }
  ],
  crown: [
    {
      k: 'path',
      d: 'M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z'
    },
    {
      k: 'path',
      d: 'M5 21h14'
    }
  ],
  finance: [
    {
      k: 'circle',
      cx: 12,
      cy: 12,
      r: 10
    },
    {
      k: 'path',
      d: 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8'
    },
    {
      k: 'path',
      d: 'M12 18V6'
    }
  ],
  award: [
    {
      k: 'path',
      d: 'm15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526'
    },
    {
      k: 'circle',
      cx: 12,
      cy: 8,
      r: 6
    }
  ]
}
