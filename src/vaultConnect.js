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
import {
  createDbSyncEngine,
  getOrCreateDeviceId,
  vaultCredentialKey,
  credentialHaltKey,
} from './dbEngine.js';

const typedError = (message, code) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

// Storage canary: prove the credential slot is writable BEFORE minting.
// Enrollment is non-idempotent, so if device storage cannot hold the
// credential we must find out before the server creates a row, not after.
// (A crash between mint and persist can still orphan one row; since 2.1 the
// next successful enrollment with the same (accountId, deviceId) supersedes
// it, so even that is no longer a live orphan. Broken storage must still not
// orphan one per attempt.)
const ensureCredentialSlotWritable = (key, context) => {
  // The slot's prior contents are RESTORED, not discarded: during recovery
  // the slot holds the stale record, and a failed enrollment after the canary
  // must leave that record exactly as it was (a failed recovery leaves the
  // device halted with its state intact, never ambiguous).
  const prior = localStorage.getItem(key);
  const canary = JSON.stringify({ canary: true });
  try {
    localStorage.setItem(key, canary);
    if (localStorage.getItem(key) !== canary) throw new Error('read-back mismatch');
    if (prior === null) localStorage.removeItem(key);
    else localStorage.setItem(key, prior);
  } catch {
    throw typedError(
      `${context}: device storage cannot persist a credential; refusing to enroll.`,
      'CREDENTIAL_PERSIST_FAILED'
    );
  }
};

