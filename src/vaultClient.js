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
//   POST   /intents/batch                        append intent events, { written, maxSeq }
//   GET    /intents/list?accountId=&since=&limit= intent events after a cursor, { rows, hasMore }
//
// Every client method is gated by a module-scope brake and counted by a
// module-scope budget meter, and the two write methods keep a bounded
// per-entity history that warns on loop-shaped traffic. See the diagnostics
// block below for why those live at module scope and what they cost.
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

// ═══════════════════════════════════════════════════════════════════════════
// Module-scope diagnostics (1.11.0): the brake, the budget meter, the
// write-loop detector.
//
// WHY MODULE SCOPE, NOT PER CLIENT INSTANCE. All three protect (or observe) a
// resource that is shared by every client in the process: the server's
// per-IP request budget. Two clients built by the same bundle are two views
// of one traffic stream, so the state that models that stream belongs to the
// module — one brake, one meter, one write history per *bundle realm*. The
// app is one realm; a plugin that bundles its own copy of this package is a
// separate realm, which is correct: it is a separate process with its own
// traffic and its own IP budget slice.
//
// WHY BY CONSTRUCTION. The incident these exist for (2026-08-30) was a
// fire-and-forget delete loop that re-tombstoned rows for hours and saturated
// the server's per-IP budget. Every request "succeeded" or failed into a
// swallowed `.catch(() => {})`. A protection a caller has to remember to
// apply is a protection that is missing on the day it matters, so the brake
// gates every network method of every client, and the meter and the write
// history observe them all whether or not anyone reads the stats.
// ═══════════════════════════════════════════════════════════════════════════

// --- The brake ---
// 30s doubling to a 10-minute ceiling. The ceiling is a deliberate stopping
// point rather than unbounded growth: a client that has waited ten minutes
// and is still being limited is in a condition an operator has to fix, and
// waiting twenty would only make the recovery slower once they do.
const BRAKE_BASE_MS = 30_000;
const BRAKE_CEILING_MS = 600_000;

// --- The budget meter ---
// 300/min is half of GLANCEvault's default 600/min per-IP budget: crossing
// half the budget in a minute is not yet a failure, which is exactly when a
// warning is still useful. The window is rolling; samples older than a minute
// are pruned on every record, and the buffer is hard-capped so a runaway loop
// can never grow it without bound (a dropped sample only under-counts a
// number that is already far past the threshold).
const BUDGET_WINDOW_MS = 60_000;
const DEFAULT_SOFT_LIMIT = 300;
const BUDGET_SAMPLE_CAP = 20_000;
const BUDGET_TOP_N = 3;

// --- The write-loop detector ---
// K=4 redundant writes inside M=10 minutes. A write is redundant when it
// cannot have changed the row's state from what the previous write to the
// same entityId left it: a polarity flip, a repeat delete, or an
// identical-content rewrite (see isRedundantWrite for why each counts). K=4
// means five events — upsert/delete/upsert/delete/upsert, or five deletes of
// one tombstone — which no human edit pattern produces and every
// delete/resupply or re-tombstone loop produces within seconds.
// M=10min is long enough to catch a slow loop running on a 60s sync cycle
// and short enough that a week of ordinary edits never accumulates into it.
// Both are configurable via configureVaultDiagnostics for callers whose
// cadence makes different numbers right.
//
// FAILS OPEN BY CONSTRUCTION: the rule is per-entityId and needs consecutive
// events on the SAME id, so a first sync or a large import — many DIFFERENT
// ids, one event each — can never trigger it however big it is.
const DEFAULT_LOOP_TRANSITIONS = 4;
const DEFAULT_LOOP_WINDOW_MS = 10 * 60_000;
const WRITE_HISTORY_PER_ID = 8;   // >= K+1 events, so the ring always holds a full detection
const WRITE_HISTORY_IDS = 500;    // LRU-capped: the map is bounded regardless of traffic

