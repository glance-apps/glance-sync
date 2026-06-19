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
export { webdavFetch, createProviders } from './providers.js';

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
export { createDbSyncEngine } from './dbEngine.js';
export { createVaultClient } from './vaultClient.js';
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
