// Client-side encryption for cloud sync and remote backup files.
// Uses Web Crypto API exclusively — no external dependencies.
// Architecture: passphrase → PBKDF2 → AES-256-GCM key → encrypts JSON blob.
//
// Parameterizations vs. dayGLANCE original:
//   - KEY_DB_NAME is now passed as `cryptoDBName` (no hardcoded app name)
//   - Android Keystore detection uses injected `nativeGetSyncKey` function
//     instead of probing window globals by name

// ---------------------------------------------------------------------------
// Session state (in-memory only, never persisted)
// ---------------------------------------------------------------------------
let _sessionPassphrase = null; // string | null
let _sessionKey = null;        // CryptoKey | null
let _sessionSalt = null;       // Uint8Array | null — the salt used to derive _sessionKey

export function setSyncPassphrase(p) { _sessionPassphrase = p; }
export function getSyncPassphrase()  { return _sessionPassphrase; }
export function hasEncryptionReady() { return _sessionKey !== null; }

// ---------------------------------------------------------------------------
// IndexedDB key store
// ---------------------------------------------------------------------------
const KEY_DB_VERSION = 1;
const KEY_STORE      = 'keys';
const SYNC_KEY_ID    = 'sync-key';

function openKeyDB(cryptoDBName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(cryptoDBName, KEY_DB_VERSION);
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

async function saveKeyToIndexedDB(cryptoDBName, cryptoKey, salt) {
  const db     = await openKeyDB(cryptoDBName);
  const rawKey = await crypto.subtle.exportKey('raw', cryptoKey);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.objectStore(KEY_STORE).put({ id: SYNC_KEY_ID, rawKey, salt: Array.from(salt) });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadKeyFromIndexedDB(cryptoDBName) {
  try {
    const db     = await openKeyDB(cryptoDBName);
    const record = await new Promise((resolve, reject) => {
      const tx  = db.transaction(KEY_STORE, 'readonly');
      const req = tx.objectStore(KEY_STORE).get(SYNC_KEY_ID);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    if (!record) return null;
    const key = await crypto.subtle.importKey(
      'raw', record.rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    return { key, salt: new Uint8Array(record.salt) };
  } catch {
    return null;
  }
}

async function clearKeyFromIndexedDB(cryptoDBName) {
  try {
    const db = await openKeyDB(cryptoDBName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).delete(SYNC_KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Android Keystore bridge
// ---------------------------------------------------------------------------
// The native bridge is injected as a function reference rather than probing
// window globals by name — no app-specific global detection here.

async function loadKeyFromNative(nativeGetSyncKey) {
  try {
    const b64 = await nativeGetSyncKey();
    if (!b64) return null;
    const record = JSON.parse(atob(b64));
    const key = await crypto.subtle.importKey(
      'raw', new Uint8Array(record.rawKey), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    return { key, salt: new Uint8Array(record.salt) };
  } catch {
    return null;
  }
}

async function saveKeyToNative(nativeStoreSyncKey, cryptoKey, salt) {
  if (!nativeStoreSyncKey) return;
  const rawKey = await crypto.subtle.exportKey('raw', cryptoKey);
  const record = { rawKey: Array.from(new Uint8Array(rawKey)), salt: Array.from(salt) };
  nativeStoreSyncKey(btoa(JSON.stringify(record)));
}

async function clearKeyFromNative(nativeStoreSyncKey) {
  try {
    if (nativeStoreSyncKey) {
      nativeStoreSyncKey(null);
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// PBKDF2 key derivation
// ---------------------------------------------------------------------------
async function deriveKey(passphrase, salt) {
  const enc         = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// Public lifecycle API
// ---------------------------------------------------------------------------

/**
 * Called on app load. Attempts to restore the session key from device storage
 * (IndexedDB on browser, native bridge on mobile) without requiring the user
 * to re-enter their passphrase.
 *
 * @param {object} config
 * @param {string} config.cryptoDBName  - IndexedDB database name for key storage
 * @param {Function|null} [config.nativeGetSyncKey]  - native bridge getter (Android Keystore)
 * @returns {Promise<boolean>} true if key was restored, false if passphrase required
 */
export async function initSessionKey({ cryptoDBName, nativeGetSyncKey = null } = {}) {
  try {
    let result;
    if (nativeGetSyncKey != null) {
      result = await loadKeyFromNative(nativeGetSyncKey);
    } else {
      result = await loadKeyFromIndexedDB(cryptoDBName);
    }
    if (result) {
      _sessionKey  = result.key;
      _sessionSalt = result.salt;
      return true;
    }
  } catch { /* storage unavailable */ }
  return false;
}

/**
 * First-time setup on a fresh device: derives a key from the passphrase with a
 * freshly generated salt and caches it in device storage.
 * Call this when the user configures encryption for the first time.
 *
 * @param {string} passphrase
 * @param {object} config
 * @param {string} config.cryptoDBName
 * @param {Function|null} [config.nativeGetSyncKey]
 * @param {Function|null} [config.nativeStoreSyncKey]
 */
export async function setupEncryptionKey(passphrase, { cryptoDBName, nativeGetSyncKey = null, nativeStoreSyncKey = null } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveKey(passphrase, salt);
  _sessionPassphrase = passphrase;
  _sessionSalt       = salt;
  if (nativeGetSyncKey != null) {
    await saveKeyToNative(nativeStoreSyncKey, key, salt);
  } else {
    await saveKeyToIndexedDB(cryptoDBName, key, salt);
  }
  // Re-import as non-extractable so the live in-memory key cannot be exported via Web Crypto API.
  const rawKey = await crypto.subtle.exportKey('raw', key);
  _sessionKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

/**
 * Clears the cached key from device storage and session memory.
 * Call this when the user disables encryption.
 *
 * @param {object} config
 * @param {string} config.cryptoDBName
 * @param {Function|null} [config.nativeGetSyncKey]
 * @param {Function|null} [config.nativeStoreSyncKey]
 */
export async function clearEncryptionKey({ cryptoDBName, nativeGetSyncKey = null, nativeStoreSyncKey = null } = {}) {
  _sessionPassphrase = null;
  _sessionKey        = null;
  _sessionSalt       = null;
  if (nativeGetSyncKey != null) {
    await clearKeyFromNative(nativeStoreSyncKey);
  } else {
    await clearKeyFromIndexedDB(cryptoDBName);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function packBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let   offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function toBase64(bytes) {
  // Chunk to avoid "Maximum call stack size exceeded" for large payloads —
  // spreading a large Uint8Array as function arguments hits the engine's
  // argument-count limit (~65 K in V8).
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypts a plain JS object and returns an envelope object ready for JSON.stringify.
 *
 * Envelope format:
 *   { v: 1, enc: "AES-GCM-256", data: "<base64>" }
 *
 * The base64 blob encodes:
 *   [ 16 bytes: PBKDF2 salt ] [ 12 bytes: AES-GCM IV ] [ N bytes: ciphertext ]
 *
 * @param {object} data - plain JS object to encrypt
 * @param {object} config
 * @param {string} config.cryptoDBName
 * @param {Function|null} [config.nativeGetSyncKey]
 * @param {Function|null} [config.nativeStoreSyncKey]
 */
export async function encryptData(data, config = {}) {
  // First use: lazily set up the key so the caller doesn't need to distinguish
  // between "first device" and "subsequent upload" scenarios.
  if (!_sessionKey) {
    if (_sessionPassphrase) {
      await setupEncryptionKey(_sessionPassphrase, config);
    } else {
      throw new Error('Encryption key not available. Please enter your sync passphrase.');
    }
  }

  const plaintext  = new TextEncoder().encode(JSON.stringify(data));
  const iv         = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _sessionKey, plaintext);

  const packed = packBytes(_sessionSalt, iv, new Uint8Array(ciphertext));
  return { v: 1, enc: 'AES-GCM-256', data: toBase64(packed) };
}

/**
 * Decrypts an envelope object produced by encryptData.
 * Throws on wrong passphrase, tampered data, or missing key.
 *
 * Cross-device recovery path: if no cached key but _sessionPassphrase is set,
 * derives the key from the passphrase + salt embedded in the ciphertext, then
 * caches it in device storage for future sessions.
 *
 * @param {object} envelope - encrypted envelope from encryptData
 * @param {object} config
 * @param {string} config.cryptoDBName
 * @param {Function|null} [config.nativeGetSyncKey]
 * @param {Function|null} [config.nativeStoreSyncKey]
 */
export async function decryptData(envelope, config = {}) {
  if (!envelope || !envelope.data) throw new Error('Invalid encrypted envelope');
  if (envelope.v !== 1) throw new Error(`Unknown encryption version: ${envelope.v}`);

  const packed     = fromBase64(envelope.data);
  const salt       = packed.slice(0, 16);
  const iv         = packed.slice(16, 28);
  const ciphertext = packed.slice(28);

  let key = _sessionKey;

  // If the cached key was derived from a different salt (e.g. user re-configured
  // encryption, generating a new salt), it cannot decrypt this file. Force
  // re-derivation so the file's embedded salt always dictates which key is used.
  if (key && _sessionSalt) {
    const saltMatch = salt.length === _sessionSalt.length &&
      salt.every((b, i) => b === _sessionSalt[i]);
    if (!saltMatch) key = null;
  }

  let keyWasDerived = false;
  if (!key) {
    if (_sessionPassphrase) {
      // Cross-device recovery or salt mismatch: derive key from passphrase + salt from file.
      // Do NOT cache yet — only persist after we confirm the key actually decrypts the file.
      key = await deriveKey(_sessionPassphrase, salt);
      keyWasDerived = true;
    } else {
      const err = new Error('Encryption key not available. Please enter your sync passphrase.');
      err.code = 'PASSPHRASE_REQUIRED';
      throw err;
    }
  }

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    // Decryption succeeded — safe to promote and cache the derived key.
    if (keyWasDerived) {
      _sessionKey  = key;
      _sessionSalt = salt;
      const { nativeGetSyncKey = null, nativeStoreSyncKey = null, cryptoDBName } = config;
      if (nativeGetSyncKey != null) {
        await saveKeyToNative(nativeStoreSyncKey, key, salt);
      } else {
        await saveKeyToIndexedDB(cryptoDBName, key, salt);
      }
    }
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (err) {
    if (err.name === 'OperationError') {
      throw new Error('Decryption failed — wrong passphrase or corrupted data.');
    }
    throw err;
  }
}

/**
 * Returns true if the value looks like an encrypted envelope produced by
 * encryptData. Used to decide whether to call decryptData on downloaded files.
 */
export function isEncryptedEnvelope(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.v === 1 &&
    value.enc === 'AES-GCM-256' &&
    typeof value.data === 'string'
  );
}
