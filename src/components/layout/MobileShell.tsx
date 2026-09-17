import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { MORE_ITEMS, TAB_ITEMS, type NavItem } from './nav'
import { cn } from '@/lib/utils'

/**
 * 移动端外壳：flex 纵向铺满视口 + 底部固定 Tab。
 * 面向「在外面跑课、随手处理」的场景。
 * 底部 Tab 常驻拇指可达区，触控目标 44px 以上。
 *
 * 底部 Tab = 5 个高频直达（工作台/学生/课表/知识库/打卡）+「更多」弹层
 * （班课/财务/反馈/报告/设置），保证新增页面在手机上也有入口。
 *
 * 用「视口高度 flex 布局」而不是 position:fixed：main 内部滚动，
 * 底部 Tab 作为 flex 尾行常驻，即使在很长页面（如班课列表）也始终可见，
 * 天然规避部分手机浏览器 position:fixed 随内容滚动的 bug。
 */
export default function MobileShell({ children }: { children: ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const location = useLocation()

  // 路由变化即收起「更多」弹层
  useEffect(() => {
    setMoreOpen(false)
  }, [location.pathname])

  const moreActive = MORE_ITEMS.some((i) => i.to === location.pathname)

  return (
    <div className="flex h-dvh flex-col bg-surface-1">
      <main className="flex-1 overflow-y-auto pt-safe px-4 pb-4">{children}</main>

      <nav className="shrink-0 border-t border-line-1 bg-surface-0 pb-safe">
        <div className="flex">
          {TAB_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex flex-1 flex-col items-center justify-center gap-1 py-2 transition-colors',
                  isActive ? 'text-accent' : 'text-text-3',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon size={21} strokeWidth={isActive ? 2.2 : 1.8} />
                  <span className="text-[11px] leading-none">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
          <NavTabButton
            item={{ to: '', label: '更多', icon: MoreHorizontal, inTab: false }}
            active={moreActive || moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          />
        </div>
      </nav>

      {moreOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setMoreOpen(false)} />
          {/*
            「更多」面板：一行放下全部入口的紧凑浮层。
            ⚠ 不要改回「贴底通栏大面板」：4 列 5 项会多出一行只放 1 项，
            面板高度翻倍且视觉上占了半屏（2026-09-17 用户反馈「占比超过一半」）。
            现在 5 列单行 + 浮在 Tab 栏之上，高度约 70px。
          */}
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-50 rounded-2xl border border-line-1 bg-surface-0 p-1.5 shadow-2xl"
          >
            <div className="grid grid-cols-5 gap-0.5">
              {MORE_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] transition-colors',
                      isActive ? 'bg-accent-soft text-accent-text' : 'text-text-2 active:bg-surface-1',
                    )
                  }
                >
                  <item.icon size={20} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** 底部 Tab 里的非路由按钮（「更多」） */
function NavTabButton({
  item,
  active,
  onClick,
}: {
  item: NavItem
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-1 py-2 transition-colors',
        active ? 'text-accent' : 'text-text-3',
      )}
    >
      <item.icon size={21} strokeWidth={active ? 2.2 : 1.8} />
      <span className="text-[11px] leading-none">{item.label}</span>
    </button>
  )
}
