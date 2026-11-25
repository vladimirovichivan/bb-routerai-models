# Changelog

## 0.0.3 — 2026-11-24

Model names in bb's picker keep their version.

- bb shows `routerai-managed/<name>` and truncates the tail, and OpenCode
  supplies the prefix, so a raw `Anthropic: Claude Haiku 5.5` lost the version.
  The generated config now carries `Claude Haiku 5.5 (Anthropic)`
  (`modelDisplayName()` in `core/models.ts`). The vendor is dropped when the
  name already says it, and alias ids (`~vendor/...-latest`) get `(latest)`
  instead, so alias and pinned rows stay distinguishable.
- 50 tests.
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
