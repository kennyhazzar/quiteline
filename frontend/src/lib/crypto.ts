export interface LocalIdentity {
  userId: string
  displayName: string
  identityPublicKey: string
  identityPrivateKey: JsonWebKey
}

export interface PlainMessage {
  text: string
  senderName: string
  senderAvatarUrl?: string
  sentAt: string
  system?: {
    type: 'join' | 'leave'
    text: string
  }
  attachment?: EncryptedAttachment
}

export interface EncryptedAttachment {
  fileId: string
  name: string
  type: string
  size: number
  ciphertextSize: number
  nonce: string
  algorithm: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
export const PLAIN_MESSAGE_ALGORITHM = 'PLAIN-JSON-V1'
export const PLAIN_FILE_ALGORITHM = 'PLAIN-FILE-V1'

export async function createLocalIdentity(displayName: string): Promise<LocalIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicKey = toBase64URL(JSON.stringify(publicJwk))
  const userId = await digestID(publicKey)

  return {
    userId,
    displayName,
    identityPublicKey: publicKey,
    identityPrivateKey: privateJwk,
  }
}

export function createRoomSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64URL(bytes)
}

export async function keyID(roomSecret: string): Promise<string> {
  return (await digestID(roomSecret)).slice(0, 16)
}

export async function encryptMessage(roomSecret: string, message: PlainMessage) {
  const key = await importRoomKey(roomSecret)
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)
  const plaintext = encoder.encode(JSON.stringify(message))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asArrayBuffer(nonce) }, key, plaintext)

  return {
    ciphertext: bytesToBase64URL(new Uint8Array(ciphertext)),
    nonce: bytesToBase64URL(nonce),
    algorithm: 'AES-GCM-256',
    keyId: await keyID(roomSecret),
  }
}

export function encodePlainMessage(message: PlainMessage) {
  return {
    ciphertext: bytesToBase64URL(encoder.encode(JSON.stringify(message))),
    nonce: '',
    algorithm: PLAIN_MESSAGE_ALGORITHM,
    keyId: 'plain',
  }
}

export async function decodeMessagePayload(input: {
  roomSecret?: string
  ciphertext: string
  nonce: string
  algorithm: string
}): Promise<PlainMessage> {
  if (input.algorithm === PLAIN_MESSAGE_ALGORITHM) {
    return JSON.parse(decoder.decode(base64URLToBytes(input.ciphertext))) as PlainMessage
  }
  if (!input.roomSecret) throw new Error('room_secret_required')
  return decryptMessage(input.roomSecret, input.ciphertext, input.nonce)
}

export async function decryptMessage(roomSecret: string, ciphertext: string, nonce: string): Promise<PlainMessage> {
  const key = await importRoomKey(roomSecret)
  const nonceBytes = base64URLToBytes(nonce)
  const ciphertextBytes = base64URLToBytes(ciphertext)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(nonceBytes) },
    key,
    asArrayBuffer(ciphertextBytes),
  )
  return JSON.parse(decoder.decode(plain)) as PlainMessage
}

export async function encryptFile(roomSecret: string, file: File) {
  const key = await importRoomKey(roomSecret)
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(nonce) },
    key,
    await file.arrayBuffer(),
  )
  return {
    blob: new Blob([ciphertext], { type: 'application/octet-stream' }),
    nonce: bytesToBase64URL(nonce),
    algorithm: 'AES-GCM-256',
  }
}

export async function decryptFile(roomSecret: string, encrypted: Blob, nonce: string, type: string): Promise<Blob> {
  const key = await importRoomKey(roomSecret)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(base64URLToBytes(nonce)) },
    key,
    await encrypted.arrayBuffer(),
  )
  return new Blob([plain], { type: type || 'application/octet-stream' })
}

export async function decodeFilePayload(input: {
  roomSecret?: string
  encrypted: Blob
  nonce: string
  type: string
  algorithm: string
}): Promise<Blob> {
  if (input.algorithm === PLAIN_FILE_ALGORITHM) {
    return input.encrypted.slice(0, input.encrypted.size, input.type || 'application/octet-stream')
  }
  if (!input.roomSecret) throw new Error('room_secret_required')
  return decryptFile(input.roomSecret, input.encrypted, input.nonce, input.type)
}

async function importRoomKey(roomSecret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(roomSecret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function digestID(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return bytesToBase64URL(new Uint8Array(digest)).slice(0, 22)
}

function toBase64URL(value: string): string {
  return bytesToBase64URL(encoder.encode(value))
}

function bytesToBase64URL(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64URLToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
