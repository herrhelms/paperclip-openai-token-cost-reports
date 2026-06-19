# Publishing Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take `claude-token-cost-reports` from v0.9.2 to a publishable `1.0.0-rc.1` by closing every blocker and 🟡 item in `docs/TODO-BEFORE-DEPLOYMENT.md`, verifying along the way, and tagging a release candidate ready for `npm publish --dry-run`.

**Architecture:** Sequential tasks ordered by dependency (LICENSE file must exist before referencing MIT in package.json; package.json + LICENSE land before any version bump or publish dry-run). Each task is independently committable — frequent commits after green local checks. The execution path runs `pnpm typecheck && pnpm test && pnpm build` after every code-affecting change, and `paperclipai plugin uninstall && install -l .` after every manifest/migration change.

**Tech Stack:** TypeScript (worker + UI), esbuild bundler, vitest tests, Paperclip plugin SDK, embedded Postgres for the host, `npm`/`pnpm` for packaging.

---

## Pre-flight (already done — do not redo)

- ✅ Plugin renamed `claude-token-usage` → `claude-token-cost-reports` (slug, npm name, DB namespace, folder, briefs, cognito knowledge)
- ✅ Migrations idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
- ✅ Install verified at v0.9.2 with new namespace `plugin_claude_token_cost_reports_c7ca204bbe`
- ✅ Backfill + per-agent breakdown confirmed working end-to-end

Reference docs to keep open while executing:
- `docs/TODO-BEFORE-DEPLOYMENT.md` — the source of truth for findings
- `README.md` — needs rewriting in Task 5
- `package.json`, `src/manifest.ts`, `migrations/`, `tsconfig.json` — primary edit targets

## File Structure

Files to be **created**:
- `LICENSE` — MIT template at repo root
- `CHANGELOG.md` — Keep-a-Changelog format
- `tsconfig.test.json` — extends `tsconfig.json`, includes `tests/`

Files to be **modified**:
- `package.json` — flip `private`, set license, fix description, pin SDK, add `engines.npm`, add `repository`/`homepage` if not present
- `migrations/002_fx_rates.sql` → renamed `migrations/003_fx_rates.sql`
- `README.md` — data model, migrations list, KPI count, subscription mode subsection
- `src/manifest.ts` — bump version to `1.0.0-rc.1` (last task)
- `tsconfig.json` — drop `tests/**/*` from `exclude` (or add a `tsconfig.test.json` and chain in `pnpm typecheck`)
- `docs/TODO-BEFORE-DEPLOYMENT.md` — strike completed items as each task closes

Files **NOT** to touch in this plan (defer):
- `src/worker.ts` and `src/ui/index.tsx` — no code changes needed for publishing readiness
- Quality concerns (#10–#13 in the TODO) — tracked separately

---

## Task 1: Add a LICENSE file (MIT)

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Write the LICENSE file**

Write `LICENSE` at the repo root with the standard MIT template. Update copyright holder + year:

```
MIT License

Copyright (c) 2026 Sebastian Helms

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Verify the file is at the repo root**

Run: `ls -la LICENSE`
Expected: file exists, ~1 KB.

- [ ] **Step 3: Commit**

```bash
git add LICENSE
git commit -m "chore: add MIT LICENSE file"
```

---

## Task 2: Update package.json (private, license, description, SDK pin, fields)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Read the SDK version we're testing against**

Run: `node -p "require('@paperclipai/plugin-sdk/package.json').version"`
Capture the output — e.g. `2026.609.0`. Use this exact string in the pin below (with caret prefix).

- [ ] **Step 2: Edit `package.json`**

Apply these changes in one edit:

```diff
- "private": true,
+ "license": "MIT",
- "license": "UNLICENSED",
- "description": "...export a weekly CSV for token-based billing...",
+ "description": "...export a monthly CSV for token-based billing...",
- "peerDependencies": { "@paperclipai/plugin-sdk": "*" },
+ "peerDependencies": { "@paperclipai/plugin-sdk": "^2026.609.0" },
- "@paperclipai/plugin-sdk": "*",
+ "@paperclipai/plugin-sdk": "^2026.609.0",
```

Specifically:
- Delete the `"private": true,` line entirely
- Change `"license": "UNLICENSED"` to `"license": "MIT"`
- In the `description` string, replace the word `weekly` with `monthly`
- In `peerDependencies` and `devDependencies`, replace the SDK version `"*"` with the exact pin from Step 1 (e.g. `"^2026.609.0"`)

- [ ] **Step 3: Verify the JSON parses**

Run: `node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).license"`
Expected output: `MIT`

