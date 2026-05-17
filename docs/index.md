# KinTunnel Documentation

KinTunnel is a small public VPN service built around a single Linux VPS, WireGuard, and Docker-first operations.

The MVP goal is straightforward: trusted users install the WireGuard client, import a peer profile, and route their internet traffic through the VPS public IP. This is a personal or small-group VPN, not a commercial VPN platform.

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
- Dokploy or Docker Swarm is supported only as a single-node deployment pattern for now.
- The admin UI must not be exposed casually. Put it behind HTTPS and restrict access where possible.
- The `KINTUNNEL_*` environment variable namespace is used for deployment settings.

## Diagrams

Source Mermaid diagrams:

- [Architecture](diagrams/architecture.mmd)
- [Packet Flow](diagrams/packet-flow.mmd)
- [Onboarding Flow](diagrams/onboarding-flow.mmd)
- [Security Boundaries](diagrams/security-boundaries.mmd)
- [Backup and Restore](diagrams/backup-restore.mmd)
