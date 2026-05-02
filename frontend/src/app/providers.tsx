'use client'
import { MantineProvider, useMantineColorScheme } from '@mantine/core'
import { Notifications, notifications } from '@mantine/notifications'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { NavShell } from '@/components/NavShell'
import { updateTheme, type AuthSession } from '@/lib/api'
import { I18nProvider, useI18n } from '@/lib/i18n'

const SESSION_KEY = 'zk.session.v1'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 0,
            retry: 1,
            refetchOnMount: 'always',
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider defaultColorScheme="dark">
        <I18nProvider>
          <ThemeBridge>
            <Notifications position="top-right" />
            {children}
          </ThemeBridge>
        </I18nProvider>
      </MantineProvider>
    </QueryClientProvider>
  )
}

function ThemeBridge({ children }: { children: React.ReactNode }) {
  const { setColorScheme } = useMantineColorScheme()
  const { t } = useI18n()

  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY)
    if (!saved) return
    const session = JSON.parse(saved) as AuthSession
    if (session.principal.theme === 'light' || session.principal.theme === 'dark') {
      setColorScheme(session.principal.theme)
    }
  }, [setColorScheme])

  async function persistTheme(theme: 'light' | 'dark') {
    const saved = localStorage.getItem(SESSION_KEY)
    if (!saved) return
    try {
      const session = JSON.parse(saved) as AuthSession
      const principal = await updateTheme({ token: session.accessToken, theme })
      const nextSession: AuthSession = { ...session, principal }
      localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
    } catch (err) {
      notifications.show({
        title: t('saveLocalThemeFailed'),
        message: err instanceof Error ? err.message : t('saveLocalThemeFailedMessage'),
        color: 'yellow',
      })
    }
  }

  return <NavShell onToggleTheme={persistTheme}>{children}</NavShell>
}
