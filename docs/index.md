# KinTunnel Documentation

KinTunnel is a small public VPN service built around a single Linux VPS, WireGuard, and Docker-first operations.

The MVP goal is straightforward: trusted users install the WireGuard client, import a peer profile, and route their internet traffic through the VPS public IP. This is a personal or small-group VPN, not a commercial VPN platform.

## Current Runtime

The repository now includes a runnable TypeScript MVP:

- Engine API for health, status, peer creation, peer lookup, config export, revoke/delete, and reconcile.
- Admin UI for token-authenticated peer workflows.
- Persistent JSON state for server and peer records.
- Dry-run mode for safe local and container evaluation.

Dry-run mode is the documented default for the MVP. It creates state and renders WireGuard client configs without changing host networking.

Non-dry-run reconcile is intentionally conservative and not production-ready. It checks basic WireGuard host capability and interface state, but production interface creation, peer replacement, firewall, NAT, and rollback behavior still need hardening.

## Start Here

- [Quick Start](quick-start.md)
- [Docker Compose Installation](installation/docker-compose.md)
- [Dokploy Swarm Installation](installation/dokploy-swarm.md)
- [Architecture](architecture.md)
- [Environment Variables](configuration/environment-variables.md)
- [Full Tunnel](configuration/full-tunnel.md)
- [Split Tunnel](configuration/split-tunnel.md)
- [Security Model](security/security-model.md)
- [Backups](operations/backups.md)
- [Troubleshooting](troubleshooting/index.md)
- [VPN Research Memo](vpn-research.md)

## Operating Assumptions

- One Linux VPS is the first supported deployment target.
- WireGuard is the VPN protocol.
- Full tunnel through the VPS public IP is the default client mode.
- Docker Compose is the preferred install path.
- Dry-run mode is the safe MVP default.
- Dokploy or Docker Swarm is supported only as a single-node deployment pattern for now.
- The admin UI must not be exposed casually. Put it behind HTTPS and restrict access where possible.
- The `KINTUNNEL_*` environment variable namespace is used for deployment settings.
- [VPN Research Memo](vpn-research.md) is preserved as historical research, not as the current implementation plan.

## Diagrams

Source Mermaid diagrams:

- [Architecture](diagrams/architecture.mmd)
- [Packet Flow](diagrams/packet-flow.mmd)
- [Onboarding Flow](diagrams/onboarding-flow.mmd)
- [Security Boundaries](diagrams/security-boundaries.mmd)
- [Backup and Restore](diagrams/backup-restore.mmd)
