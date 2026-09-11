import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { GraduationCap } from 'lucide-react'
import { NAV_ITEMS } from './nav'
import { cn } from '@/lib/utils'

/**
 * 平板外壳（768–1023px）：窄图标侧栏 + 单列内容区。
 * 介于 PC 与手机之间——保留导航常驻，但压缩横向占用。
 */
export default function TabletShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-surface-1">
      <aside className="flex w-16 shrink-0 flex-col items-center border-r border-line-1 bg-surface-0">
        <div className="flex h-14 w-full items-center justify-center border-b border-line-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent">
            <GraduationCap size={16} className="text-white" />
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              title={item.label}
              aria-label={item.label}
              className={({ isActive }) =>
                cn(
                  'flex h-11 w-12 flex-col items-center justify-center rounded-lg transition-colors',
                  isActive
                    ? 'bg-accent-soft text-accent-text'
                    : 'text-text-3 hover:bg-surface-2 hover:text-text-1',
                )
              }
            >
              <item.icon size={19} />
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[900px] p-5">{children}</div>
      </main>
    </div>
  )
}
