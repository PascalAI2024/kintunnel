# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of Keep a Changelog and intends to use semantic versioning once releases begin.

## Unreleased

### Added

- Initial public repository foundation.
- Apache-2.0 licensing scaffold.
- Security, contribution, conduct, roadmap, and notice documents.
- README positioning for an original Docker-native family VPN manager for WireGuard deployments.
- Process-level integration coverage for the dry-run engine and admin HTTP client peer lifecycle.
- Engine API token authentication.
- Admin config download, no-store sensitive response headers, and recent activity view.
- Engine audit events for state initialization, peer lifecycle, and reconcile actions.

### Changed

- README and operator docs now describe the runnable dry-run MVP, source-build Docker flow, build commands, and current non-dry-run limitations.
- Engine defaults now fail closed into dry-run mode unless host networking is explicitly acknowledged.

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- Nothing yet.

### Security

- Added initial security reporting guidance.
