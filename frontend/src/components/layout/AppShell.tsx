'use client'

import {
  ActionIcon,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Slider,
  Stack,
  Text,
} from '@mantine/core'
import {
  IconCopy,
  IconDoorExit,
  IconLogout,
  IconLink,
  IconMessageCircle,
  IconMicrophone,
  IconMicrophoneOff,
  IconPaperclip,
  IconPhone,
  IconPhoneOff,
  IconSettings,
  IconVolume,
  IconUsers,
} from '@tabler/icons-react'
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query'
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type {
  AuthSession,
  AccountSession,
  Friend,
  Identity,
  Room,
} from '@/lib/api'
import { absoluteAvatarUrl } from '@/lib/api'
import type { PlainMessage } from '@/lib/crypto'
import { useI18n } from '@/lib/i18n'
import type {
  AppView,
  CallState,
  DecryptedMessage,
  RealtimeEvent,
} from '@/types/messenger'
import { Sidebar } from './Sidebar'
import { ChatView } from '../chat/ChatView'

const DESKTOP_SIDEBAR_WIDTH_KEY = 'quietline:desktop-sidebar-width'
const MIN_DESKTOP_SIDEBAR_WIDTH = 280
const MAX_DESKTOP_SIDEBAR_WIDTH = 520

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function storedNumber(key: string, fallback: number) {
  if (typeof window === 'undefined') return fallback
  const parsed = Number(window.localStorage.getItem(key))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

interface AppShellLayoutProps {
  // nav
  isMobile: boolean
  isTablet: boolean
  mobileView: AppView
  sidebarView: AppView
  leftView: AppView
  setMobileView: (v: AppView) => void
  setSidebarView: (v: AppView) => void
  liveStatus: 'connecting' | 'connected' | 'disconnected'
  // health
  health: UseQueryResult<{ status: string }>
  // auth
  session: AuthSession
  identity: Identity
  // locale / theme
  locale: string
  setLocale: (locale: 'en' | 'ru') => void
  colorScheme: string
  toggleTheme: () => void
  // avatar
  ownAvatarSrc: string
  avatarMutation: UseMutationResult<unknown, Error, File>
  // profile
  profileUser: Identity | null
  setProfileUser: (user: Identity | null) => void
  presence: Record<string, { displayName: string; status: 'online' | 'offline'; lastSeenAt: string }>
  updateSessionPrincipal: (principal: AuthSession['principal']) => void
  // 2fa
  totpSetup: { secret: string; otpauthUrl: string } | null
  totpQRCode: string
  totpConfirmCode: string
  setTotpConfirmCode: (v: string) => void
  totpDisablePassword: string
  setTotpDisablePassword: (v: string) => void
  totpDisableCode: string
  setTotpDisableCode: (v: string) => void
  beginTOTPMutation: UseMutationResult<unknown, Error, void>
  confirmTOTPMutation: UseMutationResult<unknown, Error, void>
  disableTOTPMutation: UseMutationResult<unknown, Error, void>
  // sessions
  accountSessions: UseQueryResult<{ sessions: AccountSession[] }>
  revokeSessionMutation: UseMutationResult<unknown, Error, AccountSession>
  revokeOtherSessionsMutation: UseMutationResult<unknown, Error, void>
  logout: () => void
  // friends
  friends: UseQueryResult<{ friends: Friend[] }>
  friendUsername: string
  setFriendUsername: (v: string) => void
  requestFriendMutation: UseMutationResult<unknown, Error, void>
  respondFriendMutation: UseMutationResult<unknown, Error, { friend: Friend; accept: boolean }>
  acceptedFriends: Friend[]
  inviteFriendMutation: UseMutationResult<unknown, Error, Friend>
  // rooms
  rooms: UseQueryResult<{ rooms: Room[] }>
  filteredRooms: Room[]
  activeRoomID: string
  activeRoom: Room | null
  activeInvite: string
  activeInviteLink: string
  activeChatLink: string
  activeRoomSecret: string
  roomSearch: string
  setRoomSearch: (v: string) => void
  roomName: string
  setRoomName: (v: string) => void
  newRoomSecret: string
  setNewRoomSecret: (v: string) => void
  roomSecret: string
  setRoomSecret: (v: string) => void
  inviteText: string
  setInviteText: (v: string) => void
  selectRoom: (room: Room) => void
  closeChat: () => void
  requestLeaveChat: () => void
  leaveActiveRoom: () => void
  leavingRoom: boolean
  saveManualSecret: () => void
  createRoomMutation: UseMutationResult<unknown, Error, { roomName: string; newRoomSecret: string }>
  importInviteMutation: UseMutationResult<unknown, Error, string>
  mobileCreateRoomOpened: boolean
  setMobileCreateRoomOpened: (v: boolean) => void
  mobileImportInviteOpened: boolean
  setMobileImportInviteOpened: (v: boolean) => void
  mobileChatActionsOpened: boolean
  setMobileChatActionsOpened: (v: boolean) => void
  leaveConfirmOpened: boolean
  setLeaveConfirmOpened: (v: boolean) => void
  // identities
  memberIdentities: UseQueryResult<Identity[]>
  identitiesByID: Map<string, Identity>
  peers: Identity[]
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
  messageInfo: DecryptedMessage | null
  setMessageInfo: (msg: DecryptedMessage | null) => void
  editTarget: DecryptedMessage | null
  editText: string
  setEditText: (v: string) => void
  deleteTarget: DecryptedMessage | null
  deleteForEveryone: boolean
  setDeleteForEveryone: (v: boolean) => void
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
  copyAppURL: (options?: { view?: AppView; roomId?: string; messageId?: string }) => void
  // typing / presence
  activeTyping: string[]
  // call
  callState: CallState
  incomingCall: Extract<RealtimeEvent, { kind: 'call-offer' }> | null
  callPeerName: string
  callPeerID: string
  callStatus: string
  callError: string
  callDiagnostics: string[]
  callDurationSec: number
  isCallMuted: boolean
  setIsCallMuted: (v: boolean) => void
  peerVolume: number
  setPeerVolume: (v: number) => void
  audioInputDevices: MediaDeviceInfo[]
  audioOutputDevices: MediaDeviceInfo[]
  selectedAudioInputId: string
  setSelectedAudioInputId: (v: string) => void
  selectedAudioOutputId: string
  setSelectedAudioOutputId: (v: string) => void
  remoteAudioRef: RefObject<HTMLAudioElement | null>
  startCall: (targetUserId?: string) => void
  endCall: (notifyPeer?: boolean) => void
  answerCall: () => void
  declineIncomingCall: () => void
}

export function AppShellLayout(props: AppShellLayoutProps) {
  const { t } = useI18n()
  const {
    isMobile,
    isTablet,
    mobileView,
    sidebarView,
    leftView,
    setMobileView,
    setSidebarView,
    liveStatus,
    session,
    identity,
    locale,
    closeChat,
  } = props
  const [contactsResetKey, setContactsResetKey] = useState(0)
  const [settingsResetKey, setSettingsResetKey] = useState(0)
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(() =>
    storedNumber(DESKTOP_SIDEBAR_WIDTH_KEY, isTablet ? 300 : 340),
  )
  const resizeStateRef = useRef<{
    startX: number
    startSidebarWidth: number
  } | null>(null)
  const liveBadge = {
    color: liveStatus === 'connected' ? 'green' : liveStatus === 'connecting' ? 'yellow' : 'red',
    label: liveStatus === 'connected'
      ? t('online')
      : liveStatus === 'connecting'
        ? (locale === 'ru' ? 'Соединение' : 'Connecting')
        : t('offline'),
  }
  const navCopy = {
    contacts: locale === 'ru' ? 'Контакты' : 'Contacts',
    chats: locale === 'ru' ? 'Чаты' : 'Chats',
    settings: locale === 'ru' ? 'Настройки' : 'Settings',
  }
  function openMobileTab(value: 'contacts' | 'rooms' | 'settings') {
    const current = mobileView === 'chat' ? 'rooms' : mobileView
    if (value === 'rooms' && current === 'rooms') {
      closeChat()
      return
    }
    if (value === 'contacts' && current === 'contacts') setContactsResetKey((key) => key + 1)
    if (value === 'settings' && current === 'settings') setSettingsResetKey((key) => key + 1)
    setMobileView(value)
  }

  useEffect(() => {
    if (isMobile) return
    window.localStorage.setItem(DESKTOP_SIDEBAR_WIDTH_KEY, String(Math.round(desktopSidebarWidth)))
  }, [desktopSidebarWidth, isMobile])

  function startDesktopResize(event: PointerEvent<HTMLButtonElement>) {
    if (isMobile) return
    event.preventDefault()
    resizeStateRef.current = {
      startX: event.clientX,
      startSidebarWidth: desktopSidebarWidth,
    }

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const state = resizeStateRef.current
      if (!state) return
      const delta = moveEvent.clientX - state.startX
      setDesktopSidebarWidth(clamp(
        state.startSidebarWidth + delta,
        MIN_DESKTOP_SIDEBAR_WIDTH,
        MAX_DESKTOP_SIDEBAR_WIDTH,
      ))
    }

    const stopResize = () => {
      resizeStateRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }

  return (
    <>
      {/* Global modals */}
      <ProfileModal {...props} />
      <MessageInfoModal {...props} />
      <EditMessageModal {...props} />
      <DeleteMessageModal {...props} />
      <ChatActionsModal {...props} />
      <CallPanelModal {...props} />
      <LeaveConfirmModal {...props} />
      <CreateRoomModal {...props} />
      <ImportInviteModal {...props} />

      <Box className="app-workspace">
        {(!isMobile || mobileView !== 'chat') && (
          <Group
            className={isMobile ? 'mobile-top-bar' : 'app-top-bar'}
            justify="space-between"
            wrap="nowrap"
          >
            <div style={{ minWidth: 0 }}>
              <Text fw={800} size="lg" truncate>Quietline</Text>
              <Text size="xs" c="dimmed" truncate>
                {isMobile
                  ? mobileView === 'rooms'
                    ? navCopy.chats
                    : mobileView === 'contacts'
                      ? navCopy.contacts
                      : navCopy.settings
                  : t('encryptedBadge')}
              </Text>
            </div>
            <Group gap="xs" wrap="nowrap">
              <Badge color={liveBadge.color} variant="light">
                {liveBadge.label}
              </Badge>
            </Group>
          </Group>
        )}

        <Group
          className={isMobile ? 'mobile-app-shell mobile-content' : 'workspace-shell'}
          align="stretch"
          gap={isMobile ? 0 : 'md'}
          wrap={isMobile ? 'wrap' : 'nowrap'}
          style={{
            height: isMobile
              ? mobileView === 'chat'
                ? '100dvh'
                : 'calc(100dvh - 58px)'
              : 'calc(100dvh - 96px)',
            minHeight: 0,
          }}
        >
          {!isMobile ? (
            <>
              <Sidebar
                {...props}
                contactsResetKey={contactsResetKey}
                settingsResetKey={settingsResetKey}
                desktopSidebarWidth={desktopSidebarWidth}
              />
              <button
                type="button"
                className="desktop-resize-handle"
                aria-label="Resize chat list"
                onPointerDown={startDesktopResize}
              />
              <Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <ChatView {...props} />
              </Box>
            </>
          ) : (
            <>
              <Sidebar {...props} contactsResetKey={contactsResetKey} settingsResetKey={settingsResetKey} />
              <ChatView {...props} />
            </>
          )}
        </Group>

        {isMobile && mobileView !== 'chat' && (
          <Group className="mobile-bottom-nav" gap={4} wrap="nowrap">
            {([
              { value: 'contacts', label: navCopy.contacts, icon: <IconUsers size={18} /> },
              { value: 'rooms', label: navCopy.chats, icon: <IconMessageCircle size={18} /> },
              { value: 'settings', label: navCopy.settings, icon: <IconSettings size={18} /> },
            ] as const).map((item) => (
              <button
                key={item.value}
                type="button"
                className={`mobile-nav-item${mobileView === item.value ? ' mobile-nav-item-active' : ''}`}
                onClick={() => openMobileTab(item.value)}
              >
                <Stack gap={1} align="center">
                  {item.icon}
                  <Text size="xs" fw={700}>{item.label}</Text>
                </Stack>
              </button>
            ))}
          </Group>
        )}
      </Box>
    </>
  )
}

// ─── Modal subcomponents ───────────────────────────────────────────────────

function ProfileModal({ profileUser, setProfileUser, presence, identity, ownAvatarSrc }: Pick<AppShellLayoutProps, 'profileUser' | 'setProfileUser' | 'presence' | 'identity' | 'ownAvatarSrc'>) {
  const { t } = useI18n()
  const [avatarViewerOpened, setAvatarViewerOpened] = useState(false)
  if (!profileUser) return null
  const currentPresence = presence[profileUser.userId]
  const avatarSrc = profileUser.userId === identity.userId
    ? ownAvatarSrc
    : absoluteAvatarUrl(`/v1/users/${encodeURIComponent(profileUser.userId)}/avatar`)
  return (
    <>
    <Modal opened={avatarViewerOpened} onClose={() => setAvatarViewerOpened(false)} title={profileUser.displayName} centered size="lg">
      <Stack align="center">
        <Avatar src={avatarSrc} name={profileUser.displayName} radius="xl" size={220} color="blue" />
      </Stack>
    </Modal>
    <Modal opened={Boolean(profileUser) && !avatarViewerOpened} onClose={() => setProfileUser(null)} title={t('profileTitle')} centered>
      <Stack gap="sm">
        <Group align="center" wrap="nowrap">
          <Avatar
            src={avatarSrc}
            name={profileUser.displayName}
            radius="xl"
            size={64}
            color="blue"
            style={{ cursor: 'pointer' }}
            onClick={() => setAvatarViewerOpened(true)}
          />
          <div>
            <Text fw={700}>{profileUser.displayName}</Text>
            <Text size="xs" c="dimmed">
              {currentPresence?.status === 'online'
                ? t('online')
                : `${t('lastSeen')} ${new Date(currentPresence?.lastSeenAt || profileUser.lastSeenAt).toLocaleString()}`}
            </Text>
          </div>
        </Group>
      </Stack>
    </Modal>
    </>
  )
}

function MessageInfoModal({ messageInfo, setMessageInfo, identitiesByID }: Pick<AppShellLayoutProps, 'messageInfo' | 'setMessageInfo' | 'identitiesByID'>) {
  const { t } = useI18n()
  return (
    <Modal opened={Boolean(messageInfo)} onClose={() => setMessageInfo(null)} title="Message info" centered>
      {messageInfo && (
        <Stack gap="xs">
          <Text size="sm" fw={700}>{messageInfo.body?.senderName ?? messageInfo.senderId}</Text>
          <Text size="sm">Sent: {new Date(messageInfo.createdAt).toLocaleString()}</Text>
          {messageInfo.editedAt && <Text size="sm">Edited: {new Date(messageInfo.editedAt).toLocaleString()}</Text>}
          {messageInfo.deletedAt && <Text size="sm">Deleted: {new Date(messageInfo.deletedAt).toLocaleString()}</Text>}
          <div style={{ height: 1, background: 'var(--mantine-color-gray-3)', margin: '4px 0' }} />
          <Text size="sm" fw={700}>{t('views')}</Text>
          {(messageInfo.readReceipts ?? []).length > 0 ? (
            <Stack gap={6}>
              {(messageInfo.readReceipts ?? []).map((receipt) => {
                const reader = identitiesByID.get(receipt.userId)
                return (
                  <Group key={`${messageInfo.id}-${receipt.userId}`} justify="space-between" gap="xs" wrap="nowrap">
                    <Text size="sm" truncate>{reader?.displayName ?? t('unknownUser')}</Text>
                    <Text size="xs" c="dimmed" ta="right">{new Date(receipt.readAt).toLocaleString()}</Text>
                  </Group>
                )
              })}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">{t('noViews')}</Text>
          )}
        </Stack>
      )}
    </Modal>
  )
}

function EditMessageModal({ editTarget, setEditTarget, editText, setEditText, editMessageMutation }: Pick<AppShellLayoutProps, 'editTarget' | 'setEditTarget' | 'editText' | 'setEditText' | 'editMessageMutation'>) {
  const { t } = useI18n()
  return (
    <Modal opened={Boolean(editTarget)} onClose={() => setEditTarget(null)} title="Edit message" centered>
      <Stack gap="sm">
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.currentTarget.value)}
          rows={3}
          style={{ width: '100%', resize: 'vertical', padding: 12, borderRadius: 14, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14 }}
        />
        <Group justify="flex-end">
          <Button variant="subtle" onClick={() => setEditTarget(null)}>{t('cancel')}</Button>
          <Button
            onClick={() => (editMessageMutation as UseMutationResult<unknown, Error, void>).mutate()}
            loading={(editMessageMutation as UseMutationResult<unknown, Error, void>).isPending}
            disabled={!editText.trim()}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function DeleteMessageModal({
  deleteTarget,
  setDeleteTarget,
  deleteForEveryone,
  setDeleteForEveryone,
  deleteMessageMutation,
  identity,
}: Pick<AppShellLayoutProps, 'deleteTarget' | 'setDeleteTarget' | 'deleteForEveryone' | 'setDeleteForEveryone' | 'deleteMessageMutation' | 'identity'>) {
  const { t } = useI18n()

  function isPersistedMessageID(id: string) {
    return !id.startsWith('local-')
  }

  return (
    <Modal opened={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete message" centered>
      <Stack gap="sm">
        <Text size="sm">Delete this message?</Text>
        {identity?.userId === deleteTarget?.senderId && deleteTarget && isPersistedMessageID(deleteTarget.id) && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={deleteForEveryone}
              onChange={(e) => setDeleteForEveryone(e.currentTarget.checked)}
            />
            <Text size="sm">Delete for everyone</Text>
          </label>
        )}
        <Group justify="flex-end">
          <Button variant="subtle" onClick={() => setDeleteTarget(null)}>{t('cancel')}</Button>
          <Button
            color="red"
            onClick={() => (deleteMessageMutation as UseMutationResult<unknown, Error, void>).mutate()}
            loading={(deleteMessageMutation as UseMutationResult<unknown, Error, void>).isPending}
          >
            Delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function formatCallDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0')
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

function CallPanelModal({
  isMobile,
  locale,
  callState,
  incomingCall,
  callPeerName,
  callStatus,
  callError,
  callDiagnostics,
  callDurationSec,
  isCallMuted,
  setIsCallMuted,
  peerVolume,
  setPeerVolume,
  audioInputDevices,
  audioOutputDevices,
  selectedAudioInputId,
  setSelectedAudioInputId,
  selectedAudioOutputId,
  setSelectedAudioOutputId,
  remoteAudioRef,
  answerCall,
  declineIncomingCall,
  endCall,
}: Pick<AppShellLayoutProps,
  | 'isMobile'
  | 'locale'
  | 'callState'
  | 'incomingCall'
  | 'callPeerName'
  | 'callStatus'
  | 'callError'
  | 'callDiagnostics'
  | 'callDurationSec'
  | 'isCallMuted'
  | 'setIsCallMuted'
  | 'peerVolume'
  | 'setPeerVolume'
  | 'audioInputDevices'
  | 'audioOutputDevices'
  | 'selectedAudioInputId'
  | 'setSelectedAudioInputId'
  | 'selectedAudioOutputId'
  | 'setSelectedAudioOutputId'
  | 'remoteAudioRef'
  | 'answerCall'
  | 'declineIncomingCall'
  | 'endCall'
>) {
  const { t } = useI18n()
  const opened = callState !== 'idle' || Boolean(incomingCall)
  const peerName = callPeerName || incomingCall?.displayName || t('unknownUser')
  const isIncoming = callState === 'ringing' && Boolean(incomingCall)
  const isActive = callState === 'connected'
  const isFailed = callState === 'failed'
  const microphoneOptions = audioInputDevices.map((device, index) => ({
    value: device.deviceId,
    label: device.label || (locale === 'ru' ? `Микрофон ${index + 1}` : `Microphone ${index + 1}`),
  }))
  const speakerOptions = audioOutputDevices.map((device, index) => ({
    value: device.deviceId,
    label: device.label || (locale === 'ru' ? `Динамик ${index + 1}` : `Speaker ${index + 1}`),
  }))

  return (
    <Modal
      opened={opened}
      onClose={() => endCall(true)}
      centered
      fullScreen={isMobile}
      size="md"
      title={locale === 'ru' ? 'Звонок' : 'Call'}
    >
      <audio ref={remoteAudioRef as RefObject<HTMLAudioElement>} autoPlay />
      <Stack gap="lg" align="stretch">
        <Stack gap={4} align="center">
          <Avatar name={peerName} radius="xl" size={84} color="blue" />
          <Text fw={800} size="xl" ta="center">{peerName}</Text>
          <Text size="sm" c={callError ? 'red' : 'dimmed'} ta="center" style={{ minHeight: 20 }}>
            {callError || (isActive ? formatCallDuration(callDurationSec) : callStatus || t('calling'))}
          </Text>
        </Stack>

        {isFailed ? (
          <Button color="red" variant="light" leftSection={<IconPhoneOff size={18} />} onClick={() => endCall(false)}>
            {locale === 'ru' ? 'Закрыть' : 'Close'}
          </Button>
        ) : isIncoming ? (
          <Group grow>
            <Button color="red" variant="light" leftSection={<IconPhoneOff size={18} />} onClick={declineIncomingCall}>
              {t('declineCall')}
            </Button>
            <Button color="green" leftSection={<IconPhone size={18} />} onClick={answerCall}>
              {t('answerCall')}
            </Button>
          </Group>
        ) : (
          <Group grow>
            <Button
              variant={isCallMuted ? 'filled' : 'light'}
              color={isCallMuted ? 'yellow' : 'blue'}
              leftSection={isCallMuted ? <IconMicrophoneOff size={18} /> : <IconMicrophone size={18} />}
              onClick={() => setIsCallMuted(!isCallMuted)}
            >
              {locale === 'ru' ? (isCallMuted ? 'Включить микрофон' : 'Выключить микрофон') : (isCallMuted ? 'Unmute' : 'Mute')}
            </Button>
            <Button color="red" leftSection={<IconPhoneOff size={18} />} onClick={() => endCall(true)}>
              {t('endCall')}
            </Button>
          </Group>
        )}

        {!isIncoming && !isFailed && (
          <Stack gap="sm">
            <div>
              <Group justify="space-between" mb={4}>
                <Text size="sm" fw={700}>{locale === 'ru' ? 'Громкость собеседника' : 'Peer volume'}</Text>
                <IconVolume size={18} />
              </Group>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={peerVolume}
                onChange={setPeerVolume}
                label={(value) => `${Math.round(value * 100)}%`}
              />
            </div>
            <Select
              label={locale === 'ru' ? 'Микрофон' : 'Microphone'}
              value={selectedAudioInputId || null}
              onChange={(value) => setSelectedAudioInputId(value ?? '')}
              data={microphoneOptions}
              placeholder={locale === 'ru' ? 'Системный микрофон' : 'System default'}
              clearable
            />
            {speakerOptions.length > 0 && (
              <Select
                label={locale === 'ru' ? 'Вывод звука' : 'Audio output'}
                value={selectedAudioOutputId || null}
                onChange={(value) => setSelectedAudioOutputId(value ?? '')}
                data={speakerOptions}
                placeholder={locale === 'ru' ? 'Системный вывод' : 'System default'}
                clearable
              />
            )}
          </Stack>
        )}
        {callDiagnostics.length > 0 && (
          <Card withBorder radius="lg" p="sm">
            <Text size="xs" fw={800} mb={6}>
              {locale === 'ru' ? 'Диагностика соединения' : 'Connection diagnostics'}
            </Text>
            <Stack gap={3}>
              {callDiagnostics.map((item) => (
                <Text key={item} size="xs" c="dimmed" style={{ fontFamily: 'var(--font-geist-mono), monospace' }}>
                  {item}
                </Text>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </Modal>
  )
}

function ChatActionsModal(props: AppShellLayoutProps) {
  const { t } = useI18n()
  const {
    mobileChatActionsOpened,
    setMobileChatActionsOpened,
    activeRoom,
    isMobile,
    locale,
    messageSearch,
    setMessageSearch,
    peers,
    presence,
    setProfileUser,
    closeChat,
    callState,
    startCall,
    endCall,
    activeInvite,
    activeInviteLink,
    activeChatLink,
    acceptedFriends,
    inviteFriendMutation,
    requestLeaveChat,
    leavingRoom,
    activeRoomID,
    attachmentMessages,
    setAttachmentsOpened,
  } = props

  function formatLastSeen(value?: string) {
    if (!value) return ''
    return new Date(value).toLocaleString()
  }

  return (
    <Modal
      opened={mobileChatActionsOpened}
      onClose={() => setMobileChatActionsOpened(false)}
      title={activeRoom?.name ?? t('chat')}
      centered
    >
      {activeRoom && (
        <Stack gap="md">
          <div>
            <Text fw={800} truncate>{activeRoom.name}</Text>
          </div>
          <Card withBorder radius="lg" p="sm">
            <Stack gap="xs">
              <input
                placeholder="Search messages"
                value={messageSearch}
                onChange={(e) => setMessageSearch(e.currentTarget.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 14, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14 }}
              />
              <Button
                variant="light"
                leftSection={<IconPaperclip size={16} />}
                onClick={() => {
                  setMobileChatActionsOpened(false)
                  setAttachmentsOpened(true)
                }}
                disabled={attachmentMessages.length === 0}
                fullWidth
              >
                {t('file')} {attachmentMessages.length > 0 ? `(${attachmentMessages.length})` : ''}
              </Button>
            </Stack>
          </Card>
          {!isMobile && peers.length > 0 && (
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
          <Card withBorder radius="lg" p="sm">
            <Stack gap="xs">
              <Button
                variant={callState === 'idle' ? 'light' : 'filled'}
                color={callState === 'idle' ? 'green' : 'red'}
                leftSection={<IconPhone size={16} />}
                onClick={callState === 'idle' ? () => startCall() : () => endCall(true)}
                fullWidth
                disabled={!activeRoomID}
              >
                {callState === 'idle' ? t('startCall') : t('endCall')}
              </Button>
              <Stack gap="xs">
                <Button
                  variant="light"
                  leftSection={<IconLink size={16} />}
                  onClick={() => navigator.clipboard.writeText(activeInviteLink).catch(() => undefined)}
                  disabled={!activeInviteLink}
                  fullWidth
                >
                  {t('copyInviteLink')}
                </Button>
                <Button
                  variant="light"
                  leftSection={<IconCopy size={16} />}
                  onClick={() => navigator.clipboard.writeText(activeChatLink).catch(() => undefined)}
                  disabled={!activeChatLink}
                  fullWidth
                >
                  {t('copyChatLink')}
                </Button>
              </Stack>
              <Button
                variant="subtle"
                leftSection={<IconLogout size={16} />}
                onClick={closeChat}
                fullWidth
              >
                {t('closeChat')}
              </Button>
            </Stack>
          </Card>
          {acceptedFriends.length > 0 && (
            <Card withBorder radius="lg" p="sm">
            <Stack gap={6}>
              <Text size="xs" c="dimmed" fw={700}>{locale === 'ru' ? 'Пригласить контакт' : 'Invite contact'}</Text>
              {acceptedFriends
                .filter((friend) => !activeRoom.members.includes(friend.userId))
                .slice(0, 4)
                .map((friend) => (
                  <Button
                    key={friend.userId}
                    size="xs"
                    variant="light"
                    onClick={() => (inviteFriendMutation as UseMutationResult<unknown, Error, Friend>).mutate(friend)}
                  >
                    {friend.displayName || t('unknownUser')}
                  </Button>
                ))}
            </Stack>
            </Card>
          )}
          {!activeInvite && <Text size="xs" c="dimmed">{t('inviteSecretMissing')}</Text>}
          <Button
            variant="light"
            color="red"
            leftSection={<IconDoorExit size={16} />}
            onClick={requestLeaveChat}
            loading={leavingRoom}
            fullWidth
          >
            {t('leaveChat')}
          </Button>
        </Stack>
      )}
    </Modal>
  )
}

function LeaveConfirmModal({
  leaveConfirmOpened,
  setLeaveConfirmOpened,
  leaveActiveRoom,
  leavingRoom,
}: Pick<AppShellLayoutProps, 'leaveConfirmOpened' | 'setLeaveConfirmOpened' | 'leaveActiveRoom' | 'leavingRoom'>) {
  const { t } = useI18n()
  return (
    <Modal
      opened={leaveConfirmOpened}
      onClose={() => setLeaveConfirmOpened(false)}
      title={t('leaveChat')}
      centered
    >
      <Stack gap="md">
        <Text size="sm">{t('leaveChatConfirm')}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setLeaveConfirmOpened(false)}>{t('cancel')}</Button>
          <Button color="red" onClick={() => void leaveActiveRoom()} loading={leavingRoom}>{t('leaveChat')}</Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function CreateRoomModal({
  mobileCreateRoomOpened,
  setMobileCreateRoomOpened,
  roomName,
  setRoomName,
  createRoomMutation,
}: Pick<AppShellLayoutProps, 'mobileCreateRoomOpened' | 'setMobileCreateRoomOpened' | 'roomName' | 'setRoomName' | 'newRoomSecret' | 'setNewRoomSecret' | 'createRoomMutation'>) {
  const { t } = useI18n()
  return (
    <Modal
      opened={mobileCreateRoomOpened}
      onClose={() => setMobileCreateRoomOpened(false)}
      title={t('createRoom')}
      centered
    >
      <Stack gap="sm">
        <label>
          <Text size="sm" mb={4}>{t('roomName')}</Text>
          <input
            value={roomName}
            onChange={(e) => setRoomName(e.currentTarget.value)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 14, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14 }}
          />
        </label>
        <Button
          onClick={() => (createRoomMutation as UseMutationResult<unknown, Error, { roomName: string; newRoomSecret: string }>).mutate({ roomName, newRoomSecret: '' })}
          loading={(createRoomMutation as UseMutationResult<unknown, Error, { roomName: string; newRoomSecret: string }>).isPending}
          disabled={(createRoomMutation as UseMutationResult<unknown, Error, { roomName: string; newRoomSecret: string }>).isPending}
        >
          {t('createEncryptedRoom')}
        </Button>
      </Stack>
    </Modal>
  )
}

function ImportInviteModal({
  mobileImportInviteOpened,
  setMobileImportInviteOpened,
  inviteText,
  setInviteText,
  importInviteMutation,
}: Pick<AppShellLayoutProps, 'mobileImportInviteOpened' | 'setMobileImportInviteOpened' | 'inviteText' | 'setInviteText' | 'importInviteMutation'>) {
  const { t } = useI18n()
  return (
    <Modal
      opened={mobileImportInviteOpened}
      onClose={() => setMobileImportInviteOpened(false)}
      title={t('importInvite')}
      centered
    >
      <Stack gap="sm">
        <label>
          <Text size="sm" mb={4}>{t('invite')}</Text>
          <input
            type="text"
            name="quietline-invite-token"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            placeholder={t('invitePlaceholder')}
            value={inviteText}
            onChange={(e) => setInviteText(e.currentTarget.value)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 14, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14, fontFamily: 'var(--font-geist-mono), monospace' }}
          />
        </label>
        <Button
          variant="light"
          onClick={() => (importInviteMutation as UseMutationResult<unknown, Error, string>).mutate(inviteText)}
          loading={(importInviteMutation as UseMutationResult<unknown, Error, string>).isPending}
          disabled={!inviteText.trim()}
        >
          {t('joinRoom')}
        </Button>
      </Stack>
    </Modal>
  )
}
