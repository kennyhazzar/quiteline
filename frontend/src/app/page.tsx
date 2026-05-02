'use client'

import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Divider,
  FileButton,
  FileInput,
  Group,
  Image,
  Modal,
  PasswordInput,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
  useMantineColorScheme,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconCopy, IconDotsVertical, IconDownload, IconKey, IconLock, IconPaperclip, IconPhone, IconPhoneOff, IconPlus, IconRefresh, IconSend, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  absoluteAvatarUrl,
  AuthError,
  fetchAccountSessions,
  fetchCurrentIdentity,
  createRoom,
  downloadEncryptedFile,
  fetchIdentity,
  fetchHealth,
  fetchMessages,
  fetchRooms,
  leaveRoom,
  loginUser,
  registerUser,
  revokeAccountSession,
  revokeOtherAccountSessions,
  sendEncryptedMessage,
  touchIdentity,
  uploadAvatar,
  uploadEncryptedFile,
  type AuthSession,
  type AccountSession,
  type EncryptedMessage,
  type Identity,
  type MessageEnvelope,
  type Room,
  WS_BASE,
} from '@/lib/api'
import { compressAvatar } from '@/lib/avatar'
import { useI18n } from '@/lib/i18n'
import {
  createRoomSecret,
  decryptFile,
  decryptMessage,
  encryptFile,
  encryptMessage,
  type PlainMessage,
} from '@/lib/crypto'

interface DecryptedMessage {
  id: string
  senderId: string
  body: PlainMessage | null
  createdAt: string
  failed?: boolean
}

type RealtimeEvent =
  | { kind: 'typing'; userId: string; displayName: string; typing: boolean; at: string }
  | { kind: 'presence'; userId: string; displayName: string; status: 'online' | 'offline'; lastSeenAt: string }
  | { kind: 'call-offer'; callId: string; fromUserId: string; displayName: string; offer: RTCSessionDescriptionInit }
  | { kind: 'call-answer'; callId: string; fromUserId: string; answer: RTCSessionDescriptionInit }
  | { kind: 'call-ice'; callId: string; fromUserId: string; candidate: RTCIceCandidateInit }
  | { kind: 'call-hangup'; callId: string; fromUserId: string }

type CallState = 'idle' | 'calling' | 'ringing' | 'connected'

const ROOM_SECRETS_KEY = 'zk.roomSecrets.v1'
const SESSION_KEY = 'zk.session.v1'
const MAX_FILE_BYTES = 100 * 1024 * 1024

function accountScopedKey(base: string, accountId: string) {
  return `${base}.${accountId}`
}

function readStoredJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

