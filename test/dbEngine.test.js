// Tests for the database sync engine (Phase 3).
//
// Covers the Phase 3 deliverable tests:
//   #2 salt registration (real vault via VAULT_URL; skipped when unset)
//   #3 push cycle
//   #4 pull cycle (new / remote-wins LWW / local-wins LWW / insert-only)
//   #5 partial-write safety
//   #6 idempotency
//
// Synthetic tests use a stateful in-memory mock vault injected via
// config.vaultClient. The root key is set up directly with a fixed salt so the
// real per-entity crypto runs without touching the salt endpoints.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal in-memory localStorage shim (same pattern as engine.test.js).
const __store = new Map();
globalThis.localStorage = {
  getItem:    (k) => (__store.has(k) ? __store.get(k) : null),
  setItem:    (k, v) => { __store.set(k, String(v)); },
  removeItem: (k) => { __store.delete(k); },
  clear:      () => { __store.clear(); },
  key:        (i) => Array.from(__store.keys())[i] ?? null,
  get length() { return __store.size; },
};

const { createDbSyncEngine } = await import('../src/dbEngine.js');
const { createSyncEngine } = await import('../src/engine.js');
const {
  setupDbRootKey,
  clearDbRootKey,
  encryptEntity,
  KEYCHECK_ENTITY_ID,
  KEYCHECK_PAYLOAD,
} = await import('../src/dbCrypto.js');

const CRYPTO_CFG = { cryptoDBName: 'glance-db-engine-test' };
const FIXED_SALT = new Uint8Array(16).fill(5);

// A verifier envelope encrypted under the beforeEach session key, recomputed in
// beforeEach so mock vaults can be seeded as "already-established" accounts.
let VERIFIER_ENVELOPE = null;

// ---------- Mock vault ----------

// seedVerifier (default true): pre-store a key verifier at seq 0 so the engine's
// verifyAccountKey takes the decrypt-success path — no extra batch write and no
// seq consumed — matching an account whose verifier already exists. Pass false
// to exercise the fresh-account path (getRow -> null -> verifier write).
const makeStatefulVault = ({ seedVerifier = true } = {}) => {
  const rows = new Map(); // entityId -> { entityId, envelope, createdAt, seq, deleted }
  let seq = 0;
  if (seedVerifier && VERIFIER_ENVELOPE) {
    rows.set(KEYCHECK_ENTITY_ID, {
      entityId: KEYCHECK_ENTITY_ID, envelope: VERIFIER_ENVELOPE, createdAt: 0, seq: 0, deleted: false,
    });
  }
  const calls = { batch: [], list: [], deleteRow: [], device: [], getRow: [] };
  return {
    rows,
    calls,
    async batch(app, { rows: incoming }) {
      calls.batch.push(incoming);
      for (const r of incoming) {
        seq += 1;
        rows.set(r.entityId, { ...r, seq, deleted: false });
      }
      return { written: incoming.length, maxSeq: seq };
    },
    async list(app, { since }) {
      calls.list.push(since);
      const out = [...rows.values()].filter(r => r.seq > since).sort((a, b) => a.seq - b.seq);
      return { rows: out, hasMore: false };
    },
    async getRow(app, entityId) {
      calls.getRow.push(entityId);
      return rows.get(entityId) ?? null;
    },
    async deleteRow(app, entityId, _accountId, opts = {}) {
      calls.deleteRow.push(entityId);
      seq += 1;
      rows.set(entityId, { entityId, seq, deleted: true, deletedAt: opts?.deletedAt });
      return { seq };
    },
    async device(app, args) {
      calls.device.push(args);
      return { updated: true };
    },
    async getSalt() { return FIXED_SALT; },
    async putSalt(_a, s) { return s; },
  };
};

const makeEngine = (overrides = {}) => {
  const local = overrides.local || new Map();
  const applied = [];
  const deleted = [];
  const vault = overrides.vault || makeStatefulVault();
  const engine = createDbSyncEngine({
    storageKeyPrefix: 'dbtest',
    appId: 'test-app',
    accountId: 'acct-1',
    deviceId: 'device-1',
    cryptoDBName: CRYPTO_CFG.cryptoDBName,
    vaultClient: vault,
    getLocalEntity: (id) => (local.has(id) ? local.get(id) : null),
    applyRemoteEntity: (id, entity) => { local.set(id, entity); applied.push({ id, entity }); },
    applyRemoteDelete: (id) => { local.delete(id); deleted.push(id); },
    isInsertOnly: (entity) => !!(entity && entity.insertOnly),
    ...overrides.config,
  });
  return { engine, vault, local, applied, deleted };
};

beforeEach(async () => {
  localStorage.clear();
  await clearDbRootKey(CRYPTO_CFG);
  await setupDbRootKey('engine-test-pass', FIXED_SALT, CRYPTO_CFG);
  VERIFIER_ENVELOPE = await encryptEntity(KEYCHECK_PAYLOAD, KEYCHECK_ENTITY_ID);
});

// ---------- #3 push cycle ----------

describe('push cycle', () => {
  it('posts a batch of dirty rows, then clears the dirty set and advances the push-ack marker (not the pull cursor)', async () => {
    const local = new Map([
      ['a', { id: 'a', lastModified: '2026-01-01T00:00:00Z' }],
      ['b', { id: 'b', lastModified: '2026-01-01T00:00:00Z' }],
      ['c', { id: 'c', lastModified: '2026-01-01T00:00:00Z' }],
    ]);
    const { engine, vault } = makeEngine({ local });

    engine.markDirty('a');
    engine.markDirty('b');
    engine.markDirty('c');
    expect(engine.getDirtySet().sort()).toEqual(['a', 'b', 'c']);
    expect(engine.getHighWaterMark()).toBe(0);
    expect(engine.getPushAck()).toBe(0);

    const result = await engine.pushDirtyRows();

    expect(vault.calls.batch).toHaveLength(1);
    expect(vault.calls.batch[0]).toHaveLength(3);
    expect(result.maxSeq).toBe(3);
    expect(engine.getDirtySet()).toEqual([]);
    // Push records its ack...
    expect(engine.getPushAck()).toBe(3);
    // ...but must NOT advance the pull cursor: a push consumes nothing.
    expect(engine.getHighWaterMark()).toBe(0);
  });

  it('is a no-op when nothing is dirty', async () => {
    const { engine, vault } = makeEngine();
    const result = await engine.pushDirtyRows();
    expect(vault.calls.batch).toHaveLength(0);
    expect(result.written).toBe(0);
  });
});

// ---------- #4 pull cycle ----------

describe('pull cycle', () => {
  it('applies new rows, resolves LWW both directions, and unions insert-only rows', async () => {
    // Build five encrypted remote rows with explicit seqs.
    const mk = async (entityId, entity, seq) => ({
      entityId,
      envelope: await encryptEntity(entity, entityId),
      createdAt: Date.now(),
      seq,
      deleted: false,
    });

    const remoteRows = [
      await mk('new1', { id: 'new1', lastModified: '2026-01-01T00:00:00Z' }, 1),
      await mk('new2', { id: 'new2', lastModified: '2026-01-01T00:00:00Z' }, 2),
      await mk('rwin', { id: 'rwin', lastModified: '2026-02-01T00:00:00Z', v: 'remote' }, 3),
      await mk('lwin', { id: 'lwin', lastModified: '2026-01-01T00:00:00Z', v: 'remote' }, 4),
      await mk('ins',  { id: 'ins', insertOnly: true, v: 'remote' }, 5),
    ];

    const vault = {
      calls: { list: [] },
      async list(app, { since }) {
        this.calls.list.push(since);
        return { rows: remoteRows.filter(r => r.seq > since), hasMore: false };
      },
      async device() { return { updated: true }; },
    };

    // Local state: rwin is older locally, lwin is newer locally.
    const local = new Map([
      ['rwin', { id: 'rwin', lastModified: '2026-01-01T00:00:00Z', v: 'local' }],
      ['lwin', { id: 'lwin', lastModified: '2026-03-01T00:00:00Z', v: 'local' }],
    ]);

    const { engine, applied, local: store } = makeEngine({ vault, local });

    const { maxSeq } = await engine.pullRemoteChanges();

    expect(maxSeq).toBe(5);
    expect(engine.getHighWaterMark()).toBe(5);

    // new1, new2 applied
    expect(store.get('new1')).toEqual({ id: 'new1', lastModified: '2026-01-01T00:00:00Z' });
    expect(store.get('new2')).toEqual({ id: 'new2', lastModified: '2026-01-01T00:00:00Z' });
    // remote-wins: remote version applied
    expect(store.get('rwin').v).toBe('remote');
    // local-wins: local version retained, remote discarded
    expect(store.get('lwin').v).toBe('local');
    // insert-only: unioned (applied)
    expect(store.get('ins').v).toBe('remote');

    const appliedIds = applied.map(a => a.id).sort();
    expect(appliedIds).toEqual(['ins', 'new1', 'new2', 'rwin']);
  });

  it('applies remote deletes', async () => {
    const local = new Map([['gone', { id: 'gone', lastModified: '2026-01-01T00:00:00Z' }]]);
    const vault = {
      async list() {
        return { rows: [{ entityId: 'gone', seq: 7, deleted: true }], hasMore: false };
      },
      async device() { return { updated: true }; },
    };
    const { engine, deleted, local: store } = makeEngine({ vault, local });
    await engine.pullRemoteChanges();
    expect(deleted).toEqual(['gone']);
    expect(store.has('gone')).toBe(false);
    expect(engine.getHighWaterMark()).toBe(7);
  });
});

