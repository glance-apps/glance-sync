// Per-entity encryption for the database sync transport (Phase 3).
//
// The file-tier transport (crypto.js) encrypts the entire entity array as one
// AES-GCM blob. The database transport instead encrypts one entity at a time so
// that each row on GLANCEvault is an independent ciphertext that can be fetched,
// upserted, and decrypted on its own.
//
// Crypto design (mirrors the per-envelope pattern in @glance-apps/intents):
//   1. A single root key is derived once from the passphrase with PBKDF2
//      (SHA-256, 310 000 iterations) using a per-account salt fetched from the
//      GLANCEvault salt endpoint. This matches the file-tier derivation cost.
//   2. Per entity, an AES-256-GCM key is HKDF-derived from the root key using
//      the entityId as the HKDF info context. HKDF is cheap, so deriving a fresh
//      key per row is fast (no extra PBKDF2 work per entity).
//   3. Each entity is encrypted with a fresh 12-byte IV. The stored ciphertext
//      is base64(IV || AES-GCM output).
//
// This module is entirely additive: it does not import from, modify, or share
// mutable state with crypto.js beyond reading the shared session passphrase,
// which the engine wires up via getSyncPassphrase().

const PBKDF2_ITERATIONS = 310_000;
const ROOT_KEY_BYTES    = 32; // 256 bits
const IV_BYTES          = 12;

// HKDF info prefix. Namespacing the entityId keeps these derivations distinct
// from any other HKDF use of the same root key.
const HKDF_INFO_PREFIX = 'glance-sync:entity:';

// ---------------------------------------------------------------------------
// Engine-reserved entities
// ---------------------------------------------------------------------------
// Rows whose entityId starts with this prefix are owned by the sync engine
// itself (e.g. the key verifier) and are NOT app entities: they must never be
// routed to getLocalEntity / applyRemoteEntity.
export const RESERVED_ENTITY_PREFIX = '__glance_';

// The key-verifier row. Its decryptability under the derived root key is the
// signal the engine uses to prove a passphrase matches an account's data.
export const KEYCHECK_ENTITY_ID = '__glance_keycheck';

// Any fixed known plaintext works: AES-GCM tag validation means a wrong key
// fails to decrypt regardless of contents, so decryption SUCCESS is the signal.
export const KEYCHECK_PAYLOAD = { v: 1, magic: 'glance-keycheck' };

/** True for engine-reserved rows (e.g. the key verifier), which apps never see. */
export function isReservedEntityId(entityId) {
  return typeof entityId === 'string' && entityId.startsWith(RESERVED_ENTITY_PREFIX);
}

// ---------------------------------------------------------------------------
// Session state (in-memory only, never persisted in plaintext)
// ---------------------------------------------------------------------------
let _rootKey = null; // CryptoKey | null  (an HKDF base key, non-extractable)

export function hasDbRootKey() { return _rootKey !== null; }
export function getDbRootKey()  { return _rootKey; }

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------
function packBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let   offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

export function toBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

