# Quietline

Quietline — приватный мессенджер-петпроект, который вырос из идеи high-load WebSocket pub/sub сервера. Сейчас это полноценное full-stack приложение с аккаунтами, контактами, чатами, вложениями, push-уведомлениями, сессиями, 2FA и адаптивным PWA-интерфейсом.

Проект сделан как практичный инженерный стенд: Go на бекенде, Next.js на фронтенде, PostgreSQL/Redis/S3 для состояния и Docker Compose для локального и серверного запуска.

## Возможности

- Регистрация и вход по логину/паролю.
- Короткоживущий access token и refresh-сессии в HttpOnly cookie.
- Управление сессиями: просмотр устройств, выход, отзыв других сессий.
- TOTP 2FA с QR-кодом.
- Контакты, invite-коды и QR-сканирование.
- Чаты с realtime-обновлениями через WebSocket.
- Ответы на сообщения, реакции, редактирование, удаление, статусы прочтения, счетчики непрочитанного и ссылки на сообщения.
- Вложения до 100 MiB, хранение через S3-compatible storage.
- Просмотр изображений, скачивание файлов.
- Аватары пользователей со сжатием на фронтенде перед загрузкой.
- Browser push notifications через VAPID.
- Online/presence, typing status, last seen и базовый WebRTC signaling для звонков.
- RU/EN интерфейс, светлая/темная тема, мобильная/планшетная/десктопная верстка.

## Стек

| Слой | Технологии |
| --- | --- |
| Backend | Go, `net/http`, Gorilla WebSocket |
| API | REST + WebSocket |
| База данных | PostgreSQL |
| Realtime fanout | Redis Pub/Sub |
| Файлы | S3-compatible storage, локально MinIO |
| Frontend | Next.js 15, React 18, Mantine 7, TanStack Query |
| PWA | Web App Manifest, Service Worker, Web Push |
| Crypto | Web Crypto API для клиентского шифрования сообщений и файлов |
| Reverse proxy | Caddy в production compose |

## Архитектура

```text
Browser / PWA
  |
  | REST: auth, profile, chats, contacts, files
  | WS: chat events, read states, presence, sessions, notifications
  v
Go backend
  |
  +-- PostgreSQL: users, sessions, chats, messages, contacts, push subscriptions
  +-- Redis: cross-instance realtime fanout
  +-- S3/MinIO: avatars and attachments
```

Бекенд можно масштабировать горизонтально: каждый Go-процесс держит только свои локальные WebSocket-подключения, а Redis разносит события между инстансами.

## Модель безопасности

В проекте уже есть несколько практичных security-решений:

- Пароли хранятся bcrypt-хешами.
- Refresh token хранится в HttpOnly cookie.
- Access token живет недолго и обновляется через refresh flow.
- Есть TOTP 2FA.
- CORS задается явно.
- Размер загрузки файлов ограничен.
- Redis поддерживает пароль.
- Production-секреты выносятся в env.
- Next.js telemetry отключена.

Сообщения и файлы шифруются в браузере перед отправкой. При этом Quietline пока не является Signal-grade E2EE системой. Для настоящего production E2EE нужно отдельно проектировать multi-device key management, device verification, recovery flow и ratcheting-протокол.

## Структура Репозитория

```text
cmd/server       Go API/WebSocket server
cmd/loadgen      генератор нагрузки для WebSocket/pub-sub
cmd/vapid        генератор VAPID-ключей
internal/api     HTTP routes, auth middleware, REST handlers
internal/auth    аккаунты, сессии, токены
internal/zk      доменная storage-логика чатов, историческое имя пакета
internal/ws      WebSocket hub
internal/files   S3/MinIO file storage
frontend         Next.js приложение
deploy/caddy     production Caddy config
deploy/nginx     старые nginx-примеры
```

## Локальный Запуск

### Требования

- Go 1.25+
- Node.js 20+
- Docker Desktop или Docker Engine

### Полный Стек Через Docker Compose

1. При необходимости скопировать локальный env-шаблон:

```powershell
cp .env.example .env
```

2. Если нужно тестировать push-уведомления, сгенерировать VAPID-ключи:

```powershell
go run ./cmd/vapid
```

И положить ключи в `.env`:

```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

3. Запустить весь стек:

```powershell
docker compose up --build
```

Локальные адреса:

| Сервис | URL |
| --- | --- |
| Frontend | `http://localhost:3000` |
| Backend API | `http://localhost:18080` |
| MinIO Console | `http://localhost:19001` |
| MinIO API | `http://localhost:19000` |
| Postgres | `localhost:5432` |
| Redis | `localhost:6380` |

Логин MinIO по умолчанию:

```text
minioadmin / minioadmin
```

### Запуск Бекенда Вручную

Быстрый режим без PostgreSQL/Redis durability:

```powershell
$env:BROKER="memory"
$env:POSTGRES_DSN=""
$env:AUTH_ENABLED="false"
go run ./cmd/server
```

Для обычной разработки удобнее Docker Compose: он сразу поднимает Postgres, Redis и MinIO.

### Запуск Фронтенда Вручную

```powershell
cd frontend
npm install
npm run dev
```

Фронтенд ожидает:

```env
NEXT_PUBLIC_API_URL=http://localhost:18080
NEXT_PUBLIC_WS_URL=ws://localhost:18080
```

## Production Deploy

Основной рекомендуемый вариант для VPS — Docker Compose + Caddy.

Текущие домены проекта:

```text
chat.2vault.site
```

