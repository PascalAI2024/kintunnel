# Admin API Specification

Status: Draft for future implementation

Date: 2026-05-17

## Scope

This spec defines the future unprivileged admin API. It does not expose the privileged engine API. Public clients should never call the engine directly.

All endpoints are versioned under `/api/v1`.

## API Principles

- JSON request and response bodies.
- Authentication required for all endpoints except setup bootstrap, login, health, and readiness where explicitly allowed.
- Mutating operations must produce audit events.
- Peer config and QR responses contain secrets and must be short-lived, access-controlled, and excluded from ordinary logs.
- Validation errors return field-level details.

## Authentication

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/setup` | First-admin bootstrap when no admin exists. Disabled after setup. |
| `POST` | `/api/v1/auth/login` | Create admin session or token. |
| `POST` | `/api/v1/auth/logout` | Revoke current session. |
| `GET` | `/api/v1/auth/me` | Return current authenticated admin. |

Future implementations may use secure cookies for browser sessions and bearer tokens for automation. CSRF protection is required for cookie-authenticated browser writes.

## Health

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Admin process liveness. No secret data. |
| `GET` | `/api/v1/readiness` | Admin store and engine connectivity readiness. |
| `GET` | `/api/v1/status` | Authenticated summary of server, interface, and peer counts. |

## People

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/people` | List people. |
| `POST` | `/api/v1/people` | Create person. |
| `GET` | `/api/v1/people/{person_id}` | Read person. |
| `PATCH` | `/api/v1/people/{person_id}` | Update person. |
| `POST` | `/api/v1/people/{person_id}/disable` | Disable person and associated active peers. |
| `POST` | `/api/v1/people/{person_id}/restore` | Restore disabled person without automatically restoring peers. |
| `DELETE` | `/api/v1/people/{person_id}` | Soft-delete person if no active devices remain. |

## Devices

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/devices` | List devices, filterable by person and status. |
| `POST` | `/api/v1/devices` | Create device. |
| `GET` | `/api/v1/devices/{device_id}` | Read device. |
| `PATCH` | `/api/v1/devices/{device_id}` | Update label, owner, type, or notes. |
| `POST` | `/api/v1/devices/{device_id}/mark-lost` | Mark lost and revoke associated peers. |
| `POST` | `/api/v1/devices/{device_id}/retire` | Retire device and disable associated peers. |
| `DELETE` | `/api/v1/devices/{device_id}` | Soft-delete device if no active peers remain. |

## Peers

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/peers` | List peers, filterable by status, person, or device. |
| `POST` | `/api/v1/peers` | Create peer and enqueue/apply engine reconciliation. |
| `GET` | `/api/v1/peers/{peer_id}` | Read peer metadata and runtime summary. |
| `PATCH` | `/api/v1/peers/{peer_id}` | Update metadata and safe config fields. |
| `POST` | `/api/v1/peers/{peer_id}/disable` | Disable peer without deleting record. |
| `POST` | `/api/v1/peers/{peer_id}/enable` | Re-enable disabled peer after validation. |
| `POST` | `/api/v1/peers/{peer_id}/revoke` | Permanently revoke peer access. |
| `DELETE` | `/api/v1/peers/{peer_id}` | Soft-delete revoked or disabled peer. |
| `GET` | `/api/v1/peers/{peer_id}/config` | Return WireGuard client config if authorized. |
| `GET` | `/api/v1/peers/{peer_id}/qr` | Return QR image or payload for onboarding. |

Peer create request fields:

| Field | Required | Notes |
|---|---:|---|
| `name` | yes | Unique peer name. |
| `person_id` | no | Existing person. |
| `device_id` | no | Existing device. |
| `public_key` | no | Required for client-generated key mode. |
| `generate_keys` | no | Server-generated key mode. |
| `allowed_ips` | no | Defaults from server settings. |
| `dns_servers` | no | Defaults from server settings. |
| `expires_at` | no | Future temporary access support. |

## Server Settings

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/server/settings` | Read intended server settings. |
| `PATCH` | `/api/v1/server/settings` | Update safe settings and validate before apply. |
| `POST` | `/api/v1/server/validate` | Validate intended config without applying. |
| `POST` | `/api/v1/server/reconcile` | Request engine reconciliation. |
| `GET` | `/api/v1/server/runtime` | Read authenticated runtime state from engine. |

Settings changes that affect endpoint, address pools, keys, NAT, or listen port must return validation warnings before apply if they can disrupt active clients.

## Audit

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/audit-events` | List audit events with pagination. |
| `GET` | `/api/v1/audit-events/{event_id}` | Read one audit event. |

Audit records should include actor, action, target type, target id, timestamp, request id, source IP, and redacted metadata.

## Backups

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/backups` | Create encrypted backup archive. |
| `GET` | `/api/v1/backups` | List known local backups. |
| `GET` | `/api/v1/backups/{backup_id}` | Download backup if authorized. |
| `POST` | `/api/v1/backups/restore-plan` | Validate backup and show restore impact. |

Actual restore may require maintenance mode and should not be a casual web click. Sensible, if unfashionable.

## Error Shape

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request validation failed.",
    "fields": {
      "name": ["must be unique"]
    },
    "request_id": "req_..."
  }
}
```

## Open Questions

- Exact session mechanism and token format.
- Whether backup restore is API-driven in MVP.
- Whether QR output is PNG, SVG, or a JSON payload consumed by the UI.

