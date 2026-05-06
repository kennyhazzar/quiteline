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

export function AuthPage({
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
}: AuthPageProps) {
  const { t } = useI18n()

  return (
    <Box className="auth-page">
      <Group className="auth-shell" align="stretch" wrap="nowrap">
        <Stack className="auth-copy" justify="space-between">
          <div>
            <Badge variant="light" color="blue" mb="md">{t('encryptedBadge')}</Badge>
            <Title order={1} className="auth-title">Quietline</Title>
            <Text c="dimmed" size="lg" maw={520}>{t('quietlineIntro')}</Text>
          </div>
          {!isMobile && (
            <Stack gap="xs">
              <Text fw={700}>{t('authFeatureTitle')}</Text>
              <Text size="sm" c="dimmed">{t('authFeatureText')}</Text>
            </Stack>
          )}
        </Stack>

        <Card className="auth-card" withBorder>
          <Stack gap="md">
            <div>
              <Title order={2}>{authMode === 'register' ? t('createAccount') : t('login')}</Title>
              {(authMode === 'register' || !isMobile) && (
                <Text size="sm" c="dimmed">
                  {authMode === 'register' ? t('passwordHint') : t('quietlineIntro')}
                </Text>
              )}
            </div>
            <SegmentedControl
              className="auth-switch"
              fullWidth
              value={authMode}
              onChange={(value) => onSetAuthMode(value as 'login' | 'register')}
              data={[
                { value: 'login', label: t('login') },
                { value: 'register', label: t('createAccount') },
              ]}
            />
            <TextInput
              label={t('loginName')}
              placeholder="alice"
              value={username}
              onChange={(event) => onSetUsername(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSubmit()
              }}
            />
            {authMode === 'register' && (
              <TextInput
                label={t('displayName')}
                placeholder="Alice"
                value={displayName}
                onChange={(event) => onSetDisplayName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSubmit()
                }}
              />
            )}
            <PasswordInput
              label={t('password')}
              value={password}
              onChange={(event) => onSetPassword(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSubmit()
              }}
            />
            {totpRequired && authMode === 'login' && (
              <TextInput
                label={t('twoFactorCode')}
                placeholder="123456"
                value={totpCode}
                error={authError || undefined}
                onChange={(event) => onSetTotpCode(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSubmit()
                }}
              />
            )}
            {authError && !totpRequired && (
              <Alert color="red" variant="light">
                {authError}
              </Alert>
            )}
            <Button
              fullWidth
              size="md"
              onClick={onSubmit}
              loading={isPending}
              disabled={!username.trim() || password.length < 8 || (totpRequired && totpCode.trim().length < 6)}
            >
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
        </Card>
      </Group>
    </Box>
  )
}