// Persist durably, then read back and verify, BEFORE enrollment is treated as
// complete. Overwrites whatever was in the slot — the credential slot holds
// exactly one record, so a stale credential never survives alongside a new
// one. Only the credential and its metadata are written — never the secret.
const persistCredentialRecord = (key, record, context) => {
  try {
    localStorage.setItem(key, JSON.stringify(record));
    const readBack = JSON.parse(localStorage.getItem(key));
    if (!readBack || readBack.credential !== record.credential) throw new Error('read-back mismatch');
  } catch {
    throw typedError(
      `${context}: enrolled but could not persist the credential; not treating enrollment as complete.`,
      'CREDENTIAL_PERSIST_FAILED'
    );
  }
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
  const KEY_CREDENTIAL = vaultCredentialKey(storageKeyPrefix);

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

      ensureCredentialSlotWritable(KEY_CREDENTIAL, 'connectVaultSyncEngine');

      const enrollment = await enrollVaultDevice({
        vaultUrl: base,
        enrollmentSecret,
        accountId,
        deviceId,
        fetchImpl,
      });

      persistCredentialRecord(KEY_CREDENTIAL, {
        credentialId: enrollment.credentialId,
        credential: enrollment.credential,
        accountId,
        deviceId,
        vaultUrl: base,
        createdAt: enrollment.createdAt,
      }, 'connectVaultSyncEngine');

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

/**
 * The exit from the credential halt (Phase 2.2): USER-INITIATED re-enrollment
 * with the bootstrap secret, against a per-account server. Call this only
 * from a deliberate UI action in which the user supplied the secret — never
 * from a startup path, a retry path, or an error handler. Two structural
 * guards enforce that: the package holds no secret (recovery cannot run
 * without one being supplied fresh), and the call REFUSES unless the device
 * is actually halted, so it cannot be wired in as an on-demand rotator.
 *
 * Order of operations — each failure leaves the device HALTED, never
 * ambiguous, and the halt is cleared only after a verified success:
 *   1. halt gate           (NOT_HALTED if the device isn't halted)
 *   2. deviceId resolution (stale record's deviceId is ground truth — see below)
 *   3. mode guard          (per-account only; NO fallback: VAULT_UNREACHABLE /
 *                           RECOVERY_UNSUPPORTED leave everything untouched)
 *   4. storage canary      (CREDENTIAL_PERSIST_FAILED before minting)
 *   5. enroll              (ENROLLMENT_REJECTED etc. leave the halt + stale
 *                           record intact)
 *   6. persist + verify    (overwrites the stale record — it does not survive
 *                           recovery; CREDENTIAL_PERSIST_FAILED leaves the
 *                           halt intact)
 *   7. clear the halt      (the LAST state change)
 *   8. build a fresh engine
 *
 * DEVICE IDENTITY: the stale record's deviceId wins. Recovery's defining
 * property is rotation — the server (Phase 2.1) revokes every still-active
 * predecessor for the same byte-exact (accountId, deviceId) inside the
 * enrollment transaction — and rotation only lands if we enroll under the
 * identity the dead credential is actually bound to, for which the stored
 * record is ground truth. An explicit config.deviceId that DIFFERS from the
 * record is a conflict surfaced as DEVICE_ID_CONFLICT, not resolved
 * silently: either choice would orphan something (a live predecessor or the
 * device's cursor), so the caller decides. With no readable record, the
 * explicit config value, then the persisted package-owned id, fill in.
 *
 * The engine returned is FRESH — the old engine's client closes over the
 * dead credential and must be discarded by the app. If a stale reference
 * survives anyway, its next 401 finds the stored record differs from its
 * bearer and it goes inert in memory instead of re-halting the device (see
 * isBearerSuperseded in dbEngine.js).
 *
 * SECRET LIFETIME: identical to connectVaultSyncEngine — the secret exists
 * as this call's argument, rides once in the enroll request body, and is
 * never stored, logged, placed on the engine config, or retained.
 *
 * @returns {Promise<{ engine: object, authMode: 'per-account',
 *   enrolled: true, deviceId: string }>} — same shape as
 *   connectVaultSyncEngine, so apps can swap their engine reference uniformly.
 */
export async function recoverVaultSyncEngine(config = {}) {
  const { enrollmentSecret, ...engineConfig } = config;
  const { storageKeyPrefix, vaultUrl, accountId, fetchImpl } = engineConfig;

  requireString(storageKeyPrefix, 'storageKeyPrefix', 'STORAGE_KEY_PREFIX_REQUIRED');
  requireString(vaultUrl, 'vaultUrl', 'VAULT_URL_REQUIRED');
  requireString(accountId, 'accountId', 'ACCOUNT_ID_REQUIRED');
  if (typeof enrollmentSecret !== 'string' || enrollmentSecret.trim() === '') {
    throw typedError(
      'recoverVaultSyncEngine: recovery requires the bootstrap secret to be supplied (it is never stored).',
      'ENROLLMENT_SECRET_REQUIRED'
    );
  }

  const base = vaultUrl.replace(/\/+$/, '');
  const KEY_CREDENTIAL = vaultCredentialKey(storageKeyPrefix);
  const KEY_HALT = credentialHaltKey(storageKeyPrefix);

  // 1. Halt gate. Recovery is the exit from the halt and nothing else; a
  // device that isn't halted has nothing to recover from, and refusing here
  // is what makes "no routine code path can re-enroll" structural.
  if (localStorage.getItem(KEY_HALT) === null) {
    throw typedError(
      'recoverVaultSyncEngine: this device is not credential-halted; recovery only runs from the halted state.',
      'NOT_HALTED'
    );
  }

  // 2. Device identity, from the stale record when one is readable.
  let staleRecord = null;
  try {
    const raw = localStorage.getItem(KEY_CREDENTIAL);
    staleRecord = raw ? JSON.parse(raw) : null;
  } catch {
    staleRecord = null;
  }
  const recordDeviceId =
    staleRecord && typeof staleRecord.deviceId === 'string' && staleRecord.deviceId !== ''
      ? staleRecord.deviceId
      : null;
  if (recordDeviceId && typeof engineConfig.deviceId === 'string' && engineConfig.deviceId !== recordDeviceId) {
    throw typedError(
      `recoverVaultSyncEngine: config.deviceId ("${engineConfig.deviceId}") differs from the deviceId the stale credential is bound to ("${recordDeviceId}"). Enrolling under either would orphan the other's credential or cursor — resolve the conflict explicitly.`,
      'DEVICE_ID_CONFLICT'
    );
  }
  const deviceId = recordDeviceId || engineConfig.deviceId || getOrCreateDeviceId(storageKeyPrefix);

  // 3. Mode guard. Unlike connect, recovery NEVER falls back on discovery
  // failure — it exists only to enroll, and enrolling blind could hit a
  // shared-mode server. Shared mode has no credentials and therefore no
  // recovery; this refusal is what keeps it structurally unreachable.
  let health;
  try {
    health = await fetchVaultHealth({ vaultUrl: base, fetchImpl });
  } catch {
    throw typedError(
      `recoverVaultSyncEngine: could not reach ${base}/healthz; the device stays halted.`,
      'VAULT_UNREACHABLE'
    );
  }
  if (health.authMode !== 'per-account') {
    throw typedError(
      `recoverVaultSyncEngine: this server reports auth mode "${health.authMode}", not per-account — there is no credential to recover; the device stays halted.`,
      'RECOVERY_UNSUPPORTED'
    );
  }

  // 4-6. Canary, enroll (the rotation: same byte-exact accountId + deviceId
  // revokes every still-active predecessor server-side), persist + verify.
  ensureCredentialSlotWritable(KEY_CREDENTIAL, 'recoverVaultSyncEngine');

  const enrollment = await enrollVaultDevice({
    vaultUrl: base,
    enrollmentSecret,
    accountId,
    deviceId,
    fetchImpl,
  });

  persistCredentialRecord(KEY_CREDENTIAL, {
    credentialId: enrollment.credentialId,
    credential: enrollment.credential,
    accountId,
    deviceId,
    vaultUrl: base,
    createdAt: enrollment.createdAt,
  }, 'recoverVaultSyncEngine');

  // 7. Clear the halt — the last state change, after verified persistence.
  localStorage.removeItem(KEY_HALT);

  // 8. Fresh engine on the new credential.
  const engine = createDbSyncEngine({ ...engineConfig, deviceId, vaultToken: enrollment.credential });
  return { engine, authMode: 'per-account', enrolled: true, deviceId };
}
