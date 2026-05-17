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
