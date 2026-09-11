import { useEffect, useState } from 'react'

/**
 * 断点检测。用于切换 PC / 平板 / 移动三套组件树，
 * 而不是单纯用 CSS 响应式隐藏元素。
 */
export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

function detect(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop'
  const w = window.innerWidth
  if (w >= 1024) return 'desktop'
  if (w >= 768) return 'tablet'
  return 'mobile'
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(detect)

  useEffect(() => {
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setBp(detect()))
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  return bp
}

export const isTouchLayout = (bp: Breakpoint) => bp === 'mobile' || bp === 'tablet'
