import type { ReactNode } from 'react'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import DesktopShell from './DesktopShell'
import TabletShell from './TabletShell'
import MobileShell from './MobileShell'

/**
 * 布局外壳：按断点渲染**三套不同的组件树**。
 * 不是 CSS 隐藏/显示，而是真正独立的结构，
 * 因此 PC 与移动端可以有完全不同的导航、间距与交互。
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const bp = useBreakpoint()

  if (bp === 'desktop') return <DesktopShell>{children}</DesktopShell>
  if (bp === 'tablet') return <TabletShell>{children}</TabletShell>
  return <MobileShell>{children}</MobileShell>
}
