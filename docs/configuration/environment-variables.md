# Environment Variables

These variables configure the MVP deployment. The `KINTUNNEL_*` namespace is the stable deployment environment namespace.

| Variable | Required | Example | Purpose |
|---|---:|---|---|
| `KINTUNNEL_PUBLIC_ENDPOINT` | Yes | `vpn.example.com` | Public DNS name or IP clients use to reach the VPS. |
| `KINTUNNEL_SESSION_SECRET_FILE` | Yes | `./config/secrets/session-secret.txt` | File containing the admin session secret. |
| `KINTUNNEL_WG_PORT` | No | `51820` | UDP WireGuard listen port. |
| `KINTUNNEL_ADMIN_BIND_HOST` | No | `127.0.0.1` | Host interface for the admin service when published by Compose. |
| `KINTUNNEL_ADMIN_PORT` | No | `8080` | Admin service port. |
| `KINTUNNEL_WG_INTERFACE` | No | `wg0` | WireGuard interface name managed by the engine. |
| `KINTUNNEL_WG_ADDRESS` | No | `10.44.0.1/24` | Server tunnel address and peer allocation subnet. |
| `KINTUNNEL_WG_DNS` | No | `1.1.1.1` | DNS server pushed to clients. |
| `KINTUNNEL_ALLOWED_IPS` | No | `0.0.0.0/0` | Client route set. Full tunnel by default. |
| `KINTUNNEL_ENGINE_IMAGE` | No | `ghcr.io/pascalai2024/kintunnel-engine:dev` | Engine image used by Compose. |
| `KINTUNNEL_ADMIN_IMAGE` | No | `ghcr.io/pascalai2024/kintunnel-admin:dev` | Admin image used by Compose. |

## Full Tunnel Defaults

For IPv4 full tunnel:

```env
KINTUNNEL_ALLOWED_IPS=0.0.0.0/0
```

For IPv4 and IPv6 full tunnel:

```env
KINTUNNEL_ALLOWED_IPS=0.0.0.0/0, ::/0
```

Only use IPv6 when the VPS, firewall, Docker network path, and WireGuard server are configured for IPv6 forwarding and egress.

## DNS Choices

Common public DNS choices:

- `1.1.1.1`
- `9.9.9.9`
- `8.8.8.8`

If DNS filtering is added later, document it as an explicit feature. Do not imply privacy filtering exists unless it has actually been configured.

## Admin Secrets

Store the session secret in the file referenced by `KINTUNNEL_SESSION_SECRET_FILE`. Keep generated secrets out of public documentation, tickets, screenshots, and shell history where possible.
