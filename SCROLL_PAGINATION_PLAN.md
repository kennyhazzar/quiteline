# Plan: scroll-to-bottom button + pagination

---

## 1. Кнопка «вниз» + счётчик непрочитанных

**Сложность:** низкая. Чисто фронтенд, ~1-2 часа.  
**Файлы:** `frontend/src/components/chat/ChatView.tsx`, `frontend/src/components/MessengerApp.tsx`

### Что нужно сделать

#### ChatView.tsx

1. Добавить локальный стейт:
   ```ts
   const [unreadCount, setUnreadCount] = useState(0)
   const [showScrollBtn, setShowScrollBtn] = useState(false)
   const isNearBottomRef = useRef(true)
   const prevLengthRef = useRef(0)
   ```

2. Слушать скролл через `onScrollPositionChange` на `<ScrollArea>`:
   ```tsx
   onScrollPositionChange={({ y }) => {
     const el = messagesViewportRef.current
     if (!el) return
     const atBottom = el.scrollHeight - y - el.clientHeight < 80
     isNearBottomRef.current = atBottom
     setShowScrollBtn(!atBottom)
     if (atBottom) setUnreadCount(0)
   }}
   ```

3. При изменении `visibleMessages.length` — автоскролл если уже внизу, иначе инкрементировать счётчик:
   ```ts
   useEffect(() => {
     const diff = visibleMessages.length - prevLengthRef.current
     prevLengthRef.current = visibleMessages.length
     if (diff <= 0) return
     if (isNearBottomRef.current) {
       messagesViewportRef.current?.scrollTo({ top: 999999 })
     } else {
       setUnreadCount(c => c + diff)
     }
   }, [visibleMessages.length])
   ```
   > Счётчик учитывает только входящие сообщения пока юзер наверху.
   > При смене комнаты счётчик сбрасывается (activeRoomID меняется).

4. Кнопка — поверх ScrollArea (абсолютное позиционирование, z-index):
   ```tsx
   {showScrollBtn && (
     <Box style={{ position: 'absolute', bottom: 70, right: 16, zIndex: 10 }}>
       <Indicator label={unreadCount || undefined} size={18} disabled={!unreadCount}>
         <ActionIcon
           radius="xl"
           size="lg"
           variant="filled"
           onClick={() => {
             messagesViewportRef.current?.scrollTo({ top: 999999, behavior: 'smooth' })
             setUnreadCount(0)
           }}
         >
           <IconChevronDown size={20} />
         </ActionIcon>
       </Indicator>
     </Box>
   )}
   ```
   Нужен `position: relative` на обёртке `<Box>` вокруг `<ScrollArea>`.

5. Сброс при смене комнаты:
   ```ts
   useEffect(() => {
     setUnreadCount(0)
     setShowScrollBtn(false)
     isNearBottomRef.current = true
   }, [activeRoomID])
   ```

#### MessengerApp.tsx

Убрать из зависимостей `messages.displayMessages.length` в useEffect автоскролла —
оставить только `activeRoomID` (скролл вниз при открытии комнаты):
```ts
// было:
}, [activeRoomID, messages.displayMessages.length, highlightedMessageID])
// стало:
}, [activeRoomID, highlightedMessageID])
```
Логика «автоскролл при новом сообщении если уже внизу» переезжает в ChatView (п. 3 выше).

---

## 2. Пагинация сообщений

**Сложность:** средняя. Backend + frontend, ~2-3 часа.  
**Файлы:** `internal/zk/store.go`, `internal/zk/postgres.go`, `internal/api/router.go`, `frontend/src/lib/api.ts`, `frontend/src/hooks/useMessages.ts`, `frontend/src/components/chat/ChatView.tsx`

### Backend

#### `internal/zk/store.go` — интерфейс
```go
// Добавить параметр before
ListMessages(ctx context.Context, roomID string, limit int, before *time.Time) ([]EncryptedMessage, error)
```

