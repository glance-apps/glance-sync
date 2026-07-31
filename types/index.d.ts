// Type declarations for @glance-apps/sync
//
// Covers the full public API exported from src/index.js. The JSDoc on the
// source files is the source of truth for behavior; these declarations only
// express the shape of values crossing the package boundary.

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type SyncErrorCode =
  | 'APP_ID_MISMATCH'
  | 'SCHEMA_FORWARD_INCOMPATIBLE'
  | 'PASSPHRASE_REQUIRED'
  | 'PRECONDITION_FAILED'
  | 'FORBIDDEN'
  | 'AUTH_FAILURE'
  | 'LOCKED'
  | 'NETWORK_ERROR'
  // DB transport: derived root key does not match the account's existing data.
  | 'KEY_MISMATCH'
  // DB transport: a single row failed to decrypt (surfaced as a count via
  // onRowsSkipped, never thrown).
  | 'ROW_DECRYPT_FAILED'
  // DB transport: the server can't host the key verifier (doesn't support the
  // reserved __glance_keycheck id or the single-row endpoint).
  | 'VERIFIER_UNSUPPORTED'
  // DB transport: a row-scoped call (incl. the key verifier) was made before the
  // accountId was populated — retryable once the account id is available.
  | 'ACCOUNT_ID_REQUIRED';

export type SyncStatus = 'idle' | 'uploading' | 'downloading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

export interface SyncEnvelope<TData = unknown> {
  schemaVersion: number;
  appId: string;
  version: number;
  lastModified: string; // ISO 8601
  data: TData;
}

export interface EncryptedEnvelope {
  v: 1;
  enc: 'AES-GCM-256';
  data: string; // base64
}

// ---------------------------------------------------------------------------
// Transport bridges (all optional; engine selects the first non-null tier)
// ---------------------------------------------------------------------------

export interface NativeHttpResponse {
  status: number;
  ok: boolean;
  body: string;
  headers?: { etag?: string };
  error?: string;
}

export type NativeHttpRequest = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
) => NativeHttpResponse | null;

export type ElectronProxyFetch = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
) => Promise<{
  status: number;
  ok: boolean;
  statusText: string;
  body: string;
  headers?: { etag?: string };
}>;

// ---------------------------------------------------------------------------
// Merge engine
// ---------------------------------------------------------------------------

export interface MergeResult<T> {
  merged: T[];
  localChanged: boolean;
  remoteChanged: boolean;
}

export interface MergeArrayOptions {
  idField?: string;
  timestampField?: string;
}

export function mergeArrayById<T extends Record<string, unknown>>(
  localItems: T[],
  remoteItems: T[],
  deletedIds: Record<string, string>,
  syncHorizon?: Date | null,
  options?: MergeArrayOptions,
): MergeResult<T>;

export function mergeDailyNotes<T>(
  local: Record<string, T>,
  remote: Record<string, T>,
): { merged: Record<string, T>; localChanged: boolean; remoteChanged: boolean };

export function mergeHabits<T extends Record<string, unknown>>(
  localHabits: T[],
  remoteHabits: T[],
  localDeletedIds?: Record<string, string>,
  remoteDeletedIds?: Record<string, string>,
): {
  merged: T[];
  mergedDeletedIds: Record<string, string>;
  localChanged: boolean;
  remoteChanged: boolean;
};

export function mergeHabitLogs<T = number>(
  localLogs: Record<string, Record<string, T>>,
  remoteLogs: Record<string, Record<string, T>>,
  localTs?: Record<string, string>,
  remoteTs?: Record<string, string>,
): {
  merged: Record<string, Record<string, T>>;
  mergedTimestamps: Record<string, string>;
  localChanged: boolean;
  remoteChanged: boolean;
};

export function mergeRoutineDefinitions<T extends { id: string | number }>(
  localDefs: Record<string, T[]>,
  remoteDefs: Record<string, T[]>,
  deletedChipIds?: Record<string, string>,
): { merged: Record<string, T[]>; localChanged: boolean; remoteChanged: boolean };

