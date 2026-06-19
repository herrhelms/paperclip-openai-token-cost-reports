# TODO before deployment

Self-audit of `claude-token-cost-reports` at v0.9.2. Items below are ranked by severity
and grouped so the blocker fixes can be done in one ~30 min pass before tagging
a release.

Last reviewed: 2026-06-15.

---

## 🔴 Hard blockers — cannot publish without these

### 1. `package.json` is marked private

```json
"private": true
```

`npm publish` refuses to publish private packages. Remove the field (or set
`false`) before publishing.

**Fix**

```diff
- "private": true,
```

---

### 2. License is `UNLICENSED` and no `LICENSE` file exists

```json
"license": "UNLICENSED"
```

A proper SPDX identifier is required for npm publishing and consumer trust
(corporate consumers refuse packages with no license). A matching `LICENSE`
file at the repo root must exist or `npm install` warns.

**Fix**

```diff
- "license": "UNLICENSED"
+ "license": "MIT"
```

Add a `LICENSE` file at the repo root using the standard MIT template. Update
copyright holder + year.

---

### ~~3. Duplicate migration prefix `002_`~~ — RESOLVED 2026-06-16

```
migrations/
├── 001_init.sql
├── 002_costs_overview.sql    ← adds raw_model, provider, cached_input_tokens, cost_cents, indexes
└── 002_fx_rates.sql           ← creates fx_rates table
```

Both files start with `002_` but contain different, unrelated schema changes.
Both are **required** at runtime (the worker references `raw_model`,
`cached_input_tokens` and the `fx_rates` table). Whether both apply depends
entirely on how Paperclip's migration runner derives the migration key —
filename, prefix, or hash.

If the runner uses the numeric prefix as the migration key, only one of the two
applies and the plugin fails on first use on a fresh install.

**Fix**

Rename `002_fx_rates.sql` → `003_fx_rates.sql`. Existing installs already
recorded both keys, so the migration-tracker reconciliation only matters for
fresh installs (which will be the common case post-publish).

Verify post-rename:

```bash
paperclipai plugin uninstall claude-token-cost-reports --force
paperclipai plugin install -l .
paperclipai plugin inspect claude-token-cost-reports --json | jq '.migrations'
```

Expect three entries: `001_init`, `002_costs_overview`, `003_fx_rates`.

---

### ~~4. CLI `bridge:data` produces `state.get` scope errors after first call~~ — NOT REPRODUCIBLE 2026-06-16

After the rename + idempotent migration pass, this no longer reproduces on consecutive `bridge:data` calls. Suspected cause: orphan schema from a previous install was confusing the host's invocation-scope dispatcher; purging via --force then reinstalling onto idempotent migrations cleared it. Keep on the watch-list for one production-grade install before publish.

---

### 5. SDK dependency pinned to `"*"`

```json
"peerDependencies": { "@paperclipai/plugin-sdk": "*" },
"devDependencies":  { "@paperclipai/plugin-sdk": "*", ... }
```

`"*"` accepts any version, including future breaking changes. The plugin will
silently break for new consumers when the SDK rolls forward.

**Fix**

Pin to the version we've tested against. Inspect the installed version:

```bash
node -p "require('@paperclipai/plugin-sdk/package.json').version"
```

Then update both spots:

```diff
- "peerDependencies": { "@paperclipai/plugin-sdk": "*" },
+ "peerDependencies": { "@paperclipai/plugin-sdk": "^2026.609.0" },
- "devDependencies":  { "@paperclipai/plugin-sdk": "*", ... }
+ "devDependencies":  { "@paperclipai/plugin-sdk": "^2026.609.0", ... }
```

Bump on each verified SDK update going forward.

---

## 🟡 Important — should fix before publish but doesn't block the npm command

### 6. `package.json.description` is stale

> "…export a **weekly** CSV for token-based billing."

The implementation is monthly. This appears in `npm view` output and search
results — first impression problem.

