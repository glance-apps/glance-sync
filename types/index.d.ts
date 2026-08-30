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
  | 'ACCOUNT_ID_REQUIRED'
  // DB transport, per-account auth: the server rejected this device's
  // credential (401 "invalid credential"). Surfaced with isHardStop === true;
  // the engine persists a halt and stops retrying. Recovery (re-enrollment)
  // is Phase 2.2 — nothing in this version clears the halt.
  | 'CREDENTIAL_INVALID'
  // DB transport: the server rejected a write because the account is over a
  // configured quota (413 storage-shaped / 429 volume-shaped, Phase 3.2).
  // ALWAYS isHardStop === false — a quota condition clears when the operator
  // raises the limit or reclaim runs, with NO client action, so the engine
  // never halts on it. The parsed descriptor rides on the engine's
  // getQuotaState(); the engine suppresses further writes for a bounded,
  // self-resuming window while the pull keeps running.
  | 'QUOTA_EXCEEDED'
  // DB transport (1.11.0): the module-scope brake is engaged after a real 429,
  // so this call failed FAST without touching the network. Carries
  // `status: 429` and `retryInMs`, so any ladder that already treats a real
  // 429 as transient handles it unchanged. Never a hard stop: the window is
  // self-expiring and a success both releases it and halves the escalation.
  | 'RATE_LIMITED';

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

/**
 * One intent event on the wire. `envelope` is OPAQUE to this package — it is
 * never decoded or inspected; the codec lives in `@glance-apps/intents`.
 */
export interface VaultIntentEvent {
  eventId: string;
  /** Opaque base64 payload. */
  envelope: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface VaultIntentRow extends VaultIntentEvent {
  seq: number;
  serverMtime: string;
}

export interface VaultClient {
  batch(app: string, args: { accountId: string; rows: VaultRow[] }): Promise<{ written: number; maxSeq: number }>;
  list(app: string, args: { accountId: string; since: number }): Promise<{ rows: VaultPulledRow[]; hasMore: boolean }>;
  getRow(app: string, entityId: string, accountId: string): Promise<VaultPulledRow | null>;
  deleteRow(app: string, entityId: string, accountId: string, opts?: { deletedAt?: number }): Promise<{ seq?: number } | null>;
  device(app: string, args: { accountId: string; deviceId: string; lastSeenSeq: number }): Promise<{ updated: boolean }>;
  getSalt(accountId: string): Promise<Uint8Array | null>;
  putSalt(accountId: string, salt: Uint8Array): Promise<Uint8Array>;
  /** Appends intent events. Insert-only: a re-sent eventId is a server no-op. */
  intentsBatch(accountId: string, events: VaultIntentEvent[]): Promise<{ written: number; maxSeq: number }>;
  /** Fetches non-expired intent events with seq > since, ascending. One page per call. */
  intentsList(accountId: string, opts?: { since?: number; limit?: number }): Promise<{ rows: VaultIntentRow[]; hasMore: boolean }>;
}

export function createVaultClient(config: {
  vaultUrl: string;
  /** Shared device token, or the device's enrolled credential in per-account mode. */
  vaultToken: string;
  fetchImpl?: typeof fetch;
  /**
   * Set false to opt this client out of the module-scope brake — it then
   * neither gates on nor arms it. An escape hatch for tests that need the
   * wire on every call; production callers should leave it on.
   * @default true
   */
  brake?: boolean;
}): VaultClient;

// ---------------------------------------------------------------------------
// Module-scope request diagnostics (1.11.0)
// ---------------------------------------------------------------------------
//
// One brake, one budget meter and one write-loop history per BUNDLE REALM,
// not per client instance: they model a resource every client in the process
// shares — the server's per-IP request budget. A separately bundled copy
// (e.g. an Obsidian plugin) is its own realm, which is correct: separate
// process, separate traffic.

export interface VaultBrakeStatus {
  /** Is the brake engaged right now? While engaged, every client call fails fast with RATE_LIMITED. */
  braked: boolean;
  /** Epoch ms the current window expires, or null when not braked. */
  until: number | null;
  /** Escalation memory. Doubles per 429 burst to a 10-minute ceiling; a success halves it. */
  memoryMs: number;
  /** Milliseconds left in the window, 0 when not braked. */
  retryInMs: number;
}

export interface VaultWriteLoopSuspect {
  entityId: string;
  /** Polarity flips or identical-content rewrites counted inside the window. */
  transitions: number;
  /** Whether the loud one-per-window warning has fired for this id. */
  warned: boolean;
  history: Array<{ polarity: 'upsert' | 'delete'; at: number; contentHash: string | null }>;
}

export interface VaultStats {
  brake: VaultBrakeStatus;
  requests: {
    /** Requests that reached the wire in the last rolling minute. */
    lastMinute: number;
    softLimitPerMinute: number;
    /** Attribution by client method name, e.g. { intentsList: 210, batch: 130 }. */
    byMethod: Record<string, number>;
    /** Samples dropped by the buffer's hard cap (only ever under-counts a storm). */
    droppedSamples: number;
  };
  writeLoopSuspects: VaultWriteLoopSuspect[];
}

/** Is the shared brake engaged? For callers that prefer to sit a cycle out pre-flight. */
export function isVaultRateLimited(): boolean;

/** The brake's full state. */
export function vaultBrakeStatus(): VaultBrakeStatus;

/** Brake status, per-minute request counts by method, and write-loop suspects in one read. */
export function getVaultStats(): VaultStats;

/**
 * Tunes the visibility-only thresholds. The brake's curve is deliberately not
 * configurable — it protects someone else's server.
 */
export function configureVaultDiagnostics(options?: {
  /** Budget-meter warn threshold. @default 300 */
  softLimitPerMinute?: number;
  /** Write-loop K: qualifying transitions before warning. @default 4 */
  loopTransitions?: number;
  /** Write-loop M. @default 600000 (10 minutes) */
  loopWindowMs?: number;
  /** Console-shaped sink for the diagnostic lines. Defaults to `console`. */
  logger?: { warn?: (m: string) => void; info?: (m: string) => void; log?: (m: string) => void } | null;
}): { softLimitPerMinute: number; loopTransitions: number; loopWindowMs: number; logger: unknown };

/** Clears the brake, the meter and the write history, and restores the defaults. For tests. */
export function resetVaultDiagnostics(): void;

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
  /** True when the push threw but the pull still ran (Phase 3.3 partial function). */
  pushFailed?: boolean;
  /** True when the push was skipped because its backoff window is open. */
  pushSkipped?: boolean;
  /** The push error's code when pushFailed/pushSkipped — the pull's own result is still reported above. */
  pushErrorCode?: SyncErrorCode | string;
  /** True when the pull threw but the cursor report still ran. */
  pullFailed?: boolean;
  /** True when the pull was skipped because its backoff window is open. */
  pullSkipped?: boolean;
  /** The pull error's code when pullFailed/pullSkipped. */
  pullErrorCode?: SyncErrorCode | string;
  /** The standing over-quota descriptor, when one applies. */
  quota?: QuotaState | null;
  /** True when the cycle no-opped because the credential halt is set. */
  halted?: boolean;
  /** True when the cycle no-opped because this instance's credential was superseded. */
  superseded?: boolean;
}

