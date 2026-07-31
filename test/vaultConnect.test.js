// Tests for the packaged vault connect flow (vault Phase 1.4b): auth-mode
// discovery, branch, enrollment, durable credential persistence, bootstrap-
// secret discard, and the no-automatic-re-enrollment invariant. The halt
// behavior of a rejected credential mid-cycle lives in dbEngine.test.js
// (it needs the crypto scaffolding); this file covers the connect flow.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

// Minimal in-memory localStorage shim (same pattern as dbEngine.test.js), with
// a write recorder so tests can assert what never touches storage.
const __store = new Map();
const __writes = []; // setItem entries plus removeItem markers, in order — lets tests prove operation ordering
globalThis.localStorage = {
  getItem:    (k) => (__store.has(k) ? __store.get(k) : null),
  setItem:    (k, v) => { __writes.push({ key: k, value: String(v) }); __store.set(k, String(v)); },
  removeItem: (k) => { __writes.push({ key: k, value: '', removed: true }); __store.delete(k); },
  clear:      () => { __store.clear(); },
  key:        (i) => Array.from(__store.keys())[i] ?? null,
  get length() { return __store.size; },
};

const { connectVaultSyncEngine, recoverVaultSyncEngine } = await import('../src/vaultConnect.js');
const { getOrCreateDeviceId } = await import('../src/dbEngine.js');

const SECRET = 'the-bootstrap-secret';
const CREDENTIAL = 'gvc_' + 'ab'.repeat(32);

// A configurable fake vault server: routes /healthz and /enroll, answers
// everything else ok, and records every request.
const makeServer = ({ authMode = 'per-account', healthzStatus = 200, omitAuthMode = false, enrollStatus = 201 } = {}) => {
  const requests = [];
  let enrollCount = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/healthz')) {
      if (healthzStatus !== 200) return { ok: false, status: healthzStatus, json: async () => ({}) };
      const body = { status: 'ok', version: '0.1.0', schemaVersion: 5 };
      if (!omitAuthMode) body.authMode = authMode;
      return { ok: true, status: 200, json: async () => body };
    }
    if (url.endsWith('/enroll')) {
      enrollCount += 1;
      if (enrollStatus !== 201) return { ok: false, status: enrollStatus, json: async () => ({ error: 'invalid enrollment secret' }) };
      const sent = JSON.parse(init.body);
      return {
        ok: true, status: 201,
        json: async () => ({
          credentialId: `cred-${enrollCount}`,
          credential: enrollCount === 1 ? CREDENTIAL : `gvc_${'cd'.repeat(32)}`,
          accountId: sent.accountId,
          deviceId: sent.deviceId,
          createdAt: '2026-07-31T00:00:00.000Z',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ rows: [], hasMore: false }) };
  };
  return { requests, fetchImpl, enrollCalls: () => requests.filter(r => r.url.endsWith('/enroll')).length };
};

const baseConfig = (server, overrides = {}) => ({
  storageKeyPrefix: 'connect-test',
  appId: 'test-app',
  accountId: 'acct-1',
  cryptoDBName: 'connect-test-crypto',
  vaultUrl: 'https://vault.example',
  fetchImpl: server.fetchImpl,
  getLocalEntity: () => null,
  applyRemoteEntity: () => {},
  applyRemoteDelete: () => {},
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  __writes.length = 0;
});

describe('shared mode (the default path, unchanged behavior)', () => {
  it('uses the provided vaultToken, never enrolls, persists no credential', async () => {
    const server = makeServer({ authMode: 'shared' });
    const { engine, authMode, enrolled } = await connectVaultSyncEngine(
      baseConfig(server, { vaultToken: 'shared-tok' }));

    expect(authMode).toBe('shared');
    expect(enrolled).toBe(false);
    expect(server.enrollCalls()).toBe(0);
    expect(localStorage.getItem('connect-test-vault-credential')).toBeNull();

    await engine.vault.list('test-app', { accountId: 'acct-1', since: 0 });
    const listed = server.requests.find(r => r.url.includes('/list'));
    expect(listed.init.headers.Authorization).toBe('Bearer shared-tok');
  });

  it('without a vaultToken -> VAULT_TOKEN_REQUIRED', async () => {
    const server = makeServer({ authMode: 'shared' });
    await expect(connectVaultSyncEngine(baseConfig(server)))
      .rejects.toMatchObject({ code: 'VAULT_TOKEN_REQUIRED' });
  });

  it('a stored credential from a past per-account life is NOT sent to a shared-mode server', async () => {
    localStorage.setItem('connect-test-vault-credential', JSON.stringify({
      credentialId: 'old', credential: CREDENTIAL, accountId: 'acct-1',
      deviceId: 'd', vaultUrl: 'https://vault.example', createdAt: 'x',
    }));
    const server = makeServer({ authMode: 'shared' });
    const { engine } = await connectVaultSyncEngine(baseConfig(server, { vaultToken: 'shared-tok' }));

    await engine.vault.list('test-app', { accountId: 'acct-1', since: 0 });
    const listed = server.requests.find(r => r.url.includes('/list'));
    expect(listed.init.headers.Authorization).toBe('Bearer shared-tok');
    // ...but the credential is kept in storage for a switch back.
    expect(localStorage.getItem('connect-test-vault-credential')).not.toBeNull();
  });
});

