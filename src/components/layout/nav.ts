import {
  Award,
  BookOpen,
  CalendarCheck,
  CalendarDays,
  FileBarChart,
  LayoutDashboard,
  MessageSquareText,
  Settings,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** 是否直接出现在移动端底部 Tab；false 的进「更多」弹层 */
  inTab: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '工作台', icon: LayoutDashboard, inTab: true },
  { to: '/students', label: '学生', icon: Users, inTab: true },
  { to: '/schedule', label: '课表', icon: CalendarDays, inTab: true },
  { to: '/knowledge', label: '知识库', icon: BookOpen, inTab: true },
  { to: '/checkin', label: '打卡', icon: CalendarCheck, inTab: true },
  { to: '/classpoints', label: '课堂积分', icon: Award, inTab: false },
  { to: '/groups', label: '班课', icon: BookOpen, inTab: false },
  { to: '/finance', label: '财务', icon: Wallet, inTab: false },
  { to: '/feedback', label: '反馈', icon: MessageSquareText, inTab: false },
  { to: '/reports', label: '报告', icon: FileBarChart, inTab: false },
  { to: '/settings', label: '设置', icon: Settings, inTab: false },
]

/** 移动端底部 Tab：5 个直达 + 1 个「更多」 */
export const TAB_ITEMS = NAV_ITEMS.filter((i) => i.inTab)

/** 移动端「更多」弹层里的页面（不含已在 Tab 里的） */
export const MORE_ITEMS: NavItem[] = NAV_ITEMS.filter((i) => !i.inTab)
