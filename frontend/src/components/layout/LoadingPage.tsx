'use client'

import { Button, Loader, Stack, Text } from '@mantine/core'
import { IconShieldCheck } from '@tabler/icons-react'
import { useI18n } from '@/lib/i18n'

interface LoadingPageProps {
  isMobile: boolean
  onLogout: () => void
}

export function LoadingPage({ isMobile, onLogout }: LoadingPageProps) {
  const { t } = useI18n()

  if (isMobile) {
    return (
      <div className="auth-mobile-page">
        <Stack className="auth-mobile-brand" align="center" justify="center" gap="xs">
          <div className="auth-mobile-icon">
            <IconShieldCheck size={36} stroke={1.6} color="white" />
          </div>
          <Text className="auth-mobile-wordmark">Quietline</Text>
          <Loader color="rgba(255,255,255,0.8)" type="dots" size="md" mt="sm" />
          <Text size="sm" ta="center" maw={260} lh={1.45} mt="xs" style={{ color: 'rgba(255,255,255,0.7)' }}>
            {t('loadingProfile')}
          </Text>
          <Button
            variant="subtle"
            size="xs"
            mt="xl"
            onClick={onLogout}
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            {t('logout')}
          </Button>
        </Stack>
      </div>
    )
  }

  return (
    <div className="loading-page">
      <div className="loading-card">
        <div className="loading-icon">
          <IconShieldCheck size={36} stroke={1.6} color="var(--mantine-color-blue-5)" />
        </div>
        <Text fw={800} fz={26} mt="md" lh={1}>Quietline</Text>
        <Loader type="dots" size="sm" mt="xl" />
        <Text size="sm" c="dimmed" mt="xs" maw={240} lh={1.5} ta="center">
          {t('loadingProfile')}
        </Text>
        <Button variant="subtle" size="xs" mt="xl" c="dimmed" onClick={onLogout}>
          {t('logout')}
        </Button>
      </div>
    </div>
  )
}
