# TODO before deployment

Self-audit forked from `claude-token-cost-reports`'s rc.3 audit. Items already
resolved in the Claude plugin are inherited green; items that travel forward
(production-install verification, install-UUID browser fetch) stay open.

Last reviewed: 2026-06-19 — initial fork.

---

### ~~4. CLI `bridge:data` produces `state.get` scope errors after first call~~ — NOT REPRODUCIBLE 2026-06-16

After the rename + idempotent migration pass, this no longer reproduces on consecutive `bridge:data` calls. Suspected cause: orphan schema from a previous install was confusing the host's invocation-scope dispatcher; purging via --force then reinstalling onto idempotent migrations cleared it. Keep on the watch-list for one production-grade install before publish.

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

## Path to 1.0.0 GA

1. Run `docs/PRODUCTION-INSTALL-CHECKLIST.md` on a non-dev host that has actual
   OpenAI agent activity. Confirm `provider = "openai"` is the correct filter
   string by checking `paperclipai cost by-agent-model` against the same range.
2. If the filter string differs (e.g., `"OpenAI"`, `"oai"`), update Task 6's
   filter and reinstall before tagging GA.
3. After at least one green production install, drop the `-rc.N` suffix,
   tag `v1.0.0`, push.