/**
 * Over-quota state (Phase 3.3). IN MEMORY ONLY — this describes server-side
 * state that changes without the client (an operator raises a limit, reclaim
 * runs, intents expire), so it is never persisted and there is nothing to
 * clear: it lifts by itself when a write succeeds again.
 *
 * `quota` is the server's dimension string, passed through verbatim — the
 * known values are 'storage' | 'rows' | 'intents' | 'concurrent-uploads', but
 * a newer server may add dimensions, so treat an unrecognised one generically
 * rather than assuming it cannot happen. The numbers are bytes for 'storage'
 * and counts otherwise, and render "X of Y used" directly; they are null only
 * in the defensive case where a rejection was typed without a full body.
 */
/**
 * One backoff window. The DB engine keeps two (push and pull) and enforces
 * them itself; both are IN MEMORY ONLY, like the file tier's, so a restart
 * clears them — a relaunch is a user saying "try now", and a persisting
 * failure re-opens the window immediately.
 *
 * A window only ever DELAYS: the next cycle after `until` probes again, with
 * no user action and no restart. Failures that must not be delayed at all
 * (PASSPHRASE_REQUIRED / ACCOUNT_ID_REQUIRED, which clear the moment the app
 * supplies the value) and failures owned by another state (CREDENTIAL_INVALID,
 * which halts) never open one.
 */
export interface BackoffWindow {
  /** Epoch ms; the direction is skipped while this is in the future. 0 when clear. */
  until: number;
  /** Consecutive failures driving the escalation (30s doubling; 15 min push cap, 5 min pull cap). */
  strikes: number;
  /** 'quota' (keeps surfacing its descriptor), 'auth' (flat hour on a 401), 'transport' (quiet after one signal). */
  reason: 'quota' | 'auth' | 'transport' | null;
  /** The typed error code that opened the window. */
  code: SyncErrorCode | string | null;
  /** ISO timestamp of the most recent failure. */
  since: string | null;
}

