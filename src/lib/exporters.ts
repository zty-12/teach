import * as XLSX from 'xlsx'
import type { Table } from 'dexie'
import { db } from './db'
import { SYNC_TABLES } from './sync'
import {
  COURSE_STATUS_LABEL,
  STUDENT_STATUS_LABEL,
  type Course,
  type Group,
  type LearningReport,
  type Student,
} from './types'
import { courseDurationMin, courseEnd, format, formatTime } from './utils'

interface SheetRow {
  [key: string]: string | number
}

function downloadSheet(rows: SheetRow[], filename: string) {
  if (rows.length === 0) {
    alert('没有可导出的数据')
    return
  }
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, filename.slice(0, 31))
  XLSX.writeFile(wb, `${filename}_${format(new Date(), 'yyyyMMdd')}.xlsx`)
}

/** 学生列表导出 */
export function exportStudents(students: Student[]) {
  const rows: SheetRow[] = students.map((s) => ({
    姓名: s.name,
    年级: s.grade,
    学籍水平: s.academicLevel,
    电话: s.phone,
    状态: STUDENT_STATUS_LABEL[s.status],
    备注: s.note,
  }))
  downloadSheet(rows, '学生列表')
}

/** 学习报告导出 */
export function exportReports(
  reports: LearningReport[],
  studentNameMap: Record<string, string>,
  filename = '学习报告',
) {
  const rows: SheetRow[] = reports.map((r) => ({
    标题: r.title || '未命名报告',
    学生: studentNameMap[r.studentId] ?? '（已删除）',
    周期开始: format(new Date(r.periodStart), 'yyyy-MM-dd'),
    周期结束: format(new Date(r.periodEnd), 'yyyy-MM-dd'),
    AI生成: r.aiGenerated ? '是' : '否',
    正文: r.content,
  }))
  downloadSheet(rows, filename)
}

/** 班课列表导出（含成员） */
export function exportGroups(groups: { group: Group; members: string[] }[]) {
  const rows: SheetRow[] = groups.map((g) => ({
    班课名称: g.group.name,
    科目: g.group.subject,
    单次时长分钟: g.group.defaultDurationMin,
    成员: g.members.join('、'),
    备注: g.group.note,
  }))
  downloadSheet(rows, '班课列表')
}

/** 课程表导出 */
export function exportSchedule(
  courses: Course[],
  studentMap: Map<string, Student>,
  groupMap: Map<string, Group>,
) {
  const live = courses.filter((c) => !c.deletedAt).sort((a, b) => a.startAt - b.startAt)
  const rows: SheetRow[] = live.map((c) => {
    const who = c.studentId
      ? studentMap.get(c.studentId)?.name ?? '学生(已删)'
      : c.groupId
        ? groupMap.get(c.groupId)?.name ?? '班课(已删)'
        : '班课'
    return {
      日期: format(c.startAt, 'yyyy-MM-dd'),
      开始: formatTime(c.startAt),
      结束: formatTime(courseEnd(c, groupMap)),
      学生或班课: who,
      科目: c.subject,
      时长分钟: courseDurationMin(c, groupMap),
      方式: c.method === 'online' ? '线上' : '线下',
      地点: c.location,
      状态: COURSE_STATUS_LABEL[c.status],
      课酬元: Number((c.feeCents / 100).toFixed(2)),
    }
  })
  downloadSheet(rows, '课程表')
}

/** 财务台账导出（应收 + 收款合并） */
export interface FinanceExportRow {
  日期: string
  类型: string
  学生或班课: string
  科目: string
  金额元: number
  备注: string
}

export function exportFinance(rows: FinanceExportRow[]) {
  downloadSheet(rows as unknown as SheetRow[], '财务台账')
}

// ============================================================
// 全库备份 / 恢复（JSON）
// ============================================================

function triggerDownload(filename: string, content: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 备份全库：所有同步表 + 设置，导出为一个 JSON 文件 */
export async function exportBackupJson(): Promise<number> {
  const payload: Record<string, unknown> = {
    app: 'edu-workbench',
    version: 1,
    exportedAt: Date.now(),
    tables: {} as Record<string, unknown[]>,
  }
  const tables = payload.tables as Record<string, unknown[]>
  for (const name of SYNC_TABLES) {
    const table = (db as unknown as Record<string, Table<never, string>>)[name]
    tables[name] = (await table.toArray()) as unknown[]
  }
  payload.settings = (await db.settings.toArray()) as unknown[]
  triggerDownload(
    `edu_workbench_backup_${format(new Date(), 'yyyyMMdd_HHmmss')}.json`,
    JSON.stringify(payload, null, 2),
  )
  return SYNC_TABLES.reduce((sum, n) => sum + (tables[n] as unknown[]).length, 0)
}

/** 从 JSON 文件恢复全库（逐行 LWW 合并：仅当备份行更新、或本地无该行时才写入） */
export async function importBackupJson(
  file: File,
): Promise<{ tables: number; rows: number; skipped: number }> {
  const text = await file.text()
  const data = JSON.parse(text) as {
    tables: Record<string, Record<string, unknown>[]>
    settings?: Record<string, unknown>[]
  }
  if (!data || typeof data.tables !== 'object') {
    throw new Error('不是有效的备份文件')
  }

  let totalRows = 0
  let totalTables = 0
  let skipped = 0
  for (const name of SYNC_TABLES) {
    const rows = data.tables[name]
    if (!Array.isArray(rows) || rows.length === 0) continue
    const table = (db as unknown as Record<string, Table<never, string>>)[name]
    const valid = rows.filter((r) => typeof r.id === 'string') as Array<Record<string, unknown>>

    // ⚠ 逐行 last-write-wins：备份文件里的行可能**比本地旧**（导出之后本地又改过），
    //   直接 bulkPut 会把本地较新的记录静默回退；且备份行的 dirty 多为 0，
    //   回退后甚至推不到云端 → 本机与云端分裂（v26 审查：P2）。
    const keep: Array<Record<string, unknown>> = []
    for (const r of valid) {
      const local = (await table.get(r.id as string)) as { updatedAt?: number } | undefined
      const backupAt = typeof r.updatedAt === 'number' ? r.updatedAt : 0
      const localAt = typeof local?.updatedAt === 'number' ? local.updatedAt : 0
      if (!local || backupAt > localAt) {
        keep.push({ ...r, dirty: 1 }) // 统一标 dirty，保证合并结果能推送出去
      } else {
        skipped++
      }
    }
    if (keep.length === 0) continue

    // 整批包事务：要么都进、要么都不进，避免半途失败留下不一致的库
    await db.transaction('rw', table, async () => {
      await table.bulkPut(keep as never[])
    })
    totalRows += keep.length
    totalTables += 1
  }

  // 恢复设置（仅合并，不全覆盖）
  const settings = data.settings ?? []
  for (const s of settings) {
    if (typeof s.key === 'string') {
      await db.settings.put(s as never)
    }
  }

  return { tables: totalTables, rows: totalRows, skipped }
}

