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
  isReservedEntityId,
  KEYCHECK_ENTITY_ID,
  KEYCHECK_PAYLOAD,
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
 * @param {Function} [config.onError]      - (message, code, isHardStop) called with code 'KEY_MISMATCH' on a wrong key, or 'VERIFIER_UNSUPPORTED' when the server can't host the verifier
 * @param {Function} [config.onRowsSkipped] - (count, entityIds) called when a cycle skipped undecryptable rows
 * @param {boolean}  [config.allowUnverified=false] - operator escape hatch: downgrade VERIFIER_UNSUPPORTED to a logged warning and proceed (unsafe; off by default)
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
    onRowsSkipped,
    allowUnverified = false,
  } = config;

  if (!storageKeyPrefix) throw new Error('createDbSyncEngine: storageKeyPrefix is required');
  if (!config.vaultClient && !vaultUrl)   throw new Error('createDbSyncEngine: vaultUrl is required');
  if (!config.vaultClient && !vaultToken) throw new Error('createDbSyncEngine: vaultToken is required');
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    // Reject empty/whitespace too: a whitespace-only id passes a plain falsy
    // check but serialises to `?accountId=+++`, which the server trims to empty
    // and rejects with a cryptic 400 on every row-scoped call (incl. the key
    // verifier's single-row GET).
    throw new Error('createDbSyncEngine: accountId is required');
  }
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
  // KEY_QUARANTINE persists the set of rows that failed to decrypt under the
  // (otherwise verified) account key, as [{ entityId, seq }]. They are skipped
  // on pull so one bad row cannot wedge the cycle, and re-attempted each cycle
  // so a row recovers if the correct key later becomes available.
  const KEY_QUARANTINE = `${storageKeyPrefix}-db-sync-quarantine`;

  // ── In-memory guards ──────────────────────────────────────────────────────
  let syncing = false;
  // Per-session cache: once the derived root key is proven against the account's
  // existing data (Part A), we never re-verify for the life of this engine.
  let verified = false;

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

  // Quarantine set persisted as a JSON array of { entityId, seq }.
  const getQuarantine = () => {
    const raw = localStorage.getItem(KEY_QUARANTINE);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };
  const writeQuarantine = (list) => {
    if (list.length === 0) localStorage.removeItem(KEY_QUARANTINE);
    else localStorage.setItem(KEY_QUARANTINE, JSON.stringify(list));
  };
  const addToQuarantine = (entityId, seq) => {
    const list = getQuarantine();
    const i = list.findIndex((q) => q.entityId === entityId);
    if (i >= 0) list[i] = { entityId, seq };
    else list.push({ entityId, seq });
    writeQuarantine(list);
  };
  const removeFromQuarantine = (entityId) => {
    writeQuarantine(getQuarantine().filter((q) => q.entityId !== entityId));
  };

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

  // ── Key verifier (Part A) ─────────────────────────────────────────────────
  // Proves the derived root key matches the account's existing data BEFORE we
  // are allowed to push. A wrong passphrase — or a per-account salt that drifted
  // across server redeploys — derives a non-matching key; without this check it
  // would only surface as a cryptic per-row failure mid-sync, after a device may
  // already have uploaded rows under the bad key and poisoned the account.
  //
  // The signal is decryptability: AES-GCM tag validation means a wrong key
  // simply fails, so the verifier payload's contents need not match. Runs once
  // per session (cached via `verified`).
  // A server that can't host the verifier (doesn't support the reserved id or
  // the single-row GET endpoint) must fail with a CLEAR reason, not a raw
  // "get row failed: 400". We never silently proceed unverified: the verifier
  // gates push and quarantine does NOT, so a wrong-key device with verification
  // skipped would still push poison rows. Pausing sync with a clear reason is
  // the correct degradation. (config.allowUnverified is an explicit operator
  // escape hatch, off by default, that downgrades this to a logged warning.)
  // Client-readiness failures (no passphrase yet, or accountId not populated)
  // are NOT a server problem: re-throw them as-is so they surface with their own
  // typed, retryable code instead of being mislabeled "update your server".
  const isClientNotReady = (err) =>
    err && (err.code === 'ACCOUNT_ID_REQUIRED' || err.code === 'PASSPHRASE_REQUIRED');

  const verifierUnsupported = (cause) => {
    if (isClientNotReady(cause)) throw cause;
    if (allowUnverified) {
      // eslint-disable-next-line no-console
      console.warn(`[${appId}] db sync proceeding UNVERIFIED: the server cannot host the key verifier (${KEYCHECK_ENTITY_ID}).`, cause);
      verified = true;
      return; // caller returns from verifyAccountKey and sync proceeds
    }
    const err = new Error('Your GLANCEvault server needs to be updated to support key verification (the __glance_keycheck row).');
    err.code = 'VERIFIER_UNSUPPORTED';
    if (cause) err.cause = cause;
    throw err;
  };

  const verifyAccountKey = async () => {
    if (verified) return;
    // Verification needs a single-row fetch. Clients that don't implement getRow
    // (e.g. minimal test stubs) cannot be verified; don't block sync on them.
    if (typeof vault.getRow !== 'function') { verified = true; return; }

    // Outcome 3: any error from the GET (HTTP 400/405/500, or a 404 on the route
    // itself) means the server can't host the verifier — fail clearly.
    let row;
    try {
      row = await vault.getRow(app, KEYCHECK_ENTITY_ID, accountId);
    } catch (cause) {
      verifierUnsupported(cause);
      return; // only reached when downgraded via allowUnverified
    }

    if (row && !row.deleted && row.envelope) {
      // Outcome 1: existing account — the verifier must decrypt under our key.
      try {
        await decryptEntity(row.envelope, KEYCHECK_ENTITY_ID);
        verified = true;
      } catch {
        const err = new Error("This sync passphrase doesn't match this account's existing data.");
        err.code = 'KEY_MISMATCH';
        throw err;
      }
    } else {
      // Outcome 2: row absent (404 -> getRow returned null) — new account.
      // Establish the verifier insert-only / first-write-wins so concurrent
      // establishers don't clobber; since the salt is already first-write-wins,
      // they derive the same key and their verifiers are mutually decryptable.
      const envelope = await encryptEntity(KEYCHECK_PAYLOAD, KEYCHECK_ENTITY_ID);
      try {
        await vault.batch(app, {
          accountId,
          rows: [{ entityId: KEYCHECK_ENTITY_ID, envelope, createdAt: Date.now(), insertOnly: true }],
        });
      } catch (cause) {
        // The write itself rejecting the reserved id (400/405/…) is the same
        // "server can't host the verifier" condition.
        verifierUnsupported(cause);
        return;
      }
      verified = true;
    }
  };

  // ── Root key / salt bootstrap ─────────────────────────────────────────────
  // Ensures the per-account root key is available, fetching or registering the
  // salt with the vault on first use, then verifies it once per session.
  const ensureRootKey = async () => {
    if (!hasDbRootKey() && !(await initDbRootKey(cryptoCfg))) {
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
    }

    // Key is now available (restored or freshly derived). Prove it matches the
    // account before anything else relies on it; this gates the push.
    await verifyAccountKey();
  };

  // ── Step 1: push dirty rows ───────────────────────────────────────────────
  // Encrypts every dirty entity and upserts it as a batch. Entities that no
  // longer exist locally are pushed as soft-deletes. The dirty set is cleared
  // and the push-ack high water mark advanced only after the server fully
  // acknowledges, so a network failure leaves un-acked rows dirty for an
  // idempotent re-send. Push deliberately does NOT touch the pull cursor
  // (getHighWaterMark): the server assigns pushed rows the highest seqs, so
  // advancing `since` here would skip any remote row whose seq sits below them.
  //
  // The push is GATED on key verification: ensureRootKey runs Part A's
  // verifyAccountKey, which throws KEY_MISMATCH (before any upsert) if the
  // derived key doesn't match the account — so a device can never upload rows
  // under a non-matching key.
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

    // Batch the upserts FIRST, then soft-delete. If any call throws, we fall
    // out before clearing the dirty set or advancing the push-ack marker.
    //
    // The order matters for partial-failure safety: a cross-list move puts a
    // delete ("old-list:X") and its replacement upsert ("new-list:X") in the
    // same dirty set. Deleting first opened a window where the delete landed,
    // the batch failed, and every peer pulled a delete with no replacement —
    // the entity vanished fleet-wide until this device successfully retried.
    // Upserting first inverts the partial state into a benign one (both rows
    // briefly exist) that the retried delete cleans up. Nothing depends on
    // deletes landing first: upserts and deletes in one push never share an
    // entityId (an entity is either present locally or not), and maxSeq is
    // order-independent.
    //
    // Each delete carries a deletedAt stamp so pulling devices can run LWW
    // against it (see applyRemoteRow). Servers that predate the stamp ignore
    // the extra field, in which case pulled tombstones simply lack deletedAt
    // and fall back to the old delete-wins behavior.
    let maxSeq = getPushAck();
    if (upserts.length > 0) {
      const result = await vault.batch(app, { accountId, rows: upserts });
      if (result && typeof result.maxSeq === 'number') maxSeq = Math.max(maxSeq, result.maxSeq);
    }
    for (const entityId of deletes) {
      const r = await vault.deleteRow(app, entityId, accountId, { deletedAt: Date.now() });
      if (r && typeof r.seq === 'number') maxSeq = Math.max(maxSeq, r.seq);
      if (r && typeof r.maxSeq === 'number') maxSeq = Math.max(maxSeq, r.maxSeq);
    }

    // Full acknowledgment: safe to mark clean. Advance the push-ack marker only;
    // the pull cursor stays put so the next pull still lists from the highest
    // seq we have actually consumed.
    clearDirty();
    setPushAck(maxSeq);
    return { written: upserts.length, deleted: deletes.length, maxSeq };
  };

  // Decrypts and applies one row with entity-grain LWW. Mutates the supplied
  // `dirty` Set in place (and persists it) when a remote write supersedes a
  // dirty local copy, so we do not re-push a superseded version. Returns true if
  // a remote write/delete was applied. Throws (ROW_DECRYPT_FAILED) on a decrypt
  // failure — the caller decides whether to quarantine.
  const applyRemoteRow = async (R, dirty) => {
    if (R.deleted) {
      // A tombstone participates in the same entity-grain LWW as an upsert,
      // using the deletedAt stamp the pushing device attached (see
      // pushDirtyRows). A local copy KEEPS only when its lastModified strictly
      // exceeds deletedAt: the delete wins ties, because deletedAt is stamped
      // at push time and therefore already post-dates the edit that produced
      // it on the deleting device. Tombstones from servers/devices that
      // predate the stamp carry no deletedAt (ts -> 0); those keep the old
      // unconditional delete-wins behavior.
      const deletedAt = ts(R.deletedAt);
      if (deletedAt > 0) {
        const local = await getLocalEntity(R.entityId);
        if (local != null && ts(lastModifiedOf(local)) > deletedAt) {
          // The local edit is newer than the delete: keep it, and make sure it
          // is dirty so the next push re-upserts it over the tombstone and
          // restores the row fleet-wide (matching the file tier's
          // newest-write-wins over tombstones).
          if (!dirty.has(R.entityId)) {
            dirty.add(R.entityId);
            writeDirtySet([...dirty]);
          }
          return false;
        }
      }
      await applyRemoteDelete(R.entityId);
      if (dirty.delete(R.entityId)) writeDirtySet([...dirty]);
      return true;
    }

    const remoteEntity = await decryptEntity(R.envelope, R.entityId);
    const local = await getLocalEntity(R.entityId);

    if (local == null) {
      await applyRemoteEntity(R.entityId, remoteEntity);
      return true;
    }
    if (insertOnly(remoteEntity, R.entityId)) {
      // Insert-only types never conflict: applying is an idempotent union.
      await applyRemoteEntity(R.entityId, remoteEntity);
      return true;
    }
    // Entity-grain last-writer-wins. The same comparison covers both the clean
    // case and the contended (locally dirty) case.
    const remoteWins = ts(lastModifiedOf(remoteEntity)) > ts(lastModifiedOf(local));
    if (remoteWins) {
      await applyRemoteEntity(R.entityId, remoteEntity);
      if (dirty.delete(R.entityId)) writeDirtySet([...dirty]);
      return true;
    }
    // local is newer or equal: keep local and discard remote. If the entity is
    // dirty it stays dirty and will be re-pushed next cycle.
    return false;
  };

  // ── Quarantine self-heal (Part B) ─────────────────────────────────────────
  // Quarantined rows sit BELOW the pull cursor (we advanced past them), so they
  // never reappear in list() — re-fetching by id is the only recovery path. A
  // row drops out of quarantine on successful decrypt+apply (e.g. once the
  // correct key is in use) or once it is gone from the server.
  const healQuarantine = async (dirty) => {
    const list = getQuarantine();
    if (list.length === 0 || typeof vault.getRow !== 'function') return 0;

    let healed = 0;
    for (const { entityId } of list) {
      let R;
      try {
        R = await vault.getRow(app, entityId, accountId);
      } catch {
        continue; // transient network error: leave quarantined, retry next cycle
      }
      if (R == null) {
        removeFromQuarantine(entityId); // gone from server: nothing to recover
        continue;
      }
      try {
        const didApply = await applyRemoteRow(R, dirty);
        removeFromQuarantine(entityId);
        if (didApply) healed += 1;
      } catch {
        // Still undecryptable under the current key: leave quarantined.
      }
    }
    return healed;
  };

  // ── Step 2: pull remote changes ───────────────────────────────────────────
  // Paginates from the high water mark, applying each row with entity-grain LWW.
  // Part A's key verification has already run (via ensureRootKey), so a globally
  // wrong key has aborted with KEY_MISMATCH before we get here; any decrypt
  // failure now is an INDIVIDUAL bad row. Such a row is counted, quarantined,
  // and its cursor advanced past — it must never throw and wedge the cycle.
  const pullRemoteChanges = async () => {
    await ensureRootKey();

    let since = getHighWaterMark();
    let maxSeq = since;
    let appliedRemote = false;
    let applied = 0;
    let skipped = 0;
    const skippedEntityIds = [];

    // Re-attempt previously quarantined rows first; a snapshot dirty set keeps
    // contended-path resolution consistent across heal + page application.
    const dirty = new Set(getDirtySet());
    applied += await healQuarantine(dirty);

    let hasMore = true;
    while (hasMore) {
      const { rows, hasMore: more } = await vault.list(app, { accountId, since });
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const R of rows) {
        if (typeof R.seq === 'number' && R.seq > maxSeq) maxSeq = R.seq;

        // Engine-reserved rows (e.g. the key verifier) are not app entities and
        // must never be routed to applyRemoteEntity. Advance past them.
        if (!isReservedEntityId(R.entityId)) {
          try {
            const didApply = await applyRemoteRow(R, dirty);
            if (didApply) { appliedRemote = true; applied += 1; }
          } catch {
            // Per-row decrypt failure: quarantine, count, advance, continue.
            skipped += 1;
            skippedEntityIds.push(R.entityId);
            addToQuarantine(R.entityId, R.seq);
          }
        }

        if (typeof R.seq === 'number') since = Math.max(since, R.seq);
      }

      hasMore = !!more;
    }

    // Pull is the sole writer of the pull cursor. Advance it (monotonically)
    // from the highest seq we actually listed this run.
    setHighWaterMark(Math.max(getHighWaterMark(), maxSeq));
    return { maxSeq, appliedRemote, applied, skipped, skippedEntityIds };
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
      // Part A first: prove the key before we push anything. A globally wrong
      // key aborts here with KEY_MISMATCH (push gated, nothing uploaded) rather
      // than quarantining thousands of rows one by one on the pull.
      await ensureRootKey();

      await pushDirtyRows();
      onStatusChange?.('downloading');
      const pull = await pullRemoteChanges();
      await updateDeviceCursor();

      const now = new Date().toISOString();
      localStorage.setItem(KEY_LAST_SYNCED, now);
      onStatusChange?.('success');

      if (pull.skipped > 0) onRowsSkipped?.(pull.skipped, pull.skippedEntityIds);
      return { applied: pull.applied, skipped: pull.skipped, skippedEntityIds: pull.skippedEntityIds };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[${appId}] db sync cycle error:`, err);
      const code = err && err.code ? err.code : 'NETWORK_ERROR';
      onError?.(err?.message || String(err), code, false);
      onStatusChange?.('error');
      return { applied: 0, skipped: 0, skippedEntityIds: [] };
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

    // Quarantine (per-row decrypt failures awaiting self-heal)
    getQuarantine,

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
    isKeyVerified:    () => verified,
    hasEncryptionReady: hasDbRootKey,

    // Sub-modules
    vault,
  };
};
