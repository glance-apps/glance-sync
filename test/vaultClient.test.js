// Tests for the vault client's per-account auth surface (vault Phase 1.4b):
// unauthenticated auth-mode discovery via /healthz and the bootstrap-secret ->
// per-device-credential exchange at POST /enroll. Scoped-call tests for the
// client live in dbEngine.test.js; this file covers only the pre-credential
// helpers and the one invariant the workstream pinned for scoped calls — the
// credential IS the Bearer token, so switching modes changes only what string
// the client sends.

import { describe, it, expect } from 'vitest';
import { fetchVaultHealth, enrollVaultDevice, createVaultClient } from '../src/vaultClient.js';

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