export function mergeSyncData<TLocal extends Record<string, unknown>, TRemote extends Record<string, unknown>>(
  localData: TLocal,
  remoteData: TRemote,
  retentionDays?: number,
): { data: Record<string, unknown>; localChanged: boolean; remoteChanged: boolean };

export function pruneTombstones(
  tombstones: Record<string, string>,
  cutoff: Date | null,
): Record<string, string>;

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export interface CryptoConfig {
  cryptoDBName: string;
  nativeGetSyncKey?: (() => string | null | Promise<string | null>) | null;
  nativeStoreSyncKey?: ((value: string | null) => void) | null;
}

export function initSessionKey(config: CryptoConfig): Promise<boolean>;
export function setupEncryptionKey(passphrase: string, config: CryptoConfig): Promise<void>;
export function clearEncryptionKey(config: CryptoConfig): Promise<void>;
export function setSyncPassphrase(passphrase: string | null): void;
export function getSyncPassphrase(): string | null;
export function hasEncryptionReady(): boolean;
export function getSessionKey(): CryptoKey | null;
/**
 * Derives a fresh non-extractable AES-256-GCM key from the cached passphrase
 * and the supplied salt (PBKDF2-SHA-256, 310 000 iterations). Intended for
 * per-envelope key derivation in `@glance-apps/intents`: pass this function as
 * the `deriveKey` callback to `buildEncryptedEnvelope` / `parseEncryptedEnvelope`.
 *
 * Throws with `err.code === 'PASSPHRASE_REQUIRED'` when no passphrase is held
 * in the current session. Gate on `getSyncPassphrase() !== null` (not
 * `hasEncryptionReady()`) before passing this as a callback.
 */
export function deriveKeyForSalt(salt: Uint8Array): Promise<CryptoKey>;
export function encryptData<T>(data: T, config?: CryptoConfig): Promise<EncryptedEnvelope>;
export function decryptData<T = unknown>(envelope: EncryptedEnvelope, config?: CryptoConfig): Promise<T>;
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope;

// ---------------------------------------------------------------------------
// Auto-backup
// ---------------------------------------------------------------------------

export type BackupFrequency = 'hourly' | 'daily' | 'weekly';

export interface BackupRecord<TData = unknown> {
  id: string;
  timestamp: string;
  frequency: BackupFrequency;
  data: TData;
}

export interface AutoBackupDB {
  open(): Promise<IDBDatabase>;
  saveBackup<TData>(frequency: BackupFrequency, data: TData): Promise<BackupRecord<TData>>;
  listBackups<TData>(frequency?: BackupFrequency): Promise<BackupRecord<TData>[]>;
  getBackup<TData>(id: string): Promise<BackupRecord<TData> | undefined>;
  deleteBackup(id: string): Promise<void>;
  pruneBackups(frequency: BackupFrequency, maxCount: number): Promise<number | undefined>;
}

