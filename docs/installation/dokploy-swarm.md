# Dokploy Swarm Installation

Dokploy or Docker Swarm can host the MVP as a single-node deployment. Do not scale the VPN service beyond one replica.

Use `KINTUNNEL_DRY_RUN=true` for MVP evaluation. Non-dry-run reconcile is still conservative and should be treated as host-networking test work, not production WireGuard automation.

The reference Swarm stack is dry-run first. If your Dokploy or Swarm path does
not provide `/dev/net/tun` to the engine container, keep dry-run enabled.

## Constraints

- One active node.
- One KinTunnel engine replica.
- One KinTunnel admin replica.
- UDP `51820` published in host mode.
- Persistent storage pinned to the same node.
- Admin UI protected behind HTTPS and access control.

## Recommended Swarm Shape

Label the node that owns VPN state:

```sh
docker node update --label-add kintunnel.vpn=true <node-name>
```

Use `compose/dokploy-swarm.yml` as the reference stack. Swarm does not build
images from a stack file, so set `KINTUNNEL_ENGINE_IMAGE` and
`KINTUNNEL_ADMIN_IMAGE` to images you have already published.

The core shape is:

```yaml
services:
  engine:
    image: ${KINTUNNEL_ENGINE_IMAGE}
    environment:
      KINTUNNEL_DRY_RUN: ${KINTUNNEL_DRY_RUN:-true}
      KINTUNNEL_ENDPOINT_HOST: ${KINTUNNEL_PUBLIC_ENDPOINT}
      KINTUNNEL_ENDPOINT_PORT: ${KINTUNNEL_WG_PORT:-51820}
      KINTUNNEL_WG_INTERFACE: ${KINTUNNEL_WG_INTERFACE:-wg0}
      KINTUNNEL_WG_LISTEN_PORT: ${KINTUNNEL_WG_PORT:-51820}
      KINTUNNEL_WG_ADDRESS: ${KINTUNNEL_WG_ADDRESS:-10.44.0.1/24}
      KINTUNNEL_DNS_SERVERS: ${KINTUNNEL_WG_DNS:-1.1.1.1}
      KINTUNNEL_ALLOWED_IPS: ${KINTUNNEL_ALLOWED_IPS:-0.0.0.0/0}
      KINTUNNEL_DATA_DIR: /var/lib/kintunnel
    volumes:
      - kintunnel_config:/etc/kintunnel:ro
      - kintunnel_data:/var/lib/kintunnel
      - kintunnel_backups:/backups
    ports:
      - target: ${KINTUNNEL_WG_PORT:-51820}
        published: ${KINTUNNEL_WG_PORT:-51820}
        protocol: udp
        mode: host
    cap_add:
      - NET_ADMIN
    sysctls:
      net.ipv4.ip_forward: "1"
      net.ipv4.conf.all.src_valid_mark: "1"
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.kintunnel.vpn == true
      restart_policy:
        condition: any

  admin:
    image: ${KINTUNNEL_ADMIN_IMAGE}
    environment:
      KINTUNNEL_ADMIN_BIND: 0.0.0.0
      KINTUNNEL_ADMIN_PORT: 8080
      KINTUNNEL_ENGINE_URL: http://engine:9090
      KINTUNNEL_ADMIN_TOKEN_FILE: /run/secrets/kintunnel_admin_token
    volumes:
      - kintunnel_config:/etc/kintunnel:ro
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.kintunnel.vpn == true
      restart_policy:
        condition: any

volumes:
  kintunnel_config:
  kintunnel_data:
  kintunnel_backups:
```

## Dokploy Notes

Use Dokploy for lifecycle management and HTTPS routing around the admin UI, not for scaling the VPN data plane.

Practical guidance:

- Keep the WireGuard UDP port published directly.
- Keep the admin UI behind Dokploy/Traefik HTTPS.
- Restrict the admin UI by source IP if Dokploy routing supports it.
- Back up the named volume before moving nodes or rebuilding the VPS.
- Treat migration as a maintenance event.

## Why Single Node

WireGuard peers and server keys are stateful. UDP port ownership, peer config, and NAT behavior all assume one active server endpoint. Swarm can restart the service, but it should not schedule multiple active copies.
