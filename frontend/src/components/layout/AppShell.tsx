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
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core'
import {
  IconLock,
  IconMessageCircle,
  IconMoon,
  IconSun,
  IconUserPlus,
} from '@tabler/icons-react'
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query'
import { useState, type RefObject } from 'react'
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

interface AppShellLayoutProps {
  // nav
  isMobile: boolean
  isTablet: boolean
  mobileView: AppView
  sidebarView: AppView
  leftView: AppView
  setMobileView: (v: AppView) => void
  setSidebarView: (v: AppView) => void
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
  displayMessages: DecryptedMessage[]
  attachmentMessages: DecryptedMessage[]
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
    health,
    session,
    identity,
    locale,
    setLocale,
    colorScheme,
    toggleTheme,
  } = props

  return (
    <>
      {/* Global modals */}
      <ProfileModal {...props} />
      <MessageInfoModal {...props} />
      <EditMessageModal {...props} />
      <DeleteMessageModal {...props} />
      <ChatActionsModal {...props} />
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
                    ? t('rooms')
                    : t('profile')
                  : t('encryptedBadge')}
              </Text>
            </div>
            <Group gap="xs" wrap="nowrap">
              <Badge color={health.data?.status === 'ok' ? 'green' : 'red'} variant="light">
                {health.data?.status === 'ok' ? t('online') : t('offline')}
              </Badge>
              {!isMobile && (
                <>
                  <SegmentedControl
                    size="xs"
                    value={locale}
                    onChange={(value) => setLocale(value === 'en' ? 'en' : 'ru')}
                    data={[
                      { value: 'ru', label: 'RU' },
                      { value: 'en', label: 'EN' },
                    ]}
                  />
                  <ActionIcon variant="subtle" onClick={toggleTheme} aria-label="Toggle theme">
                    {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
                  </ActionIcon>
                </>
              )}
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
          <Sidebar {...props} />
          <ChatView {...props} />
        </Group>

        {isMobile && (
          <Group className="mobile-bottom-nav" gap={4} wrap="nowrap">
            {([
              { value: 'chat', label: t('chat'), icon: <IconMessageCircle size={18} /> },
              { value: 'rooms', label: t('rooms'), icon: <IconLock size={18} /> },
              { value: 'profile', label: t('profile'), icon: <IconUserPlus size={18} /> },
            ] as const).map((item) => (
              <button
                key={item.value}
                type="button"
                className={`mobile-nav-item${mobileView === item.value ? ' mobile-nav-item-active' : ''}`}
                onClick={() => setMobileView(item.value)}
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
        <Avatar src={avatarSrc} name={profileUser.displayName} radius="xl" size={160} color="blue" />
      </Stack>
    </Modal>
    <Modal opened={Boolean(profileUser)} onClose={() => setProfileUser(null)} title={t('profileTitle')} centered>
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
          style={{ width: '100%', resize: 'vertical', padding: 8, borderRadius: 4, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14 }}
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

function ChatActionsModal(props: AppShellLayoutProps) {
  const { t } = useI18n()
  const {
    mobileChatActionsOpened,
    setMobileChatActionsOpened,
    activeRoom,
    isMobile,
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
        <Stack gap="sm">
          <input
            placeholder="Search messages"
            value={messageSearch}
            onChange={(e) => setMessageSearch(e.currentTarget.value)}
            style={{ width: '100%', padding: '8px', borderRadius: 4, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14 }}
          />
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
          <Button variant="subtle" onClick={closeChat} fullWidth>{t('closeChat')}</Button>
          <Button
            variant={callState === 'idle' ? 'light' : 'filled'}
            color={callState === 'idle' ? 'green' : 'red'}
            onClick={callState === 'idle' ? () => startCall() : () => endCall(true)}
            fullWidth
            disabled={!activeRoomID}
          >
            {callState === 'idle' ? t('startCall') : t('endCall')}
          </Button>
          <Button
            variant="light"
            onClick={() => navigator.clipboard.writeText(activeInvite).catch(() => undefined)}
            fullWidth
            disabled={!activeInvite}
          >
            {t('copyInvite')}
          </Button>
          <Button
            variant="light"
            onClick={() => navigator.clipboard.writeText(activeInviteLink).catch(() => undefined)}
            fullWidth
            disabled={!activeInviteLink}
          >
            {t('copyInviteLink')}
          </Button>
          <Button
            variant="light"
            onClick={() => navigator.clipboard.writeText(activeChatLink).catch(() => undefined)}
            fullWidth
            disabled={!activeChatLink}
          >
            {t('copyChatLink')}
          </Button>
          {acceptedFriends.length > 0 && (
            <Stack gap={6}>
              <Text size="xs" c="dimmed">{t('inviteFriend')}</Text>
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
          )}
          {!activeInvite && <Text size="xs" c="dimmed">{t('inviteSecretMissing')}</Text>}
          <Button
            variant="light"
            color="red"
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
            style={{ width: '100%', padding: '8px', borderRadius: 4, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14 }}
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
            type="password"
            placeholder={t('invitePlaceholder')}
            value={inviteText}
            onChange={(e) => setInviteText(e.currentTarget.value)}
            style={{ width: '100%', padding: '8px', borderRadius: 4, border: '1px solid var(--mantine-color-gray-4)', fontSize: 14 }}
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