Run: `node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).private"`
Expected output: `undefined`

- [ ] **Step 4: Reinstall deps to lock new pins**

Run: `pnpm install`
Expected: lockfile updates without errors. New `@paperclipai/plugin-sdk` resolution should match the pin.

- [ ] **Step 5: Verify build + tests still green**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: typecheck clean, 33 tests pass, dist built.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: license=MIT, drop private, fix description, pin SDK"
```

---

## Task 3: Rename `002_fx_rates.sql` → `003_fx_rates.sql`

**Files:**
- Rename: `migrations/002_fx_rates.sql` → `migrations/003_fx_rates.sql`
- Modify: `docs/TODO-BEFORE-DEPLOYMENT.md` (strike blocker #3 as resolved)

- [ ] **Step 1: Rename the migration file**

Run:

```bash
git mv migrations/002_fx_rates.sql migrations/003_fx_rates.sql
```

- [ ] **Step 2: Inspect the file header comment for the old number**

The file body doesn't reference its own filename, so no content edit needed. Confirm by:

Run: `head -3 migrations/003_fx_rates.sql`
Expected output: the same header (`claude-token-cost-reports — daily FX rates ...`), no "002" embedded in comments.

- [ ] **Step 3: Reinstall to verify ordering**

Run:

```bash
paperclipai plugin uninstall claude-token-cost-reports --force
paperclipai plugin install -l .
paperclipai plugin list
```

Expected output: `key=claude-token-cost-reports status=ready version=0.9.2 id=<uuid>`.

- [ ] **Step 4: Sanity-check FX table works after rename**

Run:

```bash
paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json '{"key":"getFxStatus","params":{"companyId":"<COMPANY_ID>"}}' --json
```

Expected: a JSON object with `currency`, `rate`, `rateDay`, `rateSource`. No "relation fx_rates does not exist" errors. If you see the scope-error, retry once — known intermittent.

- [ ] **Step 5: Update TODO doc**

In `docs/TODO-BEFORE-DEPLOYMENT.md`, mark blocker #3 as resolved by prepending `~~` to the heading and adding a closing note:

```markdown
### ~~3. Duplicate migration prefix `002_`~~ — RESOLVED 2026-06-16
```

- [ ] **Step 6: Commit**

```bash
git add migrations/003_fx_rates.sql docs/TODO-BEFORE-DEPLOYMENT.md
git commit -m "chore: rename 002_fx_rates -> 003_fx_rates for unique migration prefix"
```

---

## Task 4: Fix typecheck coverage of test files

**Files:**
- Create: `tsconfig.test.json`
- Modify: `package.json` (typecheck script)
- Modify: `docs/TODO-BEFORE-DEPLOYMENT.md` (strike item #9)

- [ ] **Step 1: Write `tsconfig.test.json`**

Create the file with this exact content:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Chain it into the typecheck script**

In `package.json`, replace:

```json
"typecheck": "tsc --noEmit",
```

with:

```json
"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json",
```

- [ ] **Step 3: Run typecheck and confirm tests are now covered**

Run: `pnpm typecheck`
Expected: clean. If any pre-existing type errors in `tests/plugin.spec.ts` surface, fix them inline before continuing — that's the value of this task.

- [ ] **Step 4: Run the unit tests too, to make sure runtime semantics didn't shift**

Run: `pnpm test`
Expected: 33 tests pass.

- [ ] **Step 5: Update TODO doc**

In `docs/TODO-BEFORE-DEPLOYMENT.md`, mark item #9 resolved:

```markdown
### ~~9. `tsconfig.json` excludes the test file from typecheck~~ — RESOLVED 2026-06-16
```

- [ ] **Step 6: Commit**

```bash
git add tsconfig.test.json package.json docs/TODO-BEFORE-DEPLOYMENT.md
git commit -m "chore: typecheck tests too via tsconfig.test.json"
```

---

## Task 5: Rewrite README sections that drift from reality

**Files:**
- Modify: `README.md`
- Modify: `docs/TODO-BEFORE-DEPLOYMENT.md` (strike item #7)

- [ ] **Step 1: Read the current README and locate the four drift points**

Drift point A — **Migrations list** (around line 65 in the current README):

Find this line:

```markdown
Migrations: `migrations/001_init.sql`, `migrations/002_fx_rates.sql`.
```

Replace with:

```markdown
Migrations: `migrations/001_init.sql`, `migrations/002_costs_overview.sql`, `migrations/003_fx_rates.sql`.
```

Drift point B — **Data model section** (`usage_events` column list):

Find:

```markdown
- `usage_events(source_event_id PRIMARY KEY, company_id, agent_id, model, input_tokens, output_tokens, occurred_at, day TEXT)` — append-only event log.
```

Replace with:

```markdown
- `usage_events(source_event_id PRIMARY KEY, company_id, agent_id, model, raw_model, provider, source, input_tokens, output_tokens, cached_input_tokens, cost_cents, occurred_at, day TEXT)` — append-only event log. `raw_model` preserves the literal model id (`claude-opus-4-7[1m]`) while `model` holds the normalized key; `provider` and `source` (`api` / `subscription`) drive the cost split.
```

Drift point C — **Surface table KPI count** (around line 14):

Find:

```markdown
  - 5 KPI cards: total tokens, input, output, cost (pre-margin), client price (post-margin)
