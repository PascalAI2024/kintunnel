# ADR 0001: WireGuard-first VPN engine

Status: Accepted

Date: 2026-05-17

## Context

KinTunnel is intended to provide a small trusted group with a private VPN exit through a VPS. The project needs a narrow, dependable data plane before it needs broad protocol coverage.

WireGuard is widely deployed, simple to operate, and has a small configuration surface compared with older VPN stacks. It also maps well to the intended peer lifecycle: create a keypair, assign an address, generate a client config, revoke the public key when access should end.

## Decision

KinTunnel will be WireGuard-first.

The first implementation will manage a single WireGuard interface on a single Linux host. The product model, API, engine behavior, and documentation will assume WireGuard as the primary VPN protocol.

Protocol fallback features, including OpenVPN over TCP 443, are later considerations and must not complicate the first runtime architecture.

## Consequences

- The data model can use WireGuard-native concepts: server keypair, peer public key, preshared key, allowed IPs, endpoint, keepalive, and latest handshake.
- The engine can rely on standard Linux WireGuard tooling and kernel support.
- The admin API should avoid generic multi-protocol abstractions until another protocol is truly designed.
- Networks that block UDP may not work in the first release. That is acceptable for the initial scope.
- WireGuard trademark references must remain factual and must not imply affiliation, sponsorship, or endorsement.
