# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
