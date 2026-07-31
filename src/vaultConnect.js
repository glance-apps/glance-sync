// The packaged vault connect flow (vault Phase 1.4b).
//
// This is the front door for building a DB sync engine against a GLANCEvault
// server without the app implementing auth-mode discovery, enrollment,
// credential persistence, or bootstrap-secret discard itself. The app hands
// over whatever it has — the shared device token, a bootstrap secret, or
// nothing beyond a previously connected state — and gets a working engine
// back:
//
//   1. DISCOVER  GET /healthz (unauthenticated) → 'shared' | 'per-account'.
//                A missing authMode field means shared (every server that
//                predates the field is a shared-token server), so version
//                skew is an ordinary case, not an error.
//   2. BRANCH    shared      → use config.vaultToken, exactly as before 1.4b.
//                per-account → use the persisted credential; enroll with the
//                bootstrap secret only when no credential is stored yet.
//   3. ENROLL    POST /enroll, then persist the credential DURABLY before
//                treating enrollment as complete (enrollment is
//                non-idempotent — every call mints a server row).
//   4. BUILD     createDbSyncEngine with the resolved Bearer value.
//
// SECRET LIFETIME: the bootstrap secret exists inside this module only as the
// `enrollmentSecret` binding for the duration of one connectVaultSyncEngine
// call. It is sent in the enroll request body and nowhere else: never written
// to any storage, never placed on the engine config, never logged, never
// retained. When the call returns, the package holds no reference. (The app
// still owns the copy it passed in — dropping that is the app's one remaining
// obligation.)
//
// NO AUTOMATIC RE-ENROLLMENT, on any path. Once a credential is stored for
// this (server, account), this flow always uses it and never enrolls again —
// even when the credential has been rejected and the engine is halted
// (CREDENTIAL_INVALID). Re-enrolling on failure would mint a credential row
// per attempt and would let a revoked device silently re-admit itself, which
// is exactly what revocation (vault Phase 2.1) must be able to prevent.
// Recovery from a rejected credential is Phase 2.2.

import { fetchVaultHealth, enrollVaultDevice } from './vaultClient.js';
import { createDbSyncEngine, getOrCreateDeviceId } from './dbEngine.js';

const typedError = (message, code) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

// Byte-exact everywhere: validation only rejects missing/whitespace-only
// values, it never trims or normalizes what is stored or sent. Whitespace-
// distinct account ids are distinct live accounts on the server.
const requireString = (value, name, code) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw typedError(`connectVaultSyncEngine: ${name} is required but was missing or empty.`, code);
  }
};

/**
 * Discovers the server's auth mode, resolves the Bearer value for this device
 * (enrolling if the server is per-account and no credential is stored yet),
 * and returns a ready sync engine.
 *
 * Config is DbSyncEngineConfig plus:
 * @param {string} [config.enrollmentSecret] - bootstrap secret for first-time
 *   enrollment against a per-account server. Ignored (and not needed) once a
 *   credential is stored. See SECRET LIFETIME above.
 * @param {string} [config.vaultToken] - the shared device token. Required
 *   when the server runs shared mode; ignored against a per-account server
 *   (the shared token authenticates nothing there).
 *
 * Typed failures:
 *  - VAULT_TOKEN_REQUIRED: server is shared-mode and no vaultToken was given.
 *  - ENROLLMENT_SECRET_REQUIRED: server is per-account, no credential is
 *    stored, and no enrollmentSecret was given.
 *  - CREDENTIAL_PERSIST_FAILED: device storage rejected the credential write.
 *    When storage is detectably broken this is raised BEFORE enrolling, so a
 *    client with broken storage does not mint a credential row per launch.
 *  - VAULT_UNREACHABLE: discovery failed and there is no stored credential
 *    and no vaultToken to fall back on.
 *  - Plus everything enrollVaultDevice can throw (ENROLLMENT_REJECTED, ...).
 *
 * @returns {Promise<{ engine: object, authMode: 'shared'|'per-account'|null,
 *   enrolled: boolean, deviceId: string }>}
 *   authMode is null when discovery failed and the flow fell back to the last
 *   known state; `enrolled` is true only when this call minted a credential.
 */
