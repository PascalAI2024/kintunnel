# Dokploy Swarm Installation

Dokploy or Docker Swarm can host the MVP as a single-node deployment. Do not scale the VPN service beyond one replica.

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
docker node update --label-add vpn=true <node-name>
```

Use a stack file similar to:

```yaml
services:
  engine:
    image: ${KINTUNNEL_ENGINE_IMAGE:-ghcr.io/pascalai2024/kintunnel-engine:dev}
    environment:
      KINTUNNEL_PUBLIC_ENDPOINT: ${KINTUNNEL_PUBLIC_ENDPOINT}
      KINTUNNEL_WG_INTERFACE: ${KINTUNNEL_WG_INTERFACE:-wg0}
      KINTUNNEL_WG_PORT: ${KINTUNNEL_WG_PORT:-51820}
      KINTUNNEL_WG_ADDRESS: ${KINTUNNEL_WG_ADDRESS:-10.44.0.1/24}
      KINTUNNEL_WG_DNS: ${KINTUNNEL_WG_DNS:-1.1.1.1}
      KINTUNNEL_ALLOWED_IPS: ${KINTUNNEL_ALLOWED_IPS:-0.0.0.0/0}
      KINTUNNEL_DATA_DIR: /var/lib/kintunnel
      KINTUNNEL_CONFIG_FILE: /etc/kintunnel/kintunnel.yml
    volumes:
      - kintunnel_config:/etc/kintunnel:ro
      - kintunnel_data:/var/lib/kintunnel
      - kintunnel_backups:/backups
    ports:
      - target: 51820
        published: ${KINTUNNEL_WG_PORT:-51820}
        protocol: udp
        mode: host
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      net.ipv4.ip_forward: "1"
      net.ipv4.conf.all.src_valid_mark: "1"
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.vpn == true
      restart_policy:
        condition: any

  admin:
    image: ${KINTUNNEL_ADMIN_IMAGE:-ghcr.io/pascalai2024/kintunnel-admin:dev}
    environment:
      KINTUNNEL_ADMIN_BIND: 0.0.0.0
      KINTUNNEL_ADMIN_PORT: 8080
      KINTUNNEL_ENGINE_URL: http://engine:9090
    volumes:
      - kintunnel_config:/etc/kintunnel:ro
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.vpn == true
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
