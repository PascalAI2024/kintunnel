# Full Tunnel Configuration

Full tunnel mode routes all client internet traffic through the VPS. This is the default MVP mode because the product goal is to make client traffic exit from the VPS public IP.

## Client Route

IPv4:

```ini
AllowedIPs = 0.0.0.0/0
```

IPv4 and IPv6:

```ini
AllowedIPs = 0.0.0.0/0, ::/0
```

## Server Requirements

The VPS must:

- Accept WireGuard UDP traffic on the configured port.
- Enable IP forwarding.
- Perform NAT from the WireGuard subnet to the public interface.
- Allow established return traffic.
- Provide DNS that clients can reach through the tunnel.

## Verification

From a connected client:

```sh
curl https://ifconfig.me
```

Expected result: the VPS public IP.

Also test DNS:

```sh
nslookup example.com
```

## Client Expectations

When full tunnel is active:

- Public IP becomes the VPS IP.
- Local network access may change depending on client settings.
- Traffic speed is bounded by the VPS network, CPU, and route quality.
- Some services may challenge logins because the apparent location changed.

## When Not To Use Full Tunnel

Use split tunnel when users only need access to private services behind the VPS and do not need general internet egress through the VPS.

