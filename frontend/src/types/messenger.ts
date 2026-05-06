import type { EncryptedMessage } from '@/lib/api'
import type { PlainMessage } from '@/lib/crypto'

export interface DecryptedMessage {
  id: string
  roomId: string
  senderId: string
  body: PlainMessage | null
  createdAt: string
  editedAt?: string
  deletedAt?: string
  readBy?: string[]
  readReceipts?: EncryptedMessage['readReceipts']
  read?: boolean
  reactions?: EncryptedMessage['reactions']
  status?: 'sending' | 'sent' | 'read' | 'failed'
  failed?: boolean
}

export interface MessageDraft {
  clientId: string
  roomId: string
  text: string
  file: File | null
  createdAt: string
  replyTo?: PlainMessage['replyTo']
}

export type RealtimeEvent =
  | { kind: 'typing'; userId: string; displayName: string; typing: boolean; at: string }
  | { kind: 'presence'; userId: string; displayName: string; status: 'online' | 'offline'; lastSeenAt: string }
  | { kind: 'chats.changed'; roomId?: string; userId?: string; at: string }
  | { kind: 'rooms.changed'; roomId?: string; userId?: string; at: string }
  | { kind: 'friends.changed'; userId?: string; at: string }
  | { kind: 'sessions.changed'; userId?: string; at: string }
  | { kind: 'session.revoked'; userId?: string; sessionId?: string; at: string }
  | { kind: 'message.read'; roomId: string; userId: string; at: string }
  | { kind: 'message.created'; roomId: string; messageId: string; senderId: string; at: string }
  | { kind: 'call-offer'; callId: string; roomId: string; fromUserId: string; toUserId: string; displayName: string; offer: RTCSessionDescriptionInit }
  | { kind: 'call-answer'; callId: string; roomId: string; fromUserId: string; toUserId: string; answer: RTCSessionDescriptionInit }
  | { kind: 'call-ice'; callId: string; roomId: string; fromUserId: string; toUserId: string; candidate: RTCIceCandidateInit }
  | { kind: 'call-hangup'; callId: string; roomId: string; fromUserId: string; toUserId: string }
  | { kind: 'call-decline'; callId: string; roomId: string; fromUserId: string; toUserId: string; reason?: 'busy' | 'declined' }

export type CallState = 'idle' | 'calling' | 'ringing' | 'connected'
export type AppView = 'chat' | 'rooms' | 'profile'

export const ROOM_SECRETS_KEY = 'zk.roomSecrets.v1'
export const SESSION_KEY = 'zk.session.v1'
export const LOCAL_DELETED_MESSAGES_KEY = 'quietline.deletedMessages.v1'
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '✅']

export function accountScopedKey(base: string, accountId: string) {
  return `${base}.${accountId}`
}

export function readStoredJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

export function maskedRoomId(roomId: string) {
  if (roomId.length <= 8) return '*'.repeat(roomId.length)
  return `${roomId.slice(0, 4)}${'*'.repeat(Math.min(14, roomId.length - 8))}${roomId.slice(-4)}`
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${bytes} B`
}

export function formatLastSeen(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleString()
}

export function messageVersion(msg: { deletedAt?: string; editedAt?: string; createdAt: string }) {
  return Date.parse(msg.deletedAt || msg.editedAt || msg.createdAt)
}

export function reactionSignature(msg: { reactions?: Array<{ emoji: string; count: number }> }) {
  return (msg.reactions ?? []).map((r) => `${r.emoji}:${r.count}`).join('|')
}

export function isPersistedMessageID(messageID: string) {
  return !messageID.startsWith('local-')
}

export type AppRouteOptions = { view?: AppView; roomId?: string; messageId?: string }

export function buildAppPath(options: AppRouteOptions = {}) {
  if (typeof window === 'undefined') return '/'
  const view = options.view ?? 'rooms'
  if (view === 'profile') return '/profile'
  if (view === 'chat' && options.roomId) {
    const chatPath = `/chats/${encodeURIComponent(options.roomId)}`
    return options.messageId ? `${chatPath}/messages/${encodeURIComponent(options.messageId)}` : chatPath
  }
  return '/chats'
}

export function buildAppURL(options: AppRouteOptions = {}) {
  if (typeof window === 'undefined') return ''
  return new URL(buildAppPath(options), window.location.origin).toString()
}

export function replaceAppURL(options: AppRouteOptions = {}) {
  if (typeof window === 'undefined') return
  window.history.replaceState(null, '', buildAppPath(options))
}
