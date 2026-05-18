# Contributing

Thank you for considering a contribution.

KinTunnel is the public project name. The `KINTUNNEL_*` namespace is used for deployment configuration.

## Project Rules

- Do not copy code, UI assets, or documentation from `wg-easy`.
- Keep WireGuard references descriptive and trademark-safe.
- Prefer original implementation over cloning existing admin flows.
- Do not rename environment variables, config keys, image names, or file paths without a compatibility plan.
- Keep Docker deployment first-class.
- Keep security-sensitive behavior explicit and documented.
- Update notices when adding third-party code or assets.

## Development Workflow

1. Open an issue or draft proposal for larger changes.
2. Keep pull requests focused.
3. Include tests for behavior that can regress.
4. Update README, roadmap, or security docs when user-facing behavior changes.
5. Run the project checks before asking for review.

Local checks:

```sh
npm ci
npm run build
npm test
npm audit --audit-level=moderate
python -m mkdocs build --strict
docker compose --env-file .env.example --profile admin config
```

Docker image builds are covered in CI. Run them locally as well if Docker is available.

## Commit Style

Use clear, conventional commit messages when practical:

```text
feat: add peer revocation endpoint
fix: preserve config volume ownership
docs: clarify WireGuard trademark notice
```

## Review Standards

Pull requests should be reviewed for:

- Security impact.
- Deployment safety.
- Upgrade and rollback behavior.
- Configuration persistence.
- User onboarding clarity.
- License and notice compliance.

This will become stricter as the project moves from scaffold to usable release. Annoying, yes. Also how fewer things catch fire.
