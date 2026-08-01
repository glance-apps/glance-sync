// HTTP client for the GLANCEvault database backend (Phase 3).
//
// GLANCEvault is a self-hosted Express/SQLite server that stores one encrypted
// row per entity. This client wraps its sync endpoints. All requests carry a
// Bearer token. The fetch implementation is injectable so tests can supply a
// synthetic transport and native/Electron shells can route through their own
// network bridge if needed; it defaults to the platform fetch.
//
// Endpoints:
//   POST   /sync/:app/batch                     upsert rows, returns { written, maxSeq }
//   GET    /sync/:app/list?accountId=&since=     incremental fetch, { rows, hasMore }
//   GET    /sync/:app/:entityId?accountId=       fetch one row
//   DELETE /sync/:app/:entityId?accountId=&deletedAt=  soft-delete a row (deletedAt optional)
//   POST   /sync/:app/device                     update device cursor, { updated }
//   GET    /salt/:accountId                      fetch the account root-key salt
//   PUT    /salt/:accountId                      register a salt (first-write-wins)
//
// Auth models (vault Phase 1.4b — the client half of per-account credentials):
// a vault runs in one of two modes, discoverable unauthenticated via
// fetchVaultHealth. In "shared" mode every device presents the instance-wide
// device token as the Bearer value. In "per-account" mode each device first
// exchanges the admin-configured bootstrap secret for its own credential at
// POST /enroll (enrollVaultDevice below) and presents THAT as the Bearer
// value — the wire shape of every scoped call is identical in both modes, so
// createVaultClient is mode-agnostic: callers pass the shared token or the
// per-device credential as vaultToken and nothing else changes.
//
// Salts cross the wire as base64 in a { salt } field. The client converts to and
// from Uint8Array at the boundary so callers always deal in bytes.

import { toBase64, fromBase64 } from './dbCrypto.js';

class VaultError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VaultError';
    this.code = 'VAULT_ERROR';
    this.status = status;
  }
}

// Quota rejection parsing (GLANCEvault Phase 3.2 / client Phase 3.3).
//
// The server rejects an over-quota write with 413 (storage-shaped: `storage`,
// `rows`) or 429 (volume/concurrency-shaped: `intents`, `concurrent-uploads`)
// and a uniform body:
//   { error: "quota exceeded", quota, limit, used, requested }
// The three numbers are bytes for `storage` and counts otherwise, and are
// meant to render "X of Y used" directly.
//
// DEFENSIVE BY CONSTRUCTION — this shape is a contract across two repos, so
// a body must earn the typed classification rather than be assumed into it.
// ALL of: the exact `error` wording, a non-empty string `quota`, and three
// finite numbers. Anything short of that (a missing field, a non-JSON body, a
// 413 with no quota fields at all, an older server that never sends this
// shape) degrades to the generic VAULT_ERROR the client already handled —
// never a throw, never a mis-classification.
//
// The `quota` DIMENSION is deliberately NOT allowlisted. A newer server may
// add dimensions, and an unknown one is still a quota condition with the same
// remedy (wait; it clears when the operator acts, with no client action), so
// passing the string through verbatim is more truthful than pretending the
// rejection was a generic failure. Consumers that do not recognise a
// dimension render it generically. See the PR for this decision.
//
// The legacy SSE per-account cap (429 {"error":"too many connections for
// account"}) predates this shape and is NOT a quota rejection: its wording
// fails the `error` check on the first line, so it degrades generically with
// no special-casing. Nothing in this package speaks SSE regardless.
const parseQuotaBody = (status, body, bodyError) => {
  if (status !== 413 && status !== 429) return null;
  if (bodyError !== 'quota exceeded') return null;
  if (!body || typeof body.quota !== 'string' || body.quota === '') return null;
  const { limit, used, requested } = body;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return null;
  return { quota: body.quota, limit, used, requested };
};

// Shared by createVaultClient and the standalone pre-credential helpers below.
const resolveFetch = (fetchImpl, context) => {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error(`${context}: no fetch implementation available`);
  }
  return doFetch;
};