let diagnosticsConfig = {
  softLimitPerMinute: DEFAULT_SOFT_LIMIT,
  loopTransitions: DEFAULT_LOOP_TRANSITIONS,
  loopWindowMs: DEFAULT_LOOP_WINDOW_MS,
  logger: null,
};

const diagLog = (level, message) => {
  const sink = diagnosticsConfig.logger || console;
  const fn = typeof sink[level] === 'function' ? sink[level] : sink.log;
  if (typeof fn === 'function') fn.call(sink, message);
};

const secs = (ms) => Math.round(ms / 1000);

// ---------------------------------------------------------------------------
// The brake
// ---------------------------------------------------------------------------

const brakeState = { until: 0, memoryMs: 0 };

/**
 * The gate. Returns a typed error when the brake is engaged, or null.
 *
 * The error is deliberately shaped like a REAL 429 (`status: 429`) so every
 * retry ladder already sitting on top of this client — the DB engine's
 * backoff, an app's bounded retry — treats it as the transient it is with no
 * new code. `code: 'RATE_LIMITED'` and `retryInMs` are additive: a caller
 * that wants to sit the whole cycle out can branch on them.
 */
const brakeGate = () => {
  const now = Date.now();
  if (brakeState.until <= now) return null;
  const retryInMs = brakeState.until - now;
  const err = new VaultError(
    `vault requests are paused: rate-limited by the server, retry in ~${Math.ceil(retryInMs / 1000)}s`,
    429
  );
  err.code = 'RATE_LIMITED';
  err.retryInMs = retryInMs;
  return err;
};

/**
 * Arms the brake on a real 429. ONE ARMING PER BURST: a 429 that arrives
 * while the brake is already engaged never compounds the delay, so a
 * concurrent fan-out of ten requests that all meet the limiter costs one
 * escalation step, not ten.
 */
const brakeArm = (label) => {
  const now = Date.now();
  if (brakeState.until > now) return;
  brakeState.memoryMs = brakeState.memoryMs === 0
    ? BRAKE_BASE_MS
    : Math.min(brakeState.memoryMs * 2, BRAKE_CEILING_MS);
  brakeState.until = now + brakeState.memoryMs;
  // The once-per-incident report, and the only loud line the brake prints.
  // It names the method that met the limiter because that is the single most
  // useful fact when the storm is someone else's loop.
  diagLog('warn', `[vault] BRAKE: rate-limited (429) on ${label} — vault requests paused for ~${secs(brakeState.memoryMs)}s`);
};

/**
 * DECAY, NEVER AMNESTY. A success clears the gate but only HALVES the
 * escalation memory (below the 30s base it drains to zero).
 *
 * This is the lesson from the first brake built for this ecosystem, which
 * reset escalation to zero on ANY success. On a saturated SHARED budget the
 * occasional cheap request slips into a fresh limiter window and returns 200
 * — and each lucky 200 wiped the entire 30s->480s escalation and re-licensed
 * full cadence. It backed off, escalated, forgot, and started over, forever.
 *
 * Halving keeps the storm's level in memory: the next 429 re-arms at 2x what
 * is left (so a lucky success cannot buy back full cadence), while a genuine
 * recovery drains to zero in a few quiet successes and costs nothing.
 */
const brakeNoteSuccess = () => {
  const wasBraked = brakeState.until > Date.now();
  brakeState.until = 0;
  if (brakeState.memoryMs === 0) return;
  const before = brakeState.memoryMs;
  const halved = Math.floor(before / 2);
  brakeState.memoryMs = halved < BRAKE_BASE_MS ? 0 : halved;
  diagLog(
    'info',
    `[vault] brake ${wasBraked ? 'released' : 'decay'}: escalation memory ${secs(before)}s -> ${secs(brakeState.memoryMs)}s`
  );
};

/**
 * The brake's state, for callers that would rather sit a whole cycle out
 * pre-flight than fire a call and catch RATE_LIMITED.
 *
 * @returns {{ braked: boolean, until: number|null, memoryMs: number, retryInMs: number }}
 */
