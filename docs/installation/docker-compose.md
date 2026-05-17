# Docker Compose Installation

Docker Compose is the recommended install path for the MVP.

The current runtime is real, but dry-run should remain enabled for evaluation until non-dry-run reconcile is hardened. In dry-run, the engine persists state and renders client configs without touching WireGuard, firewall, forwarding, or NAT state.

This repository includes Dockerfiles for both runtime services. The default
Compose file builds local images from source. Published GHCR images are a
release artifact once tags are cut; a source checkout does not need them.

Build the TypeScript runtime locally before container work:

```sh
npm ci
npm run build
```

Build and run the included Compose stack with:

```sh
cp .env.example .env
mkdir -p config/secrets
openssl rand -base64 32 > config/secrets/admin-token.txt
docker compose --profile admin build
docker compose --profile admin up -d
```

## Host Preparation

Open the required ports on the VPS firewall:

```sh
sudo ufw allow 51820/udp
sudo ufw allow 443/tcp
```

Enable IP forwarding:

```sh
printf 'net.ipv4.ip_forward=1\n' | sudo tee /etc/sysctl.d/99-kintunnel.conf
sudo sysctl --system
```

If IPv6 full tunnel is required, also configure IPv6 forwarding:

```sh
printf 'net.ipv6.conf.all.forwarding=1\n' | sudo tee -a /etc/sysctl.d/99-kintunnel.conf
sudo sysctl --system
```

## Compose File

The repository root already includes `docker-compose.yml`. If you need a
standalone reference file, keep the environment mapping aligned with the same
runtime variables:

```yaml
services:
  engine:
    image: ${KINTUNNEL_ENGINE_IMAGE:-kintunnel-engine:local}
    build:
      context: .
      dockerfile: Dockerfile.engine
    container_name: ${KINTUNNEL_ENGINE_CONTAINER:-kintunnel-engine}
    restart: unless-stopped
    environment:
      KINTUNNEL_DRY_RUN: ${KINTUNNEL_DRY_RUN:-true}
      KINTUNNEL_ENDPOINT_HOST: ${KINTUNNEL_PUBLIC_ENDPOINT}
      KINTUNNEL_ENDPOINT_PORT: ${KINTUNNEL_WG_PORT:-51820}
      KINTUNNEL_WG_INTERFACE: ${KINTUNNEL_WG_INTERFACE:-wg0}
      KINTUNNEL_WG_LISTEN_PORT: ${KINTUNNEL_WG_PORT:-51820}
      KINTUNNEL_WG_ADDRESS: ${KINTUNNEL_WG_ADDRESS:-10.44.0.1/24}
      KINTUNNEL_DNS_SERVERS: ${KINTUNNEL_WG_DNS:-1.1.1.1}
      KINTUNNEL_ALLOWED_IPS: ${KINTUNNEL_ALLOWED_IPS:-0.0.0.0/0}
      KINTUNNEL_DATA_DIR: /var/lib/kintunnel
    volumes:
      - ./config:/etc/kintunnel:ro
      - kintunnel-data:/var/lib/kintunnel
      - kintunnel-backups:/backups
    ports:
      - "${KINTUNNEL_WG_PORT:-51820}:${KINTUNNEL_WG_PORT:-51820}/udp"
    cap_add:
      - NET_ADMIN
    sysctls:
      net.ipv4.ip_forward: "1"
      net.ipv4.conf.all.src_valid_mark: "1"

  admin:
    image: ${KINTUNNEL_ADMIN_IMAGE:-kintunnel-admin:local}
    build:
      context: .
      dockerfile: Dockerfile.admin
    container_name: ${KINTUNNEL_ADMIN_CONTAINER:-kintunnel-admin}
    restart: unless-stopped
    depends_on:
      - engine
    environment:
      KINTUNNEL_ADMIN_BIND: 0.0.0.0
      KINTUNNEL_ADMIN_PORT: 8080
      KINTUNNEL_ENGINE_URL: http://engine:9090
      KINTUNNEL_ADMIN_TOKEN_FILE: /run/secrets/kintunnel_admin_token
    volumes:
      - ./config:/etc/kintunnel:ro
    ports:
      - "${KINTUNNEL_ADMIN_BIND_HOST:-127.0.0.1}:${KINTUNNEL_ADMIN_PORT:-8080}:8080/tcp"
    secrets:
      - kintunnel_admin_token

volumes:
  kintunnel-data:
  kintunnel-backups:

secrets:
  kintunnel_admin_token:
    file: ${KINTUNNEL_ADMIN_TOKEN_FILE:-./config/secrets/admin-token.txt}
```

This keeps the admin UI on localhost by default. Use an SSH tunnel or a reverse proxy with authentication and IP allowlisting.

## Environment File

Create `.env`:

```env
KINTUNNEL_DRY_RUN=true
KINTUNNEL_PUBLIC_ENDPOINT=vpn.example.com
KINTUNNEL_WG_PORT=51820
KINTUNNEL_WG_INTERFACE=wg0
KINTUNNEL_WG_ADDRESS=10.44.0.1/24
KINTUNNEL_WG_DNS=1.1.1.1
KINTUNNEL_ALLOWED_IPS=0.0.0.0/0
KINTUNNEL_ADMIN_TOKEN_FILE=./config/secrets/admin-token.txt
KINTUNNEL_ADMIN_BIND_HOST=127.0.0.1
KINTUNNEL_ADMIN_PORT=8080
```

See [environment-variables.md](../configuration/environment-variables.md) for details.

## Start

```sh
docker compose --profile admin up -d
docker compose ps
```

## Admin UI Access

SSH tunnel option:

```sh
ssh -L 8080:127.0.0.1:8080 root@vpn.example.com
```

Then open:

```text
http://127.0.0.1:8080
```

Reverse proxy option:

- Terminate HTTPS at Traefik, Caddy, Nginx, or Dokploy.
- Forward to `127.0.0.1:8080` or an internal Docker network.
- Add IP allowlisting where possible.
- Do not leave the admin UI open to the internet with only a weak password. That would be sporting, in the worst sense.

## Upgrade

```sh
docker compose pull
docker compose up -d
docker compose logs --tail 100
```

Back up the `kintunnel-data` and `kintunnel-backups` volumes before upgrades. The names match the public project namespace.
