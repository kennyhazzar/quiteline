const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
export const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080'
export const API_BASE = BASE

export interface Identity {
  userId: string
  displayName: string
  identityPublicKey: string
  createdAt: string
  lastSeenAt: string
}

export interface Principal {
  clientId: string
  userId: string
  sessionId?: string
  username: string
  displayName: string
  theme: 'light' | 'dark'
  avatarUrl?: string
  totpEnabled: boolean
  scopes: string[]
  expires: number
}

export interface AuthSession {
  accessToken: string
  tokenType: string
  expiresAt: number
  principal: Principal
}

export interface AccountSession {
  sessionId: string
  userId: string
  username: string
  deviceName?: string
  userAgent?: string
  ipAddress?: string
  location?: string
  createdAt: string
  expiresAt: string
  revokedAt?: string
  current?: boolean
}

export interface Room {
  roomId: string
  name: string
  members: string[]
  roomSecret?: string
  lastMessageAt?: string
  unreadCount?: number
  createdAt: string
}

export interface Friend {
  userId: string
  displayName: string
  status: 'pending' | 'accepted'
  direction: 'incoming' | 'outgoing'
  createdAt: string
}

export interface EncryptedMessage {
  id: string
  roomId: string
  senderId: string
  ciphertext: string
  nonce: string
  algorithm: string
  keyId: string
  createdAt: string
  editedAt?: string
  deletedAt?: string
  readBy?: string[]
  readReceipts?: MessageReadReceipt[]
  read?: boolean
  reactions?: MessageReaction[]
}

export interface MessageReadReceipt {
  userId: string
  readAt: string
}

export interface MessageReaction {
  emoji: string
  count: number
}

export interface MessageEnvelope {
  id: string
  topic: string
  data: unknown
  source: string
  createdAt: string
}

export interface FileUploadResponse {
  fileId: string
  size: number
}

export interface TwoFactorChallenge {
  twoFactorRequired: true
}

export interface TOTPSetup {
  secret: string
  otpauthUrl: string
}

export class AuthError extends Error {
  constructor(message = 'unauthorized') {
    super(message)
    this.name = 'AuthError'
  }
}

export async function fetchHealth(): Promise<{ status: string }> {
  const res = await fetch(`${BASE}/healthz`)
  if (!res.ok) throw new Error('health check failed')
  return res.json()
}

export async function registerUser(input: {
  username: string
  password: string
  displayName: string
}): Promise<AuthSession> {
  const res = await fetch(`${BASE}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return readJSON(res)
}

export async function loginUser(input: {
  username: string
  password: string
  totpCode?: string
}): Promise<AuthSession | TwoFactorChallenge> {
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return readJSON(res)
}

export function isTwoFactorChallenge(value: AuthSession | TwoFactorChallenge): value is TwoFactorChallenge {
  return 'twoFactorRequired' in value && value.twoFactorRequired
}

export async function updateTheme(input: {
  token: string
  theme: 'light' | 'dark'
}): Promise<Principal> {
  const res = await fetch(`${BASE}/v1/me/theme`, {
    method: 'PUT',
    headers: authHeaders(input.token),
    body: JSON.stringify({ theme: input.theme }),
  })
  return readJSON(res)
}

export async function uploadAvatar(input: {
  token: string
  blob: Blob
}): Promise<Principal> {
  const form = new FormData()
  form.append('avatar', input.blob, 'avatar.webp')
  const res = await fetch(`${BASE}/v1/me/avatar`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${input.token}` },
    body: form,
  })
  return readJSON(res)
}

export async function beginTOTPSetup(token: string): Promise<TOTPSetup> {
  const res = await fetch(`${BASE}/v1/me/2fa/setup`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  })
  return readJSON(res)
}

export async function confirmTOTP(input: {
  token: string
  code: string
}): Promise<Principal> {
  const res = await fetch(`${BASE}/v1/me/2fa/confirm`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({ code: input.code }),
  })
  return readJSON(res)
}