describe('per-account mode: first contact enrolls', () => {
  it('enrolls, persists the credential durably, and the engine speaks it as Bearer', async () => {
    const server = makeServer();
    const { engine, authMode, enrolled, deviceId } = await connectVaultSyncEngine(
      baseConfig(server, { enrollmentSecret: SECRET }));

    expect(authMode).toBe('per-account');
    expect(enrolled).toBe(true);
    expect(server.enrollCalls()).toBe(1);

    const stored = JSON.parse(localStorage.getItem('connect-test-vault-credential'));
    expect(stored).toMatchObject({
      credential: CREDENTIAL, accountId: 'acct-1', vaultUrl: 'https://vault.example', deviceId,
    });

    await engine.vault.list('test-app', { accountId: 'acct-1', since: 0 });
    const listed = server.requests.find(r => r.url.includes('/list'));
    expect(listed.init.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('discovery happens before any authenticated request', async () => {
    const server = makeServer();
    await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));
    expect(server.requests[0].url).toBe('https://vault.example/healthz');
    expect(server.requests[0].init.headers.Authorization).toBeUndefined();
  });

  it('the bootstrap secret never touches storage and never rides a URL', async () => {
    const server = makeServer();
    await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));

    // Every storage write, key and value, over the whole flow:
    for (const w of __writes) {
      expect(w.key).not.toContain(SECRET);
      expect(w.value).not.toContain(SECRET);
    }
    // Every request URL:
    for (const r of server.requests) {
      expect(r.url).not.toContain(SECRET);
    }
    // The one place it may appear: the enroll request body.
    const enroll = server.requests.find(r => r.url.endsWith('/enroll'));
    expect(JSON.parse(enroll.init.body).enrollmentSecret).toBe(SECRET);
  });

  it('no stored credential and no secret -> ENROLLMENT_SECRET_REQUIRED, nothing minted', async () => {
    const server = makeServer();
    await expect(connectVaultSyncEngine(baseConfig(server, { vaultToken: 'shared-tok' })))
      .rejects.toMatchObject({ code: 'ENROLLMENT_SECRET_REQUIRED' });
    // The shared token is NOT a fallback against a per-account server:
    expect(server.enrollCalls()).toBe(0);
    expect(server.requests.every(r => !r.init.headers?.Authorization)).toBe(true);
  });

  it('a rejected secret propagates ENROLLMENT_REJECTED and persists nothing', async () => {
    const server = makeServer({ enrollStatus: 401 });
    await expect(connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: 'wrong' })))
      .rejects.toMatchObject({ code: 'ENROLLMENT_REJECTED' });
    expect(localStorage.getItem('connect-test-vault-credential')).toBeNull();
  });

  it('broken credential storage fails BEFORE enrolling (no orphan row per launch)', async () => {
    const server = makeServer();
    const realSetItem = localStorage.setItem;
    localStorage.setItem = (k, v) => {
      if (k === 'connect-test-vault-credential') throw new Error('quota');
      realSetItem(k, v);
    };
    try {
      await expect(connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET })))
        .rejects.toMatchObject({ code: 'CREDENTIAL_PERSIST_FAILED' });
      expect(server.enrollCalls()).toBe(0);
    } finally {
      localStorage.setItem = realSetItem;
    }
  });
});

