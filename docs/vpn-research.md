# VPS VPN Research Memo

Date: 2026-05-16

Historical note: this memo is preserved as early prior-art and deployment research. Later planning chose an original KinTunnel codebase with separate engine and admin services, placeholder project images, and standard WireGuard tooling rather than a `wg-easy` deployment or fork.

## Goal

Set up a VPN service on a VPS, managed around Dokploy/Docker Swarm, so friends and family can install a client on Android, iOS, macOS, Windows, or Linux and route their internet traffic through the VPS public IP.

## Short Recommendation

Use **WireGuard with wg-easy**.

This is the best fit for a personal/family VPN because it is fast, simple to administer, has official clients for every major platform, and `wg-easy` gives an admin UI with QR-code onboarding.

Do not start with NetBird, Tailscale, Headscale, or Netmaker for this specific goal. Those are better when the main problem is private network access, employee identity, ACLs, device posture, and offboarding.

## Best Direction

1. Deploy **wg-easy** as a single VPN service.
2. Publish the WireGuard UDP port directly, usually `51820/udp`.
3. Put the `wg-easy` web UI behind HTTPS through Dokploy/Traefik.
4. Protect the admin UI with a strong credential and ideally IP allowlisting or private access.
5. Create one peer per person/device.
6. Have users install the WireGuard app and scan a QR code.
7. Configure clients as full tunnel so traffic exits through the VPS IP:

```ini
AllowedIPs = 0.0.0.0/0, ::/0
```

## WireGuard vs OpenVPN

| Category | WireGuard | OpenVPN |
|---|---|---|
| Speed | Usually faster, lower CPU | Good, better with DCO, but generally heavier |
| Setup | Simple keys/config files | More moving parts: certs, TLS, profiles |
| Onboarding | Excellent with QR codes via `wg-easy` | Good with `.ovpn` files or OpenVPN Access Server |
| Client app | WireGuard app required | OpenVPN Connect app required |
| Mobile roaming | Very good across Wi-Fi/cellular | Good, but heavier |
| Docker fit | Simple single UDP service | Works, but more complex and privileged |
| Firewall traversal | UDP only by default; can be blocked | Can run UDP or TCP, including TCP 443 |
| Admin UI | `wg-easy` is simple and free | Access Server is polished but paid after 2 free connections |
| Best use | Family/friends VPN through VPS IP | Legacy compatibility or TCP fallback |

Verdict: **WireGuard first. OpenVPN only if UDP blocking or legacy compatibility becomes a problem.**

## Built-In OS VPN Protocols

If avoiding apps is more important than simplicity/performance, the modern built-in protocol is **IKEv2/IPsec**, usually implemented on the server with `strongSwan`.

IKEv2/IPsec works with built-in clients on Apple platforms, Windows, and many Android versions. However, it is more tedious to support:

- Server certificates are required.
- Windows has certificate requirements.
- Android support varies by device/version/vendor.
- Users may need CA/profile installation.
- UDP `500` and `4500` must be open.
- It is fussier to run correctly in Docker/Swarm.

Verdict: **IKEv2/IPsec is the no-app option, but WireGuard is easier for real people.**

## Dokploy / Docker Swarm Notes

VPN data-plane services should not be treated like normal replicated web apps.

Recommended pattern:

```yaml
ports:
  - target: 51820
    published: 51820
    protocol: udp
    mode: host
deploy:
  replicas: 1
  placement:
    constraints:
      - node.labels.vpn == true
```

Important operational notes:

- Run one VPN instance, not replicas.
- Avoid Swarm routing mesh for the VPN UDP port.
- Persist WireGuard state/config, usually `/etc/wireguard`.
- Pin the service to the node that owns the volume.
- Use Traefik/Dokploy only for HTTP admin UI, not for the WireGuard tunnel.
- Ensure `/dev/net/tun`, IP forwarding, and host firewall/NAT are configured.

Host checks:

```bash
modprobe tun
test -c /dev/net/tun
sysctl -w net.ipv4.ip_forward=1
```

## Options Reviewed

### WireGuard + wg-easy

Best fit for this project. Simple personal VPN with a web UI, QR codes, and first-class client apps.

Use this first.

### OpenVPN Access Server

Mature and polished. Good if you want a traditional VPN admin portal or TCP 443 fallback. The downside is licensing after the free connection limit and a heavier stack.

Use only if WireGuard is blocked or if OpenVPN compatibility is required.

### IKEv2/IPsec with strongSwan

Best no-app option. More complicated to configure and support. Good for users who insist on built-in VPN profiles.

Use only if avoiding apps is a hard requirement.

### Tailscale / Headscale / NetBird

Excellent for employee/private-resource access, identity, ACLs, and offboarding. Not ideal for this simple “use my VPS IP as a VPN exit” goal unless you want a full mesh network.

Do not use as the first family/friends VPN.

### Netmaker / Pritunl / Firezone / Outline

Useful in specific cases, but not the best first choice here:

- Netmaker: heavier network platform.
- Pritunl: mature but heavier, more enterprise/admin-centric.
- Firezone: self-host production support has caveats.
- Outline: Shadowsocks proxy, useful for censorship bypass, not a normal VPN replacement.

## Possible Fallbacks

If WireGuard is blocked on some networks:

1. Try changing the WireGuard UDP port, possibly to `443/udp`.
2. Add **OpenVPN TCP 443** as a compatibility fallback.
3. For censorship-heavy countries, consider **AmneziaWG** or **VLESS/REALITY**, but those are not the first-choice family VPN stack.

## Security Notes

- Create separate peers per user/device.
- Revoke a peer immediately if a device is lost.
- Do not share one profile among multiple people.
- Keep the admin UI private or strongly protected.
- Back up the WireGuard config volume.
- Log enough to debug, but be clear with users about what you operate and what the VPS provider can see.
- Make sure friends/family understand that traffic exits through your server and your VPS account is responsible for abuse complaints.

## Source Links

- WireGuard: https://www.wireguard.com/
- wg-easy docs: https://wg-easy.github.io/wg-easy/v15.2/getting-started/
- wg-easy GitHub: https://github.com/wg-easy/wg-easy
- Docker Swarm routing mesh: https://docs.docker.com/engine/swarm/ingress/
- Docker service create: https://docs.docker.com/reference/cli/docker/service/create/
- Dokploy Docker Compose: https://docs.dokploy.com/docs/core/docker-compose
- OpenVPN Docker docs: https://openvpn.net/as-docs/v3/docker.html
- OpenVPN pricing: https://openvpn.net/access-server/pricing/
- Windows built-in VPN protocols: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/vpn/vpn-connection-type
- Apple VPN payloads: https://developer.apple.com/documentation/devicemanagement/vpn
- Android IKEv2/IPsec library: https://source.android.google.cn/docs/core/ota/modular-system/ipsec
- strongSwan: https://strongswan.org/
- NetBird architecture: https://docs.netbird.io/about-netbird/how-netbird-works
- Headscale: https://github.com/juanfont/headscale
- AmneziaWG: https://docs.amnezia.org/documentation/amnezia-wg/
