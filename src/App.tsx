import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useSettings } from '@/store/useSettings'
import { useAutoSync } from '@/hooks/useAutoSync'
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
