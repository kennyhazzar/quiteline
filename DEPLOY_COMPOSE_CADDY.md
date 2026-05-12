# Deploy Quietline with Docker Compose and Caddy

This is the recommended low-overhead deployment for a small VPS.

Domains:

- Frontend: `https://chat.2vault.site`
- Backend API/WebSocket: `https://api.chat.2vault.site`

Stack:

- Docker Compose
- Caddy for automatic HTTPS
- Go backend
- Next.js frontend
- Postgres
- Redis with password
- MinIO for encrypted files and avatars
- coturn for WebRTC calls

## 1. DNS

Create two `A` records:

```text
chat.2vault.site     -> YOUR_SERVER_IP
api.chat.2vault.site -> YOUR_SERVER_IP
```

Check:

```bash
dig +short chat.2vault.site
dig +short api.chat.2vault.site
```

Both should return your VPS IP.

## 2. Install base packages

Run as `root`:

```bash
apt update
apt install -y ca-certificates curl gnupg git openssl
```

## 3. Add swap for a 2 GB RAM server

Building Next.js and Go on a 2 GB VPS can fail without swap.

```bash
fallocate -l 3G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

## 4. Install Docker Engine and Compose plugin

```bash
install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg

chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
docker --version
docker compose version
```

## 5. Clone the repository

```bash
mkdir -p /opt/quietline
cd /opt/quietline
git clone git@github.com:kennyhazzar/quiteline.git .
```

If SSH keys are not configured on the server, use HTTPS:

```bash
git clone https://github.com/kennyhazzar/quiteline.git .
```

## 6. Create production env

```bash
cp .env.deploy.example .env
nano .env
```

Generate secrets:

```bash
openssl rand -hex 32
```

Replace every `CHANGE_ME...` value.

Important: `POSTGRES_PASSWORD` and the password inside `POSTGRES_DSN` must be identical.

Example:

```env
POSTGRES_PASSWORD=abc123
POSTGRES_DSN=postgres://quietline:abc123@postgres:5432/quietline?sslmode=disable
```

Keep frontend URLs exactly like this:

```env
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
NEXT_PUBLIC_API_URL=https://api.chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://api.chat.2vault.site
```

## 7. Build and start

```bash
cd /opt/quietline
docker compose -f docker-compose.deploy.yml --env-file .env build
docker compose -f docker-compose.deploy.yml --env-file .env up -d
```

Caddy will request certificates automatically for:

- `chat.2vault.site`
- `api.chat.2vault.site`

## 8. Check logs

```bash
docker compose -f docker-compose.deploy.yml --env-file .env ps
docker compose -f docker-compose.deploy.yml --env-file .env logs -f caddy
docker compose -f docker-compose.deploy.yml --env-file .env logs -f backend
```

Backend should log that the server started.

Caddy should log certificate issuance or successful TLS setup.

## 9. Verify

```bash
curl https://api.chat.2vault.site/healthz
curl -I https://chat.2vault.site
```

Open:

```text
https://chat.2vault.site
```

Smoke test:

- register
- create local identity
- upload avatar
- create room
- copy invite
- join from another browser profile
- send message
- upload/download file
- logout

## 10. Enable UFW after the service works

Only do this after SSH access is stable and the app is verified.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49160:49200/udp
ufw enable
ufw status verbose
```

Do not expose Postgres, Redis, MinIO, backend `8080`, or frontend `3000` to the public internet. TURN ports are public by design and are protected by long-term credentials from `.env`.

For calls, set `TURN_EXTERNAL_IP` in `.env` to the public IPv4 address of the VPS. In production compose, coturn runs with `network_mode: host` so TURN and relay ports are bound directly on the VPS instead of going through Docker NAT.

## 11. Update deploy

```bash
cd /opt/quietline
git pull
docker compose -f docker-compose.deploy.yml --env-file .env build
docker compose -f docker-compose.deploy.yml --env-file .env up -d
```

## 12. Useful commands

Restart:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env restart
```

Stop:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env down
```

View all logs:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env logs -f
```

Check disk:

```bash
df -h
docker system df
```

Clean unused build cache:

```bash
docker builder prune
```

## Troubleshooting

### Caddy cannot issue certificates

Check:

- DNS points to the VPS
- ports `80` and `443` are free
- no external firewall blocks ports `80` and `443`
- no external firewall blocks TURN ports `3478/tcp`, `3478/udp`, and `49160-49200/udp`

### Frontend calls localhost

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` were wrong during build.

Fix `.env`, then rebuild frontend:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env build frontend
docker compose -f docker-compose.deploy.yml --env-file .env up -d frontend
```

### Redis auth fails

Check `REDIS_PASSWORD` is the same for Redis and backend:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env logs redis
docker compose -f docker-compose.deploy.yml --env-file .env logs backend
```

### File upload fails

Check MinIO and backend:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env logs minio
docker compose -f docker-compose.deploy.yml --env-file .env logs backend
```

Backend uses:

```env
S3_ENDPOINT=minio:9000
S3_USE_SSL=false
```
