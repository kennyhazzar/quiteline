'use client'

import { notifications } from '@mantine/notifications'
import { useMutation } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import {
  AuthError,
  fetchCurrentIdentity,
  isTwoFactorChallenge,
  loginUser,
  registerUser,
  updateTheme,
  type AuthSession,
  type Identity,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import {
  accountScopedKey,
  LOCAL_DELETED_MESSAGES_KEY,
  readStoredJSON,
  ROOM_SECRETS_KEY,
} from '@/types/messenger'

export interface UseSessionReturn {
  session: AuthSession | null
  identity: Identity | null
  authMode: 'login' | 'register'
  username: string
  password: string
  totpCode: string
  authError: string
  totpRequired: boolean
  displayName: string
  avatarVersion: number
  setAuthMode: (mode: 'login' | 'register') => void
  setUsername: (v: string) => void
  setPassword: (v: string) => void
  setTotpCode: (v: string) => void
  setAuthError: (v: string) => void
  setDisplayName: (v: string) => void
  setIdentity: (id: Identity | null) => void
  setAvatarVersion: (v: number) => void
  saveSession: (next: AuthSession, options?: { reloadLocalState?: boolean }) => void
  updateSessionPrincipal: (principal: AuthSession['principal']) => void
  handleAuthExpired: () => void
  logoutLocal: () => void
  submitAuth: () => void
  toggleTheme: () => void
  /** Call this after login/session restore to load local account storage */
  loadAccountLocalState: (
    target: AuthSession,
    callbacks: LoadLocalStateCallbacks,
  ) => void
  clearAccountLocalState: (callbacks: ClearLocalStateCallbacks) => void
  authMutation: ReturnType<typeof useMutation>
  authExpiredNotifiedRef: React.MutableRefObject<boolean>
  accountStorageID: (target?: AuthSession | null) => string
  colorScheme: string
  setColorScheme: (scheme: 'light' | 'dark') => void
}

export interface LoadLocalStateCallbacks {
  setRoomSecrets: (s: Record<string, string>) => void
  setLocalDeletedMessageIDs: (d: Record<string, true>) => void
  setActiveRoomID: (id: string) => void
  setHighlightedMessageID: (id: string) => void
  setLiveMessages: (msgs: never[]) => void
  setPendingMessages: (msgs: never[]) => void
  setTypingUsers: (users: Record<string, never>) => void
  setPresence: (p: Record<string, never>) => void
  setMobileChatActionsOpened: (v: boolean) => void
  setLeaveConfirmOpened: (v: boolean) => void
  setTotpRequired: (v: boolean) => void
  setTotpCode: (v: string) => void
  setMobileView?: (v: 'rooms') => void
  setSidebarView?: (v: 'rooms') => void
  onIdentityLoaded: (identity: Identity) => void
  onAuthExpired: () => void
}

export interface ClearLocalStateCallbacks {
  setRoomSecrets: (s: Record<string, string>) => void
  setLocalDeletedMessageIDs: (d: Record<string, true>) => void
  setActiveRoomID: (id: string) => void
  setHighlightedMessageID: (id: string) => void
  setLiveMessages: (msgs: never[]) => void
  setPendingMessages: (msgs: never[]) => void
  setTypingUsers: (users: Record<string, never>) => void
  setPresence: (p: Record<string, never>) => void
  setMobileView: (v: 'rooms') => void
  setSidebarView: (v: 'rooms') => void
  setMobileChatActionsOpened: (v: boolean) => void
  setLeaveConfirmOpened: (v: boolean) => void
}

export function useSession(opts: {
  colorScheme: string
  setColorScheme: (scheme: 'light' | 'dark') => void
  queryClientClear: () => void
  wsClose: () => void
  isMobile: boolean
  sendRealtimePresenceOffline?: () => void
}) {
  const { colorScheme, setColorScheme, queryClientClear, wsClose, isMobile, sendRealtimePresenceOffline } = opts
  const { t } = useI18n()

  const [session, setSession] = useState<AuthSession | null>(null)
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [authError, setAuthError] = useState('')
  const [totpRequired, setTotpRequired] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [avatarVersion, setAvatarVersion] = useState(Date.now())

  const authExpiredNotifiedRef = useRef(false)

  function accountStorageID(target: AuthSession | null = session) {
    return target?.principal.userId || target?.principal.clientId || ''
  }

  const saveSession = useCallback((next: AuthSession, options: { reloadLocalState?: boolean } = { reloadLocalState: true }) => {
    authExpiredNotifiedRef.current = false
    setSession(next)
    // reloadLocalState is handled by callers who pass callbacks
  }, [])

  const updateSessionPrincipal = useCallback((principal: AuthSession['principal']) => {
    setSession((prev) => {
      if (!prev) return prev
      const next = { ...prev, principal }
      return next
    })
  }, [])

  const handleAuthExpired = useCallback(() => {
    if (authExpiredNotifiedRef.current) return
    authExpiredNotifiedRef.current = true
    setSession(null)
    wsClose()
    queryClientClear()
    notifications.show({ title: t('sessionExpired'), message: t('sessionExpiredMessage'), color: 'yellow' })
  }, [queryClientClear, t, wsClose])

  function loadAccountLocalState(
    target: AuthSession,
    callbacks: LoadLocalStateCallbacks,
  ) {
    const accountId = accountStorageID(target)
    const savedSecrets = accountId
      ? readStoredJSON<Record<string, string>>(accountScopedKey(ROOM_SECRETS_KEY, accountId))
      : null
    const deletedMessages = accountId
      ? readStoredJSON<Record<string, true>>(accountScopedKey(LOCAL_DELETED_MESSAGES_KEY, accountId))
      : null

    setIdentity(null)
    callbacks.setRoomSecrets(savedSecrets ?? {})
    callbacks.setLocalDeletedMessageIDs(deletedMessages ?? {})
    callbacks.setActiveRoomID('')
    callbacks.setHighlightedMessageID('')
    callbacks.setLiveMessages([])
    callbacks.setPendingMessages([])
    callbacks.setTypingUsers({} as Record<string, never>)
    callbacks.setPresence({} as Record<string, never>)
    callbacks.setMobileChatActionsOpened(false)
    callbacks.setLeaveConfirmOpened(false)
    callbacks.setTotpRequired(false)
    callbacks.setTotpCode('')
    if (isMobile) {
      callbacks.setMobileView?.('rooms')
    } else {
      callbacks.setSidebarView?.('rooms')
    }
    fetchCurrentIdentity(target.accessToken)
      .then((id) => {
        setIdentity(id)
        callbacks.onIdentityLoaded(id)
      })
      .catch((err: Error) => {
        if (err instanceof AuthError) {
          callbacks.onAuthExpired()
        } else {
          notifications.show({ title: t('profileTitle'), message: err.message, color: 'red' })
        }
      })
  }

  function clearAccountLocalState(callbacks: ClearLocalStateCallbacks) {
    setIdentity(null)
    callbacks.setRoomSecrets({})
    callbacks.setLocalDeletedMessageIDs({})
    callbacks.setActiveRoomID('')
    callbacks.setHighlightedMessageID('')
    callbacks.setLiveMessages([])
    callbacks.setPendingMessages([])
    callbacks.setTypingUsers({} as Record<string, never>)
    callbacks.setPresence({} as Record<string, never>)
    callbacks.setMobileView('rooms')
    callbacks.setSidebarView('rooms')
    callbacks.setMobileChatActionsOpened(false)
    callbacks.setLeaveConfirmOpened(false)
  }

  async function toggleTheme() {
    const theme = colorScheme === 'dark' ? 'light' : 'dark'
    setColorScheme(theme as 'light' | 'dark')
    if (!session) return
    try {
      const principal = await updateTheme({ token: session.accessToken, theme: theme as 'light' | 'dark' })
      updateSessionPrincipal(principal)
    } catch (err) {
      notifications.show({
        title: t('saveLocalThemeFailed'),
        message: err instanceof Error ? err.message : t('saveLocalThemeFailedMessage'),
        color: 'yellow',
      })
    }
  }

  const authMutation = useMutation({
    onMutate: () => {
      setAuthError('')
    },
    mutationFn: () => {
      if (authMode === 'register') {
        return registerUser({ username, password, displayName: displayName.trim() || username })
      }
      return loginUser({ username, password, totpCode: totpCode.trim() || undefined })
    },
    onSuccess: (next) => {
      if (isTwoFactorChallenge(next)) {
        setTotpRequired(true)
        setAuthError('')
        notifications.show({ title: t('login'), message: t('twoFactorPrompt'), color: 'blue' })
        return
      }
      // Session save is handled by callers via onSessionReady
      authExpiredNotifiedRef.current = false
      setSession(next)
      setColorScheme(next.principal.theme)
      setDisplayName(next.principal.username || username)
      setTotpRequired(false)
      setTotpCode('')
      setAuthError('')
      notifications.show({ title: authMode === 'register' ? t('createAccount') : t('login'), message: t('sessionReady'), color: 'green' })
    },
    onError: (err: Error) => {
      if (err instanceof AuthError) {
        handleAuthExpired()
        return
      }
      setAuthError(totpRequired ? t('invalidTwoFactor') : err.message)
    },
  })

  function submitAuth() {
    if (!username.trim() || password.length < 8 || authMutation.isPending) return
    authMutation.mutate()
  }

  function logoutLocal() {
    sendRealtimePresenceOffline?.()
    setSession(null)
    wsClose()
    queryClientClear()
  }

  return {
    session,
    setSession,
    identity,
    setIdentity,
    authMode,
    setAuthMode,
    username,
    setUsername,
    password,
    setPassword,
    totpCode,
    setTotpCode,
    authError,
    setAuthError,
    totpRequired,
    setTotpRequired,
    displayName,
    setDisplayName,
    avatarVersion,
    setAvatarVersion,
    authExpiredNotifiedRef,
    saveSession,
    updateSessionPrincipal,
    handleAuthExpired,
    loadAccountLocalState,
    clearAccountLocalState,
    toggleTheme,
    authMutation,
    submitAuth,
    logoutLocal,
    accountStorageID,
    colorScheme,
    setColorScheme,
  }
}