// Derives the raw 32-byte root key from a passphrase and salt using the same
// PBKDF2 parameters as the file-tier crypto. Returned as raw bytes so the
// caller can persist them in device storage; HKDF base keys are non-extractable
// and cannot be re-exported once imported.
async function deriveRootBits(passphrase, salt) {
  const enc         = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    ROOT_KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

// Imports raw root bytes as a non-extractable HKDF base key usable only to
// derive per-entity keys.
async function importRootKey(rootBytes) {
  return crypto.subtle.importKey('raw', rootBytes, 'HKDF', false, ['deriveKey']);
}

// HKDF-derives a fresh AES-256-GCM key from the root key, scoped to one entity.
async function deriveEntityKey(rootKey, entityId) {
  const enc = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: enc.encode(HKDF_INFO_PREFIX + entityId),
    },
    rootKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// Root key lifecycle (storage parallels crypto.js but uses its own DB/record)
// ---------------------------------------------------------------------------
const KEY_DB_VERSION = 1;
const KEY_STORE      = 'db-root-keys';
const ROOT_KEY_ID    = 'db-root-key';

function openRootKeyDB(cryptoDBName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`${cryptoDBName}-db`, KEY_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

async function saveRootToIndexedDB(cryptoDBName, rootBytes, salt) {
  const db = await openRootKeyDB(cryptoDBName);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.objectStore(KEY_STORE).put({
      id: ROOT_KEY_ID,
      rootBytes: Array.from(rootBytes),
      salt: Array.from(salt),
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadRootFromIndexedDB(cryptoDBName) {
  try {
    const db     = await openRootKeyDB(cryptoDBName);
    const record = await new Promise((resolve, reject) => {
      const tx  = db.transaction(KEY_STORE, 'readonly');
      const req = tx.objectStore(KEY_STORE).get(ROOT_KEY_ID);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    if (!record) return null;
    return { rootBytes: new Uint8Array(record.rootBytes), salt: new Uint8Array(record.salt) };
  } catch {
    return null;
  }
}

async function clearRootFromIndexedDB(cryptoDBName) {
  try {
    const db = await openRootKeyDB(cryptoDBName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).delete(ROOT_KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

// Native bridge (Android Keystore) stores the same record as a base64 JSON blob.
async function loadRootFromNative(nativeGetSyncKey) {
  try {
    const b64 = await nativeGetSyncKey();
    if (!b64) return null;
    const record = JSON.parse(atob(b64));
    return { rootBytes: new Uint8Array(record.rootBytes), salt: new Uint8Array(record.salt) };
  } catch {
    return null;
  }
}

async function saveRootToNative(nativeStoreSyncKey, rootBytes, salt) {
  if (!nativeStoreSyncKey) return;
  const record = { rootBytes: Array.from(rootBytes), salt: Array.from(salt) };
  nativeStoreSyncKey(btoa(JSON.stringify(record)));
}

async function clearRootFromNative(nativeStoreSyncKey) {
  try { if (nativeStoreSyncKey) nativeStoreSyncKey(null); }
  catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Public lifecycle API
// ---------------------------------------------------------------------------

/**
 * First-time setup: derive the root key from the passphrase + account salt and
 * cache it in device storage. The salt is provided by the engine (fetched from
 * or registered with the GLANCEvault salt endpoint).
 *
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {object} config
 * @param {string} config.cryptoDBName
 * @param {Function|null} [config.nativeGetSyncKey]
 * @param {Function|null} [config.nativeStoreSyncKey]
 */
export async function setupDbRootKey(passphrase, salt, { cryptoDBName, nativeGetSyncKey = null, nativeStoreSyncKey = null } = {}) {
  const rootBytes = await deriveRootBits(passphrase, salt);
  _rootKey = await importRootKey(rootBytes);
  if (nativeGetSyncKey != null) {
    await saveRootToNative(nativeStoreSyncKey, rootBytes, salt);
  } else {
    await saveRootToIndexedDB(cryptoDBName, rootBytes, salt);
  }
}

/**
 * Restores the root key from device storage without requiring the passphrase.
 * Returns true if a key was restored, false if setup is still required.
 *
 * @param {object} config
 * @param {string} config.cryptoDBName
 * @param {Function|null} [config.nativeGetSyncKey]
 * @returns {Promise<boolean>}
 */
export async function initDbRootKey({ cryptoDBName, nativeGetSyncKey = null } = {}) {
  try {
    const result = nativeGetSyncKey != null
      ? await loadRootFromNative(nativeGetSyncKey)
      : await loadRootFromIndexedDB(cryptoDBName);
    if (result) {
      _rootKey = await importRootKey(result.rootBytes);
      return true;
    }
  } catch { /* storage unavailable */ }
  return false;
}

/**
 * Clears the cached root key from device storage and session memory.
 *
 * @param {object} config
 */
export async function clearDbRootKey({ cryptoDBName, nativeGetSyncKey = null, nativeStoreSyncKey = null } = {}) {
  _rootKey = null;
  if (nativeGetSyncKey != null) {
    await clearRootFromNative(nativeStoreSyncKey);
  } else {
    await clearRootFromIndexedDB(cryptoDBName);
  }
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt a single entity
// ---------------------------------------------------------------------------

/**
 * Encrypts one entity into a base64 ciphertext string for the row's
 * `envelope` field. The output encodes [ 12-byte IV ][ AES-GCM ciphertext ].
 *
 * @param {*} entity        - plain JS value to encrypt (serialised with JSON)
 * @param {string} entityId - stable entity UUID, used as HKDF context
 * @param {CryptoKey} [rootKey] - explicit root key (defaults to the session key)
 * @returns {Promise<string>} base64 ciphertext
 */
export async function encryptEntity(entity, entityId, rootKey = _rootKey) {
  if (!rootKey) {
    const err = new Error('Database root key not available. Please enter your sync passphrase.');
    err.code = 'PASSPHRASE_REQUIRED';
    throw err;
  }
  const key        = await deriveEntityKey(rootKey, entityId);
  const plaintext  = new TextEncoder().encode(JSON.stringify(entity));
  const iv         = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return toBase64(packBytes(iv, new Uint8Array(ciphertext)));
}

/**
 * Decrypts a base64 ciphertext produced by encryptEntity back into the entity.
 *
 * @param {string} ciphertextB64 - the row's `envelope` field
 * @param {string} entityId      - stable entity UUID, used as HKDF context
 * @param {CryptoKey} [rootKey]  - explicit root key (defaults to the session key)
 * @returns {Promise<*>} the decrypted entity
 */
export async function decryptEntity(ciphertextB64, entityId, rootKey = _rootKey) {
  if (!rootKey) {
    const err = new Error('Database root key not available. Please enter your sync passphrase.');
    err.code = 'PASSPHRASE_REQUIRED';
    throw err;
  }
  const packed     = fromBase64(ciphertextB64);
  const iv         = packed.slice(0, IV_BYTES);
  const ciphertext = packed.slice(IV_BYTES);
  const key        = await deriveEntityKey(rootKey, entityId);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (err) {
    if (err.name === 'OperationError') {
      const failure = new Error('Decryption failed: wrong passphrase or corrupted data.');
      failure.code = 'ROW_DECRYPT_FAILED';
      throw failure;
    }
    throw err;
  }
}
