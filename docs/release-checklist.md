# Release Checklist

Use this checklist before cutting a public release tag.

## Version

- Confirm `package.json` version.
- Move relevant `CHANGELOG.md` entries from `Unreleased` into the release section.
- Confirm docs do not reference images that have not been published.

## Validation

```sh
npm ci
npm run build
npm test
npm audit --audit-level=moderate
python -m mkdocs build --strict
docker compose --env-file .env.example --profile admin config
```

CI must pass on `main` before tagging.

## Images

- Tag release as `vX.Y.Z`.
- Confirm Docker publish workflow builds engine and admin images.
- Confirm GHCR tags exist for both images.
- Record image tags and digests in release notes.

## Security

- Review `SECURITY.md`.
- Confirm admin and engine token examples are placeholders only.
- Confirm no generated secrets, peer configs, QR codes, or private keys are committed.
- Review dependency and container scan results.

## Docs

- Build docs strictly.
- Check Quick Start and Docker Compose instructions from a clean checkout.
- Update roadmap remaining work if release scope changed.

## Publish

- Create GitHub release notes from changelog plus image references.
- Re-enable or batch Dependabot upgrades after the release baseline is stable.
