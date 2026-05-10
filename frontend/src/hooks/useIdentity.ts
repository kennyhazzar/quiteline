'use client'

import { useEffect, useMemo } from 'react'
import {
  AuthError,
  fetchIdentity,
  touchIdentity,
  type AuthSession,
  type Identity,
  type Room,
} from '@/lib/api'
import { useQuery } from '@tanstack/react-query'

export function useIdentity(opts: {
  session: AuthSession | null
  identity: Identity | null
  activeRoom: Room | null
  activeRoomID: string
  handleAuthExpired: () => void
}) {
  const { session, identity, activeRoom, activeRoomID, handleAuthExpired } = opts

  const memberIdentities = useQuery({
    queryKey: ['chat-identities', activeRoomID, activeRoom?.members, session?.accessToken],
    queryFn: async () => {
      if (!activeRoom || !session) return [] as Identity[]
      const identities = await Promise.all(
        activeRoom.members.map((member) =>
          fetchIdentity(member, session.accessToken).catch((err) => {
            if (err instanceof AuthError) throw err
            return null
          }),
        ),
      )
      return identities.filter((item): item is Identity => Boolean(item))
    },
    enabled: Boolean(activeRoom && session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 60000,
  })

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
  }, [identity, session, handleAuthExpired])

  const identitiesByID = useMemo(() => {
    const result = new Map<string, Identity>()
    for (const item of memberIdentities.data ?? []) result.set(item.userId, item)
    return result
  }, [memberIdentities.data])

  const peers = useMemo(
    () => (memberIdentities.data ?? []).filter((member) => member.userId !== identity?.userId),
    [identity?.userId, memberIdentities.data],
  )

  return {
    memberIdentities,
    identitiesByID,
    peers,
  }
}
