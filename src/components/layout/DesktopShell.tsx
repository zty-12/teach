import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { GraduationCap } from 'lucide-react'
import { NAV_ITEMS } from './nav'
import { cn } from '@/lib/utils'

/**
 * PC 端外壳：左侧固定导航 + 右侧宽内容区。
 * 面向「坐下来排课、批量处理、看账」的高信息密度场景。
 */
export default function DesktopShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-surface-1">
      {/* 左侧导航 */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-line-1 bg-surface-0">
        <div className="flex h-14 items-center gap-2 border-b border-line-1 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent">
            <GraduationCap size={16} className="text-white" />
          </div>
          <span className="text-[15px] font-medium text-text-1">教务工作台</span>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent-text'
                    : 'text-text-2 hover:bg-surface-2 hover:text-text-1',
                )
              }
            >
              <item.icon size={17} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line-1 p-3 text-[11px] leading-relaxed text-text-3">
          数据保存在本机浏览器
          <br />
          可配置云端同步
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1440px] p-6">{children}</div>
      </main>
    </div>
  )
}
