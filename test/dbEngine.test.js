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
import { describe, it, expect, beforeEach } from 'vitest';

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
