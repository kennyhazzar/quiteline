'use client'

import { notifications } from '@mantine/notifications'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  fetchFriends,
  requestFriend,
  respondFriend,
  type AuthSession,
  type Friend,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'

export function useFriends(opts: {
  session: AuthSession | null
  handleRequestError: (err: Error, title: string) => void
}) {
  const { session, handleRequestError } = opts
  const { t } = useI18n()
  const [friendUsername, setFriendUsername] = useState('')

  const friends = useQuery({
    queryKey: ['friends', session?.accessToken],
    queryFn: () => fetchFriends(session?.accessToken ?? ''),
    enabled: Boolean(session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 30000,
  })

  const requestFriendMutation = useMutation({
    mutationFn: async () => {
      if (!session || !friendUsername.trim()) throw new Error('friend_code_required')
      return requestFriend({ token: session.accessToken, friendCode: friendUsername.trim() })
    },
    onSuccess: () => {
      setFriendUsername('')
      friends.refetch()
      notifications.show({ title: t('friends'), message: t('friendRequestSent'), color: 'green' })
    },
    onError: (err: Error) => handleRequestError(err, t('friends')),
  })

  const respondFriendMutation = useMutation({
    mutationFn: async (input: { friend: Friend; accept: boolean }) => {
      if (!session) throw new Error('login_required')
      await respondFriend({ token: session.accessToken, userId: input.friend.userId, accept: input.accept })
      return input
    },
    onSuccess: () => friends.refetch(),
    onError: (err: Error) => handleRequestError(err, t('friends')),
  })

  return {
    friends,
    friendUsername,
    setFriendUsername,
    requestFriendMutation,
    respondFriendMutation,
  }
}
