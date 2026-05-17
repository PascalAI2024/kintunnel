# ADR 0002: Split privileged engine from unprivileged admin service

Status: Accepted

Date: 2026-05-17

## Context

Managing WireGuard on Linux requires privileged operations: creating or updating an interface, applying peer configuration, enabling forwarding, and managing firewall or NAT rules. A web admin service should not need those privileges for ordinary UI and API work.

Putting all behavior in one privileged web process would enlarge the blast radius of an admin-plane compromise. That will compile, sir, but one would prefer not to defend it in an incident review.

## Decision

KinTunnel will use a two-service architecture:

- An unprivileged admin service owns authentication, authorization, API routing, validation, audit events, and persistent application state.
- A privileged WireGuard engine owns host/network changes and the active WireGuard interface.

The admin service may request engine operations through a narrow local control channel. The engine must expose only explicit commands needed to reconcile intended state into runtime state.

## Consequences

- The admin service can run without `NET_ADMIN`, host networking, raw socket access, or direct access to WireGuard private key material where avoidable.
- The engine becomes the security boundary for privileged operations.
- The engine API must be small, authenticated at the local boundary, and unavailable from the public network.
- Runtime deployment will need separate service definitions, volumes, and health checks.
- Tests should cover invalid admin requests failing before they reach privileged execution.
