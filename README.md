# @glance-apps/sync

Shared sync engine for the GLANCE app family (dayGLANCE, lifeGLANCE, lastGLANCE). WebDAV transport, AES-256-GCM encryption, conflict-free merge.

## Installation

```bash
npm install @glance-apps/sync
```

## Usage

### Initialize the sync engine

```js
import { createSyncEngine } from '@glance-apps/sync';

const engine = createSyncEngine({
  // Identity
  appId: 'com.example.myapp',
  appName: 'MyApp',
  storageKeyPrefix: 'myapp',
  syncFilename: 'myapp-sync.json',
  appFolderName: 'myapp',
  cryptoDBName: 'myapp-crypto',
  autoBackupDBName: 'myapp-auto-backups',
  backupFilenamePrefix: 'myapp-backup-',

  // Transport (browser web app — routes through server-side CORS proxy)
  nativeHttpRequest: null,
  electronProxyFetch: null,
  proxyUrl: 'https://your-app.example.com',

  // Data lifecycle
  buildPayload: () => ({ tasks: store.getTasks(), notes: store.getNotes() }),
  applyPayload: (data) => store.replaceAll(data),
  mergePayloads: (local, remote) => mergeSyncData(local, remote),

  // Status callbacks
  onStatusChange: (status) => ui.setSyncStatus(status),
  onError: (message, code, isHardStop) => ui.showError(message),
  onLastSyncedChange: (iso) => ui.setLastSynced(iso),
  onConflict: (remoteData, remoteModified, etag) => ui.showConflictDialog(remoteData),
  onPassphraseRequired: () => ui.promptPassphrase(),
});
```

### Perform a sync cycle

The engine distinguishes between upload (local → remote) and download (download → merge → apply → upload if changed). Call `engine.sync()` for the full cycle:

```js
// Wire to local data changes (typically with a debounce)
store.on('change', debounce(() => engine.upload(), 5000));

// Wire to a periodic poll or visibility event
setInterval(() => engine.sync(), 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') engine.sync();
});
```

### Handle first-sync conflicts

On the first sync, if the remote file already exists, the engine surfaces the conflict rather than auto-merging:

```js
const engine = createSyncEngine({
  // ...
  onConflict: async (remoteData, remoteModified, etag) => {
    const choice = await ui.askUser('Remote data exists. Keep local or remote?');
    if (choice === 'remote') {
      store.replaceAll(remoteData);
      engine.setConfig({ ...engine.getConfig(), lastSynced: remoteModified });
    }
    // Either way, proceed with an upload to stamp the chosen data
    engine.upload();
  },
});
```

### Set up encryption

```js
import { initSessionKey, setupEncryptionKey, setSyncPassphrase } from '@glance-apps/sync';

const cryptoConfig = { cryptoDBName: 'myapp-crypto' };

// On app start: try to restore key from device storage
const restored = await initSessionKey(cryptoConfig);
if (!restored) {
  // Prompt user for passphrase
  const passphrase = await ui.promptPassphrase();
  setSyncPassphrase(passphrase);
  await setupEncryptionKey(passphrase, cryptoConfig);
}
```

Pass `encryptionEnabled: true` in the sync config object stored via `engine.setConfig()` to enable encryption for uploads.

## Public API

### Sync engine

| Export | Description |
|--------|-------------|
| `createSyncEngine(config)` | Creates a sync engine instance bound to the given app/transport/data config. Returns a `SyncEngine` object. |
| `SCHEMA_VERSION` | Current envelope schema version written into every upload. |
| `SUPPORTED_MAX_SCHEMA_VERSION` | Highest schema version this build can read; downloads with a higher version trigger `SCHEMA_FORWARD_INCOMPATIBLE`. |

**`SyncEngine` methods:**

| Method | Description |
|--------|-------------|
| `sync()` / `download()` | Full cycle: download → validate → merge → apply → upload if changed. |
| `upload(opts?)` | Upload local state to the remote provider. |
| `runBackup(frequency)` | Save a snapshot to IDB and upload it to the remote backup folder (`<appFolderName>/backups/`, a sibling of the sync file inside the app folder). |
| `test(config)` | Test the connection to the configured provider. |
| `getConfig()` / `setConfig(cfg)` | Read/write the persisted sync config (credentials, provider, flags). |
| `getLastSynced()` | ISO 8601 timestamp of the last successful sync. |
| `isSyncing()` | Returns `true` while a sync cycle is in progress. |
| `isHardStopped()` / `clearHardStop()` | Query or clear the hard-stop flag (set on `APP_ID_MISMATCH` or `SCHEMA_FORWARD_INCOMPATIBLE`). |
| `hasEncryptionReady()` | Returns `true` if a session key is loaded and encryption is available. |
| `getUploadBackoffUntil()` / `getDownloadBackoffUntil()` | Epoch ms timestamp before which the next upload/download should not be attempted. |