describe('per-account mode: stored credential wins, no re-enrollment', () => {
  it('a second connect reuses the stored credential and never re-enrolls, even with a secret supplied', async () => {
    const server = makeServer();
    const first = await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));
    expect(first.enrolled).toBe(true);

    const second = await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));
    expect(second.enrolled).toBe(false);
    expect(server.enrollCalls()).toBe(1);

    await second.engine.vault.list('test-app', { accountId: 'acct-1', since: 0 });
    const listed = server.requests.filter(r => r.url.includes('/list')).pop();
    expect(listed.init.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('a stored credential for a DIFFERENT account is not used (byte-exact match) — fresh enrollment instead', async () => {
    localStorage.setItem('connect-test-vault-credential', JSON.stringify({
      credentialId: 'other', credential: 'gvc_other', accountId: 'acct-1 ',
      deviceId: 'd', vaultUrl: 'https://vault.example', createdAt: 'x',
    }));
    const server = makeServer();
    const { enrolled } = await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));
    expect(enrolled).toBe(true);
    expect(server.enrollCalls()).toBe(1);
  });

  it('a trailing-slash vaultUrl still matches the stored credential (client-identical normalization)', async () => {
    const server = makeServer();
    await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));
    const again = await connectVaultSyncEngine(
      baseConfig(server, { vaultUrl: 'https://vault.example/', enrollmentSecret: SECRET }));
    expect(again.enrolled).toBe(false);
    expect(server.enrollCalls()).toBe(1);
  });
});

describe('version skew and discovery failure', () => {
  it('a /healthz without authMode (pre-1.4a server) is ordinary shared mode', async () => {
    const server = makeServer({ omitAuthMode: true });
    const { authMode, enrolled } = await connectVaultSyncEngine(
      baseConfig(server, { vaultToken: 'shared-tok' }));
    expect(authMode).toBe('shared');
    expect(enrolled).toBe(false);
    expect(server.enrollCalls()).toBe(0);
  });

  it('an unknown future mode string falls back to last known state rather than guessing', async () => {
    const server = makeServer({ authMode: 'per-galaxy' });
    const { authMode } = await connectVaultSyncEngine(
      baseConfig(server, { vaultToken: 'shared-tok' }));
    expect(authMode).toBeNull(); // reported as unknown, engine still built from vaultToken
  });

  it('unreachable /healthz + stored credential -> proceeds per-account on the stored credential', async () => {
    const server = makeServer();
    await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));

    const offline = makeServer({ healthzStatus: 503 });
    const { engine, authMode, enrolled } = await connectVaultSyncEngine(baseConfig(offline));
    expect(authMode).toBeNull();
    expect(enrolled).toBe(false);
    await engine.vault.list('test-app', { accountId: 'acct-1', since: 0 });
    const listed = offline.requests.find(r => r.url.includes('/list'));
    expect(listed.init.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('unreachable /healthz + vaultToken -> proceeds exactly as pre-1.4b (existing installs keep working)', async () => {
    const server = makeServer({ healthzStatus: 503 });
    const { engine, authMode } = await connectVaultSyncEngine(
      baseConfig(server, { vaultToken: 'shared-tok' }));
    expect(authMode).toBeNull();
    await engine.vault.list('test-app', { accountId: 'acct-1', since: 0 });
    const listed = server.requests.find(r => r.url.includes('/list'));
    expect(listed.init.headers.Authorization).toBe('Bearer shared-tok');
  });

  it('unreachable /healthz with nothing to fall back on -> VAULT_UNREACHABLE', async () => {
    const server = makeServer({ healthzStatus: 503 });
    await expect(connectVaultSyncEngine(baseConfig(server)))
      .rejects.toMatchObject({ code: 'VAULT_UNREACHABLE' });
  });
});

describe('deviceId ownership', () => {
  it('generates once, persists under {prefix}-device-id, and reuses it', () => {
    const a = getOrCreateDeviceId('devid-test');
    const b = getOrCreateDeviceId('devid-test');
    expect(a).toBe(b);
    expect(localStorage.getItem('devid-test-device-id')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(getOrCreateDeviceId('other-prefix')).not.toBe(a);
  });

  it('the enrollment carries the package-owned deviceId', async () => {
    const server = makeServer();
    const { deviceId } = await connectVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));
    const enroll = server.requests.find(r => r.url.endsWith('/enroll'));
    expect(JSON.parse(enroll.init.body).deviceId).toBe(deviceId);
    expect(localStorage.getItem('connect-test-device-id')).toBe(deviceId);
  });

  it('an explicit config.deviceId wins over the generated one', async () => {
    const server = makeServer();
    const { deviceId } = await connectVaultSyncEngine(
      baseConfig(server, { enrollmentSecret: SECRET, deviceId: 'my-own-id' }));
    expect(deviceId).toBe('my-own-id');
    const enroll = server.requests.find(r => r.url.endsWith('/enroll'));
    expect(JSON.parse(enroll.init.body).deviceId).toBe('my-own-id');
  });
});

