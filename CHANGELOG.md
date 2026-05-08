# Changelog

## 2.0.1 - 2026-05-09

### Fixed
- Removed leftover `/workspace` container path from the admin UI: the new-channel form fallback (`src/admin-ui/app.js`) now defaults to `~`, matching the server-side `DEFAULT_CHANNEL_WORKSPACE`, and the Topology editor sample (`src/admin-ui/ui-views.js`) uses `~/workspace`. This prevents "Workspace does not exist" errors on hosts that do not have `/workspace`.
- Tightened the `hkclaw-lite admin` help-text wording so it no longer suggests a removed `--foreground` flag.

## 2.0.0 - 2026-05-09

### Removed (breaking)
- Removed Docker / Kubernetes / Helm / Homebrew distribution support entirely. `hkclaw-lite` is now an npm-only local runtime.
- Deleted `Dockerfile`, `.dockerignore`, `docker/`, `charts/`, `scripts/` (release/homebrew tooling), and all `.github/workflows`.
- Removed Homebrew launchd auto-service logic from `hkclaw-lite admin` and the `--foreground` flag.
- Removed the `/workspace` container fallback from default channel workspace resolution.
- Dropped `helm-chart` and `release-version` test suites and the related Dockerfile/CI assertions in `ci.test.js` / `cli.test.js`.

### Added
- `hkclaw-lite start` / `stop` / `restart` and `hkclaw-lite service install|uninstall|status|logs` for systemd user-unit supervision on Linux.

### Changed
- `package.json` description and scripts trimmed to local-npm usage only.
