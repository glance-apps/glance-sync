// Tests for the vault client's per-account auth surface (vault Phase 1.4b):
// unauthenticated auth-mode discovery via /healthz and the bootstrap-secret ->
// per-device-credential exchange at POST /enroll. Scoped-call tests for the
// client live in dbEngine.test.js; this file covers only the pre-credential
// helpers and the one invariant the workstream pinned for scoped calls — the
// credential IS the Bearer token, so switching modes changes only what string
// the client sends.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchVaultHealth,
  enrollVaultDevice,
  createVaultClient,
  isVaultRateLimited,
  vaultBrakeStatus,
  getVaultStats,
  configureVaultDiagnostics,
  resetVaultDiagnostics,
} from '../src/vaultClient.js';

// The brake, the budget meter and the write-loop history live at MODULE
// scope (one per bundle realm — see vaultClient.js), so a case that arms the
// brake would otherwise gate the next case's calls. Every test starts from a
// clean realm.
beforeEach(() => {
  resetVaultDiagnostics();
});

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Records every call so tests can assert the exact wire shape.
const makeRecordingFetch = (responder) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { calls, fetchImpl };
};

describe('fetchVaultHealth', () => {
  it('GETs {base}/healthz with no Authorization header and returns the body', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() =>
      jsonResponse(200, { status: 'ok', version: '0.1.0', schemaVersion: 5, authMode: 'per-account' }));

    const health = await fetchVaultHealth({ vaultUrl: 'https://vault.example', fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://vault.example/healthz');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(health).toEqual({ status: 'ok', version: '0.1.0', schemaVersion: 5, authMode: 'per-account' });
  });

  it('normalizes a missing authMode to "shared" (pre-1.4a servers are all shared-token)', async () => {
    const { fetchImpl } = makeRecordingFetch(() =>
      jsonResponse(200, { status: 'ok', version: '0.1.0', schemaVersion: 5 }));

    const health = await fetchVaultHealth({ vaultUrl: 'https://vault.example', fetchImpl });
    expect(health.authMode).toBe('shared');
  });

  it('strips trailing slashes from vaultUrl', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() =>
      jsonResponse(200, { status: 'ok', version: '0.1.0', schemaVersion: 5, authMode: 'shared' }));

    await fetchVaultHealth({ vaultUrl: 'https://vault.example//', fetchImpl });
    expect(calls[0].url).toBe('https://vault.example/healthz');
  });

  it('throws a typed VAULT_ERROR with the status on a non-ok response', async () => {
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse(503, { error: 'down' }));

    await expect(fetchVaultHealth({ vaultUrl: 'https://vault.example', fetchImpl }))
      .rejects.toMatchObject({ code: 'VAULT_ERROR', status: 503 });
  });

  it('requires vaultUrl before touching the wire', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, {}));

    await expect(fetchVaultHealth({ fetchImpl })).rejects.toThrow(/vaultUrl is required/);
    expect(calls).toHaveLength(0);
  });
});

describe('enrollVaultDevice', () => {
  const ENROLL_OK = {
    credentialId: 'cred-uuid-1',
    credential: 'gvc_' + 'ab'.repeat(32),
    accountId: 'house-1',
    deviceId: 'kitchen-tablet',
    createdAt: '2026-07-31T00:00:00.000Z',
  };
  const ARGS = {
    vaultUrl: 'https://vault.example',
    enrollmentSecret: 'bootstrap-secret',
    accountId: 'house-1',
    deviceId: 'kitchen-tablet',
  };

  it('POSTs the three fields in the JSON body — no Authorization header, secret never in the URL', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(201, ENROLL_OK));

    const enrollment = await enrollVaultDevice({ ...ARGS, fetchImpl });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://vault.example/enroll');
    expect(url).not.toContain('bootstrap-secret');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      enrollmentSecret: 'bootstrap-secret',
      accountId: 'house-1',
      deviceId: 'kitchen-tablet',
    });
    expect(enrollment).toEqual(ENROLL_OK);
  });

  it('sends field values byte-exact (no trimming of what goes on the wire)', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(201, ENROLL_OK));

    await enrollVaultDevice({ ...ARGS, enrollmentSecret: ' padded ', fetchImpl });
    expect(JSON.parse(calls[0].init.body).enrollmentSecret).toBe(' padded ');
  });

  it('401 -> ENROLLMENT_REJECTED (the server did not accept the secret)', async () => {
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse(401, { error: 'invalid enrollment secret' }));

    await expect(enrollVaultDevice({ ...ARGS, fetchImpl }))
      .rejects.toMatchObject({ code: 'ENROLLMENT_REJECTED', status: 401 });
  });

  it('404 -> ENROLLMENT_UNSUPPORTED (shared-mode server: the route is registration-gated off)', async () => {
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse(404, {}));

    await expect(enrollVaultDevice({ ...ARGS, fetchImpl }))
      .rejects.toMatchObject({ code: 'ENROLLMENT_UNSUPPORTED', status: 404 });
  });

  it('other non-2xx -> VAULT_ERROR with the status', async () => {
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse(500, { error: 'boom' }));

    await expect(enrollVaultDevice({ ...ARGS, fetchImpl }))
      .rejects.toMatchObject({ code: 'VAULT_ERROR', status: 500 });
  });

  it.each([
    ['enrollmentSecret', 'ENROLLMENT_SECRET_REQUIRED'],
    ['accountId', 'ACCOUNT_ID_REQUIRED'],
    ['deviceId', 'DEVICE_ID_REQUIRED'],
  ])('missing or whitespace-only %s throws %s before touching the wire', async (field, code) => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(201, ENROLL_OK));

    await expect(enrollVaultDevice({ ...ARGS, [field]: undefined, fetchImpl })).rejects.toMatchObject({ code });
    await expect(enrollVaultDevice({ ...ARGS, [field]: '   ', fetchImpl })).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(0);
  });
});

