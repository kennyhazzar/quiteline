'use client'

import { notifications } from '@mantine/notifications'
import { useCallback, useRef } from 'react'
import { type AuthSession, type EncryptedMessage, type MessageEnvelope, WS_BASE } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { type RealtimeEvent } from '@/types/messenger'

export function useWebSocket(opts: {
  session: AuthSession | null
  currentDisplayName: string
  currentUserID: string
  activeRoomID: string
  onIncomingData: (data: unknown, ws: WebSocket) => void
  onRealtimeEvent: (event: RealtimeEvent) => void
}) {
  const { session, currentDisplayName, currentUserID, activeRoomID, onIncomingData, onRealtimeEvent } = opts
  const { t } = useI18n()
  const wsRef = useRef<WebSocket | null>(null)
  const wsReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sendRealtime = useCallback((event: RealtimeEvent) => {
    const topic = 'roomId' in event && event.roomId ? `room:${event.roomId}` : (activeRoomID ? `room:${activeRoomID}` : '')
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !topic) return
    wsRef.current.send(JSON.stringify({ type: 'publish', topic, data: event }))
  }, [activeRoomID])

  const connectWS = useCallback((roomID: string) => {
    const userID = session?.principal.userId
    if (!session || !userID) return
    if (wsReconnectTimerRef.current) {
      clearTimeout(wsReconnectTimerRef.current)
      wsReconnectTimerRef.current = null
    }
    const previousWS = wsRef.current
    wsRef.current = null
    previousWS?.close()

    const url = new URL(`${WS_BASE}/ws`)
    const topics = [`user:${userID}`]
    if (roomID) topics.push(`room:${roomID}`)
    url.searchParams.set('topics', topics.join(','))
    url.searchParams.set('token', session.accessToken)
    const ws = new WebSocket(url.toString())
    wsRef.current = ws

    ws.onopen = () => {
      if (!currentDisplayName) return
      const presenceEvent: RealtimeEvent = {
        kind: 'presence',
        userId: userID,
        displayName: currentDisplayName,
        status: 'online',
        lastSeenAt: new Date().toISOString(),
      }
      const topic = roomID ? `room:${roomID}` : ''
      if (topic && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'publish', topic, data: presenceEvent }))
      }
    }
    ws.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data) as MessageEnvelope
        if (envelope.topic === `room:${roomID}` || envelope.topic === `user:${userID}`) {
          const maybeEvent = envelope.data as Partial<RealtimeEvent>
          if (typeof maybeEvent.kind === 'string') {
            onRealtimeEvent(maybeEvent as RealtimeEvent)
          } else {
            onIncomingData(envelope.data, ws)
          }
        }
      } catch {
        // ignore malformed frames
      }
    }
    ws.onerror = () => notifications.show({ title: t('wsError'), message: t('liveDisconnected'), color: 'red' })
    ws.onclose = () => {
      if (!session?.accessToken || wsRef.current !== ws) return
      wsReconnectTimerRef.current = setTimeout(() => connectWS(roomID), 1500)
    }
  }, [session, currentDisplayName, onIncomingData, onRealtimeEvent, t])

  function closeWS() {
    if (wsReconnectTimerRef.current) {
      clearTimeout(wsReconnectTimerRef.current)
      wsReconnectTimerRef.current = null
    }
    const currentWS = wsRef.current
    wsRef.current = null
    currentWS?.close()
  }

  function sendPresenceOffline(userId: string, displayName: string, roomId: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const topic = roomId ? `room:${roomId}` : ''
    if (!topic) return
    const event: RealtimeEvent = {
      kind: 'presence',
      userId,
      displayName,
      status: 'offline',
      lastSeenAt: new Date().toISOString(),
    }
    wsRef.current.send(JSON.stringify({ type: 'publish', topic, data: event }))
  }

  return {
    wsRef,
    connectWS,
    closeWS,
    sendRealtime,
    sendPresenceOffline,
  }
}
