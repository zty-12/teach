/**
 * 学生画像：从历史打卡备注 + AI 反馈汇总生成学生特征。
 *
 * 一个学生对应一条画像记录（studentId 唯一键）。
 * 画像在生成家长反馈前按需刷新：
 *   1. 读取该学生的所有历史 aiFeedback + note
 *   2. 让 AI 输出结构化画像（summary / strengths / weaknesses / teachingStyle）
 *   3. 写回 studentProfiles 表，下次调用直接读
 *   4. 生成新反馈时把画像塞进 prompt，让每次反馈都针对该学生个性化
 */
import { db, newId, touch } from './db'
import type { AppSettings, CheckInRecord, StudentProfile } from './types'
import { chat, cfgFromSettings, extractJson, isAiConfigured } from './llm'

// ============================================================
// DB 辅助
// ============================================================

/** 读取该学生的最新画像（不存在则返回 null） */
export async function getStudentProfile(studentId: string): Promise<StudentProfile | null> {
  if (!studentId) return null
  const all = await db.studentProfiles.filter((p) => p.studentId === studentId && !p.deletedAt).toArray()
  if (all.length === 0) return null
  return all.sort((a, b) => b.updatedAt - a.updatedAt)[0]!
}

/** 写入 / 更新该学生的画像（upsert：一个学生一条） */
export async function saveStudentProfile(profile: StudentProfile): Promise<void> {
  await db.studentProfiles.put(touch(profile))
}

/** 该学生的历史 aiFeedback + note 素材（按时间升序，最多 recentLimit 条） */
export async function getCheckInHistory(
  studentId: string,
  recentLimit = 30,
): Promise<Array<{ dayAt: number; note: string; aiFeedback: string }>> {
  if (!studentId) return []
  const all = (await db.checkInRecords.toArray()) as CheckInRecord[]
  return all
    .filter((r) => !r.deletedAt && r.studentId === studentId && r.dayAt !== null)
    .filter((r) => (r.note ?? '').trim().length > 0 || (r.aiFeedback ?? '').trim().length > 0)
    .map((r) => ({
      dayAt: r.dayAt as number,
      note: r.note ?? '',
      aiFeedback: r.aiFeedback ?? '',
    }))
    .sort((a, b) => b.dayAt - a.dayAt)
    .slice(0, recentLimit)
    .reverse()
}

// ============================================================
// AI 画像生成
// ============================================================

interface ProfileJsonOutput {
  summary?: string
  strengths?: string
  weaknesses?: string
  teachingStyle?: string
}

function buildProfilePrompt(
  studentName: string,
  materials: Array<{ dayAt: number; note: string; aiFeedback: string }>,
): Array<{ role: 'system' | 'user'; content: string }> {
  const fmt = (t: number) => new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
  const materialList = materials
    .map((m) => {
      const parts: string[] = [`【${fmt(m.dayAt)}】`]
      if (m.note) parts.push(`老师观察：${m.note}`)
      if (m.aiFeedback) parts.push(`家长反馈：${m.aiFeedback}`)
      return parts.join('\n')
    })
    .join('\n\n')

  return [
    {
      role: 'system',
      content:
        '你是一名资深教研老师，正在为一名学员建立跨期观察画像。' +
        '你必须且仅输出一个 JSON 对象，不要输出任何其它文字。JSON 结构：' +
        '{"summary":"综合特征（3-5 句话，描述该学员的学习风格、专注力、表达 / 练习习惯、典型表现，200 字以内）",' +
        '"strengths":"优势亮点（3-5 个短语，用中文分号「；」分隔）",' +
        '"weaknesses":"待改进点（3-5 个短语，用中文分号「；」分隔）",' +
        '"teachingStyle":"推荐的教学方式建议（1-2 句话，针对该学员的特点给出可执行的相处方式）"}',
    },
    {
      role: 'user',
      content: `学员：${studentName}

以下是该学员过去所有打卡的【老师观察】和【家长反馈】素材，共 ${materials.length} 条：

${materialList || '（暂无素材）'}

请基于以上素材总结该学员的长期特征。要求：
1. summary 客观具体，不要空泛（避免「学习认真」「表现积极」这类通用词）；
2. strengths / weaknesses 要具体可验证（例如「数学计算速度快，但读题理解常出错」而不是「有优势有不足」）；
3. 素材不足时（少于 3 条）summary 明确写出「样本较少，画像初步」，并基于已有素材做谨慎推断；
4. teachingStyle 要与本次特点挂钩，能直接指导家长如何配合。`,
    },
  ]
}

/**
 * 刷新学生画像：读取历史 → AI 总结 → 写回 DB。
 * 素材不足（<2 条）时跳过 AI 调用，避免浪费 API 费用。
 * 返回刷新后的画像；如果无素材返回 null。
 */
export async function refreshStudentProfile(
  settings: AppSettings,
  studentId: string,
  studentName: string,
): Promise<StudentProfile | null> {
  if (!studentId) return null
  const history = await getCheckInHistory(studentId, 30)
  if (history.length < 2) {
    // 素材不足，不生成画像
    return null
  }
  if (!isAiConfigured(settings)) return null

  const messages = buildProfilePrompt(studentName, history)
  const raw = await chat(cfgFromSettings(settings), messages, true)
  const parsed = extractJson<ProfileJsonOutput>(raw)

  const existing = await getStudentProfile(studentId)
  const now = Date.now()
  const profile: StudentProfile = {
    id: existing?.id ?? newId(),
    studentId,
    summary: (parsed.summary ?? '').trim(),
    strengths: (parsed.strengths ?? '').trim(),
    weaknesses: (parsed.weaknesses ?? '').trim(),
    teachingStyle: (parsed.teachingStyle ?? '').trim(),
    profileUpdatedAt: now,
    sourceCount: history.length,
    updatedAt: now,
    deletedAt: null,
    dirty: 1,
  }
  await saveStudentProfile(profile)
  return profile
}

/**
 * 打卡场景的画像快照：先尝试用已有画像；
 * 若画像不存在或超过 maxAgeMs 未刷新，则触发一次 refresh 再返回。
 */
export async function getOrRefreshProfileForFeedback(
  settings: AppSettings,
  studentId: string,
  studentName: string,
  maxAgeMs = 24 * 3600 * 1000,
): Promise<
  | { summary: string; strengths: string; weaknesses: string; teachingStyle: string; profileUpdatedAt: number; sourceCount: number }
  | undefined
> {
  if (!studentId) return undefined
  let p = await getStudentProfile(studentId)
  if (!p || Date.now() - p.profileUpdatedAt > maxAgeMs) {
    p = await refreshStudentProfile(settings, studentId, studentName)
  }
  if (!p) return undefined
  return {
    summary: p.summary,
    strengths: p.strengths,
    weaknesses: p.weaknesses,
    teachingStyle: p.teachingStyle,
    profileUpdatedAt: p.profileUpdatedAt,
    sourceCount: p.sourceCount,
  }
}