#### `internal/zk/postgres.go` — PostgresStore
Построить запрос в зависимости от наличия `before`:
```go
// Cursor-based: WHERE room_id = $1 AND created_at < $3 ORDER BY created_at DESC LIMIT $2
// Начало: WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2
```
Использовать `fmt.Sprintf` для подстановки опциональной части.

#### `internal/zk/store.go` — MemoryStore
Фильтровать срез до индекса, где `CreatedAt < *before`, затем брать последние `limit`.

#### `internal/api/router.go` — handler
```go
func handleListEncryptedMessages(...) {
    // парсим ?before=<RFC3339>
    var before *time.Time
    if raw := r.URL.Query().Get("before"); raw != "" {
        if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
            before = &t
        }
    }
    const pageSize = 50
    messages, err := deps.ZKStore.ListMessages(r.Context(), roomID, pageSize, before)
    // ...
    // добавить hasMore: len(messages) == pageSize
    writeJSON(w, http.StatusOK, map[string]any{
        "messages": messages,
        "hasMore":  len(messages) == pageSize,
    })
}
```

### Frontend

#### `frontend/src/lib/api.ts`
```ts
export async function fetchMessages(
  roomId: string,
  token: string,
  before?: string,   // ISO timestamp самого старого загруженного сообщения
): Promise<{ messages: EncryptedMessage[]; hasMore: boolean }> {
  const url = new URL(`${BASE}/v1/chat/rooms/${encodeURIComponent(roomId)}/messages`)
  if (before) url.searchParams.set('before', before)
  const res = await fetch(url, { headers: authHeaders(token) })
  return readJSON(res)
}
```

#### `frontend/src/hooks/useMessages.ts`
Заменить `useQuery` на ручное управление страницами:
```ts
const [olderMessages, setOlderMessages] = useState<EncryptedMessage[]>([])
const [hasMore, setHasMore] = useState(false)
const [isLoadingMore, setIsLoadingMore] = useState(false)

// history useQuery остаётся — грузит последние 50
// olderMessages добавляются prepend при нажатии "Load earlier"

async function loadMore() {
  if (!session || !activeRoomID || isLoadingMore || !hasMore) return
  const cursor = history.data?.messages[0]?.createdAt  // самое раннее из текущих
  setIsLoadingMore(true)
  try {
    const res = await fetchMessages(activeRoomID, session.accessToken, cursor)
    setOlderMessages(prev => [...res.messages, ...prev])
    setHasMore(res.hasMore)
  } finally {
    setIsLoadingMore(false)
  }
}
```

Объединять `olderMessages + encryptedMessages` в `encryptedMessages` useMemo.

#### `frontend/src/components/chat/ChatView.tsx`
Кнопка «Load earlier» вверху скролл-области:
```tsx
{hasMore && (
  <Button
    variant="subtle"
    size="xs"
    loading={isLoadingMore}
    onClick={loadMore}
    fullWidth
  >
    Load earlier messages
  </Button>
)}
```
При нажатии — фиксировать `scrollHeight` до загрузки, после загрузки восстанавливать позицию:
```ts
// чтобы скролл не прыгал вверх
const prevScrollHeight = el.scrollHeight
await loadMore()
el.scrollTop += el.scrollHeight - prevScrollHeight
```

### Порядок реализации

1. Backend: интерфейс → postgres → memory → router — всё компилируется, `go build -buildvcs=false ./...`
2. Frontend api.ts: добавить `before` параметр и обновить тип ответа
3. Frontend useMessages.ts: добавить `olderMessages` стейт и `loadMore`
4. Frontend ChatView.tsx: кнопка "load earlier" + сохранение позиции скролла
5. Тест: открыть чат с >50 сообщениями, нажать кнопку, убедиться что скролл не прыгает

---

## Итог трудоёмкости

| Задача | Backend | Frontend | Итого |
|---|---|---|---|
| Кнопка вниз + счётчик | — | ~1 ч | ~1 ч |
| Пагинация | ~1.5 ч | ~1.5 ч | ~3 ч |
