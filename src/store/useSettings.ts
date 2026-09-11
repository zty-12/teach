import { create } from 'zustand'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '@/lib/db'
import type { AppSettings } from '@/lib/types'

const THEME_KEY = 'ew-theme'

/** 解析主题模式 → 实际明暗 */
function resolveTheme(mode: AppSettings['themeMode']): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

/** 应用主题到 <html data-theme> */
function applyTheme(mode: AppSettings['themeMode']) {
  const theme = resolveTheme(mode)
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(theme))
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

/** 把自定义科目配色写入 CSS 变量 */
function applySubjectColors(colors: string[]) {
  const root = document.documentElement
  colors.forEach((color, i) => {
    root.style.setProperty(`--subject-${i + 1}`, color)
  })
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  init: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
  /** 同步拉取后整体替换本地设置（不触发写库） */
  applyRemote: (next: AppSettings) => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,

  init: async () => {
    const s = await loadSettings()
    applyTheme(s.themeMode)
    applySubjectColors(s.subjectColors)
    set({ settings: s, loaded: true })

    // 跟随系统时，监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (useSettings.getState().settings.themeMode === 'system') {
        applyTheme('system')
      }
    })
  },

  update: async (patch) => {
    // 乐观更新：先把结果立即回显到界面，再异步写库。
    // 修复中文输入法（IME）组字期间被旧值打断的问题——
    // 受控 input 的 value 来自 store，若等 IndexedDB 写完才 set，
    // 组字过程中 React 会把输入框重置回旧值，拼音字母被逐个固化成
    // 「zzhzhaozhao赵老师」这类乱串。
    const prev = get().settings
    set({ settings: { ...prev, ...patch } })
    try {
      const next = await saveSettings(patch)
      applyTheme(next.themeMode)
      applySubjectColors(next.subjectColors)
      set({ settings: next })
    } catch (e) {
      set({ settings: prev }) // 写库失败回滚
      throw e
    }
  },

  applyRemote: (next) => {
    applyTheme(next.themeMode)
    applySubjectColors(next.subjectColors)
    set({ settings: next })
  },
}))

/** 取当前实际主题（组件内用于图标切换等） */
export function useResolvedTheme(): 'light' | 'dark' {
  const mode = useSettings((s) => s.settings.themeMode)
  return resolveTheme(mode)
}
