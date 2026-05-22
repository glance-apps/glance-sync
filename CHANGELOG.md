# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/glance-apps/glance-sync/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/glance-apps/glance-sync/releases/tag/v1.0.0
