'use client'

import { notifications } from '@mantine/notifications'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AuthError,
  downloadEncryptedFile,
  fetchAttachmentMessages,
  fetchMessageContext,
  fetchMessages,
  toggleMessageReaction,
  deleteEncryptedMessageForAll,
  updateEncryptedMessage,
  sendEncryptedMessage,
  uploadEncryptedFile,
  type AuthSession,
  type EncryptedMessage,
  type Identity,
} from '@/lib/api'
import {
  decodeFilePayload,
  decodeMessagePayload,
  encodePlainMessage,
  PLAIN_FILE_ALGORITHM,
  type PlainMessage,
} from '@/lib/crypto'
import { useI18n } from '@/lib/i18n'
import {
  type DecryptedMessage,
  type MessageDraft,
  isPersistedMessageID,
  messageVersion,
  reactionSignature,
  MAX_FILE_BYTES,
  formatBytes,
} from '@/types/messenger'

export { formatBytes }

export function useMessages(opts: {
  session: AuthSession | null
  identity: Identity | null
  activeRoomID: string
  activeSecret: string
  handleAuthExpired: () => void
  handleRequestError: (err: Error, title: string) => void
  sendRealtime: (event: { kind: 'typing'; userId: string; displayName: string; typing: boolean; at: string }) => void
  activeRoom: { name?: string } | null
  highlightedMessageID?: string
}) {
  const {
    session,
    identity,
    activeRoomID,
    activeSecret,
    handleAuthExpired,
    handleRequestError,
    sendRealtime,
    activeRoom,
    highlightedMessageID,
  } = opts
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [liveMessages, setLiveMessages] = useState<EncryptedMessage[]>([])
  const [pendingMessages, setPendingMessages] = useState<DecryptedMessage[]>([])
  const [localDeletedMessageIDs, setLocalDeletedMessageIDs] = useState<Record<string, true>>({})
  const [replyTarget, setReplyTarget] = useState<DecryptedMessage | null>(null)
  const [messageInfo, setMessageInfo] = useState<DecryptedMessage | null>(null)
  const [editTarget, setEditTarget] = useState<DecryptedMessage | null>(null)
  const [editText, setEditText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<DecryptedMessage | null>(null)
  const [deleteForEveryone, setDeleteForEveryone] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [messageSearch, setMessageSearch] = useState('')
  const [decryptedMessages, setDecryptedMessages] = useState<DecryptedMessage[]>([])
  const [attachmentMessages, setAttachmentMessages] = useState<DecryptedMessage[]>([])
  const [olderMessages, setOlderMessages] = useState<EncryptedMessage[]>([])
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false)
  const [isDecryptingMessages, setIsDecryptingMessages] = useState(false)
  const [contextMessages, setContextMessages] = useState<EncryptedMessage[]>([])
  const [contextHasMore, setContextHasMore] = useState(false)
  const [isInContextMode, setIsInContextMode] = useState(false)

  const messageInputRef = useRef<HTMLTextAreaElement | null>(null)
  const isInContextModeRef = useRef(false)
  isInContextModeRef.current = isInContextMode
  // Refs for values used in the highlightedMessageID effect that must NOT be deps
  // (putting them in deps would trigger cleanup and cancel the in-flight fetch).
  const isLoadingMoreMessagesRef = useRef(false)
  isLoadingMoreMessagesRef.current = isLoadingMoreMessages
  const contextMessagesRef = useRef<EncryptedMessage[]>([])
  contextMessagesRef.current = contextMessages
  const messageTextRef = useRef('')
  const messagesViewportRef = useRef<HTMLDivElement | null>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readMarksRef = useRef<Record<string, number>>({})
  const highlightedLoaderRef = useRef('')
  // Cache: id → { cacheKey, decrypted } — avoids re-decrypting unchanged messages
  const decryptCacheRef = useRef<Map<string, { cacheKey: string; decrypted: DecryptedMessage }>>(new Map())

  const history = useQuery({
    queryKey: ['chat-messages', activeRoomID, session?.accessToken],
    queryFn: () => fetchMessages(activeRoomID, session?.accessToken ?? ''),
    enabled: Boolean(activeRoomID && session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 30000,
  })

  const attachmentHistory = useQuery({
    queryKey: ['chat-attachments', activeRoomID, session?.accessToken],
    queryFn: () => fetchAttachmentMessages(activeRoomID, session?.accessToken ?? ''),
    enabled: Boolean(activeRoomID && session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 30000,
  })

  useEffect(() => {
    setOlderMessages([])
    setHasMoreMessages(false)
    setIsLoadingMoreMessages(false)
    setAttachmentMessages([])
    setContextMessages([])
    setContextHasMore(false)
    setIsInContextMode(false)
    highlightedLoaderRef.current = ''
    decryptCacheRef.current.clear()
  }, [activeRoomID, session?.accessToken])

  useEffect(() => {
    if (olderMessages.length === 0) setHasMoreMessages(Boolean(history.data?.hasMore))
  }, [history.data?.hasMore, olderMessages.length])

  const pagedMessages = useMemo(
    () => [...olderMessages, ...(history.data?.messages ?? [])],
    [history.data?.messages, olderMessages],
  )

  const oldestPagedMessageAt = useMemo(() => {
    let oldest = ''
    for (const msg of pagedMessages) {
      if (!oldest || Date.parse(msg.createdAt) < Date.parse(oldest)) oldest = msg.createdAt
    }
    return oldest
  }, [pagedMessages])

  function mergeMessagePages(prev: EncryptedMessage[], incoming: EncryptedMessage[]) {
    const byID = new Map<string, EncryptedMessage>()
    for (const msg of incoming) byID.set(msg.id, msg)
    for (const msg of prev) byID.set(msg.id, msg)
    return [...byID.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }

  function exitContextMode() {
    setContextMessages([])
    setContextHasMore(false)
    setIsInContextMode(false)
    isInContextModeRef.current = false
    highlightedLoaderRef.current = ''
  }

  async function loadMoreMessages() {
    if (isInContextMode) {
      // In context mode: load pages older than the context window's oldest message
      if (!session || !activeRoomID || isLoadingMoreMessages || !contextHasMore) return
      const oldestContextAt = contextMessages[0]?.createdAt
      if (!oldestContextAt) return
      setIsLoadingMoreMessages(true)
      try {
        const page = await fetchMessages(activeRoomID, session.accessToken, oldestContextAt)
        setContextMessages((prev) => mergeMessagePages(page.messages, prev))
        setContextHasMore(page.hasMore)
      } catch (err) {
        if (err instanceof AuthError) handleAuthExpired()
        else handleRequestError(err as Error, t('roomError'))
      } finally {
        setIsLoadingMoreMessages(false)
      }
      return
    }
    // Normal mode
    if (!session || !activeRoomID || !oldestPagedMessageAt || isLoadingMoreMessages || !hasMoreMessages) return
    setIsLoadingMoreMessages(true)
    try {
      const page = await fetchMessages(activeRoomID, session.accessToken, oldestPagedMessageAt)
      setOlderMessages((prev) => mergeMessagePages(prev, page.messages))
      setHasMoreMessages(page.hasMore)
    } catch (err) {
      if (err instanceof AuthError) handleAuthExpired()
      else handleRequestError(err as Error, t('roomError'))
    } finally {
      setIsLoadingMoreMessages(false)
    }
  }

  useEffect(() => {
    if (!session || !activeRoomID || !highlightedMessageID) return
    // Use refs so that changes to isLoadingMoreMessages / contextMessages don't
    // re-run this effect (which would fire the cleanup and cancel the in-flight fetch).
    if (isLoadingMoreMessagesRef.current) return
    if (pagedMessages.some((msg) => msg.id === highlightedMessageID)) return
    if (contextMessagesRef.current.some((msg) => msg.id === highlightedMessageID)) return
    const loaderKey = `${activeRoomID}:${highlightedMessageID}`
    if (highlightedLoaderRef.current === loaderKey) return
    highlightedLoaderRef.current = loaderKey
    const roomID = activeRoomID
    const accessToken = session.accessToken

    let cancelled = false
    async function fetchContext() {
      setIsLoadingMoreMessages(true)
      try {
        const page = await fetchMessageContext(roomID, highlightedMessageID ?? '', accessToken)
        if (!cancelled) {
          // Enter context mode: show the 30-message window around the target.
          // This replaces (not merges) any previous context window.
          setContextMessages(page.messages)
          setContextHasMore(page.hasMore)
          setIsInContextMode(true)
          isInContextModeRef.current = true
        }
      } catch (err) {
        if (err instanceof AuthError) handleAuthExpired()
        else handleRequestError(err as Error, t('roomError'))
        if (!cancelled) highlightedLoaderRef.current = ''
      } finally {
        if (!cancelled) setIsLoadingMoreMessages(false)
      }
    }
    void fetchContext()
    return () => { cancelled = true }
  }, [
    activeRoomID,
    handleAuthExpired,
    handleRequestError,
    highlightedMessageID,
    pagedMessages,
    session,
    t,
  ])

  const encryptedMessages = useMemo(() => {
    const byID = new Map<string, EncryptedMessage>()
    const put = (msg: EncryptedMessage) => {
      const current = byID.get(msg.id)
      if (
        !current ||
        messageVersion(msg) > messageVersion(current) ||
        (messageVersion(msg) === messageVersion(current) && Boolean(msg.read) && !current.read) ||
        (messageVersion(msg) === messageVersion(current) && reactionSignature(msg) !== reactionSignature(current))
      ) {
        byID.set(msg.id, msg)
      }
    }
    // In context mode: show only the context window — avoids a gap between old context and
    // latest messages. Live messages are excluded (they'd appear out-of-order across the gap).
    const sourceMessages = isInContextMode ? contextMessages : pagedMessages
    for (const msg of sourceMessages) {
      if (msg.roomId === activeRoomID) put(msg)
    }
    if (!isInContextMode) {
      for (const msg of liveMessages) {
        if (msg.roomId === activeRoomID) put(msg)
      }
    }
    return [...byID.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [activeRoomID, contextMessages, isInContextMode, liveMessages, pagedMessages])

  const encryptedAttachmentMessages = useMemo(() => {
    const byID = new Map<string, EncryptedMessage>()
    const put = (msg: EncryptedMessage) => {
      const current = byID.get(msg.id)
      if (!current || messageVersion(msg) >= messageVersion(current)) byID.set(msg.id, msg)
    }
    for (const msg of attachmentHistory.data?.messages ?? []) {
      if (msg.roomId === activeRoomID) put(msg)
    }
    for (const msg of liveMessages) {
      if (msg.roomId === activeRoomID) put(msg)
    }
    return [...byID.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }, [activeRoomID, attachmentHistory.data?.messages, liveMessages])

  useEffect(() => {
    if (encryptedMessages.length === 0) {
      setDecryptedMessages([])
      setIsDecryptingMessages(false)
      return
    }

    const cache = decryptCacheRef.current

    // Messages whose ciphertext/metadata changed since last decryption
    const toDecrypt = encryptedMessages.filter((msg) => {
      const cacheKey = `${messageVersion(msg)}:${reactionSignature(msg)}:${msg.read ? 1 : 0}:${identity?.userId}`
      return cache.get(msg.id)?.cacheKey !== cacheKey
    })

    if (toDecrypt.length === 0) {
      // All messages already cached — build result synchronously from stable references
      const next = encryptedMessages.map((msg) => cache.get(msg.id)?.decrypted).filter(Boolean) as DecryptedMessage[]
      setDecryptedMessages(next)
      setIsDecryptingMessages(false)
      return
    }

    // Only show the global spinner for the initial load (nothing decrypted yet)
    if (cache.size === 0) setIsDecryptingMessages(true)

    let cancelled = false
    async function run() {
      const freshlyDecrypted = await Promise.all(
        toDecrypt.map(async (msg) => {
          const status: DecryptedMessage['status'] =
            msg.senderId === identity?.userId ? (msg.read ? 'read' : 'sent') : undefined
          try {
            const decoded: DecryptedMessage = {
              id: msg.id,
              roomId: msg.roomId,
              senderId: msg.senderId,
              body: await decodeMessagePayload({
                roomSecret: activeSecret,
                ciphertext: msg.ciphertext,
                nonce: msg.nonce,
                algorithm: msg.algorithm,
              }),
              createdAt: msg.createdAt,
              editedAt: msg.editedAt,
              deletedAt: msg.deletedAt,
              readBy: msg.readBy ?? [],
              readReceipts: msg.readReceipts ?? [],
              read: Boolean(msg.read),
              reactions: msg.reactions ?? [],
              status,
            } satisfies DecryptedMessage
            return decoded
          } catch {
            return {
              id: msg.id,
              roomId: msg.roomId,
              senderId: msg.senderId,
              body: null,
              createdAt: msg.createdAt,
              editedAt: msg.editedAt,
              deletedAt: msg.deletedAt,
              readBy: msg.readBy ?? [],
              readReceipts: msg.readReceipts ?? [],
              read: Boolean(msg.read),
              reactions: msg.reactions ?? [],
              status,
              failed: true,
            } satisfies DecryptedMessage
          }
        }),
      )
      if (!cancelled) {
        for (let i = 0; i < toDecrypt.length; i++) {
          const msg = toDecrypt[i]
          const cacheKey = `${messageVersion(msg)}:${reactionSignature(msg)}:${msg.read ? 1 : 0}:${identity?.userId}`
          cache.set(msg.id, { cacheKey, decrypted: freshlyDecrypted[i] })
        }
        // Compose result using stable cached references — unchanged messages keep same object identity
        const next = encryptedMessages.map((msg) => cache.get(msg.id)?.decrypted).filter(Boolean) as DecryptedMessage[]
        setDecryptedMessages(next)
        setIsDecryptingMessages(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [activeSecret, encryptedMessages, identity?.userId])

  useEffect(() => {
    let cancelled = false
    async function run() {
      const next = await Promise.all(
        encryptedAttachmentMessages.map(async (msg) => {
          try {
            const body = await decodeMessagePayload({
              roomSecret: activeSecret,
              ciphertext: msg.ciphertext,
              nonce: msg.nonce,
              algorithm: msg.algorithm,
            })
            if (!body.attachment || msg.deletedAt) return null
            const decoded: DecryptedMessage = {
              id: msg.id,
              roomId: msg.roomId,
              senderId: msg.senderId,
              body,
              createdAt: msg.createdAt,
              editedAt: msg.editedAt,
              deletedAt: msg.deletedAt,
              readBy: msg.readBy ?? [],
              readReceipts: msg.readReceipts ?? [],
              read: Boolean(msg.read),
              reactions: msg.reactions ?? [],
            }
            return decoded
          } catch {
            return null
          }
        }),
      )
      if (!cancelled) setAttachmentMessages(next.filter((msg): msg is DecryptedMessage => Boolean(msg)))
    }
    run()
    return () => {
      cancelled = true
    }
  }, [activeSecret, encryptedAttachmentMessages])

  // Drop pending messages whose server ID now appears in decryptedMessages
  useEffect(() => {
    if (pendingMessages.length === 0) return
    const decryptedIds = new Set(decryptedMessages.map((m) => m.id))
    setPendingMessages((prev) => {
      const next = prev.filter((m) => !(m.status === 'sent' && decryptedIds.has(m.id)))
      return next.length === prev.length ? prev : next
    })
  }, [decryptedMessages])

  const displayMessages = useMemo(() => {
    const byID = new Map<string, DecryptedMessage>()

    // Build set of sentAt timestamps for our own confirmed (decrypted) messages.
    // Used to suppress the matching pending bubble the moment the server version arrives,
    // preventing a window where both coexist in the list.
    const confirmedSentAts = new Set<string>()
    for (const msg of decryptedMessages) {
      if (msg.senderId === identity?.userId && msg.body?.sentAt) {
        confirmedSentAts.add(msg.body.sentAt)
      }
    }

    for (const msg of pendingMessages) {
      if (msg.roomId !== activeRoomID || localDeletedMessageIDs[msg.id]) continue
      // Suppress pending if its decrypted counterpart (matched by sentAt) is already present
      if (msg.body?.sentAt && confirmedSentAts.has(msg.body.sentAt)) continue
      byID.set(msg.id, msg)
    }
    for (const msg of decryptedMessages) {
      if (msg.roomId === activeRoomID && !localDeletedMessageIDs[msg.id]) byID.set(msg.id, msg)
    }
    return [...byID.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [activeRoomID, decryptedMessages, localDeletedMessageIDs, pendingMessages, identity?.userId])

  const visibleMessages = useMemo(() => {
    const query = messageSearch.trim().toLowerCase()
    if (!query) return displayMessages
    return displayMessages.filter((msg) => {
      const haystack = [
        msg.body?.senderName,
        msg.body?.text,
        msg.body?.attachment?.name,
        msg.body?.replyTo?.text,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [displayMessages, messageSearch])

  function messageReplyPreview(msg: DecryptedMessage): PlainMessage['replyTo'] {
    const text = msg.body?.text || msg.body?.attachment?.name || 'Message'
    return {
      id: msg.id,
      senderName: msg.body?.senderName ?? msg.senderId,
      text: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    }
  }

  const sendMutation = useMutation({
    mutationFn: async (draft: MessageDraft) => {
      if (!identity || !session) throw new Error('room_not_ready')
      let attachment: PlainMessage['attachment']
      if (draft.file) {
        const uploaded = await uploadEncryptedFile({ token: session.accessToken, roomId: draft.roomId, blob: draft.file })
        attachment = {
          fileId: uploaded.fileId,
          name: draft.file.name,
          type: draft.file.type,
          size: draft.file.size,
          ciphertextSize: uploaded.size,
          nonce: '',
          algorithm: PLAIN_FILE_ALGORITHM,
        }
      }
      const payload = encodePlainMessage({
        text: draft.text,
        senderName: identity.displayName,
        senderAvatarUrl: session.principal.avatarUrl,
        sentAt: draft.createdAt,
        replyTo: draft.replyTo,
        attachment,
      })
      const message = await sendEncryptedMessage({
        roomId: draft.roomId,
        senderId: identity.userId,
        token: session.accessToken,
        ...payload,
      })
      return { clientId: draft.clientId, message }
    },
    onSuccess: ({ clientId, message }) => {
      // Sending a message exits context mode so the new message is visible in the live feed
      if (isInContextModeRef.current) {
        setContextMessages([])
        setContextHasMore(false)
        setIsInContextMode(false)
        isInContextModeRef.current = false
        highlightedLoaderRef.current = ''
      }
      // Replace local clientId with real server ID so the pending bubble stays
      // visible while async decryption runs; displayMessages will overwrite it
      // (decryptedMessages wins by ID) with no gap or flicker.
      setPendingMessages((prev) =>
        prev.map((item) => (item.id === clientId ? { ...item, id: message.id, status: 'sent' as const } : item)),
      )
      setLiveMessages((prev) => {
        // WS may have already added this message; avoid duplicating in liveMessages
        if (prev.some((m) => m.id === message.id)) return prev
        return [...prev, message].slice(-200)
      })
      void queryClient.invalidateQueries({ queryKey: ['chat-attachments', message.roomId] })
      if (identity) {
        sendRealtime({
          kind: 'typing',
          userId: identity.userId,
          displayName: identity.displayName,
          typing: false,
          at: new Date().toISOString(),
        })
      }
      setReplyTarget(null)
    },
    onError: (err: Error, draft) => {
      setPendingMessages((prev) =>
        prev.map((item) => (item.id === draft.clientId ? { ...item, status: 'failed' } : item)),
      )
      handleRequestError(err, t('sendFailed'))
    },
  })

  const editMessageMutation = useMutation({
    mutationFn: async () => {
      if (!session || !editTarget || !editTarget.body) throw new Error('message_not_ready')
      const payload = encodePlainMessage({ ...editTarget.body, text: editText.trim() })
      return updateEncryptedMessage({
        roomId: editTarget.roomId,
        messageId: editTarget.id,
        token: session.accessToken,
        ...payload,
      })
    },
    onSuccess: (message) => {
      setLiveMessages((prev) => [...prev, message].slice(-200))
      void queryClient.invalidateQueries({ queryKey: ['chat-attachments', message.roomId] })
      setEditTarget(null)
      setEditText('')
    },
    onError: (err: Error) => handleRequestError(err, 'Could not edit message'),
  })

  const deleteMessageMutation = useMutation({
    mutationFn: async () => {
      if (!session || !deleteTarget) throw new Error('message_not_ready')
      if (!deleteForEveryone) {
        return { localOnly: true as const, message: deleteTarget }
      }
      const message = await deleteEncryptedMessageForAll({
        roomId: deleteTarget.roomId,
        messageId: deleteTarget.id,
        token: session.accessToken,
      })
      return { localOnly: false as const, message }
    },
    onSuccess: ({ localOnly, message }) => {
      if (localOnly) {
        setLocalDeletedMessageIDs((prev) => {
          const next = { ...prev, [message.id]: true as const }
          return next
        })
      } else {
        setLiveMessages((prev) => [...prev, message as EncryptedMessage].slice(-200))
        void queryClient.invalidateQueries({ queryKey: ['chat-attachments', message.roomId] })
      }
      setDeleteTarget(null)
      setDeleteForEveryone(false)
    },
    onError: (err: Error) => handleRequestError(err, 'Could not delete message'),
  })

  const reactionMutation = useMutation({
    mutationFn: async ({ message, emoji }: { message: DecryptedMessage; emoji: string }) => {
      if (!session) throw new Error('message_not_ready')
      return toggleMessageReaction({
        roomId: message.roomId,
        messageId: message.id,
        emoji,
        token: session.accessToken,
      })
    },
    onSuccess: (message) => {
      setLiveMessages((prev) => [...prev, message].slice(-200))
    },
    onError: (err: Error) => handleRequestError(err, 'Could not react'),
  })

  function submitMessage(highlightedMessageID: string) {
    const text = messageTextRef.current.trim()
    if ((!text && !selectedFile) || !activeRoomID || sendMutation.isPending || !identity) return
    if (selectedFile && selectedFile.size > MAX_FILE_BYTES) {
      notifications.show({ title: t('fileTooLarge'), message: t('fileTooLargeMessage'), color: 'red' })
      return
    }
    const draft: MessageDraft = {
      clientId: `local-${crypto.randomUUID()}`,
      roomId: activeRoomID,
      text,
      file: selectedFile,
      createdAt: new Date().toISOString(),
      replyTo: replyTarget ? messageReplyPreview(replyTarget) : undefined,
    }
    const attachment = selectedFile
      ? {
          fileId: '',
          name: selectedFile.name,
          type: selectedFile.type,
          size: selectedFile.size,
          ciphertextSize: selectedFile.size,
          nonce: '',
          algorithm: PLAIN_FILE_ALGORITHM,
        }
      : undefined
    setPendingMessages((prev) => [
      ...prev,
      {
        id: draft.clientId,
        roomId: draft.roomId,
        senderId: identity.userId,
        body: {
          text,
          senderName: identity.displayName,
          senderAvatarUrl: session?.principal.avatarUrl,
          sentAt: draft.createdAt,
          replyTo: draft.replyTo,
          attachment,
        },
        createdAt: draft.createdAt,
        status: 'sending',
      },
    ])
    messageTextRef.current = ''
    if (messageInputRef.current) messageInputRef.current.value = ''
    setSelectedFile(null)
    setReplyTarget(null)
    sendMutation.mutate(draft)
  }

  function updateMessageText(value: string) {
    messageTextRef.current = value
    if (!identity || !activeRoomID) return
    sendRealtime({
      kind: 'typing',
      userId: identity.userId,
      displayName: identity.displayName,
      typing: Boolean(value.trim()),
      at: new Date().toISOString(),
    })
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(() => {
      sendRealtime({
        kind: 'typing',
        userId: identity.userId,
        displayName: identity.displayName,
        typing: false,
        at: new Date().toISOString(),
      })
    }, 1200)
  }

  function selectFile(file: File | null) {
    if (file && file.size > MAX_FILE_BYTES) {
      setSelectedFile(null)
      notifications.show({ title: t('fileTooLarge'), message: t('fileTooLargeMessage'), color: 'red' })
      return
    }
    setSelectedFile(file)
  }

  function openEditMessage(msg: DecryptedMessage) {
    setEditTarget(msg)
    setEditText(msg.body?.text ?? '')
  }

  function openDeleteMessage(msg: DecryptedMessage) {
    setDeleteTarget(msg)
    setDeleteForEveryone(false)
  }

  function copyMessageText(msg: DecryptedMessage) {
    const text = msg.body?.text || msg.body?.attachment?.name || ''
    if (!text) return
    navigator.clipboard.writeText(text).catch(() => undefined)
  }

  async function previewAttachment(msg: DecryptedMessage) {
    if (!session || !msg.body?.attachment) return
    const attachment = msg.body.attachment
    try {
      const encrypted = await downloadEncryptedFile({ token: session.accessToken, fileId: attachment.fileId, roomId: activeRoomID })
      const decrypted = await decodeFilePayload({
        roomSecret: activeSecret,
        encrypted,
        nonce: attachment.nonce,
        type: attachment.type,
        algorithm: attachment.algorithm,
      })
      const url = URL.createObjectURL(decrypted)
      setPreviews((prev) => {
        if (prev[msg.id]) URL.revokeObjectURL(prev[msg.id])
        return { ...prev, [msg.id]: url }
      })
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired()
      } else {
        notifications.show({
          title: t('previewFailed'),
          message: err instanceof Error ? err.message : t('unableToDecrypt'),
          color: 'red',
        })
      }
    }
  }

  async function downloadAttachment(msg: DecryptedMessage) {
    if (!session || !msg.body?.attachment) return
    const attachment = msg.body.attachment
    try {
      const encrypted = await downloadEncryptedFile({ token: session.accessToken, fileId: attachment.fileId, roomId: activeRoomID })
      const decrypted = await decodeFilePayload({
        roomSecret: activeSecret,
        encrypted,
        nonce: attachment.nonce,
        type: attachment.type,
        algorithm: attachment.algorithm,
      })
      const url = URL.createObjectURL(decrypted)
      const link = document.createElement('a')
      link.href = url
      link.download = attachment.name
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      if (err instanceof AuthError) {
        handleAuthExpired()
      } else {
        notifications.show({
          title: t('downloadFailed'),
          message: err instanceof Error ? err.message : t('unableToDecrypt'),
          color: 'red',
        })
      }
    }
  }

  function persistLocalDeletedMessages(nextDeleted: Record<string, true>) {
    setLocalDeletedMessageIDs(nextDeleted)
  }

  return {
    history,
    attachmentHistory,
    liveMessages,
    setLiveMessages,
    pendingMessages,
    setPendingMessages,
    localDeletedMessageIDs,
    setLocalDeletedMessageIDs,
    persistLocalDeletedMessages,
    replyTarget,
    setReplyTarget,
    messageInfo,
    setMessageInfo,
    editTarget,
    setEditTarget,
    editText,
    setEditText,
    deleteTarget,
    setDeleteTarget,
    deleteForEveryone,
    setDeleteForEveryone,
    selectedFile,
    setSelectedFile,
    previews,
    messageSearch,
    setMessageSearch,
    decryptedMessages,
    isDecryptingMessages,
    encryptedMessageCount: encryptedMessages.length,
    displayMessages,
    visibleMessages,
    attachmentMessages,
    messageInputRef,
    messageTextRef,
    messagesViewportRef,
    readMarksRef,
    hasMoreMessages: isInContextMode ? contextHasMore : hasMoreMessages,
    isInContextMode,
    exitContextMode,
    isLoadingMoreMessages,
    loadMoreMessages,
    sendMutation,
    editMessageMutation,
    deleteMessageMutation,
    reactionMutation,
    submitMessage,
    updateMessageText,
    selectFile,
    openEditMessage,
    openDeleteMessage,
    copyMessageText,
    previewAttachment,
    downloadAttachment,
    messageReplyPreview,
  }
}
