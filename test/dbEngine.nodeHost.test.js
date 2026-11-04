// The vault engine with no browser storage at all (2.4.0, krelltunez/dayGLANCE#2280).
//
// A Node host (dayGLANCE's planned MCP vault host) has neither localStorage
// nor IndexedDB. It injects `storage` for the sync bookkeeping and supplies
// the root key through nativeGetSyncKey / nativeStoreSyncKey. These tests run
// the real engine, connect flow and per-entity crypto with BOTH globals
// replaced by traps that record any access and answer `undefined`, so a code
// path that still reaches for either is caught even where the package
// swallows the error (initDbRootKey and clearDbRootKey catch storage
// failures, which would otherwise hide a stray IndexedDB call).
//
// The last block checks the other side: with no `storage` passed, the engine
// writes to globalThis.localStorage exactly as it did before the option.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { createDbSyncEngine, getOrCreateDeviceId, credentialHaltKey } = await import('../src/dbEngine.js');
const { connectVaultSyncEngine, recoverVaultSyncEngine } = await import('../src/vaultConnect.js');
const {
  setupDbRootKey,
  initDbRootKey,
  clearDbRootKey,
  hasDbRootKey,
  encryptEntity,
  KEYCHECK_ENTITY_ID,
} = await import('../src/dbCrypto.js');
const { setSyncPassphrase } = await import('../src/crypto.js');

const PREFIX = 'nodehost';
const FIXED_SALT = new Uint8Array(16).fill(9);

// ---------- the traps ----------

const TRAPPED = ['localStorage', 'indexedDB'];
const saved = {};
const touched = [];

const installTraps = () => {
  for (const name of TRAPPED) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { touched.push(name); return undefined; },
      set() { touched.push(`${name}=`); },
    });
  }
};
const removeTraps = () => {
  for (const name of TRAPPED) {
    delete globalThis[name];
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
  }
};

// ---------- injected storage and native key hooks ----------

// A Map-backed store that logs every operation in order, so tests can assert
// both where the bookkeeping landed and the sequence it was written in.
const makeMapStorage = () => {
  const map = new Map();
  const ops = [];
  return {
    map,
    ops,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { ops.push(['set', k]); map.set(k, String(v)); },
    removeItem: (k) => { ops.push(['remove', k]); map.delete(k); },
  };
};

// The native shells' key hooks, as a Node host would implement them: the
// root-key record is a base64 string kept wherever the host keeps secrets.
const makeKeyHooks = () => {
  const box = { value: null, stores: 0 };
  return {
    box,
    nativeGetSyncKey: async () => box.value,
    nativeStoreSyncKey: (v) => { box.stores += 1; box.value = v; },
  };
};

// ---------- a stateful in-memory vault (same shape as dbEngine.test.js) ----------

const makeVault = () => {
  const rows = new Map();
  let seq = 0;
  let salt = null;
  const calls = { batch: [], list: [], device: [], getRow: [], salt: [] };
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
      const out = [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      return { rows: out, hasMore: false };
    },
    async getRow(app, entityId) {
      calls.getRow.push(entityId);
      return rows.get(entityId) ?? null;
    },
    async deleteRow(app, entityId) {
      seq += 1;
      rows.set(entityId, { entityId, seq, deleted: true });
      return { seq };
    },
    async device(app, args) {
      calls.device.push(args);
      return { updated: true };
    },
    async getSalt() { calls.salt.push('get'); return salt; },
    async putSalt(_a, s) { calls.salt.push('put'); if (!salt) salt = s; return salt; },
    // Another device writing a row under the same account key.
    async remoteWrite(entityId, entity) {
      seq += 1;
      rows.set(entityId, { entityId, envelope: await encryptEntity(entity, entityId), createdAt: 0, seq, deleted: false });
      return seq;
    },
  };
};

const makeEngine = ({ storage, hooks, vault, local = new Map(), config = {} } = {}) => {
  const applied = [];
  const engine = createDbSyncEngine({
    storageKeyPrefix: PREFIX,
    appId: 'node-host',
    accountId: 'acct-1',
    cryptoDBName: 'unused-under-native-hooks',
    nativeGetSyncKey: hooks.nativeGetSyncKey,
    nativeStoreSyncKey: hooks.nativeStoreSyncKey,
    vaultClient: vault,
    getLocalEntity: (id) => (local.has(id) ? local.get(id) : null),
    applyRemoteEntity: (id, entity) => { local.set(id, entity); applied.push(id); },
    applyRemoteDelete: (id) => { local.delete(id); },
    ...(storage ? { storage } : {}),
    ...config,
  });
  return { engine, applied, local };
};

const keys = (suffixes) => suffixes.map((s) => `${PREFIX}-${s}`);

// ═══════════════════ no localStorage, no IndexedDB ═══════════════════

