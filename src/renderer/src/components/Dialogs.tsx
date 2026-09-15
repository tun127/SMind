import { useRef, type ReactElement, type ReactNode } from 'react'
import { AlertTriangle, HardDriveDownload } from 'lucide-react'
import type { RecoveryInfo } from '@shared/ipc'

interface ModalProps {
  title: string
  icon?: ReactNode
  children: ReactNode
  footer: ReactNode
  onMaskClick?: () => void
}

export function Modal({ title, icon, children, footer, onMaskClick }: ModalProps): ReactElement {
  /**
   * 只有「按下与松开**都**落在遮罩上」才算点了遮罩。
   *
   * 单用 onClick 会误判：用户按在弹窗内部、把鼠标划到外面才松开时，浏览器仍会
   * 往共同祖先（遮罩）冒泡一个 click —— 表现出来就是「鼠标只是划出去，弹窗就没了」
   * （AI 设置里试连接时尤其容易划过界，真被投诉过）。
   */
  const pressedOnMask = useRef(false)
  return (
    <div
      className="modal-mask"
      onMouseDown={(event) => {
        pressedOnMask.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || !pressedOnMask.current) return
        pressedOnMask.current = false
        onMaskClick?.()
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          {icon && <span className="modal__icon">{icon}</span>}
          <span className="modal__title">{title}</span>
        </div>
        <div className="modal__body">{children}</div>
        <div className="modal__footer">{footer}</div>
      </div>
    </div>
  )
}

interface RecoveryDialogProps {
  info: RecoveryInfo
  onRestore(): void
  onDiscard(): void
}

export function RecoveryDialog({ info, onRestore, onDiscard }: RecoveryDialogProps): ReactElement {
  const time = new Date(info.savedAt || Date.now()).toLocaleString('zh-CN')
  return (
    <Modal
      title="发现未保存的内容"
      icon={<HardDriveDownload size={18} />}
      footer={
        <>
          <button type="button" className="btn" onClick={onDiscard}>
            忽略并删除
          </button>
          <button type="button" className="btn btn--primary" onClick={onRestore}>
            恢复
          </button>
        </>
      }
    >
      <p>
        上次退出时《{info.title}》还有未保存的修改（{time}）。
      </p>
      <p className="modal__dim">是否恢复到编辑器中？</p>
    </Modal>
  )
}

interface UnsavedDialogProps {
  fileName: string
  onSave(): void
  onDiscard(): void
  onCancel(): void
}

export function UnsavedDialog({ fileName, onSave, onDiscard, onCancel }: UnsavedDialogProps): ReactElement {
  return (
    <Modal
      title="有未保存的修改"
      icon={<AlertTriangle size={18} />}
      onMaskClick={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn--danger" onClick={onDiscard}>
            不保存
          </button>
          <button type="button" className="btn btn--primary" onClick={onSave}>
            保存
          </button>
        </>
      }
    >
      <p>《{fileName}》有未保存的修改。</p>
      <p className="modal__dim">保存后再继续，还是放弃这些修改？</p>
    </Modal>
  )
}

const SHORTCUTS: Array<[string, string]> = [
  ['Tab', '为当前主题添加子主题'],
  ['Enter', '添加同级主题'],
  ['双击主题 / F2', '编辑文本'],
  ['直接打字（选中主题时）', '进入编辑并接着输入（空格也走这条路）'],
  ['Esc', '取消编辑'],
  ['Enter（编辑中）', '确认并退出编辑（不新建）；想接着建再按一次 Enter'],
  ['Tab（编辑中）', '确认并新建子主题'],
  ['Shift + Enter（编辑中）', '文本换行'],
  ['Delete / Backspace', '删除所选主题'],
  ['方向键', '在主题之间移动选择'],
  ['Ctrl + /', '折叠 / 展开所选主题'],
  ['Ctrl + C / Ctrl + V', '复制 / 粘贴主题'],
  ['Ctrl + Z / Ctrl + Shift + Z', '撤销 / 重做'],
  ['Ctrl + N / O / S', '新建 / 打开 / 保存'],
  ['Ctrl + Shift + S', '另存为'],
  ['Ctrl + F', '搜索 / 筛选 / 统计'],
  ['Ctrl + E', '导出（PNG / SVG / PDF）'],
  ['Ctrl + H', '历史记录与版本快照'],
  ['Ctrl + 0 / Ctrl + 1', '实际大小 / 适应画布'],
  ['Ctrl + Shift + L', '视角锁定：视角始终跟住选中的主题'],
  ['Alt + C', '代码块：打开节点面板并聚焦到代码输入框'],
  ['拖动主题', '贴到目标的边缘＝插到它前 / 后（同级）；停在中间＝成为它的子主题'],
  ['拖动主题到两个同级主题之间', '插到这两个之间'],
  ['拖动主题到远离任何分支的空白处', '自由摆放位置'],
  ['拖动一级主题到中心主题另一侧', '左右对调（仅平衡思维导图）'],
  ['Alt + ↑ / ↓', '在同一级里上移 / 下移一位（与 Ctrl+Shift+↑/↓ 等价）'],
  ['Ctrl + Shift + ↑ / ↓', '在同一级里上移 / 下移一位'],
  ['Ctrl + Shift + ← / →', '升级（成为父级的兄弟）/ 降级（挂到前一个兄弟下）'],
  ['Ctrl + Shift + Home / End', '移到同级的最前 / 最后'],
  ['左键拖动空白处', '框选多个主题（按住 Ctrl 为追加）'],
  ['右键 / 中键拖动', '平移画布'],
  ['Ctrl + 滚轮', '以指针为中心缩放'],
  ['拖动关系线两端的圆点', '把这一端改接到别的主题'],
  ['拖动关系线线身', '移动这条关系线（双击恢复自动弯度）']
]

export function ShortcutsDialog({ onClose }: { onClose(): void }): ReactElement {
  return (
    <Modal
      title="快捷键说明"
      onMaskClick={onClose}
      footer={
        <button type="button" className="btn btn--primary" onClick={onClose}>
          知道了
        </button>
      }
    >
      <div className="shortcut-list">
        {SHORTCUTS.map(([key, desc]) => (
          <div key={key} className="shortcut-row">
            <kbd>{key}</kbd>
            <span>{desc}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
