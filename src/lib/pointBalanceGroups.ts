/**
 * 积分余额「按班课划分」的分节逻辑（v31.5）。
 *
 * 背景：兑换商城的「积分余额」原来把全部在读学生平铺成一条长列表，
 * 老师没法按班课看。现在支持两种视图：
 *  - 全部（scope=''）：按班课分节展示，未加入任何班课的学生归到「未分班」；
 *  - 单个班课（scope=班课 id）：只看这个班课的名单；
 *  - scope='__none__'：只看未分班的学生。
 *
 * 这里刻意抽成纯函数（不依赖 React / Dexie），既让页面逻辑更薄，
 * 也让回归脚本能直接断言分节与筛选行为。
 */

/** 一行余额数据（只要学生标识 + 余额字段，方便组件透传自己的行类型） */
export interface BalanceRowLike {
  student: { id: string; name: string }
  balance: number
  earned: number
}

export interface BalanceSection<R extends BalanceRowLike> {
  /** 班课 id；未分班为 '__none__' */
  key: string
  name: string
  rows: R[]
}

/** 「未分班」这一节的固定 key（与 UI 下拉里的取值保持一致） */
export const NO_GROUP_SCOPE = '__none__'

/**
 * 把余额行按当前查看范围切成若干节。
 *
 * @param rows      已排序（余额降序）的学生行
 * @param groupsOf  学生 id → 所属班课 id 列表（按班课显示顺序）
 * @param groups    班课列表，已按显示顺序排好
 * @param scope     '' = 全部 / '__none__' = 未分班 / 其它 = 班课 id
 * @returns total = 当前范围内的行数；list = 要渲染的节（同一条数据可能出现在多个班课节里）
 */
export function buildBalanceSections<R extends BalanceRowLike>(
  rows: readonly R[],
  groupsOf: Map<string, string[]>,
  groups: ReadonlyArray<{ id: string; name: string }>,
  scope: string,
): { total: number; list: Array<BalanceSection<R>> } {
  const visible = rows.filter((r) => {
    if (!scope) return true
    const gids = groupsOf.get(r.student.id) ?? []
    return scope === NO_GROUP_SCOPE ? gids.length === 0 : gids.includes(scope)
  })

  if (scope) {
    const name =
      scope === NO_GROUP_SCOPE
        ? '未分班'
        : groups.find((g) => g.id === scope)?.name ?? '班课'
    // 即使该班课没有学生也保留一节，页面据此显示班课名 + 空态提示
    return { total: visible.length, list: [{ key: scope, name, rows: [...visible] }] }
  }

  const byGroup = new Map<string, R[]>()
  const none: R[] = []
  for (const r of visible) {
    const gid = (groupsOf.get(r.student.id) ?? [])[0]
    if (!gid) {
      none.push(r)
      continue
    }
    const arr = byGroup.get(gid)
    if (arr) arr.push(r)
    else byGroup.set(gid, [r])
  }

  const list: Array<BalanceSection<R>> = []
  for (const g of groups) {
    const rs = byGroup.get(g.id)
    if (rs && rs.length > 0) list.push({ key: g.id, name: g.name, rows: rs })
  }
  if (none.length > 0) list.push({ key: NO_GROUP_SCOPE, name: '未分班', rows: none })
  return { total: visible.length, list }
}

/** 学生 → 所属班课 id 列表（按班课显示顺序去重排序） */
export function buildStudentGroupMap(
  members: ReadonlyArray<{ groupId: string; studentId: string }>,
  groups: ReadonlyArray<{ id: string }>,
): Map<string, string[]> {
  const idx = new Map(groups.map((g, i) => [g.id, i]))
  const m = new Map<string, string[]>()
  for (const mem of members) {
    if (!idx.has(mem.groupId)) continue
    const arr = m.get(mem.studentId)
    if (!arr) {
      m.set(mem.studentId, [mem.groupId])
      continue
    }
    if (!arr.includes(mem.groupId)) arr.push(mem.groupId)
  }
  for (const arr of m.values()) arr.sort((a, b) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0))
  return m
}
