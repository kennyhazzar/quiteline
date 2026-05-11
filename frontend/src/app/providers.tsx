'use client'
import { MantineProvider, useMantineColorScheme } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { NavShell } from '@/components/NavShell'
import { I18nProvider } from '@/lib/i18n'

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

  async function persistTheme(theme: 'light' | 'dark') {
    setColorScheme(theme)
  }

  return <NavShell onToggleTheme={persistTheme}>{children}</NavShell>
}
