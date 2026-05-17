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
| `runBackup(frequency)` | Save a snapshot to IDB and upload it to the remote backup folder. |
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

### Transport & providers

| Export | Description |
|--------|-------------|
| `webdavFetch(config)` | Creates a transport-selecting WebDAV fetcher. Prefers Android HTTP bridge → Electron proxy → CORS proxy, in that order. |
| `createProviders(config)` | Creates cloud sync provider objects (`nextcloud`, `koofr`, `webdav`). |

### Auto-backup

| Export | Description |
|--------|-------------|
| `createAutoBackupDB(config)` | Creates an IndexedDB-backed local backup store. |
| `createAutoBackupProviders(config)` | Creates remote backup provider objects for Nextcloud and generic WebDAV. |
| `AUTO_BACKUP_RETENTION` | Default retention limits: `{ hourly: 24, daily: 30, weekly: 12 }`. |
| `AUTO_BACKUP_INTERVALS` | Interval seconds: `{ hourly: 3600, daily: 86400, weekly: 604800 }`. |

TypeScript declarations for all of the above are in `types/index.d.ts`.

## Versioning

This package is at **v1.0.0** and follows [Semantic Versioning](https://semver.org/). Breaking changes to the public API or the sync envelope schema will result in a major version bump.

## License

MIT
