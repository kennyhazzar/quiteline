'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMediaQuery } from '@mantine/hooks'
import { useMantineColorScheme } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  absoluteAvatarUrl,
  appendCallLog,
  AuthError,
  beginTOTPSetup,
  confirmTOTP,
  createRoom,
  inviteFriendToRoom,
  disableTOTP,
  fetchAccountSessions,
  fetchCurrentIdentity,
  fetchCurrentPrincipal,
  fetchHealth,
  fetchRooms,
  isTwoFactorChallenge,
  leaveRoom,
  listCallLogs,
  loginUser,
  logoutSession,
  refreshSession,
  registerUser,
  revokeAccountSession,
  revokeOtherAccountSessions,
  sendEncryptedMessage,
  updateTheme,
  uploadAvatar,
  WS_BASE,
  type AccountSession,
  type AuthSession,
  type CallLog,
  type EncryptedMessage,
  type Friend,
  type Identity,
  type MessageEnvelope,
  type Room,
} from '@/lib/api'
import { compressAvatar } from '@/lib/avatar'
import { createRoomSecret, encodePlainMessage } from '@/lib/crypto'
import { useI18n } from '@/lib/i18n'
import {
  type AppView,
  type CallState,
  type DecryptedMessage,
  type RealtimeEvent,
  accountScopedKey,
  buildAppURL,
  createInviteToken,
  formatLastSeen,
  LOCAL_DELETED_MESSAGES_KEY,
  readStoredJSON,
  replaceAppURL,
  ROOM_SECRETS_KEY,
} from '@/types/messenger'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useMessages } from '@/hooks/useMessages'
import { useIdentity } from '@/hooks/useIdentity'
import { useFriends } from '@/hooks/useFriends'
import { useRooms } from '@/hooks/useRooms'
import { AppShellLayout } from './layout/AppShell'
import { AuthPage } from './layout/AuthPage'
import { LoadingPage } from './layout/LoadingPage'

const APP_VIEWS: AppView[] = ['chat', 'rooms', 'profile', 'contacts', 'settings']

function appViewFromParam(value: string | null): AppView {
  if (value === 'chats') return 'rooms'
  if (value && APP_VIEWS.includes(value as AppView)) return value as AppView
  return 'rooms'
}

function appRouteFromPath(pathname: string) {
  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  if (parts[0] === 'profile') return { view: 'settings' as AppView }
  if (parts[0] !== 'chats') return {}
  const roomId = parts[1]
  const messageId = parts[2] === 'messages' ? parts[3] : undefined
  return {
    view: roomId ? ('chat' as AppView) : ('rooms' as AppView),
    roomId,
    messageId,
  }
}

