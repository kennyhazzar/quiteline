# Deploy Quietline to chat.2vault.site

This guide deploys Quietline with Docker Compose, nginx, and Let's Encrypt.

Host ports `3000`, `8080`, `9000`, and `5432` are not published in production. The bundled nginx is profile-gated. If your server already has nginx on `80`/`443`, use [DEPLOY_CHAT_2VAULT.md](DEPLOY_CHAT_2VAULT.md).

## 1. DNS

Create an `A` record:

```text
chat.2vault.site -> YOUR_SERVER_IP
```

Check it:

```bash
nslookup chat.2vault.site
```

## 2. Prepare The Server

Clone the repository:

```bash
mkdir -p /opt/quietline
cd /opt/quietline
git clone YOUR_REPOSITORY_URL .
```

Create runtime directories:

```bash
mkdir -p deploy/nginx/conf.d deploy/certbot/www deploy/certbot/conf
```

## 3. Create Production Env

Copy the template:

```bash
cp .env.prod.example .env.prod
nano .env.prod
```

Replace every `CHANGE_ME` value. Keep these values for the target domain:

```env
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
NEXT_PUBLIC_API_URL=https://chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://chat.2vault.site
```

Generate strong secrets, for example:

```bash
openssl rand -hex 32
```

## 4. First Nginx Config For Certificate Issue

Copy the temporary HTTP-only config:

```bash
cp deploy/nginx/conf.d/chat.2vault.site.http.conf.example deploy/nginx/conf.d/chat.2vault.site.conf
```

Start the stack enough for nginx and ACME challenge:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod --profile bundled-nginx up -d postgres redis minio server-a frontend nginx
```

Check nginx:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

## 5. Issue Let's Encrypt Certificate

Run certbot:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod --profile bundled-nginx run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  -d chat.2vault.site \
  --email YOUR_EMAIL@example.com \
  --agree-tos \
  --no-eff-email
```

## 6. Switch To HTTPS Nginx Config

Replace the temporary config with the HTTPS config:

```bash
cp deploy/nginx/conf.d/chat.2vault.site.https.conf.example deploy/nginx/conf.d/chat.2vault.site.conf
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod --profile bundled-nginx restart nginx
```

## 7. Build And Run Production

Build images:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod build
```

Start everything:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

The compose file reads `.env.prod` by default through `APP_ENV_FILE`. If you keep the production env under another path, pass it explicitly:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

View logs:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f server-a frontend
```

## 8. Verify

Check backend through nginx:

```bash
curl https://chat.2vault.site/healthz
```

Open:

```text
https://chat.2vault.site
```

Smoke test:

- register an account
- create a local identity
- create a room
- copy invite and join from another browser profile
- send a message
- upload and download a file
- leave the room

## 9. Renew Certificates

Add a cron job on the server:

```bash
0 3 * * * cd /opt/quietline && APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod --profile bundled-nginx run --rm certbot renew && APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod --profile bundled-nginx restart nginx
```

## 10. Updating The App

Pull and rebuild:

```bash
cd /opt/quietline
git pull
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod build
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

## Troubleshooting

If port `8080` is busy on the host, it is fine. Production does not publish `8080`; nginx proxies to `server-a:8080` inside Docker.

If `80` or `443` is busy, stop the other nginx/container using those ports or attach this app to your existing nginx Docker network and copy the server block into that nginx setup.

If WebSocket does not connect, verify:

- `NEXT_PUBLIC_WS_URL=wss://chat.2vault.site`
- nginx `/ws` location has `Upgrade` and `Connection "upgrade"` headers
- `CORS_ALLOWED_ORIGINS=https://chat.2vault.site`
