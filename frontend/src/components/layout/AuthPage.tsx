'use client'

import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { IconShieldCheck } from '@tabler/icons-react'
import { useI18n } from '@/lib/i18n'

interface AuthPageProps {
  authMode: 'login' | 'register'
  username: string
  password: string
  displayName: string
  totpCode: string
  totpRequired: boolean
  authError: string
  isMobile: boolean
  isPending: boolean
  onSetAuthMode: (mode: 'login' | 'register') => void
  onSetUsername: (v: string) => void
  onSetPassword: (v: string) => void
  onSetDisplayName: (v: string) => void
  onSetTotpCode: (v: string) => void
  onSubmit: () => void
}

export function AuthPage(props: AuthPageProps) {
  const {
    authMode,
    username,
    password,
    displayName,
    totpCode,
    totpRequired,
    authError,
    isMobile,
    isPending,
    onSetAuthMode,
    onSetUsername,
    onSetPassword,
    onSetDisplayName,
    onSetTotpCode,
    onSubmit,
  } = props
  const { t } = useI18n()

  const isDisabled = !username.trim() || password.length < 8 || (totpRequired && totpCode.trim().length < 6)

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSubmit()
  }

  const form = (
    <Stack gap="md">
      <SegmentedControl
        className="auth-switch"
        fullWidth
        value={authMode}
        onChange={(v) => onSetAuthMode(v as 'login' | 'register')}
        data={[
          { value: 'login', label: t('login') },
          { value: 'register', label: t('createAccount') },
        ]}
      />
      <TextInput
        label={t('loginName')}
        placeholder="alice"
        value={username}
        autoComplete="username"
        onChange={(e) => onSetUsername(e.currentTarget.value)}
        onKeyDown={handleKey}
      />
      {authMode === 'register' && (
        <TextInput
          label={t('displayName')}
          placeholder="Alice"
          value={displayName}
          autoComplete="name"
          onChange={(e) => onSetDisplayName(e.currentTarget.value)}
          onKeyDown={handleKey}
        />
      )}
      <PasswordInput
        label={t('password')}
        value={password}
        autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
        onChange={(e) => onSetPassword(e.currentTarget.value)}
        onKeyDown={handleKey}
      />
      {totpRequired && authMode === 'login' && (
        <TextInput
          label={t('twoFactorCode')}
          placeholder="123456"
          value={totpCode}
          inputMode="numeric"
          error={authError || undefined}
          onChange={(e) => onSetTotpCode(e.currentTarget.value)}
          onKeyDown={handleKey}
        />
      )}
      {authError && !totpRequired && (
        <Alert color="red" variant="light">{authError}</Alert>
      )}
      <Button fullWidth size="md" onClick={onSubmit} loading={isPending} disabled={isDisabled}>
        {authMode === 'register' ? t('createAccount') : t('login')}
      </Button>
      <Button
        variant="subtle"
        fullWidth
        onClick={() => onSetAuthMode(authMode === 'login' ? 'register' : 'login')}
      >
        {authMode === 'login' ? t('needAccount') : t('alreadyHaveAccount')}
      </Button>
      <Text size="xs" c="dimmed" ta="center">{t('passwordHint')}</Text>
    </Stack>
  )

  // ─── Mobile layout ────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <Box className="auth-mobile-page">
        <Stack className="auth-mobile-brand" align="center" justify="center" gap="xs">
          <Box className="auth-mobile-icon">
            <IconShieldCheck size={36} stroke={1.6} color="white" />
          </Box>
          <Text className="auth-mobile-wordmark">Quietline</Text>
          <Text size="sm" c="dimmed" ta="center" maw={260} lh={1.45}>
            {t('quietlineIntro')}
          </Text>
        </Stack>

        <Box className="auth-mobile-sheet">
          <Box className="auth-mobile-handle" />
          <Stack gap={4} mb="lg">
            <Text fw={700} size="xl">
              {authMode === 'register' ? t('createAccount') : t('login')}
            </Text>
            {authMode === 'register' && (
              <Text size="sm" c="dimmed">{t('passwordHint')}</Text>
            )}
          </Stack>
          {form}
        </Box>
      </Box>
    )
  }

  // ─── Desktop layout ───────────────────────────────────────────────────────
  return (
    <Box className="auth-page">
      <Group className="auth-shell" align="stretch" wrap="nowrap">
        <Stack className="auth-copy" justify="space-between">
          <div>
            <Badge variant="light" color="blue" mb="md">{t('encryptedBadge')}</Badge>
            <Title order={1} className="auth-title">Quietline</Title>
            <Text c="dimmed" size="lg" maw={520}>{t('quietlineIntro')}</Text>
          </div>
          <Stack gap="xs">
            <Text fw={700}>{t('authFeatureTitle')}</Text>
            <Text size="sm" c="dimmed">{t('authFeatureText')}</Text>
          </Stack>
        </Stack>

        <Card className="auth-card" withBorder>
          <Stack gap="md">
            <div>
              <Title order={2}>{authMode === 'register' ? t('createAccount') : t('login')}</Title>
              <Text size="sm" c="dimmed">
                {authMode === 'register' ? t('passwordHint') : t('quietlineIntro')}
              </Text>
            </div>
            {form}
          </Stack>
        </Card>
      </Group>
    </Box>
  )
}
