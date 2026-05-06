# Frontend Refactor Plan

## Проблема

`src/app/page.tsx` — 2933 строки, один монолитный компонент.
Роутинг (`chats/`, `profile/`) создан, но все страницы просто ре-экспортируют `MessengerPage`.

---

## Целевая структура

```
src/
├── app/
│   ├── layout.tsx
│   ├── providers.tsx
│   ├── chats/
│   │   ├── page.tsx              ← список чатов (пустое состояние)
│   │   └── [chatId]/
│   │       ├── page.tsx          ← открытый чат
│   │       └── messages/
│   │           └── [messageId]/
│   │               └── page.tsx  ← чат + подсветка сообщения
│   └── profile/
│       └── page.tsx              ← профиль, сессии, 2FA
│
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx          ← sidebar + main, адаптив mobile/desktop
│   │   └── Sidebar.tsx           ← список чатов, поиск, кнопки
│   ├── chat/
│   │   ├── ChatView.tsx          ← область сообщений + input
│   │   ├── MessageList.tsx       ← scroll, highlight, виртуализация (будущее)
│   │   ├── MessageBubble.tsx     ← одно сообщение + реакции + меню
│   │   └── MessageInput.tsx      ← поле ввода, аттачи, emoji
│   ├── profile/
│   │   ├── ProfileView.tsx       ← аватар, тема, язык
│   │   ├── SessionsPanel.tsx     ← список сессий, отзыв
│   │   └── TwoFactorPanel.tsx    ← TOTP setup/disable
│   └── friends/
│       └── FriendsPanel.tsx      ← список друзей, запросы, поиск
│
├── hooks/
│   ├── useWebSocket.ts           ← WS-соединение, реконнект, диспатч событий
│   ├── useRooms.ts               ← React Query: список комнат, создание, уход
│   ├── useMessages.ts            ← React Query: сообщения + шифрование/расшифровка
│   ├── useIdentity.ts            ← текущий пользователь + identity
│   └── useFriends.ts             ← список друзей, запросы
│
└── lib/                          ← без изменений
    ├── api.ts
    ├── crypto.ts
    ├── i18n.tsx
    └── avatar.ts
```

---

## Этапы

### Этап 1 — Хуки (без изменения UI)
Вытащить логику из `page.tsx` в отдельные хуки. UI не меняется, рефакторинг чистый.

- `useWebSocket` — подключение, реконнект, обработка входящих событий
- `useRooms` — React Query обёртки для комнат
- `useMessages` — сообщения + crypto.ts интеграция
- `useIdentity` — сессия, principal, identity
- `useFriends` — друзья и запросы

### Этап 2 — Компоненты нижнего уровня
Вытащить атомарные компоненты, которые не несут состояния:

- `MessageBubble` — рендер одного сообщения, реакции, меню
- `MessageInput` — поле ввода
- `MessageList` — список + scroll + highlight

### Этап 3 — Компоненты верхнего уровня
Собрать из хуков + атомарных компонентов:

- `ChatView` — использует `useMessages`, рендерит `MessageList` + `MessageInput`
- `Sidebar` — использует `useRooms`, `useFriends`
- `ProfileView`, `SessionsPanel`, `TwoFactorPanel`
- `FriendsPanel`

### Этап 4 — Подключить роутинг
Каждая страница в `app/` получает свой настоящий компонент вместо ре-экспорта `MessengerPage`:

- `app/chats/page.tsx` → `<AppShell><Sidebar /></AppShell>`
- `app/chats/[chatId]/page.tsx` → `<AppShell><Sidebar /><ChatView /></AppShell>`
- `app/profile/page.tsx` → `<AppShell><Sidebar /><ProfileView /></AppShell>`

### Этап 5 — Удалить page.tsx
После переноса всего — `src/app/page.tsx` редиректит на `/chats` и больше ничего не делает.

---

## Примечания

- **State management**: пока без Zustand/Redux — React Query + контекст сессии достаточно.
- **Виртуализация списка сообщений**: не в этом рефакторе, но `MessageList` нужно делать так, чтобы её можно было добавить позже.
- **fileRegistry на бэке**: при загрузке файлов клиент теперь обязан передавать `roomId` — фронтенд нужно обновить при работе с upload/download.
- **Тесты**: добавлять по мере выделения хуков — хуки тестируются значительно проще монолита.