const requireBaseUrl = (vaultUrl, context) => {
  if (typeof vaultUrl !== 'string' || vaultUrl.trim() === '') {
    throw new Error(`${context}: vaultUrl is required`);
  }
  return vaultUrl.replace(/\/+$/, '');
};

/**
 * Fetches the vault's public health document. Unauthenticated — /healthz is
 * the one endpoint that never requires a token, in either auth mode, so this
 * is safe to call before the user has pasted anything.
 *
 * `authMode` is normalized to 'shared' when the field is absent: servers that
 * predate it are all shared-token servers, so a client can branch on
 * `health.authMode === 'per-account'` against any server version.
 *
 * @param {object} config
 * @param {string} config.vaultUrl - base URL of the GLANCEvault server
 * @param {Function} [config.fetchImpl] - fetch implementation (defaults to global fetch)
 * @returns {Promise<{ status: string, version: string, schemaVersion: number, authMode: 'shared'|'per-account' }>}
 */
export async function fetchVaultHealth({ vaultUrl, fetchImpl } = {}) {
  const base = requireBaseUrl(vaultUrl, 'fetchVaultHealth');
  const doFetch = resolveFetch(fetchImpl, 'fetchVaultHealth');
  const res = await doFetch(`${base}/healthz`, { method: 'GET', headers: {} });
  if (!res.ok) {
    throw new VaultError(`health check failed: ${res.status}`, res.status);
  }
  const body = await res.json();
  return {
    ...body,
    authMode: typeof body.authMode === 'string' ? body.authMode : 'shared',
  };
}

/**
 * Enrolls this device with a per-account vault: exchanges the admin-configured
 * bootstrap secret for the device's own credential (POST /enroll). The secret
 * rides in the request body, never the query string (query strings appear in
 * proxy logs), and no Authorization header is sent — the secret IS this
 * route's authentication.
 *
 * The returned `credential` appears in the response ONCE and is never
 * retrievable again (the server stores only a hash). Callers must persist it
 * and then DISCARD the bootstrap secret: nothing ever asks for the secret
 * again, and a device that loses its credential simply re-enrolls — every
 * successful call mints a fresh credential. Pass the credential as
 * `vaultToken` to createVaultClient / the DB engine; the wire shape of scoped
 * calls is unchanged.
 *
 * Typed failures:
 *  - `ENROLLMENT_REJECTED` (401): the server did not accept the secret.
 *  - `ENROLLMENT_UNSUPPORTED` (404): the server does not offer enrollment —
 *    it runs shared auth mode (the route is registration-gated off) or
 *    predates per-account auth. Check fetchVaultHealth().authMode first to
 *    distinguish this up front.
 *  - `VAULT_ERROR` with `status` for any other non-2xx response.
 *
 * @param {object} config
 * @param {string} config.vaultUrl - base URL of the GLANCEvault server
 * @param {string} config.enrollmentSecret - the admin-configured bootstrap secret
 * @param {string} config.accountId - account to bind the credential to
 * @param {string} config.deviceId - stable identifier for this device
 * @param {Function} [config.fetchImpl] - fetch implementation (defaults to global fetch)
 * @returns {Promise<{ credentialId: string, credential: string, accountId: string, deviceId: string, createdAt: string }>}
 */
