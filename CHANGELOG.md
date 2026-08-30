# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.11.0] - 2026-08-30

**Should you take this release?** Yes if you use the GLANCEvault transport, and
immediately if anything in your bundle writes to it on a timer. This release is
the client-side answer to a 2026-08-30 incident in which an intent-cleanup loop
in the dayGLANCE Obsidian plugin deleted rows that were already tombstones. The
server re-tombstoned on every call — fresh seq, fresh SSE nudge — which put the
row back above the caller's cursor and fed the loop its own output. It ran for
hours and saturated the server's per-IP rate budget, and it was **invisible**:
every delete was fire-and-forget behind a `.catch(() => {})`, so nothing failed
loudly enough to notice. Two patches landed elsewhere (the plugin no longer
deletes tombstones; the vault's `softDeleteRow` is now idempotent). This release
adds the protection and the visibility **by construction**, so no caller has to
remember them and no loop can be silent. No server changes: the wire contract is
untouched.

### Added

- **The intents transport.** `intentsBatch(accountId, events)` and
  `intentsList(accountId, { since, limit })` wrap the server's existing
  `/intents/*` endpoints, so apps can drop their hand-rolled raw-fetch
  transports and inherit this client's auth, error classification, brake and
  meter. `intentsBatch` is insert-only server-side — a re-sent `eventId` is a
  no-op — so retrying an ambiguous failure is safe by construction.
  - **Pure transport**: the `envelope` is opaque here and is never decoded or
    inspected. The codec, and the per-envelope key derivation it needs, stays
    in `@glance-apps/intents`; this package carries the transport without
    carrying the crypto.
- **A device-wide request brake.** Any real 429 now pauses *every* vault
  request in the bundle realm: 30s, doubling per burst to a 10-minute ceiling,
  one arming per burst (a concurrent fan-out that all meets the limiter costs
  one escalation step, not ten). While paused, calls fail fast — **before
  touching the network** — with a `VaultError` carrying `status: 429`,
  `code: 'RATE_LIMITED'` and `retryInMs`.
  - It is at **module scope, not per client instance**, deliberately: the thing
    it protects is shared by every client in the process (the server's per-IP
    budget), so the state that models it belongs to the realm. A separately
    bundled copy — the Obsidian plugin's, say — is its own realm, which is
    correct: separate process, separate traffic.
  - **Decay, never amnesty.** A 2xx releases the pause but only *halves* the
    escalation memory (below the 30s base it drains to zero). This is the fix
    for the earlier app-side brake, which reset escalation to zero on *any*
    success: on a saturated shared budget an occasional cheap request slips
    into a fresh limiter window and returns 200, and each lucky 200 wiped the
    whole 30s→480s escalation and re-licensed full cadence. Halving keeps the
    storm's level in memory — the next 429 re-arms at 2× what is left — while a
    genuine recovery still drains to nothing in a few quiet successes.
  - Reads: `isVaultRateLimited()` and `vaultBrakeStatus()`, for callers that
    prefer to sit a whole cycle out pre-flight. Escape hatch:
    `createVaultClient({ brake: false })` opts a client out of both the gate
    and the arming.
- **A budget meter.** Requests are counted per rolling minute and attributed by
  method name. Crossing a soft threshold (default 300/min — half the server's
  default per-IP budget, configurable) logs **one** line per window naming the
  top contributors: `[vault] budget: 412 requests in the last minute (soft
  limit 300) — top: intentsList 210, batch 130, deleteRow 72`. Visibility only;
  it never throttles. Its whole argument is that it needs no theory about *why*
  a loop is running, so the next storm is an attributed event on day one rather
  than an afternoon of archaeology.
- **A write-loop detector — the success-side signal.** Failure visibility
  already existed; what was missing on the day was the signal for everything
  "succeeding" pathologically. The client now keeps a bounded per-`entityId`
  history across `batch` upserts and `deleteRow`, and warns loudly (once per id
  per window) when one id flips polarity, or is rewritten with identical
  content, four times inside ten minutes. Diagnostic only — never a brake.
  - **Fails open by construction**: the rule needs repeated events on the
    *same* id, so a first sync or a large import — many different ids, one
    event each — can never trigger it, however large.
  - Both thresholds are tunable via `configureVaultDiagnostics`. Four
    transitions means five events (upsert/delete/upsert/delete/upsert), which
    no human edit pattern produces and every delete/resupply loop produces
    within seconds; ten minutes is long enough to catch a loop running on a
    60s sync cycle and short enough that a week of ordinary edits never
    accumulates into it.
- `getVaultStats()` returns all three in one read: brake status, the last
  rolling minute of requests by method, and the current write-loop suspects.
  `configureVaultDiagnostics(options)` tunes the visibility-only thresholds and
  the log sink; `resetVaultDiagnostics()` clears everything (for tests).

### Changed

- Every `createVaultClient` method now passes through the brake and the meter.
  The only behaviour change a healthy caller can observe is the new
  `RATE_LIMITED` rejection while a window is open — and only after the server
  has already answered a real 429.
- A **429 arms the brake only when it is a rate-limiter hit**, never when it is
  an over-quota rejection. The server uses 429 for both and they call for
  opposite handling: a limiter hit means "stop asking for a while" (exactly
  what the brake does), while a quota rejection means the account is full,
  clears only when an operator acts, and already has its own self-resuming
  window in the DB engine. Gating on it would hide `QUOTA_EXCEEDED` and its
  descriptor behind `RATE_LIMITED` and leave apps unable to render "X of Y
  used". The quota shape is recognised as narrowly as before, so anything that
  is not unmistakably a quota body is treated as a limiter hit.

### Notes

- **Not gated**: `fetchVaultHealth` and `enrollVaultDevice`. Both are
  pre-credential, user-initiated, one-shot calls — `/healthz` is the
  unauthenticated probe you reach for *while* diagnosing a stuck client, and
  refusing it during a braked window would take away the diagnostic just when
  it is wanted.
- **For lastGLANCE / lifeGLANCE**: safe to take at leisure (semver-minor).
  During a braked window, client calls fail fast with `VaultError { status:
  429, code: 'RATE_LIMITED' }` instead of hitting the wire; any ladder that
  already treats a real 429 as transient — they all do — handles it unchanged.
  The meter and the write-loop warnings come along for free.
- An AES-GCM envelope carries a fresh random IV, so identical plaintext does
  not produce an identical envelope: for encrypted payloads it is the polarity
  flip that fires the detector, and the identical-content rule covers plaintext
  and deterministic payloads.

## [1.10.0] - 2026-08-01

**Should you take this release?** Yes, for any deployment using the database
(GLANCEvault) transport. Until now the DB sync engine had **no backoff of any
kind**: on a persistent failure it re-sent the same request on every cycle,
forever, at whatever rate the app polls. A server that was down, a device
offline, a wrong token — all of them produced an unbounded request loop. This
release adds the backoff the file tier has always had, and fixes two related
defects found alongside it. The file-tier (WebDAV) engine is untouched.

### Fixed

- **The DB engine no longer hammers a failing server.** Both directions now
  back off: 30s doubling to a 15-minute cap for pushes and a 5-minute cap for
  pulls, with a flat one hour on an authentication failure — the file tier's
  numbers, escalation curve and reset rule. Any success resets the window and
  its strike count. A window only ever **delays**: the next ordinary cycle
  after it expires probes again, with no user action and no restart, and
  dirty rows are never dropped — backoff changes *when* a push is retried,
  never *whether* it is.
  - Unlike the file tier's, the DB engine's backoff is **self-enforcing**: the
    engine skips its own work when called too soon. (The file tier's is
    advisory — nothing reads `uploadBackoffUntil` except its getter, so
    honouring it is the app's job. That is exactly why the hammering was live
    in every published version.) `getUploadBackoffUntil()` and
    `getDownloadBackoffUntil()` are exposed with the same names and meaning as
    the file tier's so one scheduler can treat both tiers alike, but honouring
    them is now an optimisation rather than a duty.
- **A failed pull no longer aborts the cycle.** 1.9.0 contained push failures
  but left pull failures throwing past the device-cursor report. A pull error
  is now captured the same way, so the cursor still reports on a cycle whose
  pull failed.
- **The pull cursor is persisted per page.** It was written only after the
  whole pagination loop, so a failure on page 3 discarded the progress of
  pages 1 and 2 — a large backlog on a flaky connection could re-download the
  same pages indefinitely and never converge. Every row in a page reaches a
  terminal outcome (applied, quarantined, or skipped as engine-reserved)
  before the page ends, so the cursor may safely advance past each completed
  page.
- **A rejected credential surfacing from the push or pull now halts.** Once
  the key is verified in-session, `ensureRootKey` makes no network call, so a
  mid-session revocation is first seen by the push or the pull — and 1.9.0's
  error capture routed those away from the halt path. They now reach exactly
  the same halt logic as before; the halt itself, its identity rule, and the
  `invalid credential` body match are unchanged.

### Changed

- **Over-quota suppression is now one case of the backoff ladder**, not a
  parallel mechanism. Its behaviour is unchanged — same curve, same
  in-memory lifetime, still surfacing `QUOTA_EXCEEDED` with its descriptor on
  every suppressed cycle so apps can render "X of Y used" — but
  `getQuotaState()` and `isQuotaSuppressed()` are now derived from the push
  window rather than a separate variable.
- **A shared-mode 401 is now delayed rather than retried immediately.** It
  opens the one-hour auth window instead of being re-sent every cycle. It is
  still not terminal and still not the credential halt: it self-resumes.
- New: `getBackoffState()` returns `{ push, pull }` windows with `until`,
  `reason` (`'quota' | 'auth' | 'transport'`), `code`, `strikes` and `since`.
  The `reason` is what lets an app distinguish a one-hour auth backoff from a
  thirty-second transport one without inferring it from the timestamp.
- The cycle result gains `pullFailed`, `pullSkipped` and `pullErrorCode`,
  mirroring the push fields added in 1.9.0.

### Notes

- **Classes that are never delayed**, deliberately: `PASSPHRASE_REQUIRED` and
  `ACCOUNT_ID_REQUIRED` fire before any network call and clear the instant the
  app supplies the value, so a window would make the app feel broken for 30
  seconds after a user types their passphrase; and `CREDENTIAL_INVALID` is
  owned by the (terminal) credential halt, so stacking a window on it would be
  meaningless at best. `QUOTA_EXCEEDED` opens exactly one window, its own.
- **For app integration — do not render backoff from the last `onError`
  message.** On a cycle suppressed by a quiet (transport or auth) window, the
  cycle's usual `onError(null, null, false)` reset still fires and nothing is
  re-surfaced, so an app that remembers the last error string will see it
  *cleared* while `onStatusChange` reads `'error'`. This is deliberate (quiet
  windows report once; repeating every cycle is the noise this release
  removes). Render standing backoff from `getBackoffState()` — `reason` plus
  `until` gives "retrying in Xs" — and treat `onError` as an event stream, not
  a status store. Quota windows are the exception and keep re-surfacing
  `QUOTA_EXCEEDED` with the descriptor each cycle.
- The cycle result now reports a superseded stale instance truthfully:
  `{ superseded: true }` rather than `{ halted: true }`, matching
  `isSuperseded()` / `isCredentialHalted()` whichever path the credential
  rejection arrived by.
- A healthy client is unaffected: no window is ever opened, no added latency,
  and an identical request pattern.

## [1.9.0] - 2026-08-01

**Should you take this release?** Yes if you run, or might run, a GLANCEvault
server with a row cap configured (`GLANCEVAULT_QUOTA_*`, server Phase 3.2).
Also yes for the sync-reliability fix below, which applies to **every**
deployment including shared mode and unconfigured servers: before this
release, a failed push also cost you the pull, so a device whose writes were
failing silently stopped receiving other devices' changes too. Nothing here
changes behavior against a server with no quota configured, which is and will
remain the common case.

### Fixed

- **A failed push no longer prevents the pull.** The DB sync cycle threw
  straight from a push failure to its error handler, so `pullRemoteChanges`
  and the device-cursor report never ran. A device that could not write — for
  *any* reason: a transport blip, a 500, a server-side cap — also stopped
  **reading**, and silently fell behind its peers. The push error is now
  captured, the pull and cursor run regardless, and the error is reported
  after. Applies to every transport failure, not just the quota case that
  exposed it. Behavior on a fully successful cycle is unchanged.
  - A cycle whose push failed but whose pull succeeded now returns
    `{ applied, skipped, skippedEntityIds, pushFailed: true, pushErrorCode,
    quota }` — the pull's own numbers are reported as usual, and `onError`
    fires with the push error's code and `isHardStop: false`. `lastSynced` is
    deliberately **not** advanced (the device is not fully in step), and the
    dirty rows are retained for the next cycle exactly as before.
- **A quota rejection is no longer mislabelled "update your server".** The key
  verifier's establishing write is a net-new entity, so a fresh device on an
  account at the row cap gets a 413 there — and every error on that path was
  relabelled `VERIFIER_UNSUPPORTED` ("Your GLANCEvault server needs to be
  updated to support key verification"), sending the user to fix a server
  that is working correctly. `QUOTA_EXCEEDED` now passes through that
  classifier, the same way `CREDENTIAL_INVALID` and the client-readiness
  codes already did.

### Added

- **Over-quota handling for the reachable dimension (server Phase 3.2 /
  client Phase 3.3).** A 413 or 429 carrying the server's quota body
  (`{ error: "quota exceeded", quota, limit, used, requested }`) is now typed
  as `QUOTA_EXCEEDED` and carries the parsed descriptor, so consumers no
  longer have to substring-match an error message to tell a quota rejection
  from any other failure.
  - **Never a halt.** A quota condition is the opposite of a rejected
    credential: it clears when the operator raises the limit or reclaim runs
    — with **no client action at all** — so the engine keeps running.
    `isHardStop` is always `false`, nothing is persisted, and there is no
    recovery entry point and nothing to clear.
  - **Bounded, self-resuming suppression** instead of retrying a doomed write
    every cycle: after a rejection the engine skips the *write* for 30s,
    doubling on repeat to a 15-minute cap (the file tier's backoff shape),
    while pulls and cursor reports continue untouched. The next ordinary
    cycle after the window probes again; a write that gets through clears the
    state by itself. Raising the server limit is picked up with no restart,
    no re-enrollment, and no user action.
  - New state queries: `getQuotaState()` (the descriptor plus `since` /
    `retryAt`, in memory only) and `isQuotaSuppressed()`.
  - **Defensive parse.** A body earns the typed classification only with the
    exact wording, a non-empty `quota` string, and three finite numbers.
    A missing field, a non-JSON body, a 413 with no quota fields, the legacy
    SSE `{"error":"too many connections for account"}` 429, or an older
    server that never sends this shape all degrade to the generic
    `VAULT_ERROR` handled before — never a throw, never a mis-classification.
    An **unrecognised** `quota` dimension from a newer server is passed
    through verbatim and still treated as a quota condition, since the remedy
    is the same; render an unfamiliar dimension generically.

### Notes

- **Scope: `rows` is the only quota dimension this package can reach.** The
  server enforces `storage` and `concurrent-uploads` at the blob path, and
  `intents` at the intents route; this package has no blob path (media is
  stripped at the adapter boundary) and no intents path (that is
  `@glance-apps/intents`), and no SSE client. So "text syncs while media
  fails" is not something this package can exercise. Handling for those
  dimensions belongs with the media transport work that would call them, and
  was deliberately not written here.
- **Known gap, not fixed here:** the DB engine has no backoff of any kind
  outside the quota window above. On a persistent write failure the same
  dirty rows are re-pushed on every cycle indefinitely, where the file tier
  has exponential backoff with an auth-failure escalation. This is a real
  defect with a live blast radius and it wants its own change rather than a
  corner of this one.

## [1.8.0] - 2026-07-31

### Added

- **Recovery from a halted credential (GLANCEvault Phase 2.2).** The 1.7.0
  credential halt was built with no exit; this release adds the one exit:
  **`recoverVaultSyncEngine(config)`**, user-initiated re-enrollment with the
  bootstrap secret. Since server Phase 2.1, enrolling the same byte-exact
  `(accountId, deviceId)` revokes every still-active predecessor credential
  in the same transaction, so recovery is a rotation — the dead credential is
  superseded, not accumulated alongside.
  - **Halt-gated, structurally.** The call refuses with `NOT_HALTED` unless
    the device is credential-halted, so it cannot be wired into a startup or
    retry path as an on-demand rotator. Combined with the package holding no
    secret (one must be supplied fresh, and it is confined to the call
    exactly as in `connectVaultSyncEngine` — never stored, logged, or
    retained), user initiation is structural, not procedural. **No code path
    recovers automatically**, including transport failures, startup, or a
    halt discovered at launch.
  - **Per-account only, no fallback.** Unlike connect, recovery never falls
    back on discovery failure: an unreachable `/healthz` is
    `VAULT_UNREACHABLE` and a non-per-account mode is
    `RECOVERY_UNSUPPORTED`; both leave the device halted and untouched.
    Shared mode has no credentials, no halt, and no reachable recovery path.
  - **Order of operations**, each failure leaving the device halted rather
    than ambiguous: halt gate → deviceId resolution → mode guard → storage
    canary (now restores the slot's prior contents, so a failed recovery
    keeps the stale record byte-identical) → enroll → persist + read-back
    verify (overwriting the stale record — it does not survive recovery) →
    **clear the halt last** → return a fresh engine. The old engine's client
    closes over the dead credential; apps must swap to the returned engine.
  - **deviceId: the stale record's value wins.** Rotation only lands if
    enrollment uses the identity the dead credential is bound to, and the
    stored record is ground truth for that. An explicit `config.deviceId`
    that differs is surfaced as `DEVICE_ID_CONFLICT`, never resolved
    silently (either choice orphans a credential or a cursor). With no
    readable record: explicit value, else the persisted package-owned id.
    Never minted fresh.
- **Halt-set identity rule** (the stale-engine hazard fix). The halt key is
  shared by every engine instance on a device, so an old instance still
  holding the superseded credential could previously re-halt the device
  after recovery. Now, on `CREDENTIAL_INVALID`, the engine halts **unless**
  the stored credential record exists, is readable, and holds a *different*
  credential than the engine's bearer — definitive proof the instance was
  superseded. **The rule fails toward halting**: a missing or unreadable
  record still halts (the naive "no record → no halt" would retry a dead
  credential forever, exactly what the halt exists to prevent). A superseded
  instance goes **inert in memory** instead — surfaced once via
  `onError('CREDENTIAL_INVALID', isHardStop true)`, then silent, zero
  network, never touching the shared halt key — killing both the bricking
  and the pointless server load. New state query: `isSuperseded()`.
- The 1.4b minted-but-lost-persistence residual is now self-healing: a
  credential minted and then lost to a persistence failure is superseded by
  the next successful enrollment for the same `(accountId, deviceId)`.

### Fixed

- **Device cursors now report on installs that never configured a
  `deviceId`, automatically on upgrade.** Such installs have never updated
  their device cursor: the cursor step silently no-opped (`{updated:
  false}`) whenever no `deviceId` was passed, so the server's tombstone GC
  had no cursor for those devices. On upgrade, a device id is generated and
  persisted (`{prefix}-device-id`) at engine construction, and cursor
  reporting begins on the first completed sync cycle — **no app changes
  required**; this applies to plain `createDbSyncEngine` construction, not
  only the new connect flow, and identically in shared and per-account
  mode. Installs that already pass an explicit `deviceId` are unaffected
  and keep using it. Operator note: an install this fixes has no prior
  cursor history, so the newly generated id strands nothing.
  (This shipped in 1.7.0's device-identity work but 1.7.0 was never
  published; it reaches consumers with this release.)

### Upgrade notes

Two behavior changes arrive with the fix above, without opt-in:

- **Engine construction now touches localStorage.** `getOrCreateDeviceId`
  reads and writes `{prefix}-device-id` at construction time; previously
  construction deferred all localStorage access to cycle time. In an
  environment without a `localStorage` global, construction now fails where
  it previously succeeded and failed later at first sync. Theoretical for
  browser and WebView hosts (all three GLANCE apps), but if construction
  throws before any network activity, look here first.
- **Injected `vaultClient` consumers see new `device()` calls.** An engine
  constructed with `config.vaultClient` and no `deviceId` previously made
  zero `device()` calls; it now makes one per cycle. A mock or bridge
  client without a `device()` method will throw inside the cursor step —
  swallowed and warned, never fatal — but the console warning is new and
  recurring. Affects tests with mock clients and native shells that inject
  a bridge client.

## [1.7.0] - 2026-07-31

### Added

- **Per-account vault auth, client half (GLANCEvault Phase 1.4b).** A
  GLANCEvault server can run `authMode: 'per-account'`, where each device
  authenticates with its own enrolled credential instead of the instance-wide
  shared device token. The package owns the whole client-side flow — apps hand
  it a bootstrap secret (or the shared token) and get a working engine back,
  without implementing discovery, branching, credential persistence, or
  secret discard themselves. Shared mode remains the default path and is
  byte-for-byte unchanged.
  - **`connectVaultSyncEngine(config)`** — the packaged connect flow.
    Discovers the server's auth mode from `/healthz`, then branches:
    `shared` → builds the engine from `config.vaultToken` exactly as before;
    `per-account` → uses the credential persisted under
    `{prefix}-vault-credential`, enrolling with `config.enrollmentSecret`
    only when no credential is stored for this exact (server, account). The
    credential is persisted durably (write + read-back verify) **before**
    enrollment is treated as complete, and a storage canary runs **before**
    minting so broken storage cannot orphan one server row per launch. The
    bootstrap secret is never written to storage, never logged, never placed
    on the engine config, and not retained past the call. **No code path
    re-enrolls automatically** — once a credential is stored it is always
    reused, even after rejection (recovery is Phase 2.2), so revocation
    (vault Phase 2.1) cannot be silently undone by a client loop. Discovery
    failure (server unreachable, unexpected body) falls back to the last
    known auth state — stored credential, else `vaultToken` — which is
    exactly the pre-1.4b behavior for existing installs; an unrecognized
    future mode string does the same rather than guessing. A `/healthz`
    without `authMode` (a pre-1.4a server) is ordinary shared mode, not an
    error. Typed failures: `VAULT_TOKEN_REQUIRED`,
    `ENROLLMENT_SECRET_REQUIRED`, `CREDENTIAL_PERSIST_FAILED`,
    `VAULT_UNREACHABLE`, plus the enrollment errors below.
  - **`getOrCreateDeviceId(storageKeyPrefix)`** — the package now owns the
    stable device identity: generated once (`crypto.randomUUID`, with a
    `getRandomValues` fallback for old WebViews) and persisted under
    `{prefix}-device-id`; used for both the device cursor and enrollment. An
    explicit `config.deviceId` still wins. This also fixes a latent bug: the
    engine's device-cursor update silently no-oped (`{updated:false}`) when
    no `deviceId` was configured, so such installs never reported cursors —
    on upgrade they get a generated id and start reporting for the first
    time (server-side effect: a `devices` row appears and tombstone GC gains
    an accurate cursor; pure improvement, no data risk).
  - **Substrate exports** (used by the flow, available standalone):
    `fetchVaultHealth({ vaultUrl, fetchImpl? })` — unauthenticated
    `GET /healthz`, `authMode` normalized to `'shared'` when the server
    predates the field; and `enrollVaultDevice({ vaultUrl, enrollmentSecret,
    accountId, deviceId, fetchImpl? })` — `POST /enroll`, secret in the body
    only, values sent byte-exact, typed `ENROLLMENT_REJECTED` (401) /
    `ENROLLMENT_UNSUPPORTED` (404, shared-mode server) failures, and
    `*_REQUIRED` codes thrown before touching the wire on missing fields.
  - **`CREDENTIAL_INVALID` and the credential halt.** `createVaultClient`
    now reads error bodies best-effort: a 401 whose body says
    `invalid credential` (the server's chosen signal for "this device must
    re-enroll") surfaces as code `CREDENTIAL_INVALID`; a missing, non-JSON,
    or unrecognized body degrades to the generic `VAULT_ERROR`, so client
    correctness never depends on server wording. On `CREDENTIAL_INVALID` the
    DB engine persists a stop under `{prefix}-db-sync-credential-halt`,
    surfaces `onError(message, 'CREDENTIAL_INVALID', /* isHardStop */ true)`,
    and makes **no further network calls** — across restarts. Nothing in
    this version clears the halt (that is Phase 2.2's recovery flow);
    `isCredentialHalted()` / `getCredentialHalt()` expose the state.
    Shared-mode 401s (`invalid device token`) keep today's retryable
    behavior. The key verifier passes `CREDENTIAL_INVALID` through instead
    of relabeling it `VERIFIER_UNSUPPORTED`, so `allowUnverified` can never
    wave a rejected device through.
  - `createVaultClient` is otherwise unchanged on the wire; `vaultToken`
    accepts either the shared device token or an enrolled credential — the
    credential IS the Bearer token.

### Security notes

- The persisted credential lives in localStorage, exactly as exposed as the
  shared device token and the file tier's provider passwords are today:
  parity, not a regression. Secure-storage migration is explicitly out of
  scope for this phase.

## [1.6.1] - 2026-07-19

### Fixed

- **File engine: persistent PRECONDITION_FAILED (412) sync loop on servers
  that mangle ETags** (lastGLANCE issue #232). The optimistic-concurrency
  cycle (GET capturing an ETag, merge, PUT with If-Match) can never converge
  against a server whose GET responses carry a mangled validator: Apache
  mod_deflate rewrites the ETag on gzip-encoded responses to `"xyz-gzip"`
  (Android's HttpURLConnection silently requests gzip, so native apps always
  hit this on Apache-fronted servers such as standard Nextcloud installs), and
  nginx's gzip filter downgrades strong ETags to weak (`W/"xyz"`), which
  If-Match's strong comparison rejects. Either way every PUT 412s, the
  single conditional retry fetches another mangled ETag and 412s again, and
  sync wedges until the user hand-deletes the sync file from the server. Two
  complementary fixes:
  - **ETag normalization at capture time.** A new exported pure helper,
    `normalizeEtag(raw)`, strips the weak-validator prefix (`W/"abc"` becomes
    `"abc"`) and the known content-coding suffixes Apache appends inside the
    quotes (`"abc-gzip"` / `"abc-br"` become `"abc"`), preserving surrounding
    quotes and passing null/undefined through. `parseDownloadResponse` now
    normalizes every ETag it captures, so If-Match round-trips the entity's
    real validator. Clean ETags are unchanged, so servers that never mangle
    see identical behavior.
  - **Termination guarantee: a second consecutive 412 falls back to an
    unconditional upload.** If the conditional retry after a 412 itself fails
    with PRECONDITION_FAILED (any other error keeps the existing
    backoff-and-surface behavior), the engine runs one final
    download-merge-upload cycle whose PUT omits If-Match entirely
    (last-writer-wins). The uploaded payload is the merge of local state with
    the remote fetched milliseconds earlier in the same cycle, so the
    lost-update window is tiny - far safer than a permanently wedged sync
    that pushes users toward deleting the sync file. If the fallback cycle
    itself fails, the error is surfaced exactly as the old retry-failure path
    did (exponential backoff, `onError`, status `'error'`).

### Added

- `normalizeEtag(raw)` exported from the package root for reuse by apps.

## [1.6.0] - 2026-07-10

### Fixed

- **DB engine: a pulled delete no longer unconditionally beats a newer local
  edit.** `applyRemoteRow` applied a pulled `deleted: true` row without any
  timestamp comparison AND pruned the entity from the dirty set, so a device
  that edited an entity offline (with a newer `lastModified`) and then pulled a
  peer's delete before pushing silently discarded its own newer edit — the
  opposite of the engine's upsert conflict rule and of the file tier's
  newest-write-wins over tombstones. Deletes now participate in the same
  entity-grain LWW: the engine stamps each pushed soft-delete with a
  `deletedAt` (epoch ms, taken at push time) and applies a pulled delete only
  when the local copy's `lastModified` does not exceed that stamp. When the
  local edit is strictly newer, the delete is discarded and the entity is
  marked (or kept) dirty so the next push re-upserts it over the tombstone and
  restores the row fleet-wide.
  - **Tie-break:** on an exact timestamp tie the DELETE wins (unlike the upsert
    rule, where local wins ties), because `deletedAt` is stamped at push time
    and therefore already post-dates the deleting device's own last edit.
  - **Backward compatibility:** a tombstone with no `deletedAt` — from a
    GLANCEvault server that predates the stamp, or a row deleted by an older
    client — keeps the previous unconditional delete-wins behavior. `deletedAt`
    rides the DELETE request as an extra query param, which old servers ignore.
- **DB engine: push sends upserts before deletes, closing the transient
  fleet-wide delete window.** `pushDirtyRows` used to issue the per-entity
  `deleteRow` calls before the batched upserts. A cross-list move (delete
  `unscheduledTasks:X` + upsert `tasks:X` in the same dirty set) that failed
  between the two steps (5xx / network drop) left the delete on the server with
  no replacement row, so every peer pulled a bare delete and the entity
  vanished fleet-wide until the origin device successfully retried. The batch
  upsert now runs first; a failure between the steps leaves the benign inverse
  (both rows briefly exist) and the retained dirty set retries both
  idempotently. No invariant depended on the old order: upserts and deletes in
  one push can never share an `entityId`, and `maxSeq`/ack accounting is
  order-independent.

### Changed — behavior notes for consumers

- Delete/edit races now resolve by newest-write-wins instead of delete-always-
  wins. An entity edited on one device *after* (per wall clock) another
  device's deletion will be **restored on all devices** rather than deleted.
  Apps relying on "delete always sticks" semantics should treat this as a
  breaking behavior change. Clock skew caveat: `deletedAt` comes from the
  deleting device's clock at push time, so a device with a fast clock can win
  conflicts it shouldn't — same trust model as the existing `lastModified` LWW.
- During a partial push failure, peers may transiently observe a moved entity
  in both its old and new lists (previously: in neither) until the retry lands.
- Unchanged (regression-guarded): upsert LWW keeps local on ties and prunes a
  remotely-superseded entity from the dirty set; the split pull/push cursors
  and their persistence keys; the exported `getRow` vault surface and
  `decryptEntity`; push idempotency for re-sent upserts and soft-deletes.

### Added

- `createVaultClient().deleteRow(app, entityId, accountId, { deletedAt })` —
  optional fourth argument; the stamp is sent as a `deletedAt` query param.
  `VaultPulledRow` gains an optional `deletedAt` field.

## [1.5.3] - 2026-07-04

### Fixed

- **Generic WebDAV auto-backups now nest under the app folder instead of the
  server root.** The `webdav` backup provider built its upload directory as the
  bare WebDAV root (`<webdavUrl>/`), so backups landed at
  `<webdavUrl>/<prefix><ts>.json`. On NAS targets whose base URL is the server
  root (Synology/fnOS), a `PUT` to `/` is rejected with `405 Method Not Allowed`
  because writes are only permitted inside a shared folder, so auto-backups
  silently failed (lifeGLANCE issue #206). The provider now writes to
  `<webdavUrl>/<appFolderName>/backups/` — matching how the sync file path
  (`<webdavUrl>/<appFolderName>/<syncFilename>`) and the `nextcloud` backup
  provider (`<appFolder>/backups/`) are constructed — and issues an `MKCOL` for
  the app folder and the `backups/` subdir on a `404`/`409` before retrying the
  `PUT`, so the first backup to a fresh target succeeds. `listBackups`,
  `downloadBackup`, `deleteBackup`, and retention all target the same nested
  directory. The folder segment comes from `appFolderName` (the sync folder),
  not the dead `config.folder` field.

## [1.5.2] - 2026-06-19

### Fixed

- **Key verifier no longer fails with a cryptic `get row failed: 400`.** The
  verifier's single-row GET (`GET /sync/{app}/__glance_keycheck`) is scoped by
  `accountId`, which GLANCEvault requires as a query param on every row-scoped
  endpoint. When the verifier ran with an `accountId` that was empty or
  whitespace — e.g. fired during reconstruction before the account id was
  populated — the request went out as `?accountId=` (or `?accountId=+++`), which
  the server correctly rejects with `400 {"error":"accountId is required"}`,
  aborting enable. The default `createVaultClient` now validates `accountId` on
  every row-scoped call (`batch`, `list`, single-row GET, `DELETE`, `device`) and
  throws a clear, typed, retryable `ACCOUNT_ID_REQUIRED` instead of putting a
  malformed `accountId` on the wire — so the next cycle (once the id is loaded)
  succeeds. `createDbSyncEngine` also rejects an empty/whitespace `accountId` at
  construction (a whitespace-only id previously passed the plain falsy check).
  The verifier path surfaces `ACCOUNT_ID_REQUIRED` (and `PASSPHRASE_REQUIRED`)
  with their own code rather than mislabeling them `VERIFIER_UNSUPPORTED`. The
  verifier GET correctly carries `?accountId=...` (like the working `list` call)
  and, on a fresh account, 404 → writes the verifier via `batch` with
  `accountId` + `insertOnly: true`.

### Added

- `ACCOUNT_ID_REQUIRED` standardized on the `SyncErrorCode` type.

## [1.5.1] - 2026-06-19

### Fixed

- **Key verification fails clearly when the server can't host the verifier.**
  1.5.0's `verifyAccountKey` did `GET /sync/{app}/__glance_keycheck`; against a
  server that doesn't yet support the reserved id or the single-row GET, that
  threw a raw `get row failed: 400` and aborted the whole sync with a meaningless
  message. `verifyAccountKey` now distinguishes three outcomes: a
  present-but-undecryptable verifier still throws `KEY_MISMATCH`; an absent
  verifier (404) is still written; but any *other* error from the single-row GET
  or the verifier write (HTTP 400/405/500, or a 404 on the route itself) now
  throws a typed `VERIFIER_UNSUPPORTED` with an actionable "update your server"
  message. The engine never silently proceeds unverified (the verifier gates push
  and quarantine does not, so a wrong-key device with verification skipped would
  still push poison rows), so sync pauses with a clear reason. Surfaced via
  `config.onError(message, code)` like `KEY_MISMATCH`.

### Added

- `config.allowUnverified` (default `false`): an opt-in operator escape hatch
  that downgrades `VERIFIER_UNSUPPORTED` to a logged warning and proceeds, for
  operators who knowingly accept the risk of syncing against a server that can't
  host the verifier.
- `VERIFIER_UNSUPPORTED` standardized on the `SyncErrorCode` type.

## [1.5.0] - 2026-06-19

### Added

- **DB sync key verifier (fail fast; never upload under an unverified key).**
  Before pushing, the DB engine now proves the derived root key matches the
  account's existing data. It reserves an engine-owned entity
  (`__glance_keycheck`, never routed to `getLocalEntity` / `applyRemoteEntity`)
  holding a fixed known plaintext; decryptability under the derived key is the
  signal. `ensureRootKey` runs `verifyAccountKey()` once per session: an existing
  verifier that fails to decrypt throws a typed `KEY_MISMATCH` and gates the push
  (nothing is uploaded), so a wrong passphrase — or a per-account salt that
  drifted across server redeploys — can no longer poison an account. A new
  account writes the verifier insert-only (first-write-wins), matching the salt's
  concurrency model. Exposed via `engine.isKeyVerified()` and
  `config.onError(message, 'KEY_MISMATCH')`.
- **DB sync per-row decrypt quarantine (one bad row must not wedge the cycle).**
  `pullRemoteChanges` now wraps each row's decrypt + apply in try/catch: an
  individual undecryptable row is counted, recorded in a persisted quarantine set
  (localStorage, keyed by `storageKeyPrefix`), and the cursor is advanced past it
  — the cycle no longer throws and wedges all future sync. Reserved `__glance_*`
  rows are skipped from normal routing. Key verification (Part A) runs first, so
  a globally wrong key aborts once with `KEY_MISMATCH` instead of quarantining
  rows one by one. Each cycle re-attempts quarantined rows by id and drops them
  on a successful decrypt + apply, so a row self-heals once the correct key is in
  use. Surfaced via `config.onRowsSkipped(count, entityIds)`; `dbSyncCycle()` now
  resolves to `{ applied, skipped, skippedEntityIds }` and `engine.getQuarantine()`
  exposes the set.
- Error codes `KEY_MISMATCH` and `ROW_DECRYPT_FAILED` standardized on the
  `SyncErrorCode` type.

## [1.4.0] - 2026-06-18

### Fixed

- **DB sync push no longer skips unread remote rows.** The DB engine split the
  single high-water mark into two cursors: a pull cursor (`getHighWaterMark`,
  the highest seq actually listed and applied) that only the pull step
  advances, and a separate push-ack marker (`getPushAck`) for push
  idempotency. Previously `pushDirtyRows` advanced the shared high-water mark to
  the max seq the server assigned its pushed rows; because pushed rows get the
  highest seqs, the next pull resumed from `since` above any remote row whose
  seq sat below them and silently skipped it — unrecoverable for insert-only
  rows. A push consumes nothing and now never moves the pull cursor, so
  push-then-pull and pull-then-push are both safe. An existing stored cursor is
  read as pull-progress (the conservative interpretation), so upgrades are safe.

### Added

- `getPushAck()` / `setPushAck()` on the DB sync engine expose the push-ack
  high-water mark.

## [1.3.2] - 2026-06-14

### Fixed

- **`mergeRoutineDefinitions` chip collisions are now ownership-aware.** Routine
  chips can be claimed by a user (stamping `ownerSyncId`), and claiming is a
  one-way transition. Previously collisions were resolved purely by newer
  `lastModified`, so an unclaimed copy of a chip could beat a claimed copy when
  it carried an equal-or-newer timestamp — a claim made on one device would
  never reach a device still holding the unclaimed copy. Resolution now prefers
  the claimed side when exactly one side is claimed, regardless of
  `lastModified`; when both sides share the same ownership status (both claimed
  or both unclaimed), the newer `lastModified` still wins. Ordering and
  tombstone behavior are unchanged.

## [1.3.1] - 2026-06-14

### Fixed

- **`mergeRoutineDefinitions` now applies last-write-wins on chip id collisions.**
  Previously, when the same chip id existed on both sides, the local chip was
  kept verbatim and the remote one skipped — `lastModified` was only consulted
  for tombstone resurrection. As a result, any edit to an existing routine chip
  (rename, reorder, time change, or stamping `ownerSyncId`) failed to propagate
  across devices. Colliding chips are now resolved by the newer `lastModified`,
  matching the behavior of `mergeArrayById` / `mergeHabits`. Ordering and
  tombstone behavior are preserved.

## [1.3.0] - 2026-06-14

### Added

- **Multi-user roster sync in `mergeSyncData`.** A `users` array is now merged
  across devices using last-write-wins per user, keyed by `syncId` (falling back
  to `id`) and resolved by `updatedAt`. A roster signature (id, `updatedAt`,
  `deleted` flag, and `name`) drives the `localChanged` / `remoteChanged` dirty
  flags so roster edits propagate. The per-device `multiUserEnabled` toggle is
  intentionally not merged.

## [1.2.1] - 2026-06-14

### Fixed

- **DB sync transport: row field renamed `ciphertext` to `envelope`** to match the
  GLANCEvault batch and list endpoints. The encrypted rows exchanged with the
  vault are now `{ entityId, envelope, createdAt }`; the field rename is applied
  across the push row, the pull read, the vault client and engine types, the
  tests, and the docs. The base64 encoding is unchanged: the value is still
  `base64(IV || AES-GCM output)` produced by `encryptEntity`.

## [1.2.0] - 2026-06-13

### Added

- **Phase 3: database (GLANCEvault) sync transport**, selected via
  `transportMode: 'database'` in the engine config. The file-tier transport is
  completely unchanged; file-tier users run the identical code path as before.
  - `src/dbCrypto.js`: per-entity encryption. One PBKDF2 root key per account
    (salt from the GLANCEvault salt endpoint), per-entity AES-256-GCM keys
    HKDF-derived from it using the entityId as context, fresh IV per entity.
  - `src/vaultClient.js`: Bearer-authenticated HTTP client for the vault batch,
    list, get, delete, device, and salt endpoints, with an injectable fetch.
  - `src/dbEngine.js`: row-grained engine with per-entity dirty tracking
    (`markDirty`), seq-based incremental pull, entity-grain last-writer-wins,
    insert-only union, partial-write safety, and a best-effort device cursor.
  - New exports: `createDbSyncEngine`, `createVaultClient`, `setupDbRootKey`,
    `initDbRootKey`, `clearDbRootKey`, `hasDbRootKey`, `encryptEntity`,
    `decryptEntity`.
  - See `docs/PHASE3_DB_TRANSPORT.md` for design decisions, the coordinated
    GLANCEvault `POST /sync/:app/device` endpoint, and the Phase 4 cutover steps.

## [1.1.2] - 2026-06-04

### Fixed

- **412 retry — local DB mutated before upload**: `applyPayload` was called before
  `upload()` in `doCycle()`. If the upload returned a 412 Precondition Failed (concurrent
  write from another device), the retry cycle re-merged already-dirtied local state with
  the freshly downloaded remote, producing inconsistent data (e.g. completion events
  referencing chore sync IDs that no longer exist after the second merge). `applyPayload`
  is now deferred until after a successful upload (204), leaving the local DB untouched
  if the upload fails so the retry starts from a clean state.

## [1.1.1] - 2026-06-03

### Fixed

- **WebDAV — 405 on MKCOL treated as directory-already-exists**: `mkcolWithParents`
  now handles HTTP 405 (Method Not Allowed) the same as 409/404, triggering the
  parent-directory creation fallback. Some WebDAV servers (e.g. certain nginx
  configurations) return 405 rather than 409 when MKCOL is called on a path that
  already exists as a collection.

## [1.1.0] - 2026-05-25

### Added

- `deriveKeyForSalt(salt: Uint8Array): Promise<CryptoKey>` — derives a fresh
  non-extractable AES-256-GCM key from the cached passphrase and a caller-supplied
  salt (PBKDF2-SHA-256, 310 000 iterations). Intended as the `deriveKey` callback
  for `@glance-apps/intents` per-envelope key derivation (Phase 2.6): the intents
  emitter generates a random salt per envelope, embeds it in the envelope, and
  calls this to obtain the encryption key; the poller extracts the salt from the
  envelope and calls this again to obtain the decryption key — enabling cross-app
  decryption without sharing a per-app session key.

  Throws with `err.code === 'PASSPHRASE_REQUIRED'` when no passphrase is held in
  the current session. Note that this guard is on `_sessionPassphrase`, **not** on
  `hasEncryptionReady()`: after `initSessionKey()` restores a key from device
  storage the session key is ready but the passphrase is not. Callers that want to
  gate on passphrase availability should check `getSyncPassphrase() !== null`.

  `getSessionKey()` (added in 1.0.2) is **not removed**; it remains exported for
  any consumer that wants the cached per-app `CryptoKey` directly.

## [1.0.3] - 2026-05-23

### Fixed

- **Generic WebDAV — `appFolderName` not used in URLs**: `getFileUrl` and
  `getDirUrl` now insert `appFolderName` between the server root and the sync
  filename, matching the behaviour of the Nextcloud and Koofr providers.
  `webdavUrl` is now expected to be a server root (e.g. `https://dav.example.com`)
  rather than a full folder path. Callers with an existing `webdavUrl` that
  already includes the folder path should migrate it into `syncFolder`/`appFolderName`
  and strip the path back to the origin.
- **Generic WebDAV — Apache 403 on missing parent directories**: `upload` now
  calls `mkcolWithParents` when PUT returns 403 in addition to 404/409. Apache
  `mod_dav` returns 403 (not 409) when both the target directory and its parent
  are absent. The `if (res.status === 403) throw FORBIDDEN` guard that follows
  still catches genuine auth failures after the retry.

## [1.0.2] - 2026-05-22

### Added

- `getSessionKey()` export — returns the cached non-extractable `CryptoKey` for reuse by sibling packages (e.g., `@glance-apps/intents` encryption helpers).

## [1.0.1] - 2026-05-18

### Fixed

- **412 retry jitter**: add a random 1–3 s delay before the single re-try
  `doCycle` call that follows a `PRECONDITION_FAILED` response. Two clients
  polling on similar 60 s schedules previously collided on every cycle; the
  jitter breaks the lock-step pattern.
- **412 retry backoff**: when the one-shot retry itself fails, apply the same
  exponential backoff (`downloadErrorCount` / `downloadBackoffUntil`) used for
  all other transient errors, emit an `'error'` status, and call `onError`.
  Previously the engine silently returned, which caused it to hammer the server
  again on the very next 60 s poll.

## [1.0.0] - 2026-05-17

Initial stable release. Extracted from dayGLANCE and made app-agnostic so the
entire sync infrastructure can be shared across the GLANCE app family.

### Added

- `createSyncEngine(config)` — orchestrates the download → validate → merge →
  apply → upload cycle. Supports WebDAV, Nextcloud, and Koofr providers.
  Backoff on auth failures, 423 Locked, and network errors. Hard-stop on
  `APP_ID_MISMATCH` and `SCHEMA_FORWARD_INCOMPATIBLE`. Fires status events
  (`uploading`, `downloading`, `success`, `error`, `idle`) with auto-revert
  timers.
- `mergeArrayById`, `mergeDailyNotes`, `mergeHabits`, `mergeHabitLogs`,
  `mergeRoutineDefinitions`, `mergeSyncData`, `pruneTombstones` — ID-based
  merge engine with tombstone propagation and sync-horizon zombie suppression.
- `encryptData`, `decryptData`, `setupEncryptionKey`, `clearEncryptionKey`,
  `initSessionKey`, `setSyncPassphrase`, `getSyncPassphrase`,
  `hasEncryptionReady`, `isEncryptedEnvelope` — client-side AES-256-GCM
  encryption via Web Crypto API. Key derived with PBKDF2 and persisted in
  IndexedDB or via native Android Keystore bridge.
- `webdavFetch(config)` — transport-selecting WebDAV fetcher (Android HTTP
  bridge → Electron net.fetch → server-side CORS proxy).
- `createProviders(config)` — cloud sync provider objects for Nextcloud, Koofr,
  and generic WebDAV.
- `createAutoBackupDB(config)` and `createAutoBackupProviders(config)` —
  periodic snapshot backups to local IndexedDB and remote WebDAV folders.
- `AUTO_BACKUP_RETENTION` and `AUTO_BACKUP_INTERVALS` constants.
- TypeScript declarations in `types/index.d.ts`.
- WebDAV CORS proxy handler in `api/webdav-proxy.js`.

[Unreleased]: https://github.com/glance-apps/glance-sync/compare/v1.6.1...HEAD
[1.6.1]: https://github.com/glance-apps/glance-sync/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/glance-apps/glance-sync/compare/v1.5.3...v1.6.0
[1.5.3]: https://github.com/glance-apps/glance-sync/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/glance-apps/glance-sync/compare/v1.5.1...v1.5.2
[1.1.2]: https://github.com/glance-apps/glance-sync/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/glance-apps/glance-sync/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/glance-apps/glance-sync/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/glance-apps/glance-sync/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/glance-apps/glance-sync/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/glance-apps/glance-sync/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/glance-apps/glance-sync/releases/tag/v1.0.0
