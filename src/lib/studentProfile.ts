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
import type { AppSettings, CheckInRecord, CheckInTask, StudentProfile } from './types'
import { chat, cfgFromSettings, extractJson, isAiConfigured } from './llm'

// ============================================================
// DB 辅助
// ============================================================

/** 传给 LLM 的画像快照（与 llm.ts 的 StudentProfileSnapshot 结构一致） */
export type ProfileSnapshot = {
  summary: string
  strengths: string
  weaknesses: string
  teachingStyle: string
  profileUpdatedAt: number
  sourceCount: number
}

/** 读取该学生的最新画像（不存在则返回 null） */
export async function getStudentProfile(studentId: string): Promise<StudentProfile | null> {
  if (!studentId) return null
  const all = await db.studentProfiles.filter((p) => p.studentId === studentId && !p.deletedAt).toArray()
  if (all.length === 0) return null
  return all.sort((a, b) => b.updatedAt - a.updatedAt)[0]!
}

/**
 * 只做本地读取的画像快照（**不触发任何 AI 调用**，毫秒级返回）。
 *
 * v31.4：生成家长反馈前优先用它拿到画像，避免「等画像刷新完再生成反馈」
 * 变成两次串行 LLM 请求（实测是生成慢的主因）。刷新改由后台异步进行。
 */
export async function getProfileSnapshot(studentId: string): Promise<ProfileSnapshot | null> {
  const p = await getStudentProfile(studentId)
  if (!p) return null
  return {
    summary: p.summary,
    strengths: p.strengths,
    weaknesses: p.weaknesses,
    teachingStyle: p.teachingStyle,
    profileUpdatedAt: p.profileUpdatedAt,
    sourceCount: p.sourceCount,
  }
}

/** 写入 / 更新该学生的画像（upsert：一个学生一条） */
export async function saveStudentProfile(profile: StudentProfile): Promise<void> {
  await db.studentProfiles.put(touch(profile))
}

/** 该学生的历史 aiFeedback + note 素材（含对应打卡任务标题，按时间升序，最多 recentLimit 条） */
export async function getCheckInHistory(
  studentId: string,
  recentLimit = 30,
): Promise<Array<{ dayAt: number; note: string; aiFeedback: string; taskTitle?: string }>> {
  if (!studentId) return []
  const all = (await db.checkInRecords.toArray()) as CheckInRecord[]
  const taskById = new Map(((await db.checkInTasks.toArray()) as CheckInTask[]).map((t) => [t.id, t]))
  return all
    .filter((r) => !r.deletedAt && r.studentId === studentId && r.dayAt !== null)
    .filter((r) => (r.note ?? '').trim().length > 0 || (r.aiFeedback ?? '').trim().length > 0)
    .map((r) => {
      // 优先用打卡时固化的任务快照，缺则回退关联任务（兼容旧数据）
      const snap = r.taskSnapshot
      const task =
        snap && (snap.title || snap.note)
          ? { title: snap.title, note: snap.note }
          : taskById.get(r.taskId)
      return {
        dayAt: r.dayAt as number,
        note: r.note ?? '',
        aiFeedback: r.aiFeedback ?? '',
        taskTitle: task?.title,
      }
    })
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

/**
 * 画像素材上限（v31.4：30 → 12）。
 * 画像只在「跨期特征」上起作用，喂 30 条历史只会把 prompt 撑到数千 token，
 * 预填与生成都变慢，而对结论几乎无增益。
 */
export const PROFILE_MAX_MATERIALS = 12

/** 单条素材的字段截断长度，避免个别超长备注吃掉大半预算 */
const MATERIAL_CLIP = { task: 30, note: 100, feedback: 140 }

function clip(s: string, n: number): string {
  const t = (s ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function buildProfilePrompt(
  studentName: string,
  materials: Array<{ dayAt: number; note: string; aiFeedback: string; taskTitle?: string }>,
): Array<{ role: 'system' | 'user'; content: string }> {
  const fmt = (t: number) => new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
  const materialList = materials
    .map((m) => {
      const parts: string[] = [`【${fmt(m.dayAt)}】`]
      if (m.taskTitle) parts.push(`任务：${clip(m.taskTitle, MATERIAL_CLIP.task)}`)
      if (m.note) parts.push(`观察：${clip(m.note, MATERIAL_CLIP.note)}`)
      if (m.aiFeedback) parts.push(`反馈：${clip(m.aiFeedback, MATERIAL_CLIP.feedback)}`)
      return parts.join('\n')
    })
    .join('\n')

  return [
    {
      role: 'system',
      content:
        '你是一名资深教研老师，正在为一名学员建立跨期观察画像。' +
        '你必须且仅输出一个 JSON 对象，不要输出任何其它文字。JSON 结构：' +
        '{"summary":"综合特征（2-3 句话，描述学习风格、专注力、表达 / 练习习惯，120 字以内）",' +
        '"strengths":"优势亮点（3 个短语，用中文分号「；」分隔，每项不超过 15 字）",' +
        '"weaknesses":"待改进点（3 个短语，用中文分号「；」分隔，每项不超过 15 字）",' +
        '"teachingStyle":"推荐的教学方式（1 句话，不超过 40 字）"}',
    },
    {
      role: 'user',
      content: `学员：${studentName}

以下是该学员近期打卡的【老师观察】和【家长反馈】素材，共 ${materials.length} 条：

${materialList || '（暂无素材）'}

请基于以上素材总结该学员的长期特征。要求：
1. summary 客观具体，不要空泛（避免「学习认真」「表现积极」这类通用词）；
2. strengths / weaknesses 要具体可验证（例如「数学计算速度快，但读题理解常出错」而不是「有优势有不足」）；
3. 素材不足时（少于 3 条）summary 明确写出「样本较少，画像初步」，并基于已有素材做谨慎推断；
4. teachingStyle 要与本次特点挂钩，能直接指导家长如何配合；
5. 输出务必精简，不要复述素材原文。`,
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
  const history = await getCheckInHistory(studentId, PROFILE_MAX_MATERIALS)
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
 * 画像刷新周期（v31.4：24h → 72h）。
 *
 * 画像是「跨期特征」，一天一刷意义不大，却会让老师每次生成反馈时
 * 都多等一次 LLM 往返。放宽到 72h 后，绝大多数反馈生成都是单请求。
 */
export const PROFILE_REFRESH_MAX_AGE_MS = 72 * 3600 * 1000

/**
 * 打卡场景的画像快照：先尝试用已有画像；
 * 若画像不存在或超过 maxAgeMs 未刷新，则触发一次 refresh 再返回。
 *
 * ⚠ 本函数**可能发一次 LLM 请求**（画像过期时）。
 *   只想读本地画像的场景请用 `getProfileSnapshot`（不联网，毫秒级）。
 */
export async function getOrRefreshProfileForFeedback(
  settings: AppSettings,
  studentId: string,
  studentName: string,
  maxAgeMs = PROFILE_REFRESH_MAX_AGE_MS,
): Promise<ProfileSnapshot | undefined> {
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