### Merge functions

| Export | Description |
|--------|-------------|
| `mergeArrayById(local, remote, deletedIds, syncHorizon?, opts?)` | Generic array merge by item ID with tombstone support. |
| `mergeDailyNotes(local, remote)` | Merge date-keyed note maps; newer `lastModified` wins per key. |
| `mergeHabits(local, remote, localDeleted?, remoteDeleted?)` | Merge habit arrays with unified tombstones. |
| `mergeHabitLogs(local, remote, localTs?, remoteTs?)` | Merge date-keyed habit log maps; last-writer-wins per entry when timestamps are available. |
| `mergeRoutineDefinitions(local, remote, deletedChipIds?)` | Merge routine definitions (bucket → chip array) with tombstone support. |
| `mergeSyncData(local, remote, retentionDays?)` | Full data-level merge for the dayGLANCE payload shape. |
| `pruneTombstones(tombstones, cutoff)` | Remove tombstone entries older than the cutoff date. |

### Crypto

| Export | Description |
|--------|-------------|
| `initSessionKey(config)` | Restore session key from device storage (IDB or native bridge). Returns `true` if key was restored. |
| `setupEncryptionKey(passphrase, config)` | First-time setup: derive a key from the passphrase and persist it. |
| `clearEncryptionKey(config)` | Erase the cached key from device storage and session memory. |
| `encryptData(data, config?)` | Encrypt a plain JS object and return an `EncryptedEnvelope`. |
| `decryptData(envelope, config?)` | Decrypt an `EncryptedEnvelope` back to a plain JS object. |
| `isEncryptedEnvelope(value)` | Type guard — returns `true` if the value looks like an `EncryptedEnvelope`. |
| `setSyncPassphrase(p)` / `getSyncPassphrase()` | Store/retrieve the passphrase in session memory (not persisted). |
| `hasEncryptionReady()` | Returns `true` if the session key is loaded. |
| `getSessionKey()` | Returns the cached non-extractable `CryptoKey`, or `null` if no key is loaded. |
| `deriveKeyForSalt(salt)` | Derives a fresh non-extractable AES-256-GCM key from the cached passphrase and a caller-supplied 16-byte salt (PBKDF2-SHA-256, 310 000 iterations). Intended as the `deriveKey` callback for `@glance-apps/intents` per-envelope encryption: pass `sync.deriveKeyForSalt` to `buildEncryptedEnvelope` / `parseEncryptedEnvelope` so each envelope is independently rekeyed. Throws with `err.code === 'PASSPHRASE_REQUIRED'` when no passphrase is in session — gate on `getSyncPassphrase() !== null` before using it. |

### Transport & providers

| Export | Description |
|--------|-------------|
| `webdavFetch(config)` | Creates a transport-selecting WebDAV fetcher. Prefers Android HTTP bridge → Electron proxy → CORS proxy, in that order. |
| `createProviders(config)` | Creates cloud sync provider objects (`nextcloud`, `koofr`, `webdav`). |
| `normalizeEtag(raw)` | Normalizes a raw ETag header value for If-Match use: strips a weak-validator prefix (`W/"abc"` → `"abc"`) and the content-coding suffixes some servers append inside the quotes (`"abc-gzip"` / `"abc-br"` → `"abc"`). Quotes are preserved; `null`/`undefined` pass through unchanged. |

### GLANCEvault client

| Export | Description |
|--------|-------------|
| `createVaultClient(config)` | HTTP client for a GLANCEvault server. `config` is `{ vaultUrl, vaultToken, fetchImpl?, brake? }`. Every method carries the Bearer token, classifies errors uniformly (`CREDENTIAL_INVALID`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, else `VaultError` with `.status`), and passes through the module-scope brake and budget meter. |
| `fetchVaultHealth(config)` | Unauthenticated `GET /healthz`. Returns `{ status, version, schemaVersion, authMode }`, with `authMode` normalized to `'shared'` on servers that predate the field. |
| `enrollVaultDevice(config)` | Exchanges the admin-configured bootstrap secret for this device's own credential (`POST /enroll`). The credential is returned once and never again. |

**`VaultClient` methods:**

