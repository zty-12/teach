/**
 * 通用 Modal 底部（取消 + 主按钮）。
 * 统一替换每个弹窗各写一份的：
 *   footer={
 *     <>
 *       <Button onClick={onClose}>取消</Button>
 *       <Button variant="primary" onClick={save}>保存</Button>
 *     </>
 *   }
 *
 * 支持左/右扩展槽（如「删除」按钮放左边）。
 */
import type { ReactNode } from 'react'
import { Button } from '@/components/ui'

export interface ModalFooterProps {
  onCancel: () => void
  onConfirm: () => void
  /** 主按钮文案，默认"保存" */
  confirmLabel?: string
  /** 主按钮 variant，默认 primary */
  confirmVariant?: 'primary' | 'danger' | 'secondary'
  /** 主按钮是否禁用 */
  confirmDisabled?: boolean
  /** 取消按钮文案，默认"取消" */
  cancelLabel?: string
  /** 左侧额外元素（如"删除"、"仅保存"） */
  left?: ReactNode
}

export function ModalFooter({
  onCancel,
  onConfirm,
  confirmLabel = '保存',
  confirmVariant = 'primary',
  confirmDisabled = false,
  cancelLabel = '取消',
  left,
}: ModalFooterProps) {
  return (
    <>
      {left}
      <div className="ml-auto flex gap-2">
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button
          variant={confirmVariant}
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {confirmLabel}
        </Button>
      </div>
    </>
  )
}