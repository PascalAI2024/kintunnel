# Quick Start

This path gets a working MVP onto one Linux VPS using Docker Compose and WireGuard.

## Requirements

- A Linux VPS with a public IPv4 address.
- Root or sudo access.
- Docker Engine and Docker Compose plugin.
- DNS record for the admin UI, if publishing it behind HTTPS.
- UDP `51820` open to the internet.
- TCP `443` open if the admin UI is reverse proxied with HTTPS.

## Deployment Shape

The recommended MVP uses the original KinTunnel two-service shape:

- WireGuard data plane on UDP `51820`.
- Privileged engine container that applies WireGuard, forwarding, and NAT state using standard Linux tooling.
- Unprivileged admin container on an internal Docker port, published only through a reverse proxy or an SSH tunnel.
- Persistent config volume for peers and server keys.
- Full-tunnel peer configs using `AllowedIPs = 0.0.0.0/0, ::/0`.

## Steps

1. Create the server directory.

```powershell
mkdir kintunnel
cd kintunnel
```

2. Create a `.env` file using [environment-variables.md](configuration/environment-variables.md).

3. Create a Compose file using [installation/docker-compose.md](installation/docker-compose.md).

4. Start the service.

```powershell
docker compose up -d
```

5. Confirm the container is running.

```powershell
docker compose ps
docker compose logs --tail 100
```

6. Open the admin UI through the protected HTTPS endpoint or SSH tunnel.

7. Create one peer per user device.

8. Have the user install the official WireGuard client and import the QR code or config file.

9. Verify the client public IP matches the VPS public IP.

## First Verification

From a connected client:

```sh
curl https://ifconfig.me
```

The response should be the VPS public IP when using full tunnel mode.

## Early Production Checklist

- Use a strong admin password.
- Restrict admin UI access by IP allowlist, VPN-only access, or SSH tunnel.
- Back up the persistent data and backup volumes.
- Keep one peer per device, not one peer per family.
- Remove peers immediately when a device is lost or no longer trusted.
