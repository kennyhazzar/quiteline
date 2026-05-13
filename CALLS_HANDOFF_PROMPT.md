# Quietline WebRTC Calls Handoff Prompt

Use this prompt to continue debugging Quietline calls without repeating the same work.

## Context

Quietline is a Go backend + Next.js frontend messenger deployed with Docker Compose.

Production domains:

- Frontend: `https://chat.2vault.site`
- API/WebSocket: `https://api.chat.2vault.site`
- TURN realm: `chat.2vault.site`

Main deployment file:

- `docker-compose.deploy.yml`

Important frontend files:

- `frontend/src/components/MessengerApp.tsx`
- `frontend/src/components/layout/AppShell.tsx`
- `frontend/src/types/messenger.ts`

Important backend files:

- `internal/api/router.go`
- `internal/ws/handler.go`
- `internal/config/config.go`

## Current Problem

Audio calls do not establish media connection.

Signaling works:

- Caller sends offer.
- Receiver gets incoming call.
- Receiver answers.
- Caller receives answer.
- Both sides can get `Remote audio track received`.

But ICE/WebRTC never reaches `connected`. Calls fail after timeout.

Typical frontend error:

```text
Не удалось установить медиасоединение. Проверьте TURN, сеть или мобильный firewall.
```

## Current Production TURN Setup

`.env` on server should contain:

```env
TURN_REALM=chat.2vault.site
TURN_EXTERNAL_IP=95.164.55.124
TURN_URLS=turn:chat.2vault.site:3478?transport=udp
TURN_USERNAME=quietline
TURN_CREDENTIAL=<secret>
```

`docker-compose.deploy.yml` currently runs coturn with host network and UDP-only:

```yaml
coturn:
  image: coturn/coturn:4
  restart: unless-stopped
  network_mode: host
  command:
    - -n
    - -v
    - --log-file=stdout
    - --listening-port=3478
    - --listening-ip=0.0.0.0
    - --relay-ip=${TURN_EXTERNAL_IP}
    - --external-ip=${TURN_EXTERNAL_IP}
    - --realm=${TURN_REALM}
    - --server-name=${TURN_REALM}
    - --fingerprint
    - --lt-cred-mech
    - --user=${TURN_USERNAME}:${TURN_CREDENTIAL}
    - --no-multicast-peers
    - --no-tcp
    - --no-tls
    - --no-dtls
    - --min-port=49160
    - --max-port=49200
```

UFW was opened:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow 3478/udp
ufw allow 49160:49200/udp
```

Server IP/DNS verified:

```text
curl -4 -s ifconfig.me -> 95.164.55.124
dig +short chat.2vault.site -> 95.164.55.124
dig +short api.chat.2vault.site -> 95.164.55.124
```

## Important Observed Logs

coturn receives allocation requests and succeeds:

```text
realm <chat.2vault.site> user <>: incoming packet message processed, error 401: Unauthorized
IPv4. Local relay addr: 95.164.55.124:49181
session ... new, realm=<chat.2vault.site>, username=<quietline>, lifetime=600
incoming packet ALLOCATE processed, success
```

The initial `401 Unauthorized` before `ALLOCATE processed, success` is likely normal TURN long-term credential challenge.

But then allocations timeout with no peer traffic:

```text
peer usage: realm=<chat.2vault.site>, username=<quietline>, rp=0, rb=0, sp=0, sb=0
closed (2nd stage), user <quietline> realm <chat.2vault.site>, reason: allocation timeout
```

This is the core failure: TURN allocation works, but relayed peer traffic never starts.

## Latest Frontend Diagnostics

Caller:

```text
Quietline call diagnostics
state: failed
peer: ...
status: -
error: Не удалось установить медиасоединение. Проверьте TURN, сеть или мобильный firewall.

