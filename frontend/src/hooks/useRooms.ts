'use client'

import { notifications } from '@mantine/notifications'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/lib/i18n'
import {
  AuthError,
  createRoom,
  inviteFriendToRoom,
  leaveRoom,
  markRoomRead,
  type AuthSession,
  type Friend,
  type Identity,
  type Room,
} from '@/lib/api'
import { sendEncryptedMessage } from '@/lib/api'
import {
  createRoomSecret,
  encodePlainMessage,
} from '@/lib/crypto'
import { parseInviteToken, replaceAppURL } from '@/types/messenger'

export { sendEncryptedMessage } from '@/lib/api'

export function useRooms(opts: {
  session: AuthSession | null
  identity: Identity | null
  activeRoomID: string
  roomSecrets: Record<string, string>
  isMobile: boolean
  handleAuthExpired: () => void
  handleRequestError: (err: Error, title: string) => void
  persistRoomSecrets: (nextSecrets: Record<string, string>) => void
  setActiveRoomID: (id: string) => void
  setHighlightedMessageID: (id: string) => void
  setPendingMessages: (msgs: never[]) => void
  setMobileView: (v: 'rooms' | 'chat') => void
  setSidebarView: (v: 'rooms' | 'chat') => void
  setMobileCreateRoomOpened: (v: boolean) => void
  setMobileImportInviteOpened: (v: boolean) => void
  setMobileChatActionsOpened: (v: boolean) => void
  setLeaveConfirmOpened: (v: boolean) => void
  sendSystemMessage: (roomID: string, secret: string, type: 'join' | 'leave') => Promise<void>
}) {
  const {
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
    setPendingMessages,
    setMobileView,
    setSidebarView,
    setMobileCreateRoomOpened,
    setMobileImportInviteOpened,
    setMobileChatActionsOpened,
    setLeaveConfirmOpened,
    sendSystemMessage,
  } = opts
  const { t } = useI18n()
  const queryClient = useQueryClient()

  function patchRoomActivity(roomId: string, options: { at?: string; incrementUnread?: boolean; clearUnread?: boolean }) {
    queryClient.setQueriesData<{ rooms: Room[] }>({ queryKey: ['chat-rooms'] }, (current) => {
      if (!current) return current
      const updated = current.rooms.map((room) => {
        if (room.roomId !== roomId) return room
        return {
          ...room,
          lastMessageAt: options.at ?? room.lastMessageAt,
          unreadCount: options.clearUnread
            ? 0
            : (room.unreadCount ?? 0) + (options.incrementUnread ? 1 : 0),
        }
      })
      updated.sort((a, b) => Date.parse(b.lastMessageAt || b.createdAt) - Date.parse(a.lastMessageAt || a.createdAt))
      return { rooms: updated }
    })
  }

  const createRoomMutation = useMutation({
    mutationFn: async (input: { roomName: string; newRoomSecret: string }) => {
      if (!identity || !session) throw new Error('account_required')
      const requestedSecret = input.newRoomSecret.trim()
      const room = await createRoom({
        name: input.roomName.trim() || t('privateRoom'),
        members: [identity.userId],
        roomSecret: requestedSecret || undefined,
        token: session.accessToken,
      })
      const secret = room.roomSecret || requestedSecret || createRoomSecret()
      return { room, secret }
    },
    onSuccess: ({ room, secret }) => {
      const nextSecrets = { ...roomSecrets, [room.roomId]: secret }
      persistRoomSecrets(nextSecrets)
      setActiveRoomID(room.roomId)
      setHighlightedMessageID('')
      if (isMobile) setMobileView('chat')
      else setSidebarView('chat')
      setMobileCreateRoomOpened(false)
      replaceAppURL({ view: 'chat', roomId: room.roomId })
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
      sendSystemMessage(room.roomId, secret, 'join').catch(() => undefined)
      notifications.show({ title: t('roomReady'), message: t('roomReadyMessage'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('roomError')),
  })

  const importInviteMutation = useMutation({
    mutationFn: async (inviteText: string) => {
      if (!identity || !session) throw new Error('account_required')
      const invite = parseInviteToken(inviteText)
      if (!invite) throw new Error('invite_format_must_be_roomId_secret')
      const room = await createRoom({
        roomId: invite.roomId,
        name: t('importedRoom'),
        members: [identity.userId],
        roomSecret: invite.secret,
        token: session.accessToken,
      })
      return { room, secret: room.roomSecret || invite.secret }
    },
    onSuccess: ({ room, secret }) => {
      const nextSecrets = { ...roomSecrets, [room.roomId]: secret }
      persistRoomSecrets(nextSecrets)
      setActiveRoomID(room.roomId)
      setHighlightedMessageID('')
      if (isMobile) setMobileView('chat')
      else setSidebarView('chat')
      setMobileImportInviteOpened(false)
      replaceAppURL({ view: 'chat', roomId: room.roomId })
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
      sendSystemMessage(room.roomId, secret, 'join').catch(() => undefined)
      notifications.show({ title: t('inviteImported'), message: t('inviteImportedMessage'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('inviteError')),
  })

  const inviteFriendMutation = useMutation({
    mutationFn: async (friend: Friend) => {
      if (!session || !activeRoomID) throw new Error('room_not_ready')
      await inviteFriendToRoom({ token: session.accessToken, roomId: activeRoomID, userId: friend.userId })
      return friend
    },
    onSuccess: (friend) => {
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] })
      notifications.show({ title: t('inviteFriend'), message: friend.displayName, color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('inviteFriend')),
  })

  async function leaveActiveRoom(opts2: {
    activeSecret: string
    roomSecrets: Record<string, string>
    persistRoomSecrets: (s: Record<string, string>) => void
    sendSystemMessage: (roomID: string, secret: string, type: 'join' | 'leave') => Promise<void>
  }) {
    if (!activeRoomID || !identity || !session) return
    try {
      await opts2.sendSystemMessage(activeRoomID, opts2.activeSecret, 'leave').catch(() => undefined)
      await leaveRoom({ roomId: activeRoomID, userId: identity.userId, token: session.accessToken })
      const nextSecrets = { ...opts2.roomSecrets }
      delete nextSecrets[activeRoomID]
      opts2.persistRoomSecrets(nextSecrets)
      setActiveRoomID('')
      setHighlightedMessageID('')
      setPendingMessages([])
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
    }
  }

  function markRead(roomId: string, token: string) {
    return markRoomRead({ token, roomId }).catch((err: Error) => {
      if (err instanceof AuthError) handleAuthExpired()
    })
  }

  return {
    patchRoomActivity,
    createRoomMutation,
    importInviteMutation,
    inviteFriendMutation,
    leaveActiveRoom,
    markRead,
  }
}
