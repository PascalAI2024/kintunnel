# Data Model Specification

Status: Draft for future implementation

Date: 2026-05-17

## Scope

This spec defines the intended application data model for a single-server, WireGuard-first KinTunnel deployment. It describes persisted admin-plane state, not every runtime statistic reported by the kernel.

## Principles

- One peer represents one WireGuard client configuration.
- A peer may belong to a person or directly to an unmanaged device.
- Private key material is sensitive and must be encrypted at rest where practical.
- Runtime state can be recomputed from intended state.
- Deletion should be explicit and auditable; soft deletion is preferred for user-facing lifecycle records.

## Entities

### Person

A person is a human member of the trusted group.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | UUID | yes | Stable internal identifier. |
| `display_name` | string | yes | Human-readable name. |
| `email` | string | no | Optional contact/admin reference. |
| `role` | enum | yes | `owner`, `admin`, or `member`. MVP may support only `owner` and `member`. |
| `status` | enum | yes | `active`, `disabled`, or `deleted`. |
| `notes` | string | no | Operator notes. Not shown in client configs. |
| `created_at` | timestamp | yes | UTC. |
| `updated_at` | timestamp | yes | UTC. |
| `disabled_at` | timestamp | no | Set when access is disabled. |

### Device

A device is a physical or logical client endpoint owned by a person.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | UUID | yes | Stable internal identifier. |
| `person_id` | UUID | no | Nullable for unmanaged service devices. |
| `label` | string | yes | Example: `Alice iPhone`. |
| `device_type` | enum | no | `phone`, `tablet`, `laptop`, `desktop`, `router`, `server`, or `other`. |
| `status` | enum | yes | `active`, `lost`, `retired`, `disabled`, or `deleted`. |
| `notes` | string | no | Operator notes. |
| `created_at` | timestamp | yes | UTC. |
| `updated_at` | timestamp | yes | UTC. |
| `retired_at` | timestamp | no | Set when the device is no longer expected to connect. |

### Peer

A peer is the WireGuard identity and network assignment for one client config.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | UUID | yes | Stable internal identifier. |
| `device_id` | UUID | no | Recommended. Nullable for imported or temporary peers. |
| `name` | string | yes | Unique display/config name, for example `alice-iphone`. |
| `public_key` | string | yes | WireGuard public key. Unique. |
| `private_key_ref` | string | no | Reference to encrypted private key storage if generated server-side. |
| `preshared_key_ref` | string | no | Reference to encrypted preshared key storage. |
| `address_v4` | CIDR address | yes | Client tunnel address, for example `10.8.0.2/32`. |
| `address_v6` | CIDR address | no | Client IPv6 tunnel address. |
| `allowed_ips` | CIDR list | yes | Routes placed in generated client config. |
| `dns_servers` | IP list | no | Optional per-peer DNS override. |
| `persistent_keepalive` | integer | no | Seconds. Common default: `25`. |
| `status` | enum | yes | `active`, `disabled`, `revoked`, or `deleted`. |
| `expires_at` | timestamp | no | Future enrollment or temporary access support. |
| `created_at` | timestamp | yes | UTC. |
| `updated_at` | timestamp | yes | UTC. |
| `revoked_at` | timestamp | no | Set when the peer must no longer be applied. |
| `last_handshake_at` | timestamp | no | Cached observation from engine/runtime. |
| `transfer_rx_bytes` | integer | no | Cached runtime counter. |
| `transfer_tx_bytes` | integer | no | Cached runtime counter. |

Private keys should only be retained if KinTunnel generates downloadable configs after creation. If the implementation uses client-generated keys, `private_key_ref` must be null.

### Server Settings

Server settings define intended WireGuard interface and deployment behavior.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | string | yes | Singleton key, for example `default`. |
| `server_public_key` | string | yes | Derived from server private key. |
| `server_private_key_ref` | string | yes | Reference to encrypted private key storage. |
| `interface_name` | string | yes | Default: `wg0`. |
| `listen_port` | integer | yes | Default: `51820`. |
| `endpoint_host` | string | yes | DNS name or IP used in client configs. |
| `endpoint_port` | integer | yes | Usually same as `listen_port`. |
| `tunnel_cidr_v4` | CIDR | yes | Example: `10.8.0.0/24`. |
| `tunnel_cidr_v6` | CIDR | no | Optional. |
| `default_allowed_ips` | CIDR list | yes | Full tunnel default: `0.0.0.0/0`. |
| `default_dns_servers` | IP list | no | Client DNS defaults. |
| `mtu` | integer | no | Optional WireGuard MTU. |
| `nat_enabled` | boolean | yes | Whether engine manages NAT rules. |
| `forwarding_required` | boolean | yes | Whether engine requires host forwarding. |
| `admin_base_url` | URL | no | Used for future invite links. |
| `updated_at` | timestamp | yes | UTC. |

## Relationships

- `Person 1 -> many Device`
- `Device 0..1 -> many Peer`
- `Server Settings 1 -> many Peer`

## Lifecycle Rules

- Disabling a person should disable that person's active peers.
- Marking a device as `lost` should revoke its peers immediately.
- Revoked peers must not be applied to the WireGuard interface.
- Peer IP addresses must remain unique among non-deleted peers.
- Peer public keys must remain globally unique.
- Audit events should record create, update, disable, revoke, export, and delete actions.

## Open Questions

- Whether MVP stores client private keys after first export.
- Whether multi-admin accounts ship in MVP or remain a later role model.
- Whether soft-deleted peer IPs are reusable by default or only after operator confirmation.