// ═══════════════════════════ Phase 2.2: recovery ═══════════════════════════

const HALT_KEY = 'connect-test-db-sync-credential-halt';
const CRED_KEY = 'connect-test-vault-credential';

const seedHalt = () =>
  localStorage.setItem(HALT_KEY, JSON.stringify({ message: 'get salt failed: 401', at: '2026-07-31T00:00:00Z' }));

const seedStaleRecord = (overrides = {}) => {
  const rec = {
    credentialId: 'stale-cred-id',
    credential: 'gvc_' + 'aa'.repeat(32),
    accountId: 'acct-1',
    deviceId: 'dev-real',
    vaultUrl: 'https://vault.example',
    createdAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
  localStorage.setItem(CRED_KEY, JSON.stringify(rec));
  return rec;
};

describe('recovery: the halt gate is structural', () => {
  it('refuses when the device is not halted (NOT_HALTED), touching nothing', async () => {
    const server = makeServer();
    seedStaleRecord();
    await expect(recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET })))
      .rejects.toMatchObject({ code: 'NOT_HALTED' });
    expect(server.requests).toHaveLength(0);
    expect(server.enrollCalls()).toBe(0);
  });

  it('refuses without a freshly supplied secret (the package holds none)', async () => {
    const server = makeServer();
    seedHalt();
    seedStaleRecord();
    await expect(recoverVaultSyncEngine(baseConfig(server)))
      .rejects.toMatchObject({ code: 'ENROLLMENT_SECRET_REQUIRED' });
    expect(server.requests).toHaveLength(0);
    expect(localStorage.getItem(HALT_KEY)).not.toBeNull();
  });
});

describe('recovery: mode guard (shared mode is structurally unreachable)', () => {
  it('a shared-mode server -> RECOVERY_UNSUPPORTED; halt and stale record untouched, nothing enrolled', async () => {
    const server = makeServer({ authMode: 'shared' });
    seedHalt();
    const stale = seedStaleRecord();
    await expect(recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET })))
      .rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
    expect(server.enrollCalls()).toBe(0);
    expect(localStorage.getItem(HALT_KEY)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(CRED_KEY))).toEqual(stale);
  });

  it('unreachable /healthz -> VAULT_UNREACHABLE (recovery NEVER falls back); device stays halted', async () => {
    const server = makeServer({ healthzStatus: 503 });
    seedHalt();
    seedStaleRecord();
    await expect(recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET })))
      .rejects.toMatchObject({ code: 'VAULT_UNREACHABLE' });
    expect(server.enrollCalls()).toBe(0);
    expect(localStorage.getItem(HALT_KEY)).not.toBeNull();
  });
});

