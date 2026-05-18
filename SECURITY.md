# Security Policy

KinTunnel manages VPN peers and sensitive network configuration. Treat every credential, private key, peer profile, and generated QR code as secret.

## Supported Versions

This project is pre-release. Security fixes will target the main development line until versioned releases are established.

| Version | Supported |
| --- | --- |
| Unreleased main branch | Yes |
| Tagged releases | Not yet available |

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub private vulnerability reporting:

- [Open a private vulnerability report](https://github.com/PascalAI2024/kintunnel/security/advisories/new).
- Do not open a public issue, discussion, or pull request for active vulnerabilities.
- Do not include live credentials, private keys, peer configs, or QR codes unless they are test-only samples.

Include:

- A clear description of the issue.
- Steps to reproduce.
- Impact and affected configurations.
- Any logs, screenshots, or proof-of-concept details that help confirm the issue.

Reports are handled in a private GitHub security advisory draft until disclosure is safe. If the issue is accepted, fixes target the main development line first while the project is pre-release.

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
- Weak admin tokens or credentials outside project defaults.
- Abuse complaints caused by traffic exiting through the operator's VPS.
- Privacy guarantees against the VPS provider, upstream network, or destination services.

If the software encourages an unsafe default, that is in scope. If the operator publishes the admin panel to the entire internet with a reused token or weak credential, that is an educational opportunity.
