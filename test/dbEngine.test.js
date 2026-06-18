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
} = await import('../src/dbCrypto.js');

const CRYPTO_CFG = { cryptoDBName: 'glance-db-engine-test' };
const FIXED_SALT = new Uint8Array(16).fill(5);

// ---------- Mock vault ----------

const makeStatefulVault = () => {
  const rows = new Map(); // entityId -> { entityId, envelope, createdAt, seq, deleted }
  let seq = 0;
  const calls = { batch: [], list: [], deleteRow: [], device: [] };
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
    async deleteRow(app, entityId) {
      calls.deleteRow.push(entityId);
      seq += 1;
      rows.set(entityId, { entityId, seq, deleted: true });
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

    // Server keyed rows by entityId: still exactly 3 rows, no duplicates.
    expect(vault.rows.size).toBe(3);
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
