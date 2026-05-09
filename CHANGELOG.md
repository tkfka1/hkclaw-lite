# Changelog

## 2.2.0 - 2026-05-09

### Added
- `hkclaw-lite onboard` — interactive first-run setup wizard. Walks the operator through (1) picking a project root and initializing `.hkclaw-lite/`, (2) setting the admin password (or disabling login), (3) recording an external admin URL as the Kakao relay base in `<root>/.hkclaw-lite/service.env` (or falling back to the local instance), and (4) installing + enabling the systemd user service on Linux. Prints the access URL and the next admin-UI steps when done.

### Changed (breaking-ish)
- `DEFAULT_KAKAO_RELAY_URL` fallback flipped from the external `https://k.tess.dev/` to the local-self `http://127.0.0.1:5687/` so a fresh `npm install -g hkclaw-lite` does not silently route Kakao traffic through a third-party domain. Operators using an external admin URL should set `OPENCLAW_TALKCHANNEL_RELAY_URL` (or `KAKAO_TALKCHANNEL_RELAY_URL`) in `service.env` — `hkclaw-lite onboard` does this for you.

### Removed
- Dropped the dead `FALLBACK_KAKAO_RELAY_URL` constant in `src/admin-ui/app.js`.

## 2.1.0 - 2026-05-09

### Removed
- Topology automation removed entirely: deleted `src/topology.js`, the `hkclaw-lite topology plan|apply|export` CLI subcommands, the `/api/topology/{plan,apply,export}` admin endpoints, the `구성` (Topology) admin view (`renderTopologyView`, `topologyDraft`/`topologyResult` state, `data-form="topology"` UI, all `topology-*` action handlers and CSS), the `managementPolicy` agent field plus its store-side normalization/validation, and the prompt-envelope `Topology management:` block. Operate the runtime through the regular agents/channels/schedules screens or the equivalent CLI commands.
- Removed the `home` (`운영 개요`) view: deleted `renderHomeView` from `ui-views.js` and `app.js`, dropped `home` from `VIEW_NAMES` / `getViewMeta`, removed the home nav entry, and dropped the unused `renderShortcutCard` helper. The default landing is now the `agents` view, and `normalizeView` falls back to `agents`.
- Deleted dead admin-UI CSS: `.topology-*`, `.shortcut-*`, `.hero-panel`, `.hero-copy`, `.hero-meta`, `.hero-chip[.is-busy]`, `.metrics--hero`, `.metrics--three`, `.metrics--four`, `.metrics--compact`, `.grid-three`, `.overview-panel`, plus their entries in the responsive `@media (max-width: 900px)` block.

### Fixed
- Connector and schedule modal save buttons rendered the `sparkles` glyph because `renderButtonLabel('save', …)` referenced a non-existent icon; switched to `renderButtonLabel('edit', …)` to match the agent modal.
- Schedule modal "disabled" checkbox label used the unknown class `checkbox-row` instead of `checkbox`, so the styled label never applied; corrected the class name.
- Connector / schedule / local LLM modal "취소" buttons rendered without an icon while every other modal close affordance used `renderButtonLabel('stop', '닫기')`; standardized them via `renderButtonLabel('stop', '취소')`.
- `.activity-log-empty` referenced an undeclared CSS variable `--ink-muted`; replaced every occurrence with `--ink-soft`, which is the actual palette token.
- `card-title-icon` was 32×32 / radius 10px while sibling `section-title-icon` and `metric-icon` were 38×38 / radius 12px, causing visible size jumps between the section header icon and per-card icons in the channels view; unified `card-title-icon` to 36×36 / radius 11px so the spacing scales smoothly.

### Changed
- Agents view empty-state now uses the `empty-inline empty-inline--action` layout with a CTA hint pointing at the "에이전트 추가" button (matches the schedules view empty-state pattern).
- Admin password modal hint replaced the deployment-era phrasing "최초 bootstrap 용도" with the npm-runtime-accurate "최초 서버 시작 시 한 번만 읽힙니다" so the copy stops implying container init semantics.
- `hkclaw-lite admin` execution-model help label trimmed redundant "in the foreground" wording to "(foreground)".

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
