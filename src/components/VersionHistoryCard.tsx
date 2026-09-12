import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import {
  Cloud,
  HardDrive,
  History,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Button, Card, CardHeader } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  CLOUD_KEEP,
  LOCAL_KEEP,
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  localSnapshotCount,
  restoreSnapshot,
  type SnapshotMeta,
  type SnapshotSource,
} from '@/lib/snapshots'

/** 表名 → 中文标签（版本摘要用） */
const TABLE_LABEL: Record<string, string> = {
  students: '学生',
  groups: '班课',
  groupMembers: '班课成员',
  courses: '课程',
  courseAttendances: '出勤',
  courseFeedbacks: '反馈',
  learningReports: '学习报告',
  learningTags: '学习标签',
  studentTags: '学生标签',
  payments: '收款',
  settlements: '结算',
  textbooks: '教材',
  textbookUnits: '单元',
  knowledgePoints: '知识点',
  feedbackTemplates: '反馈模板',
  courseKnowledges: '课知识点',
  checkInTasks: '打卡任务',
  checkInRecords: '打卡记录',
  pointRules: '积分规则',
  pointLedgers: '积分流水',
  rewardItems: '奖品',
  redemptions: '兑换',
  studentProfiles: '学生画像',
  feedbackTemplateFields: '模板字段',
}

function totalRows(counts: Record<string, number>): number {
  return Object.values(counts ?? {}).reduce((s, n) => s + (n || 0), 0)
}

/** 取记录数最多的前 3 张表作为摘要 */
function summary(counts: Record<string, number>): string {
  const entries = Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  if (entries.length === 0) return '空数据'
  return entries.map(([name, n]) => `${TABLE_LABEL[name] ?? name} ${n}`).join(' · ')
}

function SourceBadge({ source }: { source: SnapshotSource }) {
  const map: Record<SnapshotSource, { label: string; icon: typeof Cloud; cls: string }> = {
    local: { label: '本地', icon: HardDrive, cls: 'text-text-2' },
    cloud: { label: '云端', icon: Cloud, cls: 'text-accent-text' },
    both: { label: '本地·云端', icon: Cloud, cls: 'text-accent-text' },
  }
  const m = map[source]
  const Icon = m.icon
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px]', m.cls)}>
      <Icon size={11} />
      {m.label}
    </span>
  )
}

export function VersionHistoryCard({
  refreshKey,
  hasCloud,
  onChanged,
}: {
  /** 变化时（如手动同步成功）触发列表重载 */
  refreshKey: number
  /** 是否已配置 Supabase（决定是否展示云端说明） */
  hasCloud: boolean
  /** 创建 / 恢复后回调（用于刷新待推送数等） */
  onChanged?: () => void | Promise<void>
}) {
  const [list, setList] = useState<SnapshotMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [localCount, setLocalCount] = useState(0)

  async function reload() {
    setLoading(true)
    try {
      const [snaps, cnt] = await Promise.all([listSnapshots(), localSnapshotCount()])
      setList(snaps)
      setLocalCount(cnt)
    } catch (e) {
      setMsg({ tone: 'err', text: String(e) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  async function handleCreate() {
    setBusy('create')
    setMsg(null)
    try {
      const s = await createSnapshot({
        auto: false,
        label: `手动版本 ${format(new Date(), 'M-d HH:mm')}`,
        force: true,
      })
      setMsg({
        tone: 'ok',
        text: s ? `已创建版本（共 ${totalRows(s.counts)} 条记录）` : '已创建版本',
      })
      await reload()
      await onChanged?.()
    } catch (e) {
      setMsg({ tone: 'err', text: `创建失败：${String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  async function handleRestore(m: SnapshotMeta) {
    const t = format(m.createdAt, 'yyyy-MM-dd HH:mm')
    if (
      !window.confirm(
        `确定恢复到「${t} · ${m.label}」这个版本吗？\n\n` +
          `当前数据会被该版本整体覆盖。恢复前会自动为当前状态留一份备份，可再撤销。\n` +
          `恢复后下次同步会把该版本推送到云端。`,
      )
    )
      return
    setBusy(m.id)
    setMsg(null)
    try {
      const r = await restoreSnapshot(m.id, m.source)
      setMsg({
        tone: 'ok',
        text: `已恢复：${r.tables} 张表 / 共 ${r.rows} 条记录。开启同步后会自动推送。`,
      })
      await reload()
      await onChanged?.()
    } catch (e) {
      setMsg({ tone: 'err', text: `恢复失败：${String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(m: SnapshotMeta) {
    if (!window.confirm('删除该版本？此操作不可撤销。')) return
    setBusy(m.id)
    try {
      await deleteSnapshot(m.id, m.source)
      await reload()
    } catch (e) {
      setMsg({ tone: 'err', text: `删除失败：${String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title="数据版本"
        subtitle={`同步后自动留档，可回滚。本地保留最近 ${LOCAL_KEEP} 个${
          hasCloud ? ` · 云端 ${CLOUD_KEEP} 个` : ''
        }`}
        action={<span className="text-xs text-text-3">共 {list.length} 个</span>}
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleCreate()}
            disabled={busy !== null}
          >
            {busy === 'create' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <History size={14} />
            )}
            立即创建版本
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            刷新
          </Button>
          <span className="text-xs text-text-3">本地 {localCount} 个</span>
        </div>

        {msg && (
          <p className={cn('text-[13px]', msg.tone === 'ok' ? 'text-done' : 'text-money-due')}>
            {msg.text}
          </p>
        )}

        {list.length === 0 ? (
          <p className="text-[13px] text-text-3">
            暂无版本。开启同步后，每次有数据变化的同步都会自动留档；也可点「立即创建版本」手动存档。
          </p>
        ) : (
          <ul className="divide-y divide-line-1 overflow-hidden rounded-lg border border-line-1">
            {list.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-text-1">
                      {format(m.createdAt, 'yyyy-MM-dd HH:mm')}
                    </span>
                    <span className="rounded bg-surface-2 px-1.5 text-[11px] text-text-2">
                      {m.label}
                    </span>
                    <SourceBadge source={m.source} />
                    {m.device && <span className="text-[11px] text-text-3">{m.device}</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-text-3">
                    {totalRows(m.counts)} 条记录 · {summary(m.counts)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRestore(m)}
                  disabled={busy !== null}
                >
                  {busy === m.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <RotateCcw size={13} />
                  )}
                  恢复
                </Button>
                <button
                  type="button"
                  onClick={() => void handleDelete(m)}
                  disabled={busy !== null}
                  className="rounded p-1.5 text-text-3 hover:bg-surface-2 hover:text-money-due disabled:opacity-50"
                  aria-label="删除版本"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {!hasCloud && (
          <p className="text-[12px] text-text-3">
            未配置 Supabase：版本仅存在本机。配置后可自动同步到云端，实现跨设备恢复。
          </p>
        )}
      </div>
    </Card>
  )
}