describe('error-body classification (best-effort, degrades to VAULT_ERROR)', () => {
  const client = (responder) => createVaultClient({
    vaultUrl: 'https://vault.example',
    vaultToken: 'tok',
    fetchImpl: async () => responder(),
  });

  it('401 with body {error:"invalid credential"} -> CREDENTIAL_INVALID', async () => {
    const c = client(() => jsonResponse(401, { error: 'invalid credential' }));
    await expect(c.list('app', { accountId: 'a', since: 0 }))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID', status: 401 });
  });

  it('401 with shared-mode wording ("invalid device token") stays VAULT_ERROR', async () => {
    const c = client(() => jsonResponse(401, { error: 'invalid device token' }));
    await expect(c.list('app', { accountId: 'a', since: 0 }))
      .rejects.toMatchObject({ code: 'VAULT_ERROR', status: 401 });
  });

  it('401 with a missing/non-JSON body degrades to VAULT_ERROR (never throws in the parse)', async () => {
    const c = client(() => ({ ok: false, status: 401, json: async () => { throw new Error('no body'); } }));
    await expect(c.list('app', { accountId: 'a', since: 0 }))
      .rejects.toMatchObject({ code: 'VAULT_ERROR', status: 401 });
  });

  it('"invalid credential" wording on a non-401 status stays VAULT_ERROR', async () => {
    const c = client(() => jsonResponse(500, { error: 'invalid credential' }));
    await expect(c.list('app', { accountId: 'a', since: 0 }))
      .rejects.toMatchObject({ code: 'VAULT_ERROR', status: 500 });
  });

  it('classification applies on every scoped call, e.g. getSalt', async () => {
    const c = client(() => jsonResponse(401, { error: 'invalid credential' }));
    await expect(c.getSalt('acct')).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });
});

