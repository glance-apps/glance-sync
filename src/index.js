export {
  mergeArrayById,
  mergeDailyNotes,
  mergeHabits,
  mergeHabitLogs,
  mergeRoutineDefinitions,
  mergeSyncData,
  pruneTombstones,
} from './merge.js';

export {
  encryptData,
  decryptData,
  setupEncryptionKey,
  setSyncPassphrase,
  getSyncPassphrase,
  clearEncryptionKey,
  hasEncryptionReady,
  getSessionKey,
  deriveKeyForSalt,
  isEncryptedEnvelope,
  initSessionKey,
} from './crypto.js';

// webdavFetch and createProviders are internal to the engine (Step 6) but
// exported here so shims can wire them before the engine exists.
export { webdavFetch, createProviders, normalizeEtag } from './providers.js';

export {
  createAutoBackupDB,
  createAutoBackupProviders,
  AUTO_BACKUP_RETENTION,
  AUTO_BACKUP_INTERVALS,
} from './autoBackup.js';

export {
  createSyncEngine,
  SCHEMA_VERSION,
  SUPPORTED_MAX_SCHEMA_VERSION,
} from './engine.js';

// Phase 3: database transport (selected via transportMode: 'database').
export {
  createDbSyncEngine,
  getOrCreateDeviceId,
  // Phase 4a: tells a caller's own retry ladder that the engine paused this
  // call, rather than that the request failed. Branching on it is what keeps
  // an app's breaker from stacking a second cooldown on the engine's window.
  isSuppressedError,
} from './dbEngine.js';
export {
  createVaultClient,
  // Per-account auth substrate (vault Phase 1.4b): unauthenticated auth-mode
  // discovery and the bootstrap-secret -> per-device-credential exchange.
  fetchVaultHealth,
  enrollVaultDevice,
  // Module-scope request diagnostics (1.11.0). The brake gates every client
  // call after a real 429; the budget meter and the write-loop detector are
  // visibility only. All three are per bundle realm, not per client.
  isVaultRateLimited,
  vaultBrakeStatus,
  getVaultStats,
  configureVaultDiagnostics,
  resetVaultDiagnostics,
} from './vaultClient.js';
// The packaged connect flow: discover -> branch -> enroll if needed ->
// persist credential -> build engine. Apps hand it a secret or token and get
// a working engine back; the bootstrap secret never touches storage.
// recoverVaultSyncEngine (Phase 2.2) is the halt-gated, user-initiated exit
// from a rejected credential: re-enrollment that rotates the dead credential
// away server-side.
export { connectVaultSyncEngine, recoverVaultSyncEngine } from './vaultConnect.js';
// 2.1.0: the snapshot-file cycle (iCloud, Direct Access) and the slice
// comparison it decides writes and applies with. Pure over an injected
// transport; see src/snapshotFileSync.js.
export {
  runSnapshotFileCycle,
  classifySnapshotText,
  evaluateMissingSnapshot,
  shouldPromptFirstRun,
  payloadHasData,
  relayDecision,
  relayWaitMs,
  noteWriter,
  readWriters,
  RELAY_CONFIRM_MS,
  RELAY_STAGGER_MS,
  MISSING_GRACE_MS,
} from './snapshotFileSync.js';
export {
  canonicalJson,
  describeSliceDiff,
  sliceDiffs,
  writeWorthy,
  explainSnapshotMerge,
  PER_MERGE_STAMPS,
} from './snapshotMergeExplain.js';
export {
  setupDbRootKey,
  initDbRootKey,
  clearDbRootKey,
  hasDbRootKey,
  encryptEntity,
  decryptEntity,
  isReservedEntityId,
  RESERVED_ENTITY_PREFIX,
  KEYCHECK_ENTITY_ID,
  KEYCHECK_PAYLOAD,
} from './dbCrypto.js';
