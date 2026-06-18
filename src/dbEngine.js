// Database sync engine for @glance-apps/sync (Phase 3).
//
// This is the row-grained transport that runs when config.transportMode is
// 'database'. It sits alongside the file-tier engine in engine.js, which is left
// completely untouched: file-tier users never reach this code.
//
// Where the file tier downloads the whole entity array, merges it, and uploads
// the whole array back, this engine tracks dirty entities locally and exchanges
// only the rows that changed, using GLANCEvault's seq-based incremental sync:
//
//   1. PUSH dirty rows   (encrypted per-entity, cleared only on full ack)
//   2. PULL remote rows  (seq cursor, paginated, entity-grain LWW)
//   3. UPDATE device cursor (best-effort)
//
// Local sync state (dbSyncHighWaterMark, dbSyncDirtySet) is persisted via the
// same localStorage that the file engine uses for its sync metadata, keyed by
// storageKeyPrefix. See the Phase 3 summary for why localStorage is used here in
// place of the spec's IndexedDB suggestion.

import { createVaultClient } from './vaultClient.js';
import { getSyncPassphrase } from './crypto.js';
import {
  setupDbRootKey,
  initDbRootKey,
  hasDbRootKey,
  encryptEntity,
  decryptEntity,
} from './dbCrypto.js';

