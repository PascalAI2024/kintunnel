# WireGuard Engine Specification

Status: Draft for future implementation

Date: 2026-05-17

## Scope

The WireGuard engine is the privileged runtime component that reconciles intended VPN state into the Linux host/container networking environment.

The engine is not the admin API, not the UI backend, and not a general command runner. It should be boring. Boring is the point.

## Responsibilities

The engine owns:

- creating, updating, and deleting the WireGuard interface;
- applying server private key, listen port, and peer public keys;
- adding and removing peers from the active interface;
- configuring peer allowed IPs on the server side;
- validating address uniqueness and WireGuard key format before apply;
- enabling or verifying required forwarding settings;
- creating or verifying NAT/firewall rules when configured to manage them;
- reporting runtime status, including interface existence, listen port, peer handshake timestamps, and transfer counters;
- reconciling active runtime state with intended admin state;
- returning structured errors when host capabilities are missing.

The admin service owns:

- authentication and authorization;
- person, device, and peer metadata;
- audit logging;
- API request validation;
- UI session behavior;
- backup orchestration;
- long-term application database state.

## Security Boundary

The engine is privileged. Treat every request as hostile unless it arrives over the approved local channel from the admin service.

Required boundaries:

- Engine control API must bind only to a private local socket or internal network.
- Engine must not be published through the reverse proxy.
- Engine commands must be allowlisted operations, not shell command strings.
- Engine must reject unknown fields and invalid state transitions.
- Engine logs must not contain private keys, preshared keys, client configs, QR payloads, or admin credentials.
- Engine should run with the minimum required Linux capabilities, expected to include `NET_ADMIN` and possibly `SYS_MODULE` depending on deployment.
- Admin service should not mount or read engine-only secret files unless explicitly required for backup.

## Control Channel

Preferred local channel:

- Unix domain socket when services share a host namespace or mounted socket path.
- Internal Docker network HTTP/gRPC endpoint only if the service is unreachable from public ingress.

Every command should include:

- request id;
- desired config generation or revision;
- operation type;
- complete desired state for reconciliation where practical.

The engine should be idempotent. Repeating the same reconcile request should produce the same runtime state.

## Commands

| Command | Purpose |
|---|---|
| `GetCapabilities` | Report WireGuard tooling, kernel support, iptables/nftables availability, and forwarding visibility. |
| `ValidateConfig` | Validate intended server and peer state without changing runtime. |
| `Reconcile` | Apply complete intended state to the active interface. |
| `GetRuntimeState` | Return interface and peer runtime observations. |
| `StopInterface` | Stop WireGuard interface for maintenance. |
| `StartInterface` | Start WireGuard interface from intended state. |
| `RotateServerKeyPlan` | Produce validation and impact summary for future key rotation. |

MVP may implement only `GetCapabilities`, `ValidateConfig`, `Reconcile`, and `GetRuntimeState`.

## Reconciliation Behavior

Input to `Reconcile` should include:

- server interface name;
- listen port;
- server private key reference or resolved secret;
- tunnel CIDRs;
- NAT/forwarding policy;
- active peers only;
- config revision.

The engine should:

1. Load and validate secrets through the approved secret path.
2. Validate interface settings and peer address uniqueness.
3. Create or update the WireGuard interface.
4. Apply server listen port and private key.
5. Replace active peer set to match intended state.
6. Ensure forwarding and NAT rules if enabled.
7. Report final runtime summary and applied revision.

Revoked, disabled, deleted, or expired peers must not be applied.

## Host Requirements

The engine should detect and report:

- Linux host;
- `/dev/net/tun` availability where required;
- WireGuard kernel module or userspace implementation availability;
- `wg` tooling availability if used;
- IPv4 forwarding state;
- IPv6 forwarding state when IPv6 is configured;
- ability to manage iptables or nftables rules;
- bindability of the configured UDP listen port.

## Failure Modes

| Failure | Expected behavior |
|---|---|
| Invalid peer key | Reject config before partial apply. |
| Duplicate peer address | Reject config before partial apply. |
| Missing host capability | Return explicit readiness error. |
| NAT rule apply failure | Mark reconciliation failed and report rollback status. |
| Engine restart | Recover by reading intended state and reconciling. |
| Admin unavailable | Keep existing WireGuard runtime state if safe. |

## Observability

Engine logs should be structured and sparse:

- request id;
- config revision;
- operation;
- result;
- duration;
- error code;
- count of peers applied.

Metrics may include engine readiness, reconcile success/failure counts, last applied revision, active peer count, and interface status.

## Non-Goals

- Public REST API.
- Admin authentication.
- UI rendering.
- Multi-node coordination.
- Running arbitrary shell commands from admin input.
- Deep traffic inspection.