Creating peer connection
ICE servers: 2
ICE policy: relay
ICE policy: relay
Waiting for local ICE
ICE gathering: gathering
ICE local: typ relay UDP
Initial ICE ready: relay
Offer sent
ICE local: typ relay UDP
Remote audio track received
Remote answer accepted
ICE error 701: STUN binding request timed out.
ICE error 701: TURN allocate request timed out.
ICE gathering: complete
ICE gathering complete
```

Receiver before latest SDP candidate extraction fix:

```text
Incoming offer received
ICE stored early: typ relay UDP
Answering call
ICE servers: 2
ICE policy: relay
ICE policy: relay
ICE restored: 2
Remote audio track received
Remote offer accepted
ICE bundled: 1
ICE added: typ relay UDP
ICE added: typ relay UDP
ICE added: typ relay UDP
Waiting for local ICE
ICE gathering: gathering
ICE gathering complete
ICE gathering: complete
Initial ICE ready: none
Answer sent
```

After that, a fix was added to collect local ICE candidates from `localDescription.sdp`, but the user reports the problem still persists. Get fresh diagnostics from both sides using the copy button in the call modal.

## Recent Changes Already Made

1. Added TURN/coturn to Docker Compose.
2. Switched production coturn to `network_mode: host`.
3. Set `--relay-ip=${TURN_EXTERNAL_IP}` and `--external-ip=${TURN_EXTERNAL_IP}`.
4. Switched TURN to UDP-only:
   - `TURN_URLS=turn:chat.2vault.site:3478?transport=udp`
   - coturn has `--no-tcp`
5. Frontend now uses `iceTransportPolicy: 'relay'` when TURN is present.
6. Frontend waits for initial relay ICE before sending offer/answer.
7. Frontend bundles ICE candidates inside `call-offer` and `call-answer`.
8. Frontend has a button to copy call diagnostics.
9. Frontend additionally extracts local candidates from `localDescription.sdp`.

Recent relevant commits:

- `21c2cb5 Force TURN calls over UDP relay`
- `8586239 Add call diagnostics copy action`
- `489e293 Collect ICE candidates from local SDP`

## Root Cause (Diagnosed 2026-05-13)

The receiver gathered **0 ICE relay candidates** every call. The answer was sent empty after an 8-second timeout in `waitForInitialIce`. With no remote relay address, coturn relayed nothing (`peer usage: rp=0, rb=0, sp=0, sb=0`).

Two compound causes:

1. **Relay port range 49160-49200 is blocked by the hosting provider.** TURN allocation on port 3478 works (coturn shows successful `ALLOCATE processed, success`), but the relay ports are blocked at the provider firewall level (Hetzner security groups or equivalent). The browser contacts coturn, gets back a relay address, but the address is unreachable — so the relay candidate is never confirmed valid, and 0 candidates are gathered.

2. **No TCP TURN fallback** (`--no-tcp` was set in coturn). Mobile and restrictive networks block arbitrary UDP ports but universally allow TCP 443/3478.

## Changes Made

### docker-compose.deploy.yml
- Removed `--no-tcp` so coturn accepts TCP connections on port 3478
- Changed relay port range from `49160-49200` to `49152-65535`

### frontend/src/components/MessengerApp.tsx
- `waitForInitialIce`: when `iceGatheringState === 'complete'` with 0 relay candidates, calls `finish()` immediately (was: waited 8s for the timer) and logs `TURN relay failed: gathering complete, 0 relay candidates (check provider firewall for relay ports)`
- Added `Offer candidates: N` before sending the offer
- Added `Answer candidates: N` before sending the answer
- Added `Offer received candidates: N` when the receiver gets a call-offer
- Added `Answer received candidates: N` when the caller gets the call-answer

## What Must Be Done on the Server

### 1. Open relay port range in provider firewall (CRITICAL)

If the server is on Hetzner Cloud, go to the Hetzner Console → Firewalls and add a rule:

```
Protocol: UDP
Port range: 49152-65535
Direction: Inbound
```

Also update UFW:

```bash
ufw delete allow 49160:49200/udp
ufw allow 49152:65535/udp
```

### 2. Enable TCP TURN and update TURN_URLS (important for mobile)

After redeploying coturn (which now has TCP enabled), update `.env`:

```env
TURN_URLS=turn:chat.2vault.site:3478?transport=udp,turn:chat.2vault.site:3478?transport=tcp
```

Open TCP 3478 in UFW and provider firewall if not already open:

```bash
ufw allow 3478/tcp
```

### 3. Deploy

```bash
cd /opt/quietline
git pull
docker compose -f docker-compose.deploy.yml --env-file .env up -d --force-recreate coturn
docker compose -f docker-compose.deploy.yml --env-file .env up -d --build frontend
```

## How to Verify the Fix

After deploying, make a test call and check diagnostics. The receiver should now show:

```text
TURN relay failed: gathering complete, 0 relay candidates (check provider firewall for relay ports)
```

— if relay ports are STILL blocked at provider. Or, if ports are open:

```text
ICE local: typ relay UDP
Initial ICE ready: relay
Answer candidates: 2
Answer sent
```

And the caller should show after receiving the answer:

```text
Answer received candidates: 2
ICE bundled: 2
ICE added: typ relay UDP
```

If `Answer received candidates: 0` still appears after opening provider ports, the TURN server relay IP configuration may be wrong for this network topology. Check:

```bash
ss -lunp | grep -E '3478|491[5-9][0-9]|[5-9][0-9]{4}'
ip -4 addr
```

If the public IP is not directly on the interface (NAT setup), change coturn:

```text
--relay-ip=<private_interface_ip>
--external-ip=<public_ip>/<private_interface_ip>
```

## What To Investigate Next

Do not start by assuming CORS or basic signaling. Offer/answer signaling already works.

1. **Verify provider firewall** — open 49152-65535/UDP inbound in the Hetzner/provider console, not just UFW.

2. **Confirm new diagnostics** after deploying:
   - Receiver should show `TURN relay failed: ...` immediately (not after 8s) if ports still blocked
   - Or show `Answer candidates: N` where N > 0 if fixed

3. **If relay still fails after opening ports**, test coturn independently:

```bash
# From a second machine, test TURN with turnutils_uclient or a browser TURN test page
# e.g.: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
# Use: turn:chat.2vault.site:3478, username=quietline, credential=<secret>
```

4. **If TCP TURN is needed** (one side on mobile/VPN), update TURN_URLS in .env to include both transports (see above).

5. Temporarily switch `iceTransportPolicy` to `'all'` for one test call to check if direct P2P or STUN-reflexive works. If it does, the relay path is the only broken thing.

6. Consider TURNS (TLS) on port 443 as the ultimate fallback for the most restricted networks. This requires a TLS certificate for the TURN server, or fronting through Caddy with `tls_passthrough`.

## Useful Server Commands

Deploy latest frontend:

```bash
cd /opt/quietline
git pull
docker compose -f docker-compose.deploy.yml --env-file .env up -d --build frontend
```

Recreate coturn and backend:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env up -d --force-recreate coturn backend
```

Check env inside backend:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env exec backend printenv TURN_URLS
docker compose -f docker-compose.deploy.yml --env-file .env exec backend printenv TURN_USERNAME
```

Check coturn generated config:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env config | sed -n '/coturn:/,/backend:/p'
```

Follow logs:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env logs -f coturn backend
```

## Desired Outcome

Make Quietline calls reliable enough for real use:

- incoming call UI works;
- answer/decline/end states stay synchronized;
- ICE connects through TURN when direct route is unavailable;
- audio plays on both sides;
- diagnostics clearly explain failure when connection cannot be established.

Start by collecting fresh diagnostics from both clients after commit `489e293`, then decide whether the next fix is signaling ACK/logging or coturn/network relay verification.
