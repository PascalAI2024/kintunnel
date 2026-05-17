# ADR 0005: Public name and namespace policy

Status: Accepted

Date: 2026-05-17

## Context

The project needs one public name, one repository slug, and a predictable deployment namespace before the first public repository is published.

The project also touches the WireGuard ecosystem and must avoid names, logos, or claims that imply official association with WireGuard or any other third-party project.

## Decision

The public project name is KinTunnel. The expected repository slug is `kintunnel`.

The project will:

- use KinTunnel in public-facing repository and documentation copy;
- use `kintunnel` as the repository slug, container, package, file path, and volume namespace;
- use `KINTUNNEL_*` as the deployment environment variable namespace;
- describe it as an original, self-hosted WireGuard VPN manager;
- keep WireGuard references factual and include trademark boundaries where public docs mention the mark;
- avoid names that are confusingly similar to WireGuard, wg-easy, commercial VPN providers, or infrastructure platforms.

## Consequences

- Runtime package names, image names, env vars, and public domains have one public namespace from the first public commit.
- User-facing copy should use KinTunnel.
- Legal/trademark review remains a pre-launch task.
- Documentation should avoid claiming any official relationship with WireGuard.