export interface AutoBackupProvider {
  name: string;
  uploadBackup(providerConfig: Record<string, unknown>, data: unknown): Promise<string>;
  listBackups(providerConfig: Record<string, unknown>): Promise<Array<{ filename: string; lastModified: string | null }>>;
  downloadBackup(providerConfig: Record<string, unknown>, filename: string): Promise<unknown>;
  deleteBackup(providerConfig: Record<string, unknown>, filename: string): Promise<void>;
  testConnection(providerConfig: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
}

export interface AutoBackupRetention {
  hourly: number;
  daily: number;
  weekly: number;
}

export interface AutoBackupIntervals {
  hourly: number;
  daily: number;
  weekly: number;
}

export const AUTO_BACKUP_RETENTION: AutoBackupRetention;
export const AUTO_BACKUP_INTERVALS: AutoBackupIntervals;

export function createAutoBackupDB(config: { autoBackupDBName: string }): AutoBackupDB;
export function createAutoBackupProviders(config: {
  backupFilenamePrefix: string;
  appFolderName: string;
  webdavFetch: WebdavFetch;
}): Record<string, AutoBackupProvider>;

// ---------------------------------------------------------------------------
// Providers / transport
// ---------------------------------------------------------------------------

export type WebdavFetch = (
  method: string,
  url: string,
  authHeaders: Record<string, string>,
  body?: string | null,
  extraHeaders?: Record<string, string>,
) => Promise<{
  status: number;
  ok: boolean;
  statusText?: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface CloudSyncProvider {
  name: string;
  configFields: Array<{ key: string; label: string; type: string; placeholder?: string }>;
  helpText?: string;
  upload(config: Record<string, unknown>, envelope: SyncEnvelope, etag?: string | null): Promise<boolean>;
  download(config: Record<string, unknown>): Promise<{ payload: unknown; etag: string | null } | null>;
  test(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
}

export function webdavFetch(config: SyncEngineConfig): WebdavFetch;
export function createProviders(config: SyncEngineConfig): Record<string, CloudSyncProvider>;

/**
 * Normalizes a raw ETag header value for use in If-Match: strips a weak-
 * validator prefix (`W/"abc"` -> `"abc"`) and the content-coding suffixes
 * Apache mod_deflate/mod_brotli append inside the quotes (`"abc-gzip"` /
 * `"abc-br"` -> `"abc"`). Quotes are preserved; null/undefined pass through.
 */
export function normalizeEtag(raw: string | null | undefined): string | null | undefined;

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface SyncEngineConfig {
  // Transport selection (Phase 3). Defaults to 'file' when unset.
  transportMode?: 'file' | 'database';

  // Identity
  storageKeyPrefix: string;
  cryptoDBName: string;
  autoBackupDBName: string;
  syncFilename: string;
  appFolderName: string;
  backupFilenamePrefix: string;
  appId: string;
  appName: string;

  // Transport bridges (optional, listed in priority order)
  nativeHttpRequest?: NativeHttpRequest | null;
  electronProxyFetch?: ElectronProxyFetch | null;
  proxyUrl?: string;

  // Crypto bridges (forwarded to crypto.js)
  nativeGetSyncKey?: (() => string | null | Promise<string | null>) | null;
  nativeStoreSyncKey?: ((value: string | null) => void) | null;

  // Data lifecycle callbacks
  buildPayload: () => unknown | Promise<unknown>;
  buildBackupPayload?: () => unknown | Promise<unknown>;
  applyPayload: (data: unknown, opts: { allowEmpty: boolean }) => void | Promise<void>;
  mergePayloads: (local: unknown, remote: unknown) => {
    data: unknown;
    localChanged: boolean;
    remoteChanged: boolean;
  };
  validateUploadPayload?: (payload: SyncEnvelope) => ValidationResult | Promise<ValidationResult>;
  validateApplyPayload?: (payload: SyncEnvelope) => ValidationResult | Promise<ValidationResult>;

  // Event callbacks
  onStatusChange?: (status: SyncStatus, hints?: { from?: SyncStatus }) => void;
  onError?: (message: string | null, code: SyncErrorCode | null, isHardStop: boolean) => void;
  onLastSyncedChange?: (isoString: string) => void;
  onConflict?: (remoteData: unknown, remoteModified: string, etag: string | null) => void;
  onPassphraseRequired?: () => void;
  onFirstSyncReload?: () => void;

  // Retention
  retentionDays?: number;
}

export interface SyncEngine {
  sync(): Promise<void>;
  upload(opts?: {
    prebuiltPayload?: unknown;
    etag?: string | null;
    skipLockCheck?: boolean;
  }): Promise<void>;
  download(): Promise<void>;
  runBackup(frequency: BackupFrequency): Promise<void>;
  test(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;

  getConfig(): Record<string, unknown> | null;
  setConfig(config: Record<string, unknown> | null): void;
  getLastSynced(): string | null;

  isSyncing(): boolean;
  isHardStopped(): boolean;
  clearHardStop(): void;
  hasEncryptionReady(): boolean;
  getUploadBackoffUntil(): number;
  getDownloadBackoffUntil(): number;

  providers: Record<string, CloudSyncProvider>;
  autoBackupDB: AutoBackupDB;
  autoBackupProviders: Record<string, AutoBackupProvider>;
  webdavFetch: WebdavFetch;
}

// createSyncEngine returns the file-tier engine by default, or the DB engine
// when config.transportMode is 'database'.
export function createSyncEngine(config: SyncEngineConfig): SyncEngine;
export function createSyncEngine(config: DbSyncEngineConfig & { transportMode: 'database' }): DbSyncEngine;

export const SCHEMA_VERSION: number;
export const SUPPORTED_MAX_SCHEMA_VERSION: number;

// ---------------------------------------------------------------------------
// Database transport (Phase 3)
// ---------------------------------------------------------------------------

// Per-entity crypto. The root key is PBKDF2-derived from the passphrase and a
// per-account salt; per-entity AES-GCM keys are HKDF-derived from it.
export interface DbCryptoConfig {
  cryptoDBName: string;
  nativeGetSyncKey?: (() => string | null | Promise<string | null>) | null;
  nativeStoreSyncKey?: ((value: string | null) => void) | null;
}

export function setupDbRootKey(passphrase: string, salt: Uint8Array, config: DbCryptoConfig): Promise<void>;
export function initDbRootKey(config: DbCryptoConfig): Promise<boolean>;
export function clearDbRootKey(config: DbCryptoConfig): Promise<void>;
export function hasDbRootKey(): boolean;
export function encryptEntity(entity: unknown, entityId: string, rootKey?: CryptoKey): Promise<string>;
export function decryptEntity<T = unknown>(ciphertext: string, entityId: string, rootKey?: CryptoKey): Promise<T>;

// Engine-reserved entities. Rows whose entityId starts with RESERVED_ENTITY_PREFIX
// are owned by the sync engine (e.g. the key verifier) and are never routed to
// getLocalEntity / applyRemoteEntity.
export const RESERVED_ENTITY_PREFIX: string;
export const KEYCHECK_ENTITY_ID: string;
export const KEYCHECK_PAYLOAD: { v: number; magic: string };
export function isReservedEntityId(entityId: string): boolean;

// Row exchanged with GLANCEvault. envelope is base64(IV || AES-GCM output).
export interface VaultRow {
  entityId: string;
  envelope: string;
  createdAt: number;
}

export interface VaultPulledRow extends Partial<VaultRow> {
  entityId: string;
  seq: number;
  deleted?: boolean;
  /** Tombstone LWW stamp (epoch ms or date string). Absent on rows from servers that predate it: the engine then treats the delete as unconditionally winning. */
  deletedAt?: number | string;
  envelope?: string;
}

export interface VaultClient {
  batch(app: string, args: { accountId: string; rows: VaultRow[] }): Promise<{ written: number; maxSeq: number }>;
  list(app: string, args: { accountId: string; since: number }): Promise<{ rows: VaultPulledRow[]; hasMore: boolean }>;
  getRow(app: string, entityId: string, accountId: string): Promise<VaultPulledRow | null>;
  deleteRow(app: string, entityId: string, accountId: string, opts?: { deletedAt?: number }): Promise<{ seq?: number } | null>;
  device(app: string, args: { accountId: string; deviceId: string; lastSeenSeq: number }): Promise<{ updated: boolean }>;
  getSalt(accountId: string): Promise<Uint8Array | null>;
  putSalt(accountId: string, salt: Uint8Array): Promise<Uint8Array>;
}

export function createVaultClient(config: {
  vaultUrl: string;
  /** Shared device token, or the device's enrolled credential in per-account mode. */
  vaultToken: string;
  fetchImpl?: typeof fetch;
}): VaultClient;

// Per-account auth (vault Phase 1.4b).

/** Which trust model a GLANCEvault server runs. Discoverable via fetchVaultHealth. */
export type VaultAuthMode = 'shared' | 'per-account';

export interface VaultHealth {
  status: string;
  version: string;
  schemaVersion: number;
  /** Normalized to 'shared' when the server predates the field. */
  authMode: VaultAuthMode;
}

/** Unauthenticated GET /healthz. Safe to call before any token exists. */
export function fetchVaultHealth(config: {
  vaultUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<VaultHealth>;

export interface VaultEnrollment {
  credentialId: string;
  /** Returned once, never retrievable again. Persist it, then discard the bootstrap secret. */
  credential: string;
  accountId: string;
  deviceId: string;
  createdAt: string;
}

/**
 * POST /enroll — exchanges the bootstrap secret for this device's own credential.
 * Rejects with err.code 'ENROLLMENT_REJECTED' (401, secret not accepted),
 * 'ENROLLMENT_UNSUPPORTED' (404, server runs shared mode or predates enrollment),
 * or 'VAULT_ERROR' with err.status for other failures.
 */
export function enrollVaultDevice(config: {
  vaultUrl: string;
  enrollmentSecret: string;
  accountId: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
}): Promise<VaultEnrollment>;

export interface DbSyncEngineConfig {
  // Identity / local state
  storageKeyPrefix: string;
  appId: string;
  vaultApp?: string;
  cryptoDBName: string;
  nativeGetSyncKey?: (() => string | null | Promise<string | null>) | null;
  nativeStoreSyncKey?: ((value: string | null) => void) | null;

  // Transport selection
  transportMode?: 'database';

  // Vault connection
  vaultUrl?: string;
  vaultToken?: string;
  accountId: string;
  deviceId?: string;
  fetchImpl?: typeof fetch;
  vaultClient?: VaultClient;

  // Data callbacks
  getLocalEntity: (entityId: string) => unknown | Promise<unknown>;
  applyRemoteEntity: (entityId: string, entity: unknown) => void | Promise<void>;
  applyRemoteDelete: (entityId: string) => void | Promise<void>;
  isInsertOnly?: (entity: unknown, entityId: string) => boolean;
  getEntityLastModified?: (entity: unknown) => string | number | undefined;

  // Event callbacks
  onStatusChange?: (status: SyncStatus, hints?: { from?: SyncStatus }) => void;
  // Called with code === 'KEY_MISMATCH' when the derived key doesn't match the
  // account, or 'VERIFIER_UNSUPPORTED' when the server can't host the verifier.
  onError?: (message: string | null, code: SyncErrorCode | null, isHardStop: boolean) => void;
  // Called once per cycle that skipped > 0 undecryptable rows (per-row quarantine).
  onRowsSkipped?: (count: number, entityIds: string[]) => void;

  // Operator escape hatch: downgrade VERIFIER_UNSUPPORTED to a logged warning
  // and proceed without verification (unsafe — a wrong-key device could push
  // poison rows). Off by default so the safe behavior is the default.
  allowUnverified?: boolean;
}

/** Result of a DB sync cycle / pull: how many rows applied vs. quarantined. */
export interface DbSyncResult {
  applied: number;
  skipped: number;
  skippedEntityIds: string[];
}

/** A row quarantined after failing to decrypt under the (verified) account key. */
export interface QuarantinedRow {
  entityId: string;
  seq: number;
}

export interface DbSyncEngine {
  transportMode: 'database';
  sync(): Promise<DbSyncResult>;
  dbSyncCycle(): Promise<DbSyncResult>;
  pushDirtyRows(): Promise<{ written: number; deleted: number; maxSeq: number }>;
  pullRemoteChanges(): Promise<DbSyncResult & { maxSeq: number; appliedRemote: boolean }>;
  updateDeviceCursor(): Promise<{ updated: boolean }>;
  ensureRootKey(): Promise<void>;

  markDirty(entityId: string): void;
  getDirtySet(): string[];
  clearDirty(): void;
  /** Rows quarantined after a per-row decrypt failure, awaiting self-heal. */
  getQuarantine(): QuarantinedRow[];

  /** Pull cursor: highest seq actually listed + applied. Only pull advances it. */
  getHighWaterMark(): number;
  setHighWaterMark(seq: number): void;
  /** Push-ack marker: highest seq the server assigned to pushed rows. Never feeds the pull cursor. */
  getPushAck(): number;
  setPushAck(seq: number): void;

  getConfig(): Record<string, unknown> | null;
  setConfig(config: Record<string, unknown> | null): void;
  getLastSynced(): string | null;

  isSyncing(): boolean;
  /** True once the derived root key has been proven against the account (Part A). */
  isKeyVerified(): boolean;
  hasEncryptionReady(): boolean;

  vault: VaultClient;
}

export function createDbSyncEngine(config: DbSyncEngineConfig): DbSyncEngine;