export async function disableTOTP(input: {
  token: string
  password: string
  code: string
}): Promise<Principal> {
  const res = await fetch(`${BASE}/v1/me/2fa`, {
    method: 'DELETE',
    headers: authHeaders(input.token),
    body: JSON.stringify({ password: input.password, code: input.code }),
  })
  return readJSON(res)
}

export async function fetchAccountSessions(token: string): Promise<{ sessions: AccountSession[] }> {
  const res = await fetch(`${BASE}/v1/me/sessions`, {
    headers: authHeaders(token),
  })
  return readJSON(res)
}

export async function revokeAccountSession(input: {
  token: string
  sessionId: string
}): Promise<void> {
  const res = await fetch(`${BASE}/v1/me/sessions/${encodeURIComponent(input.sessionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${input.token}` },
  })
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'revoke_failed')
  }
}

export async function revokeOtherAccountSessions(token: string): Promise<void> {
  const res = await fetch(`${BASE}/v1/me/sessions/others`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'revoke_failed')
  }
}

export function absoluteAvatarUrl(avatarUrl?: string): string {
  if (!avatarUrl) return ''
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) return avatarUrl
  return `${BASE}${avatarUrl}`
}

export async function fetchCurrentIdentity(token: string): Promise<Identity> {
  const res = await fetch(`${BASE}/v1/me/identity`, {
    headers: authHeaders(token),
  })
  return readJSON(res)
}

export async function fetchFriends(token: string): Promise<{ friends: Friend[] }> {
  const res = await fetch(`${BASE}/v1/chat/friends`, {
    headers: authHeaders(token),
  })
  return readJSON(res)
}

export async function requestFriend(input: {
  token: string
  username: string
}): Promise<{ friends: Friend[] }> {
  const res = await fetch(`${BASE}/v1/chat/friends`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({ username: input.username }),
  })
  return readJSON(res)
}

export async function respondFriend(input: {
  token: string
  userId: string
  accept: boolean
}): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/friends/${encodeURIComponent(input.userId)}/${input.accept ? 'accept' : 'decline'}`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'friend_response_failed')
  }
}

export async function upsertIdentity(input: {
  userId: string
  displayName: string
  identityPublicKey: string
  token: string
}): Promise<Identity> {
  const res = await fetch(`${BASE}/v1/chat/identities/${encodeURIComponent(input.userId)}`, {
    method: 'PUT',
    headers: authHeaders(input.token),
    body: JSON.stringify({
      displayName: input.displayName,
      identityPublicKey: input.identityPublicKey,
    }),
  })
  return readJSON(res)
}

export async function fetchIdentity(userId: string, token: string): Promise<Identity> {
  const res = await fetch(`${BASE}/v1/chat/identities/${encodeURIComponent(userId)}`, {
    headers: authHeaders(token),
  })
  return readJSON(res)
}

export async function touchIdentity(userId: string, token: string): Promise<Identity> {
  const res = await fetch(`${BASE}/v1/chat/identities/${encodeURIComponent(userId)}/last-seen`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  })
  return readJSON(res)
}

export async function createRoom(input: {
  roomId?: string
  name: string
  members: string[]
  roomSecret?: string
  token: string
}): Promise<Room> {
  const res = await fetch(`${BASE}/v1/chat/rooms`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({
      roomId: input.roomId,
      name: input.name,
      members: input.members,
      roomSecret: input.roomSecret,
    }),
  })
  return readJSON(res)
}

export async function fetchRooms(token: string): Promise<{ rooms: Room[] }> {
  const res = await fetch(`${BASE}/v1/chat/rooms`, {
    headers: authHeaders(token),
  })
  return readJSON(res)
}

export async function leaveRoom(input: {
  roomId: string
  userId: string
  token: string
}): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(input.roomId)}/members/${encodeURIComponent(input.userId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${input.token}` },
  })
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'leave_failed')
  }
}