export async function enrollVaultDevice({ vaultUrl, enrollmentSecret, accountId, deviceId, fetchImpl } = {}) {
  const base = requireBaseUrl(vaultUrl, 'enrollVaultDevice');
  const doFetch = resolveFetch(fetchImpl, 'enrollVaultDevice');

  // Fail typed and off the wire on missing fields, like requireAccountId: the
  // server rejects them with a 400 anyway, but a client-side throw is clearer
  // and never puts a malformed enrollment on the network. Values are sent
  // byte-exact — validation only rejects missing/whitespace-only input, it
  // never trims what goes on the wire (matching the server's semantics).
  const requireField = (value, name, code) => {
    if (typeof value !== 'string' || value.trim() === '') {
      const err = new Error(`enrollVaultDevice: ${name} is required but was missing or empty.`);
      err.code = code;
      throw err;
    }
  };
  requireField(enrollmentSecret, 'enrollmentSecret', 'ENROLLMENT_SECRET_REQUIRED');
  requireField(accountId, 'accountId', 'ACCOUNT_ID_REQUIRED');
  requireField(deviceId, 'deviceId', 'DEVICE_ID_REQUIRED');

  const res = await doFetch(`${base}/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollmentSecret, accountId, deviceId }),
  });

  if (res.status === 401) {
    const err = new VaultError('enroll failed: enrollment secret rejected', 401);
    err.code = 'ENROLLMENT_REJECTED';
    throw err;
  }
  if (res.status === 404) {
    // Express's default 404: the /enroll route is only registered in
    // per-account mode, so this server cannot enroll anyone.
    const err = new VaultError('enroll failed: this server does not offer enrollment (shared auth mode?)', 404);
    err.code = 'ENROLLMENT_UNSUPPORTED';
    throw err;
  }
  if (!res.ok) {
    throw new VaultError(`enroll failed: ${res.status}`, res.status);
  }
  return res.json();
}

/**
 * Creates a vault client bound to a server URL and token.
 *
 * @param {object} config
 * @param {string} config.vaultUrl   - base URL of the GLANCEvault server
 * @param {string} config.vaultToken - Bearer token: the shared device token
 *   (shared mode) or this device's enrolled credential (per-account mode)
 * @param {Function} [config.fetchImpl] - fetch implementation (defaults to global fetch)
 */
export function createVaultClient({ vaultUrl, vaultToken, fetchImpl } = {}) {
  const base = requireBaseUrl(vaultUrl, 'createVaultClient');
  if (!vaultToken) throw new Error('createVaultClient: vaultToken is required');
  const doFetch = resolveFetch(fetchImpl, 'createVaultClient');
  const authHeaders = (extra = {}) => ({
    Authorization: `Bearer ${vaultToken}`,
    ...extra,
  });

  const request = async (method, path, { body, query } = {}) => {
    let url = base + path;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += `?${qs}`;
    }
    const init = { method, headers: authHeaders() };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await doFetch(url, init);
    return res;
  };

  // Error-body inspection is BEST-EFFORT and deliberately narrow. The server
  // made the 401 body wording the only signal separating shared mode's
  // "invalid device token" (server misconfigured / wrong token) from
  // per-account mode's "invalid credential" (this device must re-enroll —
  // a Phase 2.2 recovery flow; nothing in this package re-enrolls). Only that
  // exact wording upgrades the code to CREDENTIAL_INVALID; a missing,
  // non-JSON, or unrecognized body degrades to the generic VAULT_ERROR, so
  // the client's correctness never depends on server wording.
  const errorFromResponse = async (res, context) => {
    let body = null;
    let bodyError = null;
    try {
      body = await res.json();
      if (body && typeof body.error === 'string') bodyError = body.error;
    } catch {
      // Empty or non-JSON error body: keep the generic classification.
    }
    if (res.status === 401 && bodyError === 'invalid credential') {
      const err = new VaultError(`${context} failed: 401 — the server rejected this device's credential`, 401);
      err.code = 'CREDENTIAL_INVALID';
      return err;
    }
    const quota = parseQuotaBody(res.status, body, bodyError);
    if (quota) {
      const err = new VaultError(
        `${context} failed: ${res.status} — ${quota.quota} quota exceeded (${quota.used} of ${quota.limit}, requested ${quota.requested})`,
        res.status
      );
      err.code = 'QUOTA_EXCEEDED';
      err.quota = quota;
      return err;
    }
    return new VaultError(`${context} failed: ${res.status}`, res.status);
  };

  const jsonOrThrow = async (res, context) => {
    if (!res.ok) {
      throw await errorFromResponse(res, context);
    }
    return res.json();
  };

  // accountId scopes every row-scoped endpoint (batch, list, single-row GET,
  // DELETE, device). The server has no default and rejects a missing/empty value
  // with a cryptic 400 {"error":"accountId is required"}. Validate it here so a
  // caller that fires before the account id is populated (e.g. the key verifier
  // running during reconstruction) fails with a clear, typed, retryable error
  // and we never put a malformed `?accountId=` on the wire.
  const requireAccountId = (accountId, context) => {
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      const err = new Error(`${context}: accountId is required but was missing or empty.`);
      err.code = 'ACCOUNT_ID_REQUIRED';
      throw err;
    }
  };

  return {
    /**
     * Upserts a batch of rows. Each row is { entityId, envelope, createdAt }.
     * @returns {Promise<{ written: number, maxSeq: number }>}
     */
    async batch(app, { accountId, rows }) {
      requireAccountId(accountId, 'batch upsert');
      const res = await request('POST', `/sync/${encodeURIComponent(app)}/batch`, {
        body: { accountId, rows },
      });
      return jsonOrThrow(res, 'batch upsert');
    },

    /**
     * Fetches rows changed since `since` (a seq). One page per call.
     * @returns {Promise<{ rows: Array, hasMore: boolean }>}
     */
    async list(app, { accountId, since }) {
      requireAccountId(accountId, 'list');
      const res = await request('GET', `/sync/${encodeURIComponent(app)}/list`, {
        query: { accountId, since: String(since) },
      });
      return jsonOrThrow(res, 'list');
    },

    /**
     * Fetches a single row by entityId. Returns null on 404.
     */
    async getRow(app, entityId, accountId) {
      requireAccountId(accountId, 'get row');
      const res = await request('GET', `/sync/${encodeURIComponent(app)}/${encodeURIComponent(entityId)}`, {
        query: { accountId },
      });
      if (res.status === 404) return null;
      return jsonOrThrow(res, 'get row');
    },

    /**
     * Soft-deletes a row by entityId. Returns the server response (may include
     * the new seq for the tombstone).
     *
     * opts.deletedAt (epoch ms) stamps the tombstone so pulling devices can
     * resolve delete-vs-edit conflicts with LWW. It rides as a query param, so
     * servers that predate the stamp simply ignore it (their tombstones come
     * back without deletedAt and the engine falls back to delete-wins).
     */
    async deleteRow(app, entityId, accountId, opts = {}) {
      requireAccountId(accountId, 'delete row');
      const query = { accountId };
      if (opts && opts.deletedAt != null) query.deletedAt = String(opts.deletedAt);
      const res = await request('DELETE', `/sync/${encodeURIComponent(app)}/${encodeURIComponent(entityId)}`, {
        query,
      });
      if (res.status === 404) return null;
      return jsonOrThrow(res, 'delete row');
    },

    /**
     * Updates this device's cursor. Best-effort: callers should not let a
     * failure here abort the sync cycle.
     * @returns {Promise<{ updated: boolean }>}
     */
    async device(app, { accountId, deviceId, lastSeenSeq }) {
      requireAccountId(accountId, 'device cursor');
      const res = await request('POST', `/sync/${encodeURIComponent(app)}/device`, {
        body: { accountId, deviceId, lastSeenSeq },
      });
      return jsonOrThrow(res, 'device cursor');
    },

    /**
     * Fetches the account's root-key salt. Returns a Uint8Array, or null if no
     * salt is registered yet (404).
     */
    async getSalt(accountId) {
      const res = await request('GET', `/salt/${encodeURIComponent(accountId)}`);
      if (res.status === 404) return null;
      const body = await jsonOrThrow(res, 'get salt');
      return body && body.salt ? fromBase64(body.salt) : null;
    },

    /**
     * Registers a salt (first-write-wins). Returns whatever salt the server has
     * stored as a Uint8Array, which may differ from the one sent if another
     * device registered first.
     *
     * @param {string} accountId
     * @param {Uint8Array} salt
     * @returns {Promise<Uint8Array>}
     */
    async putSalt(accountId, salt) {
      const res = await request('PUT', `/salt/${encodeURIComponent(accountId)}`, {
        body: { salt: toBase64(salt) },
      });
      const body = await jsonOrThrow(res, 'put salt');
      return body && body.salt ? fromBase64(body.salt) : salt;
    },
  };
}
