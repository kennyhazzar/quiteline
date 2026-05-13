'use client'

import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  FileButton,
  Group,
  Image,
  Indicator,
  Menu,
  Modal,
  PasswordInput,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconCheck,
  IconChecks,
  IconChevronDown,
  IconChevronLeft,
  IconClock,
  IconCopy,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconInfoCircle,
  IconLink,
  IconLock,
  IconMessageCircle,
  IconPaperclip,
  IconPencil,
  IconPhone,
  IconPhoneEnd,
  IconPhoneIncoming,
  IconSend,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { useMutation } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import React, { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { absoluteAvatarUrl, updateRoomName, type AuthSession, type Friend, type Identity, type Room } from '@/lib/api'
import type { PlainMessage } from '@/lib/crypto'
import { useI18n } from '@/lib/i18n'
import type { AppView, CallState, DecryptedMessage, RealtimeEvent } from '@/types/messenger'
import {
  formatBytes,
  formatLastSeen,
  isPersistedMessageID,
  QUICK_REACTIONS,
} from '@/types/messenger'

interface ChatViewProps {
  isMobile: boolean
  mobileView: AppView
  setMobileView: (v: AppView) => void
  session: AuthSession
  identity: Identity
  ownAvatarSrc: string
  activeRoom: Room | null
  activeRoomID: string
  activeInvite: string
  activeInviteLink: string
  activeChatLink: string
  activeRoomSecret: string
  roomSecret: string
  setRoomSecret: (v: string) => void
  saveManualSecret: () => void
  closeChat: () => void
  requestLeaveChat: () => void
  leavingRoom: boolean
  peers: Identity[]
  presence: Record<string, { displayName: string; status: 'online' | 'offline'; lastSeenAt: string }>
  setProfileUser: (user: Identity | null) => void
  memberIdentities: UseQueryResult<Identity[]>
  identitiesByID: Map<string, Identity>
  mobilePeerStatus: string
  // messages
  visibleMessages: DecryptedMessage[]
  isMessagesLoading: boolean
  displayMessages: DecryptedMessage[]
  attachmentMessages: DecryptedMessage[]
  attachmentsOpened: boolean
  setAttachmentsOpened: (v: boolean) => void
  highlightedMessageID: string
  messageSearch: string
  setMessageSearch: (v: string) => void
  messagesViewportRef: RefObject<HTMLDivElement | null>
  messageInputRef: RefObject<HTMLInputElement | null>
  hasMoreMessages: boolean
  isLoadingMoreMessages: boolean
  loadMoreMessages: () => Promise<void>
  replyTarget: DecryptedMessage | null
  setReplyTarget: (msg: DecryptedMessage | null) => void
  selectedFile: File | null
  previews: Record<string, string>
  sendMutation: UseMutationResult<unknown, Error, unknown>
  editMessageMutation: UseMutationResult<unknown, Error, void>
  deleteMessageMutation: UseMutationResult<unknown, Error, void>
  reactionMutation: UseMutationResult<unknown, Error, { message: DecryptedMessage; emoji: string }>
  submitMessage: () => void
  updateMessageText: (v: string) => void
  selectFile: (file: File | null) => void
  openEditMessage: (msg: DecryptedMessage) => void
  openDeleteMessage: (msg: DecryptedMessage) => void
  copyMessageText: (msg: DecryptedMessage) => void
  previewAttachment: (msg: DecryptedMessage) => void
  downloadAttachment: (msg: DecryptedMessage) => void
  messageReplyPreview: (msg: DecryptedMessage) => PlainMessage['replyTo']
  setEditTarget: (msg: DecryptedMessage | null) => void
  setDeleteTarget: (msg: DecryptedMessage | null) => void
  setMessageInfo: (msg: DecryptedMessage | null) => void
  copyAppURL: (options?: { view?: AppView; roomId?: string; messageId?: string }) => void
  // typing
  activeTyping: string[]
  // call
  callState: CallState
  incomingCall: Extract<RealtimeEvent, { kind: 'call-offer' }> | null
  callPeerName: string
  callPeerID: string
  remoteAudioRef: RefObject<HTMLAudioElement | null>
  startCall: (targetUserId?: string) => void
  endCall: (notifyPeer?: boolean) => void
  answerCall: () => void
  declineIncomingCall: () => void
  setMobileChatActionsOpened: (v: boolean) => void
  // friends for invite
  acceptedFriends: Friend[]
  inviteFriendMutation: UseMutationResult<unknown, Error, Friend>
}

// Inline markdown + linkify renderer. Handles: URLs, **bold**, *italic*, `code`, ~~strike~~, newlines.
const INLINE_PATTERN = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|~~(.+?)~~/g

function parseInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = new RegExp(INLINE_PATTERN.source, 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...splitNewlines(text.slice(lastIndex, match.index), nodes.length))
    }
    const key = `${match.index}`
    if (match[1]) {
      nodes.push(
        <a key={key} href={match[1]} target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--mantine-color-blue-4)', wordBreak: 'break-all' }}>
          {match[1]}
        </a>
      )
    } else if (match[2]) {
      nodes.push(<strong key={key}>{match[2]}</strong>)
    } else if (match[3]) {
      nodes.push(<em key={key}>{match[3]}</em>)
    } else if (match[4]) {
      nodes.push(
        <code key={key} style={{
          background: 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))',
          padding: '1px 5px', borderRadius: 4, fontSize: '0.88em', fontFamily: 'monospace',
        }}>
          {match[4]}
        </code>
      )
    } else if (match[5]) {
      nodes.push(<s key={key}>{match[5]}</s>)
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) nodes.push(...splitNewlines(text.slice(lastIndex), nodes.length))
  return nodes
}

