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
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconBell,
  IconChevronLeft,
  IconCopy,
  IconDeviceDesktop,
  IconDownload,
  IconKey,
  IconMessageCircle,
  IconPlus,
  IconRefresh,
  IconShieldLock,
  IconUser,
  IconUserPlus,
  IconUsers,
} from '@tabler/icons-react'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'
import { useEffect, useState, type ReactNode } from 'react'
import type {
  AccountSession,
  AuthSession,
  Friend,
  Identity,
  Room,
} from '@/lib/api'
import {
  deletePushSubscription,
  fetchPushPublicKey,
  fetchPushSubscriptions,
  savePushSubscription,
  sendTestPush,
  updatePushSubscription,
  type PushPreferences,
  type PushPublicKey,
  type PushSubscriptionRecord,
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
  const { t, locale } = useI18n()
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
          <Stack gap="sm" pr="xs">
            {filteredRooms.map((room) => {
              const isActive = activeRoomID === room.roomId
              const lastActivity = room.lastMessageAt || room.createdAt
              return (
                <button
                  key={room.roomId}
                  type="button"
                  aria-label={room.name}
                  className="chat-list-card"
                  data-active={isActive ? 'true' : 'false'}
                  style={{
                    width: '100%',
                    border: isActive ? '1px solid var(--mantine-color-blue-5)' : '1px solid var(--mantine-color-default-border)',
                    borderRadius: 14,
                    padding: 10,
                    background: isActive
                      ? 'light-dark(var(--mantine-color-blue-0), rgba(34, 139, 230, 0.18))'
                      : 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    boxShadow: isActive ? '0 0 0 1px rgba(34, 139, 230, 0.16)' : undefined,
                  }}
                    onClick={() => selectRoom(room)}
                >
                  <Group gap="sm" wrap="nowrap">
                    <Avatar radius="xl" size={42} color={isActive ? 'blue' : 'gray'}>
                      <IconMessageCircle size={20} />
                    </Avatar>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Group justify="space-between" gap="xs" wrap="nowrap">
                        <Text fw={800} size="sm" truncate>{room.name}</Text>
                        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                          {new Date(lastActivity).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
                        </Text>
                      </Group>
                      <Group justify="space-between" gap="xs" wrap="nowrap" mt={2}>
                        <Text size="xs" c="dimmed" truncate>
                          {locale === 'ru' ? 'Открыть чат' : 'Open chat'}
                        </Text>
                      {Boolean(room.unreadCount) && (
                        <Badge size="sm" color="red" variant="filled" style={{ flexShrink: 0 }}>
                          {room.unreadCount}
                        </Badge>
                      )}
                      </Group>
                    </div>
                  </Group>
                </button>
              )
            })}
            {filteredRooms.length === 0 && (
              <Stack align="center" py="xl" gap="xs">
                <Avatar radius="xl" color="gray" variant="light">
                  <IconMessageCircle size={20} />
                </Avatar>
                <Text size="sm" c="dimmed" ta="center">{t('noRooms')}</Text>
              </Stack>
            )}
          </Stack>
        </ScrollArea>
      </Card>
    </Stack>
  )
}

