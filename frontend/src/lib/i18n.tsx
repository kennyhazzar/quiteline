'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'

export type Locale = 'ru' | 'en'

const LOCALE_KEY = 'quietline.locale.v1'

const dictionary = {
  ru: {
    account: 'Аккаунт',
    alreadyHaveAccount: 'Уже есть аккаунт?',
    answerCall: 'Ответить',
    attach: 'Прикрепить до 100 MB',
    avatar: 'Аватар',
    avatarFailed: 'Аватар не загружен',
    avatarReady: 'Аватар обновлен',
    avatarReadyMessage: 'Изображение профиля готово.',
    avatarUpload: 'Загрузить изображение',
    callFailed: 'Звонок не удался',
    calling: 'звоним',
    callStatus: 'Звонок',
    cancel: 'Отмена',
    chat: 'Чат',
    chooseRoom: 'Выберите или создайте комнату',
    closeChat: 'Закрыть чат',
    connected: 'соединение установлено',
    copyInvite: 'Скопировать приглашение',
    copyRoomId: 'Скопировать id комнаты',
    createAccount: 'Создать аккаунт',
    createEncryptedRoom: 'Создать защищенную комнату',
    createIdentity: 'Создать локальную личность',
    createIdentityIntro: 'Создайте локальную личность. Приватный ключ хранится только в этом браузере; сервер получает только публичные данные и зашифрованные сообщения.',
    createRoom: 'Создать комнату',
    declineCall: 'Отклонить',
    decryptedDownload: 'Скачать расшифрованный файл',
    displayName: 'Отображаемое имя',
    download: 'Скачать',
    downloadFailed: 'Не удалось скачать',
    encryptedBadge: 'клиентское шифрование',
    endCall: 'Завершить',
    file: 'Файл',
    fileTooLarge: 'Файл слишком большой',
    fileTooLargeMessage: 'Максимальный размер файла 100 MB.',
    identityCreated: 'Личность создана',
    identityCreatedMessage: 'Приватный ключ остается в этом браузере.',
    importInvite: 'Импорт приглашения',
    importedRoom: 'Импортированная комната',
    incomingCall: 'Входящий звонок',
    invite: 'Приглашение',
    inviteError: 'Ошибка приглашения',
    inviteImported: 'Приглашение импортировано',
    inviteImportedMessage: 'Секрет комнаты сохранен локально.',
    inviteSecretMissing: 'Секрет комнаты не найден в этом браузере. Откройте комнату через приглашение или введите секрет вручную.',
    joinRoom: 'Войти в защищенную комнату',
    language: 'Язык',
    lastSeen: 'был(а)',
    leaveChat: 'Покинуть чат',
    leaveChatConfirm: 'Вы точно хотите окончательно покинуть этот чат? Локальный секрет комнаты будет удален с этого устройства.',
    leaveFailed: 'Не удалось покинуть чат',
    liveDisconnected: 'Live-обновления отключены.',
    login: 'Войти',
    loginName: 'Логин',
    logout: 'Выйти',
    message: 'Сообщение',
    messagesEncrypted: 'Сообщения шифруются до выхода из браузера.',
    needAccount: 'Создать аккаунт?',
    noMessages: 'Сообщений пока нет.',
    noRooms: 'Комнат пока нет.',
    newMessage: 'Новое сообщение',
    offline: 'offline',
    online: 'online',
    password: 'Пароль',
    passwordHint: 'Пароль должен быть не короче 8 символов.',
    preview: 'Предпросмотр',
    previewFailed: 'Предпросмотр не удался',
    privateRoom: 'Личная комната',
    profile: 'Профиль',
    profileTitle: 'Профиль пользователя',
    publicKey: 'Публичный ключ',
    quietlineIntro: 'Войдите или создайте аккаунт. Ключи сообщений останутся в этом браузере.',
    roomError: 'Ошибка комнаты',
    roomName: 'Название комнаты',
    roomReady: 'Комната готова',
    roomReadyMessage: 'Передайте id комнаты и секрет по другому каналу.',
    roomSecret: 'Секрет комнаты',
    roomSecretDescription: 'Оставьте пустым, чтобы создать новый секрет.',
    roomSecretRequired: 'Нужен секрет комнаты',
    rooms: 'Комнаты',
    saveLocalThemeFailed: 'Тема изменена локально',
    saveLocalThemeFailedMessage: 'Не удалось сохранить тему в профиль.',
    send: 'Отправить',
    sendFailed: 'Не удалось отправить',
    sessionReady: 'Сессия готова.',
    sessionExpired: 'Сессия истекла',
    sessionExpiredMessage: 'Войдите заново, чтобы продолжить работу.',
    startCall: 'Позвонить',
    systemJoined: 'зашел(ла) в чат',
    systemLeft: 'покинул(а) чат',
    typing: 'печатает...',
    typeMessage: 'Введите защищенное сообщение',
    unableToDecrypt: 'Не удалось расшифровать с текущим секретом комнаты.',
    unlock: 'Открыть',
    unlockFirst: 'Сначала откройте комнату',
    uploadImage: 'Загрузить изображение',
    userId: 'User id',
    userJoined: 'Пользователь вошел в чат',
    userLeft: 'Пользователь вышел из чата',
    wsError: 'Ошибка WebSocket',
  },
  en: {
    account: 'Account',
    alreadyHaveAccount: 'Already have an account?',
    answerCall: 'Answer',
    attach: 'Attach up to 100 MB',
    avatar: 'Avatar',
    avatarFailed: 'Avatar failed',
    avatarReady: 'Avatar updated',
    avatarReadyMessage: 'Profile image is ready.',
    avatarUpload: 'Upload image',
    callFailed: 'Call failed',
    calling: 'calling',
    callStatus: 'Call',
    cancel: 'Cancel',
    chat: 'Chat',
    chooseRoom: 'Choose or create a room',
    closeChat: 'Close chat',
    connected: 'connected',
    copyInvite: 'Copy invite',
    copyRoomId: 'Copy room id',
    createAccount: 'Create account',
    createEncryptedRoom: 'Create protected room',
    createIdentity: 'Create local identity',
    createIdentityIntro: 'Create a local identity. The private key is stored only in this browser; the backend receives public identity data and encrypted payloads.',
    createRoom: 'Create room',
    declineCall: 'Decline',
    decryptedDownload: 'Download decrypted file',
    displayName: 'Display name',
    download: 'Download',
    downloadFailed: 'Download failed',
    encryptedBadge: 'client-side encrypted',
    endCall: 'End',
    file: 'File',
    fileTooLarge: 'File is too large',
    fileTooLargeMessage: 'Maximum file size is 100 MB.',
    identityCreated: 'Identity created',
    identityCreatedMessage: 'Private key stays in this browser.',
    importInvite: 'Import invite',
    importedRoom: 'Imported room',
    incomingCall: 'Incoming call',
    invite: 'Invite',
    inviteError: 'Invite error',
    inviteImported: 'Invite imported',
    inviteImportedMessage: 'Room secret saved locally.',
    inviteSecretMissing: 'Room secret is missing in this browser. Open the room from an invite or enter the secret manually.',
    joinRoom: 'Join protected room',
    language: 'Language',
    lastSeen: 'last seen',
    leaveChat: 'Leave chat',
    leaveChatConfirm: 'Are you sure you want to permanently leave this chat? The local room secret will be removed from this device.',
    leaveFailed: 'Could not leave chat',
    liveDisconnected: 'Live updates disconnected.',
    login: 'Login',
    loginName: 'Login',
    logout: 'Logout',
    message: 'Message',
    messagesEncrypted: 'Messages are encrypted before they leave the browser.',
    needAccount: 'Need an account?',
    noMessages: 'No messages yet.',
    noRooms: 'No rooms yet.',
    newMessage: 'New message',
    offline: 'offline',
    online: 'online',
    password: 'Password',
    passwordHint: 'Password must be at least 8 characters.',
    preview: 'Preview',
    previewFailed: 'Preview failed',
    privateRoom: 'Private room',
    profile: 'Profile',
    profileTitle: 'User profile',
    publicKey: 'Public key',
    quietlineIntro: 'Login or create an account. Your message keys still stay in this browser.',
    roomError: 'Room error',
    roomName: 'Room name',
    roomReady: 'Room ready',
    roomReadyMessage: 'Share the room id and secret out-of-band.',
    roomSecret: 'Room secret',
    roomSecretDescription: 'Leave empty to generate a new secret.',
    roomSecretRequired: 'Room secret required',
    rooms: 'Rooms',
    saveLocalThemeFailed: 'Theme was changed locally',
    saveLocalThemeFailedMessage: 'Could not save the theme to your profile.',
    send: 'Send',
    sendFailed: 'Send failed',
    sessionReady: 'Session is ready.',
    sessionExpired: 'Session expired',
    sessionExpiredMessage: 'Login again to continue.',
    startCall: 'Call',
    systemJoined: 'joined the chat',
    systemLeft: 'left the chat',
    typing: 'is typing...',
    typeMessage: 'Type protected message',
    unableToDecrypt: 'Unable to decrypt with current room secret.',
    unlock: 'Unlock',
    unlockFirst: 'Unlock room first',
    uploadImage: 'Upload image',
    userId: 'User id',
    userJoined: 'User joined the chat',
    userLeft: 'User left the chat',
    wsError: 'WebSocket error',
  },
} as const

type MessageKey = keyof typeof dictionary.ru

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ru')

  useEffect(() => {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved === 'ru' || saved === 'en') {
      setLocaleState(saved)
      return
    }
    const browserLocale = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'
    setLocaleState(browserLocale)
  }, [])

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale: (next) => {
      localStorage.setItem(LOCALE_KEY, next)
      setLocaleState(next)
    },
    t: (key) => dictionary[locale][key],
  }), [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const value = useContext(I18nContext)
  if (!value) throw new Error('I18nProvider is missing')
  return value
}
