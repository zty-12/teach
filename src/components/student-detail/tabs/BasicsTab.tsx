/**
 * 学生详情 - 基础信息 Tab
 *
 * 展示学生的所有属性（计费、课时、试听、所在班课、标签、备注），
 * 提供"编辑"入口跳转到原 StudentModal。
 */
import { Avatar } from '@/components/Avatar'
import { ColorPicker } from '@/components/ColorPicker'
import { StudentStatusBadge } from '@/components/StudentStatusBadge'
import { TagBadge, TagBadgeList } from '@/components/TagBadge'
import {
  BILLING_RULE_LABEL,
  type Group,
  type GroupMember,
  type LearningTag,
  type Student,
  type StudentStatus,
  type StudentTag,
} from '@/lib/types'
import { formatMoney, maskPhone, subjectColorVar } from '@/lib/utils'
import { TAG_TYPES } from '@/lib/types'

const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  active: '在读',
  paused: '暂停',
  finished: '结课',
  archived: '归档',
}

export function BasicsTab({
  student,
  groups,
  groupMembers,
  tags,
  studentTags,
}: {
  student: Student
  groups: Group[]
  groupMembers: GroupMember[]
  tags: LearningTag[]
  studentTags: StudentTag[]
}) {
  const trialDays = student.isTrial && student.trialAt
    ? Math.floor((Date.now() - student.trialAt) / 86_400_000)
    : 0

  const studentGroupIds = new Set(groupMembers.map((m) => m.groupId))
  const studentGroups = groups.filter((g) => studentGroupIds.has(g.id))
  const myTagIds = new Set(studentTags.map((t) => t.tagId))
  const myTags = tags.filter((t) => myTagIds.has(t.id))

  return (
    <div className="space-y-3 p-4">
      {/* 计费概览 */}
      <div className="rounded-lg border border-line-1 bg-surface-1 p-3">
        <div className="flex items-start gap-3">
          <Avatar name={student.name} colorSlot={student.colorSlot} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold text-text-1">{student.name}</span>
              <StudentStatusBadge status={student.status} />
              {student.isTrial && (
                <span className="inline-flex items-center rounded-md bg-pending-soft px-1.5 py-0.5 text-[11px] font-medium text-pending">
                  试听 {trialDays} 天
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] text-text-2">
              {BILLING_RULE_LABEL[student.billingRule]}
              {student.hourlyFeeCents > 0 && ` · ¥${student.hourlyFeeCents / 100}/课时`}
            </p>
          </div>
        </div>

        {student.billingRule === 'prepaid' && (
          <div className="mt-3 grid grid-cols-3 gap-3 border-t border-line-1 pt-3">
            <Field label="已缴课时" value={`${student.paidHours} 课时`} />
            <Field
              label="剩余课时"
              value={`${student.remainingHours} 课时`}
              tone={student.remainingHours <= student.remindHours ? 'pending' : 'default'}
            />
            <Field label="提醒阈值" value={`${student.remindHours} 课时`} />
          </div>
        )}
      </div>

      {/* 基础字段 */}
      <Section title="基础信息">
        <KV label="姓名" value={student.name} />
        <KV label="年级" value={student.grade || '—'} />
        <KV label="学籍水平" value={student.academicLevel || '—'} />
        <KV label="联系电话" value={student.phone ? maskPhone(student.phone) : '—'} />
        <KV label="状态" value={STUDENT_STATUS_LABEL[student.status]} />
      </Section>

      {student.note && (
        <Section title="备注">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">
            {student.note}
          </p>
        </Section>
      )}

      {/* 所在班课 */}
      <Section title={`所在班课（${studentGroups.length}）`}>
        {studentGroups.length === 0 ? (
          <p className="text-[13px] text-text-3">暂无所属班课</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {studentGroups.map((g) => (
              <span
                key={g.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-line-1 bg-surface-0 px-2.5 py-1 text-[12px] text-text-1"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: subjectColorVar(g.colorSlot) }}
                />
                {g.name}
              </span>
            ))}
          </div>
        )}
      </Section>

      {/* 学习标签 */}
      <Section title={`学习标签（${myTags.length}）`}>
        {myTags.length === 0 ? (
          <p className="text-[13px] text-text-3">
            暂无标签，可到「学习标签」Tab 添加
          </p>
        ) : (
          <TagBadgeList tags={myTags} variant="filled" />
        )}
        {tags.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] text-text-3 hover:text-text-2">
              标签库（{tags.length}）
            </summary>
            <div className="mt-2 space-y-2">
              {TAG_TYPES.map((typeName) => {
                const list = tags.filter((t) => t.type === typeName)
                if (list.length === 0) return null
                return (
                  <div key={typeName}>
                    <p className="text-[11px] text-text-3">{typeName}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {list.map((t) => (
                        <TagBadge
                          key={t.id}
                          tag={t}
                          variant="surface"
                          className={
                            myTagIds.has(t.id)
                              ? 'ring-1 ring-accent/40'
                              : 'opacity-50'
                          }
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </details>
        )}
      </Section>

      {/* 头像配色（只读预览） */}
      <Section title="头像配色">
        <ColorPicker
          value={student.colorSlot}
          onChange={() => {}}
          ariaPrefix="头像配色"
          className="pointer-events-none opacity-70"
        />
      </Section>

      {/* 试听状态 */}
      {student.isTrial && student.trialAt && (
        <Section title="试听信息">
          <KV
            label="试听开始"
            value={new Date(student.trialAt).toLocaleDateString('zh-CN')}
          />
          <KV label="已试听" value={`${trialDays} 天`} />
          {trialDays >= 5 && (
            <div className="rounded-lg bg-pending-soft px-3 py-2 text-[13px] text-pending">
              ⚠ 试听已 {trialDays} 天，建议及时转正式或暂停
            </div>
          )}
        </Section>
      )}

      {/* 试听/收款参考 */}
      {student.billingRule === 'prepaid' && student.hourlyFeeCents > 0 && (
        <Section title="续费参考">
          <p className="text-[12px] text-text-2">
            单价 {formatMoney(student.hourlyFeeCents)} / 课时；
            续 10 课时 ≈ {formatMoney(student.hourlyFeeCents * 10)}
          </p>
        </Section>
      )}
    </div>
  )
}

// ============================================================
// 子组件
// ============================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line-1 bg-surface-0 p-3">
      <h3 className="mb-2 text-[13px] font-semibold text-text-1">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-text-3">{label}</span>
      <span className="truncate text-right text-text-1">{value}</span>
    </div>
  )
}

function Field({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'pending'
}) {
  return (
    <div>
      <p className="text-[11px] text-text-3">{label}</p>
      <p
        className={`mt-0.5 text-[15px] font-semibold tabular-nums ${
          tone === 'pending' ? 'text-pending' : 'text-text-1'
        }`}
      >
        {value}
      </p>
    </div>
  )
}