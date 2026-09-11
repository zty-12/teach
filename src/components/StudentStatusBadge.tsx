/**
 * 学生状态徽章：替换 Students 表格行 / 移动端卡片两处
 * 各自写的「Badge + STUDENT_STATUS_LABEL[s.status] + 配色 className」重复。
 */
import { Badge } from '@/components/ui'
import { STUDENT_STATUS_LABEL, type StudentStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

const STATUS_CLASS: Record<StudentStatus, string> = {
  active: 'bg-done-soft text-done',
  paused: 'bg-leave-soft text-leave',
  finished: 'bg-surface-3 text-text-2',
  archived: 'bg-surface-3 text-text-2',
}

export function StudentStatusBadge({ status }: { status: StudentStatus }) {
  return (
    <Badge className={cn(STATUS_CLASS[status])}>
      {STUDENT_STATUS_LABEL[status]}
    </Badge>
  )
}