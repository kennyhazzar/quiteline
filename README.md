# Quietline

Quietline is a private messenger pet project that grew out of a high-load WebSocket pub/sub server idea. It is now a full-stack chat application with accounts, contacts, chats, attachments, push notifications, sessions, 2FA, and a responsive PWA frontend.

The stack is intentionally practical: Go on the backend, Next.js on the frontend, PostgreSQL/Redis/S3 for state, and Docker Compose for local and production deployment.

## Features

- Username/password registration and login.
- Short-lived access tokens with refresh sessions stored in HttpOnly cookies.
- Session management with device list and revoke actions.
- TOTP 2FA with QR setup.
- Contacts with invite codes and in-app QR scanning.
- Chats with realtime WebSocket updates.
- Replies, reactions, message editing, deletion, read states, unread counters, and message links.
- Attachments up to 100 MiB with S3-compatible storage.
- Image viewer and file downloads.
- User avatars with client-side compression before upload.
- Browser push notifications through VAPID.
- Online presence, typing status, last seen, and WebRTC audio calls with TURN support.
- RU/EN UI, light/dark themes, and responsive mobile/tablet/desktop layout.

## Stack

| Layer | Technology |
| --- | --- |
| Backend | Go, `net/http`, Gorilla WebSocket |
| API | REST + WebSocket |
| Database | PostgreSQL |
| Realtime fanout | Redis Pub/Sub |
| Files | S3-compatible storage, MinIO locally |
| Calls | WebRTC audio + coturn TURN relay |
| Frontend | Next.js 15, React 18, Mantine 7, TanStack Query |
| PWA | Web App Manifest, Service Worker, Web Push |
| Crypto | Web Crypto API for client-side message/file encryption |
| Reverse proxy | Caddy in production compose |

## Architecture

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
  +-- coturn: TURN relay for WebRTC calls across NAT/mobile networks
```

The backend can be scaled horizontally. Each Go process keeps only its own local WebSocket clients; Redis distributes events between backend instances.

## Security Model

Quietline already includes several practical security choices:

- Passwords are stored as bcrypt hashes.
- Refresh tokens are stored in HttpOnly cookies.
- Access tokens are short-lived and refreshed through the session flow.
- TOTP 2FA is supported.
- CORS origins are explicit.
- Upload size is limited.
- Redis password is supported.
- Production secrets are configured through env files.
- Next.js telemetry is disabled.

Messages and files are encrypted in the browser before upload. Quietline is still not a Signal-grade E2EE protocol: production-grade E2EE would require multi-device key management, device verification, recovery flows, and a ratcheting protocol.

## Repository Layout

```text
cmd/server       Go API/WebSocket server
cmd/loadgen      WebSocket/pub-sub load generator
cmd/vapid        VAPID key generator
internal/api     HTTP routes, auth middleware, REST handlers
internal/auth    accounts, sessions, tokens
internal/zk      chat/domain storage layer; historical package name
internal/ws      WebSocket hub
internal/files   S3/MinIO file storage
frontend         Next.js application
deploy/caddy     production Caddy config
deploy/nginx     older nginx examples
```

## Local Development

### Requirements

- Go 1.25+
- Node.js 20+
- Docker Desktop or Docker Engine

### Full Stack With Docker Compose

Copy the local env template if you want to override defaults:

```powershell
cp .env.example .env
```

Generate VAPID keys if you want to test browser push notifications:

```powershell
go run ./cmd/vapid
```

Put the generated keys into `.env`:

```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

Start the stack:

```powershell
docker compose up --build
```

Local URLs:

| Service | URL |
| --- | --- |
| Frontend | `http://localhost:3000` |
| Backend API | `http://localhost:18080` |
| MinIO Console | `http://localhost:19001` |
| MinIO API | `http://localhost:19000` |
| Postgres | `localhost:5432` |
| Redis | `localhost:6380` |
| TURN | `localhost:3478` |

Default local MinIO login:

```text
minioadmin / minioadmin
```

### Backend Only

Quick backend-only mode without PostgreSQL/Redis durability:

```powershell
$env:BROKER="memory"
$env:POSTGRES_DSN=""
$env:AUTH_ENABLED="false"
go run ./cmd/server
```

For normal development, Docker Compose is preferred because it provides Postgres, Redis, and MinIO.

### Frontend Only

```powershell
cd frontend
npm install
npm run dev
```

The frontend expects:

```env
NEXT_PUBLIC_API_URL=http://localhost:18080
NEXT_PUBLIC_WS_URL=ws://localhost:18080
```