function ProfilePanel(props: SidebarProps) {
  const { t, locale } = useI18n()
  const [avatarViewerOpened, setAvatarViewerOpened] = useState(false)
  const [profileSection, setProfileSection] = useState<'overview' | 'account' | 'friends' | 'security' | 'notifications' | 'sessions'>('overview')
  const [pushInfo, setPushInfo] = useState<PushPublicKey | null>(null)
  const [pushSubscriptions, setPushSubscriptions] = useState<PushSubscriptionRecord[]>([])
  const [pushLoading, setPushLoading] = useState(false)
  const [pushPrefs, setPushPrefs] = useState<PushPreferences>({ messages: true, chats: true, sessions: true, friends: true })
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
  const sectionCopy = {
    back: locale === 'ru' ? 'Назад' : 'Back',
    account: locale === 'ru' ? 'Аккаунт' : 'Account',
    accountHint: locale === 'ru' ? 'Аватар и внешний вид профиля' : 'Avatar and profile appearance',
    friends: t('friends'),
    friendsHint: locale === 'ru' ? 'Код, заявки и приглашения' : 'Code, requests and invites',
    security: locale === 'ru' ? 'Безопасность' : 'Security',
    securityHint: locale === 'ru' ? 'Двухфакторная защита' : 'Two-factor protection',
    notifications: locale === 'ru' ? 'Уведомления' : 'Notifications',
    notificationsHint: locale === 'ru' ? 'Web Push для событий вне вкладки' : 'Web Push for events outside the tab',
    sessions: t('sessions'),
    sessionsHint: locale === 'ru' ? `${sessions.length} активных сессий` : `${sessions.length} active sessions`,
  }
  const sectionTitle = profileSection === 'account'
    ? sectionCopy.account
    : profileSection === 'friends'
      ? sectionCopy.friends
      : profileSection === 'security'
        ? sectionCopy.security
        : profileSection === 'notifications'
          ? sectionCopy.notifications
          : profileSection === 'sessions'
            ? sectionCopy.sessions
            : t('profile')

  const currentPushSubscription = pushSubscriptions[0] ?? null
  const pushPermission = typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'

  useEffect(() => {
    if (profileSection !== 'notifications') return
    let cancelled = false
    setPushLoading(true)
    Promise.all([
      fetchPushPublicKey(session.accessToken),
      fetchPushSubscriptions(session.accessToken),
    ])
      .then(([info, subs]) => {
        if (cancelled) return
        setPushInfo(info)
        setPushSubscriptions(subs.subscriptions ?? [])
        if (subs.subscriptions?.[0]?.preferences) setPushPrefs(subs.subscriptions[0].preferences)
      })
      .catch((err: Error) => notifications.show({ title: sectionCopy.notifications, message: err.message, color: 'red' }))
      .finally(() => {
        if (!cancelled) setPushLoading(false)
      })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileSection, session.accessToken])

  async function enablePushNotifications() {
    if (!pushInfo?.enabled || !pushInfo.publicKey) {
      notifications.show({ title: sectionCopy.notifications, message: locale === 'ru' ? 'Push не настроен на сервере.' : 'Push is not configured on the server.', color: 'yellow' })
      return
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      notifications.show({ title: sectionCopy.notifications, message: locale === 'ru' ? 'Этот браузер не поддерживает Web Push.' : 'This browser does not support Web Push.', color: 'yellow' })
      return
    }
    setPushLoading(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') throw new Error(locale === 'ru' ? 'Разрешение на уведомления не выдано.' : 'Notification permission was not granted.')
      const registration = await navigator.serviceWorker.register('/sw.js')
      const existing = await registration.pushManager.getSubscription()
      const browserSub = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushInfo.publicKey),
      })
      const json = browserSub.toJSON()
      const saved = await savePushSubscription({
        token: session.accessToken,
        endpoint: json.endpoint ?? '',
        keys: {
          p256dh: json.keys?.p256dh ?? '',
          auth: json.keys?.auth ?? '',
        },
        preferences: pushPrefs,
      })
      setPushSubscriptions([saved])
      setPushPrefs(saved.preferences)
      notifications.show({ title: sectionCopy.notifications, message: locale === 'ru' ? 'Уведомления включены.' : 'Notifications enabled.', color: 'green' })
    } catch (err) {
      notifications.show({ title: sectionCopy.notifications, message: err instanceof Error ? err.message : 'push_failed', color: 'red' })
    } finally {
      setPushLoading(false)
    }
  }

  async function disablePushNotifications() {
    if (!currentPushSubscription) return
    setPushLoading(true)
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration('/sw.js')
        const browserSub = await registration?.pushManager.getSubscription()
        await browserSub?.unsubscribe()
      }
      await deletePushSubscription({ token: session.accessToken, id: currentPushSubscription.id })
      setPushSubscriptions([])
      notifications.show({ title: sectionCopy.notifications, message: locale === 'ru' ? 'Уведомления выключены.' : 'Notifications disabled.', color: 'green' })
    } catch (err) {
      notifications.show({ title: sectionCopy.notifications, message: err instanceof Error ? err.message : 'push_disable_failed', color: 'red' })
    } finally {
      setPushLoading(false)
    }
  }

  async function updatePushPrefs(next: PushPreferences) {
    setPushPrefs(next)
    if (!currentPushSubscription) return
    try {
      const saved = await updatePushSubscription({ token: session.accessToken, id: currentPushSubscription.id, preferences: next })
      setPushSubscriptions([saved])
    } catch (err) {
      notifications.show({ title: sectionCopy.notifications, message: err instanceof Error ? err.message : 'push_update_failed', color: 'red' })
    }
  }

  function SectionCard({
    icon,
    title,
    description,
    onClick,
  }: {
    icon: ReactNode
    title: string
    description: string
    onClick: () => void
  }) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          width: '100%',
          border: '1px solid var(--mantine-color-default-border)',
          borderRadius: 12,
          padding: 12,
          background: 'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <Group gap="sm" wrap="nowrap">
          <ActionIcon variant="light" size="lg" radius="xl">
            {icon}
          </ActionIcon>
          <div style={{ minWidth: 0 }}>
            <Text fw={800} size="sm">{title}</Text>
            <Text size="xs" c="dimmed" lineClamp={2}>{description}</Text>
          </div>
        </Group>
      </button>
    )
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

      {profileSection !== 'overview' && (
        <Group gap="xs" mb="sm" wrap="nowrap">
          <ActionIcon variant="subtle" onClick={() => setProfileSection('overview')} aria-label={sectionCopy.back}>
            <IconChevronLeft size={18} />
          </ActionIcon>
          <Text fw={800}>{sectionTitle}</Text>
        </Group>
      )}

      {profileSection === 'overview' && (
        <Stack gap="xs" mt="sm">
          <SectionCard
            icon={<IconUser size={18} />}
            title={sectionCopy.account}
            description={sectionCopy.accountHint}
            onClick={() => setProfileSection('account')}
          />
          <SectionCard
            icon={<IconUsers size={18} />}
            title={sectionCopy.friends}
            description={sectionCopy.friendsHint}
            onClick={() => setProfileSection('friends')}
          />
          <SectionCard
            icon={<IconShieldLock size={18} />}
            title={sectionCopy.security}
            description={sectionCopy.securityHint}
            onClick={() => setProfileSection('security')}
          />
          <SectionCard
            icon={<IconBell size={18} />}
            title={sectionCopy.notifications}
            description={sectionCopy.notificationsHint}
            onClick={() => setProfileSection('notifications')}
          />
          <SectionCard
            icon={<IconDeviceDesktop size={18} />}
            title={sectionCopy.sessions}
            description={sectionCopy.sessionsHint}
            onClick={() => setProfileSection('sessions')}
          />
          <Button color="red" variant="light" onClick={logout} mt="xs">
            {t('logout')}
          </Button>
        </Stack>
      )}

      {profileSection === 'account' && (
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
      )}

      {profileSection === 'friends' && (
      <>
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
      </>
      )}

      {profileSection === 'security' && (
      <>
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
      </>
      )}

      {profileSection === 'notifications' && (
      <Stack gap="sm">
        <Card withBorder radius="md" p="sm">
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={800}>{sectionCopy.notifications}</Text>
                <Text size="xs" c="dimmed">
                  {locale === 'ru'
                    ? 'Quietline отправляет только технические события без текста сообщений.'
                    : 'Quietline sends only technical events without message content.'}
                </Text>
              </div>
              <Badge color={currentPushSubscription ? 'green' : pushPermission === 'denied' ? 'red' : 'gray'} variant="light">
                {currentPushSubscription
                  ? (locale === 'ru' ? 'Включены' : 'Enabled')
                  : pushPermission === 'denied'
                    ? (locale === 'ru' ? 'Запрещены' : 'Blocked')
                    : (locale === 'ru' ? 'Выключены' : 'Off')}
              </Badge>
            </Group>
            {!pushInfo?.enabled && (
              <Text size="xs" c="yellow">
                {locale === 'ru'
                  ? 'На сервере не заданы VAPID ключи, поэтому Web Push пока недоступен.'
                  : 'VAPID keys are not configured on the server, so Web Push is unavailable.'}
              </Text>
            )}
          </Stack>
        </Card>

        <Card withBorder radius="md" p="sm">
          <Stack gap={6}>
            <Text fw={800} size="sm">{locale === 'ru' ? 'Как включить' : 'How to enable'}</Text>
            {(locale === 'ru'
              ? [
                  '1. Нажмите кнопку включения ниже.',
                  '2. Разрешите уведомления в системном окне браузера.',
                  '3. На iPhone добавьте сайт на экран Домой и откройте Quietline оттуда.',
                  '4. Отправьте тестовое уведомление, чтобы проверить устройство.',
                ]
              : [
                  '1. Press the enable button below.',
                  '2. Allow notifications in the browser permission prompt.',
                  '3. On iPhone, add the site to Home Screen and open Quietline from there.',
                  '4. Send a test notification to verify this device.',
                ]).map((line) => (
                <Text key={line} size="xs" c="dimmed">{line}</Text>
              ))}
          </Stack>
        </Card>

        <Stack gap="xs">
          <Switch
            label={locale === 'ru' ? 'Новые сообщения' : 'New messages'}
            checked={pushPrefs.messages}
            onChange={(event) => void updatePushPrefs({ ...pushPrefs, messages: event.currentTarget.checked })}
          />
          <Switch
            label={locale === 'ru' ? 'Чаты и приглашения' : 'Chats and invitations'}
            checked={pushPrefs.chats}
            onChange={(event) => void updatePushPrefs({ ...pushPrefs, chats: event.currentTarget.checked })}
          />
          <Switch
            label={locale === 'ru' ? 'Сессии аккаунта' : 'Account sessions'}
            checked={pushPrefs.sessions}
            onChange={(event) => void updatePushPrefs({ ...pushPrefs, sessions: event.currentTarget.checked })}
          />
          <Switch
            label={locale === 'ru' ? 'Друзья' : 'Friends'}
            checked={pushPrefs.friends}
            onChange={(event) => void updatePushPrefs({ ...pushPrefs, friends: event.currentTarget.checked })}
          />
        </Stack>

        <Button
          variant={currentPushSubscription ? 'light' : 'filled'}
          onClick={currentPushSubscription ? disablePushNotifications : enablePushNotifications}
          loading={pushLoading}
          disabled={!pushInfo?.enabled && !currentPushSubscription}
        >
          {currentPushSubscription
            ? (locale === 'ru' ? 'Выключить на этом устройстве' : 'Disable on this device')
            : (locale === 'ru' ? 'Включить уведомления' : 'Enable notifications')}
        </Button>
        <Button
          variant="light"
          onClick={() => sendTestPush(session.accessToken).catch((err: Error) => notifications.show({ title: sectionCopy.notifications, message: err.message, color: 'red' }))}
          disabled={!currentPushSubscription}
        >
          {locale === 'ru' ? 'Отправить тест' : 'Send test'}
        </Button>
      </Stack>
      )}

      {profileSection === 'sessions' && (
      <>
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
      </>
      )}
    </Card>
    </>
  )
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}