describe('vault engine under Node: injected storage + native key hooks', () => {
  beforeAll(installTraps);
  afterAll(removeTraps);

  let hooks;
  beforeEach(async () => {
    hooks = makeKeyHooks();
    await clearDbRootKey({ nativeGetSyncKey: hooks.nativeGetSyncKey, nativeStoreSyncKey: hooks.nativeStoreSyncKey });
    setSyncPassphrase(null);
    touched.length = 0;
  });

  it('the traps are live: neither global is reachable', () => {
    expect(globalThis.localStorage).toBeUndefined();
    expect(globalThis.indexedDB).toBeUndefined();
    expect(touched).toEqual(['localStorage', 'indexedDB']);
    touched.length = 0;
  });

  it('runs a push and a pull, with every key in the injected storage under the same names', async () => {
    const storage = makeMapStorage();
    const vault = makeVault();
    const local = new Map([['a', { id: 'a', lastModified: '2026-11-01T00:00:00Z' }]]);
    setSyncPassphrase('node-host-pass');
    const { engine, applied } = makeEngine({ storage, hooks, vault, local });

    // Device id minted into the injected store at construction.
    expect(engine.deviceId).toBe(storage.map.get(`${PREFIX}-device-id`));

    // markDirty is synchronous and lands in the store before anything else.
    engine.markDirty('a');
    expect(JSON.parse(storage.map.get(`${PREFIX}-db-sync-dirty`))).toEqual(['a']);

    // Cycle 1 (push): derives the root key from the passphrase + registered
    // salt, stores it through the native hook, establishes the verifier,
    // pushes 'a'.
    await engine.dbSyncCycle();
    expect(hooks.box.value).toBeTruthy();
    expect(vault.calls.salt).toEqual(['get', 'put']);
    expect(vault.rows.has(KEYCHECK_ENTITY_ID)).toBe(true);
    expect(vault.rows.has('a')).toBe(true);
    expect(storage.map.has(`${PREFIX}-db-sync-dirty`)).toBe(false);
    expect(Number(storage.map.get(`${PREFIX}-db-sync-push-ack`))).toBe(vault.rows.get('a').seq);
    expect(storage.map.get(`${PREFIX}-db-sync-last-synced`)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const hwmAfterPush = Number(storage.map.get(`${PREFIX}-db-sync-hwm`));
    expect(hwmAfterPush).toBe(vault.rows.get('a').seq);

    // Cycle 2 (pull): another device wrote 'b'.
    const bSeq = await vault.remoteWrite('b', { id: 'b', lastModified: '2026-11-02T00:00:00Z' });
    await engine.dbSyncCycle();
    expect(applied).toContain('b');
    expect(local.get('b')).toEqual({ id: 'b', lastModified: '2026-11-02T00:00:00Z' });
    expect(Number(storage.map.get(`${PREFIX}-db-sync-hwm`))).toBe(bSeq);
    expect(vault.calls.device.at(-1)).toMatchObject({ deviceId: engine.deviceId });

    // Engine accessors read the injected store.
    engine.setConfig({ enabled: true });
    expect(storage.map.get(`${PREFIX}-db-sync-config`)).toBe('{"enabled":true}');
    expect(engine.getConfig()).toEqual({ enabled: true });
    expect(engine.getHighWaterMark()).toBe(bSeq);
    expect(engine.getLastSynced()).toBe(storage.map.get(`${PREFIX}-db-sync-last-synced`));

    // Only the engine's own keys, nothing else.
    expect([...storage.map.keys()].sort()).toEqual(keys([
      'db-sync-config', 'db-sync-hwm', 'db-sync-last-synced', 'db-sync-push-ack', 'device-id',
    ]).sort());
    expect(touched).toEqual([]);
  });

  it('quarantine and the credential halt live in the injected storage', async () => {
    const storage = makeMapStorage();
    const vault = makeVault();
    setSyncPassphrase('node-host-pass');
    const { engine } = makeEngine({ storage, hooks, vault });
    await engine.dbSyncCycle(); // establish key + verifier

    // A row that does not decrypt under this key is quarantined.
    vault.rows.set('junk', { entityId: 'junk', envelope: btoa('x'.repeat(40)), seq: 99, deleted: false });
    await engine.dbSyncCycle();
    expect(JSON.parse(storage.map.get(`${PREFIX}-db-sync-quarantine`))).toEqual([{ entityId: 'junk', seq: 99 }]);
    expect(engine.getQuarantine()).toEqual([{ entityId: 'junk', seq: 99 }]);

    // A halt written to the injected store is what the engine sees.
    expect(engine.isCredentialHalted()).toBe(false);
    storage.setItem(credentialHaltKey(PREFIX), JSON.stringify({ message: 'rejected', at: 'now' }));
    expect(engine.isCredentialHalted()).toBe(true);
    const result = await engine.dbSyncCycle();
    expect(result.halted).toBe(true);
    expect(touched).toEqual([]);
  });

  it('a 401 "invalid credential" sets the halt in the injected storage, and the superseded check reads it there', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = makeMapStorage();
    const vault = makeVault();
    setSyncPassphrase('node-host-pass');
    await setupDbRootKey('node-host-pass', FIXED_SALT, hooks);
    vault.getRow = async () => {
      const err = new Error('get row failed: 401 invalid credential');
      err.status = 401;
      err.code = 'CREDENTIAL_INVALID';
      throw err;
    };
    // Bearer matches the stored record: not superseded, so the device halts.
    storage.setItem(`${PREFIX}-vault-credential`, JSON.stringify({ credential: 'gvc_live' }));
    const { engine } = makeEngine({ storage, hooks, vault, config: { vaultToken: 'gvc_live' } });
    const result = await engine.dbSyncCycle();
    expect(result.halted).toBe(true);
    expect(JSON.parse(storage.map.get(credentialHaltKey(PREFIX))).message).toMatch(/401/);

    // A record holding a DIFFERENT credential means this bearer was replaced:
    // the stale instance goes inert instead of re-halting.
    storage.removeItem(credentialHaltKey(PREFIX));
    storage.setItem(`${PREFIX}-vault-credential`, JSON.stringify({ credential: 'gvc_newer' }));
    const { engine: stale } = makeEngine({ storage, hooks, vault, config: { vaultToken: 'gvc_live' } });
    const r2 = await stale.dbSyncCycle();
    expect(r2.superseded).toBe(true);
    expect(storage.map.has(credentialHaltKey(PREFIX))).toBe(false);
    expect(touched).toEqual([]);
    quiet.mockRestore();
  });

  it('setup, init and clear of the root key go through the hooks only', async () => {
    const opts = { cryptoDBName: 'unused', ...hooks };
    await setupDbRootKey('pw', FIXED_SALT, opts);
    expect(hasDbRootKey()).toBe(true);
    const record = hooks.box.value;
    expect(typeof record).toBe('string');

    await clearDbRootKey(opts);
    expect(hasDbRootKey()).toBe(false);
    expect(hooks.box.value).toBeNull();

    // A restart: the host hands back the record it kept.
    hooks.box.value = record;
    expect(await initDbRootKey(opts)).toBe(true);
    expect(hasDbRootKey()).toBe(true);

    // Nothing stored: init reports setup is needed, still without IndexedDB.
    await clearDbRootKey(opts);
    expect(await initDbRootKey(opts)).toBe(false);
    expect(touched).toEqual([]);
  });

  it('re-derives from the passphrase at start when the host keeps no key', async () => {
    const storage = makeMapStorage();
    const vault = makeVault();
    const noKeep = { nativeGetSyncKey: async () => null, nativeStoreSyncKey: () => {} };
    setSyncPassphrase('node-host-pass');
    const { engine } = makeEngine({ storage, hooks: noKeep, vault });
    await engine.dbSyncCycle();
    expect(engine.isKeyVerified()).toBe(true);
    expect(touched).toEqual([]);
  });

  it('getOrCreateDeviceId takes the store as its trailing argument', () => {
    const storage = makeMapStorage();
    const id = getOrCreateDeviceId(PREFIX, storage);
    expect(storage.map.get(`${PREFIX}-device-id`)).toBe(id);
    expect(getOrCreateDeviceId(PREFIX, storage)).toBe(id);
    expect(touched).toEqual([]);
  });

  it('connect and recover keep the device id and credential in the injected storage', async () => {
    const storage = makeMapStorage();
    let enrolls = 0;
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/healthz')) return { ok: true, status: 200, json: async () => ({ authMode: 'per-account' }) };
      if (url.endsWith('/enroll')) {
        enrolls += 1;
        const sent = JSON.parse(init.body);
        return {
          ok: true, status: 201,
          json: async () => ({
            credentialId: `cred-${enrolls}`, credential: `gvc_${enrolls}`,
            accountId: sent.accountId, deviceId: sent.deviceId, createdAt: '2026-11-04T00:00:00Z',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], hasMore: false }) };
    };
    const cfg = {
      storageKeyPrefix: PREFIX, appId: 'node-host', accountId: 'acct-1', cryptoDBName: 'unused',
      vaultUrl: 'https://vault.example', fetchImpl, storage, ...hooks,
      getLocalEntity: () => null, applyRemoteEntity: () => {}, applyRemoteDelete: () => {},
    };

    const { engine, enrolled, deviceId } = await connectVaultSyncEngine({ ...cfg, enrollmentSecret: 's' });
    expect(enrolled).toBe(true);
    expect(storage.map.get(`${PREFIX}-device-id`)).toBe(deviceId);
    expect(JSON.parse(storage.map.get(`${PREFIX}-vault-credential`))).toMatchObject({ credential: 'gvc_1', deviceId });
    expect(engine.deviceId).toBe(deviceId);

    // Not halted in the injected store: recovery refuses.
    await expect(recoverVaultSyncEngine({ ...cfg, enrollmentSecret: 's' })).rejects.toMatchObject({ code: 'NOT_HALTED' });

    // Halted: recovery rotates the credential and clears the halt, both there.
    storage.setItem(credentialHaltKey(PREFIX), JSON.stringify({ message: 'x', at: 'now' }));
    const rec = await recoverVaultSyncEngine({ ...cfg, enrollmentSecret: 's' });
    expect(rec.deviceId).toBe(deviceId);
    expect(JSON.parse(storage.map.get(`${PREFIX}-vault-credential`)).credential).toBe('gvc_2');
    expect(storage.map.has(credentialHaltKey(PREFIX))).toBe(false);
    expect(touched).toEqual([]);
  });

  it('refuses a store without the three methods, and a store that answers with a Promise', () => {
    expect(() => makeEngine({ storage: { getItem: () => null }, hooks, vault: makeVault() }))
      .toThrow(/storage must implement getItem, setItem and removeItem/);

    const asyncStore = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    };
    expect(() => makeEngine({ storage: asyncStore, hooks, vault: makeVault() }))
      .toThrow(/storage\.getItem returned a Promise/);
    expect(() => getOrCreateDeviceId(PREFIX, { ...asyncStore, getItem: () => 'id' })).not.toThrow();
    expect(() => getOrCreateDeviceId(PREFIX, { ...asyncStore, getItem: () => null }))
      .toThrow(/storage\.setItem returned a Promise/);
  });
});

