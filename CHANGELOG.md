# Changelog

## 1.0.12 - 2026-04-29

### Added
- Added an authenticated Telegram `getUpdates` shortcut from the channel form for quick chat ID lookup.

### Changed
- Removed verbose helper copy across channel, connector, topology, and AI auth screens so the admin UI stays focused on fields and actions.

## 1.0.11 - 2026-04-29

### Added
- Added Discord DM and Telegram 1:1 direct targets for channel setup in CLI, admin UI, runtime prompt context, and Discord outbox delivery.
- Added operator-facing bundled CLI version/status/auth/test/logout affordances for Codex, Gemini, and Claude runtimes.
- Added Homebrew formula rendering support for macOS distribution.

### Changed
- Reworked connector terminology so reusable connectors are KakaoTalk-only, while Discord/Telegram use agent platform tokens and channel/direct targets.
- Refined the Channels UI/UX around “대화 대상” setup so server channels, Telegram chats, Discord DMs, and Kakao connector routes read as distinct choices.
- Made npm publishing fail loudly when neither `NPM_TOKEN` nor trusted publishing is available.

## 1.0.8 - 2026-04-29

### Added
- Added topology automation for dry-run planning, policy-guarded apply, export, admin APIs, web admin UI, and CLI commands.
- Added CI smoke builds for both `linux/amd64` and `linux/arm64` Docker images with Buildx/QEMU.

### Changed
- Added agent management policy guidance so automation agents can plan/apply allowed topology changes without inline secrets.

## 1.0.7 - 2026-04-27

### Changed
- Changed the Helm chart default deployment strategy to `Recreate` so RWO state/workspace PVCs are owned by only one hkclaw-lite Pod during rollouts.
- Documented that `READY 2/2` means the single admin Pod has two ready containers, not that two Pods should run.

## 1.0.6 - 2026-04-27

### Changed
- Simplified the admin password modal render-state cleanup while preserving the password field typing fix.

## 1.0.5 - 2026-04-27

### Fixed
- Fixed the admin password modal so typed password fields survive live validation re-renders instead of appearing blank while entering text.

## 1.0.4 - 2026-04-25

### Added
- Added unauthenticated Kakao relay health endpoints for ingress and OpenBuilder smoke checks.

### Fixed
- Return a protocol-local `400 Invalid JSON body` for malformed Kakao relay payloads instead of falling through to the admin error wrapper.

## 1.0.3 - 2026-04-25

### Added
- Added KakaoTalk channel/connector support based on the OpenClaw TalkChannel relay pattern.
- Added the built-in Kakao relay endpoints to the hkclaw-lite admin server so a separate relay deployment is not required by default.
- Added GitOps-friendly Kakao worker sidecar support in the Helm chart.
- Added channel-worker controls in the Channels UI for Discord, Telegram, and KakaoTalk platform workers.
- Added favicon and installable browser icon metadata.

### Changed
- Simplified admin headings and refined the overall UI hierarchy, spacing, responsive cards, and action placement.
- Made connector-owned channel routing explicit: connectors own platform sessions, channels own route filters, and agents own execution harnesses.
- Clarified README guidance for connector-vs-channel-vs-agent ownership, tribunal routing, Kakao pairing, relay endpoints, and local Kubernetes GitOps deployment.
- Updated container publish workflow action majors and semver tag guards to keep main-branch publishes warning-free.

### Fixed
- Fixed Kakao wildcard routing ambiguity by blocking overlapping route filters in the same connector.
- Fixed connector-only agents being displayed as legacy token-managed workers.
- Fixed channel form validation hints shifting fields out of alignment.
- Fixed mobile card action layouts that could wrap awkwardly or overlap.
- Fixed idle Kakao worker behavior so GitOps sidecars remain alive before Kakao channels are configured.
- Fixed release workflow behavior so GitHub Release assets can still publish when `NPM_TOKEN` is not configured; npm publish is skipped with a warning in that case.

## 1.0.2 - 2026-04-23

### Changed
- Kept release metadata aligned across npm package metadata and the Helm chart.
- Updated release workflows for the current GitHub runner environment.

## 1.0.0 - 2026-04-08

### Added
- Initial public hkclaw-lite release.