function splitNewlines(text: string, keyOffset: number): React.ReactNode[] {
  return text.split('\n').flatMap((line, i) =>
    i === 0 ? [line] : [<br key={`br-${keyOffset}-${i}`} />, line]
  )
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

interface MessageRenderMeta {
  msg: DecryptedMessage
  dateDivider: string | null
}

function buildMessageMeta(
  messages: DecryptedMessage[],
  todayLabel: string,
  yesterdayLabel: string,
  locale: string,
  hasMoreMessages: boolean,
): MessageRenderMeta[] {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  return messages.map((msg, i) => {
    const prev = i > 0 ? messages[i - 1] : null
    const currDate = new Date(msg.createdAt)
    const prevDate = prev ? new Date(prev.createdAt) : null
    let dateDivider: string | null = null
    // Don't show a divider for the very first loaded message when more history exists above —
    // the label would just scroll out of view on the next pagination load.
    const isTopBoundary = i === 0 && hasMoreMessages
    if (!isTopBoundary && (!prevDate || !isSameDay(prevDate, currDate))) {
      if (isSameDay(currDate, today)) dateDivider = todayLabel
      else if (isSameDay(currDate, yesterday)) dateDivider = yesterdayLabel
      else dateDivider = currDate.toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', {
        day: 'numeric',
        month: 'long',
        year: currDate.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
      })
    }
    return { msg, dateDivider }
  })
}

function CallOrSystemBubble({
  system,
  identity,
  locale,
}: {
  system: NonNullable<PlainMessage['system']>
  identity: { userId: string }
  locale: string
}) {
  if (system.type !== 'call') {
    return <Text size="sm" c="dimmed" ta="center">{system.text}</Text>
  }
  const isOutgoing = system.callerId === identity.userId
  const isCompleted = system.callStatus === 'completed'
  const isMissed = system.callStatus === 'missed'
  const CallIcon = isOutgoing ? IconPhone : isMissed ? IconPhoneEnd : IconPhoneIncoming
  const iconColor = isCompleted ? 'green' : 'red'
  const label = isCompleted
    ? (locale === 'ru' ? 'Звонок' : 'Call')
    : isMissed
      ? (locale === 'ru' ? 'Пропущенный звонок' : 'Missed call')
      : (locale === 'ru' ? 'Звонок отклонён' : 'Call declined')
  const mins = Math.floor(system.durationSec / 60).toString().padStart(2, '0')
  const secs = Math.floor(system.durationSec % 60).toString().padStart(2, '0')
  return (
    <Group gap="xs" justify="center" wrap="nowrap">
      <ActionIcon variant="light" color={iconColor} size="sm" radius="xl">
        <CallIcon size={13} />
      </ActionIcon>
      <Text size="sm" c="dimmed">
        {label}{isCompleted && system.durationSec > 0 ? ` · ${mins}:${secs}` : ''}
      </Text>
    </Group>
  )
}

