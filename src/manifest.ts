import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "claude-token-cost-reports",
  apiVersion: 1,
  version: "1.0.0-rc.3",
  displayName: "Claude Token Usage",
  description:
    "Track Claude token usage per company, accumulate daily totals, and export a monthly CSV priced at configurable per-model rates (Opus 4.8 / 4.7, Sonnet 4.6 / 4.5, plus 1M context variants). The dashboard is mounted at the host's company-scoped plugin page (open from the company sidebar) and per-company pricing is configured here in the plugin settings.",
  author: "@herrhelms",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "api.routes.register",
    "ui.page.register",
    // Pricing config is stored in ctx.state (company-scoped) so it survives
    // reinstalls and migration changes. The host gates reads and writes via
    // separate capabilities — declaring only .write means saves succeed but
    // loadPricing(getPricing) silently returns null on the next render and the
    // UI falls back to defaults. Declare both.
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "instance.settings.register",
    // costs.read gates delivery of `cost_event.created` to the worker.
    // Without it, ctx.events.on("cost_event.created", ...) silently never fires.
    "costs.read",
    // agents.read lets us enrich per-model breakdown with agent attribution
    // (which agent burned which tokens) — required for future per-agent rollups
    // and already useful in logs.
    "agents.read",
    // companies.read lets the CSV exporter look up the company's display name
    // so the downloaded filename is "usage-acme-corp-…csv" instead of the
    // opaque UUID. Falls back silently when the capability is denied.
    "companies.read",
    // http.outbound is needed by the daily FX-rate job: it GETs
    // https://open.er-api.com/v6/latest/USD and parses the {rates} map so the
    // dashboard can convert per-1M USD costs to the operator's chosen
    // billing currency (e.g. EUR) at query time.
    "http.outbound",
  ],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui",
  },
  database: {
    migrationsDir: "migrations",
    // Read-only access to the host's cost_events table so the worker can
    // backfill historical token usage that pre-dates the plugin install.
    // The host whitelists this table for plugin reads; ctx.db.query can
    // SELECT from public.cost_events but cannot mutate it.
    coreReadTables: ["cost_events"],
  },
  jobs: [
    {
      jobKey: "rollup-daily",
      displayName: "Roll up daily token usage",
      description:
        "Recompute today's usage_daily rows for each company from usage_events.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "fetch-fx-daily",
      displayName: "Fetch daily FX rates",
      description:
        "Once per hour, ensure today's USD-base FX rate is stored for every currency any company has configured. Idempotent per (day, currency).",
      schedule: "7 * * * *",
    },
  ],
  apiRoutes: [
    {
      routeKey: "export-monthly-csv",
      method: "GET",
      path: "/export/monthly.csv",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "usage-page",
        displayName: "Token Usage",
        exportName: "UsagePage",
        // Host validation: routePath must be a single lowercase slug — letters,
        // numbers, hyphens; no slashes. The host mounts this at the company-scoped
        // path it owns; we don't get to insert intermediate path segments.
        // "tokens" reads cleaner than "usage" since the host's prefix already
        // contains the plugin key: /$COMPANY/plugins/claude-token-cost-reports/tokens.
        routePath: "tokens",
      },
      {
        type: "settingsPage",
        id: "usage-settings",
        displayName: "Token Usage Settings",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
