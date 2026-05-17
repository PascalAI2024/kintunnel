# Troubleshooting

Start with the boring checks. They are boring because they usually work.

## Client Cannot Connect

Check:

- VPS firewall allows UDP `51820`.
- Cloud provider firewall allows UDP `51820`.
- `KINTUNNEL_ENDPOINT_HOST` resolves to the VPS public IP.
- Container is running.
- Client config endpoint matches the server DNS name and port.

Commands:

```sh
docker compose ps
docker compose logs --tail 100
ss -lunp | grep 51820
```

## Client Connects But No Internet

Check:

- IP forwarding is enabled.
- NAT rules are active.
- `AllowedIPs` is set for full tunnel.
- DNS server is reachable.
- VPS provider allows forwarding and NAT.

Client-side test:

```sh
curl https://ifconfig.me
nslookup example.com
```

## Admin UI Not Reachable

Check:

- UI port is bound to localhost as expected.
- SSH tunnel is open if using tunnel access.
- Reverse proxy target points to the correct container or localhost port.
- HTTPS certificate is valid.
- Admin token file exists and is mounted into the admin service.

## Slow Speeds

Likely causes:

- Small VPS CPU.
- Poor route between client and VPS region.
- MTU mismatch.
- Client is on weak Wi-Fi or mobile data.
- VPS provider throttling.

Try testing from a different network and region before changing the server.

## DNS Fails

Check `KINTUNNEL_DNS_SERVERS`. Use a known public resolver first:

```env
KINTUNNEL_DNS_SERVERS=1.1.1.1
```

If custom DNS filtering is added later, test it separately from WireGuard tunnel setup.

## Peer Was Shared Or Leaked

Delete the peer and create a new one. Peer configs are credentials.

## Useful References

- [Architecture](../architecture.md)
- [Full Tunnel](../configuration/full-tunnel.md)
- [Split Tunnel](../configuration/split-tunnel.md)
- [Security Model](../security/security-model.md)
- [Backups](../operations/backups.md)