export interface QuotaState {
  quota: string;
  limit: number | null;
  used: number | null;
  requested: number | null;
  message: string;
  /** ISO timestamp of the most recent rejection. */
  since: string;
  /** ISO timestamp after which the engine probes again, on its own. */
  retryAt: string;
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

  /** True while the persisted credential-rejected stop is set (CREDENTIAL_INVALID). */
  isCredentialHalted(): boolean;
  /** The persisted stop record, or null. Cleared only by recoverVaultSyncEngine after a verified successful re-enrollment. */
  getCredentialHalt(): { message: string; at: string } | null;
  /** True once this instance proved its bearer was superseded by recovery and went inert (in-memory only). */
  isSuperseded(): boolean;
  /** The standing over-quota descriptor, or null. In-memory only; never a hard stop; nothing to clear. */
  getQuotaState(): QuotaState | null;
  /** True while the bounded over-quota window is open (writes skipped, pulls continue). */
  isQuotaSuppressed(): boolean;

  /**
   * Epoch ms before which the push/pull will not be attempted, or 0. Same
   * getter names and meaning as the file engine's, so one scheduler can treat
   * both tiers identically — but unlike the file tier, the DB engine also
   * ENFORCES these itself, so honouring them is an optimisation, not a duty.
   */
  getUploadBackoffUntil(): number;
  getDownloadBackoffUntil(): number;
  /**
   * The full backoff picture. `reason` distinguishes a one-hour auth window
   * from a thirty-second transport one without inferring from the timestamp's
   * magnitude, which is what an app needs to tell a user why and for how long.
   */
  getBackoffState(): { push: BackoffWindow; pull: BackoffWindow };
  /** The resolved stable device identity this engine runs as. */
  deviceId: string;

  vault: VaultClient;
}

export function createDbSyncEngine(config: DbSyncEngineConfig): DbSyncEngine;

/**
 * Package-owned stable device identifier: generated once (crypto.randomUUID)
 * and persisted under `{prefix}-device-id`. Used for both the device cursor
 * and per-account enrollment. An explicit config.deviceId overrides it.
 */
export function getOrCreateDeviceId(storageKeyPrefix: string): string;

/**
 * The packaged vault connect flow: discovers the server's auth mode, resolves
 * the Bearer value (enrolling with the bootstrap secret when the server is
 * per-account and no credential is stored yet), persists the credential under
 * `{prefix}-vault-credential`, and returns a ready engine. The bootstrap
 * secret is never written to storage, never logged, and never retained past
 * the call. No path re-enrolls automatically once a credential is stored.
 *
 * Typed failures: VAULT_TOKEN_REQUIRED, ENROLLMENT_SECRET_REQUIRED,
 * CREDENTIAL_PERSIST_FAILED, VAULT_UNREACHABLE, plus enrollVaultDevice's
 * ENROLLMENT_REJECTED / ENROLLMENT_UNSUPPORTED.
 */
export function connectVaultSyncEngine(
  config: Omit<DbSyncEngineConfig, 'vaultToken'> & {
    vaultToken?: string;
    enrollmentSecret?: string;
  }
): Promise<{
  engine: DbSyncEngine;
  /** null when discovery failed and the flow fell back to the last known auth state. */
  authMode: VaultAuthMode | null;
  /** True only when this call minted a credential. */
  enrolled: boolean;
  deviceId: string;
}>;

/**
 * The exit from the credential halt (Phase 2.2): USER-INITIATED re-enrollment
 * with the bootstrap secret. Refuses unless the device is halted (NOT_HALTED)
 * and unless the server runs per-account auth (RECOVERY_UNSUPPORTED /
 * VAULT_UNREACHABLE — recovery never falls back on discovery failure). The
 * stale record's deviceId is used for enrollment so the server (2.1) revokes
 * every still-active predecessor; an explicit config.deviceId differing from
 * it is DEVICE_ID_CONFLICT. Order: canary -> enroll -> persist + verify
 * (overwriting the stale record) -> clear the halt LAST -> fresh engine.
 * Every failure leaves the device halted with its state intact. The secret is
 * confined to the call, exactly as in connectVaultSyncEngine. Call only from
 * a deliberate user action; no code path in this package invokes it.
 */
export function recoverVaultSyncEngine(
  config: Omit<DbSyncEngineConfig, 'vaultToken'> & {
    vaultToken?: string;
    enrollmentSecret: string;
  }
): Promise<{
  engine: DbSyncEngine;
  authMode: 'per-account';
  enrolled: true;
  deviceId: string;
}>;
