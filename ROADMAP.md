# Roadmap

KinTunnel is the public project name. The repository slug is expected to become `kintunnel`.

This roadmap describes intent, not a release promise.

## Phase 0: Foundation

- Establish license, notices, contribution rules, and security policy.
- Keep project positioning distinct from `wg-easy`.
- Document WireGuard trademark boundaries.
- Preserve research notes and deployment assumptions.
- Keep the `KINTUNNEL_*` env namespace stable for the first public prototype.

## Phase 1: Minimum Usable Manager

- Docker Compose deployment for a single-node VPS.
- Admin authentication.
- Peer creation, listing, revocation, and export.
- QR-code onboarding.
- Persistent configuration volume.
- Basic backup and restore workflow.
- Health checks for `/dev/net/tun`, forwarding, and port exposure.

## Phase 2: Operator Safety

- Safer defaults for admin exposure.
- Audit log for peer lifecycle events.
- Configuration validation before apply.
- Upgrade notes and rollback guidance.
- Explicit support matrix for host platforms.
- Hardened container image and dependency review.

## Phase 3: Family-Scale Polish

- Friendly device labels and ownership tracking.
- Expiring invite links or short-lived enrollment flows.
- Clear lost-device revocation workflow.
- Usage and status summaries without excessive traffic inspection.
- Documentation for Dokploy and reverse proxy deployment.

## Later Considerations

- OpenVPN TCP 443 fallback for networks that block WireGuard UDP.
- Optional DNS filtering integration.
- IPv6 support hardening.
- Multi-admin roles.
- Import and migration tooling.

## Non-Goals

- Building an enterprise mesh networking platform.
- Replacing WireGuard.
- Becoming a hosted VPN service.
- Copying `wg-easy` code, UI, or documentation.