```

Replace with:

```markdown
  - 6 KPI cards: total tokens, input, output, list (pre-margin), net (subscription-adjusted), price (chargeback). Labels switch to "List" + "Sub-adjusted" when a subscription preset is active.
```

Drift point D — **Settings list** (after the existing Settings bullet block, before "Client-facing monthly CSV"):

Add a new bullet:

```markdown
  - Subscription preset (Off / Claude Pro ÷5 / Claude Max ÷20) — divides list-price cost before margin, so the chargeback column reflects what the operator actually pays. The List column is unchanged so subscription savings stay visible. See "Subscription mode" below.
```

Drift point E — **Add a "Subscription mode" subsection** before the "Surface" heading:

```markdown
## Subscription mode

The plugin computes two cost lanes per row:

- **List** = `tokens × per-MTok rate` — what API billing would charge.
- **Sub-adjusted** = `List ÷ divisor × (1 + margin)` — what the operator bills the client.

The divisor comes from the Subscription preset in Settings:

| Preset | Divisor | Use when |
| --- | --- | --- |
| Off | 1 | Client pays for raw API consumption |
| Claude Pro | 5 | Operator covers usage with a Pro subscription |
| Claude Max | 20 | Operator covers usage with a Max subscription |

Switching modes never rewrites historical data — it's a render-time recompute. The dashboard's KPI labels and the per-agent table column headers update in place. The monthly CSV applies the divisor at row aggregation time so the exported invoice matches the dashboard total to the cent.
```

- [ ] **Step 2: Verify the README renders sensibly**

Run: `wc -l README.md`
Expected: ~140 lines (was 123).

Manually skim the file to confirm no orphan headings or stray markdown artifacts.

- [ ] **Step 3: Update TODO doc**

In `docs/TODO-BEFORE-DEPLOYMENT.md`, mark item #7 resolved:

```markdown
### ~~7. README is multiple chapters out of sync~~ — RESOLVED 2026-06-16
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/TODO-BEFORE-DEPLOYMENT.md
git commit -m "docs: README data model, migrations, KPI count, subscription mode"
```

---

## Task 6: Seed CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`
- Modify: `docs/TODO-BEFORE-DEPLOYMENT.md` (strike item #8)

- [ ] **Step 1: Write `CHANGELOG.md`**

Create with this content (one ##-block per shipped version; Unreleased reserved for 1.0.0-rc.1):

```markdown
# Changelog

All notable changes to this plugin will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.2] - 2026-06-15
### Changed
- KPI grid breakpoints: 6 cols on widescreen / 3×2 on laptop / 2×3 on tablet / 1 col on phone.

## [0.9.0] - 2026-06-15
### Added
- Always-visible billing-config strip above the KPI row showing period, currency + FX, margin, and subscription preset.
- KPI labels switch to "List" + "Sub-adjusted" when a subscription preset is active.

## [0.8.0] - 2026-06-14
### Added
- Audit-grade dashboard: subscription preset surfaced in every total cell.
### Fixed
- Monthly CSV export applies the divisor at row aggregation time so the exported invoice matches the dashboard.

## [0.7.0] - 2026-06-14
### Added
- Subscription preset (Off / Pro ÷5 / Max ÷20) with deterministic billable math: `tokens × rate ÷ divisor × (1 + margin) × FX`.

## [0.6.0] - 2026-06-14
### Added
- Monthly CSV export priced in the operator's billing currency.
### Changed
- Worker rolls usage_daily up every 15 minutes; previously every hour.

## [0.5.0] - 2026-06-13
### Added
- `backfillFromCostEvents` action — reads `public.cost_events` directly via `coreReadTables` so the dashboard can show pre-install history.

## [0.4.1] - 2026-06-13
### Fixed
- Per-agent table now reads live host `/api/costs/by-agent-model` because `cost_event.created` events never fire on the host. Worker subscription is kept as a fallback.

## [0.4.0] - 2026-06-13
### Added
- Per-agent breakdown card with expandable per-model sub-rows (mirrors host /costs).

## [0.3.x] - 2026-06-13
### Changed
- `routePath: "tokens"` (single-segment slug, per host validator).
- Settings link resolves the install UUID at runtime via `GET /api/plugins`.
- Cross-link from settings back to the usage dashboard.

## [0.2.x] - 2026-06-13
### Added
- 8-row pricing table for Opus 4.8 / 4.7 and Sonnet 4.6 / 4.5 with 1M-context variants.
- Pricing defaults sourced from platform.claude.com/docs/en/about-claude/pricing.
- Settings link, CSV download via Blob fetch, costs.read capability.

## [0.1.0] - 2026-06-13
### Added
- Initial scaffold: `cost_event.created` subscription, `usage_events`/`usage_daily` tables, weekly CSV export.
```

- [ ] **Step 2: Update TODO doc**

In `docs/TODO-BEFORE-DEPLOYMENT.md`, mark item #8 resolved.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/TODO-BEFORE-DEPLOYMENT.md
git commit -m "docs: seed CHANGELOG.md (Keep a Changelog format)"
```

---

## Task 7: Investigate or document the `state.get` scope error

**Files:**
- Modify: `docs/TODO-BEFORE-DEPLOYMENT.md` (item #4)
- Possibly modify: `src/worker.ts` if a fix lands

- [ ] **Step 1: Attempt a controlled reproduction**

Run the same call twice in quick succession:

```bash
paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json '{"key":"getPricing","params":{"companyId":"<COMPANY_ID>"}}' --json
sleep 1
paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json '{"key":"getPricing","params":{"companyId":"<COMPANY_ID>"}}' --json
```

- [ ] **Step 2: Branch on the outcome**

**Branch A — Both calls succeed (no reproduction):**

Update `docs/TODO-BEFORE-DEPLOYMENT.md` item #4 with a closing note:

```markdown
### ~~4. CLI `bridge:data` produces `state.get` scope errors after first call~~ — NOT REPRODUCIBLE 2026-06-16

After the rename + idempotent migration pass, this no longer reproduces on consecutive `bridge:data` calls. Suspected cause: orphan schema from a previous install was confusing the host's invocation-scope dispatcher; purging via --force then reinstalling onto idempotent migrations cleared it. Keep on the watch-list for one production-grade install before publish.
```

Commit:

```bash
git add docs/TODO-BEFORE-DEPLOYMENT.md
git commit -m "docs: state.get scope error not reproducible after rename"
```

**Branch B — Second call fails with the scope error:**

Capture the exact error text. Open `src/worker.ts`. The handlers that call `ctx.state.get` are `loadPricing`, `loadCurrency`, and the `getPricing`/`getCurrencyConfig` actions. Wrap the first state read in each action with a try/catch that, on `scope expired` errors, reloads the scope by re-deriving it (no SDK API for this is documented; if no workaround exists, document the limitation in the TODO and the README's "Known limitations" section).

If a workaround lands, add a focused vitest test that mocks the SDK's `ctx.state.get` to throw a scope error, then asserts the handler retries once.

Commit accordingly:

```bash
git add src/worker.ts tests/plugin.spec.ts docs/TODO-BEFORE-DEPLOYMENT.md
git commit -m "fix(worker): retry state.get on invocation-scope expiry"
```

If no workaround: document and move on (don't block the release on a host-side limitation).

```bash
git add docs/TODO-BEFORE-DEPLOYMENT.md README.md
git commit -m "docs: known limitation — bridge:data state.get scope expiry"
```

---

## Task 8: Bump version to `1.0.0-rc.1`

**Files:**
- Modify: `src/manifest.ts`
- Modify: `package.json`
- Modify: `tests/plugin.spec.ts` (if it asserts the version string)
- Modify: `CHANGELOG.md` (move `[Unreleased]` content into `[1.0.0-rc.1] - 2026-06-16`)

- [ ] **Step 1: Edit `src/manifest.ts`**

```diff
-  version: "0.9.2",
+  version: "1.0.0-rc.1",
```

- [ ] **Step 2: Edit `package.json`**

```diff
-  "version": "0.9.2",
+  "version": "1.0.0-rc.1",
```

- [ ] **Step 3: Check whether tests assert the version**

Run: `grep -n "0.9.2\|version" tests/plugin.spec.ts`

If a test asserts the exact version string, update it to `1.0.0-rc.1`. If not, skip this sub-step.

- [ ] **Step 4: Promote Unreleased to `[1.0.0-rc.1]` in CHANGELOG**

Replace:

```markdown
## [Unreleased]

## [0.9.2] - 2026-06-15
```

with:

```markdown
## [Unreleased]

## [1.0.0-rc.1] - 2026-06-16
### Changed
- BREAKING: renamed `claude-token-usage` → `claude-token-cost-reports` (npm package, in-app slug, DB namespace). Existing installs must `paperclipai plugin uninstall claude-token-usage --force` before installing.
- Migrations made idempotent so re-installs don't fail on lingering postgres schemas.
- Migration prefix collision resolved (`002_fx_rates.sql` → `003_fx_rates.sql`).
- Package now publishable: `private: false`, `license: MIT`, SDK pinned to a version range, LICENSE file added.
- Typecheck now covers tests via `tsconfig.test.json`.
### Added
- `CHANGELOG.md`, `LICENSE`, "Subscription mode" README section.

## [0.9.2] - 2026-06-15
```

- [ ] **Step 5: Full local verify**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: typecheck clean, 33 tests pass, dist built. `dist/manifest.js` contains `version: "1.0.0-rc.1"`.

- [ ] **Step 6: Reinstall live**

```bash
paperclipai plugin uninstall claude-token-cost-reports --force
paperclipai plugin install -l .
paperclipai plugin list
```

Expected: `key=claude-token-cost-reports status=ready version=1.0.0-rc.1 id=<uuid>`.

- [ ] **Step 7: Commit**

```bash
git add src/manifest.ts package.json CHANGELOG.md tests/plugin.spec.ts
git commit -m "release: 1.0.0-rc.1"
```

---

## Task 9: `npm publish --dry-run` verification

**Files:** (none modified; verification only)

- [ ] **Step 1: Run the dry-run**

Run: `npm publish --dry-run --access public`

Expected: tarball summary listing `dist/`, `migrations/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`. **Must not include** `node_modules/`, `src/`, `tests/`, `.git/`, `pnpm-lock.yaml`, or the `docs/superpowers/` plan files.

If the listing is wrong, edit the `files` array in `package.json` to be explicit:

```json
"files": [
  "dist",
  "migrations",
  "README.md",
  "LICENSE",
  "CHANGELOG.md"
],
```

Then re-run the dry-run.

- [ ] **Step 2: Check tarball size**

The dry-run prints the unpacked size. Expected: under 1.5 MB. If larger, the source maps may be doubling the size — consider whether shipping `.map` files matters for end-user debug; it's a quality concern, not a blocker.

- [ ] **Step 3: Commit any `files` array adjustments**

```bash
git add package.json
git commit -m "chore: scope npm tarball contents"
```

---

## Task 10: Tag the release candidate

**Files:** (none modified; git only)

- [ ] **Step 1: Tag the commit**

```bash
git tag -a v1.0.0-rc.1 -m "1.0.0-rc.1: publishable rename + cleanup"
```

- [ ] **Step 2: Verify the tag**

```bash
git log --oneline -1
git tag --list v1.0.0-rc.1
```

Expected: tag exists, points at the release commit.

- [ ] **Step 3: Push tag (optional, manual)**

Skip this step if no remote is configured. If a remote is set up:

```bash
git push origin main --tags
```

---

## Self-Review (run before handing off)

**Spec coverage** — TODO-BEFORE-DEPLOYMENT.md mapping:
- Blocker #1 (private flag) → Task 2 ✓
- Blocker #2 (license + LICENSE file) → Tasks 1, 2 ✓
- Blocker #3 (duplicate `002_` migrations) → Task 3 ✓
- Blocker #4 (state.get scope error) → Task 7 ✓ (with branching)
- Blocker #5 (SDK dep `"*"`) → Task 2 ✓
- 🟡 #6 (stale description) → Task 2 ✓
- 🟡 #7 (README out of sync) → Task 5 ✓
- 🟡 #8 (no CHANGELOG) → Tasks 6, 8 ✓
- 🟡 #9 (tsconfig excludes tests) → Task 4 ✓
- 🟢 #10-#13 (dist size, namespace hash, /api/plugins fetch, package-vs-slug naming) — explicitly deferred; not in this plan.

**Placeholder scan** — searched the plan for TBD/TODO/FIXME — none found. Every code-affecting step includes the actual diff or content.

**Type consistency** — all script names (`pnpm typecheck`, `pnpm test`, `pnpm build`), file paths (`tsconfig.test.json`, `CHANGELOG.md`, `LICENSE`), and CLI invocations are spelled identically across tasks.

**Risk gates** — every code-affecting task runs `pnpm typecheck && pnpm test` before committing. Every manifest/migration task includes a `paperclipai plugin uninstall && install` round-trip + a `bridge:data` smoke test.

---

## Execution notes

- Tasks **1-6 can run sequentially with no inter-task dependencies beyond LICENSE-before-license-string** (i.e., Task 1 before Task 2).
- Tasks **7-10 must run in order** (state.get investigation → version bump → publish dry-run → tag).
- If any task surfaces an unexpected regression, **stop and surface it before continuing** — don't bundle a fix into the next task's commit.
- Frequent commits: every checkbox group ends with a commit; do not let multiple tasks share a commit.
- Don't run `npm publish` (no `--dry-run`) from this plan — that's a separate user decision after the RC sits for a day.