export function MessengerApp() {
  const queryClient = useQueryClient()
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const { locale, setLocale, t } = useI18n()
  const isMobile = useMediaQuery('(max-width: 767px)') ?? false
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1180px)') ?? false

  // ─── Auth & session state ──────────────────────────────────────────────────
  const [session, setSession] = useState<AuthSession | null>(null)
  const [sessionBootstrapped, setSessionBootstrapped] = useState(false)
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

  // ─── Room / nav state ──────────────────────────────────────────────────────
  const [activeRoomID, setActiveRoomID] = useState('')
  const [highlightedMessageID, setHighlightedMessageID] = useState('')
  const [roomSecrets, setRoomSecrets] = useState<Record<string, string>>({})
  const [localDeletedMessageIDs, setLocalDeletedMessageIDs] = useState<Record<string, true>>({})
  const [mobileView, setMobileView] = useState<AppView>('rooms')
  const [sidebarView, setSidebarView] = useState<AppView>('rooms')
  const [roomName, setRoomName] = useState('')
  const [newRoomSecret, setNewRoomSecret] = useState('')
  const [roomSecret, setRoomSecret] = useState('')
  const [inviteText, setInviteText] = useState('')
  const [roomSearch, setRoomSearch] = useState('')
  const [leavingRoom, setLeavingRoom] = useState(false)

  // ─── UI modal state ────────────────────────────────────────────────────────
  const [mobileChatActionsOpened, setMobileChatActionsOpened] = useState(false)
  const [mobileCreateRoomOpened, setMobileCreateRoomOpened] = useState(false)
  const [mobileImportInviteOpened, setMobileImportInviteOpened] = useState(false)
  const [leaveConfirmOpened, setLeaveConfirmOpened] = useState(false)
  const [profileUser, setProfileUser] = useState<Identity | null>(null)
  const [attachmentsOpened, setAttachmentsOpened] = useState(false)

  // ─── Presence / typing ────────────────────────────────────────────────────
  const [typingUsers, setTypingUsers] = useState<Record<string, { displayName: string; until: number }>>({})
  const [presence, setPresence] = useState<Record<string, { displayName: string; status: 'online' | 'offline'; lastSeenAt: string }>>({})
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')

  // ─── Call state ───────────────────────────────────────────────────────────
  const [callState, setCallState] = useState<CallState>('idle')
  const [incomingCall, setIncomingCall] = useState<Extract<RealtimeEvent, { kind: 'call-offer' }> | null>(null)
  const [callPeerName, setCallPeerName] = useState('')
  const [callPeerID, setCallPeerID] = useState('')
  const [callStatus, setCallStatus] = useState('')
  const [callError, setCallError] = useState('')
  const [callDiagnostics, setCallDiagnostics] = useState<string[]>([])
  const [callStartedAt, setCallStartedAt] = useState('')
  const [callDurationSec, setCallDurationSec] = useState(0)
  const [isCallMuted, setIsCallMuted] = useState(false)
  const [peerVolume, setPeerVolume] = useState(1)
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([])
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedAudioInputId, setSelectedAudioInputId] = useState('')
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState('')
  const myUserIDRef = useRef('')
  const localStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const callAudioEpochRef = useRef<{ startTime: number; chunkDuration: number; senderRate: number } | null>(null)
  const activeCallIDRef = useRef('')
  const activeCallPeerIDRef = useRef('')
  const activeCallRoomIDRef = useRef('')
  const callCallerIDRef = useRef('')
  const callTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioConnectedRef = useRef(false)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const urlStateReadyRef = useRef(false)

  // ─── Derived ───────────────────────────────────────────────────────────────
  const currentUserID = identity?.userId || session?.principal.userId || ''
  myUserIDRef.current = currentUserID
  const currentDisplayName =
    identity?.displayName || session?.principal.displayName || session?.principal.username || ''
  const leftView = isMobile ? mobileView : sidebarView

  const activeSecret = (activeRoomID ? roomSecrets[activeRoomID] : '') || ''

  // ─── helpers ──────────────────────────────────────────────────────────────
  function accountStorageID(target: AuthSession | null = session) {
    return target?.principal.userId || target?.principal.clientId || ''
  }

  function persistRoomSecrets(nextSecrets: Record<string, string>) {
    setRoomSecrets(nextSecrets)
    const accountId = accountStorageID()
    if (accountId) {
      localStorage.setItem(accountScopedKey(ROOM_SECRETS_KEY, accountId), JSON.stringify(nextSecrets))
    }
  }

  function persistLocalDeletedMessages(nextDeleted: Record<string, true>) {
    setLocalDeletedMessageIDs(nextDeleted)
    const accountId = accountStorageID()
    if (accountId) {
      localStorage.setItem(accountScopedKey(LOCAL_DELETED_MESSAGES_KEY, accountId), JSON.stringify(nextDeleted))
    }
  }

  function errorMessage(code: string) {
    const normalized = code.trim()
    const messages: Record<string, string> = {
      account_required: t('errorAccountRequired'),
      avatar_too_large_after_compression: t('errorAvatarTooLarge'),
      call_failed: t('errorCallFailed'),
      invite_format_must_be_roomId_secret: t('errorInviteFormat'),
      leave_failed: t('errorLeaveFailed'),
      login_required: t('errorLoginRequired'),
      message_not_ready: t('errorMessageNotReady'),
      room_not_ready: t('errorChatNotReady'),
      username_required: t('errorUsernameRequired'),
      user_not_found: t('errorUserNotFound'),
    }
    return messages[normalized] ?? normalized
  }

  function handleAuthExpired() {
    if (authExpiredNotifiedRef.current) return
    authExpiredNotifiedRef.current = true
    void queryClient.resetQueries()
    queryClient.clear()
    const previousWS = wsRef.current
    wsRef.current = null
    previousWS?.close()
    clearAccountLocalState()
    setSession(null)
    notifications.show({ title: t('sessionExpired'), message: t('sessionExpiredMessage'), color: 'yellow' })
  }

  function handleRequestError(err: Error, title: string) {
    if (err instanceof AuthError) {
      handleAuthExpired()
      return
    }
    notifications.show({ title, message: errorMessage(err.message), color: 'red' })
  }

  function notifyChat(title: string, message?: string) {
    notifications.show({ title, message, color: 'blue' })
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body: message })
    }
  }

  function requestNotifications() {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => undefined)
    }
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────
  // We need wsRef available for handleAuthExpired, so we declare it early
  const wsRef = useRef<WebSocket | null>(null)
  const wsReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousRoomIDRef = useRef('')

  function sendRealtimeRaw(event: RealtimeEvent) {
    const topic =
      'kind' in event && event.kind.startsWith('call-') && 'toUserId' in event && event.toUserId
        ? `user:${event.toUserId}`
        : 'roomId' in event && event.roomId
        ? `room:${event.roomId}`
        : activeRoomID
          ? `room:${activeRoomID}`
          : ''
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !topic) return
    wsRef.current.send(JSON.stringify({ type: 'publish', topic, data: event }))
  }

  function sendToUserRaw(targetUserId: string, event: RealtimeEvent) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !targetUserId) return
    wsRef.current.send(JSON.stringify({ type: 'publish', topic: `user:${targetUserId}`, data: event }))
  }

  // ─── Queries ──────────────────────────────────────────────────────────────
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 60000, staleTime: 30000 })
  const rooms = useQuery({
    queryKey: ['chat-rooms', identity?.userId, session?.accessToken],
    queryFn: () => fetchRooms(session?.accessToken ?? ''),
    enabled: Boolean(identity && session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 30000,
  })
  const accountSessions = useQuery({
    queryKey: ['account-sessions', session?.accessToken],
    queryFn: () => fetchAccountSessions(session?.accessToken ?? ''),
    enabled: Boolean(session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 30000,
  })
  const callLogs = useQuery({
    queryKey: ['call-logs', session?.accessToken],
    queryFn: () => listCallLogs(session?.accessToken ?? ''),
    enabled: Boolean(session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 30000,
  })

  const activeRoomData = useMemo(
    () => rooms.data?.rooms.find((room) => room.roomId === activeRoomID) ?? null,
    [rooms.data?.rooms, activeRoomID],
  )

  const activeRoomSecret = activeRoomData?.roomSecret || (activeRoomID ? roomSecrets[activeRoomID] : '')
  const activeInvite = activeRoomID && activeRoomSecret ? createInviteToken(activeRoomID, activeRoomSecret) : ''

  // ─── Identity ─────────────────────────────────────────────────────────────
  const {
    memberIdentities,
    identitiesByID,
    peers,
  } = useIdentity({
    session,
    identity,
    activeRoom: activeRoomData,
    activeRoomID,
    handleAuthExpired,
  })

  const preferredCallPeer = useMemo(() => {
    const onlinePeer = peers.find((member) => presence[member.userId]?.status === 'online')
    return onlinePeer ?? peers[0] ?? null
  }, [peers, presence])

  // ─── Friends ──────────────────────────────────────────────────────────────
  const {
    friends,
    friendUsername,
    setFriendUsername,
    requestFriendMutation,
    respondFriendMutation,
  } = useFriends({ session, handleRequestError })

  const acceptedFriends = useMemo(
    () => (friends.data?.friends ?? []).filter((friend) => friend.status === 'accepted'),
    [friends.data?.friends],
  )
  const acceptedFriendsRef = useRef(acceptedFriends)
  useEffect(() => { acceptedFriendsRef.current = acceptedFriends }, [acceptedFriends])

  // ─── Messages ─────────────────────────────────────────────────────────────
  const messages = useMessages({
    session,
    identity,
    activeRoomID,
    activeSecret: activeRoomSecret,
    handleAuthExpired,
    handleRequestError,
    sendRealtime: sendRealtimeRaw as (event: { kind: 'typing'; userId: string; displayName: string; typing: boolean; at: string }) => void,
    activeRoom: activeRoomData,
    highlightedMessageID,
  })

  // Sync localDeletedMessageIDs from messages hook back to our local state (so persisted deletes work)
  // Messages hook manages its own localDeletedMessageIDs, we sync initial load
  // Actually the message hook's persistLocalDeletedMessages only updates its internal state.
  // We need to provide persistence. Let's handle this by overriding the hook's persistLocalDeletedMessages.

  // ─── Rooms ────────────────────────────────────────────────────────────────
  async function sendSystemMessage(roomID: string, _secret: string, _type: 'leave') {
    if (!identity || !session || !roomID) return
    const text = t('systemLeft')
    const payload = encodePlainMessage({
      text: '',
      senderName: identity.displayName,
      senderAvatarUrl: session.principal.avatarUrl,
      sentAt: new Date().toISOString(),
      system: { type: 'leave', text: `${identity.displayName} ${text}` },
    })
    await sendEncryptedMessage({
      roomId: roomID,
      senderId: identity.userId,
      token: session.accessToken,
      ...payload,
    })
  }

  const roomsHook = useRooms({
    session,
    identity,
    activeRoomID,
    roomSecrets,
    isMobile,
    handleAuthExpired,
    handleRequestError,
    persistRoomSecrets,
    setActiveRoomID,
    setHighlightedMessageID,
    setPendingMessages: messages.setPendingMessages as (msgs: never[]) => void,
    setMobileView: (v) => setMobileView(v),
    setSidebarView: (v) => setSidebarView(v),
    setMobileCreateRoomOpened,
    setMobileImportInviteOpened,
    setMobileChatActionsOpened,
    setLeaveConfirmOpened,
    sendSystemMessage,
  })

  // Patch room activity (used in WS handlers)
  const patchRoomActivity = roomsHook.patchRoomActivity

  // ─── Error forwarding from queries ────────────────────────────────────────
  useEffect(() => {
    const error =
      rooms.error ?? messages.history.error ?? messages.attachmentHistory.error ?? memberIdentities.error ?? accountSessions.error ?? friends.error
    if (error instanceof AuthError) handleAuthExpired()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms.error, messages.history.error, messages.attachmentHistory.error, memberIdentities.error, accountSessions.error, friends.error])

  // ─── Typing expiry timer ──────────────────────────────────────────────────
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTypingUsers((prev) => {
        const now = Date.now()
        let changed = false
        const next: typeof prev = {}
        for (const [userId, value] of Object.entries(prev)) {
          if (value.until > now) {
            next[userId] = value
          } else {
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  // ─── Presence init from member identities ─────────────────────────────────
  useEffect(() => {
    const next: Record<string, { displayName: string; status: 'online' | 'offline'; lastSeenAt: string }> = {}
    for (const item of memberIdentities.data ?? []) {
      next[item.userId] = {
        displayName: item.displayName,
        status: presence[item.userId]?.status ?? 'offline',
        lastSeenAt: presence[item.userId]?.lastSeenAt ?? item.lastSeenAt,
      }
    }
    setPresence((prev) => ({ ...prev, ...next }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIdentities.data])

  // ─── Presence fan-out to friends on connect ───────────────────────────────
  useEffect(() => {
    if (liveStatus !== 'connected' || !identity) return
    const event = {
      kind: 'presence' as const,
      userId: identity.userId,
      displayName: identity.displayName,
      status: 'online' as const,
      lastSeenAt: new Date().toISOString(),
      requestEcho: true,
    }
    for (const friend of acceptedFriendsRef.current) {
      sendToUserRaw(friend.userId, event)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStatus, identity?.userId, acceptedFriends.length])

  // ─── Beforeunload presence offline ────────────────────────────────────────
  useEffect(() => {
    if (!identity) return
    const handleClose = () => {
      const offlineEvent = {
        kind: 'presence' as const,
        userId: identity.userId,
        displayName: identity.displayName,
        status: 'offline' as const,
        lastSeenAt: new Date().toISOString(),
      }
      for (const friend of acceptedFriendsRef.current) {
        sendToUserRaw(friend.userId, offlineEvent)
      }
      if (activeRoomID) sendRealtimeRaw(offlineEvent)
    }
    window.addEventListener('beforeunload', handleClose)
    return () => window.removeEventListener('beforeunload', handleClose)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, activeRoomID])

  // ─── URL sync ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!urlStateReadyRef.current) return
    if (new URLSearchParams(window.location.search).has('invite')) return
    const view = activeRoomID && !isMobile ? 'chat' : activeRoomID ? leftView : leftView === 'chat' ? 'rooms' : leftView
    replaceAppURL({
      view,
      roomId: activeRoomID && view === 'chat' ? activeRoomID : undefined,
      messageId: activeRoomID && view === 'chat' ? highlightedMessageID || undefined : undefined,
    })
  }, [activeRoomID, highlightedMessageID, isMobile, leftView])

  // ─── Scroll to bottom on room open ───────────────────────────────────────
  const openedRoomScrollRef = useRef('')
  useEffect(() => {
    const viewport = messages.messagesViewportRef.current
    if (!activeRoomID || openedRoomScrollRef.current !== activeRoomID) {
      openedRoomScrollRef.current = ''
    }
    if (!viewport || !activeRoomID || highlightedMessageID || messages.visibleMessages.length === 0) return
    if (openedRoomScrollRef.current === activeRoomID) return
    openedRoomScrollRef.current = activeRoomID
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        viewport.scrollTo({ top: viewport.scrollHeight })
      })
    })
  }, [activeRoomID, highlightedMessageID, messages.visibleMessages.length])

  useEffect(() => {
    if (!activeRoomID || !highlightedMessageID || messages.visibleMessages.length === 0) return
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const target = document.getElementById(`message-${highlightedMessageID}`)
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    })
  }, [activeRoomID, highlightedMessageID, messages.visibleMessages.length])

  // ─── Mark room read ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!session || !activeRoomID) return
    const lastSeenLength = messages.readMarksRef.current[activeRoomID] ?? -1
    if (lastSeenLength === messages.decryptedMessages.length) return
    messages.readMarksRef.current[activeRoomID] = messages.decryptedMessages.length
    roomsHook.markRead(activeRoomID, session.accessToken)
  }, [session, activeRoomID, messages.decryptedMessages.length])

  useEffect(() => {
    if (previousRoomIDRef.current === activeRoomID) return
    previousRoomIDRef.current = activeRoomID
    messages.setLiveMessages([])
    messages.setPendingMessages([])
  }, [activeRoomID])

  // ─── Realtime event handling ──────────────────────────────────────────────
  function handleRealtimeEvent(event: RealtimeEvent) {
    if (!currentUserID) return
    if ('fromUserId' in event && event.fromUserId === currentUserID) return
    if (event.kind === 'typing') {
      if (event.userId === currentUserID) return
      setTypingUsers((prev) => ({
        ...prev,
        [event.userId]: { displayName: event.displayName, until: event.typing ? Date.now() + 3500 : 0 },
      }))
      return
    }
    if (event.kind === 'presence') {
      if (event.userId === currentUserID) return
      setPresence((prev) => ({
        ...prev,
        [event.userId]: { displayName: event.displayName, status: event.status, lastSeenAt: event.lastSeenAt },
      }))
      if (event.requestEcho && identity) {
        sendToUserRaw(event.userId, {
          kind: 'presence',
          userId: identity.userId,
          displayName: identity.displayName,
          status: 'online',
          lastSeenAt: new Date().toISOString(),
        })
      }
      return
    }
    if (event.kind === 'profile.updated') {
      if (event.userId === currentUserID) return
      setPresence((prev) => ({
        ...prev,
        [event.userId]: {
          ...prev[event.userId],
          displayName: event.displayName,
          status: prev[event.userId]?.status ?? 'offline',
          lastSeenAt: prev[event.userId]?.lastSeenAt ?? new Date().toISOString(),
        },
      }))
      setAvatarVersion(Date.now())
      void queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
      return
    }
    if (event.kind === 'chats.changed' || event.kind === 'rooms.changed') {
      void queryClient.refetchQueries({ queryKey: ['chat-rooms'] })
      if (event.roomId && event.roomId === activeRoomID) {
        void queryClient.refetchQueries({ queryKey: ['chat-identities', event.roomId] })
      }
      return
    }
    if (event.kind === 'message.created') {
      patchRoomActivity(event.roomId, {
        at: event.at,
        incrementUnread: event.senderId !== currentUserID && event.roomId !== activeRoomID,
      })
      return
    }
    if (event.kind === 'friends.changed') {
      queryClient.invalidateQueries({ queryKey: ['friends'] })
      return
    }
    if (event.kind === 'sessions.changed') {
      queryClient.invalidateQueries({ queryKey: ['account-sessions'] })
      return
    }
    if (event.kind === 'session.revoked') {
      if (event.sessionId && event.sessionId === session?.principal.sessionId) {
        handleAuthExpired()
        return
      }
      queryClient.invalidateQueries({ queryKey: ['account-sessions'] })
      return
    }
    if (event.kind === 'message.read') {
      if (event.userId === currentUserID) {
        patchRoomActivity(event.roomId, { clearUnread: true })
        return
      }
      if (event.roomId === activeRoomID) {
        void queryClient.refetchQueries({ queryKey: ['chat-messages', event.roomId] })
      }
      return
    }
    void handleCallEvent(event)
  }

  function handleIncomingData(data: unknown) {
    const maybeEvent = data as Partial<RealtimeEvent>
    if (typeof maybeEvent.kind === 'string') {
      handleRealtimeEvent(maybeEvent as RealtimeEvent)
      return
    }
    const msg = data as EncryptedMessage
    messages.setLiveMessages((prev) => [...prev, msg].slice(-200))
    patchRoomActivity(msg.roomId, {
      at: msg.createdAt,
      incrementUnread: msg.senderId !== currentUserID && msg.roomId !== activeRoomID,
    })
  }

  // ─── WebSocket connect ────────────────────────────────────────────────────
  const connectWS = (roomID: string) => {
    const userID = session?.principal.userId
    if (!session || !userID) return
    if (wsReconnectTimerRef.current) {
      clearTimeout(wsReconnectTimerRef.current)
      wsReconnectTimerRef.current = null
    }
    const previousWS = wsRef.current
    wsRef.current = null
    previousWS?.close()

    const url = new URL(`${WS_BASE}/ws`)
    const topics = [`user:${userID}`]
    if (roomID) topics.push(`room:${roomID}`)
    url.searchParams.set('topics', topics.join(','))
    setLiveStatus('connecting')
    const ws = new WebSocket(url.toString())
    wsRef.current = ws
    ws.onopen = () => {
      setLiveStatus('connected')
      if (!currentDisplayName) return
      sendRealtimeRaw({
        kind: 'presence',
        userId: userID,
        displayName: currentDisplayName,
        status: 'online',
        lastSeenAt: new Date().toISOString(),
      })
    }
    ws.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data) as MessageEnvelope & { type?: string; code?: string }
        if (envelope.type === 'error') {
          notifications.show({
            title: t('wsError'),
            message: envelope.code ?? 'websocket_error',
            color: 'red',
          })
          return
        }
        if (envelope.topic === `room:${roomID}` || envelope.topic === `user:${userID}`) {
          handleIncomingData(envelope.data)
        }
      } catch {
        // ignore malformed frames
      }
    }
    ws.onerror = () => {
      if (wsRef.current === ws) setLiveStatus('disconnected')
      notifications.show({ title: t('wsError'), message: t('liveDisconnected'), color: 'red' })
    }
    ws.onclose = () => {
      if (wsRef.current === ws) setLiveStatus('disconnected')
      if (!session?.accessToken || wsRef.current !== ws) return
      wsReconnectTimerRef.current = setTimeout(() => connectWS(roomID), 1500)
    }
  }

  useEffect(() => {
    if (session?.principal.userId) connectWS(activeRoomID)
    return () => {
      if (wsReconnectTimerRef.current) {
        clearTimeout(wsReconnectTimerRef.current)
        wsReconnectTimerRef.current = null
      }
      const currentWS = wsRef.current
      wsRef.current = null
      currentWS?.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomID, session?.principal.userId])

  // ─── Call logic ───────────────────────────────────────────────────────────
  async function refreshCallDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    setAudioInputDevices(devices.filter((device) => device.kind === 'audioinput'))
    setAudioOutputDevices(devices.filter((device) => device.kind === 'audiooutput'))
  }

  function addCallDiagnostic(message: string) {
    const stamp = new Date().toLocaleTimeString()
    setCallDiagnostics((prev) => [...prev.slice(-19), `${stamp} ${message}`])
  }

  function clearCallTimeout() {
    if (!callTimeoutRef.current) return
    clearTimeout(callTimeoutRef.current)
    callTimeoutRef.current = null
  }

  function armCallTimeout(callId: string, peerUserId: string, roomID: string) {
    clearCallTimeout()
    callTimeoutRef.current = setTimeout(() => {
      if (activeCallIDRef.current !== callId) return
      if (identity && peerUserId && roomID) {
        sendRealtimeRaw({
          kind: 'call-hangup',
          callId,
          roomId: roomID,
          fromUserId: identity.userId,
          toUserId: peerUserId,
        })
      }
      setCallError(locale === 'ru' ? 'Собеседник не ответил.' : 'The call was not answered.')
      cleanupCall(false, true)
    }, 45000)
  }

  function armConnectionTimeout(callId: string) {
    clearCallTimeout()
    callTimeoutRef.current = setTimeout(() => {
      if (activeCallIDRef.current !== callId || callState === 'connected') return
      setCallError(locale === 'ru'
        ? 'Не удалось установить медиасоединение. Проверьте TURN, сеть или мобильный firewall.'
        : 'Could not establish media connection. Check TURN, network, or mobile firewall.')
      cleanupCall(false, true)
    }, 45000)
  }

  function setupAudioPlayback() {
    const ctx = audioContextRef.current
    if (!ctx) { addCallDiagnostic('Audio playback: no AudioContext'); return }
    try {
      const gain = ctx.createGain()
      gain.gain.value = peerVolume
      gain.connect(ctx.destination)
      gainNodeRef.current = gain
      callAudioEpochRef.current = null
      addCallDiagnostic(`Audio playback setup (${ctx.sampleRate}Hz)`)
    } catch (err) {
      addCallDiagnostic(`Audio playback error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function startAudioStreaming() {
    const stream = localStreamRef.current
    if (!stream) { addCallDiagnostic('Audio streaming: no mic stream'); return }
    if (!myUserIDRef.current || !activeCallPeerIDRef.current) { addCallDiagnostic('Audio streaming: missing ids'); return }
    const ctx = audioContextRef.current
    if (!ctx) { addCallDiagnostic('Audio streaming: no AudioContext'); return }
    try {
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(2048, 1, 1)
      let seq = 0
      processor.onaudioprocess = (e) => {
        if (!activeCallIDRef.current) return
        const input = e.inputBuffer.getChannelData(0)
        const int16 = new Int16Array(input.length)
        for (let i = 0; i < input.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32768)))
        }
        // 4-byte LE uint32 sample-rate header + int16 PCM
        const header = new Uint8Array(4)
        new DataView(header.buffer).setUint32(0, ctx.sampleRate, true)
        const pcm = new Uint8Array(int16.buffer)
        const full = new Uint8Array(4 + pcm.byteLength)
        full.set(header, 0); full.set(pcm, 4)
        let binary = ''
        const step = 8192
        for (let i = 0; i < full.byteLength; i += step) {
          binary += String.fromCharCode(...full.subarray(i, i + step))
        }
        if (seq === 0) addCallDiagnostic(`First chunk: ${full.byteLength}b, ws=${wsRef.current?.readyState}, sr=${ctx.sampleRate}`)
        sendRealtimeRaw({
          kind: 'call-audio',
          callId: activeCallIDRef.current,
          roomId: activeCallRoomIDRef.current,
          fromUserId: myUserIDRef.current,
          toUserId: activeCallPeerIDRef.current,
          chunk: btoa(binary),
          seq: seq++,
        })
      }
      source.connect(processor)
      processor.connect(ctx.destination) // outputBuffer stays silent (zeros)
      audioSourceNodeRef.current = source
      scriptProcessorRef.current = processor
      addCallDiagnostic('Audio streaming started (PCM)')
    } catch (err) {
      addCallDiagnostic(`Audio streaming error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function appendRemoteAudioChunk(base64: string, seq?: number) {
    try {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      if (bytes.byteLength < 5) return
      const senderRate = new DataView(bytes.buffer).getUint32(0, true)
      const int16 = new Int16Array(bytes.buffer, 4)
      const float32 = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768

      // Tiny fade-in/out to prevent clicks at chunk boundaries
      const fadeLen = Math.min(64, Math.floor(float32.length / 8))
      for (let i = 0; i < fadeLen; i++) {
        float32[i] *= i / fadeLen
        float32[float32.length - 1 - i] *= i / fadeLen
      }

      const ctx = audioContextRef.current
      if (!ctx) {
        if (seq === 0) addCallDiagnostic(`First remote chunk: ${bytes.length}b, ctx=null`)
        return
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)

      const safeSeq = seq ?? 0
      const now = ctx.currentTime
      const buf = ctx.createBuffer(1, float32.length, senderRate)
      buf.copyToChannel(float32, 0)

      let epoch = callAudioEpochRef.current
      if (!epoch || epoch.senderRate !== senderRate) {
        // Anchor: chunk safeSeq plays 250ms from now regardless of how late it arrived
        epoch = { startTime: now + 0.25 - safeSeq * buf.duration, chunkDuration: buf.duration, senderRate }
        callAudioEpochRef.current = epoch
        addCallDiagnostic(`First remote chunk: ${bytes.length}b, senderSR=${senderRate}, localSR=${ctx.sampleRate}`)
      }

      let scheduleTime = epoch.startTime + safeSeq * epoch.chunkDuration
      if (scheduleTime < now - 0.5) {
        // More than 500ms stale — re-anchor so burst chunks don't all play simultaneously
        epoch.startTime = now + 0.25 - safeSeq * epoch.chunkDuration
        scheduleTime = epoch.startTime + safeSeq * epoch.chunkDuration
        addCallDiagnostic(`Audio epoch reset at seq=${safeSeq}`)
      }

      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(gainNodeRef.current ?? ctx.destination)
      src.start(Math.max(scheduleTime, now))
    } catch { /* ignore */ }
  }

  async function startCall(targetUserId = preferredCallPeer?.userId ?? '') {
    if (!identity || !activeRoomID || callState !== 'idle') return
    const target = peers.find((member) => member.userId === targetUserId)
    if (!target) {
      notifications.show({
        title: t('callFailed'),
        message: locale === 'ru' ? 'В этой комнате нет собеседника для звонка.' : 'There is nobody to call in this room.',
        color: 'yellow',
      })
      return
    }
    try {
      const callId = crypto.randomUUID()
      setCallDiagnostics([])
      addCallDiagnostic('Starting call')
      const audio: MediaTrackConstraints = {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : {}),
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      localStreamRef.current = stream
      stream.getAudioTracks().forEach((track) => { track.enabled = !isCallMuted })
      void refreshCallDevices()
      const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AC) {
        const ctx = new AC()
        audioContextRef.current = ctx
        ctx.resume().catch(() => undefined)
      }
      activeCallIDRef.current = callId
      activeCallPeerIDRef.current = target.userId
      activeCallRoomIDRef.current = activeRoomID
      callCallerIDRef.current = identity.userId
      setCallPeerID(target.userId)
      setCallPeerName(target.displayName)
      setCallError('')
      setCallState('calling')
      setCallStatus(locale === 'ru' ? 'Ожидаем ответ...' : 'Waiting for answer...')
      armCallTimeout(callId, target.userId, activeRoomID)
      sendRealtimeRaw({
        kind: 'call-offer',
        callId,
        roomId: activeRoomID,
        fromUserId: identity.userId,
        toUserId: target.userId,
        displayName: identity.displayName,
      })
      addCallDiagnostic('Offer sent')
    } catch (err) {
      setCallError(err instanceof Error ? err.message : 'call_failed')
      notifications.show({ title: t('callFailed'), message: err instanceof Error ? err.message : 'call_failed', color: 'red' })
      cleanupCall(false, true)
    }
  }

  async function answerCall() {
    if (!incomingCall || !identity) return
    try {
      setCallState('connecting')
      addCallDiagnostic('Answering call')
      const audio: MediaTrackConstraints = {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : {}),
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      localStreamRef.current = stream
      stream.getAudioTracks().forEach((track) => { track.enabled = !isCallMuted })
      void refreshCallDevices()
      const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AC) {
        const ctx = new AC()
        audioContextRef.current = ctx
        ctx.resume().catch(() => undefined)
      }
      activeCallIDRef.current = incomingCall.callId
      activeCallPeerIDRef.current = incomingCall.fromUserId
      activeCallRoomIDRef.current = incomingCall.roomId
      callCallerIDRef.current = incomingCall.fromUserId
      setCallPeerID(incomingCall.fromUserId)
      setCallPeerName(incomingCall.displayName)
      setCallError('')
      armConnectionTimeout(incomingCall.callId)
      setupAudioPlayback()
      startAudioStreaming()
      sendRealtimeRaw({
        kind: 'call-answer',
        callId: incomingCall.callId,
        roomId: incomingCall.roomId,
        fromUserId: identity.userId,
        toUserId: incomingCall.fromUserId,
      })
      addCallDiagnostic('Answer sent')
      setIncomingCall(null)
    } catch (err) {
      setCallError(err instanceof Error ? err.message : 'call_failed')
      notifications.show({ title: t('callFailed'), message: err instanceof Error ? err.message : 'call_failed', color: 'red' })
      cleanupCall(true, true)
    }
  }

  async function sendCallSystemMessage(
    roomID: string,
    callerID: string,
    calleeID: string,
    status: 'completed' | 'missed' | 'declined',
    durationSec: number,
    startedAt?: string,
  ) {
    if (!identity || !session || !roomID || !callerID || !calleeID) return
    const payload = encodePlainMessage({
      text: '',
      senderName: identity.displayName,
      senderAvatarUrl: session.principal.avatarUrl,
      sentAt: new Date().toISOString(),
      system: { type: 'call', callStatus: status, durationSec, callerId: callerID, calleeId: calleeID },
    })
    await sendEncryptedMessage({ roomId: roomID, senderId: identity.userId, token: session.accessToken, ...payload }).catch(() => undefined)
    await appendCallLog({
      token: session.accessToken,
      roomId: roomID,
      callerId: callerID,
      calleeId: calleeID,
      status,
      durationSec,
      startedAt,
      endedAt: new Date().toISOString(),
    }).then(() => queryClient.invalidateQueries({ queryKey: ['call-logs'] })).catch(() => undefined)
  }

  function cleanupCall(notifyPeer = true, keepError = false) {
    const roomID = activeCallRoomIDRef.current
    const peerID = activeCallPeerIDRef.current
    const callerID = callCallerIDRef.current
    const calleeID = callerID === identity?.userId ? peerID : identity?.userId ?? ''
    const wasConnected = Boolean(callStartedAt)
    const duration = callDurationSec
    const startedAt = callStartedAt || undefined

    if (notifyPeer && identity && roomID && activeCallIDRef.current && peerID) {
      sendRealtimeRaw({
        kind: 'call-hangup',
        callId: activeCallIDRef.current,
        roomId: roomID,
        fromUserId: identity.userId,
        toUserId: peerID,
      })
    }

    if (notifyPeer && roomID && callerID && calleeID) {
      void sendCallSystemMessage(roomID, callerID, calleeID, wasConnected ? 'completed' : 'missed', duration, startedAt)
    }
    clearCallTimeout()
    audioSourceNodeRef.current?.disconnect()
    audioSourceNodeRef.current = null
    scriptProcessorRef.current?.disconnect()
    scriptProcessorRef.current = null
    gainNodeRef.current = null
    audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    callAudioEpochRef.current = null
    audioConnectedRef.current = false
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    activeCallIDRef.current = ''
    activeCallPeerIDRef.current = ''
    activeCallRoomIDRef.current = ''
    callCallerIDRef.current = ''
    setCallState(keepError ? 'failed' : 'idle')
    setIncomingCall(null)
    if (!keepError) {
      setCallPeerName('')
      setCallPeerID('')
    }
    setCallStartedAt('')
    setCallDurationSec(0)
    setCallStatus('')
    if (!keepError) setCallError('')
    if (!keepError) setCallDiagnostics([])
  }

  function endCall(notifyPeer = true) {
    cleanupCall(notifyPeer)
  }

  function declineIncomingCall() {
    const decliningCall = incomingCall
    if (decliningCall && identity) {
      sendRealtimeRaw({
        kind: 'call-decline',
        callId: decliningCall.callId,
        roomId: decliningCall.roomId,
        fromUserId: identity.userId,
        toUserId: decliningCall.fromUserId,
        reason: 'declined',
      })
      void sendCallSystemMessage(decliningCall.roomId, decliningCall.fromUserId, identity.userId, 'declined', 0)
    }
    cleanupCall(false)
  }

  async function handleCallEvent(event: RealtimeEvent) {
    const myID = myUserIDRef.current
    if (!myID || !('fromUserId' in event) || event.fromUserId === myID) return
    if ('toUserId' in event && event.toUserId !== myID) return
    if (event.kind === 'call-offer') {
      if (callState !== 'idle') {
        sendRealtimeRaw({
          kind: 'call-decline',
          callId: event.callId,
          roomId: event.roomId,
          fromUserId: myID,
          toUserId: event.fromUserId,
          reason: 'busy',
        })
        return
      }
      setIncomingCall(event)
      setCallDiagnostics([])
      setCallState('ringing')
      setCallPeerID(event.fromUserId)
      setCallPeerName(event.displayName)
      setCallError('')
      setCallStatus(locale === 'ru' ? 'Входящий звонок' : 'Incoming call')
      addCallDiagnostic('Incoming offer received')
      armCallTimeout(event.callId, event.fromUserId, event.roomId)
      return
    }
    if (event.callId !== activeCallIDRef.current) return
    if (event.kind === 'call-answer') {
      clearCallTimeout()
      setCallState('connecting')
      armConnectionTimeout(event.callId)
      setCallStatus(locale === 'ru' ? 'Соединяем...' : 'Connecting...')
      addCallDiagnostic('Answer received, starting audio')
      setupAudioPlayback()
      startAudioStreaming()
      return
    }
    if (event.kind === 'call-audio') {
      if (!audioConnectedRef.current) {
        audioConnectedRef.current = true
        clearCallTimeout()
        setCallState('connected')
        setCallStartedAt(new Date().toISOString())
        addCallDiagnostic('Audio connected')
      }
      appendRemoteAudioChunk(event.chunk, event.seq)
      return
    }
    if (event.kind === 'call-hangup') {
      cleanupCall(false)
      return
    }
    if (event.kind === 'call-decline') {
      notifications.show({
        title: t('declineCall'),
        message:
          event.reason === 'busy'
            ? locale === 'ru'
              ? 'Собеседник уже в звонке.'
              : 'The user is already in a call.'
            : t('declineCall'),
        color: 'yellow',
      })
      cleanupCall(false)
    }
  }

  useEffect(() => {
    if (callState !== 'connected' || !callStartedAt) return
    const tick = () => setCallDurationSec(Math.max(0, Math.floor((Date.now() - Date.parse(callStartedAt)) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [callState, callStartedAt])

  useEffect(() => {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !isCallMuted
    })
  }, [isCallMuted])

  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = peerVolume
  }, [peerVolume])

  useEffect(() => {
    if (callState === 'idle' || !localStreamRef.current) return
    const currentCallId = activeCallIDRef.current
    const audio: MediaTrackConstraints = {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : {}),
    }
    navigator.mediaDevices.getUserMedia({ audio, video: false })
      .then((stream) => {
        if (activeCallIDRef.current !== currentCallId) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        stream.getAudioTracks().forEach((track) => { track.enabled = !isCallMuted })
        audioSourceNodeRef.current?.disconnect()
        audioSourceNodeRef.current = null
        scriptProcessorRef.current?.disconnect()
        scriptProcessorRef.current = null
        localStreamRef.current?.getTracks().forEach((track) => track.stop())
        localStreamRef.current = stream
        startAudioStreaming()
      })
      .catch((err) => setCallError(err instanceof Error ? err.message : 'microphone_failed'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAudioInputId])

  useEffect(() => {
    void refreshCallDevices()
    const handler = () => void refreshCallDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', handler)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler)
  }, [])

  // ─── Session helpers ──────────────────────────────────────────────────────
  function saveSession(next: AuthSession, options: { reloadLocalState?: boolean } = { reloadLocalState: true }) {
    authExpiredNotifiedRef.current = false
    setSession(next)
    if (options.reloadLocalState !== false) {
      loadAccountLocalState(next)
    }
  }

  function updateSessionPrincipal(principal: AuthSession['principal']) {
    if (!session) return
    const next = { ...session, principal }
    setSession(next)
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

  function loadAccountLocalState(target: AuthSession) {
    const accountId = accountStorageID(target)
    const savedSecrets = accountId
      ? readStoredJSON<Record<string, string>>(accountScopedKey(ROOM_SECRETS_KEY, accountId))
      : null
    const deletedMessages = accountId
      ? readStoredJSON<Record<string, true>>(accountScopedKey(LOCAL_DELETED_MESSAGES_KEY, accountId))
      : null

    setIdentity(null)
    setRoomSecrets(savedSecrets ?? {})
    setLocalDeletedMessageIDs(deletedMessages ?? {})
    setActiveRoomID('')
    setHighlightedMessageID('')
    messages.setLiveMessages([])
    messages.setPendingMessages([])
    setTypingUsers({})
    setPresence({})
    setMobileChatActionsOpened(false)
    setLeaveConfirmOpened(false)
    setTotpRequired(false)
    setTotpCode('')
    if (isMobile) setMobileView('rooms')
    else setSidebarView('rooms')

    fetchCurrentIdentity(target.accessToken)
      .then((id: Identity) => setIdentity(id))
      .catch((err: Error) => {
        if (err instanceof AuthError) handleAuthExpired()
        else notifications.show({ title: t('profileTitle'), message: err.message, color: 'red' })
      })
    fetchCurrentPrincipal(target.accessToken)
      .then((principal) => {
        const next = { ...target, principal }
        setSession((current) => current?.accessToken === target.accessToken ? next : current)
      })
      .catch(() => {
        // Identity loading above owns the visible auth error path.
      })
  }

  function clearAccountLocalState() {
    setIdentity(null)
    setRoomSecrets({})
    setLocalDeletedMessageIDs({})
    setActiveRoomID('')
    setHighlightedMessageID('')
    messages.setLiveMessages([])
    messages.setPendingMessages([])
    setTypingUsers({})
    setPresence({})
    setMobileView('rooms')
    setSidebarView('rooms')
    setMobileChatActionsOpened(false)
    setLeaveConfirmOpened(false)
    setTotpRequired(false)
    setTotpCode('')
  }

  // ─── URL init on mount ────────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const routeState = appRouteFromPath(window.location.pathname)
    const invite = params.get('invite')
    const linkedChatID = params.get('chat') || params.get('room') || routeState.roomId
    const linkedMessageID = params.get('message') || routeState.messageId
    const rawView = params.get('view')
    const linkedView =
      rawView ? appViewFromParam(rawView) : routeState.view ?? (linkedChatID ? 'chat' : 'rooms')

    refreshSession()
      .then((restored) => {
        saveSession(restored)
        setColorScheme(restored.principal.theme)
        setDisplayName(restored.principal.displayName || restored.principal.username)
      })
      .catch(() => undefined)
      .finally(() => setSessionBootstrapped(true))

    if (invite) {
      setInviteText(invite)
      setMobileView('rooms')
      setSidebarView('rooms')
    } else if (linkedChatID) {
      setActiveRoomID(linkedChatID)
      setMobileView(linkedView as AppView)
      setSidebarView(linkedView === 'chat' ? 'rooms' : linkedView as AppView)
    } else {
      setMobileView(linkedView as AppView)
      setSidebarView(linkedView as AppView)
    }
    if (linkedMessageID) setHighlightedMessageID(linkedMessageID)
    urlStateReadyRef.current = true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!session) return
    const refreshInMs = Math.max(30_000, session.expiresAt * 1000 - Date.now() - 60_000)
    const timer = window.setTimeout(() => {
      refreshSession()
        .then((next) => saveSession(next, { reloadLocalState: false }))
        .catch(() => handleAuthExpired())
    }, refreshInMs)
    return () => window.clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.expiresAt, session?.principal.sessionId])

  // ─── Auth mutation ────────────────────────────────────────────────────────
  const authMutation = useMutation({
    onMutate: () => setAuthError(''),
    mutationFn: (values?: { username: string; password: string; displayName: string; totpCode: string }) => {
      const authUsername = values?.username ?? username
      const authPassword = values?.password ?? password
      const authDisplayName = values?.displayName ?? displayName
      const authTotpCode = values?.totpCode ?? totpCode
      if (authMode === 'register') {
        return registerUser({ username: authUsername, password: authPassword, displayName: authDisplayName.trim() || authUsername })
      }
      return loginUser({ username: authUsername, password: authPassword, totpCode: authTotpCode.trim() || undefined })
    },
    onSuccess: (next: AuthSession | { twoFactorRequired: true }) => {
      if (isTwoFactorChallenge(next)) {
        setTotpRequired(true)
        setAuthError('')
        notifications.show({ title: t('login'), message: t('twoFactorPrompt'), color: 'blue' })
        return
      }
      const s = next as AuthSession
      saveSession(s)
      setColorScheme(s.principal.theme)
      setDisplayName(s.principal.username || username)
      setTotpRequired(false)
      setTotpCode('')
      setAuthError('')
      notifications.show({
        title: authMode === 'register' ? t('createAccount') : t('login'),
        message: t('sessionReady'),
        color: 'green',
      })
    },
    onError: (err: Error) => {
      if (err instanceof AuthError) {
        handleAuthExpired()
        return
      }
      setAuthError(totpRequired ? t('invalidTwoFactor') : err.message)
    },
  })

  function submitAuth(values?: { username: string; password: string; displayName: string; totpCode: string }) {
    const nextUsername = values?.username ?? username
    const nextPassword = values?.password ?? password
    const nextDisplayName = values?.displayName ?? displayName
    const nextTotpCode = values?.totpCode ?? totpCode
    if (!nextUsername.trim() || nextPassword.length < 8 || authMutation.isPending) return
    if (values) {
      setUsername(nextUsername)
      setPassword(nextPassword)
      setDisplayName(nextDisplayName)
      setTotpCode(nextTotpCode)
    }
    authMutation.mutate({
      username: nextUsername,
      password: nextPassword,
      displayName: nextDisplayName,
      totpCode: nextTotpCode,
    })
  }

  function logoutLocal(options: { remote?: boolean } = {}) {
    if (identity && activeRoomID) {
      sendRealtimeRaw({
        kind: 'presence',
        userId: identity.userId,
        displayName: identity.displayName,
        status: 'offline',
        lastSeenAt: new Date().toISOString(),
      })
    }
    if (options.remote !== false) {
      void logoutSession().catch(() => undefined)
    }
    void queryClient.resetQueries()
    queryClient.clear()
    wsRef.current?.close()
    clearAccountLocalState()
    setSession(null)
  }

  function logout() {
    const current = accountSessions.data?.sessions.find((item) => item.current)
    if (current && session) {
      revokeSessionMutation.mutate(current)
      return
    }
    logoutLocal()
  }

  // ─── Session mutations ────────────────────────────────────────────────────
  const revokeSessionMutation = useMutation({
    mutationFn: async (target: AccountSession) => {
      if (!session) throw new Error('login_required')
      await revokeAccountSession({ token: session.accessToken, sessionId: target.sessionId })
      return target
    },
    onSuccess: (target: AccountSession) => {
      if (target.current) logoutLocal()
      else accountSessions.refetch()
    },
    onError: (err: Error) => handleRequestError(err, t('sessions')),
  })

  const revokeOtherSessionsMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('login_required')
      await revokeOtherAccountSessions(session.accessToken)
    },
    onSuccess: () => accountSessions.refetch(),
    onError: (err: Error) => handleRequestError(err, t('sessions')),
  })

  const avatarMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!session) throw new Error('login_required')
      const avatar = await compressAvatar(file)
      if (avatar.size > 1024 * 1024) throw new Error('avatar_too_large_after_compression')
      return uploadAvatar({ token: session.accessToken, blob: avatar })
    },
    onSuccess: (principal: AuthSession['principal']) => {
      updateSessionPrincipal(principal)
      setAvatarVersion(Date.now())
      notifications.show({ title: t('avatarReady'), message: t('avatarReadyMessage'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('avatarFailed')),
  })

  // ─── TOTP state ───────────────────────────────────────────────────────────
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null)
  const [totpQRCode, setTotpQRCode] = useState('')
  const [totpConfirmCode, setTotpConfirmCode] = useState('')
  const [totpDisablePassword, setTotpDisablePassword] = useState('')
  const [totpDisableCode, setTotpDisableCode] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!totpSetup?.otpauthUrl) { setTotpQRCode(''); return }
    import('qrcode').then((QRCode) => {
      QRCode.toDataURL(totpSetup.otpauthUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 184,
        color: { dark: '#111827', light: '#ffffff' },
      })
        .then((url) => { if (!cancelled) setTotpQRCode(url) })
        .catch(() => { if (!cancelled) setTotpQRCode('') })
    })
    return () => { cancelled = true }
  }, [totpSetup?.otpauthUrl])

  const beginTOTPMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('login_required')
      return beginTOTPSetup(session.accessToken)
    },
    onSuccess: setTotpSetup,
    onError: (err: Error) => handleRequestError(err, '2FA setup failed'),
  })

  const confirmTOTPMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('login_required')
      return confirmTOTP({ token: session.accessToken, code: totpConfirmCode.trim() })
    },
    onSuccess: (principal: AuthSession['principal']) => {
      updateSessionPrincipal(principal)
      setTotpSetup(null)
      setTotpConfirmCode('')
      notifications.show({ title: '2FA enabled', message: 'Two-factor authentication is active.', color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, '2FA confirmation failed'),
  })

  const disableTOTPMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('login_required')
      return disableTOTP({ token: session.accessToken, password: totpDisablePassword, code: totpDisableCode.trim() })
    },
    onSuccess: (principal: AuthSession['principal']) => {
      updateSessionPrincipal(principal)
      setTotpDisablePassword('')
      setTotpDisableCode('')
      notifications.show({ title: '2FA disabled', message: 'Two-factor authentication is off.', color: 'yellow' })
    },
    onError: (err: Error) => handleRequestError(err, 'Could not disable 2FA'),
  })

  // ─── Derived values ───────────────────────────────────────────────────────
  const ownAvatarSrc = useMemo(() => {
    const url = absoluteAvatarUrl(session?.principal.avatarUrl)
    return url ? `${url}?v=${avatarVersion}` : ''
  }, [avatarVersion, session?.principal.avatarUrl])

  const activeTyping = useMemo(
    () =>
      Object.entries(typingUsers)
        .filter(([userId, value]) => userId !== identity?.userId && value.until > Date.now())
        .map(([, value]) => value.displayName),
    [identity?.userId, typingUsers],
  )

  const mobilePeerStatus = useMemo(() => {
    if (peers.length === 0) return ''
    const onlinePeers = peers.filter((member) => presence[member.userId]?.status === 'online')
    const statusText =
      onlinePeers.length > 0
        ? `${onlinePeers.map((member) => member.displayName).join(', ')}: ${t('online')}`
        : peers.length === 1
          ? `${peers[0].displayName}: ${t('lastSeen')} ${formatLastSeen(presence[peers[0].userId]?.lastSeenAt || peers[0].lastSeenAt)}`
          : `${peers.length}: ${t('offline')}`
    if (activeTyping.length === 0) return statusText
    return `${statusText} · ${activeTyping.join(', ')} ${t('typing')}`
  }, [activeTyping, peers, presence, t])

  const filteredRooms = useMemo(() => {
    const query = roomSearch.trim().toLowerCase()
    const list = rooms.data?.rooms ?? []
    if (!query) return list
    return list.filter((room) => `${room.name} ${room.roomId}`.toLowerCase().includes(query))
  }, [roomSearch, rooms.data?.rooms])

  const activeInviteLink = useMemo(() => {
    if (!activeInvite || typeof window === 'undefined') return ''
    return `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(activeInvite)}`
  }, [activeInvite])

  const activeChatLink = useMemo(() => {
    if (!activeRoomID || typeof window === 'undefined') return ''
    return buildAppURL({ view: 'chat', roomId: activeRoomID })
  }, [activeRoomID])

  // ─── Room selection helpers ───────────────────────────────────────────────
  function selectRoom(room: Room) {
    setActiveRoomID(room.roomId)
    setHighlightedMessageID('')
    messages.setPendingMessages([])
    requestNotifications()
    if (isMobile) setMobileView('chat')
    else setSidebarView('rooms')
  }

  async function openDirectChat(friend: Friend) {
    if (!identity || !session) return
    const directRoomId = `direct-${[identity.userId, friend.userId].sort().join('-')}`
    const existing = rooms.data?.rooms.find((r) => r.roomId === directRoomId)
    if (existing) {
      selectRoom(existing)
      return
    }
    try {
      const secret = createRoomSecret()
      const room = await createRoom({
        roomId: directRoomId,
        name: friend.displayName || 'Direct',
        members: [identity.userId],
        roomSecret: secret,
        token: session.accessToken,
      })
      const actualSecret = room.roomSecret || secret
      persistRoomSecrets({ ...roomSecrets, [room.roomId]: actualSecret })
      await inviteFriendToRoom({ token: session.accessToken, roomId: room.roomId, userId: friend.userId })
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
      selectRoom(room)
    } catch (err) {
      handleRequestError(err as Error, t('roomError'))
    }
  }

  function closeChat() {
    setMobileChatActionsOpened(false)
    setActiveRoomID('')
    setHighlightedMessageID('')
    messages.setPendingMessages([])
    setMobileView('rooms')
    setSidebarView('rooms')
  }

  function requestLeaveChat() {
    setLeaveConfirmOpened(true)
  }

  async function leaveActiveRoom() {
    if (!activeRoomID || !identity || !session) return
    setLeavingRoom(true)
    try {
      await sendSystemMessage(activeRoomID, activeRoomSecret, 'leave').catch(() => undefined)
      await leaveRoom({ roomId: activeRoomID, userId: identity.userId, token: session.accessToken })
      const nextSecrets = { ...roomSecrets }
      delete nextSecrets[activeRoomID]
      persistRoomSecrets(nextSecrets)
      setActiveRoomID('')
      setHighlightedMessageID('')
      messages.setPendingMessages([])
      setMobileView('rooms')
      setSidebarView('rooms')
      setMobileChatActionsOpened(false)
      setLeaveConfirmOpened(false)
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired()
      } else {
        notifications.show({
          title: t('leaveFailed'),
          message: err instanceof Error ? err.message : 'leave_failed',
          color: 'red',
        })
      }
    } finally {
      setLeavingRoom(false)
    }
  }

  function saveManualSecret() {
    if (!activeRoomID || !roomSecret.trim()) return
    const nextSecrets = { ...roomSecrets, [activeRoomID]: roomSecret.trim() }
    persistRoomSecrets(nextSecrets)
    setRoomSecret('')
  }

  function copyAppURL(options: { view?: AppView; roomId?: string; messageId?: string } = {}) {
    const link = buildAppURL(options)
    if (!link) return
    navigator.clipboard
      .writeText(link)
      .then(() => notifications.show({ title: t('linkCopied'), message: link, color: 'green' }))
      .catch(() => undefined)
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  if (!sessionBootstrapped) {
    return <LoadingPage isMobile={isMobile} onLogout={() => logoutLocal({ remote: false })} />
  }

  if (!session) {
    return (
      <AuthPage
        authMode={authMode}
        username={username}
        password={password}
        displayName={displayName}
        totpCode={totpCode}
        totpRequired={totpRequired}
        authError={authError}
        isMobile={isMobile}
        isPending={authMutation.isPending}
        onSetAuthMode={(mode) => {
          setAuthMode(mode)
          setTotpRequired(false)
          setTotpCode('')
          setAuthError('')
        }}
        onSetUsername={(v) => { setUsername(v); setAuthError('') }}
        onSetPassword={(v) => { setPassword(v); setAuthError('') }}
        onSetDisplayName={setDisplayName}
        onSetTotpCode={(v) => { setTotpCode(v); setAuthError('') }}
        onSubmit={submitAuth}
      />
    )
  }

  if (!identity) {
    return <LoadingPage isMobile={isMobile} onLogout={logoutLocal} />
  }

  return (
    <AppShellLayout
      // nav
      isMobile={isMobile}
      isTablet={isTablet}
      mobileView={mobileView}
      sidebarView={sidebarView}
      leftView={leftView}
      setMobileView={setMobileView}
      setSidebarView={setSidebarView}
      liveStatus={liveStatus}
      // health
      health={health}
      // auth
      session={session}
      identity={identity}
      // locale / theme
      locale={locale}
      setLocale={setLocale}
      colorScheme={colorScheme}
      toggleTheme={toggleTheme}
      // avatar
      ownAvatarSrc={ownAvatarSrc}
      avatarMutation={avatarMutation}
      // profile
      profileUser={profileUser}
      setProfileUser={setProfileUser}
      presence={presence}
      updateSessionPrincipal={updateSessionPrincipal}
      // 2fa
      totpSetup={totpSetup}
      totpQRCode={totpQRCode}
      totpConfirmCode={totpConfirmCode}
      setTotpConfirmCode={setTotpConfirmCode}
      totpDisablePassword={totpDisablePassword}
      setTotpDisablePassword={setTotpDisablePassword}
      totpDisableCode={totpDisableCode}
      setTotpDisableCode={setTotpDisableCode}
      beginTOTPMutation={beginTOTPMutation}
      confirmTOTPMutation={confirmTOTPMutation}
      disableTOTPMutation={disableTOTPMutation}
      // sessions
      accountSessions={accountSessions}
      revokeSessionMutation={revokeSessionMutation}
      revokeOtherSessionsMutation={revokeOtherSessionsMutation}
      logout={logout}
      // friends
      friends={friends}
      friendUsername={friendUsername}
      setFriendUsername={setFriendUsername}
      requestFriendMutation={requestFriendMutation}
      respondFriendMutation={respondFriendMutation}
      acceptedFriends={acceptedFriends}
      inviteFriendMutation={roomsHook.inviteFriendMutation}
      openDirectChat={openDirectChat}
      // rooms
      rooms={rooms}
      filteredRooms={filteredRooms}
      activeRoomID={activeRoomID}
      activeRoom={activeRoomData}
      activeInvite={activeInvite}
      activeInviteLink={activeInviteLink}
      activeChatLink={activeChatLink}
      activeRoomSecret={activeRoomSecret}
      roomSearch={roomSearch}
      setRoomSearch={setRoomSearch}
      roomName={roomName}
      setRoomName={setRoomName}
      newRoomSecret={newRoomSecret}
      setNewRoomSecret={setNewRoomSecret}
      roomSecret={roomSecret}
      setRoomSecret={setRoomSecret}
      inviteText={inviteText}
      setInviteText={setInviteText}
      selectRoom={selectRoom}
      closeChat={closeChat}
      requestLeaveChat={requestLeaveChat}
      leaveActiveRoom={leaveActiveRoom}
      leavingRoom={leavingRoom}
      saveManualSecret={saveManualSecret}
      createRoomMutation={roomsHook.createRoomMutation}
      importInviteMutation={roomsHook.importInviteMutation}
      mobileCreateRoomOpened={mobileCreateRoomOpened}
      setMobileCreateRoomOpened={setMobileCreateRoomOpened}
      mobileImportInviteOpened={mobileImportInviteOpened}
      setMobileImportInviteOpened={setMobileImportInviteOpened}
      mobileChatActionsOpened={mobileChatActionsOpened}
      setMobileChatActionsOpened={setMobileChatActionsOpened}
      leaveConfirmOpened={leaveConfirmOpened}
      setLeaveConfirmOpened={setLeaveConfirmOpened}
      // identities
      memberIdentities={memberIdentities}
      identitiesByID={identitiesByID}
      peers={peers}
      mobilePeerStatus={mobilePeerStatus}
      // messages
      visibleMessages={messages.visibleMessages}
      isMessagesLoading={
        messages.history.isLoading
        || messages.isDecryptingMessages
        || (messages.encryptedMessageCount > 0 && messages.displayMessages.length === 0)
      }
      displayMessages={messages.displayMessages}
      attachmentMessages={messages.attachmentMessages}
      attachmentsOpened={attachmentsOpened}
      setAttachmentsOpened={setAttachmentsOpened}
      highlightedMessageID={highlightedMessageID}
      messageSearch={messages.messageSearch}
      setMessageSearch={messages.setMessageSearch}
      messagesViewportRef={messages.messagesViewportRef}
      messageInputRef={messages.messageInputRef}
      hasMoreMessages={messages.hasMoreMessages}
      isLoadingMoreMessages={messages.isLoadingMoreMessages}
      loadMoreMessages={messages.loadMoreMessages}
      replyTarget={messages.replyTarget}
      setReplyTarget={messages.setReplyTarget}
      selectedFile={messages.selectedFile}
      previews={messages.previews}
      messageInfo={messages.messageInfo}
      setMessageInfo={messages.setMessageInfo}
      editTarget={messages.editTarget}
      editText={messages.editText}
      setEditText={messages.setEditText}
      deleteTarget={messages.deleteTarget}
      deleteForEveryone={messages.deleteForEveryone}
      setDeleteForEveryone={messages.setDeleteForEveryone}
      sendMutation={messages.sendMutation as import('@tanstack/react-query').UseMutationResult<unknown, Error, unknown>}
      editMessageMutation={messages.editMessageMutation}
      deleteMessageMutation={messages.deleteMessageMutation}
      reactionMutation={messages.reactionMutation}
      submitMessage={() => messages.submitMessage(highlightedMessageID)}
      updateMessageText={messages.updateMessageText}
      selectFile={messages.selectFile}
      openEditMessage={messages.openEditMessage}
      openDeleteMessage={messages.openDeleteMessage}
      copyMessageText={messages.copyMessageText}
      previewAttachment={messages.previewAttachment}
      downloadAttachment={messages.downloadAttachment}
      messageReplyPreview={messages.messageReplyPreview}
      setEditTarget={messages.setEditTarget}
      setDeleteTarget={messages.setDeleteTarget}
      copyAppURL={copyAppURL}
      // typing / presence
      activeTyping={activeTyping}
      // call
      callState={callState}
      incomingCall={incomingCall}
      callPeerName={callPeerName}
      callPeerID={callPeerID}
      callStatus={callStatus}
      callError={callError}
      callDiagnostics={callDiagnostics}
      callDurationSec={callDurationSec}
      isCallMuted={isCallMuted}
      setIsCallMuted={setIsCallMuted}
      peerVolume={peerVolume}
      setPeerVolume={setPeerVolume}
      audioInputDevices={audioInputDevices}
      audioOutputDevices={audioOutputDevices}
      selectedAudioInputId={selectedAudioInputId}
      setSelectedAudioInputId={setSelectedAudioInputId}
      selectedAudioOutputId={selectedAudioOutputId}
      setSelectedAudioOutputId={setSelectedAudioOutputId}
      remoteAudioRef={remoteAudioRef}
      startCall={startCall}
      endCall={endCall}
      answerCall={answerCall}
      declineIncomingCall={declineIncomingCall}
      callLogs={callLogs}
    />
  )
}