// ═══════════════════ the default: globalThis.localStorage ═══════════════════

describe('default storage (no `storage` passed) is globalThis.localStorage, as before', () => {
  let shim;
  let prior;
  beforeAll(() => {
    prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  });
  beforeEach(async () => {
    shim = makeMapStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: shim });
    setSyncPassphrase(null);
  });
  afterAll(() => {
    delete globalThis.localStorage;
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior);
  });

  // The same scripted push + pull against a given store; returns its op log
  // with the run-dependent values (device id, timestamps) left out, since the
  // log records keys only.
  const scripted = async (storage) => {
    const hooks = makeKeyHooks();
    await clearDbRootKey(hooks);
    await setupDbRootKey('pw', FIXED_SALT, hooks);
    const vault = makeVault();
    await vault.putSalt('acct-1', FIXED_SALT);
    const local = new Map([['a', { id: 'a', lastModified: '2026-11-01T00:00:00Z' }]]);
    const { engine } = makeEngine({ storage, hooks, vault, local });
    engine.markDirty('a');
    await engine.dbSyncCycle();
    await vault.remoteWrite('b', { id: 'b', lastModified: '2026-11-02T00:00:00Z' });
    await engine.dbSyncCycle();
    engine.setConfig({ on: 1 });
    engine.setConfig(null);
    return engine;
  };

  it('writes the same keys, in the same order, to localStorage as an injected store receives', async () => {
    const engineA = await scripted(undefined);
    const defaultOps = shim.ops.slice();
    const defaultKeys = [...shim.map.keys()].sort();
    expect(engineA.deviceId).toBe(shim.map.get(`${PREFIX}-device-id`));

    const injected = makeMapStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: makeMapStorage() });
    await scripted(injected);

    expect(defaultOps.length).toBeGreaterThan(0);
    expect(injected.ops).toEqual(defaultOps);
    expect([...injected.map.keys()].sort()).toEqual(defaultKeys);
    expect(defaultKeys).toEqual(keys([
      'db-sync-hwm', 'db-sync-last-synced', 'db-sync-push-ack', 'device-id',
    ]).sort());
    // The injected run never touched the global.
    expect(globalThis.localStorage.ops).toEqual([]);
  });

  it('looks localStorage up at each call, so a replaced global is the one written to', () => {
    const hooks = makeKeyHooks();
    const { engine } = makeEngine({ hooks, vault: makeVault() });
    const later = makeMapStorage();
    globalThis.localStorage = later;
    engine.markDirty('x');
    expect(later.map.get(`${PREFIX}-db-sync-dirty`)).toBe('["x"]');
    expect(shim.map.has(`${PREFIX}-db-sync-dirty`)).toBe(false);
  });

  it('getOrCreateDeviceId with no store uses localStorage', () => {
    const id = getOrCreateDeviceId('default-prefix');
    expect(shim.map.get('default-prefix-device-id')).toBe(id);
  });
});
