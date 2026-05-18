<p align="center">
  <img src="docs/assets/kintunnel-logo.svg" alt="KinTunnel" width="720">
</p>

<p align="center">
  <a href="https://github.com/PascalAI2024/kintunnel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/PascalAI2024/kintunnel/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/PascalAI2024/kintunnel/actions/workflows/docs.yml"><img alt="Docs" src="https://github.com/PascalAI2024/kintunnel/actions/workflows/docs.yml/badge.svg"></a>
  <a href="https://github.com/PascalAI2024/kintunnel/actions/workflows/security.yml"><img alt="Security" src="https://github.com/PascalAI2024/kintunnel/actions/workflows/security.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

KinTunnel is an original, Docker-native family VPN manager for WireGuard deployments.

It is built for one simple job: give trusted people a private VPN exit through a VPS without turning the project into an enterprise mesh networking platform. Sensible. Almost suspiciously so.

## Why KinTunnel

- One VPS.
- One WireGuard server.
- One peer per person or device.
- QR-code and config-based onboarding.
- A private admin UI for lifecycle work.
- Docker Compose first, with a Dokploy/Swarm reference for single-node deployments.

KinTunnel is not a hosted VPN provider, a WireGuard replacement, a corporate zero-trust suite, or a `wg-easy` fork.

## Current Status

KinTunnel has a runnable TypeScript MVP.

| Area | Status |
|---|---|
| Engine API | Health, status, peer lifecycle, config export, audit events, and reconcile endpoints. |
| Admin UI | Token login, peer list, peer creation, QR rendering, config download, revoke, delete, and recent activity. |
| Docker | Engine and admin Dockerfiles, Compose model, minimal VPS overlay, and Dokploy/Swarm reference. |
| Tests | Unit and process-level integration coverage for the dry-run runtime. |
| Safe default | `KINTUNNEL_DRY_RUN=true`, which validates state and renders configs without changing host networking. |
| Not finished | Production-grade host networking apply, NAT/firewall management, rollback, and live VPS validation. |

Treat real host networking as experimental until the reconcile path is hardened. The project says that out loud because denial is a poor deployment strategy.

## Quick Start

Run the engine and admin UI locally in dry-run mode:

```bash
git clone https://github.com/PascalAI2024/kintunnel.git
cd kintunnel
npm ci
npm test
KINTUNNEL_ENV=development KINTUNNEL_DRY_RUN=true KINTUNNEL_ENGINE_API_TOKEN=dev-engine-token-change-me KINTUNNEL_ENGINE_PORT=9090 npm run dev:engine
```

In another shell:

```bash
KINTUNNEL_ENV=development KINTUNNEL_ADMIN_TOKEN=dev-admin-token-change-me KINTUNNEL_ENGINE_API_TOKEN=dev-engine-token-change-me KINTUNNEL_ENGINE_URL=http://127.0.0.1:9090 npm run dev:admin
```

Open `http://127.0.0.1:8080` and sign in with the token.

## Docker From Source

```bash
cp .env.example .env
mkdir -p config/secrets
openssl rand -base64 32 > config/secrets/admin-token.txt
openssl rand -base64 32 > config/secrets/engine-api-token.txt
docker compose --profile admin build
docker compose --profile admin up -d
docker compose ps
```

For the MVP, leave `KINTUNNEL_DRY_RUN=true` unless you are deliberately testing host networking on a Linux VPS.

## Architecture

```mermaid
flowchart LR
    devices["Family devices<br>WireGuard clients"] --> tunnel["WireGuard UDP tunnel"]
    tunnel --> engine["KinTunnel engine<br>state, config, reconcile"]
    admin["Admin browser"] --> ui["KinTunnel admin UI"]
    ui --> engine
    engine --> store["Persistent JSON state<br>server keys, peers, audit events"]
    engine --> wg["Standard WireGuard tooling"]
    wg --> internet["Internet via VPS public IP"]
```

Design principles:

- Keep the VPN data plane boring and standard.
- Keep the admin plane private, authenticated, and auditable.
- Prefer explicit single-node deployment over accidental clustered VPN state.
- Treat generated peer configs as sensitive material.

## VPS Requirements

Minimum host expectations for non-dry-run testing:

- Linux VPS with Docker Engine.
- UDP port for WireGuard, commonly `51820/udp`.
- HTTPS reverse proxy or SSH tunnel for the admin UI.
- `/dev/net/tun` available to the engine container.
- IPv4 forwarding and firewall/NAT configured on the host.

Host checks:

```bash
test -c /dev/net/tun
sysctl net.ipv4.ip_forward
```

## Documentation

- [Quick Start](docs/quick-start.md)
- [Docker Compose Installation](docs/installation/docker-compose.md)
- [Dokploy Swarm Installation](docs/installation/dokploy-swarm.md)
- [Architecture](docs/architecture.md)
- [Security Model](docs/security/security-model.md)
- [Brand](docs/brand.md)
- [Release Checklist](docs/release-checklist.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

The research memo is retained as a historical note: [VPN Research Memo](docs/vpn-research.md).

## Security Summary

This project manages VPN access. Boring security is not optional.

- Create one peer per person or device.
- Revoke lost devices immediately.
- Do not share peer profiles across users.
- Keep the admin UI behind HTTPS, IP allowlisting, an SSH tunnel, or an identity-aware proxy.
- Back up the config volume securely.
- Remember that traffic exits through the VPS public IP. The VPS owner remains responsible for provider terms, abuse reports, and local law.

See [SECURITY.md](SECURITY.md) for reporting guidance. Vulnerabilities should be reported through [GitHub private vulnerability reporting](https://github.com/PascalAI2024/kintunnel/security/advisories/new), not public issues.

## Trademark Notice

WireGuard is a registered trademark of Jason A. Donenfeld. KinTunnel is not affiliated with, endorsed by, sponsored by, or approved by Jason A. Donenfeld or the WireGuard project.

The `KINTUNNEL_*` environment variable namespace is used for deployment configuration.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