## Production Deployment

The recommended VPS setup is Docker Compose + Caddy.

Current project domain:

```text
chat.2vault.site
```

The production compose file includes:

- PostgreSQL
- Redis with password
- MinIO
- Go backend
- Next.js frontend
- coturn for WebRTC calls
- Caddy with automatic TLS

Quick path:

```bash
git clone git@github.com:kennyhazzar/quiteline.git /opt/quietline
cd /opt/quietline
cp .env.prod.example .env.prod
nano .env.prod
APP_ENV_FILE=.env.prod docker compose -f docker-compose.deploy.yml --env-file .env.prod up -d --build
```

Detailed guides:

- [DEPLOY_COMPOSE_CADDY.md](DEPLOY_COMPOSE_CADDY.md)
- [DEPLOY_CHAT_2VAULT.md](DEPLOY_CHAT_2VAULT.md)
- [DEPLOY_DOKPLOY.md](DEPLOY_DOKPLOY.md)

## Environment Variables

Backend:

| Variable | Description |
| --- | --- |
| `HTTP_ADDR` | Backend listen address, usually `:8080` |
| `AUTH_ENABLED` | Enables account auth |
| `AUTH_SECRET` | HMAC secret for access tokens |
| `AUTH_TOKEN_TTL` | Access token lifetime, for example `15m` |
| `AUTH_REFRESH_TTL` | Refresh session lifetime, for example `2160h` |
| `API_KEYS` | Optional service API keys |
| `POSTGRES_DSN` | PostgreSQL connection string |
| `BROKER` | `redis` or `memory` |
| `REDIS_ADDR` | Redis address |
| `REDIS_PASSWORD` | Redis password |
| `REDIS_DB` | Redis DB number |
| `REDIS_CHANNEL_PREFIX` | Pub/Sub namespace |
| `CORS_ALLOWED_ORIGINS` | Allowed browser origins |
| `S3_ENDPOINT` | S3/MinIO endpoint |
| `S3_ACCESS_KEY` | S3 access key |
| `S3_SECRET_KEY` | S3 secret key |
| `S3_BUCKET` | Bucket for avatars and attachments |
| `S3_USE_SSL` | Use HTTPS for S3 |
| `MAX_FILE_BYTES` | Maximum encrypted upload size |
| `VAPID_PUBLIC_KEY` | Web Push public key |
| `VAPID_PRIVATE_KEY` | Web Push private key |
| `VAPID_SUBJECT` | Web Push subject, usually `mailto:...` |
| `TURN_URLS` | Comma-separated TURN URLs returned to the frontend |
| `TURN_EXTERNAL_IP` | Public VPS IP advertised by coturn when running behind Docker NAT |
| `TURN_USERNAME` | TURN long-term credential username |
| `TURN_CREDENTIAL` | TURN long-term credential password |
| `TURN_REALM` | coturn realm/server name in Docker Compose |

Frontend:

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Public API URL used by the browser |
| `NEXT_PUBLIC_WS_URL` | Public WebSocket URL used by the browser |
| `NEXT_TELEMETRY_DISABLED` | Keep as `1` |

## Useful Commands

Build frontend:

```powershell
cd frontend
npm run build
```

Run Go tests:

```powershell
go test ./...
```

Generate VAPID keys:

```powershell
go run ./cmd/vapid
```

Validate production compose config:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.deploy.yml --env-file .env.prod config
```

View backend logs:

```bash
docker logs -f quietline-backend-1
```

Container names can differ depending on the Compose project name. Use `docker ps` when in doubt.

## Main API Surface

The frontend mostly uses these endpoints:

| Area | Endpoints |
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
| Calls | `GET /v1/calls/ice-servers` |
| Realtime | `GET /ws?topics=user:{userId},room:{roomId}` |

Older `/v1/zk/...` paths remain as compatibility aliases, but new code and docs should use `/v1/chat/...` and `/v1/chats/...`.

## Current Focus

Quietline is still evolving. The current focus is making it feel like a normal messenger:

- less polling, more WebSocket-driven updates;
- more stable mobile and desktop UX;
- fewer internal identifiers in the UI;
- more skeleton/loading states instead of layout jumps;
- cleaner profile, contacts, and notification flows;
- simpler and more reliable production deployment.

Good next technical steps:

- Add integration tests for auth/session refresh and realtime chat events.
- Add Playwright smoke tests for login, chat creation, messaging, and attachments.
- Move more list updates to WebSocket invalidation.
- Improve E2EE/key management if the project moves beyond pet-project scope.
