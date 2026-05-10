'use client'

import { notifications } from '@mantine/notifications'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AuthError,
  downloadEncryptedFile,
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

  const messageInputRef = useRef<HTMLInputElement | null>(null)
  const messageTextRef = useRef('')
  const messagesViewportRef = useRef<HTMLDivElement | null>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readMarksRef = useRef<Record<string, number>>({})

  const history = useQuery({
    queryKey: ['chat-messages', activeRoomID, session?.accessToken],
    queryFn: () => fetchMessages(activeRoomID, session?.accessToken ?? ''),
    enabled: Boolean(activeRoomID && session),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 30000,
  })

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
    for (const msg of history.data?.messages ?? []) put(msg)
    for (const msg of liveMessages) put(msg)
    return [...byID.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [history.data?.messages, liveMessages])

  useEffect(() => {
    let cancelled = false
    async function run() {
      const next = await Promise.all(
        encryptedMessages.map(async (msg) => {
          const status: DecryptedMessage['status'] =
            msg.senderId === identity?.userId ? (msg.read ? 'read' : 'sent') : undefined
          try {
            return {
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
      if (!cancelled) setDecryptedMessages(next)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [activeSecret, encryptedMessages, identity?.userId])

  const displayMessages = useMemo(() => {
    const byID = new Map<string, DecryptedMessage>()
    for (const msg of pendingMessages) {
      if (msg.roomId === activeRoomID && !localDeletedMessageIDs[msg.id]) byID.set(msg.id, msg)
    }
    for (const msg of decryptedMessages) {
      if (!localDeletedMessageIDs[msg.id]) byID.set(msg.id, msg)
    }
    return [...byID.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }, [activeRoomID, decryptedMessages, localDeletedMessageIDs, pendingMessages])

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

  const attachmentMessages = useMemo(
    () => displayMessages.filter((msg) => !msg.deletedAt && msg.body?.attachment),
    [displayMessages],
  )

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
      setPendingMessages((prev) => prev.filter((item) => item.id !== clientId))
      setLiveMessages((prev) => [...prev, message].slice(-200))
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
    displayMessages,
    visibleMessages,
    attachmentMessages,
    messageInputRef,
    messageTextRef,
    messagesViewportRef,
    readMarksRef,
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
