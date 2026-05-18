# Environment Variables

These variables configure the MVP deployment. The `KINTUNNEL_*` namespace is the stable deployment environment namespace.

| Variable | Required | Example | Purpose |
|---|---:|---|---|
| `KINTUNNEL_ENV` | No | `production` | Runtime environment. Production rejects weak placeholder admin and engine tokens. Use `development` for local throwaway tokens. |
| `KINTUNNEL_DRY_RUN` | No | `true` | Runs the engine without changing host networking. Recommended for MVP evaluation. |
| `KINTUNNEL_PUBLIC_ENDPOINT` | Yes for Compose | `vpn.example.com` | Public DNS name or IP clients use to reach the VPS. The included Compose file maps this into the runtime endpoint host. |
| `KINTUNNEL_ENDPOINT_HOST` | Yes for direct engine runs | `vpn.example.com` | Runtime endpoint host written into client configs when running the engine outside the included Compose file. |
| `KINTUNNEL_ADMIN_TOKEN` | Yes | `generated-secret` | Bearer token used to sign in to the admin UI. Prefer a secret file in deployments. |
| `KINTUNNEL_ADMIN_TOKEN_FILE` | No | `/run/secrets/kintunnel_admin_token` | File containing the admin token. |
| `KINTUNNEL_ENGINE_API_TOKEN` | Yes | `generated-secret` | Bearer token used by the admin UI to call the engine API. Prefer a secret file in deployments. |
| `KINTUNNEL_ENGINE_API_TOKEN_FILE` | No | `/run/secrets/kintunnel_engine_api_token` | File containing the engine API token. |
| `KINTUNNEL_ENABLE_HOST_NETWORKING` | No | `false` | Required safety acknowledgement before running with `KINTUNNEL_DRY_RUN=false`. |
| `KINTUNNEL_WG_PORT` | No | `51820` | Compose convenience value for both published UDP port and runtime endpoint/listen port. |
| `KINTUNNEL_WG_LISTEN_PORT` | No | `51820` | UDP WireGuard listen port. |
| `KINTUNNEL_ENDPOINT_PORT` | No | `51820` | Endpoint port written into client configs. |
| `KINTUNNEL_ADMIN_BIND_HOST` | No | `127.0.0.1` | Host interface for the admin service when published by Compose. |
| `KINTUNNEL_ADMIN_BIND` | No | `0.0.0.0` | Interface the admin process binds inside the container or dev shell. |
| `KINTUNNEL_ADMIN_PORT` | No | `8080` | Admin service port. |
| `KINTUNNEL_ENGINE_PORT` | No | `9090` | Engine service port. |
| `KINTUNNEL_ENGINE_URL` | No | `http://engine:9090` | Engine URL used by the admin service. |
| `KINTUNNEL_DATA_DIR` | No | `/var/lib/kintunnel` | Directory containing engine state. |
| `KINTUNNEL_WG_INTERFACE` | No | `wg0` | WireGuard interface name managed by the engine. |
| `KINTUNNEL_WG_ADDRESS` | No | `10.44.0.0/24` | Tunnel CIDR used for server and peer allocation. |
| `KINTUNNEL_WG_DNS` | No | `1.1.1.1` | Compose convenience value mapped into runtime DNS servers. |
| `KINTUNNEL_DNS_SERVERS` | No | `1.1.1.1` | DNS server list pushed to clients. |
| `KINTUNNEL_ALLOWED_IPS` | No | `0.0.0.0/0` | Client route set. Full tunnel by default. |
| `KINTUNNEL_ENGINE_IMAGE` | No | `ghcr.io/OWNER/kintunnel-engine:v0.1.0` | Engine image used by Compose or Swarm when pulling a published release image. |
| `KINTUNNEL_ADMIN_IMAGE` | No | `ghcr.io/OWNER/kintunnel-admin:v0.1.0` | Admin image used by Compose or Swarm when pulling a published release image. |

The included Compose files accept convenience names such as `KINTUNNEL_PUBLIC_ENDPOINT`, `KINTUNNEL_WG_PORT`, and `KINTUNNEL_WG_DNS`, then map them to runtime variables. Direct Node runs should use the runtime names.

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

Store the admin token in `KINTUNNEL_ADMIN_TOKEN_FILE` for deployments where possible. Keep generated secrets out of public documentation, tickets, screenshots, and shell history.
