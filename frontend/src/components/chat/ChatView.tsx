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
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconCheck,
  IconChecks,
  IconChevronDown,
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
  IconPhone,
  IconSend,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import React, { useEffect, useRef, useState, type RefObject } from 'react'
import { absoluteAvatarUrl, type AuthSession, type Friend, type Identity, type Room } from '@/lib/api'
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
  displayMessages: DecryptedMessage[]
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

export function ChatView(props: ChatViewProps) {
  const { t } = useI18n()
  const {
    isMobile,
    mobileView,
    identity,
    ownAvatarSrc,
    activeRoom,
    activeRoomID,
    activeRoomSecret,
    roomSecret,
    setRoomSecret,
    saveManualSecret,
    peers,
    presence,
    setProfileUser,
    memberIdentities,
    identitiesByID,
    mobilePeerStatus,
    visibleMessages,
    displayMessages,
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
    callState,
    incomingCall,
    callPeerName,
    callPeerID,
    remoteAudioRef,
    answerCall,
    declineIncomingCall,
    setMobileChatActionsOpened,
  } = props

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

  function scrollMessagesToBottom(behavior: ScrollBehavior = 'auto') {
    const el = messagesViewportRef.current
    if (!el) return
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior })
      })
    })
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
        scrollMessagesToBottom()
        const roomID = activeRoomID
        window.setTimeout(() => {
          if (initializedRoomRef.current === roomID) historyPaginationEnabledRef.current = true
        }, 250)
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
    const el = messagesViewportRef.current
    const previousHeight = el?.scrollHeight ?? 0
    const previousTop = el?.scrollTop ?? 0
    loadingHistoryRef.current = true
    try {
      await loadMoreMessages()
    } finally {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const nextEl = messagesViewportRef.current
          if (nextEl) nextEl.scrollTop = nextEl.scrollHeight - previousHeight + previousTop
          loadingHistoryRef.current = false
        })
      })
    }
  }

  useEffect(() => {
    if (!pendingImagePreviewID || !previews[pendingImagePreviewID]) return
    const msg = visibleMessages.find((item) => item.id === pendingImagePreviewID)
    setImageViewer({
      src: previews[pendingImagePreviewID],
      name: msg?.body?.attachment?.name || t('preview'),
    })
    setPendingImagePreviewID('')
  }, [pendingImagePreviewID, previews, t, visibleMessages])

  function openAttachmentPreview(msg: DecryptedMessage) {
    const attachment = msg.body?.attachment
    if (!attachment) return
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
    >
      {imageViewer && (
        <Image src={imageViewer.src} alt={imageViewer.name} mah="75dvh" fit="contain" radius="md" />
      )}
    </Modal>
    <Card
      withBorder={!isMobile}
      radius={isMobile ? 0 : 'sm'}
      p={isMobile ? 0 : 'md'}
      className={isMobile ? 'mobile-chat-card' : 'desktop-chat-card'}
      style={{
        display: !isMobile || mobileView === 'chat' ? 'flex' : 'none',
        flex: 1,
        width: isMobile ? '100%' : undefined,
        minWidth: 0,
        height: isMobile ? 'calc(100dvh - 76px)' : undefined,
        maxHeight: isMobile ? 'calc(100dvh - 76px)' : undefined,
        minHeight: isMobile ? 0 : 0,
      }}
    >
      {!activeRoom ? (
        <Stack align="center" justify="center" h="100%" style={{ flex: 1 }}>
          <IconLock size={38} />
          <Title order={3}>{t('chooseRoom')}</Title>
          <Text c="dimmed">{t('messagesEncrypted')}</Text>
          {isMobile && (
            <Button variant="light" onClick={() => props.setRoomSecret('')}>{t('rooms')}</Button>
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
            <div style={{ minWidth: 0, flex: 1 }}>
              {isMobile ? (
                <Text fw={800} size="lg" truncate>{activeRoom.name}</Text>
              ) : (
                <Title order={3}>{activeRoom.name}</Title>
              )}
              {isMobile ? (
                <Text size="xs" c="dimmed" truncate>{mobilePeerStatus || ' '}</Text>
              ) : null}
            </div>
            <ActionIcon variant="subtle" size="lg" onClick={() => setMobileChatActionsOpened(true)} aria-label={t('chat')}>
              <IconDotsVertical size={20} />
            </ActionIcon>
          </Group>

          <audio ref={remoteAudioRef as React.RefObject<HTMLAudioElement>} autoPlay />

          {callState === 'ringing' && incomingCall && (
            <Alert color="green" title={`${t('incomingCall')}: ${incomingCall.displayName}`}>
              <Group mt="xs">
                <Button leftSection={<IconPhone size={16} />} onClick={answerCall}>{t('answerCall')}</Button>
                <Button variant="light" color="red" onClick={declineIncomingCall}>{t('declineCall')}</Button>
              </Group>
            </Alert>
          )}
          {callState !== 'idle' && callState !== 'ringing' && (
            <Text size="xs" c="dimmed">
              {t('callStatus')}: {callPeerName || identitiesByID.get(callPeerID)?.displayName || t(callState === 'calling' ? 'calling' : 'connected')}
            </Text>
          )}

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
                const atBottom = el.scrollHeight - y - el.clientHeight < 80
                isNearBottomRef.current = atBottom
                setShowScrollBtn(!atBottom)
                if (atBottom) setUnreadCount(0)
                if (historyPaginationEnabledRef.current && y < 120 && hasMoreMessages && !isLoadingMoreMessages) {
                  void handleLoadMoreMessages()
                }
              }}
            >
              <Stack className={isMobile ? 'mobile-message-list' : undefined} gap={isMobile ? 8 : 'xs'} pr={isMobile ? 0 : 'sm'}>
                {visibleMessages.map((msg) => (
                  <Card
                    key={msg.id}
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
                          <code style={{ display: 'block', padding: '4px 8px', borderRadius: 4, background: 'var(--mantine-color-gray-0)', fontSize: 12 }}>
                            {t('unableToDecrypt')}
                          </code>
                        ) : (
                          <Stack gap="xs">
                            {msg.body?.replyTo && (
                              <Card withBorder radius="sm" p="xs" style={{ borderLeft: '3px solid var(--mantine-color-blue-5)' }}>
                                <Text size="xs" fw={700}>{msg.body.replyTo.senderName}</Text>
                                <Text size="xs" c="dimmed" lineClamp={2}>{msg.body.replyTo.text}</Text>
                              </Card>
                            )}
                            {msg.body?.text && <Text>{msg.body.text}</Text>}
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
                              <Card withBorder radius="sm" p="xs">
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
                                    radius="sm"
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
                ))}
                {visibleMessages.length === 0 && (
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
              <Card withBorder radius="sm" p="xs">
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