describe('recovery: the successful path', () => {
  it('enrolls under the stale record\'s deviceId, replaces the record, clears the halt LAST, returns a fresh engine', async () => {
    const server = makeServer();
    seedHalt();
    const stale = seedStaleRecord();
    __writes.length = 0;

    const { engine, authMode, enrolled, deviceId } = await recoverVaultSyncEngine(
      baseConfig(server, { enrollmentSecret: SECRET }));

    expect(authMode).toBe('per-account');
    expect(enrolled).toBe(true);
    // Rotation identity: the record's deviceId, not the generated one.
    expect(deviceId).toBe('dev-real');
    const enroll = server.requests.find(r => r.url.endsWith('/enroll'));
    expect(JSON.parse(enroll.init.body).deviceId).toBe('dev-real');

    // The stale credential did not survive: single slot, replaced.
    const newRec = JSON.parse(localStorage.getItem(CRED_KEY));
    expect(newRec.credential).toBe(CREDENTIAL);
    expect(newRec.credential).not.toBe(stale.credential);

    // Halt cleared, and cleared LAST: after the new record's persist write.
    expect(localStorage.getItem(HALT_KEY)).toBeNull();
    const persistIdx = __writes.findIndex(w => !w.removed && w.key === CRED_KEY && w.value.includes(CREDENTIAL));
    const haltClearIdx = __writes.findIndex(w => w.removed && w.key === HALT_KEY);
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(haltClearIdx).toBeGreaterThan(persistIdx);

    // The fresh engine speaks the NEW credential.
    await engine.vault.list('test-app', { accountId: 'acct-1', since: 0 });
    const listed = server.requests.filter(r => r.url.includes('/list')).pop();
    expect(listed.init.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('the bootstrap secret never touches storage during recovery and never rides a URL', async () => {
    const server = makeServer();
    seedHalt();
    seedStaleRecord();
    __writes.length = 0;

    await recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));

    for (const w of __writes) {
      expect(w.key).not.toContain(SECRET);
      expect(w.value).not.toContain(SECRET);
    }
    for (const r of server.requests) {
      expect(r.url).not.toContain(SECRET);
    }
    const enroll = server.requests.find(r => r.url.endsWith('/enroll'));
    expect(JSON.parse(enroll.init.body).enrollmentSecret).toBe(SECRET);
  });
});

describe('recovery: failure at each step leaves the device halted, never ambiguous', () => {
  it('wrong secret -> ENROLLMENT_REJECTED; halt intact, stale record byte-identical', async () => {
    const server = makeServer({ enrollStatus: 401 });
    seedHalt();
    const stale = seedStaleRecord();
    const rawBefore = localStorage.getItem(CRED_KEY);

    await expect(recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: 'wrong' })))
      .rejects.toMatchObject({ code: 'ENROLLMENT_REJECTED' });
    expect(localStorage.getItem(HALT_KEY)).not.toBeNull();
    expect(localStorage.getItem(CRED_KEY)).toBe(rawBefore);
    expect(JSON.parse(localStorage.getItem(CRED_KEY))).toEqual(stale);
  });

  it('broken storage fails BEFORE enrolling (canary): no row minted, halt intact', async () => {
    const server = makeServer();
    seedHalt();
    seedStaleRecord();
    const realSetItem = localStorage.setItem;
    localStorage.setItem = (k, v) => {
      if (k === CRED_KEY) throw new Error('quota');
      realSetItem(k, v);
    };
    try {
      await expect(recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET })))
        .rejects.toMatchObject({ code: 'CREDENTIAL_PERSIST_FAILED' });
      expect(server.enrollCalls()).toBe(0);
      expect(localStorage.getItem(HALT_KEY)).not.toBeNull();
    } finally {
      localStorage.setItem = realSetItem;
    }
  });

  it('persist failure AFTER minting -> CREDENTIAL_PERSIST_FAILED; halt not cleared', async () => {
    const server = makeServer();
    seedHalt();
    seedStaleRecord();
    const realSetItem = localStorage.setItem;
    // Canary and restore succeed; only the write carrying the NEW credential fails.
    localStorage.setItem = (k, v) => {
      if (k === CRED_KEY && String(v).includes(CREDENTIAL)) throw new Error('quota');
      realSetItem(k, v);
    };
    try {
      await expect(recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET })))
        .rejects.toMatchObject({ code: 'CREDENTIAL_PERSIST_FAILED' });
      expect(localStorage.getItem(HALT_KEY)).not.toBeNull();
    } finally {
      localStorage.setItem = realSetItem;
    }
  });
});

describe('recovery: deviceId resolution', () => {
  it('explicit config.deviceId differing from the stale record -> DEVICE_ID_CONFLICT, nothing touched', async () => {
    const server = makeServer();
    seedHalt();
    seedStaleRecord({ deviceId: 'dev-real' });
    await expect(recoverVaultSyncEngine(
      baseConfig(server, { enrollmentSecret: SECRET, deviceId: 'dev-other' })))
      .rejects.toMatchObject({ code: 'DEVICE_ID_CONFLICT' });
    expect(server.requests).toHaveLength(0);
    expect(localStorage.getItem(HALT_KEY)).not.toBeNull();
  });

  it('explicit config.deviceId matching the record is fine', async () => {
    const server = makeServer();
    seedHalt();
    seedStaleRecord({ deviceId: 'dev-real' });
    const { deviceId } = await recoverVaultSyncEngine(
      baseConfig(server, { enrollmentSecret: SECRET, deviceId: 'dev-real' }));
    expect(deviceId).toBe('dev-real');
  });

  it('no readable record: explicit config.deviceId, else the persisted package-owned id', async () => {
    const server = makeServer();
    seedHalt();
    localStorage.setItem(CRED_KEY, 'not json {');
    const { deviceId } = await recoverVaultSyncEngine(
      baseConfig(server, { enrollmentSecret: SECRET, deviceId: 'dev-explicit' }));
    expect(deviceId).toBe('dev-explicit');

    seedHalt(); // recover again, this time with no explicit id
    localStorage.removeItem(CRED_KEY);
    const second = await recoverVaultSyncEngine(baseConfig(server, { enrollmentSecret: SECRET }));
    expect(second.deviceId).toBe(localStorage.getItem('connect-test-device-id'));
  });
});