export async function inviteFriendToRoom(input: {
  token: string
  roomId: string
  userId: string
}): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(input.roomId)}/friends`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({ userId: input.userId }),
  })
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'invite_friend_failed')
  }
}

export async function markRoomRead(input: {
  token: string
  roomId: string
}): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(input.roomId)}/read`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'mark_read_failed')
  }
}

export async function fetchMessages(
  roomId: string,
  token: string,
  before?: string,
): Promise<{ messages: EncryptedMessage[]; hasMore: boolean }> {
  const cursor = before ? `?before=${encodeURIComponent(before)}` : ''
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(roomId)}/messages${cursor}`, {
    headers: authHeaders(token),
  })
  const page = await readJSON<{ messages?: EncryptedMessage[]; hasMore?: boolean }>(res)
  return { messages: page.messages ?? [], hasMore: Boolean(page.hasMore) }
}

export async function fetchAttachmentMessages(roomId: string, token: string): Promise<{ messages: EncryptedMessage[] }> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(roomId)}/attachments`, {
    headers: authHeaders(token),
  })
  const page = await readJSON<{ messages?: EncryptedMessage[] }>(res)
  return { messages: page.messages ?? [] }
}

export async function sendEncryptedMessage(input: {
  roomId: string
  senderId: string
  ciphertext: string
  nonce: string
  algorithm: string
  keyId: string
  token: string
}): Promise<EncryptedMessage> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(input.roomId)}/messages`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({
      senderId: input.senderId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      algorithm: input.algorithm,
      keyId: input.keyId,
    }),
  })
  return readJSON(res)
}

export async function updateEncryptedMessage(input: {
  roomId: string
  messageId: string
  ciphertext: string
  nonce: string
  algorithm: string
  keyId: string
  token: string
}): Promise<EncryptedMessage> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(input.roomId)}/messages/${encodeURIComponent(input.messageId)}`, {
    method: 'PUT',
    headers: authHeaders(input.token),
    body: JSON.stringify({
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      algorithm: input.algorithm,
      keyId: input.keyId,
    }),
  })
  return readJSON(res)
}

export async function deleteEncryptedMessageForAll(input: {
  roomId: string
  messageId: string
  token: string
}): Promise<EncryptedMessage> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(input.roomId)}/messages/${encodeURIComponent(input.messageId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${input.token}` },
  })
  return readJSON(res)
}

export async function toggleMessageReaction(input: {
  roomId: string
  messageId: string
  emoji: string
  token: string
}): Promise<EncryptedMessage> {
  const res = await fetch(`${BASE}/v1/chat/rooms/${encodeURIComponent(input.roomId)}/messages/${encodeURIComponent(input.messageId)}/reactions`, {
    method: 'POST',
    headers: authHeaders(input.token),
    body: JSON.stringify({ emoji: input.emoji }),
  })
  return readJSON(res)
}

export async function uploadEncryptedFile(input: {
  token: string
  roomId: string
  blob: Blob
}): Promise<FileUploadResponse> {
  const form = new FormData()
  form.append('file', input.blob, 'encrypted.bin')
  form.append('roomId', input.roomId)
  const res = await fetch(`${BASE}/v1/chat/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.token}` },
    body: form,
  })
  return readJSON(res)
}

export async function downloadEncryptedFile(input: {
  token: string
  fileId: string
  roomId: string
}): Promise<Blob> {
  const url = `${BASE}/v1/chat/files/${encodeURIComponent(input.fileId)}?roomId=${encodeURIComponent(input.roomId)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${input.token}` },
  })
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'download_failed')
  }
  return res.blob()
}

function authHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

async function readJSON<T>(res: Response): Promise<T> {
  if (!res.ok) {
    if (res.status === 401) throw new AuthError()
    const err = await res.json().catch(() => ({ error: 'unknown_error' }))
    throw new Error((err as { error?: string }).error ?? 'request_failed')
  }
  return res.json()
}
