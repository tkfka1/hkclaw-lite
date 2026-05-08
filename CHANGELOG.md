# Changelog

## 2.0.2 - 2026-05-09

### Fixed
- Tribunal arbiter never resumes a Claude CLI session: `loadRoleRuntimeSession` now short-circuits the arbiter role and rejects any session row whose `session_policy` is `ephemeral`, matching the schema-level `ephemeral` policy that `recordRuntimeRoleSession` already writes.
- Tribunal post-loop arbiter call no longer hardcodes `reviewerVerdict='blocked'`; it carries the actual `lastReviewerVerdict` from the final round into the recorder, the arbiter prompt, the role message, and the return value.
- `recordRuntimeRoleSession` skips writing when `channel.name` or `entry.role` is missing instead of synthesizing an `unknown:unknown` session_key that polluted `runtime_role_sessions`.
- Scheduler heartbeat now tracks consecutive renewal failures and abandons the lease (with a loud log) after 3 consecutive failures so a permanently broken renewal does not silently expire while the in-flight schedule keeps running.

### Changed
- `hkclaw-lite service install` (no autoStart) prints a hint that an already-running service needs `hkclaw-lite restart` to pick up the new unit.
- systemd unit `Environment=PATH` now includes `<projectRoot>/.hkclaw-lite/bundled-clis/bin` so command-type agents that reference bundled CLIs by short name (`codex`, `gemini`, etc.) keep working under systemd.
- `readBinPath()` no longer follows `process.argv[1]` through `realpathSync`, so the systemd unit pins the npm bin shim and survives `npm install -g hkclaw-lite@<new>` and nvm version switches.

### Documented
- Added an explicit comment in `runtime-db.js` recording the single-process + per-service `outboxFlushTask` serialization invariant that lets the non-atomic outbox claim path be safe.

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
