# Production install checklist

Run this checklist on the **first non-dev Paperclip host** that installs the
plugin. The goal is to confirm the parts that local dev installs can't fully
exercise: a clean migration apply, real `cost_event.created` delivery, and the
absence of the `state.get` invocation-scope error that was on the watch-list
through 1.0.0-rc.1.

If every box checks green, mark blocker #4 in
`docs/TODO-BEFORE-DEPLOYMENT.md` as **CLOSED** and remove the watch-list note.

---

## 1. Install

```bash
paperclipai plugin install claude-token-cost-reports@1.0.0-rc.1
paperclipai plugin list
```

- [ ] `status=ready`
- [ ] `version=1.0.0-rc.1`
- [ ] An install UUID is printed (capture it: `<INSTALL_UUID>`)

If `status` is `error`, run `paperclipai plugin logs claude-token-cost-reports`
and capture the failure before continuing.

## 2. Migrations applied

```bash
paperclipai plugin inspect claude-token-cost-reports --json | jq '.migrations'
```

- [ ] Three rows: `001_init`, `002_costs_overview`, `003_fx_rates`
- [ ] All with `status: "applied"`
- [ ] None left in `pending` or `failed`

If a migration is `failed`, the host's namespace registry already has a record
for the plugin install but the schema may be partial. Reinstall with
`--force` and re-check. If it fails twice, capture the host's plugin logs and
the postgres error before escalating.

## 3. Capability grants

```bash
paperclipai plugin inspect claude-token-cost-reports --json | jq '.capabilities'
```

- [ ] `costs.read` is granted (this gates `cost_event.created` delivery — if
      it's missing, all the dashboard cards stay at zero)
- [ ] `agents.read`, `companies.read`, `http.outbound`, `plugin.state.read`,
      `plugin.state.write`, `database.namespace.{migrate,read,write}`,
      `events.subscribe`, `jobs.schedule`, `api.routes.register`,
      `ui.page.register`, `instance.settings.register` are all granted

## 4. Live event subscription

After at least one company has run any agent for a few minutes, check that the
worker actually saw a `cost_event.created` event:

```bash
COMPANY_ID="<one-of-your-company-uuids>"
paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json "{\"key\":\"getIngestStats\",\"params\":{\"companyId\":\"$COMPANY_ID\"}}" --json
```

- [ ] `totalEvents` is greater than 0 within ~5 minutes of agent activity
- [ ] `lastEventAt` advances as new agent runs complete
- [ ] `hasCostsReadCapability` is `true`
- [ ] `diagnosticHint` is `null`

If `totalEvents` stays at 0 for >10 minutes despite confirmed agent activity,
the issue is host-side event delivery — see "If events don't flow" below.

## 5. The `state.get` scope error watch-list (blocker #4)

This is the specific concern that kept blocker #4 open through 1.0.0-rc.1:
some hosts produced a `state.get: invocation scope` 502 on the SECOND
`bridge:data` call after a fresh install. Verify on this production host:

```bash
COMPANY_ID="<your-company-uuid>"

paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json "{\"key\":\"getPricing\",\"params\":{\"companyId\":\"$COMPANY_ID\"}}" --json
sleep 1
paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json "{\"key\":\"getPricing\",\"params\":{\"companyId\":\"$COMPANY_ID\"}}" --json

paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json "{\"key\":\"getFxStatus\",\"params\":{\"companyId\":\"$COMPANY_ID\"}}" --json
sleep 1
paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json "{\"key\":\"getFxStatus\",\"params\":{\"companyId\":\"$COMPANY_ID\"}}" --json
```

- [ ] All four calls return valid JSON
- [ ] None return `API error 502 ... state.get ... invocation scope`

If any call returns the scope error, capture the full output, the install
UUID, and the host's `paperclipai plugin logs claude-token-cost-reports`
output. Reopen blocker #4 with the production reproduction.

## 6. UI smoke test

Open the dashboard in a browser:

```
/$COMPANY_HANDLE/tokens
```

- [ ] The page renders without console errors
- [ ] The billing-config strip shows period, currency, margin, subscription
- [ ] All 6 KPI cards render (totals, input, output, list, net, price)
- [ ] The per-agent card lists at least one agent (after a few minutes of
      activity)

Open the settings page:

```
/$COMPANY_HANDLE/company/settings/instance/plugins/<INSTALL_UUID>
```

- [ ] All eight per-model rate inputs are editable
- [ ] Save persists; reloading the page shows the saved values
- [ ] Subscription preset dropdown shows Off / Pro / Max
- [ ] The "Open usage dashboard →" link navigates back to `/tokens`

## 7. Monthly CSV export

```bash
curl -O "https://<your-host>/api/plugins/claude-token-cost-reports/api/export/monthly.csv?companyId=$COMPANY_ID&from=2026-06-01&to=2026-06-30"
```

- [ ] HTTP 200
- [ ] CSV columns: `period,month_start,month_end,model,input_tokens,output_tokens,total_tokens,currency,price`
- [ ] `price` matches the dashboard's Sub-adjusted total for the same window
      (or the List total when subscription is Off)
- [ ] Filename includes the company slug and currency code

## 8. Final state on the TODO doc

If every box above is green, edit `docs/TODO-BEFORE-DEPLOYMENT.md`:

- Change blocker #4 from `NOT REPRODUCIBLE 2026-06-16` to
  `CLOSED <today> — verified on production host <hostname>`
- Drop the "Keep on the watch-list" line from the same section

Commit:

```bash
git add docs/TODO-BEFORE-DEPLOYMENT.md
git commit -m "docs: close blocker #4 — verified on production"
```

The plugin is now eligible for the `1.0.0` GA tag (drop the `-rc.N`
pre-release suffix from `package.json`, `src/manifest.ts`, and `CHANGELOG.md`,
then `git tag -a v1.0.0 -m "1.0.0: GA"`).

---

## If events don't flow

If `getIngestStats` reports `totalEvents: 0` for >10 minutes despite agent
activity, the host isn't delivering `cost_event.created` to the worker. Two
possible workarounds:

1. **Run the backfill action** — the plugin reads `public.cost_events`
   directly via the `coreReadTables` whitelist:

   ```bash
   paperclipai plugin bridge:action claude-token-cost-reports \
     --payload-json "{\"key\":\"backfillFromCostEvents\",\"params\":{\"companyId\":\"$COMPANY_ID\",\"from\":\"$(date -u -v-7d +%Y-%m-%d)\",\"to\":\"$(date -u +%Y-%m-%d)\"}}" --json
   ```

   This copies host cost-event rows into the plugin's `usage_events` table.
   The dashboard works from there; the worker subscription becomes a no-op
   fallback.

2. **Open a host issue** — `cost_event.created` not firing is a host-side
   gap, not a plugin bug. Confirm with the Paperclip team and link the
   workaround in this checklist for future installs.
