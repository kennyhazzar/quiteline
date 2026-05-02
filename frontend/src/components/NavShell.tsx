'use client'
import { AppShell } from '@mantine/core'

export function NavShell({ children, onToggleTheme }: { children: React.ReactNode; onToggleTheme?: (theme: 'light' | 'dark') => void }) {
  void onToggleTheme

  return (
    <AppShell padding={0}>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  )
}