describe('credential as Bearer token (scoped calls are mode-agnostic)', () => {
  it('createVaultClient sends an enrolled credential exactly as it sends the shared token', async () => {
    const credential = 'gvc_' + 'cd'.repeat(32);
    const { calls, fetchImpl } = makeRecordingFetch(() =>
      jsonResponse(200, { rows: [], hasMore: false }));

    const client = createVaultClient({ vaultUrl: 'https://vault.example', vaultToken: credential, fetchImpl });
    await client.list('dayglance', { accountId: 'house-1', since: 0 });

    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${credential}`);
  });
});

// ═══════════ Phase 3.3: quota rejection parsing (defensive by construction) ═══════════
//
// The shape is a contract across two repos, so a body must EARN the typed
// classification: the exact wording, a non-empty string dimension, and three
// finite numbers. Everything else degrades to the generic VAULT_ERROR the
// client already handled — never a throw, never a mis-classification.

describe('quota rejection parsing', () => {
  const client = (status, body) => createVaultClient({
    vaultUrl: 'https://vault.example',
    vaultToken: 'tok',
    fetchImpl: async () => (body === undefined
      ? { ok: false, status, json: async () => { throw new Error('no body'); } }
      : { ok: false, status, json: async () => body }),
  });
  const push = (c) => c.batch('app', { accountId: 'a', rows: [] });

  const FULL = { error: 'quota exceeded', quota: 'rows', limit: 100, used: 100, requested: 3 };

  it('413 with the full shape -> QUOTA_EXCEEDED carrying the descriptor', async () => {
    await expect(push(client(413, FULL))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      status: 413,
      quota: { quota: 'rows', limit: 100, used: 100, requested: 3 },
    });
  });

  it('429 with the full shape -> QUOTA_EXCEEDED (volume/concurrency-shaped)', async () => {
    const body = { error: 'quota exceeded', quota: 'intents', limit: 500, used: 500, requested: 1 };
    await expect(push(client(429, body))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED', status: 429, quota: { quota: 'intents' },
    });
  });

  it('the message renders the numbers so a bare log line is still useful', async () => {
    await expect(push(client(413, FULL))).rejects.toThrow(/rows quota exceeded \(100 of 100, requested 3\)/);
  });

  it('an UNRECOGNISED dimension is still a quota condition, passed through verbatim', async () => {
    const body = { error: 'quota exceeded', quota: 'bandwidth-from-a-newer-server', limit: 5, used: 5, requested: 1 };
    await expect(push(client(413, body))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED', quota: { quota: 'bandwidth-from-a-newer-server' },
    });
  });

  it('413 with NO quota fields at all -> generic VAULT_ERROR', async () => {
    await expect(push(client(413, { error: 'payload too large' })))
      .rejects.toMatchObject({ code: 'VAULT_ERROR', status: 413 });
  });

  it('413 with an empty body -> generic VAULT_ERROR (no throw in the parse)', async () => {
    await expect(push(client(413, undefined))).rejects.toMatchObject({ code: 'VAULT_ERROR', status: 413 });
  });

  it.each([
    ['missing quota', { error: 'quota exceeded', limit: 1, used: 1, requested: 1 }],
    ['empty quota', { error: 'quota exceeded', quota: '', limit: 1, used: 1, requested: 1 }],
    ['missing limit', { error: 'quota exceeded', quota: 'rows', used: 1, requested: 1 }],
    ['missing used', { error: 'quota exceeded', quota: 'rows', limit: 1, requested: 1 }],
    ['missing requested', { error: 'quota exceeded', quota: 'rows', limit: 1, used: 1 }],
    ['string numbers', { error: 'quota exceeded', quota: 'rows', limit: '1', used: '1', requested: '1' }],
    ['non-finite number', { error: 'quota exceeded', quota: 'rows', limit: null, used: 1, requested: 1 }],
  ])('a body missing part of the shape (%s) -> generic VAULT_ERROR', async (_label, body) => {
    await expect(push(client(413, body))).rejects.toMatchObject({ code: 'VAULT_ERROR' });
  });

  it('the quota wording on a status that is neither 413 nor 429 stays VAULT_ERROR', async () => {
    await expect(push(client(500, FULL))).rejects.toMatchObject({ code: 'VAULT_ERROR', status: 500 });
  });

  it('the LEGACY SSE 429 body is not a quota rejection', async () => {
    // Byte-identical legacy body; it fails the `error` check with no
    // special-casing. (Nothing in this package speaks SSE — see the PR's
    // documented negative — but the parse must not claim it either.)
    await expect(push(client(429, { error: 'too many connections for account' })))
      .rejects.toMatchObject({ code: 'VAULT_ERROR', status: 429 });
  });

  it('a 401 credential rejection is untouched by quota parsing', async () => {
    await expect(push(client(401, { error: 'invalid credential' })))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID', status: 401 });
  });
});

// ═══════════════════ 1.11.0: the intents transport ═══════════════════
//
// Pure client transport for the /intents/* surface the server already
// serves. These tests pin the exact wire shapes, because the contract spans
// two repos and the whole point of moving apps off raw fetch is that this
// client sends what their hand-rolled transports sent.

describe('intents transport', () => {
  const ARGS = { vaultUrl: 'https://vault.example', vaultToken: 'tok' };
  const EVENTS = [
    { eventId: 'evt-1', envelope: 'YmFzZTY0LW9wYXF1ZQ==', expiresAt: '2026-09-01T00:00:00.000Z' },
    { eventId: 'evt-2', envelope: 'c2Vjb25kLWVudmVsb3Bl', expiresAt: '2026-09-02T00:00:00.000Z' },
  ];

  it('intentsBatch POSTs {base}/intents/batch with { accountId, events } and passes the response through', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, { written: 2, maxSeq: 41 }));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    const result = await client.intentsBatch('house-1', EVENTS);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://vault.example/intents/batch');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ accountId: 'house-1', events: EVENTS });
    expect(result).toEqual({ written: 2, maxSeq: 41 });
  });

  it('intentsBatch sends the envelope byte-exact and never decodes or inspects it', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, { written: 1, maxSeq: 1 }));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    // Not valid base64 of anything meaningful, and not a JSON envelope: the
    // codec lives in @glance-apps/intents, so this package must not care.
    const opaque = '!!!not-base64-at-all!!!';
    await client.intentsBatch('house-1', [{ eventId: 'e', envelope: opaque, expiresAt: 'whenever' }]);

    expect(JSON.parse(calls[0].init.body).events[0]).toEqual({
      eventId: 'e', envelope: opaque, expiresAt: 'whenever',
    });
  });

  it('an empty batch is still a well-formed request (no client-side short-circuit to invent)', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, { written: 0, maxSeq: 7 }));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    expect(await client.intentsBatch('house-1', [])).toEqual({ written: 0, maxSeq: 7 });
    expect(JSON.parse(calls[0].init.body)).toEqual({ accountId: 'house-1', events: [] });
  });

  it('intentsList GETs {base}/intents/list?accountId=&since=&limit= and passes the response through', async () => {
    const rows = [
      { eventId: 'evt-1', envelope: 'ZW52', seq: 12, expiresAt: '2026-09-01T00:00:00.000Z', serverMtime: '2026-08-30T00:00:00.000Z' },
    ];
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, { rows, hasMore: true }));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    const page = await client.intentsList('house-1', { since: 11, limit: 500 });

    expect(calls[0].url).toBe('https://vault.example/intents/list?accountId=house-1&since=11&limit=500');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.body).toBeUndefined();
    expect(page).toEqual({ rows, hasMore: true });
  });

  it('intentsList defaults since to 0 and omits limit entirely when not given', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, { rows: [], hasMore: false }));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    await client.intentsList('house-1');

    expect(calls[0].url).toBe('https://vault.example/intents/list?accountId=house-1&since=0');
  });

  it('both methods require accountId before touching the wire (same rule as the sync methods)', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, {}));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    await expect(client.intentsBatch('  ', EVENTS)).rejects.toMatchObject({ code: 'ACCOUNT_ID_REQUIRED' });
    await expect(client.intentsList(undefined, { since: 0 })).rejects.toMatchObject({ code: 'ACCOUNT_ID_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('intentsBatch rejects a non-array events argument before touching the wire', async () => {
    const { calls, fetchImpl } = makeRecordingFetch(() => jsonResponse(200, {}));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    await expect(client.intentsBatch('house-1', undefined)).rejects.toMatchObject({ code: 'EVENTS_REQUIRED' });
    await expect(client.intentsBatch('house-1', { eventId: 'not-a-list' })).rejects.toMatchObject({ code: 'EVENTS_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('climbs the same error ladder as the sync methods: 401 -> CREDENTIAL_INVALID', async () => {
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse(401, { error: 'invalid credential' }));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    await expect(client.intentsList('house-1', { since: 0 }))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID', status: 401 });
    await expect(client.intentsBatch('house-1', EVENTS))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID', status: 401 });
  });

  it('a 429 over-quota rejection on intentsBatch surfaces QUOTA_EXCEEDED with its descriptor', async () => {
    const body = { error: 'quota exceeded', quota: 'intents', limit: 500, used: 500, requested: 2 };
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse(429, body));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    await expect(client.intentsBatch('house-1', EVENTS)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      status: 429,
      quota: { quota: 'intents', limit: 500, used: 500, requested: 2 },
    });
  });

  it('any other non-2xx -> VaultError with the status', async () => {
    const { fetchImpl } = makeRecordingFetch(() => jsonResponse(503, { error: 'down' }));
    const client = createVaultClient({ ...ARGS, fetchImpl });

    await expect(client.intentsList('house-1', { since: 0 }))
      .rejects.toMatchObject({ name: 'VaultError', code: 'VAULT_ERROR', status: 503 });
  });
});

// ═══════════════════ 1.11.0: the device-wide brake ═══════════════════
//
// One brake per bundle realm, gating every client call. The semantics ported
// here are the FIXED ones: decay, never amnesty. The first brake in this
// ecosystem reset escalation to zero on any success, and on a saturated
// shared budget a lucky 200 re-licensed full cadence — it backed off,
// escalated, forgot, and started over.

describe('the request brake', () => {
  const T0 = new Date('2026-08-30T12:00:00.000Z').getTime();
  let logs;

  const captureLogs = () => {
    logs = [];
    configureVaultDiagnostics({ logger: {
      warn: (m) => logs.push({ level: 'warn', message: m }),
      info: (m) => logs.push({ level: 'info', message: m }),
      log: (m) => logs.push({ level: 'log', message: m }),
    } });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    captureLogs();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A fetch whose status is whatever the test's `status` box says right now.
  const scriptedClient = (box, extra = {}) => {
    const calls = [];
    const client = createVaultClient({
      vaultUrl: 'https://vault.example',
      vaultToken: 'tok',
      ...extra,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return box.status === 200
          ? jsonResponse(200, { rows: [], hasMore: false })
          : jsonResponse(box.status, box.body ?? { error: 'rate limited' });
      },
    });
    return { client, calls };
  };

  const brakeLines = () => logs.filter((l) => l.message.startsWith('[vault] BRAKE'));

  it('a real 429 arms the brake and reports ONCE, naming the method that met the limiter', async () => {
    const box = { status: 429 };
    const { client } = scriptedClient(box);

    await expect(client.intentsList('a', { since: 0 })).rejects.toMatchObject({ status: 429 });

    expect(brakeLines()).toHaveLength(1);
    expect(brakeLines()[0].message).toBe(
      '[vault] BRAKE: rate-limited (429) on intentsList — vault requests paused for ~30s'
    );
    expect(isVaultRateLimited()).toBe(true);
    expect(vaultBrakeStatus()).toMatchObject({ braked: true, memoryMs: 30_000, until: T0 + 30_000 });
  });

  it('while braked, every method fails FAST with a typed RATE_LIMITED — without touching the network', async () => {
    const box = { status: 429 };
    const { client, calls } = scriptedClient(box);
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);

    box.status = 200; // the server would answer happily now; the gate must not ask.
    const gated = await client.batch('app', { accountId: 'a', rows: [] }).catch((e) => e);

    expect(gated).toMatchObject({ name: 'VaultError', code: 'RATE_LIMITED', status: 429 });
    expect(gated.retryInMs).toBeGreaterThan(0);
    expect(gated.retryInMs).toBeLessThanOrEqual(30_000);
    expect(calls).toHaveLength(1); // no second request reached the wire

    // Gated calls stay silent — the arming line was the once-per-incident report.
    for (const m of [
      () => client.list('app', { accountId: 'a', since: 0 }),
      () => client.getRow('app', 'e', 'a'),
      () => client.deleteRow('app', 'e', 'a'),
      () => client.device('app', { accountId: 'a', deviceId: 'd', lastSeenSeq: 1 }),
      () => client.getSalt('a'),
      () => client.putSalt('a', new Uint8Array(16)),
      () => client.intentsBatch('a', []),
      () => client.intentsList('a', { since: 0 }),
    ]) {
      await expect(m()).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    }
    expect(calls).toHaveLength(1);
    expect(brakeLines()).toHaveLength(1);
  });

  it('escalates 30s -> 60s -> 120s across bursts, and one burst arms only once', async () => {
    const box = { status: 429 };
    const { client } = scriptedClient(box);

    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(vaultBrakeStatus().memoryMs).toBe(30_000);

    vi.setSystemTime(T0 + 30_001);
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(vaultBrakeStatus().memoryMs).toBe(60_000);

    vi.setSystemTime(T0 + 30_001 + 60_001);
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(vaultBrakeStatus().memoryMs).toBe(120_000);
    expect(brakeLines()).toHaveLength(3);
  });

  it('a concurrent burst of 429s costs ONE escalation step, not one per response', async () => {
    // All three are in flight before the first 429 lands, so all three pass
    // the gate and all three see a real 429.
    const box = { status: 429 };
    const { client, calls } = scriptedClient(box);

    const results = await Promise.allSettled([
      client.list('app', { accountId: 'a', since: 0 }),
      client.intentsList('a', { since: 0 }),
      client.device('app', { accountId: 'a', deviceId: 'd', lastSeenSeq: 0 }),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(calls).toHaveLength(3);
    expect(vaultBrakeStatus().memoryMs).toBe(30_000); // not 120_000
    expect(brakeLines()).toHaveLength(1);
  });

  it('escalation stops at the 10-minute ceiling', async () => {
    const box = { status: 429 };
    const { client } = scriptedClient(box);
    let now = T0;
    for (let i = 0; i < 8; i += 1) {
      vi.setSystemTime(now);
      await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
      now += vaultBrakeStatus().memoryMs + 1;
    }
    expect(vaultBrakeStatus().memoryMs).toBe(600_000);
  });

  it('DECAY, NOT AMNESTY: one success halves the memory, and the next 429 re-arms LONGER than the base', async () => {
    const box = { status: 429 };
    const { client } = scriptedClient(box);

    // Two bursts: memory 30s -> 60s.
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    vi.setSystemTime(T0 + 30_001);
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(vaultBrakeStatus().memoryMs).toBe(60_000);

    // The lucky 200 that used to buy full amnesty.
    vi.setSystemTime(T0 + 30_001 + 60_001);
    box.status = 200;
    await client.list('app', { accountId: 'a', since: 0 });
    expect(vaultBrakeStatus()).toMatchObject({ braked: false, memoryMs: 30_000 });

    // The storm resumes: re-arms at 2x what is LEFT (60s), not at the 30s base.
    box.status = 429;
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(vaultBrakeStatus().memoryMs).toBe(60_000);
    expect(vaultBrakeStatus().retryInMs).toBe(60_000);
  });

  it('a 2xx that lands mid-window releases the gate early, and halves the memory', async () => {
    // The only way a success lands while the gate is engaged: a request that
    // was already in flight when a sibling's 429 armed it.
    let landOk;
    const okInFlight = new Promise((resolve) => { landOk = resolve; });
    const client = createVaultClient({
      vaultUrl: 'https://vault.example',
      vaultToken: 'tok',
      fetchImpl: async (url) => {
        if (url.includes('/intents/list')) {
          await okInFlight; // held open until the sibling's 429 has armed
          return jsonResponse(200, { rows: [], hasMore: false });
        }
        return jsonResponse(429, { error: 'rate limited' });
      },
    });

    // Both pass the gate (it is checked synchronously, before either fetch
    // resolves), then the 429 lands first and arms.
    const okCall = client.intentsList('a', { since: 0 });
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toMatchObject({ status: 429 });
    expect(isVaultRateLimited()).toBe(true);

    landOk();
    await expect(okCall).resolves.toEqual({ rows: [], hasMore: false });

    expect(isVaultRateLimited()).toBe(false);            // gate cleared
    expect(vaultBrakeStatus().memoryMs).toBe(0);         // 30s halved is below the base
    expect(logs.some((l) => l.message.includes('brake released'))).toBe(true);
  });

  it('a brake:false client neither arms, gates, nor decays the shared brake', async () => {
    const box = { status: 429 };
    const { client: braking } = scriptedClient(box);
    await expect(braking.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(vaultBrakeStatus()).toMatchObject({ braked: true, memoryMs: 30_000 });

    box.status = 200;
    const { client: unbraked, calls } = scriptedClient(box, { brake: false });
    await unbraked.list('app', { accountId: 'a', since: 0 });

    // It reached the wire mid-window (the escape hatch works)...
    expect(calls).toHaveLength(1);
    // ...and left the shared brake exactly as it found it: a client that opted
    // out is not evidence about the traffic the brake is modelling.
    expect(vaultBrakeStatus()).toMatchObject({ braked: true, memoryMs: 30_000 });
  });

  it('consecutive successes drain the memory to zero, so a genuine recovery costs nothing', async () => {
    const box = { status: 429 };
    const { client } = scriptedClient(box);

    let now = T0;
    for (let i = 0; i < 4; i += 1) { // memory 30 -> 60 -> 120 -> 240
      vi.setSystemTime(now);
      await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
      now += vaultBrakeStatus().memoryMs + 1;
    }
    expect(vaultBrakeStatus().memoryMs).toBe(240_000);

    vi.setSystemTime(now);
    box.status = 200;
    const drained = [];
    for (let i = 0; i < 4; i += 1) {
      await client.list('app', { accountId: 'a', since: 0 });
      drained.push(vaultBrakeStatus().memoryMs);
    }
    // 240 -> 120 -> 60 -> 30 -> below the base, so zero.
    expect(drained).toEqual([120_000, 60_000, 30_000, 0]);

    // Fully drained: the next 429 starts over at the base.
    box.status = 429;
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(vaultBrakeStatus().memoryMs).toBe(30_000);
  });

  it('an over-quota 429 does NOT arm the brake (it would mask QUOTA_EXCEEDED behind RATE_LIMITED)', async () => {
    const box = { status: 429, body: { error: 'quota exceeded', quota: 'intents', limit: 5, used: 5, requested: 1 } };
    const { client, calls } = scriptedClient(box);

    await expect(client.intentsBatch('a', [])).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(isVaultRateLimited()).toBe(false);
    expect(brakeLines()).toHaveLength(0);

    // ...and the next call still reaches the wire and still gets the descriptor.
    await expect(client.intentsBatch('a', [])).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(calls).toHaveLength(2);
  });

  it('the legacy SSE 429 IS a limiter hit and does arm the brake', async () => {
    const box = { status: 429, body: { error: 'too many connections for account' } };
    const { client } = scriptedClient(box);
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toMatchObject({ code: 'VAULT_ERROR' });
    expect(isVaultRateLimited()).toBe(true);
  });

  it('brake:false opts a client out of BOTH the gate and the arming', async () => {
    const box = { status: 429 };
    const { client, calls } = scriptedClient(box, { brake: false });

    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toMatchObject({ code: 'VAULT_ERROR', status: 429 });
    expect(isVaultRateLimited()).toBe(false); // never armed the shared brake
    expect(brakeLines()).toHaveLength(0);

    // And it keeps hitting the wire even while a braked client armed it.
    const { client: braking } = scriptedClient(box);
    await expect(braking.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    expect(isVaultRateLimited()).toBe(true);

    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(2);
  });
});

// ═══════════════════ 1.11.0: the budget meter ═══════════════════
//
// Visibility only — it never throttles. Its argument is that it needs no
// theory about WHY a loop is running, so the next storm is an attributed
// event on day one instead of an afternoon of archaeology.

describe('the budget meter', () => {
  const T0 = new Date('2026-08-30T12:00:00.000Z').getTime();
  let logs;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    logs = [];
    configureVaultDiagnostics({
      softLimitPerMinute: 4,
      logger: { warn: (m) => logs.push(m), info: (m) => logs.push(m), log: (m) => logs.push(m) },
    });
  });
  afterEach(() => vi.useRealTimers());

  const okClient = () => createVaultClient({
    vaultUrl: 'https://vault.example',
    vaultToken: 'tok',
    fetchImpl: async () => jsonResponse(200, { rows: [], hasMore: false, written: 0, maxSeq: 0 }),
  });

  const budgetLines = () => logs.filter((m) => m.startsWith('[vault] budget:'));

  it('says nothing below the soft limit', async () => {
    const client = okClient();
    for (let i = 0; i < 4; i += 1) await client.intentsList('a', { since: 0 });
    expect(budgetLines()).toHaveLength(0);
    expect(getVaultStats().requests).toMatchObject({ lastMinute: 4, softLimitPerMinute: 4 });
  });

  it('logs ONE attributable line per window, naming the top contributors', async () => {
    const client = okClient();
    for (let i = 0; i < 3; i += 1) await client.intentsList('a', { since: 0 });
    await client.intentsBatch('a', []);
    await client.deleteRow('app', `e${Math.random()}`, 'a');

    expect(budgetLines()).toHaveLength(1);
    expect(budgetLines()[0]).toBe(
      '[vault] budget: 5 requests in the last minute (soft limit 4) — top: intentsList 3, intentsBatch 1, deleteRow 1'
    );

    // Still over the limit for the rest of the window: still exactly one line.
    for (let i = 0; i < 20; i += 1) await client.intentsList('a', { since: 0 });
    expect(budgetLines()).toHaveLength(1);
  });

  it('reports again in the next window, and the window is rolling', async () => {
    const client = okClient();
    for (let i = 0; i < 5; i += 1) await client.intentsList('a', { since: 0 });
    expect(budgetLines()).toHaveLength(1);

    // A full minute later the old samples have rolled off entirely...
    vi.setSystemTime(T0 + 61_000);
    expect(getVaultStats().requests.lastMinute).toBe(0);

    // ...so crossing again is a fresh, separately attributed incident.
    for (let i = 0; i < 5; i += 1) await client.list('app', { accountId: 'a', since: 0 });
    expect(budgetLines()).toHaveLength(2);
    expect(budgetLines()[1]).toContain('top: list 5');
  });

  it('never throttles: every metered call still reaches the wire', async () => {
    let hits = 0;
    const client = createVaultClient({
      vaultUrl: 'https://vault.example',
      vaultToken: 'tok',
      fetchImpl: async () => { hits += 1; return jsonResponse(200, { rows: [], hasMore: false }); },
    });
    for (let i = 0; i < 50; i += 1) await client.intentsList('a', { since: 0 });
    expect(hits).toBe(50);
    expect(isVaultRateLimited()).toBe(false);
  });

  it('counts only what reaches the wire — a gated call is not budget the server spent', async () => {
    const client = createVaultClient({
      vaultUrl: 'https://vault.example',
      vaultToken: 'tok',
      fetchImpl: async () => jsonResponse(429, { error: 'rate limited' }),
    });
    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toBeTruthy();
    const after429 = getVaultStats().requests.lastMinute;

    await expect(client.list('app', { accountId: 'a', since: 0 })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(getVaultStats().requests.lastMinute).toBe(after429);
  });
});

// ═══════════════════ 1.11.0: the write-loop detector ═══════════════════
//
// The success-side signal. Failure visibility existed; what was missing on
// the day of the incident was the signal for everything "succeeding"
// pathologically — every request 200, every promise swallowed.

describe('the write-loop detector', () => {
  const T0 = new Date('2026-08-30T12:00:00.000Z').getTime();
  let logs;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    logs = [];
    configureVaultDiagnostics({
      // The meter is off the table here: raise its limit so the only lines
      // this suite sees are the detector's.
      softLimitPerMinute: 100_000,
      logger: { warn: (m) => logs.push(m), info: () => {}, log: () => {} },
    });
  });
  afterEach(() => vi.useRealTimers());

  const client = createVaultClient({
    vaultUrl: 'https://vault.example',
    vaultToken: 'tok',
    fetchImpl: async () => jsonResponse(200, { written: 1, maxSeq: 1, rows: [], hasMore: false }),
  });

  const loopLines = () => logs.filter((m) => m.startsWith('[vault] WRITE LOOP?'));
  const upsert = (id, envelope = `env-${Math.random()}`) =>
    client.batch('app', { accountId: 'a', rows: [{ entityId: id, envelope, createdAt: 1 }] });
  const remove = (id) => client.deleteRow('app', id, 'a');

  it('warns ONCE when one entityId flips polarity K times, naming the id and its history', async () => {
    await upsert('note-1');
    await remove('note-1');
    await upsert('note-1');
    expect(loopLines()).toHaveLength(0); // 2 flips: not a loop yet

    await remove('note-1');
    await upsert('note-1');                // 4 flips
    expect(loopLines()).toHaveLength(1);
    expect(loopLines()[0]).toContain('note-1');
    expect(loopLines()[0]).toContain('4 polarity flips');
    expect(loopLines()[0]).toContain('upsert -> delete -> upsert -> delete -> upsert');

    // At most once per id per window, however long the loop runs.
    for (let i = 0; i < 10; i += 1) { await remove('note-1'); await upsert('note-1'); }
    expect(loopLines()).toHaveLength(1);
  });

  it('warns again for the same id in a later window (the loop is still news an hour on)', async () => {
    for (let i = 0; i < 3; i += 1) { await upsert('note-1'); await remove('note-1'); }
    expect(loopLines()).toHaveLength(1);

    vi.setSystemTime(T0 + 11 * 60_000);
    for (let i = 0; i < 3; i += 1) { await upsert('note-1'); await remove('note-1'); }
    expect(loopLines()).toHaveLength(2);
  });

  it('catches identical-content rewrites, not just polarity flips', async () => {
    for (let i = 0; i < 5; i += 1) await upsert('note-2', 'the-very-same-envelope');
    expect(loopLines()).toHaveLength(1);
    expect(loopLines()[0]).toContain('note-2');
  });

  it('FAILS OPEN: a big import of many DIFFERENT ids never triggers it', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ entityId: `import-${i}`, envelope: `e${i}`, createdAt: 1 }));
    await client.batch('app', { accountId: 'a', rows });
    // ...and again, as a re-import would.
    await client.batch('app', { accountId: 'a', rows });
    expect(loopLines()).toHaveLength(0);
  });

  it('FAILS OPEN: repeated edits to one id with CHANGING content are not a loop', async () => {
    for (let i = 0; i < 8; i += 1) await upsert('note-3', `revision-${i}`);
    expect(loopLines()).toHaveLength(0);
  });

  it('FAILS OPEN: flips spread beyond the window do not accumulate', async () => {
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(T0 + i * 4 * 60_000); // 4 minutes apart, window is 10
      await (i % 2 === 0 ? upsert('note-4') : remove('note-4'));
    }
    expect(loopLines()).toHaveLength(0);
  });

  it('surfaces the current suspects on the stats surface, with bounded history', async () => {
    for (let i = 0; i < 6; i += 1) { await upsert('note-5'); await remove('note-5'); }
    const suspects = getVaultStats().writeLoopSuspects;

    expect(suspects[0]).toMatchObject({ entityId: 'note-5', warned: true });
    expect(suspects[0].transitions).toBeGreaterThanOrEqual(4);
    // The per-id ring is capped: a loop that runs all day cannot grow it.
    expect(suspects[0].history.length).toBeLessThanOrEqual(8);
    expect(suspects[0].history.at(-1)).toMatchObject({ polarity: 'delete' });
  });

  it('the id map is LRU-bounded, so a busy realm cannot grow it without bound', async () => {
    await upsert('old-id');
    await remove('old-id');
    await upsert('old-id');
    await remove('old-id'); // 3 flips: one more would warn

    // 600 other ids push past the 500-id cap and evict the oldest.
    const rows = Array.from({ length: 600 }, (_, i) => ({ entityId: `filler-${i}`, envelope: `e${i}`, createdAt: 1 }));
    await client.batch('app', { accountId: 'a', rows });

    await upsert('old-id'); // would be the 4th flip if the history had survived
    expect(loopLines()).toHaveLength(0);
    expect(getVaultStats().writeLoopSuspects.every((s) => s.entityId !== 'old-id')).toBe(true);
  });

  it('is diagnostic only — it never brakes and never fails a call', async () => {
    for (let i = 0; i < 6; i += 1) { await upsert('note-6'); await remove('note-6'); }
    expect(loopLines().length).toBeGreaterThan(0);
    expect(isVaultRateLimited()).toBe(false);
    await expect(upsert('note-6')).resolves.toBeTruthy();
  });

  it('records at INTENT time, so a loop that is being gated is still visible as a loop', async () => {
    const limited = createVaultClient({
      vaultUrl: 'https://vault.example',
      vaultToken: 'tok',
      fetchImpl: async () => jsonResponse(429, { error: 'rate limited' }),
    });
    // First call arms the brake; the rest never reach the wire.
    await expect(limited.deleteRow('app', 'looping', 'a')).rejects.toBeTruthy();
    for (let i = 0; i < 5; i += 1) {
      await limited.batch('app', { accountId: 'a', rows: [{ entityId: 'looping', envelope: 'e', createdAt: 1 }] }).catch(() => {});
      await limited.deleteRow('app', 'looping', 'a').catch(() => {});
    }
    expect(loopLines()).toHaveLength(1);
    expect(loopLines()[0]).toContain('looping');
  });
});

// ═══════════════════ 1.11.0: the shared stats surface ═══════════════════

describe('getVaultStats', () => {
  it('reports the brake, the metered counts and the suspects in one read', async () => {
    const client = createVaultClient({
      vaultUrl: 'https://vault.example',
      vaultToken: 'tok',
      fetchImpl: async () => jsonResponse(200, { rows: [], hasMore: false, written: 1, maxSeq: 1 }),
    });
    await client.intentsList('a', { since: 0 });
    await client.batch('app', { accountId: 'a', rows: [{ entityId: 'x', envelope: 'e', createdAt: 1 }] });

    const stats = getVaultStats();
    expect(stats.brake).toEqual({ braked: false, until: null, memoryMs: 0, retryInMs: 0 });
    expect(stats.requests.byMethod).toEqual({ intentsList: 1, batch: 1 });
    expect(stats.requests.lastMinute).toBe(2);
    expect(stats.requests.softLimitPerMinute).toBe(300);
    expect(stats.writeLoopSuspects).toEqual([]);
  });

  it('resetVaultDiagnostics clears every counter and restores the defaults', async () => {
    configureVaultDiagnostics({ softLimitPerMinute: 1, loopTransitions: 2, loopWindowMs: 1000 });
    const client = createVaultClient({
      vaultUrl: 'https://vault.example',
      vaultToken: 'tok',
      fetchImpl: async () => jsonResponse(200, { rows: [], hasMore: false }),
    });
    await client.list('app', { accountId: 'a', since: 0 });

    resetVaultDiagnostics();

    const stats = getVaultStats();
    expect(stats.requests).toMatchObject({ lastMinute: 0, softLimitPerMinute: 300, byMethod: {} });
    expect(stats.writeLoopSuspects).toEqual([]);
    expect(stats.brake.braked).toBe(false);
  });
});
