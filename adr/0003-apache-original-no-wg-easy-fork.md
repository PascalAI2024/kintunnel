# ADR 0003: Apache-2.0 original codebase with no wg-easy fork

Status: Accepted

Date: 2026-05-17

## Context

KinTunnel is licensed under Apache-2.0 and is positioned as an original project. Existing tools such as `wg-easy` prove that simple WireGuard administration is useful, but copying their code, UI, documentation, or project identity would create licensing, maintenance, and trust problems.

The repository may contain research notes or migration references that mention existing projects. Those references are not permission to import their implementation.

## Decision

KinTunnel will remain an Apache-2.0 original codebase.

The project will not be a fork of `wg-easy`, will not copy `wg-easy` source code, and will not clone its UI or documentation. Future implementation may interoperate with WireGuard and standard Linux/Docker tooling, but code should be written specifically for KinTunnel.

## Consequences

- New runtime code must use dependencies with licenses compatible with Apache-2.0 distribution.
- Third-party code or generated assets must be tracked in notices where required.
- Similar features, such as QR code export or peer creation, must be implemented independently.
- Any import/migration feature from `wg-easy` must treat it as an external data source, not an inherited codebase.
- Public messaging should avoid implying this is a rebrand, fork, or continuation of `wg-easy`.
