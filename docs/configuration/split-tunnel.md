# Split Tunnel Configuration

Split tunnel mode routes only selected networks through WireGuard. General internet traffic stays on the user's normal network.

This is not the default MVP mode, but it is useful for admin access, private dashboards, or future internal services.

## Client Route Examples

Route only the WireGuard subnet:

```ini
AllowedIPs = 10.8.0.0/24
```

Route a private service subnet:

```ini
AllowedIPs = 10.8.0.0/24, 10.10.0.0/16
```

## Tradeoffs

| Mode | Benefit | Cost |
|---|---|---|
| Full tunnel | Public traffic exits through the VPS IP. | More bandwidth, more VPS dependency. |
| Split tunnel | Less bandwidth and fewer client surprises. | Public IP remains the user's local network. |

## DNS Considerations

Split tunnel DNS can be awkward. If private hostnames are required, use one of these patterns:

- Push an internal DNS server reachable through the tunnel.
- Use explicit private IP addresses for admin-only services.
- Keep public DNS names resolving to private tunnel addresses only for trusted users.

Document the chosen pattern before adding more users. Future-you is unlikely to enjoy detective work.

