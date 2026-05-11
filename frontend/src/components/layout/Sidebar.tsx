'use client'

import {
  ActionIcon,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Divider,
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
} from '@mantine/core'
import {
  IconCopy,
  IconDownload,
  IconKey,
  IconPlus,
  IconRefresh,
  IconUserPlus,
} from '@tabler/icons-react'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { useState } from 'react'
import type {
  AccountSession,
  AuthSession,
  Friend,
  Identity,
  Room,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { AppView, DecryptedMessage } from '@/types/messenger'
import { formatBytes, formatLastSeen } from '@/types/messenger'

interface SidebarProps {
  isMobile: boolean
  isTablet: boolean
  mobileView: AppView
  sidebarView: AppView
  leftView: AppView
  setSidebarView: (v: AppView) => void
  liveStatus: 'connecting' | 'connected' | 'disconnected'
  health: UseQueryResult<{ status: string }>
  session: AuthSession
  identity: Identity
  ownAvatarSrc: string
  avatarMutation: UseMutationResult<unknown, Error, File>
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
  attachmentMessages: DecryptedMessage[]
  roomSearch: string
  setRoomSearch: (v: string) => void
  roomName: string
  setRoomName: (v: string) => void
  newRoomSecret: string
  setNewRoomSecret: (v: string) => void
  inviteText: string
  setInviteText: (v: string) => void
  roomSecret: string
  setRoomSecret: (v: string) => void
  selectRoom: (room: Room) => void
  createRoomMutation: UseMutationResult<unknown, Error, { roomName: string; newRoomSecret: string }>
  importInviteMutation: UseMutationResult<unknown, Error, string>
  setMobileCreateRoomOpened: (v: boolean) => void
  setMobileImportInviteOpened: (v: boolean) => void
  downloadAttachment: (msg: DecryptedMessage) => void
}

export function Sidebar(props: SidebarProps) {
  const { t } = useI18n()
  const {
    isMobile,
    isTablet,
    leftView,
    sidebarView,
    setSidebarView,
    rooms,
    filteredRooms,
    activeRoomID,
    activeRoom,
    attachmentMessages,
    selectRoom,
    roomSearch,
    setRoomSearch,
    setMobileCreateRoomOpened,
    setMobileImportInviteOpened,
    downloadAttachment,
  } = props

  return (
    <Stack
      className={!isMobile ? 'app-sidebar' : undefined}
      w={isMobile ? '100%' : isTablet ? 300 : 340}
      gap={isMobile ? 0 : 'md'}
      style={{
        minHeight: 0,
        flexShrink: 0,
        display: isMobile && props.mobileView === 'chat' ? 'none' : 'flex',
        height: isMobile ? '100%' : undefined,
        overflowY: isMobile ? 'auto' : undefined,
        padding: isMobile ? '12px 12px 66px' : 12,
      }}
    >
      {!isMobile && (
        <SegmentedControl
          fullWidth
          value={sidebarView}
          onChange={(value) => setSidebarView(value as AppView)}
          data={[
            { value: 'chat', label: t('chat') },
            { value: 'rooms', label: t('rooms') },
            { value: 'profile', label: t('profile') },
          ]}
        />
      )}

      {/* Chat details panel */}
      <Card
        className={!isMobile ? 'desktop-surface' : undefined}
        withBorder={!isMobile}
        radius={isMobile ? 0 : 'sm'}
        p={isMobile ? 'xs' : 'md'}
        style={{ display: leftView === 'chat' ? undefined : 'none' }}
      >
        <Title order={4} mb="xs">{t('chat')}</Title>
        {activeRoom ? (
          <Stack gap="xs">
            <Text fw={700} truncate>{activeRoom.name}</Text>
            <Button variant="light" onClick={() => setSidebarView('rooms')}>{t('rooms')}</Button>
            <Divider />
            <Text fw={700} size="sm">Attachments</Text>
            <Stack gap={6}>
              {attachmentMessages.slice(0, 8).map((msg) => (
                <Group key={msg.id} gap="xs" wrap="nowrap">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text size="sm" truncate>{msg.body?.attachment?.name}</Text>
                    <Text size="xs" c="dimmed" truncate>
                      {msg.body?.senderName} · {formatBytes(msg.body?.attachment?.size ?? 0)}
                    </Text>
                  </div>
                  <ActionIcon variant="light" size="sm" onClick={() => downloadAttachment(msg)} aria-label={t('download')}>
                    <IconDownload size={15} />
                  </ActionIcon>
                </Group>
              ))}
              {attachmentMessages.length === 0 && <Text size="xs" c="dimmed">No attachments yet.</Text>}
            </Stack>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">{t('chooseRoom')}</Text>
            <Button variant="light" onClick={() => setSidebarView('rooms')}>{t('rooms')}</Button>
          </Stack>
        )}
      </Card>

      {/* Profile panel */}
      {leftView === 'profile' && <ProfilePanel {...props} />}

      {/* Room list */}
      <Card
        withBorder={!isMobile}
        className={!isMobile ? 'desktop-surface' : undefined}
        radius={isMobile ? 'md' : 'sm'}
        p={isMobile ? 'sm' : 'md'}
        style={{
          display: leftView === 'rooms' ? 'flex' : 'none',
          flex: 1,
          minHeight: 0,
          flexDirection: 'column',
        }}
      >
        <Group justify="space-between" mb="sm">
          <Title order={4}>{t('rooms')}</Title>
          <Group gap={6} wrap="nowrap">
            <ActionIcon variant="light" onClick={() => setMobileCreateRoomOpened(true)} aria-label={t('createRoom')}>
              <IconPlus size={16} />
            </ActionIcon>
            <ActionIcon variant="light" onClick={() => setMobileImportInviteOpened(true)} aria-label={t('importInvite')}>
              <IconKey size={16} />
            </ActionIcon>
            <ActionIcon variant="subtle" onClick={() => rooms.refetch()} loading={rooms.isFetching}>
              <IconRefresh size={16} />
            </ActionIcon>
          </Group>
        </Group>
        <TextInput
          mb="sm"
          placeholder="Search rooms"
          value={roomSearch}
          onChange={(event) => setRoomSearch(event.currentTarget.value)}
        />
        <ScrollArea type="auto" offsetScrollbars style={{ flex: 1, minHeight: 0 }}>
          <Stack gap="xs" pr="xs">
            {filteredRooms.map((room) => {
              return (
                <Group key={room.roomId} gap={6} wrap="nowrap">
                  <Button
                    variant={activeRoomID === room.roomId ? 'filled' : 'light'}
                    justify="space-between"
                    onClick={() => selectRoom(room)}
                    style={{ flex: 1, minWidth: 0 }}
                    styles={{ label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
                  >
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0, width: '100%' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {room.name}
                      </span>
                      {Boolean(room.unreadCount) && (
                        <Badge size="xs" color="red" variant="filled" style={{ flexShrink: 0 }}>
                          {room.unreadCount}
                        </Badge>
                      )}
                    </Group>
                  </Button>
                </Group>
              )
            })}
            {filteredRooms.length === 0 && <Text size="sm" c="dimmed">{t('noRooms')}</Text>}
          </Stack>
        </ScrollArea>
      </Card>
    </Stack>
  )
}

function ProfilePanel(props: SidebarProps) {
  const { t, locale } = useI18n()
  const [avatarViewerOpened, setAvatarViewerOpened] = useState(false)
  const {
    session,
    identity,
    liveStatus,
    ownAvatarSrc,
    avatarMutation,
    friends,
    friendUsername,
    setFriendUsername,
    requestFriendMutation,
    respondFriendMutation,
    inviteFriendMutation,
    acceptedFriends,
    activeRoomID,
    activeRoom,
    totpSetup,
    totpQRCode,
    totpConfirmCode,
    setTotpConfirmCode,
    totpDisablePassword,
    setTotpDisablePassword,
    totpDisableCode,
    setTotpDisableCode,
    beginTOTPMutation,
    confirmTOTPMutation,
    disableTOTPMutation,
    accountSessions,
    revokeSessionMutation,
    revokeOtherSessionsMutation,
    logout,
    isMobile,
  } = props
  const sessions = accountSessions.data?.sessions ?? []
  const cleanSessionText = (value?: string) =>
    (value || '').replaceAll(' В· ', ' - ').replaceAll(' · ', ' - ').replaceAll('Â·', '-').trim()
  const sessionCopy = {
    location: locale === 'ru' ? 'Локация' : 'Location',
    created: locale === 'ru' ? 'Создана' : 'Created',
    expires: locale === 'ru' ? 'Истекает' : 'Expires',
    unknownLocation: locale === 'ru' ? 'Локация не определена' : 'Location unknown',
  }
  const friendCode = session.principal.friendCode || ''
  const friendCodeCopy = {
    title: locale === 'ru' ? 'Код для друзей' : 'Friend code',
    hint: locale === 'ru'
      ? 'Скопируйте код и отправьте его человеку вне Quietline.'
      : 'Copy this code and send it outside Quietline.',
    label: locale === 'ru' ? 'Код друга' : 'Friend code',
    placeholder: locale === 'ru' ? 'Введите код' : 'Enter code',
    copied: locale === 'ru' ? 'Код скопирован' : 'Code copied',
  }
  const liveBadge = {
    color: liveStatus === 'connected' ? 'green' : liveStatus === 'connecting' ? 'yellow' : 'red',
    label: liveStatus === 'connected'
      ? t('online')
      : liveStatus === 'connecting'
        ? (locale === 'ru' ? 'Соединение' : 'Connecting')
        : t('offline'),
  }

  return (
    <>
    <Modal opened={avatarViewerOpened} onClose={() => setAvatarViewerOpened(false)} title={t('avatar')} centered size="lg">
      {ownAvatarSrc ? (
        <Image src={ownAvatarSrc} alt="avatar" mah="70dvh" fit="contain" radius="md" />
      ) : (
        <Stack align="center" py="xl">
          <Avatar name={session.principal.displayName || identity.displayName} size={120} radius="xl" color="blue" />
        </Stack>
      )}
    </Modal>
    <Card
      withBorder={!isMobile}
      className={!isMobile ? 'desktop-surface' : undefined}
      radius={isMobile ? 'md' : 'sm'}
      p={isMobile ? 'sm' : 'md'}
      style={{
        display: 'block',
        flex: isMobile ? 'unset' : 1,
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      <Group justify="space-between" align="flex-start" mb="xs" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          {ownAvatarSrc ? (
            <Image
              src={ownAvatarSrc}
              alt="avatar"
              w={52}
              h={52}
              radius="xl"
              style={{ cursor: 'pointer' }}
              onClick={() => setAvatarViewerOpened(true)}
            />
          ) : (
            <div
              onClick={() => setAvatarViewerOpened(true)}
              style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--mantine-color-blue-6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 20, cursor: 'pointer' }}
            >
              {(session.principal.displayName || identity.displayName).slice(0, 1).toUpperCase()}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <Text fw={700} truncate>{session.principal.displayName || identity.displayName}</Text>
            <Text size="xs" c="dimmed" truncate>{t('profile')}</Text>
          </div>
        </Group>
        <Badge color={liveBadge.color} style={{ flexShrink: 0 }}>
          {liveBadge.label}
        </Badge>
      </Group>

      <FileInput
        label={t('avatar')}
        placeholder={t('avatarUpload')}
        accept="image/png,image/jpeg,image/webp"
        onChange={(file) => {
          if (file) (avatarMutation as UseMutationResult<unknown, Error, File>).mutate(file)
        }}
        disabled={(avatarMutation as UseMutationResult<unknown, Error, File>).isPending}
        clearable
        mb="sm"
      />

      <Divider my="sm" />

      {/* Friends */}
      <Card withBorder radius="md" p="sm" mb="sm">
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Text fw={700} size="sm">{friendCodeCopy.title}</Text>
            <Text size="xs" c="dimmed" lineClamp={2}>{friendCodeCopy.hint}</Text>
            <Text size="lg" fw={800} mt={4} style={{ letterSpacing: 1 }}>{friendCode || '--------'}</Text>
          </div>
          <ActionIcon
            variant="light"
            size="lg"
            disabled={!friendCode}
            onClick={() => {
              void navigator.clipboard?.writeText(friendCode)
            }}
            aria-label={friendCodeCopy.copied}
          >
            <IconCopy size={18} />
          </ActionIcon>
        </Group>
      </Card>
      <Group justify="space-between" align="center" mb="xs">
        <Text fw={700} size="sm">{t('friends')}</Text>
        <ActionIcon variant="subtle" onClick={() => friends.refetch()} loading={friends.isFetching}>
          <IconRefresh size={16} />
        </ActionIcon>
      </Group>
      <Group align="flex-end" gap="xs" wrap="nowrap" mb="xs">
        <TextInput
          label={friendCodeCopy.label}
          placeholder={friendCodeCopy.placeholder}
          value={friendUsername}
          onChange={(e) => setFriendUsername(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (requestFriendMutation as UseMutationResult<unknown, Error, void>).mutate()
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <ActionIcon
          variant="light"
          size="lg"
          onClick={() => (requestFriendMutation as UseMutationResult<unknown, Error, void>).mutate()}
          loading={(requestFriendMutation as UseMutationResult<unknown, Error, void>).isPending}
          disabled={!friendUsername.trim()}
          aria-label={t('addFriend')}
        >
          <IconUserPlus size={18} />
        </ActionIcon>
      </Group>
      <ScrollArea.Autosize mah={260} type="auto" offsetScrollbars>
        <Stack gap="xs" pr="xs">
          {(friends.data?.friends ?? []).map((friend) => (
            <Group key={friend.userId} justify="space-between" gap="xs" wrap="nowrap">
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={friend.status === 'accepted' ? 700 : 500} truncate>
                {friend.displayName || t('unknownUser')}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {friend.status === 'accepted'
                  ? t('friendAccepted')
                  : friend.direction === 'incoming'
                    ? t('friendIncoming')
                    : t('friendOutgoing')}
              </Text>
            </div>
            {friend.status === 'pending' && friend.direction === 'incoming' ? (
              <Group gap={4} wrap="nowrap">
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => (respondFriendMutation as UseMutationResult<unknown, Error, { friend: Friend; accept: boolean }>).mutate({ friend, accept: true })}
                >
                  {t('accept')}
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={() => (respondFriendMutation as UseMutationResult<unknown, Error, { friend: Friend; accept: boolean }>).mutate({ friend, accept: false })}
                >
                  {t('decline')}
                </Button>
              </Group>
            ) : friend.status === 'accepted' && activeRoomID && !activeRoom?.members.includes(friend.userId) ? (
              <Button
                size="xs"
                variant="light"
                onClick={() => (inviteFriendMutation as UseMutationResult<unknown, Error, Friend>).mutate(friend)}
                loading={(inviteFriendMutation as UseMutationResult<unknown, Error, Friend>).isPending}
              >
                {t('invite')}
              </Button>
            ) : null}
            </Group>
          ))}
          {(friends.data?.friends ?? []).length === 0 && <Text size="xs" c="dimmed">{t('noFriends')}</Text>}
        </Stack>
      </ScrollArea.Autosize>

      <Divider my="sm" />

      {/* 2FA */}
      <Text fw={700} size="sm" mb="xs">Two-factor authentication</Text>
      <Stack gap="xs">
        <Badge color={session.principal.totpEnabled ? 'green' : 'gray'} variant="light" w="fit-content">
          {session.principal.totpEnabled ? 'Enabled' : 'Disabled'}
        </Badge>
        {!session.principal.totpEnabled ? (
          <>
            <Button variant="light" onClick={() => (beginTOTPMutation as UseMutationResult<unknown, Error, void>).mutate()} loading={(beginTOTPMutation as UseMutationResult<unknown, Error, void>).isPending}>
              Set up 2FA
            </Button>
            {totpSetup && (
              <Stack gap="xs">
                <Text size="xs" c="dimmed">Add this key in your authenticator app, then enter the 6-digit code.</Text>
                {totpQRCode ? (
                  <Box p="xs" bg="white" style={{ borderRadius: 8, border: '1px solid var(--mantine-color-gray-3)', width: 'fit-content' }}>
                    <Image src={totpQRCode} alt="2FA QR code" w={184} h={184} fit="contain" />
                  </Box>
                ) : (
                  <Text size="xs" c="dimmed">QR code is being generated...</Text>
                )}
                <code style={{ display: 'block', padding: '8px', borderRadius: 4, background: 'var(--mantine-color-gray-0)', fontSize: 12 }}>{totpSetup.secret}</code>
                <TextInput
                  label="Code"
                  value={totpConfirmCode}
                  onChange={(e) => setTotpConfirmCode(e.currentTarget.value)}
                />
                <Button
                  onClick={() => (confirmTOTPMutation as UseMutationResult<unknown, Error, void>).mutate()}
                  loading={(confirmTOTPMutation as UseMutationResult<unknown, Error, void>).isPending}
                  disabled={totpConfirmCode.trim().length < 6}
                >
                  Enable 2FA
                </Button>
              </Stack>
            )}
          </>
        ) : (
          <Stack gap="xs">
            <PasswordInput
              label={t('password')}
              value={totpDisablePassword}
              onChange={(e) => setTotpDisablePassword(e.currentTarget.value)}
            />
            <TextInput
              label="2FA code"
              value={totpDisableCode}
              onChange={(e) => setTotpDisableCode(e.currentTarget.value)}
            />
            <Button
              color="red"
              variant="light"
              onClick={() => (disableTOTPMutation as UseMutationResult<unknown, Error, void>).mutate()}
              loading={(disableTOTPMutation as UseMutationResult<unknown, Error, void>).isPending}
              disabled={totpDisablePassword.length < 8 || totpDisableCode.trim().length < 6}
            >
              Disable 2FA
            </Button>
          </Stack>
        )}
      </Stack>

      <Divider my="sm" />

      {/* Sessions */}
      <Group justify="space-between" align="center" mb="xs">
        <Text fw={700} size="sm">{t('sessions')}</Text>
        <Badge variant="light" color="gray">{sessions.length}</Badge>
      </Group>
      <ScrollArea.Autosize mah={isMobile ? 420 : 300} type="auto" offsetScrollbars>
        <Stack gap="xs" pr="xs">
          {sessions.map((item) => {
            const deviceName = cleanSessionText(item.deviceName) || t('sessionDevice')
            const location = cleanSessionText(item.location) || sessionCopy.unknownLocation
            const currentLabel = isMobile
              ? (locale === 'ru' ? 'Текущая' : 'Current')
              : t('currentSession')
            return (
              <Box
                key={item.sessionId}
                p={isMobile ? 'sm' : 'xs'}
                style={{
                  border: '1px solid var(--mantine-color-default-border)',
                  borderRadius: isMobile ? 12 : 8,
                  background: 'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))',
                }}
              >
                <Stack gap={isMobile ? 'xs' : 6}>
                  <Group justify="space-between" align="flex-start" wrap={isMobile ? 'wrap' : 'nowrap'}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Group gap={6} wrap="wrap" mb={4}>
                        <Text size="sm" fw={800} style={{ wordBreak: 'break-word' }}>{deviceName}</Text>
                        {item.current && <Badge size="xs" color="green" variant="light">{currentLabel}</Badge>}
                      </Group>
                      <Stack gap={2}>
                        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word' }}>{sessionCopy.location}: {location}</Text>
                        <Text size="xs" c="dimmed">{sessionCopy.created}: {formatLastSeen(item.createdAt)}</Text>
                        <Text size="xs" c="dimmed">{sessionCopy.expires}: {formatLastSeen(item.expiresAt)}</Text>
                      </Stack>
                    </div>
                    <Button
                      size="xs"
                      variant={item.current ? 'subtle' : 'light'}
                      color="red"
                      onClick={() => (revokeSessionMutation as UseMutationResult<unknown, Error, AccountSession>).mutate(item)}
                      loading={(revokeSessionMutation as UseMutationResult<unknown, Error, AccountSession>).isPending}
                      fullWidth={isMobile}
                      style={{ flexShrink: 0, width: isMobile ? '100%' : undefined }}
                    >
                      {item.current ? t('logout') : t('revoke')}
                    </Button>
                  </Group>
                </Stack>
              </Box>
            )
          })}
          {sessions.length === 0 && (
            <Text size="xs" c="dimmed">{t('noSessions')}</Text>
          )}
        </Stack>
      </ScrollArea.Autosize>
      <Stack mt="sm" gap="xs">
        <Button
          variant="light"
          color="red"
          onClick={() => (revokeOtherSessionsMutation as UseMutationResult<unknown, Error, void>).mutate()}
          loading={(revokeOtherSessionsMutation as UseMutationResult<unknown, Error, void>).isPending}
        >
          {t('revokeOtherSessions')}
        </Button>
        <Button
          color="red"
          onClick={logout}
          loading={(revokeSessionMutation as UseMutationResult<unknown, Error, AccountSession>).isPending}
        >
          {t('logout')}
        </Button>
      </Stack>
    </Card>
    </>
  )
}
