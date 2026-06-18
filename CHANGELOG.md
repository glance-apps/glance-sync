# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/glance-apps/glance-sync/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/glance-apps/glance-sync/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/glance-apps/glance-sync/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/glance-apps/glance-sync/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/glance-apps/glance-sync/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/glance-apps/glance-sync/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/glance-apps/glance-sync/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/glance-apps/glance-sync/releases/tag/v1.0.0
