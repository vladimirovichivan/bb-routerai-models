# Changelog

## 0.0.2 — 2026-11-24

First public release.

- Provider `routerai-managed` in bb built from a cached RouterAI catalog.
- Sidebar page: catalog filter, model checkboxes, per-model reasoning level
  selector, ruble prices and generated config size.
- CLI: `refresh`, `list`, `status`, `enable`, `disable`, `reasoning`, `apply`,
  `approvals`, `show-config`, each with `--json`.
- Inline `OPENCODE_CONFIG_CONTENT` delivered through bb's ACP bridge, with a
  24 KiB cap and fallback to the last config that fit.
- RouterAI modalities mapped to the OpenCode enum, so one `file` input cannot
  invalidate the whole config.
- Tool approvals follow bb by default; `approvals off` opts into the generic
  ACP dialect.
- 48 tests, type check, MIT license.
