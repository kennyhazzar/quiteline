# Deploy Quietline with Dokploy

Target domains:

- Dokploy panel: `https://infra.2vault.site`
- App frontend/API: `https://chat.2vault.site`

This guide assumes a fresh VPS for Dokploy where ports `80`, `443`, and `3000` are available during installation.

Quietline services:

- PostgreSQL
- Redis
- S3-compatible storage, for example MinIO
- Go backend from root `Dockerfile`
- Next.js frontend from `frontend/Dockerfile`

## 0. Install Dokploy on infra.2vault.site

Point DNS first:

```text
infra.2vault.site -> DOKPLOY_SERVER_IP
chat.2vault.site -> DOKPLOY_SERVER_IP
```

On the Dokploy server:

```bash
apt update
apt install -y curl ca-certificates git
curl -sSL https://dokploy.com/install.sh | sh
```

Open the initial Dokploy panel:

```text
http://DOKPLOY_SERVER_IP:3000
```

Create the admin account.

Then in Dokploy UI:

1. Go to Dokploy settings/domains.
2. Add `infra.2vault.site`.
3. Enable Let's Encrypt/SSL.
4. After HTTPS works, optionally disable direct `IP:3000` access.

## 1. Create a project

In Dokploy:

1. Create Project: `quietline`
2. Create Environment: `production`

Use one Git repository for both apps:

```text
git@github.com:kennyhazzar/quiteline.git
```

## 2. Create databases/services

### PostgreSQL

Create PostgreSQL in Dokploy:

```text
Name: quietline-postgres
Database: quietline
User: quietline
Password: generate strong password
```

Save the internal connection string. It should look like:

```text
postgres://quietline:PASSWORD@quietline-postgres:5432/quietline?sslmode=disable
```

If Dokploy gives another internal hostname, use that hostname in `POSTGRES_DSN`.

### Redis

Create Redis in Dokploy:

```text
Name: quietline-redis
Password: optional, but recommended if Dokploy exposes this setting
```

Internal address:

```text
quietline-redis:6379
```

If Dokploy gives another internal hostname, use it in `REDIS_ADDR`.
If Dokploy generates a Redis password, put it into `REDIS_PASSWORD`.

### S3 / MinIO

Quietline needs S3-compatible storage for encrypted files and avatars.

Option A, recommended inside Dokploy: create a MinIO compose service from the Dokploy template.

```text
Service name in compose: minio
Root user: quietline
Root password: generate strong password
Bucket used by backend: quietline
Internal endpoint for backend: minio:9000
```

Use this MinIO environment in the Dokploy compose template:

```env
MINIO_ROOT_USER=quietline
MINIO_ROOT_PASSWORD=CHANGE_ME_MINIO_PASSWORD
MINIO_BROWSER_REDIRECT_URL=https://minio.2vault.site
```

If you expose the MinIO console, use a separate domain like `minio.2vault.site` for port `9001`.
The backend must use the API port `9000`, not the console port.

Option B: use external S3. Then set `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, and `S3_USE_SSL=true` according to the provider.

## 3. Backend application

Create Application:

```text
Name: quietline-backend
Provider: GitHub / Git repository
Repository: git@github.com:kennyhazzar/quiteline.git
Branch: master
Build type: Dockerfile
Dockerfile path: Dockerfile
Context path: .
Internal port: 8080
```

Domain:

```text
chat.2vault.site
```

Route all backend paths through the same domain:

```text
/v1
/ws
/healthz
/metrics optional
```

If Dokploy asks for only one domain per app and cannot split paths, create the backend on a subdomain instead:

```text
api.chat.2vault.site
```

Then use:

```env
NEXT_PUBLIC_API_URL=https://api.chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://api.chat.2vault.site
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
```

Preferred setup is path-based routing on `chat.2vault.site`.

### Backend environment variables

Paste this into backend Environment:

```env
HTTP_ADDR=:8080
NODE_ID=quietline-backend

AUTH_ENABLED=true
AUTH_SECRET=CHANGE_ME_LONG_RANDOM_SECRET
API_KEYS=frontend:CHANGE_ME_SERVICE_SECRET

POSTGRES_DSN=postgres://quietline:CHANGE_ME_POSTGRES_PASSWORD@quietline-postgres:5432/quietline?sslmode=disable