export function vaultBrakeStatus() {
  const now = Date.now();
  const braked = brakeState.until > now;
  return {
    braked,
    until: brakeState.until || null,
    memoryMs: brakeState.memoryMs,
    retryInMs: braked ? brakeState.until - now : 0,
  };
}

/** Convenience read: is the shared brake engaged right now? */
export function isVaultRateLimited() {
  return brakeState.until > Date.now();
}

// ---------------------------------------------------------------------------
// The budget meter
// ---------------------------------------------------------------------------
//
// VISIBILITY ONLY — the meter never throttles anything. Its argument is that
// it needs no theory about WHY a loop is running: it counts requests and
// names who made them, so the next storm is an attributed event on day one
// instead of an afternoon of archaeology.

const meterState = { samples: [], lastReportAt: 0, dropped: 0 };

const meterPrune = (now) => {
  const cutoff = now - BUDGET_WINDOW_MS;
  const s = meterState.samples;
  let i = 0;
  while (i < s.length && s[i].at <= cutoff) i += 1;
  if (i > 0) s.splice(0, i);
};

const meterTally = () => {
  const counts = new Map();
  for (const sample of meterState.samples) {
    counts.set(sample.label, (counts.get(sample.label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

const meterRecord = (label) => {
  const now = Date.now();
  meterPrune(now);
  if (meterState.samples.length >= BUDGET_SAMPLE_CAP) {
    // Hard cap: a loop cannot grow the buffer without bound. Dropping the
    // oldest samples only under-counts a number already far past the limit.
    const excess = meterState.samples.length - BUDGET_SAMPLE_CAP + 1;
    meterState.samples.splice(0, excess);
    meterState.dropped += excess;
  }
  meterState.samples.push({ at: now, label });

  const total = meterState.samples.length;
  if (total <= diagnosticsConfig.softLimitPerMinute) return;
  // ONE line per window: after reporting, stay quiet for a full minute. A
  // storm that lasts an hour prints sixty attributable lines, not a million.
  if (meterState.lastReportAt !== 0 && now - meterState.lastReportAt < BUDGET_WINDOW_MS) return;
  meterState.lastReportAt = now;
  const top = meterTally().slice(0, BUDGET_TOP_N).map(([name, n]) => `${name} ${n}`).join(', ');
  diagLog('warn', `[vault] budget: ${total} requests in the last minute (soft limit ${diagnosticsConfig.softLimitPerMinute}) — top: ${top}`);
};

// ---------------------------------------------------------------------------
// The write-loop detector (success-side visibility)
// ---------------------------------------------------------------------------
//
// Failure visibility exists. What was missing on the day of the incident was
// the signal for everything "succeeding" pathologically: every request
// returned 200 and every caller swallowed its promise, so a delete/resupply
// loop was indistinguishable from healthy traffic until the server's budget
// ran out. This ring is the client-level answer — diagnostic only, never a
// brake, and it fails open.

const writeHistory = new Map(); // entityId -> { events: [...], warnedAt }

// FNV-1a over a bounded prefix. Cheap enough to run on every row of every
// batch, and only ever used to spot an IDENTICAL rewrite (see
// isRedundantWrite). Never decoded, only hashed.
const hashContent = (value) => {
  if (typeof value !== 'string' || value === '') return null;
  const span = value.length > 4096 ? value.slice(0, 4096) : value;
  let h = 0x811c9dc5;
  for (let i = 0; i < span.length; i += 1) {
    h ^= span.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${value.length}:${(h >>> 0).toString(36)}`;
};

/**
 * Is this consecutive pair of writes to one entityId REDUNDANT — a write that
 * cannot have changed the row's state from what the previous write left it?
 *
 * Three shapes qualify, and the third is the founding incident's:
 *
 *  1. A POLARITY FLIP (upsert -> delete or delete -> upsert). The
 *     write-flip / delete-and-resupply loop.
 *  2. An IDENTICAL-CONTENT REWRITE (upsert -> upsert, same content). Note
 *     that an AES-GCM envelope carries a fresh random IV, so identical
 *     plaintext does NOT produce an identical envelope: this rule fires for
 *     plaintext and deterministic payloads, while shape 1 covers encrypted
 *     ones.
 *  3. A REPEAT DELETE (delete -> delete). Re-deleting a row that is already
 *     a tombstone is redundant by definition — and it is exactly the loop
 *     this detector was built for: the Obsidian plugin's cleanup called
 *     deleteRow on rows that were already tombstones, the server re-tombstoned
 *     each time with a fresh seq, and that pushed the row back above the
 *     caller's cursor to be deleted again. Same polarity every time, no
 *     content at all, so neither of the first two rules sees it. A detector
 *     that misses its own origin story is not a detector.
 *
 * A bounded retry of one failed delete does not reach K on its own; a ladder
 * that retries the same delete K times inside the window is itself worth
 * knowing about, and is the same shape as the incident.
 */
const isRedundantWrite = (prev, cur) => {
  if (prev.polarity !== cur.polarity) return true;
  if (prev.polarity === 'delete') return true;
  return prev.contentHash != null && prev.contentHash === cur.contentHash;
};

const countTransitions = (events, now) => {
  const cutoff = now - diagnosticsConfig.loopWindowMs;
  const recent = events.filter((e) => e.at >= cutoff);
  let transitions = 0;
  for (let i = 1; i < recent.length; i += 1) {
    if (isRedundantWrite(recent[i - 1], recent[i])) transitions += 1;
  }
  return transitions;
};

const renderHistory = (events) => events
  .map((e) => (e.polarity === 'upsert' ? 'upsert' : 'delete'))
  .join(' -> ');

/**
 * Records one write against an entityId and warns — loudly, at most once per
 * id per window — when its recent history looks like a loop.
 *
 * Recorded at INTENT time (before the request), so a loop that is being
 * gated by the brake or rejected by the server is still visible as a loop.
 */
const noteWrite = (entityId, polarity, envelope) => {
  if (typeof entityId !== 'string' || entityId === '') return;
  const now = Date.now();
  let rec = writeHistory.get(entityId);
  if (rec) writeHistory.delete(entityId); // re-insert keeps Map iteration order LRU
  else rec = { events: [], warnedAt: 0 };
  rec.events.push({
    polarity,
    at: now,
    contentHash: polarity === 'upsert' ? hashContent(envelope) : null,
  });
  if (rec.events.length > WRITE_HISTORY_PER_ID) rec.events.shift();
  writeHistory.set(entityId, rec);
  while (writeHistory.size > WRITE_HISTORY_IDS) {
    writeHistory.delete(writeHistory.keys().next().value);
  }

  const transitions = countTransitions(rec.events, now);
  if (transitions < diagnosticsConfig.loopTransitions) return;
  if (rec.warnedAt !== 0 && now - rec.warnedAt < diagnosticsConfig.loopWindowMs) return;
  rec.warnedAt = now;
  diagLog(
    'warn',
    `[vault] WRITE LOOP? entity ${entityId}: ${transitions} redundant writes (polarity flips, repeat deletes or identical rewrites) in the last ${Math.round(diagnosticsConfig.loopWindowMs / 60_000)} min — ${renderHistory(rec.events)}`
  );
};

const writeLoopSuspects = () => {
  const now = Date.now();
  const suspects = [];
  for (const [entityId, rec] of writeHistory) {
    const transitions = countTransitions(rec.events, now);
    if (transitions === 0) continue;
    suspects.push({
      entityId,
      transitions,
      warned: rec.warnedAt !== 0,
      history: rec.events.map((e) => ({ polarity: e.polarity, at: e.at, contentHash: e.contentHash })),
    });
  }
  return suspects.sort((a, b) => b.transitions - a.transitions).slice(0, 20);
};

// ---------------------------------------------------------------------------
// The shared stats surface
// ---------------------------------------------------------------------------

/**
 * Everything the module-scope diagnostics know, in one read: the brake's
 * state, the last rolling minute of request counts attributed by method, and
 * the entityIds whose recent write history looks loop-shaped.
 *
 * @returns {{ brake: object, requests: object, writeLoopSuspects: Array }}
 */
export function getVaultStats() {
  const now = Date.now();
  meterPrune(now);
  const byMethod = {};
  for (const [label, n] of meterTally()) byMethod[label] = n;
  return {
    brake: vaultBrakeStatus(),
    requests: {
      lastMinute: meterState.samples.length,
      softLimitPerMinute: diagnosticsConfig.softLimitPerMinute,
      byMethod,
      droppedSamples: meterState.dropped,
    },
    writeLoopSuspects: writeLoopSuspects(),
  };
}

/**
 * Tunes the visibility-only thresholds. The brake's curve is deliberately NOT
 * configurable: it is a protection for someone else's server, and an app that
 * could widen it would eventually widen it.
 *
 * @param {object} [options]
 * @param {number} [options.softLimitPerMinute] - budget-meter warn threshold (default 300)
 * @param {number} [options.loopTransitions]    - write-loop K (default 4)
 * @param {number} [options.loopWindowMs]       - write-loop M (default 10min)
 * @param {object|null} [options.logger]        - console-shaped sink for the diagnostic lines
 */
export function configureVaultDiagnostics(options = {}) {
  if (typeof options.softLimitPerMinute === 'number' && options.softLimitPerMinute > 0) {
    diagnosticsConfig.softLimitPerMinute = options.softLimitPerMinute;
  }
  if (typeof options.loopTransitions === 'number' && options.loopTransitions > 0) {
    diagnosticsConfig.loopTransitions = options.loopTransitions;
  }
  if (typeof options.loopWindowMs === 'number' && options.loopWindowMs > 0) {
    diagnosticsConfig.loopWindowMs = options.loopWindowMs;
  }
  if ('logger' in options) diagnosticsConfig.logger = options.logger || null;
  return { ...diagnosticsConfig };
}

/**
 * Clears the brake, the meter and the write history, and restores the default
 * thresholds. For tests — module-scope state is per realm and would otherwise
 * carry between cases.
 */
export function resetVaultDiagnostics() {
  brakeState.until = 0;
  brakeState.memoryMs = 0;
  meterState.samples.length = 0;
  meterState.lastReportAt = 0;
  meterState.dropped = 0;
  writeHistory.clear();
  diagnosticsConfig = {
    softLimitPerMinute: DEFAULT_SOFT_LIMIT,
    loopTransitions: DEFAULT_LOOP_TRANSITIONS,
    loopWindowMs: DEFAULT_LOOP_WINDOW_MS,
    logger: null,
  };
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
 * Every network method of the returned client passes through the module-scope
 * brake and budget meter (see the diagnostics block at the top of this file).
 * That is deliberate: protection a caller has to remember to apply is
 * protection that is missing on the day it matters.
 *
 * @param {object} config
 * @param {string} config.vaultUrl   - base URL of the GLANCEvault server
 * @param {string} config.vaultToken - Bearer token: the shared device token
 *   (shared mode) or this device's enrolled credential (per-account mode)
 * @param {Function} [config.fetchImpl] - fetch implementation (defaults to global fetch)
 * @param {boolean} [config.brake=true] - set false to opt this client out of the
 *   shared brake (it neither gates on nor arms it). An escape hatch for tests
 *   that need the wire on every call; production callers should leave it on.
 */
export function createVaultClient({ vaultUrl, vaultToken, fetchImpl, brake = true } = {}) {
  const base = requireBaseUrl(vaultUrl, 'createVaultClient');
  if (!vaultToken) throw new Error('createVaultClient: vaultToken is required');
  const doFetch = resolveFetch(fetchImpl, 'createVaultClient');
  const brakeEnabled = brake !== false;
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

  /**
   * The one door every network method goes through: gate, meter, send, and
   * report a 2xx back to the brake.
   *
   * `label` is the METHOD NAME (batch, intentsList, deleteRow, ...) — the
   * brake's arming line and the meter's attribution both name it, so the
   * report says who met the limiter rather than just that someone did.
   *
   * A gated call throws BEFORE the fetch and is deliberately silent and
   * unmetered: it never reaches the wire, so it is not budget the server
   * spent, and the arming line already reported the incident once.
   */
  const send = async (label, method, path, opts) => {
    if (brakeEnabled) {
      const gated = brakeGate();
      if (gated) throw gated;
    }
    meterRecord(label);
    const res = await request(method, path, opts);
    if (brakeEnabled && res && res.ok) brakeNoteSuccess();
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
  const errorFromResponse = async (res, context, label) => {
    let body = null;
    let bodyError = null;
    try {
      body = await res.json();
      if (body && typeof body.error === 'string') bodyError = body.error;
    } catch {
      // Empty or non-JSON error body: keep the generic classification.
    }
    // A 429 arms the shared brake — but only a RATE-LIMITER 429, not an
    // over-quota one. The server uses 429 for both, and they call for
    // opposite handling: a limiter hit means "you are asking too often, stop
    // for a while" (exactly what the brake is), while a quota rejection means
    // "this account is full", clears only when an operator acts, and already
    // has its own self-resuming window in the DB engine. Gating on a quota
    // 429 would mask QUOTA_EXCEEDED and its descriptor behind RATE_LIMITED
    // and leave the engine unable to render "X of Y used". So the arming
    // decision waits until the body has been parsed and the quota shape ruled
    // out — see parseQuotaBody for how narrowly that shape is recognised.
    const quotaShaped = parseQuotaBody(res.status, body, bodyError);
    if (res.status === 429 && !quotaShaped && brakeEnabled) brakeArm(label || context);
    if (res.status === 401 && bodyError === 'invalid credential') {
      const err = new VaultError(`${context} failed: 401 — the server rejected this device's credential`, 401);
      err.code = 'CREDENTIAL_INVALID';
      return err;
    }
    if (quotaShaped) {
      const quota = quotaShaped;
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

  const jsonOrThrow = async (res, context, label) => {
    if (!res.ok) {
      throw await errorFromResponse(res, context, label);
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
      // Recorded at intent time, before the wire: a loop that is being gated
      // by the brake or rejected by the server is still a loop worth naming.
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row) noteWrite(row.entityId, 'upsert', row.envelope);
        }
      }
      const res = await send('batch', 'POST', `/sync/${encodeURIComponent(app)}/batch`, {
        body: { accountId, rows },
      });
      return jsonOrThrow(res, 'batch upsert', 'batch');
    },

    /**
     * Fetches rows changed since `since` (a seq). One page per call.
     * @returns {Promise<{ rows: Array, hasMore: boolean }>}
     */
    async list(app, { accountId, since }) {
      requireAccountId(accountId, 'list');
      const res = await send('list', 'GET', `/sync/${encodeURIComponent(app)}/list`, {
        query: { accountId, since: String(since) },
      });
      return jsonOrThrow(res, 'list', 'list');
    },

    /**
     * Fetches a single row by entityId. Returns null on 404.
     */
    async getRow(app, entityId, accountId) {
      requireAccountId(accountId, 'get row');
      const res = await send('getRow', 'GET', `/sync/${encodeURIComponent(app)}/${encodeURIComponent(entityId)}`, {
        query: { accountId },
      });
      if (res.status === 404) return null;
      return jsonOrThrow(res, 'get row', 'getRow');
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
      noteWrite(entityId, 'delete');
      const query = { accountId };
      if (opts && opts.deletedAt != null) query.deletedAt = String(opts.deletedAt);
      const res = await send('deleteRow', 'DELETE', `/sync/${encodeURIComponent(app)}/${encodeURIComponent(entityId)}`, {
        query,
      });
      if (res.status === 404) return null;
      return jsonOrThrow(res, 'delete row', 'deleteRow');
    },

    /**
     * Updates this device's cursor. Best-effort: callers should not let a
     * failure here abort the sync cycle.
     * @returns {Promise<{ updated: boolean }>}
     */
    async device(app, { accountId, deviceId, lastSeenSeq }) {
      requireAccountId(accountId, 'device cursor');
      const res = await send('device', 'POST', `/sync/${encodeURIComponent(app)}/device`, {
        body: { accountId, deviceId, lastSeenSeq },
      });
      return jsonOrThrow(res, 'device cursor', 'device');
    },

    /**
     * Fetches the account's root-key salt. Returns a Uint8Array, or null if no
     * salt is registered yet (404).
     */
    async getSalt(accountId) {
      const res = await send('getSalt', 'GET', `/salt/${encodeURIComponent(accountId)}`);
      if (res.status === 404) return null;
      const body = await jsonOrThrow(res, 'get salt', 'getSalt');
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
      const res = await send('putSalt', 'PUT', `/salt/${encodeURIComponent(accountId)}`, {
        body: { salt: toBase64(salt) },
      });
      const body = await jsonOrThrow(res, 'put salt', 'putSalt');
      return body && body.salt ? fromBase64(body.salt) : salt;
    },

    // ───────────────────────── intents transport (1.11.0) ────────────────────
    //
    // The client half of GLANCEvault's /intents/* surface, so apps can drop
    // their hand-rolled raw-fetch transports and inherit this client's auth,
    // error classification, brake and meter. PURE TRANSPORT: the envelope is
    // OPAQUE here and is never decoded, inspected or validated — the codec
    // (and the per-envelope key derivation it needs) stays in
    // @glance-apps/intents on the app side, which is why this package can
    // carry the transport without carrying the crypto.
    //
    // The wire contract below is what the server already serves; nothing in
    // this release changes it.

    /**
     * Appends intent events. INSERT-ONLY: the server ignores an eventId it
     * has already stored, so a re-sent batch after an ambiguous failure is a
     * no-op rather than a duplicate — retries are safe by construction.
     *
     * POST {vaultUrl}/intents/batch
     *   body { accountId, events: [{ eventId, envelope, expiresAt }] }
     *
     * @param {string} accountId
     * @param {Array<{ eventId: string, envelope: string, expiresAt: string }>} events
     *   envelope is an opaque base64 string; expiresAt is an ISO timestamp.
     * @returns {Promise<{ written: number, maxSeq: number }>}
     */
    async intentsBatch(accountId, events) {
      requireAccountId(accountId, 'intents batch');
      if (!Array.isArray(events)) {
        const err = new Error('intents batch: events must be an array of { eventId, envelope, expiresAt }.');
        err.code = 'EVENTS_REQUIRED';
        throw err;
      }
      const res = await send('intentsBatch', 'POST', '/intents/batch', {
        body: { accountId, events },
      });
      return jsonOrThrow(res, 'intents batch', 'intentsBatch');
    },

    /**
     * Fetches intent events with seq > since, ascending, one page per call.
     * The server returns only non-expired rows and pages at 500.
     *
     * GET {vaultUrl}/intents/list?accountId=&since=&limit=
     *
     * @param {string} accountId
     * @param {object} [opts]
     * @param {number} [opts.since=0] - exclusive seq cursor
     * @param {number} [opts.limit]   - page size; omitted lets the server choose
     * @returns {Promise<{ rows: Array<{ eventId: string, envelope: string, seq: number, expiresAt: string, serverMtime: string }>, hasMore: boolean }>}
     */
    async intentsList(accountId, { since = 0, limit } = {}) {
      requireAccountId(accountId, 'intents list');
      const query = { accountId, since: String(since) };
      if (limit != null) query.limit = String(limit);
      const res = await send('intentsList', 'GET', '/intents/list', { query });
      return jsonOrThrow(res, 'intents list', 'intentsList');
    },
  };
}
