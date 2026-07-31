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
export { createDbSyncEngine, getOrCreateDeviceId } from './dbEngine.js';
export {
  createVaultClient,
  // Per-account auth substrate (vault Phase 1.4b): unauthenticated auth-mode
  // discovery and the bootstrap-secret -> per-device-credential exchange.
  fetchVaultHealth,
  enrollVaultDevice,
} from './vaultClient.js';
// The packaged connect flow: discover -> branch -> enroll if needed ->
// persist credential -> build engine. Apps hand it a secret or token and get
// a working engine back; the bootstrap secret never touches storage.
// recoverVaultSyncEngine (Phase 2.2) is the halt-gated, user-initiated exit
// from a rejected credential: re-enrollment that rotates the dead credential
// away server-side.
export { connectVaultSyncEngine, recoverVaultSyncEngine } from './vaultConnect.js';
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
