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
//   DELETE /sync/:app/:entityId?accountId=       soft-delete a row
//   POST   /sync/:app/device                     update device cursor, { updated }
//   GET    /salt/:accountId                      fetch the account root-key salt
//   PUT    /salt/:accountId                      register a salt (first-write-wins)
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

/**
 * Creates a vault client bound to a server URL and token.
 *
 * @param {object} config
 * @param {string} config.vaultUrl   - base URL of the GLANCEvault server
 * @param {string} config.vaultToken - Bearer token
 * @param {Function} [config.fetchImpl] - fetch implementation (defaults to global fetch)
 */
export function createVaultClient({ vaultUrl, vaultToken, fetchImpl } = {}) {
  if (!vaultUrl)   throw new Error('createVaultClient: vaultUrl is required');
  if (!vaultToken) throw new Error('createVaultClient: vaultToken is required');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('createVaultClient: no fetch implementation available');
  }

  const base = vaultUrl.replace(/\/+$/, '');
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

  const jsonOrThrow = async (res, context) => {
    if (!res.ok) {
      throw new VaultError(`${context} failed: ${res.status}`, res.status);
    }
    return res.json();
  };

  return {
    /**
     * Upserts a batch of rows. Each row is { entityId, ciphertext, createdAt }.
     * @returns {Promise<{ written: number, maxSeq: number }>}
     */
    async batch(app, { accountId, rows }) {
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
      const res = await request('GET', `/sync/${encodeURIComponent(app)}/list`, {
        query: { accountId, since: String(since) },
      });
      return jsonOrThrow(res, 'list');
    },

    /**
     * Fetches a single row by entityId. Returns null on 404.
     */
    async getRow(app, entityId, accountId) {
      const res = await request('GET', `/sync/${encodeURIComponent(app)}/${encodeURIComponent(entityId)}`, {
        query: { accountId },
      });
      if (res.status === 404) return null;
      return jsonOrThrow(res, 'get row');
    },

    /**
     * Soft-deletes a row by entityId. Returns the server response (may include
     * the new seq for the tombstone).
     */
    async deleteRow(app, entityId, accountId) {
      const res = await request('DELETE', `/sync/${encodeURIComponent(app)}/${encodeURIComponent(entityId)}`, {
        query: { accountId },
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