const ts = (v) => {
  if (v == null) return 0;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Creates the database sync engine.
 *
 * @param {object} config
 * @param {string}  config.storageKeyPrefix - namespace for local sync state
 * @param {string}  config.appId            - app identity (fallback URL segment)
 * @param {string} [config.vaultApp]        - URL path segment for the app (defaults to appId)
 * @param {string}  config.vaultUrl
 * @param {string}  config.vaultToken
 * @param {string}  config.accountId
 * @param {string} [config.deviceId]
 * @param {string}  config.cryptoDBName     - device storage name for the root key
 * @param {Function|null} [config.nativeGetSyncKey]
 * @param {Function|null} [config.nativeStoreSyncKey]
 * @param {Function} [config.fetchImpl]     - injectable fetch (tests / native shells)
 *
 * Data callbacks (the engine is data-shape agnostic):
 * @param {Function} config.getLocalEntity      - (entityId) => entity | null | Promise
 * @param {Function} config.applyRemoteEntity   - (entityId, entity) => void | Promise
 * @param {Function} config.applyRemoteDelete   - (entityId) => void | Promise
 * @param {Function} [config.isInsertOnly]       - (entity, entityId) => boolean
 * @param {Function} [config.getEntityLastModified] - (entity) => string|number (defaults to entity.lastModified)
 *
 * Event callbacks (optional):
 * @param {Function} [config.onStatusChange]
 * @param {Function} [config.onError]
 */
export const createDbSyncEngine = (config) => {
  const {
    storageKeyPrefix,
    appId,
    vaultApp,
    vaultUrl,
    vaultToken,
    accountId,
    deviceId,
    cryptoDBName,
    nativeGetSyncKey = null,
    nativeStoreSyncKey = null,
    fetchImpl,
    getLocalEntity,
    applyRemoteEntity,
    applyRemoteDelete,
    isInsertOnly,
    getEntityLastModified,
    onStatusChange,
    onError,
  } = config;

  if (!storageKeyPrefix) throw new Error('createDbSyncEngine: storageKeyPrefix is required');
  if (!config.vaultClient && !vaultUrl)   throw new Error('createDbSyncEngine: vaultUrl is required');
  if (!config.vaultClient && !vaultToken) throw new Error('createDbSyncEngine: vaultToken is required');
  if (!accountId)        throw new Error('createDbSyncEngine: accountId is required');
  if (typeof getLocalEntity    !== 'function') throw new Error('createDbSyncEngine: getLocalEntity is required');
  if (typeof applyRemoteEntity !== 'function') throw new Error('createDbSyncEngine: applyRemoteEntity is required');
  if (typeof applyRemoteDelete !== 'function') throw new Error('createDbSyncEngine: applyRemoteDelete is required');

  const app = vaultApp || appId;
  const lastModifiedOf = typeof getEntityLastModified === 'function'
    ? getEntityLastModified
    : (entity) => entity && entity.lastModified;
  const insertOnly = typeof isInsertOnly === 'function'
    ? isInsertOnly
    : () => false;

  const cryptoCfg = { cryptoDBName, nativeGetSyncKey, nativeStoreSyncKey };
  // config.vaultClient lets tests and native shells supply a pre-built client;
  // otherwise build the default HTTP client from the vault credentials.
  const vault = config.vaultClient || createVaultClient({ vaultUrl, vaultToken, fetchImpl });

  // localStorage keys owned by this engine.
  const KEY_CONFIG = `${storageKeyPrefix}-db-sync-config`;
  // KEY_HWM is the PULL cursor: the highest seq this device has actually
  // consumed (listed + applied). It is the `since` we resume pulling from, so
  // only the pull step may advance it. A push consumes nothing and must never
  // touch it — see KEY_PUSH_ACK below.
  const KEY_HWM    = `${storageKeyPrefix}-db-sync-hwm`;
  // KEY_PUSH_ACK is the PUSH high-water mark: the highest seq the server has
  // assigned to rows this device has pushed and fully acknowledged. It exists
  // purely for push idempotency/observability and is never read by the pull
  // cursor, so it cannot cause unread remote rows to be skipped.
  const KEY_PUSH_ACK = `${storageKeyPrefix}-db-sync-push-ack`;
  const KEY_DIRTY  = `${storageKeyPrefix}-db-sync-dirty`;
  const KEY_LAST_SYNCED = `${storageKeyPrefix}-db-sync-last-synced`;

  // ── In-memory guard ───────────────────────────────────────────────────────
  let syncing = false;

  // ── Local state accessors ─────────────────────────────────────────────────
  const getConfig = () => {
    const saved = localStorage.getItem(KEY_CONFIG);
    return saved ? JSON.parse(saved) : null;
  };
  const setConfig = (cfg) => {
    if (cfg) localStorage.setItem(KEY_CONFIG, JSON.stringify(cfg));
    else     localStorage.removeItem(KEY_CONFIG);
  };
  const getLastSynced = () => localStorage.getItem(KEY_LAST_SYNCED) || null;

  // PULL cursor. Advanced only by pullRemoteChanges from rows actually applied.
  // An existing stored value from before the pull/push split is read as
  // pull-progress, which is the conservative interpretation (it never lets us
  // resume ahead of what we have consumed).
  const getHighWaterMark = () => {
    const raw = localStorage.getItem(KEY_HWM);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const setHighWaterMark = (seq) => {
    localStorage.setItem(KEY_HWM, String(seq));
  };

  // PUSH high-water mark. Tracked separately so a push can never advance the
  // pull cursor (KEY_HWM) and skip lower-seq remote rows.
  const getPushAck = () => {
    const raw = localStorage.getItem(KEY_PUSH_ACK);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const setPushAck = (seq) => {
    localStorage.setItem(KEY_PUSH_ACK, String(seq));
  };

  // Dirty set persisted as a JSON array; deduped via Set on read/write.
  const getDirtySet = () => {
    const raw = localStorage.getItem(KEY_DIRTY);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };
  const writeDirtySet = (ids) => {
    localStorage.setItem(KEY_DIRTY, JSON.stringify([...new Set(ids)]));
  };
  const clearDirty = () => localStorage.removeItem(KEY_DIRTY);

  // markDirty: called by the app on every local write (and at creation time for
  // insert-only types). Idempotent and synchronous so it can run inside the
  // app's own write path.
  const markDirty = (entityId) => {
    if (entityId == null) return;
    const id = String(entityId);
    const current = getDirtySet();
    if (current.includes(id)) return;
    current.push(id);
    writeDirtySet(current);
  };

  // ── Root key / salt bootstrap ─────────────────────────────────────────────
  // Ensures the per-account root key is available, fetching or registering the
  // salt with the vault on first use.
  const ensureRootKey = async () => {
    if (hasDbRootKey()) return;
    if (await initDbRootKey(cryptoCfg)) return;

    const passphrase = getSyncPassphrase();
    if (!passphrase) {
      const err = new Error('Encryption passphrase not available. Please enter your sync passphrase.');
      err.code = 'PASSPHRASE_REQUIRED';
      throw err;
    }

    let salt = await vault.getSalt(accountId);
    if (!salt) {
      const fresh = crypto.getRandomValues(new Uint8Array(16));
      // First-write-wins: use whatever the server returns (another device may
      // have registered a salt between our GET and PUT).
      salt = await vault.putSalt(accountId, fresh);
    }
    await setupDbRootKey(passphrase, salt, cryptoCfg);
  };

  // ── Step 1: push dirty rows ───────────────────────────────────────────────
  // Encrypts every dirty entity and upserts it as a batch. Entities that no
  // longer exist locally are pushed as soft-deletes. The dirty set is cleared
  // and the push-ack high water mark advanced only after the server fully
  // acknowledges, so a network failure leaves un-acked rows dirty for an
  // idempotent re-send. Push deliberately does NOT touch the pull cursor
  // (getHighWaterMark): the server assigns pushed rows the highest seqs, so
  // advancing `since` here would skip any remote row whose seq sits below them.
  const pushDirtyRows = async () => {
    const dirty = getDirtySet();
    if (dirty.length === 0) return { written: 0, deleted: 0, maxSeq: getPushAck() };

    await ensureRootKey();

    const upserts = [];
    const deletes = [];
    for (const entityId of dirty) {
      const entity = await getLocalEntity(entityId);
      if (entity == null) {
        deletes.push(entityId);
      } else {
        const envelope = await encryptEntity(entity, entityId);
        upserts.push({ entityId, envelope, createdAt: Date.now() });
      }
    }

    // Soft-delete first, then batch the upserts. If any call throws, we fall out
    // before clearing the dirty set or advancing the push-ack marker.
    let maxSeq = getPushAck();
    for (const entityId of deletes) {
      const r = await vault.deleteRow(app, entityId, accountId);
      if (r && typeof r.seq === 'number') maxSeq = Math.max(maxSeq, r.seq);
      if (r && typeof r.maxSeq === 'number') maxSeq = Math.max(maxSeq, r.maxSeq);
    }
    if (upserts.length > 0) {
      const result = await vault.batch(app, { accountId, rows: upserts });
      if (result && typeof result.maxSeq === 'number') maxSeq = Math.max(maxSeq, result.maxSeq);
    }

    // Full acknowledgment: safe to mark clean. Advance the push-ack marker only;
    // the pull cursor stays put so the next pull still lists from the highest
    // seq we have actually consumed.
    clearDirty();
    setPushAck(maxSeq);
    return { written: upserts.length, deleted: deletes.length, maxSeq };
  };

  // ── Step 2: pull remote changes ───────────────────────────────────────────
  // Paginates from the high water mark, applying each row with entity-grain LWW.
  // Rows that are also locally dirty are resolved against the dirty local copy
  // (contended path): remote wins only if its lastModified is newer, and when it
  // does win the entity is dropped from the dirty set so we do not re-push a
  // superseded version.
  const pullRemoteChanges = async () => {
    let since = getHighWaterMark();
    let maxSeq = since;
    let appliedRemote = false;

    let hasMore = true;
    while (hasMore) {
      const { rows, hasMore: more } = await vault.list(app, { accountId, since });
      if (!Array.isArray(rows) || rows.length === 0) break;

      // Snapshot the dirty set once per page for contended-path resolution.
      const dirty = new Set(getDirtySet());

      for (const R of rows) {
        if (typeof R.seq === 'number' && R.seq > maxSeq) maxSeq = R.seq;

        if (R.deleted) {
          await applyRemoteDelete(R.entityId);
          if (dirty.delete(R.entityId)) writeDirtySet([...dirty]);
          appliedRemote = true;
          continue;
        }

        await ensureRootKey();
        const remoteEntity = await decryptEntity(R.envelope, R.entityId);
        const local = await getLocalEntity(R.entityId);

        if (local == null) {
          await applyRemoteEntity(R.entityId, remoteEntity);
          appliedRemote = true;
        } else if (insertOnly(remoteEntity, R.entityId)) {
          // Insert-only types never conflict: applying is an idempotent union.
          await applyRemoteEntity(R.entityId, remoteEntity);
          appliedRemote = true;
        } else {
          // Entity-grain last-writer-wins. The same comparison covers both the
          // clean case and the contended (locally dirty) case.
          const remoteWins = ts(lastModifiedOf(remoteEntity)) > ts(lastModifiedOf(local));
          if (remoteWins) {
            await applyRemoteEntity(R.entityId, remoteEntity);
            appliedRemote = true;
            if (dirty.delete(R.entityId)) writeDirtySet([...dirty]);
          }
          // else: local is newer or equal, so keep local and discard remote. If the
          // entity is dirty it stays dirty and will be re-pushed next cycle.
        }

        if (typeof R.seq === 'number') since = Math.max(since, R.seq);
      }

      hasMore = !!more;
    }

    // Pull is the sole writer of the pull cursor. Advance it (monotonically)
    // from the highest seq we actually listed this run.
    setHighWaterMark(Math.max(getHighWaterMark(), maxSeq));
    return { maxSeq, appliedRemote };
  };

  // ── Step 3: update device cursor ──────────────────────────────────────────
  // Best-effort: a failure here only affects tombstone GC timing, never sync
  // correctness, so it is swallowed. lastSeenSeq reports the pull cursor (what
  // we have truly consumed), not the push-ack marker: reporting consumed
  // progress is the conservative value for server-side tombstone GC, since it
  // never lets the server reclaim a tombstone this device has not yet seen.
  const updateDeviceCursor = async () => {
    if (!deviceId) return { updated: false };
    try {
      return await vault.device(app, {
        accountId,
        deviceId,
        lastSeenSeq: getHighWaterMark(),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[${appId}] db sync device cursor update failed (non-fatal):`, err);
      return { updated: false };
    }
  };

  // ── Full cycle ────────────────────────────────────────────────────────────
  const dbSyncCycle = async () => {
    const cfg = getConfig();
    if (cfg && cfg.enabled === false) return;
    if (syncing) return;
    syncing = true;
    onStatusChange?.('uploading');
    onError?.(null, null, false);
    try {
      await pushDirtyRows();
      onStatusChange?.('downloading');
      await pullRemoteChanges();
      await updateDeviceCursor();

      const now = new Date().toISOString();
      localStorage.setItem(KEY_LAST_SYNCED, now);
      onStatusChange?.('success');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[${appId}] db sync cycle error:`, err);
      const code = err && err.code ? err.code : 'NETWORK_ERROR';
      onError?.(err?.message || String(err), code, false);
      onStatusChange?.('error');
    } finally {
      syncing = false;
    }
  };

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    transportMode: 'database',

    // Lifecycle
    sync: dbSyncCycle,
    dbSyncCycle,
    pushDirtyRows,
    pullRemoteChanges,
    updateDeviceCursor,
    ensureRootKey,

    // Dirty tracking
    markDirty,
    getDirtySet,
    clearDirty,

    // Cursor (pull-progress) and push-ack marker
    getHighWaterMark,
    setHighWaterMark,
    getPushAck,
    setPushAck,

    // Config
    getConfig,
    setConfig,
    getLastSynced,

    // State queries
    isSyncing:        () => syncing,
    hasEncryptionReady: hasDbRootKey,

    // Sub-modules
    vault,
  };
};