export async function connectVaultSyncEngine(config = {}) {
  // The secret is destructured OFF the config here so the object handed to
  // createDbSyncEngine below can never carry it.
  const { enrollmentSecret, ...engineConfig } = config;
  const { storageKeyPrefix, vaultUrl, vaultToken, accountId, fetchImpl } = engineConfig;

  requireString(storageKeyPrefix, 'storageKeyPrefix', 'STORAGE_KEY_PREFIX_REQUIRED');
  requireString(vaultUrl, 'vaultUrl', 'VAULT_URL_REQUIRED');
  requireString(accountId, 'accountId', 'ACCOUNT_ID_REQUIRED');

  // Same normalization the vault client applies to every request URL, so the
  // stored credential's server binding survives a trailing-slash difference.
  const base = vaultUrl.replace(/\/+$/, '');
  const deviceId = engineConfig.deviceId || getOrCreateDeviceId(storageKeyPrefix);
  const KEY_CREDENTIAL = `${storageKeyPrefix}-vault-credential`;

  // A stored credential is only usable for the exact (server, account) it was
  // minted for: the server binds it to an account and 403s any other claim.
  const readStoredCredential = () => {
    const raw = localStorage.getItem(KEY_CREDENTIAL);
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw);
      return rec && rec.credential && rec.vaultUrl === base && rec.accountId === accountId ? rec : null;
    } catch {
      return null;
    }
  };

  // 1. Discover. Failure (unreachable, non-JSON, non-2xx) is not fatal here:
  // an offline launch must behave exactly as pre-1.4b — build the engine from
  // whatever auth state exists and let the first sync surface any error.
  let authMode = null;
  try {
    const health = await fetchVaultHealth({ vaultUrl: base, fetchImpl });
    // Only the two known modes are acted on; a future unknown mode string
    // falls through to the last-known-state path rather than being guessed at.
    if (health.authMode === 'shared' || health.authMode === 'per-account') {
      authMode = health.authMode;
    }
  } catch {
    authMode = null;
  }

  const stored = readStoredCredential();
  let token;
  let enrolled = false;

  if (authMode === 'per-account') {
    if (stored) {
      token = stored.credential;
    } else {
      // First contact with a per-account server: enrollment needs the secret.
      // The shared token is deliberately NOT a fallback — it authenticates
      // nothing on this server and sending it just produces a confusing 401.
      if (typeof enrollmentSecret !== 'string' || enrollmentSecret.trim() === '') {
        throw typedError(
          'connectVaultSyncEngine: this server requires per-device enrollment and no credential is stored — pass enrollmentSecret.',
          'ENROLLMENT_SECRET_REQUIRED'
        );
      }

      // Storage canary BEFORE minting: enrollment is non-idempotent, so if
      // device storage cannot hold the credential we must find out before the
      // server creates a row, not after. (A crash between mint and persist
      // can still orphan one row; broken storage must not orphan one per
      // launch.)
      const canary = JSON.stringify({ canary: true });
      try {
        localStorage.setItem(KEY_CREDENTIAL, canary);
        if (localStorage.getItem(KEY_CREDENTIAL) !== canary) throw new Error('read-back mismatch');
        localStorage.removeItem(KEY_CREDENTIAL);
      } catch {
        throw typedError(
          'connectVaultSyncEngine: device storage cannot persist a credential; refusing to enroll.',
          'CREDENTIAL_PERSIST_FAILED'
        );
      }

      const enrollment = await enrollVaultDevice({
        vaultUrl: base,
        enrollmentSecret,
        accountId,
        deviceId,
        fetchImpl,
      });

      // Persist durably, then read back and verify, BEFORE treating
      // enrollment as complete. Only the credential and its metadata are
      // written — the secret is not part of this record.
      const record = {
        credentialId: enrollment.credentialId,
        credential: enrollment.credential,
        accountId,
        deviceId,
        vaultUrl: base,
        createdAt: enrollment.createdAt,
      };
      try {
        localStorage.setItem(KEY_CREDENTIAL, JSON.stringify(record));
        const readBack = JSON.parse(localStorage.getItem(KEY_CREDENTIAL));
        if (!readBack || readBack.credential !== enrollment.credential) throw new Error('read-back mismatch');
      } catch {
        throw typedError(
          'connectVaultSyncEngine: enrolled but could not persist the credential; not treating enrollment as complete.',
          'CREDENTIAL_PERSIST_FAILED'
        );
      }

      token = enrollment.credential;
      enrolled = true;
    }
  } else if (authMode === 'shared') {
    // The default path, unchanged from today. A stored credential from an
    // earlier per-account life of this server is ignored (never sent to a
    // shared-mode server) but kept in storage in case the operator switches
    // back.
    if (typeof vaultToken !== 'string' || vaultToken.trim() === '') {
      throw typedError(
        'connectVaultSyncEngine: this server uses a shared device token — pass vaultToken.',
        'VAULT_TOKEN_REQUIRED'
      );
    }
    token = vaultToken;
  } else {
    // Discovery failed: fall back to the last known auth state, which is
    // byte-for-byte the pre-1.4b behavior for existing installs (build with
    // the token you have; the first sync surfaces any real problem).
    token = stored ? stored.credential : vaultToken;
    if (typeof token !== 'string' || token.trim() === '') {
      throw typedError(
        `connectVaultSyncEngine: could not reach ${base}/healthz and no stored credential or vaultToken exists to fall back on.`,
        'VAULT_UNREACHABLE'
      );
    }
  }

  const engine = createDbSyncEngine({ ...engineConfig, deviceId, vaultToken: token });
  return { engine, authMode, enrolled, deviceId };
}