function maskedRoomId(roomId: string) {
  if (roomId.length <= 8) return '*'.repeat(roomId.length)
  return `${roomId.slice(0, 4)}${'*'.repeat(Math.min(14, roomId.length - 8))}${roomId.slice(-4)}`
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${bytes} B`
}

function formatLastSeen(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleString()
}

export default function MessengerPage() {
  const queryClient = useQueryClient()
  const { setColorScheme } = useMantineColorScheme()
  const { t } = useI18n()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1180px)')
  const [session, setSession] = useState<AuthSession | null>(null)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [roomName, setRoomName] = useState('')
  const [roomSecret, setRoomSecret] = useState('')
  const [inviteText, setInviteText] = useState('')
  const [roomSecrets, setRoomSecrets] = useState<Record<string, string>>({})
  const [activeRoomID, setActiveRoomID] = useState('')
  const [messageText, setMessageText] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [mobileView, setMobileView] = useState<'chat' | 'rooms' | 'profile'>('rooms')
  const [sidebarView, setSidebarView] = useState<'chat' | 'rooms' | 'profile'>('rooms')
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [avatarVersion, setAvatarVersion] = useState(Date.now())
  const [liveMessages, setLiveMessages] = useState<EncryptedMessage[]>([])
  const [typingUsers, setTypingUsers] = useState<Record<string, { displayName: string; until: number }>>({})
  const [presence, setPresence] = useState<Record<string, { displayName: string; status: 'online' | 'offline'; lastSeenAt: string }>>({})
  const [callState, setCallState] = useState<CallState>('idle')
  const [incomingCall, setIncomingCall] = useState<Extract<RealtimeEvent, { kind: 'call-offer' }> | null>(null)
  const [callPeerName, setCallPeerName] = useState('')
  const [profileUser, setProfileUser] = useState<Identity | null>(null)
  const [leavingRoom, setLeavingRoom] = useState(false)
  const [mobileChatActionsOpened, setMobileChatActionsOpened] = useState(false)
  const [leaveConfirmOpened, setLeaveConfirmOpened] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const messagesViewportRef = useRef<HTMLDivElement | null>(null)
  const authExpiredNotifiedRef = useRef(false)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const activeCallIDRef = useRef('')
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const savedSession = readStoredJSON<AuthSession>(SESSION_KEY)
    if (!savedSession) return
    setSession(savedSession)
    setColorScheme(savedSession.principal.theme)
    setDisplayName(savedSession.principal.displayName || savedSession.principal.username)
    loadAccountLocalState(savedSession)
  }, [])

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 5000 })
  const rooms = useQuery({
    queryKey: ['chat-rooms', identity?.userId, session?.accessToken],
    queryFn: () => fetchRooms(session?.accessToken ?? ''),
    enabled: Boolean(identity && session),
    refetchInterval: 3000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  const accountSessions = useQuery({
    queryKey: ['account-sessions', session?.accessToken],
    queryFn: () => fetchAccountSessions(session?.accessToken ?? ''),
    enabled: Boolean(session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })
  const history = useQuery({
    queryKey: ['chat-messages', activeRoomID, session?.accessToken],
    queryFn: () => fetchMessages(activeRoomID, session?.accessToken ?? ''),
    enabled: Boolean(activeRoomID && session),
    refetchInterval: activeRoomID ? 3000 : false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  const activeRoom = useMemo(
    () => rooms.data?.rooms.find((room) => room.roomId === activeRoomID) ?? null,
    [rooms.data?.rooms, activeRoomID],
  )
  const memberIdentities = useQuery({
    queryKey: ['chat-identities', activeRoomID, activeRoom?.members, session?.accessToken],
    queryFn: async () => {
      if (!activeRoom || !session) return [] as Identity[]
      const identities = await Promise.all(
        activeRoom.members.map((member) => fetchIdentity(member, session.accessToken).catch((err) => {
          if (err instanceof AuthError) throw err
          return null
        })),
      )
      return identities.filter((item): item is Identity => Boolean(item))
    },
    enabled: Boolean(activeRoom && session),
    refetchInterval: 10000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  const activeSecret = activeRoomID ? roomSecrets[activeRoomID] : ''
  const activeInvite = activeRoomID && activeSecret ? `${activeRoomID}:${activeSecret}` : ''
  const activeTopic = activeRoomID ? `room:${activeRoomID}` : ''
  const leftView = isMobile ? mobileView : sidebarView
  const ownAvatarSrc = useMemo(() => {
    const url = absoluteAvatarUrl(session?.principal.avatarUrl)
    return url ? `${url}?v=${avatarVersion}` : ''
  }, [avatarVersion, session?.principal.avatarUrl])
  const activeTyping = useMemo(
    () => Object.entries(typingUsers)
      .filter(([userId, value]) => userId !== identity?.userId && value.until > Date.now())
      .map(([, value]) => value.displayName),
    [identity?.userId, typingUsers],
  )

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
  const peers = useMemo(
    () => (memberIdentities.data ?? []).filter((member) => member.userId !== identity?.userId),
    [identity?.userId, memberIdentities.data],
  )
  const identitiesByID = useMemo(() => {
    const result = new Map<string, Identity>()
    for (const item of memberIdentities.data ?? []) result.set(item.userId, item)
    return result
  }, [memberIdentities.data])

  useEffect(() => {
    const error = rooms.error ?? history.error ?? memberIdentities.error ?? accountSessions.error
    if (error instanceof AuthError) handleAuthExpired()
  }, [rooms.error, history.error, memberIdentities.error, accountSessions.error])

  function saveSession(next: AuthSession, options: { reloadLocalState?: boolean } = { reloadLocalState: true }) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    authExpiredNotifiedRef.current = false
    setSession(next)
    if (options.reloadLocalState !== false) loadAccountLocalState(next)
  }

  function accountStorageID(target: AuthSession | null = session) {
    return target?.principal.userId || target?.principal.clientId || ''
  }

  function loadAccountLocalState(target: AuthSession) {
    const accountId = accountStorageID(target)
    const savedSecrets = accountId ? readStoredJSON<Record<string, string>>(accountScopedKey(ROOM_SECRETS_KEY, accountId)) : null

    setIdentity(null)
    setRoomSecrets(savedSecrets ?? {})
    setActiveRoomID('')
    setLiveMessages([])
    setTypingUsers({})
    setPresence({})
    setMobileChatActionsOpened(false)
    setLeaveConfirmOpened(false)
    if (isMobile) setMobileView('rooms')
    else setSidebarView('rooms')
    fetchCurrentIdentity(target.accessToken)
      .then(setIdentity)
      .catch((err: Error) => {
        if (err instanceof AuthError) handleAuthExpired()
        else notifications.show({ title: t('profileTitle'), message: err.message, color: 'red' })
      })
  }

  function clearAccountLocalState() {
    setIdentity(null)
    setRoomSecrets({})
    setActiveRoomID('')
    setLiveMessages([])
    setTypingUsers({})
    setPresence({})
    setMobileView('rooms')
    setSidebarView('rooms')
    setMobileChatActionsOpened(false)
    setLeaveConfirmOpened(false)
  }

  function persistRoomSecrets(nextSecrets: Record<string, string>) {
    setRoomSecrets(nextSecrets)
    const accountId = accountStorageID()
    if (accountId) localStorage.setItem(accountScopedKey(ROOM_SECRETS_KEY, accountId), JSON.stringify(nextSecrets))
  }

  function updateSessionPrincipal(principal: AuthSession['principal']) {
    if (!session) return
    saveSession({ ...session, principal }, { reloadLocalState: false })
  }

  function sendRealtime(event: RealtimeEvent) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !activeTopic) return
    wsRef.current.send(JSON.stringify({ type: 'publish', topic: activeTopic, data: event }))
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

  function handleAuthExpired() {
    if (authExpiredNotifiedRef.current) return
    authExpiredNotifiedRef.current = true
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
    clearAccountLocalState()
    wsRef.current?.close()
    queryClient.clear()
    notifications.show({ title: t('sessionExpired'), message: t('sessionExpiredMessage'), color: 'yellow' })
  }

  function handleRequestError(err: Error, title: string) {
    if (err instanceof AuthError) {
      handleAuthExpired()
      return
    }
    notifications.show({ title, message: err.message, color: 'red' })
  }

  useEffect(() => {
    if (!identity || !session) return
    touchIdentity(identity.userId, session.accessToken).catch((err) => {
      if (err instanceof AuthError) handleAuthExpired()
    })
    const timer = window.setInterval(() => {
      touchIdentity(identity.userId, session.accessToken).catch((err) => {
        if (err instanceof AuthError) handleAuthExpired()
      })
    }, 60000)
    return () => window.clearInterval(timer)
  }, [identity, session])

  useEffect(() => {
    if (!identity) return
    const handleClose = () => {
      sendRealtime({ kind: 'presence', userId: identity.userId, displayName: identity.displayName, status: 'offline', lastSeenAt: new Date().toISOString() })
    }
    window.addEventListener('beforeunload', handleClose)
    return () => window.removeEventListener('beforeunload', handleClose)
  }, [identity, activeTopic])

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
  }, [memberIdentities.data])

  const authMutation = useMutation({
    mutationFn: () => {
      if (authMode === 'register') {
        return registerUser({ username, password, displayName: displayName.trim() || username })
      }
      return loginUser({ username, password })
    },
    onSuccess: (next) => {
      saveSession(next)
      setColorScheme(next.principal.theme)
      setDisplayName(next.principal.username || username)
      notifications.show({ title: authMode === 'register' ? t('createAccount') : t('login'), message: t('sessionReady'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('login')),
  })

  const avatarMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!session) throw new Error('login_required')
      const avatar = await compressAvatar(file)
      if (avatar.size > 1024 * 1024) throw new Error('avatar_too_large_after_compression')
      return uploadAvatar({ token: session.accessToken, blob: avatar })
    },
    onSuccess: (principal) => {
      updateSessionPrincipal(principal)
      setAvatarVersion(Date.now())
      notifications.show({ title: t('avatarReady'), message: t('avatarReadyMessage'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('avatarFailed')),
  })

  const revokeSessionMutation = useMutation({
    mutationFn: async (target: AccountSession) => {
      if (!session) throw new Error('login_required')
      await revokeAccountSession({ token: session.accessToken, sessionId: target.sessionId })
      return target
    },
    onSuccess: (target) => {
      if (target.current) {
        logoutLocal()
      } else {
        accountSessions.refetch()
      }
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

  const createRoomMutation = useMutation({
    mutationFn: async () => {
      if (!identity || !session) throw new Error('account_required')
      const secret = createRoomSecret()
      const room = await createRoom({ name: roomName.trim() || t('privateRoom'), members: [identity.userId], token: session.accessToken })
      return { room, secret }
    },
    onSuccess: ({ room, secret }) => {
      const nextSecrets = { ...roomSecrets, [room.roomId]: secret }
      persistRoomSecrets(nextSecrets)
      setActiveRoomID(room.roomId)
      if (isMobile) setMobileView('chat')
      else setSidebarView('chat')
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
      sendSystemMessage(room.roomId, secret, 'join').catch(() => undefined)
      notifications.show({ title: t('roomReady'), message: t('roomReadyMessage'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('roomError')),
  })

  const importInviteMutation = useMutation({
    mutationFn: async () => {
      if (!identity || !session) throw new Error('account_required')
      const [roomId, secret] = inviteText.trim().split(':')
      if (!roomId || !secret) throw new Error('invite_format_must_be_roomId_secret')
      const room = await createRoom({ roomId, name: t('importedRoom'), members: [identity.userId], token: session.accessToken })
      return { room, secret }
    },
    onSuccess: ({ room, secret }) => {
      const nextSecrets = { ...roomSecrets, [room.roomId]: secret }
      persistRoomSecrets(nextSecrets)
      setActiveRoomID(room.roomId)
      if (isMobile) setMobileView('chat')
      else setSidebarView('chat')
      setInviteText('')
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
      sendSystemMessage(room.roomId, secret, 'join').catch(() => undefined)
      notifications.show({ title: t('inviteImported'), message: t('inviteImportedMessage'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('inviteError')),
  })

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!identity || !session || !activeRoomID || !activeSecret) throw new Error('room_not_ready')
      let attachment: PlainMessage['attachment']
      if (selectedFile) {
        const encryptedFile = await encryptFile(activeSecret, selectedFile)
        const uploaded = await uploadEncryptedFile({ token: session.accessToken, blob: encryptedFile.blob })
        attachment = {
          fileId: uploaded.fileId,
          name: selectedFile.name,
          type: selectedFile.type,
          size: selectedFile.size,
          ciphertextSize: uploaded.size,
          nonce: encryptedFile.nonce,
          algorithm: encryptedFile.algorithm,
        }
      }
      const encrypted = await encryptMessage(activeSecret, {
        text: messageText,
        senderName: identity.displayName,
        senderAvatarUrl: session.principal.avatarUrl,
        sentAt: new Date().toISOString(),
        attachment,
      })
      return sendEncryptedMessage({
        roomId: activeRoomID,
        senderId: identity.userId,
        token: session.accessToken,
        ...encrypted,
      })
    },
    onSuccess: () => {
      setMessageText('')
      setSelectedFile(null)
      if (identity) {
        sendRealtime({ kind: 'typing', userId: identity.userId, displayName: identity.displayName, typing: false, at: new Date().toISOString() })
      }
      queryClient.invalidateQueries({ queryKey: ['chat-messages', activeRoomID] })
    },
    onError: (err: Error) => handleRequestError(err, t('sendFailed')),
  })

  const encryptedMessages = useMemo(() => {
    const byID = new Map<string, EncryptedMessage>()
    for (const msg of history.data?.messages ?? []) byID.set(msg.id, msg)
    for (const msg of liveMessages) byID.set(msg.id, msg)
    return [...byID.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [history.data?.messages, liveMessages])

  const [decryptedMessages, setDecryptedMessages] = useState<DecryptedMessage[]>([])
  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!activeSecret) {
        setDecryptedMessages([])
        return
      }
      const next = await Promise.all(
        encryptedMessages.map(async (msg) => {
          try {
            return {
              id: msg.id,
              senderId: msg.senderId,
              body: await decryptMessage(activeSecret, msg.ciphertext, msg.nonce),
              createdAt: msg.createdAt,
            }
          } catch {
            return { id: msg.id, senderId: msg.senderId, body: null, createdAt: msg.createdAt, failed: true }
          }
        }),
      )
      if (!cancelled) setDecryptedMessages(next)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [activeSecret, encryptedMessages])

  useEffect(() => {
    const viewport = messagesViewportRef.current
    if (!viewport || !activeRoomID) return
    window.requestAnimationFrame(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
    })
  }, [activeRoomID, decryptedMessages.length])

  function handleRealtimeEvent(event: RealtimeEvent) {
    if (!identity) return
    if ('userId' in event && event.userId === identity.userId) return
    if ('fromUserId' in event && event.fromUserId === identity.userId) return
    if (event.kind === 'typing') {
      setTypingUsers((prev) => ({
        ...prev,
        [event.userId]: { displayName: event.displayName, until: event.typing ? Date.now() + 3500 : 0 },
      }))
      return
    }
    if (event.kind === 'presence') {
      setPresence((prev) => ({
        ...prev,
        [event.userId]: {
          displayName: event.displayName,
          status: event.status,
          lastSeenAt: event.lastSeenAt,
        },
      }))
      notifyChat(event.status === 'online' ? t('userJoined') : t('userLeft'), event.displayName)
      return
    }
    handleCallEvent(event)
  }

  function handleIncomingData(data: unknown) {
    const maybeEvent = data as Partial<RealtimeEvent>
    if (typeof maybeEvent.kind === 'string') {
      handleRealtimeEvent(maybeEvent as RealtimeEvent)
      return
    }
    const msg = data as EncryptedMessage
    if (msg.senderId !== identity?.userId) notifyChat(t('newMessage'), activeRoom?.name)
    setLiveMessages((prev) => [...prev, msg].slice(-200))
  }

  const connectWS = useCallback((roomID: string) => {
    if (!session) return
    wsRef.current?.close()
    setLiveMessages([])
    const url = new URL(`${WS_BASE}/ws`)
    url.searchParams.set('topics', `room:${roomID}`)
    url.searchParams.set('token', session.accessToken)
    const ws = new WebSocket(url.toString())
    wsRef.current = ws
    ws.onopen = () => {
      if (!identity) return
      sendRealtime({
        kind: 'presence',
        userId: identity.userId,
        displayName: identity.displayName,
        status: 'online',
        lastSeenAt: new Date().toISOString(),
      })
    }
    ws.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data) as MessageEnvelope
        if (envelope.topic === `room:${roomID}`) {
          handleIncomingData(envelope.data)
        }
      } catch {
        // ignore malformed frames
      }
    }
    ws.onerror = () => notifications.show({ title: t('wsError'), message: t('liveDisconnected'), color: 'red' })
  }, [session, identity, activeTopic])

  useEffect(() => {
    if (activeRoomID) connectWS(activeRoomID)
    return () => wsRef.current?.close()
  }, [activeRoomID, connectWS, identity])

  function selectRoom(room: Room) {
    setActiveRoomID(room.roomId)
    requestNotifications()
    if (isMobile) setMobileView('chat')
    else setSidebarView('chat')
  }

  async function sendSystemMessage(roomID: string, secret: string, type: 'join' | 'leave') {
    if (!identity || !session || !roomID || !secret) return
    const text = type === 'join' ? t('systemJoined') : t('systemLeft')
    const encrypted = await encryptMessage(secret, {
      text: '',
      senderName: identity.displayName,
      senderAvatarUrl: session.principal.avatarUrl,
      sentAt: new Date().toISOString(),
      system: { type, text: `${identity.displayName} ${text}` },
    })
    await sendEncryptedMessage({
      roomId: roomID,
      senderId: identity.userId,
      token: session.accessToken,
      ...encrypted,
    })
    queryClient.invalidateQueries({ queryKey: ['chat-messages', roomID] })
  }

  async function leaveActiveRoom() {
    if (!activeRoomID || !identity || !session) return
    setLeavingRoom(true)
    try {
      await sendSystemMessage(activeRoomID, activeSecret, 'leave').catch(() => undefined)
      await leaveRoom({ roomId: activeRoomID, userId: identity.userId, token: session.accessToken })
      const nextSecrets = { ...roomSecrets }
      delete nextSecrets[activeRoomID]
      persistRoomSecrets(nextSecrets)
      setActiveRoomID('')
      setMobileView('rooms')
      setSidebarView('rooms')
      setMobileChatActionsOpened(false)
      setLeaveConfirmOpened(false)
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired()
      } else {
        notifications.show({ title: t('leaveFailed'), message: err instanceof Error ? err.message : 'leave_failed', color: 'red' })
      }
    } finally {
      setLeavingRoom(false)
    }
  }

  function closeChat() {
    setMobileChatActionsOpened(false)
    setActiveRoomID('')
    setMobileView('rooms')
    setSidebarView('rooms')
  }

  function requestLeaveChat() {
    setLeaveConfirmOpened(true)
  }

  function saveManualSecret() {
    if (!activeRoomID || !roomSecret.trim()) return
    const nextSecrets = { ...roomSecrets, [activeRoomID]: roomSecret.trim() }
    persistRoomSecrets(nextSecrets)
    setRoomSecret('')
  }

  function logoutLocal() {
    if (identity) {
      sendRealtime({ kind: 'presence', userId: identity.userId, displayName: identity.displayName, status: 'offline', lastSeenAt: new Date().toISOString() })
    }
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
    clearAccountLocalState()
    wsRef.current?.close()
    queryClient.clear()
  }

  function logout() {
    const current = accountSessions.data?.sessions.find((item) => item.current)
    if (current && session) {
      revokeSessionMutation.mutate(current)
      return
    }
    logoutLocal()
  }

  function submitAuth() {
    if (!username.trim() || password.length < 8 || authMutation.isPending) return
    authMutation.mutate()
  }

  function submitMessage() {
    if ((!messageText.trim() && !selectedFile) || !activeSecret || sendMutation.isPending) return
    if (selectedFile && selectedFile.size > MAX_FILE_BYTES) {
      notifications.show({ title: t('fileTooLarge'), message: t('fileTooLargeMessage'), color: 'red' })
      return
    }
    sendMutation.mutate()
  }

  function updateMessageText(value: string) {
    setMessageText(value)
    if (!identity || !activeTopic) return
    sendRealtime({
      kind: 'typing',
      userId: identity.userId,
      displayName: identity.displayName,
      typing: Boolean(value.trim()),
      at: new Date().toISOString(),
    })
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(() => {
      sendRealtime({
        kind: 'typing',
        userId: identity.userId,
        displayName: identity.displayName,
        typing: false,
        at: new Date().toISOString(),
      })
    }, 1200)
  }

  function selectFile(file: File | null) {
    if (file && file.size > MAX_FILE_BYTES) {
      setSelectedFile(null)
      notifications.show({ title: t('fileTooLarge'), message: t('fileTooLargeMessage'), color: 'red' })
      return
    }
    setSelectedFile(file)
  }

  async function previewAttachment(msg: DecryptedMessage) {
    if (!session || !activeSecret || !msg.body?.attachment) return
    const attachment = msg.body.attachment
    try {
      const encrypted = await downloadEncryptedFile({ token: session.accessToken, fileId: attachment.fileId })
      const decrypted = await decryptFile(activeSecret, encrypted, attachment.nonce, attachment.type)
      const url = URL.createObjectURL(decrypted)
      setPreviews((prev) => {
        if (prev[msg.id]) URL.revokeObjectURL(prev[msg.id])
        return { ...prev, [msg.id]: url }
      })
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired()
      } else {
        notifications.show({ title: t('previewFailed'), message: err instanceof Error ? err.message : t('unableToDecrypt'), color: 'red' })
      }
    }
  }

  async function downloadAttachment(msg: DecryptedMessage) {
    if (!session || !activeSecret || !msg.body?.attachment) return
    const attachment = msg.body.attachment
    try {
      const encrypted = await downloadEncryptedFile({ token: session.accessToken, fileId: attachment.fileId })
      const decrypted = await decryptFile(activeSecret, encrypted, attachment.nonce, attachment.type)
      const url = URL.createObjectURL(decrypted)
      const link = document.createElement('a')
      link.href = url
      link.download = attachment.name
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired()
      } else {
        notifications.show({ title: t('downloadFailed'), message: err instanceof Error ? err.message : t('unableToDecrypt'), color: 'red' })
      }
    }
  }

  async function ensurePeer(callId: string) {
    if (peerRef.current) return peerRef.current
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    activeCallIDRef.current = callId
    peer.onicecandidate = (event) => {
      if (!event.candidate || !identity) return
      sendRealtime({ kind: 'call-ice', callId, fromUserId: identity.userId, candidate: event.candidate.toJSON() })
    }
    peer.ontrack = (event) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0]
      }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    localStreamRef.current = stream
    stream.getTracks().forEach((track) => peer.addTrack(track, stream))
    peerRef.current = peer
    return peer
  }

  async function startCall() {
    if (!identity || !activeRoomID || callState !== 'idle') return
    try {
      const callId = crypto.randomUUID()
      const peer = await ensurePeer(callId)
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      setCallState('calling')
      sendRealtime({ kind: 'call-offer', callId, fromUserId: identity.userId, displayName: identity.displayName, offer })
    } catch (err) {
      notifications.show({ title: t('callFailed'), message: err instanceof Error ? err.message : 'call_failed', color: 'red' })
      endCall(false)
    }
  }

  async function answerCall() {
    if (!incomingCall || !identity) return
    try {
      const peer = await ensurePeer(incomingCall.callId)
      await peer.setRemoteDescription(incomingCall.offer)
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      setCallState('connected')
      setCallPeerName(incomingCall.displayName)
      sendRealtime({ kind: 'call-answer', callId: incomingCall.callId, fromUserId: identity.userId, answer })
      setIncomingCall(null)
    } catch (err) {
      notifications.show({ title: t('callFailed'), message: err instanceof Error ? err.message : 'call_failed', color: 'red' })
      endCall(true)
    }
  }

  function endCall(notifyPeer = true) {
    if (notifyPeer && identity && activeCallIDRef.current) {
      sendRealtime({ kind: 'call-hangup', callId: activeCallIDRef.current, fromUserId: identity.userId })
    }
    peerRef.current?.close()
    peerRef.current = null
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    activeCallIDRef.current = ''
    setCallState('idle')
    setIncomingCall(null)
    setCallPeerName('')
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
  }

  async function handleCallEvent(event: RealtimeEvent) {
    if (!identity || !('fromUserId' in event) || event.fromUserId === identity.userId) return
    if (event.kind === 'call-offer') {
      if (callState !== 'idle') return
      setIncomingCall(event)
      setCallState('ringing')
      setCallPeerName(event.displayName)
      return
    }
    if (event.callId !== activeCallIDRef.current) return
    if (event.kind === 'call-answer' && peerRef.current) {
      await peerRef.current.setRemoteDescription(event.answer)
      setCallState('connected')
      return
    }
    if (event.kind === 'call-ice' && peerRef.current) {
      await peerRef.current.addIceCandidate(event.candidate)
      return
    }
    if (event.kind === 'call-hangup') {
      endCall(false)
    }
  }

  if (!session) {
    return (
      <Stack maw={520} mx={isMobile ? 'auto' : 0} px={isMobile ? 'xs' : 0}>
        <Title order={1}>Quietline</Title>
        <Text c="dimmed">{t('quietlineIntro')}</Text>
        <TextInput
          label={t('loginName')}
          placeholder="alice"
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitAuth()
          }}
        />
            {authMode === 'register' && (
          <TextInput
            label={t('displayName')}
            placeholder="Alice"
            value={displayName}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitAuth()
            }}
          />
        )}
        <PasswordInput
          label={t('password')}
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitAuth()
          }}
        />
        <Group>
          <Button
            onClick={submitAuth}
            loading={authMutation.isPending}
            disabled={!username.trim() || password.length < 8}
          >
            {authMode === 'register' ? t('createAccount') : t('login')}
          </Button>
          <Button variant="subtle" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
            {authMode === 'login' ? t('needAccount') : t('alreadyHaveAccount')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">{t('passwordHint')}</Text>
      </Stack>
    )
  }

  if (!identity) {
    return (
      <Stack maw={520} mx={isMobile ? 'auto' : 0} px={isMobile ? 'xs' : 0}>
        <Title order={1}>Quietline</Title>
        <Text c="dimmed">{t('loadingProfile')}</Text>
        <Button variant="subtle" onClick={logout}>{t('logout')}</Button>
      </Stack>
    )
  }

  return (
    <>
      <Modal opened={Boolean(profileUser)} onClose={() => setProfileUser(null)} title={t('profileTitle')} centered>
        {profileUser && (
          <Stack gap="sm">
            <Group>
              <Avatar name={profileUser.displayName} radius="xl" size={56} />
              <div>
                <Text fw={700}>{profileUser.displayName}</Text>
                <Text size="xs" c="dimmed">{presence[profileUser.userId]?.status === 'online' ? t('online') : `${t('lastSeen')} ${formatLastSeen(presence[profileUser.userId]?.lastSeenAt || profileUser.lastSeenAt)}`}</Text>
              </div>
            </Group>
            <Text size="xs" c="dimmed">{t('userId')}</Text>
            <Code block>{profileUser.userId}</Code>
            <Text size="xs" c="dimmed">{t('publicKey')}</Text>
            <Code block style={{ maxHeight: 160, overflow: 'auto' }}>{profileUser.identityPublicKey}</Code>
          </Stack>
        )}
      </Modal>
      <Modal opened={mobileChatActionsOpened} onClose={() => setMobileChatActionsOpened(false)} title={activeRoom?.name ?? t('chat')} centered>
        {activeRoom && (
          <Stack gap="sm">
            <Group gap={6} wrap="nowrap">
              <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>room:{maskedRoomId(activeRoom.roomId)}</Text>
              <CopyButton value={activeRoom.roomId}>
                {({ copy }) => (
                  <ActionIcon size="sm" variant="subtle" onClick={copy} aria-label={t('copyRoomId')}>
                    <IconCopy size={14} />
                  </ActionIcon>
                )}
              </CopyButton>
            </Group>
            {!isMobile && memberIdentities.data && memberIdentities.data.length > 0 && (
              <Group gap={6}>
                {peers.map((member) => {
                  const current = presence[member.userId]
                  const isOnline = current?.status === 'online'
                  return (
                    <Badge
                      key={member.userId}
                      variant="light"
                      color={isOnline ? 'green' : 'gray'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setProfileUser(member)}
                    >
                      {member.displayName}: {isOnline ? t('online') : `${t('lastSeen')} ${formatLastSeen(current?.lastSeenAt || member.lastSeenAt)}`}
                    </Badge>
                  )
                })}
              </Group>
            )}
            <Button variant="subtle" onClick={closeChat} fullWidth>
              {t('closeChat')}
            </Button>
            <Button
              variant={callState === 'idle' ? 'light' : 'filled'}
              color={callState === 'idle' ? 'green' : 'red'}
              leftSection={callState === 'idle' ? <IconPhone size={16} /> : <IconPhoneOff size={16} />}
              onClick={callState === 'idle' ? startCall : () => endCall(true)}
              fullWidth
              disabled={!activeSecret}
            >
              {callState === 'idle' ? t('startCall') : t('endCall')}
            </Button>
            <CopyButton value={activeInvite}>
              {({ copy }) => (
                <Button variant="light" leftSection={<IconCopy size={16} />} onClick={copy} fullWidth disabled={!activeInvite}>
                  {t('copyInvite')}
                </Button>
              )}
            </CopyButton>
            {!activeInvite && <Text size="xs" c="dimmed">{t('inviteSecretMissing')}</Text>}
            <Button variant="light" color="red" onClick={requestLeaveChat} loading={leavingRoom} fullWidth>
              {t('leaveChat')}
            </Button>
          </Stack>
        )}
      </Modal>
      <Modal opened={leaveConfirmOpened} onClose={() => setLeaveConfirmOpened(false)} title={t('leaveChat')} centered>
        <Stack gap="md">
          <Text size="sm">{t('leaveChatConfirm')}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setLeaveConfirmOpened(false)}>{t('cancel')}</Button>
            <Button color="red" onClick={leaveActiveRoom} loading={leavingRoom}>{t('leaveChat')}</Button>
          </Group>
        </Stack>
      </Modal>
      {isMobile && (
        <SegmentedControl
          fullWidth
          mb="sm"
          value={mobileView}
          onChange={(value) => setMobileView(value as 'chat' | 'rooms' | 'profile')}
          data={[
            { value: 'chat', label: t('chat') },
            { value: 'rooms', label: t('rooms') },
            { value: 'profile', label: t('profile') },
          ]}
        />
      )}
      <Group
      align="stretch"
      gap="md"
      wrap={isMobile ? 'wrap' : 'nowrap'}
      style={{ height: isMobile ? 'auto' : 'calc(100vh - 96px)', minHeight: 0 }}
    >
      <Stack
        w={isMobile ? '100%' : isTablet ? 300 : 340}
        gap="md"
        style={{ minHeight: 0, flexShrink: 0, display: isMobile && mobileView === 'chat' ? 'none' : 'flex' }}
      >
        {!isMobile && (
          <SegmentedControl
            fullWidth
            value={sidebarView}
            onChange={(value) => setSidebarView(value as 'chat' | 'rooms' | 'profile')}
            data={[
              { value: 'chat', label: t('chat') },
              { value: 'rooms', label: t('rooms') },
              { value: 'profile', label: t('profile') },
            ]}
          />
        )}

        <Card withBorder radius="sm" p="md" style={{ display: leftView === 'chat' ? undefined : 'none' }}>
          <Title order={4} mb="xs">{t('chat')}</Title>
          {activeRoom ? (
            <Stack gap="xs">
              <Text fw={700} truncate>{activeRoom.name}</Text>
              <Text size="xs" c="dimmed" truncate>room:{maskedRoomId(activeRoom.roomId)}</Text>
              <Button variant="light" onClick={() => setSidebarView('rooms')}>{t('rooms')}</Button>
            </Stack>
          ) : (
            <Stack gap="xs">
              <Text size="sm" c="dimmed">{t('chooseRoom')}</Text>
              <Button variant="light" onClick={() => setSidebarView('rooms')}>{t('rooms')}</Button>
            </Stack>
          )}
        </Card>

        <Card withBorder radius="sm" p="md" style={{ display: leftView === 'profile' ? undefined : 'none' }}>
          <Group justify="space-between" align="flex-start" mb="xs" wrap="nowrap">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <Avatar src={ownAvatarSrc} name={session.principal.displayName || identity.displayName} radius="xl" size={52} />
              <div style={{ minWidth: 0 }}>
                <Text fw={700} truncate>{session.principal.displayName || identity.displayName}</Text>
                <Text size="xs" c="dimmed" truncate>{t('account')}: {session.principal.username}</Text>
              </div>
            </Group>
            <Badge color={health.data?.status === 'ok' ? 'green' : 'red'} style={{ flexShrink: 0 }}>
              {health.data?.status === 'ok' ? t('online') : t('offline')}
            </Badge>
          </Group>
          <FileInput
            label={t('avatar')}
            placeholder={t('avatarUpload')}
            accept="image/png,image/jpeg,image/webp"
            onChange={(file) => {
              if (file) avatarMutation.mutate(file)
            }}
            disabled={avatarMutation.isPending}
            clearable
            mb="sm"
          />
          <Text size="xs" c="dimmed">{t('userId')}</Text>
          <Group gap={6} wrap="nowrap">
            <Code block style={{ flex: 1, fontSize: 11 }}>{identity.userId}</Code>
            <CopyButton value={identity.userId}>
              {({ copy }) => <ActionIcon variant="subtle" onClick={copy}><IconCopy size={16} /></ActionIcon>}
            </CopyButton>
          </Group>
          <Divider my="sm" />
          <Group justify="space-between" align="center" mb="xs">
            <Text fw={700} size="sm">{t('sessions')}</Text>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => accountSessions.refetch()}
              loading={accountSessions.isFetching}
            >
              {t('refresh')}
            </Button>
          </Group>
          <Stack gap="xs">
            {(accountSessions.data?.sessions ?? []).map((item) => (
              <Group key={item.sessionId} justify="space-between" gap="xs" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text size="xs" fw={item.current ? 700 : 500} truncate>
                    {item.current ? t('currentSession') : item.sessionId.slice(0, 8)}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {t('created')}: {formatLastSeen(item.createdAt)}
                  </Text>
                </div>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  onClick={() => revokeSessionMutation.mutate(item)}
                  loading={revokeSessionMutation.isPending}
                >
                  {item.current ? t('logout') : t('revoke')}
                </Button>
              </Group>
            ))}
            {(accountSessions.data?.sessions ?? []).length === 0 && (
              <Text size="xs" c="dimmed">{t('noSessions')}</Text>
            )}
          </Stack>
          <Group mt="sm" grow>
            <Button
              variant="light"
              color="red"
              onClick={() => revokeOtherSessionsMutation.mutate()}
              loading={revokeOtherSessionsMutation.isPending}
            >
              {t('revokeOtherSessions')}
            </Button>
            <Button color="red" onClick={logout} loading={revokeSessionMutation.isPending}>
              {t('logout')}
            </Button>
          </Group>
        </Card>

        <Card withBorder radius="sm" p="md" style={{ display: leftView === 'rooms' ? undefined : 'none' }}>
          <Title order={4} mb="sm">{t('createRoom')}</Title>
          <Stack gap="sm">
            <TextInput label={t('roomName')} value={roomName} onChange={(event) => setRoomName(event.currentTarget.value)} />
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => createRoomMutation.mutate()}
              loading={createRoomMutation.isPending}
              disabled={createRoomMutation.isPending}
            >
              {t('createEncryptedRoom')}
            </Button>
          </Stack>
        </Card>

        <Card withBorder radius="sm" p="md" style={{ display: leftView === 'rooms' ? undefined : 'none' }}>
          <Title order={4} mb="sm">{t('importInvite')}</Title>
          <Stack gap="sm">
            <PasswordInput
              label={t('invite')}
              placeholder="roomId:roomSecret"
              value={inviteText}
              onChange={(event) => setInviteText(event.currentTarget.value)}
            />
            <Button
              variant="light"
              leftSection={<IconKey size={16} />}
              onClick={() => importInviteMutation.mutate()}
              loading={importInviteMutation.isPending}
              disabled={!inviteText.trim()}
            >
              {t('joinRoom')}
            </Button>
          </Stack>
        </Card>

        <Card
          withBorder
          radius="sm"
          p="md"
          style={{
            display: leftView === 'rooms' ? 'flex' : 'none',
            flex: isMobile ? 'unset' : 1,
            minHeight: isMobile ? 320 : 0,
            flexDirection: 'column',
          }}
        >
          <Group justify="space-between" mb="sm">
            <Title order={4}>{t('rooms')}</Title>
            <ActionIcon variant="subtle" onClick={() => rooms.refetch()} loading={rooms.isFetching}>
              <IconRefresh size={16} />
            </ActionIcon>
          </Group>
          <ScrollArea type="auto" offsetScrollbars style={{ flex: 1, minHeight: 0 }}>
            <Stack gap="xs" pr="xs">
              {(rooms.data?.rooms ?? []).map((room) => {
                const hiddenId = maskedRoomId(room.roomId)
                return (
                  <Group key={room.roomId} gap={6} wrap="nowrap">
                    <Button
                      variant={activeRoomID === room.roomId ? 'filled' : 'light'}
                      justify="space-between"
                      onClick={() => selectRoom(room)}
                      style={{ flex: 1, minWidth: 0 }}
                      styles={{ label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
                    >
                      <span>{room.name} · {hiddenId}</span>
                    </Button>
                    <CopyButton value={room.roomId}>
                      {({ copy }) => (
                        <ActionIcon variant="light" onClick={copy} aria-label={t('copyRoomId')}>
                          <IconCopy size={16} />
                        </ActionIcon>
                      )}
                    </CopyButton>
                  </Group>
                )
              })}
              {(rooms.data?.rooms ?? []).length === 0 && <Text size="sm" c="dimmed">{t('noRooms')}</Text>}
            </Stack>
          </ScrollArea>
        </Card>
      </Stack>

      <Card
        withBorder
        radius="sm"
        p={isMobile ? 'sm' : 'md'}
        style={{
          display: !isMobile || mobileView === 'chat' ? 'flex' : 'none',
          flex: 1,
          width: isMobile ? '100%' : undefined,
          minWidth: 0,
          height: isMobile ? 'calc(100dvh - 132px)' : undefined,
          minHeight: isMobile ? 0 : 0,
        }}
      >
        {!activeRoom ? (
          <Stack align="center" justify="center" h="100%" style={{ flex: 1 }}>
            <IconLock size={38} />
            <Title order={3}>{t('chooseRoom')}</Title>
            <Text c="dimmed">{t('messagesEncrypted')}</Text>
            {isMobile && (
              <Button variant="light" onClick={() => setMobileView('rooms')}>{t('rooms')}</Button>
            )}
          </Stack>
        ) : (
          <Stack h="100%" style={{ flex: 1, minHeight: 0 }}>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div style={{ minWidth: 0, flex: 1 }}>
                <Title order={3}>{activeRoom.name}</Title>
                {isMobile ? (
                  <Text size="xs" c="dimmed" truncate>
                    {activeTyping.length > 0 ? `${activeTyping.join(', ')} ${t('typing')}` : ''}
                  </Text>
                ) : (
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" c="dimmed" truncate>room:{maskedRoomId(activeRoom.roomId)}</Text>
                    <CopyButton value={activeRoom.roomId}>
                      {({ copy }) => (
                        <ActionIcon size="sm" variant="subtle" onClick={copy} aria-label={t('copyRoomId')}>
                          <IconCopy size={14} />
                        </ActionIcon>
                      )}
                    </CopyButton>
                  </Group>
                )}
              </div>
              {isMobile ? (
                <ActionIcon variant="subtle" size="lg" onClick={() => setMobileChatActionsOpened(true)} aria-label={t('chat')}>
                  <IconDotsVertical size={20} />
                </ActionIcon>
              ) : (
                <Group gap="xs" wrap="nowrap">
                  <Button variant="subtle" onClick={closeChat}>
                    {t('closeChat')}
                  </Button>
                  <Button
                    variant={callState === 'idle' ? 'light' : 'filled'}
                    color={callState === 'idle' ? 'green' : 'red'}
                    leftSection={callState === 'idle' ? <IconPhone size={16} /> : <IconPhoneOff size={16} />}
                    onClick={callState === 'idle' ? startCall : () => endCall(true)}
                    disabled={!activeSecret}
                  >
                    {callState === 'idle' ? t('startCall') : t('endCall')}
                  </Button>
                  <CopyButton value={activeInvite}>
                    {({ copy }) => (
                      <Button variant="light" leftSection={<IconCopy size={16} />} onClick={copy} disabled={!activeInvite}>
                        {t('copyInvite')}
                      </Button>
                    )}
                  </CopyButton>
                  <Button variant="light" color="red" onClick={requestLeaveChat} loading={leavingRoom}>
                    {t('leaveChat')}
                  </Button>
                </Group>
              )}
            </Group>

            <audio ref={remoteAudioRef} autoPlay />
            {callState === 'ringing' && incomingCall && (
              <Alert color="green" title={`${t('incomingCall')}: ${incomingCall.displayName}`}>
                <Group mt="xs">
                  <Button leftSection={<IconPhone size={16} />} onClick={answerCall}>{t('answerCall')}</Button>
                  <Button variant="light" color="red" onClick={() => endCall(true)}>{t('declineCall')}</Button>
                </Group>
              </Alert>
            )}
            {callState !== 'idle' && callState !== 'ringing' && (
              <Text size="xs" c="dimmed">{t('callStatus')}: {callPeerName || t(callState === 'calling' ? 'calling' : 'connected')}</Text>
            )}

            {memberIdentities.data && memberIdentities.data.length > 0 && (
              <Group gap={6}>
                {peers.map((member) => {
                  const current = presence[member.userId]
                  const isOnline = current?.status === 'online'
                  return (
                    <Badge
                      key={member.userId}
                      variant="light"
                      color={isOnline ? 'green' : 'gray'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setProfileUser(member)}
                    >
                      {member.displayName}: {isOnline ? t('online') : `${t('lastSeen')} ${formatLastSeen(current?.lastSeenAt || member.lastSeenAt)}`}
                    </Badge>
                  )
                })}
              </Group>
            )}

            {!isMobile && <Box style={{ minHeight: 18 }}>
              <Text size="xs" c="dimmed" style={{ visibility: activeTyping.length > 0 ? 'visible' : 'hidden' }}>
                {activeTyping.length > 0 ? `${activeTyping.join(', ')} ${t('typing')}` : t('typing')}
              </Text>
            </Box>}

            {!activeSecret && (
              <Alert color="yellow" title={t('roomSecretRequired')}>
                <Group align="flex-end" mt="xs" wrap={isMobile ? 'wrap' : 'nowrap'}>
                  <PasswordInput
                    label={t('roomSecret')}
                    value={roomSecret}
                    onChange={(event) => setRoomSecret(event.currentTarget.value)}
                    style={{ flex: 1 }}
                  />
                  <Button onClick={saveManualSecret} fullWidth={isMobile}>{t('unlock')}</Button>
                </Group>
              </Alert>
            )}

            <Divider />

            <Box style={{ flex: 1, minHeight: 0 }}>
              <ScrollArea h="100%" type="auto" offsetScrollbars viewportRef={messagesViewportRef}>
                <Stack gap="xs" pr="sm">
                  {decryptedMessages.map((msg) => (
                    <Card key={msg.id} withBorder radius="sm" p="sm">
                      {msg.body?.system ? (
                        <Text size="sm" c="dimmed" ta="center">{msg.body.system.text}</Text>
                      ) : (
                        <>
                      <Group justify="space-between" align="flex-start" mb={4} wrap="nowrap">
                        <Group
                          gap="xs"
                          wrap="nowrap"
                          style={{ minWidth: 0, cursor: identitiesByID.has(msg.senderId) ? 'pointer' : undefined }}
                          onClick={() => {
                            const nextProfile = identitiesByID.get(msg.senderId)
                            if (nextProfile) setProfileUser(nextProfile)
                          }}
                        >
                          <Avatar
                            src={absoluteAvatarUrl(msg.body?.senderAvatarUrl)}
                            name={msg.body?.senderName ?? msg.senderId}
                            radius="xl"
                            size={30}
                          />
                          <Text size="sm" fw={700} truncate>{msg.body?.senderName ?? msg.senderId}</Text>
                        </Group>
                        <Text size="xs" c="dimmed">{new Date(msg.createdAt).toLocaleTimeString()}</Text>
                      </Group>
                      {msg.failed ? (
                        <Code block>{t('unableToDecrypt')}</Code>
                      ) : (
                        <Stack gap="xs">
                          {msg.body?.text && <Text>{msg.body.text}</Text>}
                          {msg.body?.attachment && (
                            <Card withBorder radius="sm" p="xs">
                              <Group justify="space-between" align="center">
                                <div>
                                  <Text size="sm" fw={600}>{msg.body.attachment.name}</Text>
                                  <Text size="xs" c="dimmed">
                                    {msg.body.attachment.type || 'file'} · {formatBytes(msg.body.attachment.size)}
                                  </Text>
                                </div>
                                <Group gap="xs">
                                  <Button size="xs" variant="light" onClick={() => previewAttachment(msg)}>
                                    {t('preview')}
                                  </Button>
                                  <ActionIcon variant="light" onClick={() => downloadAttachment(msg)} aria-label={t('download')}>
                                    <IconDownload size={16} />
                                  </ActionIcon>
                                </Group>
                              </Group>
                              {previews[msg.id] && msg.body.attachment.type.startsWith('image/') && (
                                <Image src={previews[msg.id]} alt={msg.body.attachment.name} mt="sm" mah={260} fit="contain" />
                              )}
                              {previews[msg.id] && !msg.body.attachment.type.startsWith('image/') && (
                                <Button
                                  component="a"
                                  href={previews[msg.id]}
                                  download={msg.body.attachment.name}
                                  mt="sm"
                                  variant="default"
                                  size="xs"
                                >
                                  {t('decryptedDownload')}
                                </Button>
                              )}
                            </Card>
                          )}
                        </Stack>
                      )}
                        </>
                      )}
                    </Card>
                  ))}
                  {decryptedMessages.length === 0 && (
                    <Text c="dimmed" ta="center" mt="xl">{t('noMessages')}</Text>
                  )}
                </Stack>
              </ScrollArea>
            </Box>

            <Stack gap={6} mt="auto">
              {selectedFile && (
                <Group gap="xs" wrap="nowrap">
                  <Badge variant="light" color="blue" style={{ maxWidth: '100%' }}>
                    {selectedFile.name} · {formatBytes(selectedFile.size)}
                  </Badge>
                  <ActionIcon variant="subtle" size="sm" onClick={() => setSelectedFile(null)} aria-label="Remove file">
                    <IconX size={14} />
                  </ActionIcon>
                </Group>
              )}
              <Group align="center" gap="xs" wrap="nowrap">
                <FileButton onChange={selectFile} accept="*/*" disabled={!activeSecret || sendMutation.isPending}>
                  {(props) => (
                    <ActionIcon
                      {...props}
                      variant="light"
                      size="lg"
                      aria-label={t('attach')}
                      title={t('attach')}
                    >
                      <IconPaperclip size={18} />
                    </ActionIcon>
                  )}
                </FileButton>
                <TextInput
                  aria-label={t('message')}
                  placeholder={activeSecret ? t('typeMessage') : t('unlockFirst')}
                  value={messageText}
                  onChange={(event) => updateMessageText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submitMessage()
                    }
                  }}
                  disabled={!activeSecret}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <ActionIcon
                  variant="filled"
                  size="lg"
                  onClick={submitMessage}
                  loading={sendMutation.isPending}
                  disabled={(!messageText.trim() && !selectedFile) || !activeSecret}
                  aria-label={t('send')}
                  title={t('send')}
                >
                  <IconSend size={18} />
                </ActionIcon>
              </Group>
            </Stack>
          </Stack>
        )}
      </Card>
      </Group>
    </>
  )
}
