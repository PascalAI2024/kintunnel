# Third-Party Notices

KinTunnel is licensed under the Apache License, Version 2.0.

This repository does not vendor third-party source code. It does depend on open-source packages and runtime images during development, testing, and container builds.

## Runtime Dependencies

- Express for HTTP services.
- cookie-parser for admin session cookie parsing.
- qrcode for rendering WireGuard client configuration QR codes.
- Node.js official container images for the engine and admin runtime images.
- Debian packages installed in runtime images, including `curl`, `iproute2`, `iptables`, and `wireguard-tools` for the engine image.

## Development and Test Dependencies

- TypeScript and tsx for TypeScript compilation and local execution.
- Vitest for tests.
- Supertest for admin HTTP tests.
- MkDocs for documentation builds.

## Referenced Technologies

- WireGuard.
- Docker and Docker Compose.
- Dokploy, Docker Swarm, Traefik, Caddy, and Nginx in deployment examples.
- Linux networking facilities such as `/dev/net/tun`, IP forwarding, and firewall/NAT rules.

Package-level licenses are tracked through the relevant package manifests and lockfiles. Contributors should update this file whenever new third-party source, assets, container base images, generated clients, or bundled binaries are added.

## Trademark Notice

WireGuard is a registered trademark of Jason A. Donenfeld. This project is not affiliated with, endorsed by, sponsored by, or approved by Jason A. Donenfeld or the WireGuard project.

## wg-easy

The research notes discuss `wg-easy` as prior art and deployment inspiration. This repository is not a fork of `wg-easy` and must not copy `wg-easy` source code, UI assets, documentation prose, or implementation-specific behavior without a deliberate license review and attribution update.
