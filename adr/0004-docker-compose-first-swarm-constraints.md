# ADR 0004: Docker Compose first, Swarm constrained

Status: Accepted

Date: 2026-05-17

## Context

The target operator is running a small self-hosted VPN on a VPS. Docker Compose is the simplest deployment shape for that audience and maps cleanly to a single stateful WireGuard endpoint.

Docker Swarm and Dokploy can be useful for lifecycle management and reverse proxy routing, but the VPN data plane is not horizontally scalable. WireGuard endpoint identity, peer address allocation, UDP port ownership, and NAT rules must resolve to one active node.

## Decision

KinTunnel will be Docker Compose first.

Swarm and Dokploy guidance may be documented, but only under explicit single-node or one-active-replica constraints:

- one active WireGuard engine;
- one authoritative persistent data volume;
- UDP port published in host mode where Swarm is used;
- placement constrained to the node that owns VPN state;
- admin service protected by HTTPS and access controls;
- no horizontal scaling of the WireGuard engine.

## Consequences

- First-party examples should prioritize `compose.yml` and `.env` workflows.
- Swarm examples must include replica and placement constraints.
- The product should not advertise automatic failover, multi-region routing, or clustered WireGuard state.
- Backups, restores, and migrations are maintenance operations, not transparent distributed systems features.
- Health checks should distinguish admin health from engine/data-plane health.