Production compose поднимает:

- PostgreSQL
- Redis с паролем
- MinIO
- Go backend
- Next.js frontend
- Caddy с автоматическим TLS

Короткий путь:

```bash
git clone git@github.com:kennyhazzar/quiteline.git /opt/quietline
cd /opt/quietline
cp .env.prod.example .env.prod
nano .env.prod
APP_ENV_FILE=.env.prod docker compose -f docker-compose.deploy.yml --env-file .env.prod up -d --build
```

Подробные гайды:

- [DEPLOY_COMPOSE_CADDY.md](DEPLOY_COMPOSE_CADDY.md)
- [DEPLOY_CHAT_2VAULT.md](DEPLOY_CHAT_2VAULT.md)
- [DEPLOY_DOKPLOY.md](DEPLOY_DOKPLOY.md)

## Env-Переменные

Backend:

| Переменная | Описание |
| --- | --- |
| `HTTP_ADDR` | Адрес прослушивания бекенда, обычно `:8080` |
| `AUTH_ENABLED` | Включает account auth |
| `AUTH_SECRET` | HMAC secret для access tokens |
| `AUTH_TOKEN_TTL` | Время жизни access token, например `15m` |
| `AUTH_REFRESH_TTL` | Время жизни refresh-сессии, например `2160h` |
| `API_KEYS` | Опциональные service API keys |
| `POSTGRES_DSN` | Строка подключения к PostgreSQL |
| `BROKER` | `redis` или `memory` |
| `REDIS_ADDR` | Адрес Redis |
| `REDIS_PASSWORD` | Пароль Redis |
| `REDIS_DB` | Номер Redis DB |
| `REDIS_CHANNEL_PREFIX` | Namespace для Pub/Sub |
| `CORS_ALLOWED_ORIGINS` | Разрешенные browser origins |
| `S3_ENDPOINT` | S3/MinIO endpoint |
| `S3_ACCESS_KEY` | S3 access key |
| `S3_SECRET_KEY` | S3 secret key |
| `S3_BUCKET` | Bucket для аватаров и вложений |
| `S3_USE_SSL` | Использовать HTTPS для S3 |
| `MAX_FILE_BYTES` | Максимальный размер encrypted upload |
| `VAPID_PUBLIC_KEY` | Public key для Web Push |
| `VAPID_PRIVATE_KEY` | Private key для Web Push |
| `VAPID_SUBJECT` | Subject для Web Push, обычно `mailto:...` |

Frontend:

| Переменная | Описание |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Public API URL для браузера |
| `NEXT_PUBLIC_WS_URL` | Public WebSocket URL для браузера |
| `NEXT_TELEMETRY_DISABLED` | Оставить `1` |

## Полезные Команды

Сборка фронтенда:

```powershell
cd frontend
npm run build
```

Go-тесты:

```powershell
go test ./...
```

Генерация VAPID-ключей:

```powershell
go run ./cmd/vapid
```

Проверка production compose:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.deploy.yml --env-file .env.prod config
```

Логи бекенда:

```bash
docker logs -f quietline-backend-1
```

Имя контейнера может отличаться из-за имени compose-проекта. Если команда не сработала, проверьте `docker ps`.

## Основные API

Фронтенд в основном использует эти endpoints:

| Область | Endpoints |
| --- | --- |
| Auth | `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout` |
| Profile | `GET /v1/me`, `PUT /v1/me/theme`, `PUT /v1/me/avatar` |
| 2FA | `POST /v1/me/2fa/setup`, `POST /v1/me/2fa/confirm`, `DELETE /v1/me/2fa` |
| Sessions | `GET /v1/me/sessions`, `DELETE /v1/me/sessions/{id}`, `DELETE /v1/me/sessions/others` |
| Push | `GET /v1/me/push-public-key`, `GET/POST /v1/me/push-subscriptions` |
| Contacts | `GET /v1/chat/friends`, `POST /v1/chat/friends`, `POST /v1/chat/friends/{id}` |
| Chats | `GET /v1/chats`, `POST /v1/chats`, `GET /v1/chats/{id}` |
| Messages | `GET /v1/chats/{id}/messages`, `POST /v1/chats/{id}/messages`, `PUT /v1/chats/{id}/messages/{messageId}` |
| Read states | `POST /v1/chats/{id}/read` |
| Reactions | `POST /v1/chats/{id}/messages/{messageId}/reactions` |
| Attachments | `GET /v1/chats/{id}/attachments`, `POST /v1/chat/files`, `GET /v1/chat/files/{fileId}` |
| Realtime | `GET /ws?topics=user:{userId},room:{roomId}` |

Старые `/v1/zk/...` paths остаются compatibility aliases, но новый код и документацию лучше вести через `/v1/chat/...` и `/v1/chats/...`.

## Текущий Фокус

Quietline еще развивается. Сейчас основные направления:

- меньше polling, больше WebSocket-driven updates;
- более стабильный UX на мобильных и десктопе;
- меньше отображения внутренних identifiers;
- больше skeleton/loading states вместо прыжков верстки;
- аккуратнее профиль, контакты и уведомления;
- проще и надежнее production deploy.

Хорошие следующие технические шаги:

- Интеграционные тесты для auth/session refresh и realtime chat events.
- Playwright smoke tests для login, создания чата, сообщений и вложений.
- Полнее перевести обновления списков на WebSocket invalidation.
- Улучшить E2EE/key management, если проект выйдет за рамки pet-project.