// ---------- tombstone LWW: pulled delete vs local edit ----------
//
// Regression for the "pulled delete unconditionally beats a newer local edit"
// defect: device A deletes X, device B edits X offline with a NEWER
// lastModified, B pulls before pushing. The delete must lose LWW against the
// newer edit, and the edit must stay dirty so the next push restores the row
// fleet-wide — matching both the engine's own upsert LWW and the file tier's
// newest-write-wins over tombstones.

describe('tombstone LWW (pulled delete vs local edit)', () => {
  const tombstoneVault = (tombstone) => ({
    calls: { batch: [] },
    async batch(_app, { rows }) { this.calls.batch.push(rows); return { written: rows.length, maxSeq: tombstone.seq + 1 }; },
    async list(_app, { since }) { return { rows: [tombstone].filter(r => r.seq > since), hasMore: false }; },
    async device() { return { updated: true }; },
  });

  it('keeps a newer dirty local edit over a pulled delete, leaves it dirty, and the next push restores the row', async () => {
    const tombstone = {
      entityId: 'X', seq: 9, deleted: true,
      deletedAt: new Date('2026-01-01T00:00:00Z').getTime(),
    };
    const vault = tombstoneVault(tombstone);
    const local = new Map([['X', { id: 'X', lastModified: '2026-02-01T00:00:00Z', v: 'newer-local-edit' }]]);
    const { engine, deleted, local: store } = makeEngine({ vault, local });
    engine.markDirty('X');

    await engine.pullRemoteChanges();

    // The delete lost LWW: local copy retained, delete callback never fired,
    // and the entity is still dirty (not pruned) so it will re-push.
    expect(deleted).toEqual([]);
    expect(store.get('X').v).toBe('newer-local-edit');
    expect(engine.getDirtySet()).toEqual(['X']);
    // The cursor still advances past the tombstone.
    expect(engine.getHighWaterMark()).toBe(9);

    // The next push re-upserts X over the tombstone (fleet-wide restore).
    await engine.pushDirtyRows();
    expect(vault.calls.batch).toHaveLength(1);
    expect(vault.calls.batch[0].map(r => r.entityId)).toEqual(['X']);
    expect(engine.getDirtySet()).toEqual([]);
  });

  it('marks a CLEAN newer local copy dirty when it beats a pulled delete, so the restore still pushes', async () => {
    const tombstone = {
      entityId: 'X', seq: 3, deleted: true,
      deletedAt: new Date('2026-01-01T00:00:00Z').getTime(),
    };
    const vault = tombstoneVault(tombstone);
    const local = new Map([['X', { id: 'X', lastModified: '2026-02-01T00:00:00Z', v: 'newer-clean-copy' }]]);
    const { engine, deleted, local: store } = makeEngine({ vault, local });
    expect(engine.getDirtySet()).toEqual([]); // clean before the pull

    await engine.pullRemoteChanges();

    expect(deleted).toEqual([]);
    expect(store.has('X')).toBe(true);
    // Without this the server keeps the tombstone and every peer deletes X.
    expect(engine.getDirtySet()).toEqual(['X']);
  });

  it('applies a pulled delete that is newer than the local edit and prunes the dirty set', async () => {
    const tombstone = {
      entityId: 'X', seq: 5, deleted: true,
      deletedAt: new Date('2026-03-01T00:00:00Z').getTime(),
    };
    const local = new Map([['X', { id: 'X', lastModified: '2026-02-01T00:00:00Z' }]]);
    const { engine, deleted, local: store } = makeEngine({ vault: tombstoneVault(tombstone), local });
    engine.markDirty('X');

    await engine.pullRemoteChanges();

    expect(deleted).toEqual(['X']);
    expect(store.has('X')).toBe(false);
    expect(engine.getDirtySet()).toEqual([]);
  });

  it('the delete wins a timestamp tie (deletedAt is stamped at push time, after the deleting device\'s own edit)', async () => {
    const t = new Date('2026-02-01T00:00:00Z').getTime();
    const tombstone = { entityId: 'X', seq: 5, deleted: true, deletedAt: t };
    const local = new Map([['X', { id: 'X', lastModified: t }]]);
    const { engine, deleted, local: store } = makeEngine({ vault: tombstoneVault(tombstone), local });
    engine.markDirty('X');

    await engine.pullRemoteChanges();

    expect(deleted).toEqual(['X']);
    expect(store.has('X')).toBe(false);
    expect(engine.getDirtySet()).toEqual([]);
  });

  it('a timestamp-less tombstone (pre-1.6 server or row) still wins unconditionally — old behavior preserved', async () => {
    const tombstone = { entityId: 'X', seq: 5, deleted: true }; // no deletedAt
    const local = new Map([['X', { id: 'X', lastModified: '2026-02-01T00:00:00Z', v: 'newer-local-edit' }]]);
    const { engine, deleted, local: store } = makeEngine({ vault: tombstoneVault(tombstone), local });
    engine.markDirty('X');

    await engine.pullRemoteChanges();

    expect(deleted).toEqual(['X']);
    expect(store.has('X')).toBe(false);
    expect(engine.getDirtySet()).toEqual([]);
  });
});

// ---------- push ordering: upserts before deletes ----------
//
// Regression for the transient fleet-wide delete window: a cross-list move
// pushes a delete ("unscheduledTasks:X") and its replacement upsert ("tasks:X")
// in the same dirty set. Deletes used to go first, so a failure between the
// two left the delete on the server with no replacement row — every peer
// pulled the delete and the task vanished fleet-wide until a successful retry.

