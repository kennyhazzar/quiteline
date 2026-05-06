'use client'

import { Button, Stack, Text, Title } from '@mantine/core'
import { useI18n } from '@/lib/i18n'

interface LoadingPageProps {
  isMobile: boolean
  onLogout: () => void
}

export function LoadingPage({ isMobile, onLogout }: LoadingPageProps) {
  const { t } = useI18n()
  return (
    <Stack maw={520} mx={isMobile ? 'auto' : 0} px={isMobile ? 'xs' : 0}>
      <Title order={1}>Quietline</Title>
      <Text c="dimmed">{t('loadingProfile')}</Text>
      <Button variant="subtle" onClick={onLogout}>{t('logout')}</Button>
    </Stack>
  )
}