**Fix**

```diff
- "description": "...export a weekly CSV for token-based billing..."
+ "description": "...export a monthly CSV for token-based billing..."
```

Also update the version-list at the end to match what 0.9.2 ships.

---

### ~~7. README is multiple chapters out of sync~~ — RESOLVED 2026-06-16

- **Data model section** doesn't list `raw_model`, `provider`, `source`,
  `cached_input_tokens`, `cost_cents` — all added by `002_costs_overview.sql`
  and queried by the worker.
- **Migrations list** says `001_init.sql, 002_fx_rates.sql` — omits
  `002_costs_overview.sql`.
- **Surface table** lists 5 KPI cards; the dashboard ships 6 (List, Net, Price
  after the subscription work).
- "Per-agent table … six columns" — current implementation now switches column
  labels (List + Sub-adjusted) when subscription mode is active.

Anyone reading the README and inspecting the live plugin finds inconsistencies.

**Fix**

One README pass after the blocker fixes land. Add a new "Subscription mode"
subsection under the Settings list.

---

### ~~8. No `CHANGELOG.md`~~ — RESOLVED 2026-06-16

9 minor versions, ~16 patches in development. Without a changelog, operators
have no way to know what each version added. Critical for a billing plugin
where the math may change between versions.

**Fix**

Seed `CHANGELOG.md` from the version progression. Use Keep-a-Changelog format.
Going forward, add an entry every time the version bumps.

Skeleton:

```markdown
# Changelog

All notable changes to this plugin will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.9.2] - 2026-06-15
### Changed
- KPI grid breakpoints: 6 cols wide / 3×2 mid / 2×3 narrow / 1 col phone.

## [0.9.0] - 2026-06-15
### Added
- Always-visible billing-config strip (period · currency · margin · subscription).
- KPI labels switch to List / Sub-adjusted when subscription is active.

## [0.8.0] - 2026-06-14
...
```

---

### ~~9. `tsconfig.json` excludes the test file from typecheck~~ — RESOLVED 2026-06-16

```json
"exclude": ["node_modules", "dist", "tests/**/*"]
```

`pnpm typecheck` never sees `tests/plugin.spec.ts`. Type errors there only
surface when running `vitest`.

**Fix**

Either drop the exclusion (vitest brings its own types) or add a
`tsconfig.test.json` that extends the main config and includes `tests/`. Wire
into the typecheck script:

```diff
- "typecheck": "tsc --noEmit"
+ "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json"
```

---

## 🟢 Quality concerns — not blockers, worth tracking

### ~~10. `dist/worker.js` is 416 KB unminified~~ — RESOLVED 2026-06-16

