import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useSettings } from '@/store/useSettings'
import { useAutoSync } from '@/hooks/useAutoSync'
import { isSupabaseConfigured } from '@/lib/supabase'
import { purgeTombstones } from '@/lib/sync'
import { ensureCheckInRuleBindings, purgeMakeupAutoCheckInTasks } from '@/lib/points'
import { purgeMakeupCourseFeedbacks } from '@/lib/makeupFeedback'
import { applyLegacyStopDates } from '@/lib/stopDateMigration'
import AppShell from '@/components/layout/AppShell'
import DashboardPage from '@/pages/Dashboard'
import StudentsPage from '@/pages/Students'
import SchedulePage from '@/pages/Schedule'
import GroupsPage from '@/pages/Groups'
import KnowledgePage from '@/pages/Knowledge'
import CheckInPage from '@/pages/CheckIn'
import FinancePage from '@/pages/Finance'
import FeedbackPage from '@/pages/Feedback'
import ReportsPage from '@/pages/Reports'
import SettingsPage from '@/pages/Settings'

export default function App() {
  const init = useSettings((s) => s.init)
  const loaded = useSettings((s) => s.loaded)

  // 后台自动同步：syncEnabled 开启且 Supabase 配置后，定时 + 变更触发
  useAutoSync()

  useEffect(() => {
    void init()
  }, [init])

  // 启动后的一次性本地数据维护（等设置加载完再执行，避免把「尚未读到云端配置」当成纯本地）：
  //  1) 未配置云端 → 清理本地墓碑（没有云端可复活，留着只会长期堆积）；
  //     已配置云端 → 必须保留墓碑，等 pushAll 推送成功后自行清理；
  //  2) 旧打卡任务固化 ruleIds（否则之后新增规则会追溯影响历史积分）；
  //  3) v31.36：清理历史「补课课程」自动生成的打卡任务（幂等，软删可推云端）；
  //  4) v31.37：清理历史「补课课程」的课后反馈（幂等，软删可推云端）；
  //  5) v31.41：补录历史停课起始日（幂等，仅对名单里还没有日期的学生生效）。
  useEffect(() => {
    if (!loaded) return
    if (!isSupabaseConfigured(useSettings.getState().settings)) {
      void purgeTombstones()
    }
    void ensureCheckInRuleBindings()
    void purgeMakeupAutoCheckInTasks()
    void purgeMakeupCourseFeedbacks()
    void applyLegacyStopDates()
  }, [loaded])

  if (!loaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-1">
        <p className="text-sm text-text-2">正在加载…</p>
      </div>
    )
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/checkin" element={<CheckInPage />} />
        {/* 课堂积分已合并进「打卡与积分」，旧链接重定向到对应 Tab */}
        <Route
          path="/classpoints"
          element={<Navigate to="/checkin?tab=class" replace />}
        />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
