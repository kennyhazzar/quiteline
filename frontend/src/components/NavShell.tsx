'use client'
import { ActionIcon, AppShell, Badge, Group, SegmentedControl, Text, useMantineColorScheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconLockSquareRounded, IconMoon, IconSun } from '@tabler/icons-react'
import { useI18n } from '@/lib/i18n'

export function NavShell({ children, onToggleTheme }: { children: React.ReactNode; onToggleTheme?: (theme: 'light' | 'dark') => void }) {
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const { locale, setLocale, t } = useI18n()
  const compact = useMediaQuery('(max-width: 640px)')
  const nextTheme = colorScheme === 'dark' ? 'light' : 'dark'

  function toggleTheme() {
    setColorScheme(nextTheme)
    onToggleTheme?.(nextTheme)
  }

  return (
    <AppShell padding={compact ? 'xs' : 'md'}>
      <AppShell.Header h={compact ? 44 : 56} px={compact ? 'xs' : 'md'}>
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconLockSquareRounded size={compact ? 18 : 22} />
            <Text fw={700} size={compact ? 'sm' : 'md'} truncate>Quietline</Text>
          </Group>
          <Group gap={compact ? 4 : 'xs'} wrap="nowrap">
            {!compact && <Badge variant="light" color="green">{t('encryptedBadge')}</Badge>}
            <SegmentedControl
              size="xs"
              value={locale}
              onChange={(value) => setLocale(value === 'en' ? 'en' : 'ru')}
              data={[
                { value: 'ru', label: 'RU' },
                { value: 'en', label: 'EN' },
              ]}
            />
            <ActionIcon variant="subtle" onClick={toggleTheme} aria-label="Toggle theme">
              {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main pt={compact ? 52 : 72}>{children}</AppShell.Main>
    </AppShell>
  )
}