Marked `@paperclipai/plugin-sdk` external in the worker esbuild config (was missing
from `workerConfig.external` even though `manifestConfig` and `uiConfig` already
had it). Result: `dist/worker.js` shrinks from 426 KB → 51 KB. The published
tarball drops from 211 KB → 34 KB; unpacked size 1.1 MB → 141 KB after also
switching `package.json.files` from a directory entry to explicit `dist/**/*.js`
+ `dist/**/*.d.ts` globs (so source maps stay local but don't ship).

---

### Original analysis (kept for posterity)

### ~~10. dist/worker.js was 416 KB unminified~~

Total `dist/` weighs 1.1 MB including source maps. Reasonable for a worker but
tree-shaking is leaving plenty in. If the npm package is the install artifact,
this shows on the npm page.

**Consideration**

- Mark `@paperclipai/plugin-sdk` as external in `esbuild.config.mjs` so it's
  resolved at install time, not bundled.
- Consider whether shipping source maps in the published tarball is desired —
  worth it for debugging, but doubles size.

---

### ~~11. Namespace hash is hardcoded in migration SQL~~ — DOCUMENTED 2026-06-16

Constraint now documented in the README "Naming" section with the regenerate-the-hash
one-liner. Long-term SDK fix (a `${PLUGIN_NAMESPACE}` template variable) is still
desirable but not blocking; forks have the procedure.

---

### Original analysis

Every migration begins with:

```sql
ALTER TABLE plugin_claude_token_cost_reports_c7ca204bbe.usage_events ...
```

The hash `1a4b97362d` is derived from `sha256("claude-token-cost-reports")[0:10]`. If
the plugin slug ever changes (npm scope prefix, slug rename), every migration
file silently breaks.

**Mitigation**

Document the constraint in README ("forks must regenerate the namespace
prefix"). Long-term: the SDK should expose a `${PLUGIN_NAMESPACE}` template
variable; until then, this is a fork-time hazard worth flagging.

---

### 12. Browser-side `/api/plugins` fetch for install UUID

```ts
fetch("/api/plugins", { credentials: "include" })
```

The Settings page link resolves the plugin's own install UUID by enumerating
**all installed plugins** from a host endpoint that isn't part of the SDK
surface. If the host scopes or removes that endpoint, the settings link breaks.

**Mitigation**

- Pin behavior in tests so a host upgrade that changes the response shape gets
  flagged.
- Open an SDK request: expose `installId` to the UI through
  `useHostContext()`.

---

### ~~13. Package name vs in-app slug split~~ — RESOLVED 2026-06-16

Post-rename, the npm package name (`claude-token-cost-reports`), the in-app slug
(`claude-token-cost-reports`), and the namespace seed (same string, hashed) are
all the same identifier. README "Naming" section documents the alignment.

---

### Original analysis

`claude-token-cost-reports` (npm) vs `claude-token-cost-reports` (in-app key).
Acceptable, but `npm install claude-token-cost-reports` doesn't match
the in-Paperclip key, which is confusing for new operators.

**Mitigation**

Add a "Naming" subsection to the README clarifying the difference and showing
both in the same code block.

---

## ✅ Good signs (no action needed)

- No SQL injection vectors — every `ctx.db.query`/`execute` uses parameterized
  arguments (`$1`, `$2` ...). No string-interpolated user data in SQL.
- No `as any`, `@ts-ignore`, `TODO`, `FIXME`, `HACK` in source.
- No `console.log` debugging leftover.
- FX fetch error handling is proper: HTTP status check, response-shape
  validation, fallback values.
- All declared capabilities are actually used (cross-checked manifest vs
  worker).
- All 33 unit tests pass; rewritten to cover the load-bearing pure-function
  math (pricing, normalization, divisor, slugifier).
- Migrations are idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `ON CONFLICT DO NOTHING`).
- `source_event_id PRIMARY KEY` dedupes between live subscription and backfill
  cleanly.
- Cleanup on company archive purges all plugin state (no orphan rows).

---

## Minimal blocker-fix plan (~30 min)

Do these six in one pass, then tag `v1.0.0-rc.1`:

1. Rename `migrations/002_fx_rates.sql` → `migrations/003_fx_rates.sql`.
2. Investigate or document the `state.get` scope error.
3. `package.json`:
   ```diff
   - "private": true,
   - "license": "UNLICENSED",
   + "license": "MIT",
   - "description": "...weekly CSV...",
   + "description": "...monthly CSV...",
   - "peerDependencies": { "@paperclipai/plugin-sdk": "*" }
   + "peerDependencies": { "@paperclipai/plugin-sdk": "^2026.609.0" }
   ```
4. Add `LICENSE` (MIT template).
5. Update README (migrations list, data model, KPI count, subscription mode).
6. Seed `CHANGELOG.md` and add an entry for `1.0.0-rc.1`.

Then:

```bash
pnpm build && pnpm test && paperclipai plugin uninstall claude-token-cost-reports \
  && paperclipai plugin install -l . \
  && paperclipai plugin list   # confirm 1.0.0-rc.1 status=ready
npm publish --dry-run          # confirm tarball contents look right
```
