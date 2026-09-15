import { useLiveQuery } from 'dexie-react-hooks'
import { Coins, Info, TriangleAlert } from 'lucide-react'
import { db } from '@/lib/db'
import { cn } from '@/lib/utils'
import { isLegacyNamedClassRule } from '@/lib/classPoints'
import { RULE_MODE_LABEL, RULE_SCOPE_LABEL } from '@/lib/types'
import type { PointRule, RuleScope } from '@/lib/types'

/**
 * 规则选择器（v20）
 * ------------------------------------------------------------
 * 活动 / 任务从这里「引用」积分规则库里对应范围的规则：
 * 点击标签即可增减该活动适用的规则，规则的名称与分值仍在「积分规则」页统一维护。
 */
export function RulePicker({
  scope,
  value,
  onChange,
  emptyHint,
}: {
  scope: RuleScope
  /** 已选中的规则 id */
  value: string[]
  onChange: (ids: string[]) => void
  emptyHint?: string
}) {
  const rules = useLiveQuery(() => db.pointRules.toArray(), [])
  const list = (rules ?? [])
    .filter((r) => !r.deletedAt && (r.scope ?? 'checkin') === scope)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)

  // 失效引用：被引用、但在规则库里已删除 / 已跨套的 id。
  // 计分时会自动跳过，但配置项会「隐形残留」——这里显式暴露并支持一键清理。
  const knownIds = new Set(list.map((r) => r.id))
  const staleIds = value.filter((id) => !knownIds.has(id))
  const staleBanner =
    staleIds.length > 0 ? (
      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-2">
        <Info size={11} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1">
          有 {staleIds.length} 条被引用的规则已被删除或不属于本套（已不计分）
        </span>
        <button
          type="button"
          className="shrink-0 text-accent hover:underline"
          onClick={() => onChange(value.filter((id) => knownIds.has(id)))}
        >
          清理
        </button>
      </div>
    ) : null

  if (list.length === 0) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-dashed border-line-1 bg-surface-0 p-3 text-[12px] text-text-3">
          还没有{RULE_SCOPE_LABEL[scope]}，请先到「积分规则」页新建。
          {emptyHint ? ` ${emptyHint}` : ''}
        </div>
        {staleBanner}
      </div>
    )
  }

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  const enabledIds = list.filter((r) => r.enabled).map((r) => r.id)

  // v31.0：识别「旧自动条件时代」遗留的规则名（过关/第一个额外/1 …）。
  // 它们能正常计分，但名字是旧模型的产物，容易让人误以为「v30.8 的更新没生效」。
  // 这里只做**提示**，不自动删改用户数据。
  const legacyRules =
    scope === 'class' ? list.filter((r) => r.enabled && isLegacyNamedClassRule(r)) : []
  const legacyBanner =
    legacyRules.length > 0 ? (
      <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-text-2">
        <TriangleAlert size={11} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1">
          有 {legacyRules.length} 条规则仍是旧「自动条件」时代的命名（
          {legacyRules.map((r) => r.name).join('、')}），v30.8 之后它们只作为普通按钮使用。
          想换成新词表，可到「积分规则 → 课堂规则」停用或删除，系统会自动补上「熟练 / 主动 / 进步」。
        </span>
      </div>
    ) : null

  return (
    <div className="space-y-2">
      {legacyBanner}
      <div className="flex flex-wrap gap-1.5">
        {list.map((r) => {
          const on = value.includes(r.id)
          const legacy = scope === 'class' && isLegacyNamedClassRule(r)
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => toggle(r.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                on
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line-1 bg-surface-0 text-text-3 hover:border-accent/50',
                !r.enabled && 'opacity-60',
                legacy && 'border-dashed',
              )}
              title={`${RULE_MODE_LABEL[r.mode ?? 'auto']} · ${r.points > 0 ? '+' : ''}${r.points} 分${
                legacy ? '（旧自动条件时代的命名，建议在「积分规则」页清理）' : ''
              }`}
            >
              <Coins size={11} />
              <span>{r.name}</span>
              <span className="opacity-70">
                {r.points > 0 ? '+' : ''}
                {r.points}
              </span>
              {!on && <span className="opacity-60">未用</span>}
              {legacy && (
                <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-300">
                  旧
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-text-3">
        <span>
          已选 {value.length} 条（启用中的 {enabledIds.length} 条）
        </span>
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => onChange(enabledIds)}
        >
          全选启用
        </button>
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => onChange([])}
        >
          清空
        </button>
      </div>
      {staleBanner}
    </div>
  )
}

/** 已引用规则的紧凑展示（只读） */
export function RuleChips({ rules, emptyText }: { rules: PointRule[]; emptyText?: string }) {
  if (rules.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-text-3">
        <Info size={11} />
        {emptyText ?? '未引用规则'}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {rules.map((r) => (
        <span
          key={r.id}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
            r.enabled
              ? 'border-line-1 bg-surface-1 text-text-2'
              : 'border-line-1 bg-surface-2 text-text-3 line-through',
          )}
        >
          <span>{r.name}</span>
          <span className="text-amber-600 dark:text-amber-400">
            {r.points > 0 ? '+' : ''}
            {r.points}
          </span>
        </span>
      ))}
    </div>
  )
}
