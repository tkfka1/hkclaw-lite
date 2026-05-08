# Changelog

## Unreleased

### Removed
- Removed Docker / Kubernetes / Helm / Homebrew distribution support entirely. `hkclaw-lite` is now an npm-only local runtime.
- Deleted `Dockerfile`, `.dockerignore`, `docker/`, `charts/`, `scripts/` (release/homebrew tooling), and all `.github/workflows`.
- Removed Homebrew launchd auto-service logic from `hkclaw-lite admin` and the `--foreground` flag.
- Removed the `/workspace` container fallback from default channel workspace resolution.
- Dropped `helm-chart` and `release-version` test suites and the related Dockerfile/CI assertions in `ci.test.js` / `cli.test.js`.

### Changed
- `package.json` description and scripts trimmed to local-npm usage only.
