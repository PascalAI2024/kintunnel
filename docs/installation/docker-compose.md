# Docker Compose Installation

Docker Compose is the recommended install path for the MVP.

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

Create `compose.yml`:

```yaml
services:
  engine:
    image: ${KINTUNNEL_ENGINE_IMAGE:-ghcr.io/pascalai2024/kintunnel-engine:dev}
    container_name: ${KINTUNNEL_ENGINE_CONTAINER:-kintunnel-engine}
    restart: unless-stopped
    environment:
      KINTUNNEL_PUBLIC_ENDPOINT: ${KINTUNNEL_PUBLIC_ENDPOINT}
      KINTUNNEL_WG_INTERFACE: ${KINTUNNEL_WG_INTERFACE:-wg0}
      KINTUNNEL_WG_PORT: ${KINTUNNEL_WG_PORT:-51820}
      KINTUNNEL_WG_ADDRESS: ${KINTUNNEL_WG_ADDRESS:-10.44.0.1/24}
      KINTUNNEL_WG_DNS: ${KINTUNNEL_WG_DNS:-1.1.1.1}
      KINTUNNEL_ALLOWED_IPS: ${KINTUNNEL_ALLOWED_IPS:-0.0.0.0/0}
      KINTUNNEL_DATA_DIR: /var/lib/kintunnel
      KINTUNNEL_CONFIG_FILE: /etc/kintunnel/kintunnel.yml
    volumes:
      - ./config:/etc/kintunnel:ro
      - kintunnel-data:/var/lib/kintunnel
      - kintunnel-backups:/backups
    ports:
      - "${KINTUNNEL_WG_PORT:-51820}:51820/udp"
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      net.ipv4.ip_forward: "1"
      net.ipv4.conf.all.src_valid_mark: "1"

  admin:
    image: ${KINTUNNEL_ADMIN_IMAGE:-ghcr.io/pascalai2024/kintunnel-admin:dev}
    container_name: ${KINTUNNEL_ADMIN_CONTAINER:-kintunnel-admin}
    restart: unless-stopped
    depends_on:
      - engine
    environment:
      KINTUNNEL_ADMIN_BIND: 0.0.0.0
      KINTUNNEL_ADMIN_PORT: 8080
      KINTUNNEL_ENGINE_URL: http://engine:9090
      KINTUNNEL_SESSION_SECRET_FILE: /run/secrets/kintunnel_session_secret
    volumes:
      - ./config:/etc/kintunnel:ro
    ports:
      - "${KINTUNNEL_ADMIN_BIND_HOST:-127.0.0.1}:${KINTUNNEL_ADMIN_PORT:-8080}:8080/tcp"
    secrets:
      - kintunnel_session_secret

volumes:
  kintunnel-data:
  kintunnel-backups:

secrets:
  kintunnel_session_secret:
    file: ${KINTUNNEL_SESSION_SECRET_FILE:-./config/secrets/session-secret.txt}
```

This keeps the admin UI on localhost by default. Use an SSH tunnel or a reverse proxy with authentication and IP allowlisting.

## Environment File

Create `.env`:

```env
KINTUNNEL_PUBLIC_ENDPOINT=vpn.example.com
KINTUNNEL_WG_PORT=51820
KINTUNNEL_WG_INTERFACE=wg0
KINTUNNEL_WG_ADDRESS=10.44.0.1/24
KINTUNNEL_WG_DNS=1.1.1.1
KINTUNNEL_ALLOWED_IPS=0.0.0.0/0
KINTUNNEL_ADMIN_BIND_HOST=127.0.0.1
KINTUNNEL_ADMIN_PORT=8080
KINTUNNEL_SESSION_SECRET_FILE=./config/secrets/session-secret.txt
```

See [environment-variables.md](../configuration/environment-variables.md) for details.

## Start

```sh
docker compose up -d
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