export function ChatView(props: ChatViewProps) {
  const { t, locale } = useI18n()
  const {
    isMobile,
    mobileView,
    setMobileView,
    identity,
    ownAvatarSrc,
    activeRoom,
    activeRoomID,
    activeRoomSecret,
    roomSecret,
    setRoomSecret,
    saveManualSecret,
    closeChat,
    peers,
    presence,
    setProfileUser,
    memberIdentities,
    identitiesByID,
    mobilePeerStatus,
    visibleMessages,
    isMessagesLoading,
    displayMessages,
    attachmentMessages,
    attachmentsOpened,
    setAttachmentsOpened,
    highlightedMessageID,
    messageSearch,
    setMessageSearch,
    messagesViewportRef,
    messageInputRef,
    hasMoreMessages,
    isLoadingMoreMessages,
    loadMoreMessages,
    replyTarget,
    setReplyTarget,
    selectedFile,
    previews,
    sendMutation,
    reactionMutation,
    submitMessage,
    updateMessageText,
    selectFile,
    openEditMessage,
    openDeleteMessage,
    copyMessageText,
    previewAttachment,
    downloadAttachment,
    messageReplyPreview,
    setMessageInfo,
    copyAppURL,
    activeTyping,
    setMobileChatActionsOpened,
  } = props

  // Rename state
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const renameMutation = useMutation({
    mutationFn: (name: string) => updateRoomName({ token: props.session.accessToken, roomId: activeRoomID, name }),
    onSuccess: () => setRenaming(false),
  })

  // Scroll tracking + unread counter
  const [unreadCount, setUnreadCount] = useState(0)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [imageViewer, setImageViewer] = useState<{ src: string; name: string } | null>(null)
  const [pendingImagePreviewID, setPendingImagePreviewID] = useState('')
  const isNearBottomRef = useRef(true)
  const previousMessageIDsRef = useRef<string[]>([])
  const initializedRoomRef = useRef('')
  const loadingHistoryRef = useRef(false)
  const historyPaginationEnabledRef = useRef(false)
  const bottomScrollTimersRef = useRef<number[]>([])
  const historyScrollSnapshotRef = useRef<{ height: number; top: number; length: number } | null>(null)
  const paginationArmedRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const suppressPaginationUntilRef = useRef(0)
  const lastHistoryLoadAtRef = useRef(0)

  function clearBottomScrollTimers() {
    for (const timer of bottomScrollTimersRef.current) window.clearTimeout(timer)
    bottomScrollTimersRef.current = []
  }

  function isViewportNearBottom(el: HTMLDivElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = 'auto', onSettled?: () => void) {
    clearBottomScrollTimers()
    const delays = [0, 16, 50, 120, 250, 500]
    for (const [index, delay] of delays.entries()) {
      const timer = window.setTimeout(() => {
        window.requestAnimationFrame(() => {
          const el = messagesViewportRef.current
          if (!el) return
          el.scrollTo({ top: el.scrollHeight, behavior: index === 0 ? behavior : 'auto' })
          if (index === delays.length - 1) onSettled?.()
        })
      }, delay)
      bottomScrollTimersRef.current.push(timer)
    }
  }

  function imageFileFromClipboard(event: React.ClipboardEvent<HTMLInputElement>) {
    const item = Array.from(event.clipboardData.items).find((entry) => (
      entry.kind === 'file' && entry.type.startsWith('image/')
    ))
    const file = item?.getAsFile()
    if (!file) return null
    const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const fallbackName = `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
    return new File([file], file.name || fallbackName, {
      type: file.type || 'image/png',
      lastModified: Date.now(),
    })
  }

  function handleMessagePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    if (!activeRoomID || (sendMutation as UseMutationResult<unknown, Error, unknown>).isPending) return
    const file = imageFileFromClipboard(event)
    if (!file) return
    event.preventDefault()
    selectFile(file)
    window.requestAnimationFrame(() => messageInputRef.current?.focus())
  }

  // Reset transient scroll state when changing chats.
  useEffect(() => {
    setUnreadCount(0)
    setShowScrollBtn(false)
    isNearBottomRef.current = true
    previousMessageIDsRef.current = []
    initializedRoomRef.current = ''
    loadingHistoryRef.current = false
    historyPaginationEnabledRef.current = false
    historyScrollSnapshotRef.current = null
    paginationArmedRef.current = true
    lastScrollTopRef.current = 0
    suppressPaginationUntilRef.current = 0
    lastHistoryLoadAtRef.current = 0
    clearBottomScrollTimers()
  }, [activeRoomID])

  // Only appended incoming messages affect the unread counter. Prepended history is ignored.
  useEffect(() => {
    const currentIDs = visibleMessages.map((msg) => msg.id)
    if (currentIDs.length === 0) {
      previousMessageIDsRef.current = []
      return
    }
    if (initializedRoomRef.current !== activeRoomID) {
      initializedRoomRef.current = activeRoomID
      previousMessageIDsRef.current = currentIDs
      if (!highlightedMessageID) {
        const roomID = activeRoomID
        scrollMessagesToBottom('auto', () => {
          if (initializedRoomRef.current !== roomID) return
          const el = messagesViewportRef.current
          const atBottom = el ? isViewportNearBottom(el) : false
          isNearBottomRef.current = atBottom
          setShowScrollBtn(!atBottom)
          historyPaginationEnabledRef.current = atBottom
        })
      } else {
        historyPaginationEnabledRef.current = true
      }
      return
    }

    const previousIDs = previousMessageIDsRef.current
    previousMessageIDsRef.current = currentIDs
    const previousLastID = previousIDs.at(-1)
    if (!previousLastID || previousLastID === currentIDs.at(-1)) return
    const previousLastIndex = currentIDs.indexOf(previousLastID)
    if (previousLastIndex < 0) return
    const appendedMessages = visibleMessages.slice(previousLastIndex + 1)
    if (appendedMessages.length === 0) return

    if (isNearBottomRef.current) {
      scrollMessagesToBottom()
    } else {
      const incomingCount = appendedMessages.filter((msg) => msg.senderId !== identity.userId && !msg.body?.system).length
      if (incomingCount > 0) setUnreadCount((c) => c + incomingCount)
    }
  }, [activeRoomID, highlightedMessageID, identity.userId, visibleMessages])

  function handleScrollToBottom() {
    scrollMessagesToBottom('smooth')
    setUnreadCount(0)
  }

  async function handleLoadMoreMessages() {
    if (loadingHistoryRef.current || isLoadingMoreMessages || !hasMoreMessages) return
    const now = Date.now()
    if (now - lastHistoryLoadAtRef.current < 900) return
    lastHistoryLoadAtRef.current = now
    const el = messagesViewportRef.current
    if (el) {
      historyScrollSnapshotRef.current = {
        height: el.scrollHeight,
        top: el.scrollTop,
        length: visibleMessages.length,
      }
    } else {
      historyScrollSnapshotRef.current = null
    }
    loadingHistoryRef.current = true
    try {
      await loadMoreMessages()
    } finally {
      if (!historyScrollSnapshotRef.current) loadingHistoryRef.current = false
    }
  }

  useLayoutEffect(() => {
    const snapshot = historyScrollSnapshotRef.current
    const el = messagesViewportRef.current
    if (!snapshot || !el || isLoadingMoreMessages) return
    if (visibleMessages.length <= snapshot.length && hasMoreMessages) return

    const nextTop = el.scrollHeight - snapshot.height + snapshot.top

    el.scrollTop = nextTop
    lastScrollTopRef.current = nextTop
    historyScrollSnapshotRef.current = null
    loadingHistoryRef.current = false
    paginationArmedRef.current = false
    suppressPaginationUntilRef.current = Date.now() + 450
  }, [hasMoreMessages, isLoadingMoreMessages, visibleMessages.length])

  useEffect(() => {
    const el = messagesViewportRef.current
    if (el) el.style.overflowAnchor = 'none'
  }, [messagesViewportRef])

  useEffect(() => {
    if (!pendingImagePreviewID || !previews[pendingImagePreviewID]) return
    const msg = visibleMessages.find((item) => item.id === pendingImagePreviewID)
    setAttachmentsOpened(false)
    setImageViewer({
      src: previews[pendingImagePreviewID],
      name: msg?.body?.attachment?.name || t('preview'),
    })
    setPendingImagePreviewID('')
  }, [pendingImagePreviewID, previews, t, visibleMessages])

  function openAttachmentPreview(msg: DecryptedMessage) {
    const attachment = msg.body?.attachment
    if (!attachment) return
    setAttachmentsOpened(false)
    if (attachment.type.startsWith('image/') && previews[msg.id]) {
      setImageViewer({ src: previews[msg.id], name: attachment.name })
      return
    }
    if (attachment.type.startsWith('image/')) setPendingImagePreviewID(msg.id)
    previewAttachment(msg)
  }

  function replyToMessage(msg: DecryptedMessage) {
    setReplyTarget(msg)
    window.requestAnimationFrame(() => {
      messageInputRef.current?.focus()
    })
  }

  function renderMessageStatus(msg: DecryptedMessage) {
    if (!identity || msg.senderId !== identity.userId || msg.body?.system) return null
    if (msg.status === 'sending') return <IconClock size={15} stroke={1.8} aria-label="sending" />
    if (msg.status === 'failed') return <IconX size={15} stroke={1.8} aria-label="failed" />
    if (msg.status === 'read' || msg.read) return <IconChecks size={16} stroke={1.8} aria-label="read" />
    return <IconCheck size={15} stroke={1.8} aria-label="sent" />
  }

  return (
    <>
    <Modal
      opened={Boolean(imageViewer)}
      onClose={() => setImageViewer(null)}
      title={imageViewer?.name ?? t('preview')}
      centered
      size="xl"
      fullScreen={isMobile}
    >
      {imageViewer && (
        <Image src={imageViewer.src} alt={imageViewer.name} mah="75dvh" fit="contain" radius="md" />
      )}
    </Modal>
    <Modal
      opened={attachmentsOpened && !imageViewer}
      onClose={() => setAttachmentsOpened(false)}
      title={t('attach')}
      centered
      size="lg"
      fullScreen={isMobile}
      scrollAreaComponent={ScrollArea.Autosize}
      styles={{
        content: isMobile ? { maxWidth: '100dvw', overflowX: 'hidden' } : undefined,
        body: isMobile ? { maxWidth: '100dvw', overflowX: 'hidden', paddingInline: 16 } : undefined,
      }}
    >
      <Stack gap="xs" style={{ width: '100%', minWidth: 0, maxWidth: '100%', overflowX: 'hidden' }}>
        {attachmentMessages.map((msg) => {
          const attachment = msg.body?.attachment
          if (!attachment) return null
          return (
            <Card
              key={msg.id}
              withBorder
              radius="md"
              p="sm"
              style={{ width: '100%', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}
            >
              <Stack gap="sm" style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
                <Group gap="sm" wrap="nowrap" style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
                  <ActionIcon variant="light" radius="xl" size="lg" style={{ flexShrink: 0 }}>
                    <IconPaperclip size={18} />
                  </ActionIcon>
                  <div style={{ minWidth: 0, flex: 1, maxWidth: '100%', overflow: 'hidden' }}>
                    <Text fw={700} size="sm" truncate>{attachment.name}</Text>
                    <Text size="xs" c="dimmed" truncate>
                      {(attachment.type || t('file'))} - {formatBytes(attachment.size)} - {msg.body?.senderName || t('unknownUser')}
                    </Text>
                    <Text size="xs" c="dimmed">{new Date(msg.createdAt).toLocaleString()}</Text>
                  </div>
                </Group>
                <Group gap={6} wrap={isMobile ? 'wrap' : 'nowrap'} style={{ width: '100%', minWidth: 0 }}>
                  {attachment.type.startsWith('image/') && (
                    <Button
                      size="xs"
                      variant="light"
                      fullWidth={isMobile}
                      onClick={() => openAttachmentPreview(msg)}
                      style={{ minWidth: 0 }}
                    >
                      {t('preview')}
                    </Button>
                  )}
                  {isMobile ? (
                    <Button
                      size="xs"
                      variant="light"
                      fullWidth
                      leftSection={<IconDownload size={15} />}
                      onClick={() => downloadAttachment(msg)}
                      style={{ minWidth: 0 }}
                    >
                      {t('download')}
                    </Button>
                  ) : (
                    <ActionIcon variant="light" onClick={() => downloadAttachment(msg)} aria-label={t('download')}>
                      <IconDownload size={17} />
                    </ActionIcon>
                  )}
                </Group>
              </Stack>
            </Card>
          )
        })}
        {attachmentMessages.length === 0 && <Text c="dimmed" ta="center">{t('noMessages')}</Text>}
      </Stack>
    </Modal>
    <Card
      withBorder={!isMobile}
      radius={isMobile ? 0 : 'lg'}
      p={isMobile ? 0 : 'md'}
      className={isMobile ? 'mobile-chat-card' : 'desktop-chat-card'}
      style={{
        display: !isMobile || mobileView === 'chat' ? 'flex' : 'none',
        flex: 1,
        width: isMobile ? '100%' : undefined,
        minWidth: 0,
        height: isMobile ? '100dvh' : undefined,
        maxHeight: isMobile ? '100dvh' : undefined,
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
        <Stack h="100%" gap={isMobile ? 0 : 'md'} style={{ flex: 1, minHeight: 0 }}>
          {/* Header */}
          <Group
            className={isMobile ? 'mobile-chat-header' : undefined}
            justify="space-between"
            align={isMobile ? 'center' : 'flex-start'}
            wrap="nowrap"
          >
            {isMobile && (
              <ActionIcon
                variant="light"
                size="lg"
                radius="xl"
                onClick={closeChat}
                aria-label={t('rooms')}
                className="mobile-chat-back"
              >
                <IconChevronLeft size={21} />
              </ActionIcon>
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              {renaming ? (
                <Group gap={6} wrap="nowrap">
                  <TextInput
                    autoFocus
                    size="xs"
                    value={renameText}
                    onChange={(e) => setRenameText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && renameText.trim()) renameMutation.mutate(renameText.trim())
                      if (e.key === 'Escape') setRenaming(false)
                    }}
                    disabled={renameMutation.isPending}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <ActionIcon size="sm" variant="light" loading={renameMutation.isPending} onClick={() => renameText.trim() && renameMutation.mutate(renameText.trim())}>
                    <IconCheck size={14} />
                  </ActionIcon>
                  <ActionIcon size="sm" variant="subtle" onClick={() => setRenaming(false)}>
                    <IconX size={14} />
                  </ActionIcon>
                </Group>
              ) : (
                <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                  {isMobile ? (
                    <Text fw={800} size="lg" truncate style={{ flex: 1, minWidth: 0 }}>{activeRoom.name}</Text>
                  ) : (
                    <Title order={3} style={{ flex: 1, minWidth: 0 }} lineClamp={1}>{activeRoom.name}</Title>
                  )}
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={locale === 'ru' ? 'Переименовать' : 'Rename'}
                    onClick={() => { setRenameText(activeRoom.name); setRenaming(true) }}
                  >
                    <IconPencil size={14} />
                  </ActionIcon>
                </Group>
              )}
              {isMobile ? (
                <Box style={{ minHeight: 18, display: 'flex', alignItems: 'center', minWidth: 0 }}>
                  {memberIdentities.isLoading ? (
                    <Skeleton height={10} width={150} radius="xl" />
                  ) : (
                    <Text size="xs" c="dimmed" truncate style={{ width: '100%' }}>
                      {activeTyping.length > 0 ? `${activeTyping.join(', ')} ${t('typing')}` : (mobilePeerStatus || ' ')}
                    </Text>
                  )}
                </Box>
              ) : null}
            </div>
            <ActionIcon variant="subtle" size="lg" onClick={() => setMobileChatActionsOpened(true)} aria-label={t('chat')}>
              <IconDotsVertical size={20} />
            </ActionIcon>
          </Group>

          {!isMobile && memberIdentities.isLoading && (
            <Group gap={6}>
              <Skeleton height={22} width={170} radius="xl" />
              <Skeleton height={22} width={130} radius="xl" />
            </Group>
          )}

          {!isMobile && !memberIdentities.isLoading && memberIdentities.data && memberIdentities.data.length > 0 && (
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

          {!isMobile && (
            <Box style={{ minHeight: 18 }}>
              <Text size="xs" c="dimmed" style={{ visibility: activeTyping.length > 0 ? 'visible' : 'hidden' }}>
                {activeTyping.length > 0 ? `${activeTyping.join(', ')} ${t('typing')}` : t('typing')}
              </Text>
            </Box>
          )}

          {!activeRoomSecret && displayMessages.some((msg) => msg.failed) && (
            <Alert color="yellow" title={t('roomSecretRequired')}>
              <Group align="flex-end" mt="xs" wrap={isMobile ? 'wrap' : 'nowrap'}>
                <PasswordInput
                  label={t('roomSecret')}
                  value={roomSecret}
                  onChange={(e) => setRoomSecret(e.currentTarget.value)}
                  style={{ flex: 1 }}
                />
                <Button onClick={saveManualSecret} fullWidth={isMobile}>{t('unlock')}</Button>
              </Group>
            </Alert>
          )}

          {!isMobile && (
            <>
              <Box style={{ height: 1, background: 'var(--mantine-color-gray-3)' }} />
              <TextInput
                placeholder="Search messages"
                value={messageSearch}
                onChange={(e) => setMessageSearch(e.currentTarget.value)}
              />
            </>
          )}

          {/* Message list */}
          <Box style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <ScrollArea
              h="100%"
              type="auto"
              offsetScrollbars
              viewportRef={messagesViewportRef}
              onScrollPositionChange={({ y }) => {
                const el = messagesViewportRef.current
                if (!el) return
                const atBottom = isViewportNearBottom(el)
                isNearBottomRef.current = atBottom
                setShowScrollBtn(!atBottom)
                if (atBottom) setUnreadCount(0)
                const previousY = lastScrollTopRef.current
                const isScrollingUp = y < previousY
                const crossedTopThreshold = previousY >= 120 && y < 120
                lastScrollTopRef.current = y
                if (loadingHistoryRef.current && historyScrollSnapshotRef.current) {
                  historyScrollSnapshotRef.current.top = y
                }
                if (y > 260 && Date.now() >= suppressPaginationUntilRef.current) {
                  paginationArmedRef.current = true
                }
                if (
                  historyPaginationEnabledRef.current
                  && y < 120
                  && hasMoreMessages
                  && !isLoadingMoreMessages
                  && !loadingHistoryRef.current
                  && paginationArmedRef.current
                  && isScrollingUp
                  && crossedTopThreshold
                  && Date.now() >= suppressPaginationUntilRef.current
                ) {
                  paginationArmedRef.current = false
                  void handleLoadMoreMessages()
                }
              }}
            >
              <Stack
                className={isMobile ? 'mobile-message-list' : undefined}
                gap={isMobile ? 8 : 'xs'}
                pr={isMobile ? 0 : 'sm'}
                style={{ overflowAnchor: 'none' }}
              >
                {isMessagesLoading && visibleMessages.length === 0 && Array.from({ length: 6 }).map((_, index) => (
                  <Card
                    key={index}
                    withBorder={!isMobile}
                    radius="lg"
                    p="sm"
                    className="message-bubble"
                    style={{
                      alignSelf: index % 3 === 0 ? 'flex-end' : 'flex-start',
                      width: index % 3 === 0 ? '46%' : '62%',
                      maxWidth: isMobile ? '88%' : '76%',
                      background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
                    }}
                  >
                    <Group gap="xs" wrap="nowrap" mb={8}>
                      <Skeleton circle height={30} width={30} />
                      <Skeleton height={12} width="42%" />
                    </Group>
                    <Skeleton height={12} width="92%" mb={7} />
                    <Skeleton height={12} width="64%" />
                  </Card>
                ))}
                {buildMessageMeta(visibleMessages, t('today'), t('yesterday'), locale, hasMoreMessages).map(({ msg, dateDivider }) => (
                  <React.Fragment key={msg.id}>
                    {dateDivider && (
                      <Group gap="xs" my={4} style={{ userSelect: 'none' }}>
                        <Box style={{ flex: 1, height: 1, background: 'light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))' }} />
                        <Text size="xs" c="dimmed">{dateDivider}</Text>
                        <Box style={{ flex: 1, height: 1, background: 'light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))' }} />
                      </Group>
                    )}
                    <Card
                      id={`message-${msg.id}`}
                      data-message-id={msg.id}
                      withBorder={!isMobile}
                      className={!msg.body?.system ? 'message-bubble' : undefined}
                      radius={!msg.body?.system ? 'lg' : 'sm'}
                      p={isMobile ? 'sm' : 'sm'}
                      style={{
                        ...(!msg.body?.system
                          ? {
                              alignSelf: msg.senderId === identity.userId ? 'flex-end' : 'flex-start',
                              maxWidth: isMobile ? '88%' : '76%',
                              background:
                                msg.senderId === identity.userId
                                  ? 'light-dark(var(--mantine-color-blue-0), rgba(34, 139, 230, 0.18))'
                                  : 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
                            }
                          : {}),
                        outline: highlightedMessageID === msg.id ? '2px solid var(--mantine-color-blue-5)' : undefined,
                        outlineOffset: highlightedMessageID === msg.id ? 2 : undefined,
                      }}
                    >
                      {msg.body?.system ? (
                        <CallOrSystemBubble system={msg.body.system} identity={identity} locale={locale} />
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
                                src={msg.senderId === identity.userId ? ownAvatarSrc : absoluteAvatarUrl(msg.body?.senderAvatarUrl)}
                                name={msg.body?.senderName ?? msg.senderId}
                                radius="xl"
                                size={30}
                              />
                              <Text size="sm" fw={700} truncate>{msg.body?.senderName ?? msg.senderId}</Text>
                            </Group>
                            <Group gap={4} wrap="nowrap" c="dimmed">
                              <Text size="xs" c="dimmed">{new Date(msg.createdAt).toLocaleTimeString()}</Text>
                              {msg.editedAt && !msg.deletedAt && <Text size="xs" c="dimmed">edited</Text>}
                              {renderMessageStatus(msg)}
                              <Menu shadow="md" width={210} position="bottom-end">
                                <Menu.Target>
                                  <ActionIcon variant="subtle" size="sm" aria-label="Message actions">
                                    <IconDotsVertical size={16} />
                                  </ActionIcon>
                                </Menu.Target>
                                <Menu.Dropdown>
                                  {!msg.deletedAt && (
                                    <>
                                      {QUICK_REACTIONS.map((emoji) => (
                                        <Menu.Item
                                          key={emoji}
                                          onClick={() => (reactionMutation as UseMutationResult<unknown, Error, { message: DecryptedMessage; emoji: string }>).mutate({ message: msg, emoji })}
                                        >
                                          {emoji}
                                        </Menu.Item>
                                      ))}
                                      <Menu.Divider />
                                      <Menu.Item leftSection={<IconMessageCircle size={15} />} onClick={() => replyToMessage(msg)}>
                                        Reply
                                      </Menu.Item>
                                      <Menu.Item leftSection={<IconCopy size={15} />} onClick={() => copyMessageText(msg)}>
                                        Copy
                                      </Menu.Item>
                                      {isPersistedMessageID(msg.id) && (
                                        <Menu.Item
                                          leftSection={<IconLink size={15} />}
                                          onClick={() => copyAppURL({ view: 'chat', roomId: msg.roomId, messageId: msg.id })}
                                        >
                                          {t('copyMessageLink')}
                                        </Menu.Item>
                                      )}
                                    </>
                                  )}
                                  {identity?.userId === msg.senderId && !msg.deletedAt && isPersistedMessageID(msg.id) && (
                                    <Menu.Item leftSection={<IconEdit size={15} />} onClick={() => openEditMessage(msg)}>
                                      Edit
                                    </Menu.Item>
                                  )}
                                  <Menu.Item leftSection={<IconInfoCircle size={15} />} onClick={() => setMessageInfo(msg)}>
                                    Info
                                  </Menu.Item>
                                  <Menu.Divider />
                                  <Menu.Item color="red" leftSection={<IconTrash size={15} />} onClick={() => openDeleteMessage(msg)}>
                                    Delete
                                  </Menu.Item>
                                </Menu.Dropdown>
                              </Menu>
                            </Group>
                          </Group>

                          {msg.deletedAt ? (
                            <Text fs="italic" c="dimmed">Message deleted</Text>
                          ) : msg.failed ? (
                            <code style={{ display: 'block', padding: '4px 8px', borderRadius: 12, background: 'var(--mantine-color-gray-0)', fontSize: 12 }}>
                              {t('unableToDecrypt')}
                            </code>
                          ) : (
                            <Stack gap="xs">
                              {msg.body?.replyTo && (
                                <Card withBorder radius="md" p="xs" style={{ borderLeft: '3px solid var(--mantine-color-blue-5)' }}>
                                  <Text size="xs" fw={700}>{msg.body.replyTo.senderName}</Text>
                                  <Text size="xs" c="dimmed" lineClamp={2}>{msg.body.replyTo.text}</Text>
                                </Card>
                              )}
                              {msg.body?.text && (
                                <Text style={{ wordBreak: 'break-word', overflowWrap: 'break-word', whiteSpace: 'pre-wrap' }}>
                                  {parseInlineMarkdown(msg.body.text)}
                                </Text>
                              )}
                              {Boolean(msg.reactions?.length) && (
                                <Group gap={4}>
                                  {msg.reactions?.map((reaction) => (
                                    <Button
                                      key={reaction.emoji}
                                      size="compact-xs"
                                      variant="light"
                                      onClick={() => (reactionMutation as UseMutationResult<unknown, Error, { message: DecryptedMessage; emoji: string }>).mutate({ message: msg, emoji: reaction.emoji })}
                                    >
                                      {reaction.emoji} {reaction.count}
                                    </Button>
                                  ))}
                                </Group>
                              )}
                              {msg.body?.attachment && (
                                <Card withBorder radius="md" p="xs">
                                  <Group justify="space-between" align="center">
                                    <div>
                                      <Text size="sm" fw={600}>{msg.body.attachment.name}</Text>
                                      <Text size="xs" c="dimmed">
                                        {msg.body.attachment.type || 'file'} · {formatBytes(msg.body.attachment.size)}
                                      </Text>
                                    </div>
                                    <Group gap="xs">
                                      <Button size="xs" variant="light" onClick={() => openAttachmentPreview(msg)}>
                                        {t('preview')}
                                      </Button>
                                      <ActionIcon variant="light" onClick={() => downloadAttachment(msg)} aria-label={t('download')}>
                                        <IconDownload size={16} />
                                      </ActionIcon>
                                    </Group>
                                  </Group>
                                  {previews[msg.id] && msg.body.attachment.type.startsWith('image/') && (
                                    <Image
                                      src={previews[msg.id]}
                                      alt={msg.body.attachment.name}
                                      mt="sm"
                                      mah={260}
                                      fit="contain"
                                      radius="md"
                                      style={{ cursor: 'zoom-in' }}
                                      onClick={() => setImageViewer({ src: previews[msg.id], name: msg.body?.attachment?.name || t('preview') })}
                                    />
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
                  </React.Fragment>
                ))}
                {!isMessagesLoading && visibleMessages.length === 0 && (
                  <Text c="dimmed" ta="center" mt="xl">{t('noMessages')}</Text>
                )}
              </Stack>
            </ScrollArea>

            {/* Scroll-to-bottom button */}
            {showScrollBtn && (
              <Box style={{ position: 'absolute', bottom: 12, right: 20, zIndex: 10 }}>
                <Indicator
                  label={unreadCount > 0 ? String(unreadCount) : undefined}
                  disabled={unreadCount === 0}
                  size={18}
                  color="red"
                >
                  <ActionIcon
                    radius="xl"
                    size="lg"
                    variant="filled"
                    onClick={handleScrollToBottom}
                    aria-label="Scroll to bottom"
                  >
                    <IconChevronDown size={20} />
                  </ActionIcon>
                </Indicator>
              </Box>
            )}
          </Box>

          {/* Composer */}
          <Stack className={isMobile ? 'mobile-composer' : 'composer-bar'} gap={6} mt="auto">
            {replyTarget && (
              <Card withBorder radius="md" p="xs">
                <Group justify="space-between" wrap="nowrap">
                  <div style={{ minWidth: 0 }}>
                    <Text size="xs" fw={700}>Reply to {replyTarget.body?.senderName ?? replyTarget.senderId}</Text>
                    <Text size="xs" c="dimmed" truncate>{messageReplyPreview(replyTarget)?.text}</Text>
                  </div>
                  <ActionIcon variant="subtle" size="sm" onClick={() => setReplyTarget(null)} aria-label="Cancel reply">
                    <IconX size={14} />
                  </ActionIcon>
                </Group>
              </Card>
            )}
            {selectedFile && (
              <Group gap="xs" wrap="nowrap">
                <Badge variant="light" color="blue" style={{ maxWidth: '100%' }}>
                  {selectedFile.name} · {formatBytes(selectedFile.size)}
                </Badge>
                <ActionIcon variant="subtle" size="sm" onClick={() => selectFile(null)} aria-label="Remove file">
                  <IconX size={14} />
                </ActionIcon>
              </Group>
            )}
            <Group align="center" gap="xs" wrap="nowrap">
              <FileButton onChange={selectFile} accept="*/*" disabled={!activeRoomID || (sendMutation as UseMutationResult<unknown, Error, unknown>).isPending}>
                {(fileProps) => (
                  <ActionIcon
                    {...fileProps}
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
                ref={messageInputRef as React.RefObject<HTMLInputElement>}
                aria-label={t('message')}
                placeholder={activeRoomID ? t('typeMessage') : t('unlockFirst')}
                onChange={(event) => updateMessageText(event.currentTarget.value)}
                onPaste={handleMessagePaste}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submitMessage()
                  }
                }}
                disabled={!activeRoomID}
                style={{ flex: 1, minWidth: 0 }}
                styles={{ input: { fontSize: isMobile ? 16 : undefined } }}
              />
              <ActionIcon
                variant="filled"
                size="lg"
                onClick={submitMessage}
                loading={(sendMutation as UseMutationResult<unknown, Error, unknown>).isPending}
                disabled={!activeRoomID || (sendMutation as UseMutationResult<unknown, Error, unknown>).isPending}
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
    </>
  )
}
