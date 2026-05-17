# Security Policy

KinTunnel manages VPN peers and sensitive network configuration. Treat every credential, private key, peer profile, and generated QR code as secret.

## Supported Versions

This project is pre-release. Security fixes will target the main development line until versioned releases are established.

| Version | Supported |
| --- | --- |
| Unreleased main branch | Yes |
| Tagged releases | Not yet available |

## Reporting a Vulnerability

Please report security vulnerabilities privately.

Until a dedicated security address is published, use the repository owner's private contact channel or GitHub private vulnerability reporting if enabled.

Include:

- A clear description of the issue.
- Steps to reproduce.
- Impact and affected configurations.
- Any logs, screenshots, or proof-of-concept details that help confirm the issue.

Do not open a public issue for active vulnerabilities.

## Security Expectations

Expected deployment posture:

- Run the VPN data plane as a single, explicit service.
- Keep the admin UI private or strongly authenticated.
- Use HTTPS for all admin access.
- Store generated peer material securely.
- Create separate peers per person or device.
- Revoke lost or retired devices promptly.
- Back up configuration securely and test restore procedures.

## Out of Scope

The following are usually outside this project's direct control:

- Misconfigured VPS firewalls.
- Compromised host operating systems.
- Weak admin passwords outside project defaults.
- Abuse complaints caused by traffic exiting through the operator's VPS.
- Privacy guarantees against the VPS provider, upstream network, or destination services.

If the software encourages an unsafe default, that is in scope. If the operator publishes the admin panel to the entire internet with `password123`, that is an educational opportunity.
