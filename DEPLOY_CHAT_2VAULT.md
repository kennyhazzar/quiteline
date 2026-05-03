# Deploy to chat.2vault.site with an existing Docker nginx

This guide starts from a fresh clone and deploys Quietline behind an nginx container that already owns host ports `80` and `443`.

Important constraints for this server:

- host port `8080` is already busy, so the Go backend is not published to the host
- host port `443` is already busy, so this project does not start its own public nginx by default
- the existing nginx container will proxy to `frontend:3000` and `backend:8080` inside Docker

## 1. DNS

Create or verify the DNS record:

```text
chat.2vault.site -> YOUR_SERVER_IP
```

Check it:

```bash
nslookup chat.2vault.site
```

## 2. Clone the repository

```bash
mkdir -p /opt/quietline
cd /opt/quietline
git clone git@github.com:kennyhazzar/quiteline.git .
```

## 3. Create the production env

```bash
cp .env.prod.example .env.prod
nano .env.prod
```

Replace every `CHANGE_ME` value.

Keep these values for the public domain:

```env
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
NEXT_PUBLIC_API_URL=https://chat.2vault.site
NEXT_PUBLIC_WS_URL=wss://chat.2vault.site
```

Generate secrets:

```bash
openssl rand -hex 32
```

Use different generated values for:

- `AUTH_SECRET`
- `API_KEYS`
- `POSTGRES_PASSWORD`
- `S3_SECRET_KEY`

## 4. Build and start the app stack

This does not publish `8080`, `3000`, `9000`, or `5432` to the host.

```bash
cd /opt/quietline
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod build
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Check containers:

```bash
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

Expected app containers:

- `backend`
- `frontend`
- `postgres`
- `redis`
- `minio`

The project nginx is profile-gated and should not start unless you explicitly use `--profile bundled-nginx`.

## 5. Connect the existing nginx container to the app network

Find the existing nginx container:

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"
```

Set its name:

```bash
export NGINX_CONTAINER=YOUR_EXISTING_NGINX_CONTAINER_NAME
```

Find the Quietline network:

```bash
docker network ls | grep quietline
```

If the network name is not obvious, inspect the app container:

```bash
docker inspect quietline-backend-1 --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}'
```

Set the network name:

```bash
export QUIETLINE_NETWORK=quietline_default
```

Connect nginx to it:

```bash
docker network connect "$QUIETLINE_NETWORK" "$NGINX_CONTAINER"
```

If Docker says the container is already connected, that is fine.

## 6. Add nginx server block

Open the config directory used by the existing nginx container. Common options are:

```bash
/etc/nginx/conf.d
/opt/nginx/conf.d
/opt/reverse-proxy/conf.d
```

If you are unsure, inspect mounts:

```bash
docker inspect "$NGINX_CONTAINER" --format '{{json .Mounts}}'
```

Create a config file in the mounted nginx config directory, for example:

```bash
nano /PATH/TO/EXISTING_NGINX/conf.d/chat.2vault.site.conf
```

Use this config after certificates exist:

```nginx
server {
    listen 80;
    server_name chat.2vault.site;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name chat.2vault.site;

    ssl_certificate /etc/letsencrypt/live/chat.2vault.site/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.2vault.site/privkey.pem;

    client_max_body_size 110m;

    location /v1/ {
        proxy_pass http://backend:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /healthz {
        proxy_pass http://backend:8080;
        proxy_set_header Host $host;
    }

    location /ws {
        proxy_pass http://backend:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://frontend:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Before certificates exist, use this temporary HTTP-only config:

```nginx
server {
    listen 80;
    server_name chat.2vault.site;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://frontend:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto http;
    }
}
```

Reload nginx:

```bash
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload
```

## 7. Issue certificates

Use the certbot setup that belongs to your existing nginx.

If your existing nginx already uses certbot with a shared webroot, run the existing certbot container with the same webroot and letsencrypt volumes:

```bash
docker ps --format "table {{.Names}}\t{{.Image}}" | grep certbot
```

Then run something like:

```bash
docker run --rm \
  -v /PATH/TO/CERTBOT/www:/var/www/certbot \
  -v /PATH/TO/LETSENCRYPT:/etc/letsencrypt \
  certbot/certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  -d chat.2vault.site \
  --email YOUR_EMAIL@example.com \
  --agree-tos \
  --no-eff-email
```

If the existing nginx stack has its own compose file, prefer its certbot service instead of `docker run`.

After cert issue:

1. Replace the temporary HTTP-only nginx config with the HTTPS config from step 6.
2. Reload nginx:

```bash
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload
```

## 8. Verify

```bash
curl -I https://chat.2vault.site
curl https://chat.2vault.site/healthz
```

Open:

```text
https://chat.2vault.site
```

Smoke test:

- register
- create local identity
- create room
- copy invite
- join from another browser profile
- send message
- upload and download file
- leave chat

## 9. Update deployment

```bash
cd /opt/quietline
git pull
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod build
APP_ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
docker exec "$NGINX_CONTAINER" nginx -s reload
```

## 10. Certificate renewal

Use the renewal process of the existing nginx/certbot stack.

If you use the `docker run` style from this guide, add a cron entry:

```bash
0 3 * * * docker run --rm -v /PATH/TO/CERTBOT/www:/var/www/certbot -v /PATH/TO/LETSENCRYPT:/etc/letsencrypt certbot/certbot renew && docker exec YOUR_EXISTING_NGINX_CONTAINER_NAME nginx -s reload
```

## Troubleshooting

If nginx cannot resolve `backend` or `frontend`, it is not connected to the Quietline Docker network. Repeat step 5.

If WebSocket fails, check `/ws` has `Upgrade` and `Connection "upgrade"` headers.

If browser requests fail with CORS, verify:

```env
CORS_ALLOWED_ORIGINS=https://chat.2vault.site
```

If upload fails for large files, verify nginx has:

```nginx
client_max_body_size 110m;
```