| Method | Description |
|--------|-------------|
| `batch(app, { accountId, rows })` | Upserts rows (`{ entityId, envelope, createdAt }`). Returns `{ written, maxSeq }`. |
| `list(app, { accountId, since })` | One page of rows with `seq > since`. Returns `{ rows, hasMore }`. |
| `getRow(app, entityId, accountId)` | Fetches one row; `null` on 404. |
| `deleteRow(app, entityId, accountId, opts?)` | Soft-deletes a row. `opts.deletedAt` (epoch ms) stamps the tombstone for delete-vs-edit LWW. |
| `device(app, { accountId, deviceId, lastSeenSeq })` | Updates this device's cursor. |
| `getSalt(accountId)` / `putSalt(accountId, salt)` | Reads/registers the account root-key salt as a `Uint8Array` (first-write-wins). |
| `intentsBatch(accountId, events)` | Appends intent events (`{ eventId, envelope, expiresAt }`) via `POST /intents/batch`. **Insert-only** — a re-sent `eventId` is a server no-op, so retrying an ambiguous failure is safe. Returns `{ written, maxSeq }`. |
| `intentsList(accountId, { since, limit })` | One ascending page of non-expired intent events with `seq > since` via `GET /intents/list`. Returns `{ rows, hasMore }`; the server pages at 500. |

The intents surface is **pure transport**: the `envelope` is opaque here and is
never decoded or inspected. The codec (and the per-envelope key derivation it
needs) stays in `@glance-apps/intents` — see `deriveKeyForSalt` above.

### Request diagnostics

One brake, one budget meter and one write-loop history per **bundle realm** —
not per client instance. They model a resource every client in the process
shares: the server's per-IP request budget. A separately bundled copy of this
package (an Obsidian plugin, say) is its own realm, which is correct — it is a
separate process with its own traffic.

| Export | Description |
|--------|-------------|
| `isVaultRateLimited()` | `true` while the brake is engaged. For callers that would rather sit a whole cycle out pre-flight than fire a call and catch the rejection. |
| `vaultBrakeStatus()` | `{ braked, until, memoryMs, retryInMs }`. |
| `getVaultStats()` | The brake status, the last rolling minute of requests attributed by method, and the entityIds whose write history looks loop-shaped. |
| `configureVaultDiagnostics(options?)` | Tunes the visibility-only thresholds (`softLimitPerMinute`, `loopTransitions`, `loopWindowMs`) and the log sink. The brake's curve is deliberately not configurable. |
| `resetVaultDiagnostics()` | Clears all three and restores the defaults. For tests. |

**The brake.** Any real 429 pauses *every* vault request in the realm: 30s,
doubling per burst to a 10-minute ceiling, with one arming per burst. While
paused, calls fail fast — before touching the network — with a `VaultError`
carrying `status: 429`, `code: 'RATE_LIMITED'` and `retryInMs`, so retry
ladders that already treat a real 429 as transient need no new code. A 2xx
releases the pause but only **halves** the escalation memory, so the next 429
re-arms at the storm's level; a genuine recovery drains to zero in a few quiet
successes. An over-quota 429 (`QUOTA_EXCEEDED`) is not a limiter hit and does
not arm it. `createVaultClient({ brake: false })` opts a client out of both the
gate and the arming — an escape hatch for tests.

**The budget meter and the write-loop detector** are visibility only; neither
ever throttles. The meter logs one attributable line per minute when a realm
crosses a soft threshold (default 300/min, half the server's default per-IP
budget). The detector keeps a bounded per-`entityId` write history across
`batch` upserts and `deleteRow` and warns once per id per window when one id
flips polarity (or is rewritten with identical content) four times inside ten
minutes. It fails open by construction: the rule needs repeated events on the
*same* id, so a first sync or a large import — many different ids — can never
trigger it.

### Auto-backup

| Export | Description |
|--------|-------------|
| `createAutoBackupDB(config)` | Creates an IndexedDB-backed local backup store. |
| `createAutoBackupProviders(config)` | Creates remote backup provider objects for Nextcloud and generic WebDAV. |
| `AUTO_BACKUP_RETENTION` | Default retention limits: `{ hourly: 24, daily: 30, weekly: 12 }`. |
| `AUTO_BACKUP_INTERVALS` | Interval seconds: `{ hourly: 3600, daily: 86400, weekly: 604800 }`. |

TypeScript declarations for all of the above are in `types/index.d.ts`.

## Versioning

This package follows [Semantic Versioning](https://semver.org/). Breaking changes to the public API or the sync envelope schema will result in a major version bump.

## License

MIT
