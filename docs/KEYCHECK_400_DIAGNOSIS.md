# `@glance-apps/sync` — diagnosis report: GLANCEvault enable fails with `get row failed: 400`

**Repo:** `glance-apps/glance-sync` (the sync **client library**)
**Scope of this report:** everything done *in this repository* to diagnose/fix the
`get row failed: 400` seen when enabling GLANCEvault / clicking "Sync Now" in dayGLANCE.
**Status:** root cause **not yet conclusively proven**; one decisive artifact still missing
(the server access-log line for the failing request). See [§6](#6-the-open-question).

This is one of three reports (dayGLANCE app, GLANCEvault server, sync library). Read together.

---

## 1. The symptom

Enabling GLANCEvault (or "Sync Now") shows `get row failed: 400` and DB-tier sync never starts.

- `get row failed: 400` is **this library's** error string. It comes from
  `createVaultClient`'s `getRow` → `jsonOrThrow(res, 'get row')` wrapping a server `400`.
  → So the failing call is the **single-row GET** the key verifier makes.
- The verifier GET is: `GET /sync/{app}/__glance_keycheck?accountId=<id>`
- Per the GLANCEvault side, that endpoint returns `400 {"error":"accountId is required"}`
  in exactly one condition: `accountId` missing/empty in the query string.

---

## 2. What the key verifier is (and why it makes this call)

Added in **1.5.0** (PR #19). Before pushing, the engine proves the passphrase-derived key
matches the account, once per session:

1. `GET /sync/{app}/__glance_keycheck?accountId=<id>` (a reserved, engine-owned row)
   - `404` → treat as new account, then **write** the verifier via `POST /sync/{app}/batch`
     with `{ accountId, rows: [{ entityId: "__glance_keycheck", envelope, createdAt, insertOnly: true }] }`
   - `200` → decrypt the envelope under the derived key to validate
2. The verifier **gates the push** — nothing uploads until it succeeds.

The verifier runs inside `ensureRootKey()`, **after** the root key is available. When the
root key is already cached on the device, `ensureRootKey()` **skips the salt step**, so the
verifier's `getRow` is the **first** server call of the cycle. That is consistent with the
failure surfacing as `get row failed: 400` and nothing else failing first.

---

## 3. Timeline of changes in this repo

| Version | PR | State | What it did | Honest value re: this bug |
|---|---|---|---|---|
| **1.5.0** | #19 | **merged + published** | Added the key verifier + per-row decrypt quarantine (the originally-requested feature). | This is the feature that **introduced** the verifier `getRow`, i.e. the call that now 400s. Legit feature; also the source of the breakage. |
| **1.5.1** | #20 | **merged + published** | Hardened `verifyAccountKey` to throw a typed `VERIFIER_UNSUPPORTED` when the **server** can't host the verifier (e.g. 400/405/500 on the reserved id), instead of a raw error. Added `config.allowUnverified` escape hatch. | **Low/none for this bug.** Built reacting to a hypothetical server-incompat scenario; not the observed cause. |
| **1.5.2** | #21 | **OPEN — NOT published** | Validates `accountId` on every row-scoped client call and throws a clear, typed, retryable `ACCOUNT_ID_REQUIRED` instead of putting a malformed `?accountId=` on the wire; tightens the engine constructor to also reject **whitespace-only** ids; stops mislabeling client-readiness errors as `VERIFIER_UNSUPPORTED`. | **Small real value** (clear error instead of cryptic 400) but **does not fix the underlying problem** if the app passes an empty/whitespace id. Deliberately **not published** pending root cause. |

Branch with 1.5.2: `claude/keycheck-accountid-fix` (commit `d855f08`). PR #21 is open against `main`.

> Note: a later experiment to add value-describing error messages (`describeAccountId`) was
> **not committed** and is not in the repo. The committed 1.5.2 uses the simpler message
> `"... accountId is required but was missing or empty."`

---

## 4. The key experiment (what is actually proven about the client)

Driving the **real** `createVaultClient` + `createDbSyncEngine` with a recording `fetchImpl`,
on a fresh account with a normal `accountId`:

```
GET  https://vault.example/salt/house-1
PUT  https://vault.example/salt/house-1
GET  https://vault.example/sync/dayglance/__glance_keycheck?accountId=house-1   → 404
POST https://vault.example/sync/dayglance/batch
     BODY={"accountId":"house-1","rows":[{"entityId":"__glance_keycheck",...,"insertOnly":true}]}
```

**Proven:**
- When the engine is given a non-empty `accountId`, the verifier GET **always** carries
  `?accountId=<id>`. `getRow` builds the query the same way the working `list` call does.
  There is **no** engine code path that calls `getRow` without `accountId`.
- On `404`, the verifier write includes `accountId` in the body **and** `insertOnly: true`.

→ The client library does **not** silently drop `accountId`. Confirmed independently.

---

## 5. The crucial version nuance (published vs. fixed)

The construction guard differs between published and unpublished versions:

- **Published 1.5.0 / 1.5.1:** `if (!accountId) throw 'accountId is required'`
  Catches `""`, `undefined`, `null` — **does NOT catch a whitespace-only string** (`"   "` is
  truthy). A whitespace `accountId` therefore **constructs the engine successfully**, then
  serializes to `?accountId=%20%20%20`, which the server trims to empty → **400**.
- **Unpublished 1.5.2 (PR #21):** `if (typeof accountId !== 'string' || accountId.trim() === '')`
  Catches whitespace too, and the vault client rejects empty/whitespace before any request.

**Consequence for the "it can't be empty" argument:** on the *published* version, "the engine
constructed, therefore `accountId` was non-empty" only proves it was **truthy**, not that it
was **usable**. A whitespace id passes the published guard and then 400s on `getRow`. The
"empty/whitespace value" theory is **not** disproven by the construction guard on 1.5.1.

---

## 6. The open question (what is NOT yet proven)

Two cross-component claims currently contradict each other:

- **GLANCEvault (server) side:** the `400` occurs only when `accountId` is missing/empty in the
  query string; `GET .../__glance_keycheck?accountId=house-1` was reported to return `404`
  (i.e. the server handles the reserved id fine).
- **dayGLANCE (app) side:** `accountId` is populated in the URL; the app cannot send an empty
  one; therefore the `400` must be the server rejecting the reserved `__glance_keycheck` id.

They cannot both be correct for the same request. Relevant evidence from the library side:

1. The client does not drop `accountId` (§4) — so a *populated* engine id reaches the wire.
2. Published 1.5.1 does **not** block a **whitespace** id (§5) — so an empty-after-trim value
   is still possible despite the app's guards.
3. **The error body is `{"error":"accountId is required"}`** — the server is complaining about
   **accountId**, not about the entityId. If the server were rejecting the reserved
   `__glance_keycheck` id, the error would not name `accountId`. This leans **against** the
   "server rejects the reserved id" theory.

### The single artifact that resolves it

The **literal URL from the server access log** for the failing request:

- `...?accountId=` (empty) or `...?accountId=%20%20%20` (whitespace) → **value/app side**
  (consistent with the 1.5.1 whitespace gap).
- `...?accountId=<a real, non-empty id>` and it **still** 400s → **server side** (the reserved
  id is genuinely rejected, and the earlier server `404` reproduction was not representative).

A 30-second confirmation: `curl` the exact failing URL **and** a control with a known-good
`accountId`. Same id → 400 on both = server bug; different ids → value bug.

---

## 7. Honest assessment

- **1.5.0** delivered the requested verifier/quarantine feature, but that feature is also the
  origin of the failing call. Net value depends on whether the passphrase-safety feature is
  wanted.
- **1.5.1** added effectively nothing for this bug (speculative server-incompat hardening).
- **1.5.2** (unpublished) is a worthwhile robustness/clarity improvement — it converts the
  cryptic `get row failed: 400` into an explicit `ACCOUNT_ID_REQUIRED` and closes the
  whitespace gap — **but it is not a fix** if the true cause is server-side, and it does not
  make a known-empty id work (the engine cannot invent an account id).
- The diagnosis loop ran long because the proving experiment in §4 should have been run *first*.
  It would have shown immediately that the client threads `accountId` correctly and narrowed
  the search to "what value reaches the engine" vs. "what the server does with it."

## 8. Recommended next step

Do **not** publish 1.5.2 yet. First obtain the access-log line (§6) and decide:

- **Value/app side:** fix where dayGLANCE builds the engine config so `accountId` is populated
  (and not whitespace) before construction. 1.5.2 then becomes a nice-to-have guard that makes
  the failure obvious next time.
- **Server side:** fix GLANCEvault's handling of the reserved `__glance_keycheck` id. 1.5.2's
  `VERIFIER_UNSUPPORTED`/`allowUnverified` path (from 1.5.1) already degrades more gracefully,
  but the server is the real fix.

---

*Generated from the `glance-sync` repo. Commit reference for 1.5.2 work: `d855f08`
(branch `claude/keycheck-accountid-fix`, PR #21, open/unpublished).*