BROKER=redis
REDIS_ADDR=quietline-redis:6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_CHANNEL_PREFIX=quietline

CORS_ALLOWED_ORIGINS=https://chat.2vault.site

S3_ENDPOINT=minio:9000
S3_ACCESS_KEY=quietline
S3_SECRET_KEY=CHANGE_ME_MINIO_PASSWORD
S3_BUCKET=quietline
S3_USE_SSL=false

MAX_FILE_BYTES=104861696
WS_CLIENT_BUFFER=256
WS_MAX_MESSAGE_BYTES=65536
```

Replace:

- `CHANGE_ME_LONG_RANDOM_SECRET`
- `CHANGE_ME_SERVICE_SECRET`
- `CHANGE_ME_POSTGRES_PASSWORD`
- `CHANGE_ME_MINIO_PASSWORD`
- hostnames if Dokploy generated different service names

If you renamed the MinIO compose service, update `S3_ENDPOINT` accordingly:

```env
S3_ENDPOINT=YOUR_MINIO_SERVICE_NAME:9000
```

## 4. Frontend application

Create Application:

```text
Name: quietline-frontend
Provider: GitHub / Git repository
Repository: git@github.com:kennyhazzar/quiteline.git
Branch: master
Build type: Dockerfile
Dockerfile path: frontend/Dockerfile
Context path: frontend
Internal port: 3000
```

Domain:

```text
chat.2vault.site
```

If backend uses path-based routing on the same domain:

```env
NEXT_PUBLIC_API_URL=https://chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://chat.2vault.site
```

If backend uses `api.chat.2vault.site`:

```env
NEXT_PUBLIC_API_URL=https://api.chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://api.chat.2vault.site
```

### Frontend build arguments

Important: these are build-time variables for Next.js. Add them as Build Arguments in Dokploy:

```env
NEXT_PUBLIC_API_URL=https://chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://chat.2vault.site
```

### Frontend runtime environment variables

Also add the same values to frontend Environment:

```env
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://chat.2vault.site
```

## 5. Routing recommendation

Best routing shape:

```text
https://chat.2vault.site/       -> quietline-frontend:3000
https://chat.2vault.site/v1/*   -> quietline-backend:8080
https://chat.2vault.site/ws     -> quietline-backend:8080
https://chat.2vault.site/healthz -> quietline-backend:8080
```

Make sure WebSocket upgrade is enabled for `/ws`.

If path-based routing is awkward in Dokploy, use two domains:

```text
https://chat.2vault.site     -> frontend
https://api.chat.2vault.site -> backend
```

Then set frontend build args:

```env
NEXT_PUBLIC_API_URL=https://api.chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://api.chat.2vault.site
```

And backend CORS:

```env
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
```

## 6. Deploy order

1. Deploy PostgreSQL.
2. Deploy Redis.
3. Deploy MinIO or configure external S3.
4. Deploy backend.
5. Open backend logs and wait for:

```text
server started
```

6. Deploy frontend.
7. Enable SSL for `chat.2vault.site`.

## 7. Smoke test

Check:

```bash
curl https://chat.2vault.site/healthz
```

Then in browser:

```text
https://chat.2vault.site
```

Test:

- register
- create local identity
- upload avatar
- create room
- copy invite
- join from another browser profile
- send message
- upload and download file
- revoke another session
- logout

## 8. Common issues

### Frontend calls localhost

Cause: `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` were not set as build arguments.

Fix: add them to frontend Build Arguments and redeploy frontend.

### CORS error

Backend env must include:

```env
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
```

If using `api.chat.2vault.site`, CORS still points to frontend origin:

```env
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
```

### WebSocket fails

Check:

```env
NEXT_PUBLIC_WS_URL=wss://chat.2vault.site
```

or:

```env
NEXT_PUBLIC_WS_URL=wss://api.chat.2vault.site
```

Also verify Dokploy/Traefik has WebSocket upgrade enabled for the backend route.

### File upload fails

Check backend can reach S3/MinIO:

```env
S3_ENDPOINT=minio:9000
S3_ACCESS_KEY=quietline
S3_SECRET_KEY=...
S3_BUCKET=quietline
S3_USE_SSL=false
```

Also allow request bodies around 110 MB in proxy settings if Dokploy exposes that option.