describe('push ordering (upserts before deletes)', () => {
  it('sends the batched upserts before any deleteRow calls, and stamps each delete with deletedAt', async () => {
    const order = [];
    const deleteOpts = [];
    const vault = {
      async batch(_app, { rows }) { order.push('batch'); return { written: rows.length, maxSeq: 1 }; },
      async deleteRow(_app, entityId, _acct, opts) { order.push(`delete:${entityId}`); deleteOpts.push(opts); return { seq: 2 }; },
      async list() { return { rows: [], hasMore: false }; },
      async device() { return { updated: true }; },
    };
    const local = new Map([['tasks:X', { id: 'X', lastModified: '2026-02-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ vault, local });
    engine.markDirty('unscheduledTasks:X'); // no local entity -> pushed as delete
    engine.markDirty('tasks:X');            // present locally  -> pushed as upsert

    await engine.pushDirtyRows();

    expect(order).toEqual(['batch', 'delete:unscheduledTasks:X']);
    expect(deleteOpts[0]).toBeTruthy();
    expect(typeof deleteOpts[0].deletedAt).toBe('number');
    expect(engine.getDirtySet()).toEqual([]);
  });

  it('a failure between the two steps can no longer leave a delete without its paired upsert', async () => {
    // Server state: rows keyed by entityId, tombstones tracked separately.
    const server = new Map();
    const tombstones = [];
    let failDeletes = true;
    const order = [];
    const vault = {
      async batch(_app, { rows }) {
        order.push('batch');
        for (const r of rows) server.set(r.entityId, r);
        return { written: rows.length, maxSeq: 1 };
      },
      async deleteRow(_app, entityId, _acct, opts) {
        order.push(`delete:${entityId}`);
        if (failDeletes) throw new Error('server error 500');
        tombstones.push({ entityId, deletedAt: opts?.deletedAt });
        server.delete(entityId);
        return { seq: 2 };
      },
      async list() { return { rows: [], hasMore: false }; },
      async device() { return { updated: true }; },
    };
    const local = new Map([['tasks:X', { id: 'X', lastModified: '2026-02-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ vault, local });
    engine.markDirty('tasks:X');
    engine.markDirty('unscheduledTasks:X');

    // First push: the upsert lands, then the delete fails.
    await expect(engine.pushDirtyRows()).rejects.toThrow('server error 500');

    // The replacement row is already on the server, and no tombstone exists —
    // peers pulling now see the moved task, never a bare delete.
    expect(server.has('tasks:X')).toBe(true);
    expect(tombstones).toEqual([]);
    // Nothing was acked: the whole dirty set is retained for an idempotent retry.
    expect(engine.getDirtySet().sort()).toEqual(['tasks:X', 'unscheduledTasks:X']);

    // Retry succeeds end-to-end: re-sent upsert is harmless (keyed by entityId),
    // the delete lands with its stamp, and the dirty set clears.
    failDeletes = false;
    await engine.pushDirtyRows();
    expect(order).toEqual(['batch', 'delete:unscheduledTasks:X', 'batch', 'delete:unscheduledTasks:X']);
    expect(server.has('tasks:X')).toBe(true);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].entityId).toBe('unscheduledTasks:X');
    expect(typeof tombstones[0].deletedAt).toBe('number');
    expect(engine.getDirtySet()).toEqual([]);
  });
});

// ---------- #5 partial-write safety ----------

describe('partial-write safety', () => {
  it('keeps the dirty set and does not advance the high water mark when batch fails', async () => {
    const local = new Map([
      ['a', { id: 'a', lastModified: '2026-01-01T00:00:00Z' }],
      ['b', { id: 'b', lastModified: '2026-01-01T00:00:00Z' }],
    ]);
    const failing = {
      async batch() { throw new Error('server error 500'); },
      async list() { return { rows: [], hasMore: false }; },
      async device() { return { updated: true }; },
    };
    const { engine } = makeEngine({ vault: failing, local });

    engine.markDirty('a');
    engine.markDirty('b');

    await expect(engine.pushDirtyRows()).rejects.toThrow('server error 500');

    expect(engine.getDirtySet().sort()).toEqual(['a', 'b']);
    expect(engine.getHighWaterMark()).toBe(0);
  });
});

// ---------- #6 idempotency ----------

describe('idempotency', () => {
  it('pushing the same dirty set twice produces no duplicates and reflects the second maxSeq', async () => {
    const local = new Map([
      ['a', { id: 'a', lastModified: '2026-01-01T00:00:00Z' }],
      ['b', { id: 'b', lastModified: '2026-01-01T00:00:00Z' }],
      ['c', { id: 'c', lastModified: '2026-01-01T00:00:00Z' }],
    ]);
    const { engine, vault } = makeEngine({ local });

    ['a', 'b', 'c'].forEach(id => engine.markDirty(id));
    const first = await engine.pushDirtyRows();
    expect(first.maxSeq).toBe(3);

    // Re-mark the same entities (e.g. retried sync) and push again.
    ['a', 'b', 'c'].forEach(id => engine.markDirty(id));
    const second = await engine.pushDirtyRows();

    // Server keyed rows by entityId: still exactly 3 app rows, no duplicates.
    // (The engine-reserved verifier row is excluded.)
    const appRows = [...vault.rows.keys()].filter(id => !id.startsWith('__glance_'));
    expect(appRows.sort()).toEqual(['a', 'b', 'c']);
    expect(second.maxSeq).toBe(6);
    expect(engine.getPushAck()).toBe(6);
    // Pull cursor untouched by either push.
    expect(engine.getHighWaterMark()).toBe(0);
    expect(engine.getDirtySet()).toEqual([]);
  });
});

// ---------- multi-device: push must not skip unread remote rows ----------

describe('multi-device cursor isolation', () => {
  it('neither device skips the other\'s unread rows when it pushes in the same cycle, including insert-only', async () => {
    // One shared server (shared rows + seq counter) so both devices see each
    // other's writes through the seq cursor exactly as the real vault would.
    const vault = makeStatefulVault();

    const makeDev = (prefix, local) => createDbSyncEngine({
      storageKeyPrefix: prefix,
      appId: 'test-app',
      accountId: 'acct-multi',
      deviceId: prefix,
      cryptoDBName: CRYPTO_CFG.cryptoDBName,
      vaultClient: vault,
      getLocalEntity: (id) => (local.has(id) ? local.get(id) : null),
      applyRemoteEntity: (id, e) => { local.set(id, e); },
      applyRemoteDelete: (id) => { local.delete(id); },
      isInsertOnly: (e) => !!(e && e.insertOnly),
    });

    const localA = new Map();
    const localB = new Map();
    const A = makeDev('devA', localA);
    const B = makeDev('devB', localB);

    const LM = '2026-01-01T00:00:00Z';

    // ── Phase 1: device B pushes first, so its rows take the LOW seqs (1, 2).
    // 'B-ins' is insert-only: if a peer ever skips it, it can never self-heal
    // via later LWW because insert-only rows are a pure union with no conflict.
    localB.set('B-ins',  { id: 'B-ins',  insertOnly: true, v: 'fromB', lastModified: LM });
    localB.set('B-norm', { id: 'B-norm', v: 'fromB', lastModified: LM });
    B.markDirty('B-ins');
    B.markDirty('B-norm');
    await B.pushDirtyRows();           // server seqs 1, 2
    expect(B.getHighWaterMark()).toBe(0); // push must not move B's pull cursor

    // ── Phase 2: device A's cycle. A has its own dirty rows AND two unread
    // remote rows from B (seqs 1, 2) sitting BELOW the seqs A is about to push.
    localA.set('A-ins',  { id: 'A-ins',  insertOnly: true, v: 'fromA', lastModified: LM });
    localA.set('A-norm', { id: 'A-norm', v: 'fromA', lastModified: LM });
    A.markDirty('A-ins');
    A.markDirty('A-norm');

    await A.pushDirtyRows();           // server seqs 3, 4
    // The crux: pushing must not advance A's pull cursor past B's unread rows.
    expect(A.getHighWaterMark()).toBe(0);
    await A.pullRemoteChanges();

    // A must have consumed B's rows — including the insert-only one.
    expect(localA.has('B-ins')).toBe(true);
    expect(localA.get('B-ins')).toMatchObject({ v: 'fromB', insertOnly: true });
    expect(localA.has('B-norm')).toBe(true);

    // ── Phase 3: device B's cycle. B now has a fresh dirty row plus two unread
    // remote rows from A (seqs 3, 4) sitting BELOW the seq B is about to push.
    localB.set('B-norm2', { id: 'B-norm2', v: 'fromB', lastModified: LM });
    B.markDirty('B-norm2');

    await B.pushDirtyRows();           // server seq 5
    expect(B.getHighWaterMark()).toBe(0); // still unmoved by push
    await B.pullRemoteChanges();

    // B must have consumed A's rows — including the insert-only one.
    expect(localB.has('A-ins')).toBe(true);
    expect(localB.get('A-ins')).toMatchObject({ v: 'fromA', insertOnly: true });
    expect(localB.has('A-norm')).toBe(true);

    // Each pull cursor sits at the highest seq that device has truly consumed:
    // A last pulled through seq 4; B last pulled through seq 5. The push-ack
    // markers reflect each device's own writes (A: 3,4 -> 4; B: 1,2,5 -> 5).
    expect(A.getHighWaterMark()).toBe(4);
    expect(B.getHighWaterMark()).toBe(5);
    expect(A.getPushAck()).toBe(4);
    expect(B.getPushAck()).toBe(5);
  });
});

// ---------- full cycle + transport selection ----------

describe('dbSyncCycle and transport selection', () => {
  it('runs push, pull, and device cursor in one cycle', async () => {
    const local = new Map([['a', { id: 'a', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine, vault } = makeEngine({ local });
    engine.markDirty('a');
    await engine.dbSyncCycle();
    expect(vault.calls.batch).toHaveLength(1);
    expect(vault.calls.device).toHaveLength(1);
    expect(vault.calls.device[0].lastSeenSeq).toBe(engine.getHighWaterMark());
    expect(engine.getLastSynced()).toBeTruthy();
  });

  it('createSyncEngine delegates to the DB engine when transportMode is "database"', () => {
    const engine = createSyncEngine({
      transportMode: 'database',
      storageKeyPrefix: 'sel',
      appId: 'test-app',
      accountId: 'acct-1',
      vaultClient: makeStatefulVault(),
      cryptoDBName: CRYPTO_CFG.cryptoDBName,
      getLocalEntity: () => null,
      applyRemoteEntity: () => {},
      applyRemoteDelete: () => {},
    });
    expect(engine.transportMode).toBe('database');
    expect(typeof engine.markDirty).toBe('function');
  });
});

// ---------- Part A: key verifier ----------

describe('key verifier (Part A)', () => {
  it('a fresh account writes the verifier row, marks itself verified, and never routes it to applyRemoteEntity', async () => {
    // No seeded verifier: this is a brand-new account.
    const vault = makeStatefulVault({ seedVerifier: false });
    const { engine, applied } = makeEngine({ vault });

    expect(engine.isKeyVerified()).toBe(false);
    await engine.ensureRootKey();
    expect(engine.isKeyVerified()).toBe(true);

    // The verifier row exists on the server and decrypts under our key.
    const row = vault.rows.get(KEYCHECK_ENTITY_ID);
    expect(row).toBeTruthy();
    expect(row.deleted).toBe(false);

    // A subsequent pull must skip the reserved verifier row entirely.
    await engine.pullRemoteChanges();
    expect(applied.some(a => a.id === KEYCHECK_ENTITY_ID)).toBe(false);
  });

  it('a second device with the same passphrase + salt verifies OK against the existing verifier', async () => {
    // Shared server already carries a verifier (seeded under the session key).
    const vault = makeStatefulVault();
    const { engine } = makeEngine({ vault });

    await engine.ensureRootKey();
    expect(engine.isKeyVerified()).toBe(true);
    // No new verifier write: the existing one was simply decrypted.
    expect(vault.calls.batch).toHaveLength(0);
  });

  it('a device with a different derived key gets KEY_MISMATCH and pushes nothing', async () => {
    // The shared server's verifier was written under the beforeEach key. Switch
    // the session to a DIFFERENT passphrase so the derived key no longer matches.
    const vault = makeStatefulVault();
    const local = new Map([['a', { id: 'a', lastModified: '2026-01-01T00:00:00Z' }]]);
    const errors = [];
    const { engine } = makeEngine({
      vault,
      local,
      config: { onError: (message, code) => { if (code) errors.push({ message, code }); } },
    });
    engine.markDirty('a');

    // Re-derive the root key under a mismatching passphrase (same fixed salt).
    await clearDbRootKey(CRYPTO_CFG);
    await setupDbRootKey('a-totally-different-passphrase', FIXED_SALT, CRYPTO_CFG);

    // ensureRootKey / verify throws a typed KEY_MISMATCH.
    await expect(engine.ensureRootKey()).rejects.toMatchObject({ code: 'KEY_MISMATCH' });

    // A full cycle must surface the code via onError and push NOTHING.
    await engine.dbSyncCycle();
    expect(errors.some(e => e.code === 'KEY_MISMATCH')).toBe(true);
    expect(engine.isKeyVerified()).toBe(false);
    expect(vault.calls.batch).toHaveLength(0);   // nothing uploaded under the bad key
    expect(engine.getDirtySet()).toEqual(['a']); // dirty row preserved for a correct key later
  });

  it('a server that cannot host the verifier (getRow 400) fails with VERIFIER_UNSUPPORTED and pushes nothing', async () => {
    // getRow rejects with a non-404 error, as an old GLANCEvault would for the
    // reserved id / single-row endpoint.
    const calls = { batch: [] };
    const vault = {
      calls,
      async getRow() {
        const err = new Error('get row failed: 400');
        err.code = 'VAULT_ERROR';
        err.status = 400;
        throw err;
      },
      async batch(_app, args) { calls.batch.push(args.rows); return { written: args.rows.length, maxSeq: 1 }; },
      async list() { return { rows: [], hasMore: false }; },
      async device() { return { updated: true }; },
    };

    const local = new Map([['a', { id: 'a', lastModified: '2026-01-01T00:00:00Z' }]]);
    const errors = [];
    const { engine } = makeEngine({
      vault,
      local,
      config: { onError: (message, code) => { if (code) errors.push({ message, code }); } },
    });
    engine.markDirty('a');

    // Typed, not a raw 400 — and NOT KEY_MISMATCH.
    await expect(engine.ensureRootKey()).rejects.toMatchObject({ code: 'VERIFIER_UNSUPPORTED' });

    // A full cycle surfaces it via onError and pushes NOTHING.
    await engine.dbSyncCycle();
    expect(errors.some(e => e.code === 'VERIFIER_UNSUPPORTED')).toBe(true);
    expect(errors.some(e => e.code === 'KEY_MISMATCH')).toBe(false);
    expect(engine.isKeyVerified()).toBe(false);
    expect(calls.batch).toHaveLength(0);          // never reached push
    expect(engine.getDirtySet()).toEqual(['a']);  // dirty row preserved
  });

  it('a verifier write rejected by the server also surfaces VERIFIER_UNSUPPORTED', async () => {
    // Row absent (getRow -> null) but the establishing write is rejected.
    const vault = {
      async getRow() { return null; },
      async batch() { const err = new Error('batch upsert failed: 405'); err.status = 405; throw err; },
      async list() { return { rows: [], hasMore: false }; },
      async device() { return { updated: true }; },
    };
    const { engine } = makeEngine({ vault });
    await expect(engine.ensureRootKey()).rejects.toMatchObject({ code: 'VERIFIER_UNSUPPORTED' });
    expect(engine.isKeyVerified()).toBe(false);
  });

  it('allowUnverified downgrades VERIFIER_UNSUPPORTED to a warning and proceeds', async () => {
    const calls = { batch: [] };
    const vault = {
      calls,
      async getRow() { const err = new Error('get row failed: 400'); err.status = 400; throw err; },
      async batch(_app, args) { calls.batch.push(args.rows); return { written: args.rows.length, maxSeq: 1 }; },
      async list() { return { rows: [], hasMore: false }; },
      async device() { return { updated: true }; },
    };
    const local = new Map([['a', { id: 'a', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ vault, local, config: { allowUnverified: true } });
    engine.markDirty('a');

    await engine.ensureRootKey();
    // Proceeds: marked verified despite the unsupported server, and push runs.
    expect(engine.isKeyVerified()).toBe(true);
    await engine.pushDirtyRows();
    expect(calls.batch).toHaveLength(1);
  });
});

// ---------- keycheck GET carries accountId (real HTTP client) ----------
//
// Regression for "get row failed: 400": the verifier's single-row GET must
// carry ?accountId=..., exactly like the working `list` call, and the verifier
// write must include accountId + insertOnly:true. Driven through the REAL
// createVaultClient (built from vaultUrl/fetchImpl) so the URL the client puts
// on the wire is what's asserted.
describe('keycheck request shape (real vault client)', () => {
  const makeRecordingFetch = (urls) => async (url, init) => {
    urls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.includes('/__glance_keycheck')) {
      // Mimic the server: 400 if accountId missing/empty, else 404 (new account).
      const acct = new URL(url).searchParams.get('accountId');
      if (!acct || acct.trim() === '') return { ok: false, status: 400, json: async () => ({ error: 'accountId is required' }) };
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    if (url.includes('/batch')) return { ok: true, status: 200, json: async () => ({ written: 1, maxSeq: 1 }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const makeRealEngine = (urls, accountId = 'house-1') => createDbSyncEngine({
    storageKeyPrefix: `real-${accountId}`,
    appId: 'dayglance',
    accountId,
    vaultUrl: 'https://vault.example',
    vaultToken: 'tok',
    cryptoDBName: CRYPTO_CFG.cryptoDBName, // root key already set up in beforeEach
    fetchImpl: makeRecordingFetch(urls),
    getLocalEntity: () => null,
    applyRemoteEntity: () => {},
    applyRemoteDelete: () => {},
  });

  it('the verifier GET carries ?accountId=... and returns 404 -> writes the verifier (insertOnly) without a 400', async () => {
    const urls = [];
    const engine = makeRealEngine(urls);

    await engine.ensureRootKey();
    expect(engine.isKeyVerified()).toBe(true);

    const getCall = urls.find(u => u.method === 'GET' && u.url.includes('/__glance_keycheck'));
    expect(getCall).toBeTruthy();
    // The crux: the query string carries the accountId, like the working list call.
    expect(new URL(getCall.url).searchParams.get('accountId')).toBe('house-1');

    // On 404 the verifier is written via batch with accountId + insertOnly:true.
    const batchCall = urls.find(u => u.method === 'POST' && u.url.includes('/batch'));
    expect(batchCall).toBeTruthy();
    expect(batchCall.body.accountId).toBe('house-1');
    expect(batchCall.body.rows[0]).toMatchObject({ entityId: KEYCHECK_ENTITY_ID, insertOnly: true });
  });
});

// ---------- accountId readiness (no cryptic 400) ----------

describe('accountId readiness', () => {
  it('rejects a whitespace-only accountId at construction (would serialize to ?accountId=+++ -> 400)', () => {
    expect(() => createDbSyncEngine({
      storageKeyPrefix: 'ws', appId: 'a', accountId: '   ',
      vaultUrl: 'https://v', vaultToken: 't', cryptoDBName: CRYPTO_CFG.cryptoDBName,
      getLocalEntity: () => null, applyRemoteEntity: () => {}, applyRemoteDelete: () => {},
    })).toThrow(/accountId is required/);
  });

  it('the real vault client throws a clear ACCOUNT_ID_REQUIRED instead of firing ?accountId= (no cryptic 400)', async () => {
    const { createVaultClient } = await import('../src/vaultClient.js');
    let fetched = false;
    const client = createVaultClient({
      vaultUrl: 'https://v', vaultToken: 't',
      fetchImpl: async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    await expect(client.getRow('app', KEYCHECK_ENTITY_ID, '')).rejects.toMatchObject({ code: 'ACCOUNT_ID_REQUIRED' });
    await expect(client.getRow('app', KEYCHECK_ENTITY_ID, '   ')).rejects.toMatchObject({ code: 'ACCOUNT_ID_REQUIRED' });
    expect(fetched).toBe(false); // never hit the wire with a malformed accountId
  });

  it('a verifier getRow that fails for ACCOUNT_ID_REQUIRED surfaces that code, NOT VERIFIER_UNSUPPORTED', async () => {
    const vault = {
      async getRow() { const e = new Error('get row: accountId is required'); e.code = 'ACCOUNT_ID_REQUIRED'; throw e; },
      async batch() { return { written: 1, maxSeq: 1 }; },
      async list() { return { rows: [], hasMore: false }; },
      async device() { return { updated: true }; },
    };
    const { engine } = makeEngine({ vault });
    await expect(engine.ensureRootKey()).rejects.toMatchObject({ code: 'ACCOUNT_ID_REQUIRED' });
  });
});

// ---------- Part B: per-row quarantine ----------

describe('per-row quarantine (Part B)', () => {
  const mkRow = async (entityId, entity, seq) => ({
    entityId,
    envelope: await encryptEntity(entity, entityId),
    createdAt: Date.now(),
    seq,
    deleted: false,
  });

  it('applies good rows, skips+counts+quarantines a bad row, advances the cursor, and a later cycle still progresses', async () => {
    const good1 = await mkRow('good1', { id: 'good1', lastModified: '2026-01-01T00:00:00Z' }, 1);
    // A corrupt envelope (valid base64, wrong bytes) that cannot decrypt.
    const bad = { entityId: 'bad', envelope: 'AAAAAAAAAAAAAAAAAAAAAA==', createdAt: Date.now(), seq: 2, deleted: false };
    const good2 = await mkRow('good2', { id: 'good2', lastModified: '2026-01-01T00:00:00Z' }, 3);

    let page = [good1, bad, good2];
    const vault = {
      calls: { list: [] },
      async getRow(_app, entityId) {
        if (entityId === KEYCHECK_ENTITY_ID) return { entityId, envelope: VERIFIER_ENVELOPE, seq: 0, deleted: false };
        return page.find(r => r.entityId === entityId) ?? null;
      },
      async list(_app, { since }) { this.calls.list.push(since); return { rows: page.filter(r => r.seq > since), hasMore: false }; },
      async device() { return { updated: true }; },
    };

    const skippedEvents = [];
    const { engine, local: store } = makeEngine({
      vault,
      config: { onRowsSkipped: (count, ids) => skippedEvents.push({ count, ids }) },
    });

    const result = await engine.dbSyncCycle();

    // Good rows applied, bad row skipped + counted.
    expect(store.has('good1')).toBe(true);
    expect(store.has('good2')).toBe(true);
    expect(store.has('bad')).toBe(false);
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.skippedEntityIds).toEqual(['bad']);

    // onRowsSkipped fired once with the bad id.
    expect(skippedEvents).toEqual([{ count: 1, ids: ['bad'] }]);

    // Cursor advanced PAST the bad row (to the highest listed seq), and the row
    // is persisted in quarantine.
    expect(engine.getHighWaterMark()).toBe(3);
    expect(engine.getQuarantine()).toEqual([{ entityId: 'bad', seq: 2 }]);

    // A later cycle still progresses (no wedge): the bad row stays quarantined
    // while it remains undecryptable, and nothing new is skipped.
    const second = await engine.dbSyncCycle();
    expect(second.skipped).toBe(0);
    expect(engine.getQuarantine()).toEqual([{ entityId: 'bad', seq: 2 }]);
  });

  it('self-heals a quarantined row once the correct key is in use', async () => {
    // Encrypt the row under key A (a different passphrase), so it cannot decrypt
    // under the current session key (B). It is fetchable by id for self-heal.
    await clearDbRootKey(CRYPTO_CFG);
    await setupDbRootKey('key-A', FIXED_SALT, CRYPTO_CFG);
    const underA = await encryptEntity({ id: 'roamer', lastModified: '2026-01-01T00:00:00Z', v: 'A' }, 'roamer');

    // Switch to key B and re-seed the verifier under B so verification passes.
    await clearDbRootKey(CRYPTO_CFG);
    await setupDbRootKey('key-B', FIXED_SALT, CRYPTO_CFG);
    const verifierB = await encryptEntity(KEYCHECK_PAYLOAD, KEYCHECK_ENTITY_ID);

    const rowEnvelope = { value: underA };
    const vault = {
      async getRow(_app, entityId) {
        if (entityId === KEYCHECK_ENTITY_ID) return { entityId, envelope: verifierB, seq: 0, deleted: false };
        if (entityId === 'roamer') return { entityId, envelope: rowEnvelope.value, seq: 1, deleted: false };
        return null;
      },
      async list(_app, { since }) {
        const rows = [{ entityId: 'roamer', envelope: rowEnvelope.value, createdAt: 0, seq: 1, deleted: false }];
        return { rows: rows.filter(r => r.seq > since), hasMore: false };
      },
      async device() { return { updated: true }; },
    };

    const { engine, local: store } = makeEngine({ vault });

    // Cycle 1: row is encrypted under A, fails to decrypt under B -> quarantined.
    const first = await engine.dbSyncCycle();
    expect(first.skipped).toBe(1);
    expect(store.has('roamer')).toBe(false);
    expect(engine.getQuarantine()).toEqual([{ entityId: 'roamer', seq: 1 }]);

    // The correct key (A) becomes available: re-encrypt the SAME row under B's
    // session... actually simulate recovery by serving a version the current key
    // can read. Re-encrypt the payload under the now-current key.
    rowEnvelope.value = await encryptEntity({ id: 'roamer', lastModified: '2026-01-01T00:00:00Z', v: 'A' }, 'roamer');

    // Cycle 2: self-heal re-fetches the quarantined id, decrypts, applies, and
    // drops it from quarantine.
    const second = await engine.dbSyncCycle();
    expect(store.get('roamer')).toMatchObject({ id: 'roamer', v: 'A' });
    expect(engine.getQuarantine()).toEqual([]);
    expect(second.applied).toBeGreaterThanOrEqual(1);
  });
});

// ---------- #2 salt registration (real vault) ----------

const VAULT_URL = process.env.VAULT_URL;
const VAULT_TOKEN = process.env.VAULT_TOKEN || 'test-token';

describe.skipIf(!VAULT_URL)('salt registration (real vault)', () => {
  it('first device registers a salt; a second device retrieves the same salt and derives the same root key', async () => {
    const { createVaultClient } = await import('../src/vaultClient.js');
    const accountId = `acct-salt-${Date.now()}`;
    const client = createVaultClient({ vaultUrl: VAULT_URL, vaultToken: VAULT_TOKEN });

    // Device A: no salt yet -> generate and register.
    let saltA = await client.getSalt(accountId);
    expect(saltA).toBeNull();
    const fresh = crypto.getRandomValues(new Uint8Array(16));
    saltA = await client.putSalt(accountId, fresh);
    expect(saltA).toBeInstanceOf(Uint8Array);

    // Device B: fetches the same salt.
    const saltB = await client.getSalt(accountId);
    expect(Array.from(saltB)).toEqual(Array.from(saltA));

    // Same passphrase + same salt must encrypt/decrypt interchangeably.
    await clearDbRootKey({ cryptoDBName: 'salt-test-A' });
    await setupDbRootKey('shared-pass', saltA, { cryptoDBName: 'salt-test-A' });
    const ciphertext = await encryptEntity({ shared: true }, 'e1');

    await clearDbRootKey({ cryptoDBName: 'salt-test-B' });
    await setupDbRootKey('shared-pass', saltB, { cryptoDBName: 'salt-test-B' });
    expect(await decryptEntity(ciphertext, 'e1')).toEqual({ shared: true });
  });
});

// ---------- credential-rejected halt (vault Phase 1.4b) ----------
//
// A 401 "invalid credential" from a per-account server must stop the retry
// loop: persist a halt, surface CREDENTIAL_INVALID with isHardStop true, make
// no further network calls, survive engine recreation, and NEVER enroll.

describe('credential-rejected halt', () => {
  const makeCredRejectingFetch = (requests) => async (url, init) => {
    requests.push({ url, init });
    return { ok: false, status: 401, json: async () => ({ error: 'invalid credential' }) };
  };

  const makeHaltEngine = (requests, onError) => createDbSyncEngine({
    storageKeyPrefix: 'halt-test',
    appId: 'test-app',
    accountId: 'acct-1',
    deviceId: 'device-1',
    cryptoDBName: CRYPTO_CFG.cryptoDBName, // root key set up in beforeEach
    vaultUrl: 'https://vault.example',
    vaultToken: 'gvc_dead',
    fetchImpl: makeCredRejectingFetch(requests),
    getLocalEntity: () => null,
    applyRemoteEntity: () => {},
    applyRemoteDelete: () => {},
    onError,
  });

  it('halts on 401 invalid credential: hard-stop surfaced, persisted, no further requests, no enrollment', async () => {
    const requests = [];
    const errors = [];
    const engine = makeHaltEngine(requests, (msg, code, isHardStop) => errors.push({ msg, code, isHardStop }));

    await engine.sync();
    expect(errors.pop()).toMatchObject({ code: 'CREDENTIAL_INVALID', isHardStop: true });
    expect(engine.isCredentialHalted()).toBe(true);
    expect(engine.getCredentialHalt()).toMatchObject({ at: expect.any(String) });
    const requestsAfterFirstCycle = requests.length;
    expect(requestsAfterFirstCycle).toBeGreaterThan(0);

    // Further cycles: zero network traffic, state re-surfaced each attempt.
    await engine.sync();
    await engine.sync();
    expect(requests.length).toBe(requestsAfterFirstCycle);
    expect(errors.pop()).toMatchObject({ code: 'CREDENTIAL_INVALID', isHardStop: true });

    // Nothing ever tried to enroll (the invariant 2.1 revocation depends on).
    expect(requests.some(r => r.url.includes('/enroll'))).toBe(false);
  });

  it('the halt survives engine recreation (persisted, not in-memory)', async () => {
    const requests = [];
    await makeHaltEngine(requests, () => {}).sync();
    const requestsAfterFirstCycle = requests.length;

    const relaunched = makeHaltEngine(requests, () => {});
    expect(relaunched.isCredentialHalted()).toBe(true);
    await relaunched.sync();
    expect(requests.length).toBe(requestsAfterFirstCycle);
  });

  it('a shared-mode 401 ("invalid device token") does NOT halt — ordinary retryable error', async () => {
    const requests = [];
    const errors = [];
    const engine = createDbSyncEngine({
      storageKeyPrefix: 'no-halt-test',
      appId: 'test-app',
      accountId: 'acct-1',
      deviceId: 'device-1',
      cryptoDBName: CRYPTO_CFG.cryptoDBName,
      vaultUrl: 'https://vault.example',
      vaultToken: 'wrong-shared-token',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: false, status: 401, json: async () => ({ error: 'invalid device token' }) };
      },
      getLocalEntity: () => null,
      applyRemoteEntity: () => {},
      applyRemoteDelete: () => {},
      onError: (msg, code, isHardStop) => errors.push({ msg, code, isHardStop }),
    });

    await engine.sync();
    // Pre-existing shared-mode behavior, unchanged by 1.4b: a verifier-path
    // 401 surfaces as VERIFIER_UNSUPPORTED (any getRow error does). What
    // matters here is what it is NOT: not CREDENTIAL_INVALID, not a hard
    // stop, not a halt.
    const surfaced = errors.pop();
    expect(surfaced.code).not.toBe('CREDENTIAL_INVALID');
    expect(surfaced.isHardStop).toBe(false);
    expect(engine.isCredentialHalted()).toBe(false);

    // The retry is now DELAYED rather than immediate: a shared-mode 401 opens
    // the auth backoff window (a wrong token does not fix itself in 30s, and
    // hammering an auth endpoint is the worst kind of noise). The assertion
    // this test exists for is unchanged — this is a delay, never a stop:
    const before = requests.length;
    await engine.sync();
    expect(requests.length).toBe(before); // backed off, not retried immediately
    const { push } = engine.getBackoffState();
    expect(push.reason).toBe('auth');
    expect(push.until).toBeGreaterThan(Date.now());
    expect(engine.isCredentialHalted()).toBe(false); // still not terminal

    // ...and it self-resumes once the window elapses, with no user action.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(push.until + 1000));
    try {
      await engine.sync();
      expect(requests.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- package-owned deviceId in the engine ----------

describe('device cursor without an explicit deviceId', () => {
  it('generates and uses a persisted deviceId — the cursor updates instead of silently no-oping', async () => {
    const vault = makeStatefulVault();
    const engine = createDbSyncEngine({
      storageKeyPrefix: 'autodev-test',
      appId: 'test-app',
      accountId: 'acct-1',
      // deviceId deliberately omitted — pre-1.4b this meant {updated:false} forever
      cryptoDBName: CRYPTO_CFG.cryptoDBName,
      vaultClient: vault,
      getLocalEntity: () => null,
      applyRemoteEntity: () => {},
      applyRemoteDelete: () => {},
    });

    await engine.sync();
    expect(vault.calls.device.length).toBe(1);
    const sent = vault.calls.device[0].deviceId;
    expect(sent).toBe(localStorage.getItem('autodev-test-device-id'));
    expect(engine.deviceId).toBe(sent);

    // Stable across engine instances.
    const again = createDbSyncEngine({
      storageKeyPrefix: 'autodev-test',
      appId: 'test-app',
      accountId: 'acct-1',
      cryptoDBName: CRYPTO_CFG.cryptoDBName,
      vaultClient: vault,
      getLocalEntity: () => null,
      applyRemoteEntity: () => {},
      applyRemoteDelete: () => {},
    });
    expect(again.deviceId).toBe(sent);
  });
});

// ---------- halt-set identity rule (Phase 2.2) ----------
//
// The halt key is shared by every engine instance on the device. The rule
// FAILS TOWARD HALTING: halt when the stored credential record is missing or
// unreadable, or when it matches this engine's bearer. Skip the halt ONLY
// when a readable record holds a DIFFERENT credential — definitive proof
// this instance was superseded by recovery — in which case the instance goes
// inert in memory without touching the shared halt key.

describe('halt-set identity rule', () => {
  const DEAD = 'gvc_' + 'de'.repeat(32);
  const NEW_CRED = 'gvc_' + 'ff'.repeat(32);

  const makeEngine22 = (prefix, requests, errors, bearer = DEAD) => createDbSyncEngine({
    storageKeyPrefix: prefix,
    appId: 'test-app',
    accountId: 'acct-1',
    deviceId: 'device-1',
    cryptoDBName: CRYPTO_CFG.cryptoDBName,
    vaultUrl: 'https://vault.example',
    vaultToken: bearer,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: false, status: 401, json: async () => ({ error: 'invalid credential' }) };
    },
    getLocalEntity: () => null,
    applyRemoteEntity: () => {},
    applyRemoteDelete: () => {},
    onError: (msg, code, isHardStop) => errors.push({ msg, code, isHardStop }),
  });

  const seedRecord = (prefix, credential) => localStorage.setItem(`${prefix}-vault-credential`, JSON.stringify({
    credentialId: 'c1', credential, accountId: 'acct-1', deviceId: 'device-1',
    vaultUrl: 'https://vault.example', createdAt: 'x',
  }));

  it('record MATCHES the bearer -> halt is set (the device really holds a dead credential)', async () => {
    seedRecord('idr-match', DEAD);
    const engine = makeEngine22('idr-match', [], []);
    await engine.sync();
    expect(engine.isCredentialHalted()).toBe(true);
    expect(engine.isSuperseded()).toBe(false);
  });

  it('record MISSING -> halt is set (fail toward halting, never retry forever)', async () => {
    const engine = makeEngine22('idr-missing', [], []);
    await engine.sync();
    expect(engine.isCredentialHalted()).toBe(true);
  });

  it('record UNREADABLE -> halt is set (fail toward halting)', async () => {
    localStorage.setItem('idr-garbage-vault-credential', 'not json {');
    const engine = makeEngine22('idr-garbage', [], []);
    await engine.sync();
    expect(engine.isCredentialHalted()).toBe(true);
  });

  it('record DIFFERS -> no halt: the superseded instance goes inert in memory, surfaced once', async () => {
    seedRecord('idr-super', NEW_CRED); // recovery already replaced the record
    const requests = [];
    const errors = [];
    const stale = makeEngine22('idr-super', requests, errors, DEAD);

    await stale.sync();
    // Surfaced once as a hard stop, but the SHARED halt key is untouched.
    expect(errors.filter(e => e.code === 'CREDENTIAL_INVALID')).toHaveLength(1);
    expect(errors.pop()).toMatchObject({ code: 'CREDENTIAL_INVALID', isHardStop: true });
    expect(stale.isSuperseded()).toBe(true);
    expect(stale.isCredentialHalted()).toBe(false);
    expect(localStorage.getItem('idr-super-db-sync-credential-halt')).toBeNull();

    // Inert: further cycles produce zero requests and zero further onError.
    const afterFirst = requests.length;
    const errCount = errors.length;
    await stale.sync();
    await stale.sync();
    expect(requests.length).toBe(afterFirst);
    expect(errors.length).toBe(errCount);

    // A fresh engine on the same prefix (the recovered one) is unaffected:
    // not halted, not inert, requests flow.
    const okVault = makeStatefulVault();
    const recovered = createDbSyncEngine({
      storageKeyPrefix: 'idr-super',
      appId: 'test-app',
      accountId: 'acct-1',
      deviceId: 'device-1',
      cryptoDBName: CRYPTO_CFG.cryptoDBName,
      vaultClient: okVault,
      getLocalEntity: () => null,
      applyRemoteEntity: () => {},
      applyRemoteDelete: () => {},
    });
    expect(recovered.isCredentialHalted()).toBe(false);
    expect(recovered.isSuperseded()).toBe(false);
    await recovered.sync();
    expect(okVault.calls.list.length).toBeGreaterThan(0);
  });
});

// ---------- Phase 3.3: partial function + over-quota handling ----------
//
// Two defects fixed here. (1) A failed push used to throw straight past the
// pull, so a device whose writes were blocked also stopped RECEIVING other
// devices' changes — true for ANY push failure, not just quota. (2) A quota
// rejection must never halt: it clears when the operator acts, with no client
// action, so the engine backs off in a bounded, self-resuming window instead.

describe('a failed push no longer costs the pull', () => {
  const quotaError = () => {
    const e = new Error('batch upsert failed: 413 — rows quota exceeded (100 of 100, requested 1)');
    e.code = 'QUOTA_EXCEEDED';
    e.status = 413;
    e.quota = { quota: 'rows', limit: 100, used: 100, requested: 1 };
    return e;
  };
  const transportError = () => {
    const e = new Error('batch upsert failed: 503');
    e.code = 'VAULT_ERROR';
    e.status = 503;
    return e;
  };

  // A vault whose batch always rejects, but whose list still serves a row.
  const makeRejectingVault = (makeError) => {
    const base = makeStatefulVault();
    return {
      ...base,
      calls: base.calls,
      rows: base.rows,
      async batch(app, args) {
        // The verifier's establishing write (seeded) never runs here; only
        // the push reaches batch in these tests.
        base.calls.batch.push(args.rows);
        throw makeError();
      },
    };
  };

  const seedRemoteRow = async (vault, entityId, entity, seq) => {
    vault.rows.set(entityId, {
      entityId, envelope: await encryptEntity(entity, entityId),
      createdAt: Date.now(), seq, deleted: false,
    });
  };

  it.each([
    ['a QUOTA_EXCEEDED push failure', quotaError, 'QUOTA_EXCEEDED'],
    ['a generic transport push failure', transportError, 'VAULT_ERROR'],
  ])('%s still pulls, applies rows, and reports the cursor', async (_label, makeError, expectedCode) => {
    const vault = makeRejectingVault(makeError);
    await seedRemoteRow(vault, 'from-peer', { id: 'from-peer', lastModified: '2026-01-01T00:00:00Z' }, 7);

    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine, applied } = makeEngine({
      vault, local, config: { storageKeyPrefix: `pf-${expectedCode}` },
    });
    engine.markDirty('mine');

    const result = await engine.sync();

    // The push was attempted and failed...
    expect(vault.calls.batch.length).toBeGreaterThan(0);
    expect(result.pushFailed).toBe(true);
    expect(result.pushErrorCode).toBe(expectedCode);
    // ...but the pull ran anyway and applied the peer's row.
    expect(result.applied).toBe(1);
    expect(applied.map(a => a.id)).toContain('from-peer');
    // ...and the device cursor still reported.
    expect(vault.calls.device.length).toBe(1);
    // The dirty row is retained for the next cycle (unchanged behavior).
    expect(engine.getDirtySet()).toContain('mine');
    // Never a halt, in either case.
    expect(engine.isCredentialHalted()).toBe(false);
  });

  it('does not claim lastSynced when the push did not land', async () => {
    const vault = makeRejectingVault(transportError);
    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ vault, local, config: { storageKeyPrefix: 'pf-lastsynced' } });
    engine.markDirty('mine');

    await engine.sync();
    expect(engine.getLastSynced()).toBeNull();
  });

  it('a fully successful cycle is unchanged: no push flags, lastSynced set', async () => {
    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ local, config: { storageKeyPrefix: 'pf-ok' } });
    engine.markDirty('mine');

    const result = await engine.sync();
    expect(result.pushFailed).toBeUndefined();
    expect(result.pushSkipped).toBeUndefined();
    expect(engine.getLastSynced()).not.toBeNull();
    expect(engine.getQuotaState()).toBeNull();
  });
});

describe('over-quota: surfaced, suppressed, self-resuming, never halting', () => {
  const makeQuotaVault = (rejectRef) => {
    const base = makeStatefulVault();
    return {
      ...base, calls: base.calls, rows: base.rows,
      async batch(app, args) {
        base.calls.batch.push(args.rows);
        if (rejectRef.value) {
          const e = new Error('batch upsert failed: 413 — rows quota exceeded (100 of 100, requested 1)');
          e.code = 'QUOTA_EXCEEDED';
          e.quota = { quota: 'rows', limit: 100, used: 100, requested: 1 };
          throw e;
        }
        return { written: args.rows.length, maxSeq: 1 };
      },
    };
  };

  it('surfaces QUOTA_EXCEEDED as a NON-hard-stop with the descriptor, and never halts', async () => {
    const rejectRef = { value: true };
    const vault = makeQuotaVault(rejectRef);
    const errors = [];
    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({
      vault, local,
      config: { storageKeyPrefix: 'q-surface', onError: (m, c, h) => errors.push({ m, c, h }) },
    });
    engine.markDirty('mine');

    await engine.sync();

    expect(errors.pop()).toMatchObject({ c: 'QUOTA_EXCEEDED', h: false });
    expect(engine.isCredentialHalted()).toBe(false);
    expect(localStorage.getItem('q-surface-db-sync-credential-halt')).toBeNull();
    expect(engine.getQuotaState()).toMatchObject({
      quota: 'rows', limit: 100, used: 100, requested: 1,
      since: expect.any(String), retryAt: expect.any(String),
    });
  });

  it('does not hammer: one write attempt, then the window suppresses further pushes while pulls continue', async () => {
    const rejectRef = { value: true };
    const vault = makeQuotaVault(rejectRef);
    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ vault, local, config: { storageKeyPrefix: 'q-suppress' } });
    engine.markDirty('mine');

    await engine.sync();
    const attemptsAfterFirst = vault.calls.batch.length;
    expect(attemptsAfterFirst).toBe(1);
    expect(engine.isQuotaSuppressed()).toBe(true);

    // Five more cycles inside the window: ZERO further write attempts...
    for (let i = 0; i < 5; i += 1) await engine.sync();
    expect(vault.calls.batch.length).toBe(attemptsAfterFirst);
    // ...but the pull and cursor kept running every time (partial function).
    expect(vault.calls.list.length).toBe(6);
    expect(vault.calls.device.length).toBe(6);

    const suppressed = await engine.sync();
    expect(suppressed.pushSkipped).toBe(true);
    expect(suppressed.quota).toMatchObject({ quota: 'rows' });
  });

  it('resumes on its own when the window expires — no client action, no restart', async () => {
    const rejectRef = { value: true };
    const vault = makeQuotaVault(rejectRef);
    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ vault, local, config: { storageKeyPrefix: 'q-resume' } });
    engine.markDirty('mine');

    await engine.sync();
    expect(engine.isQuotaSuppressed()).toBe(true);

    // The operator raises the limit; the client is told nothing.
    rejectRef.value = false;
    // Simulate the window elapsing (the engine probes on its ordinary cycle).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 31_000));
    try {
      const result = await engine.sync();
      expect(result.pushFailed).toBeUndefined();
      expect(result.pushSkipped).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    // State cleared by the write that got through — nothing was cleared by hand.
    expect(engine.getQuotaState()).toBeNull();
    expect(engine.isQuotaSuppressed()).toBe(false);
    expect(engine.getDirtySet()).toEqual([]);
  });
});

describe('the key verifier reports a quota rejection truthfully', () => {
  it('a 413 while establishing the keycheck row surfaces QUOTA_EXCEEDED, NOT VERIFIER_UNSUPPORTED', async () => {
    // Fresh account: the verifier row is absent, so verifyAccountKey tries to
    // establish it — a net-new entity, which is exactly what a row cap
    // rejects. Before the pass-through addition this surfaced as
    // "Your GLANCEvault server needs to be updated", sending the user to fix
    // a server that is working correctly.
    const vault = {
      ...makeStatefulVault({ seedVerifier: false }),
      async getRow() { return null; },
      async batch() {
        const e = new Error('batch upsert failed: 413 — rows quota exceeded (100 of 100, requested 1)');
        e.code = 'QUOTA_EXCEEDED';
        e.quota = { quota: 'rows', limit: 100, used: 100, requested: 1 };
        throw e;
      },
    };
    const errors = [];
    const { engine } = makeEngine({
      vault,
      config: { storageKeyPrefix: 'q-verifier', onError: (m, c, h) => errors.push({ m, c, h }) },
    });

    await engine.sync();

    const surfaced = errors.pop();
    expect(surfaced.c).toBe('QUOTA_EXCEEDED');
    expect(surfaced.c).not.toBe('VERIFIER_UNSUPPORTED');
    expect(surfaced.m).not.toMatch(/needs to be updated/);
    expect(surfaced.h).toBe(false);
    expect(engine.isCredentialHalted()).toBe(false);
    expect(engine.getQuotaState()).toMatchObject({ quota: 'rows' });
  });
});

// ---------- the backoff ladder ----------
//
// One windowing mechanism for every recoverable failure, carrying a reason.
// The file tier's numbers and reset rule, but ENFORCED by the engine (the
// file tier's is advisory, which is why the hammering was live).

describe('backoff: escalation, enforcement and reset', () => {
  const mkErr = (code, status, extra = {}) => {
    const e = new Error(`failed: ${status || code}`);
    e.code = code;
    if (status) e.status = status;
    return Object.assign(e, extra);
  };

  // A vault whose batch and/or list fail on demand, counting every call.
  const makeFlakyVault = ({ pushFails = false, pullFails = false, error = () => mkErr('VAULT_ERROR', 503) } = {}) => {
    const base = makeStatefulVault();
    const state = { pushFails, pullFails };
    return {
      ...base, calls: base.calls, rows: base.rows, state,
      async batch(app, args) {
        base.calls.batch.push(args.rows);
        if (state.pushFails) throw error();
        return { written: args.rows.length, maxSeq: 1 };
      },
      async list(app, args) {
        base.calls.list.push(args.since);
        if (state.pullFails) throw error();
        return { rows: [], hasMore: false };
      },
    };
  };

  const engineWith = (vault, prefix, errors = []) => {
    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({
      vault, local,
      config: { storageKeyPrefix: prefix, onError: (m, c, h) => errors.push({ m, c, h }) },
    });
    return { engine, local };
  };

  it('a persistent push failure backs off instead of retrying every cycle, and escalates 30s -> 60s -> 120s', async () => {
    const vault = makeFlakyVault({ pushFails: true });
    const { engine } = engineWith(vault, 'bo-push');
    engine.markDirty('mine');

    await engine.sync();
    expect(vault.calls.batch.length).toBe(1);
    const first = engine.getBackoffState().push;
    expect(first.reason).toBe('transport');
    expect(first.strikes).toBe(1);
    expect(first.until - Date.now()).toBeGreaterThan(25_000);
    expect(first.until - Date.now()).toBeLessThanOrEqual(30_000);

    // Inside the window: no further write attempts at all.
    for (let i = 0; i < 4; i += 1) await engine.sync();
    expect(vault.calls.batch.length).toBe(1);

    // Each expiry probes once and doubles: 30s -> 60s -> 120s.
    const seen = [];
    for (const expected of [60_000, 120_000]) {
      const { push } = engine.getBackoffState();
      vi.useFakeTimers();
      vi.setSystemTime(new Date(push.until + 1000));
      try {
        await engine.sync();
        const next = engine.getBackoffState().push;
        seen.push(next.until - Date.now());
        expect(next.until - Date.now()).toBeLessThanOrEqual(expected);
        expect(next.until - Date.now()).toBeGreaterThan(expected / 2);
      } finally {
        vi.useRealTimers();
      }
    }
    expect(vault.calls.batch.length).toBe(3); // one probe per expiry, never per cycle
    expect(engine.getBackoffState().push.strikes).toBe(3);
  });

  it('the pull and the cursor report keep running while the push is backed off', async () => {
    const vault = makeFlakyVault({ pushFails: true });
    const { engine } = engineWith(vault, 'bo-pushonly');
    engine.markDirty('mine');

    await engine.sync();
    for (let i = 0; i < 3; i += 1) await engine.sync();

    expect(vault.calls.batch.length).toBe(1);   // suppressed
    expect(vault.calls.list.length).toBe(4);    // every cycle
    expect(vault.calls.device.length).toBe(4);  // every cycle
    expect(engine.getBackoffState().pull.until).toBe(0); // pull window untouched
  });

  it('a persistent PULL failure backs off too, and the cursor still reports on the failing cycle', async () => {
    const vault = makeFlakyVault({ pullFails: true });
    const { engine } = engineWith(vault, 'bo-pull');

    const result = await engine.sync();
    expect(result.pullFailed).toBe(true);
    expect(vault.calls.list.length).toBe(1);
    expect(vault.calls.device.length).toBe(1); // attempted pull -> cursor still ran
    const { pull } = engine.getBackoffState();
    expect(pull.reason).toBe('transport');
    expect(pull.until).toBeGreaterThan(Date.now());

    // Inside the window the pull is skipped — and so is the cursor, because
    // firing a write at a server we are backing off from is the hammering
    // this fix removes.
    for (let i = 0; i < 3; i += 1) await engine.sync();
    expect(vault.calls.list.length).toBe(1);
    expect(vault.calls.device.length).toBe(1);
  });

  it('the pull cap is 5 minutes and the push cap is 15 (the file tier\'s numbers)', async () => {
    const vault = makeFlakyVault({ pushFails: true, pullFails: true });
    const { engine } = engineWith(vault, 'bo-caps');
    engine.markDirty('mine');

    // Drive both windows well past their caps. Stay inside fake time for the
    // assertions: the `until` values are computed against the fake clock, so
    // comparing them to a restored real clock would be meaningless.
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 12; i += 1) {
        const { push, pull } = engine.getBackoffState();
        vi.setSystemTime(new Date(Math.max(push.until, pull.until) + 1000));
        await engine.sync();
      }
      const { push, pull } = engine.getBackoffState();
      expect(push.until - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
      expect(push.until - Date.now()).toBeGreaterThan(14 * 60 * 1000);
      expect(pull.until - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
      expect(pull.until - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a shared-mode 401 gets the flat one-hour auth window, distinguishable by reason', async () => {
    const vault = makeFlakyVault({ pushFails: true, error: () => mkErr('VAULT_ERROR', 401) });
    const { engine } = engineWith(vault, 'bo-auth');
    engine.markDirty('mine');

    await engine.sync();
    const { push } = engine.getBackoffState();
    expect(push.reason).toBe('auth');
    expect(push.until - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(push.until - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    // A consumer can tell it apart from a transport window WITHOUT inferring
    // from the magnitude of the timestamp.
    expect(engine.getUploadBackoffUntil()).toBe(push.until);
  });

  it('recovery is automatic: a success resets the window and its strike count', async () => {
    const vault = makeFlakyVault({ pushFails: true });
    const { engine } = engineWith(vault, 'bo-recover');
    engine.markDirty('mine');

    await engine.sync();
    await engine.sync();
    expect(engine.getBackoffState().push.strikes).toBe(1);
    expect(engine.getDirtySet()).toContain('mine'); // dirty rows survive

    vault.state.pushFails = false; // the underlying problem goes away
    const { push } = engine.getBackoffState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(push.until + 1000));
    try {
      const result = await engine.sync();
      expect(result.pushFailed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(engine.getBackoffState().push).toMatchObject({ until: 0, strikes: 0, reason: null });
    expect(engine.getUploadBackoffUntil()).toBe(0);
    expect(engine.getDirtySet()).toEqual([]); // the row finally landed, nothing lost
  });

  it('a healthy client opens no window and is untouched by any of this', async () => {
    const vault = makeFlakyVault();
    const { engine } = engineWith(vault, 'bo-healthy');
    engine.markDirty('mine');

    const result = await engine.sync();
    expect(result.pushFailed).toBeUndefined();
    expect(result.pullFailed).toBeUndefined();
    expect(result.pushSkipped).toBeUndefined();
    expect(result.pullSkipped).toBeUndefined();
    expect(engine.getUploadBackoffUntil()).toBe(0);
    expect(engine.getDownloadBackoffUntil()).toBe(0);
    expect(engine.getBackoffState()).toMatchObject({
      push: { until: 0, strikes: 0, reason: null },
      pull: { until: 0, strikes: 0, reason: null },
    });
    expect(engine.getLastSynced()).not.toBeNull();
  });
});

describe('backoff: the classes that must NOT be delayed', () => {
  const mkErr = (code, status) => {
    const e = new Error(`failed: ${code}`);
    e.code = code;
    if (status) e.status = status;
    return e;
  };

  it.each(['PASSPHRASE_REQUIRED', 'ACCOUNT_ID_REQUIRED'])(
    '%s retries IMMEDIATELY — no window, so supplying the value works on the very next cycle',
    async (code) => {
      const base = makeStatefulVault();
      let fail = true;
      const vault = {
        ...base, calls: base.calls, rows: base.rows,
        async batch(app, args) {
          base.calls.batch.push(args.rows);
          if (fail) throw mkErr(code);
          return { written: args.rows.length, maxSeq: 1 };
        },
      };
      const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
      const { engine } = makeEngine({ vault, local, config: { storageKeyPrefix: `imm-${code}` } });
      engine.markDirty('mine');

      await engine.sync();
      expect(engine.getBackoffState().push).toMatchObject({ until: 0, strikes: 0, reason: null });

      // The app supplies the missing value; the very next cycle proceeds with
      // no waiting at all.
      fail = false;
      const result = await engine.sync();
      expect(result.pushFailed).toBeUndefined();
      expect(vault.calls.batch.length).toBe(2);
    });

  it('CREDENTIAL_INVALID halts and opens NO window (no double-delay on a terminal state)', async () => {
    const requests = [];
    const engine = createDbSyncEngine({
      storageKeyPrefix: 'no-double-cred',
      appId: 'test-app', accountId: 'acct-1', deviceId: 'device-1',
      cryptoDBName: CRYPTO_CFG.cryptoDBName,
      vaultUrl: 'https://vault.example', vaultToken: 'gvc_dead',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: false, status: 401, json: async () => ({ error: 'invalid credential' }) };
      },
      getLocalEntity: () => null, applyRemoteEntity: () => {}, applyRemoteDelete: () => {},
    });

    await engine.sync();
    expect(engine.isCredentialHalted()).toBe(true);
    expect(engine.getBackoffState()).toMatchObject({
      push: { until: 0, reason: null },
      pull: { until: 0, reason: null },
    });
  });

  it('QUOTA_EXCEEDED opens ONE window (its own), not a quota window plus a transport window', async () => {
    const base = makeStatefulVault();
    const vault = {
      ...base, calls: base.calls, rows: base.rows,
      async batch(app, args) {
        base.calls.batch.push(args.rows);
        const e = new Error('batch upsert failed: 413 — rows quota exceeded (100 of 100, requested 1)');
        e.code = 'QUOTA_EXCEEDED';
        e.status = 413;
        e.quota = { quota: 'rows', limit: 100, used: 100, requested: 1 };
        throw e;
      },
    };
    const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ vault, local, config: { storageKeyPrefix: 'no-double-quota' } });
    engine.markDirty('mine');

    await engine.sync();
    const { push, pull } = engine.getBackoffState();
    expect(push.reason).toBe('quota');
    expect(push.strikes).toBe(1);              // ONE strike, not two
    expect(pull.until).toBe(0);                // the pull is not delayed by a push-side quota
    // 3.3's surface is preserved exactly.
    expect(engine.isQuotaSuppressed()).toBe(true);
    expect(engine.getQuotaState()).toMatchObject({ quota: 'rows', limit: 100, used: 100, requested: 1 });
  });

  it('a quota window keeps surfacing its descriptor each cycle; a transport window goes quiet', async () => {
    const mk = (code, extra) => {
      const base = makeStatefulVault();
      const errors = [];
      const vault = {
        ...base, calls: base.calls, rows: base.rows,
        async batch(app, args) {
          base.calls.batch.push(args.rows);
          const e = new Error(`failed: ${code}`);
          e.code = code;
          Object.assign(e, extra || {});
          throw e;
        },
      };
      const local = new Map([['mine', { id: 'mine', lastModified: '2026-01-01T00:00:00Z' }]]);
      const { engine } = makeEngine({
        vault, local,
        config: { storageKeyPrefix: `surf-${code}`, onError: (m, c, h) => { if (c) errors.push({ m, c, h }); } },
      });
      engine.markDirty('mine');
      return { engine, errors };
    };

    const quota = mk('QUOTA_EXCEEDED', { status: 413, quota: { quota: 'rows', limit: 1, used: 1, requested: 1 } });
    await quota.engine.sync();
    const afterFirstQuota = quota.errors.length;
    await quota.engine.sync();
    await quota.engine.sync();
    expect(quota.errors.length).toBe(afterFirstQuota + 2); // keeps speaking
    expect(quota.errors.pop().c).toBe('QUOTA_EXCEEDED');

    const transport = mk('VAULT_ERROR', { status: 503 });
    await transport.engine.sync();
    const afterFirstTransport = transport.errors.length;
    await transport.engine.sync();
    await transport.engine.sync();
    expect(transport.errors.length).toBe(afterFirstTransport); // quiet after one signal
  });
});

describe('backoff: the pull cursor advances per page', () => {
  it('a failure on a later page keeps the progress of the pages already applied', async () => {
    // Three pages; the third throws. Before the per-page advance, the cursor
    // stayed at 0 and pages 1-2 were re-downloaded forever on a flaky link.
    const mk = async (entityId, seq) => ({
      entityId, envelope: await encryptEntity({ id: entityId, lastModified: '2026-01-01T00:00:00Z' }, entityId),
      createdAt: Date.now(), seq, deleted: false,
    });
    const pages = [
      [await mk('p1a', 1), await mk('p1b', 2)],
      [await mk('p2a', 3), await mk('p2b', 4)],
    ];
    let call = 0;
    const vault = {
      calls: { list: [], device: [] },
      async list(app, { since }) {
        this.calls.list.push(since);
        call += 1;
        if (call === 1) return { rows: pages[0], hasMore: true };
        if (call === 2) return { rows: pages[1], hasMore: true };
        throw Object.assign(new Error('failed: 503'), { code: 'VAULT_ERROR', status: 503 });
      },
      async device(app, args) { this.calls.device.push(args); return { updated: true }; },
      async getSalt() { return FIXED_SALT; },
      async putSalt(_a, s) { return s; },
      async getRow() { return null; },
      async batch() { return { written: 1, maxSeq: 1 }; },
    };

    const { engine, local } = makeEngine({ vault, config: { storageKeyPrefix: 'pagecursor' } });
    const result = await engine.sync();

    expect(result.pullFailed).toBe(true);
    // Four rows from two complete pages were applied and their cursor kept.
    expect(local.size).toBe(4);
    expect(engine.getHighWaterMark()).toBe(4);

    // The next attempt resumes from 4 rather than re-listing from 0.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(engine.getBackoffState().pull.until + 1000));
    try {
      await engine.sync();
    } finally {
      vi.useRealTimers();
    }
    expect(vault.calls.list[vault.calls.list.length - 1]).toBe(4);
  });
});
