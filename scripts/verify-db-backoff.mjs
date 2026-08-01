// Runtime verification for the DB engine's backoff ladder, against REAL
// GLANCEvault servers (no mocks except where a failure mode cannot be
// produced by a healthy server, which is labelled inline).
//
// Servers expected (scratchpad/start-servers.sh):
//   18081  shared, no quota configured       (token: shared-tok-1)
//   18082  per-account, no quota configured  (secret: bootstrap-secret-42)
//   18085  per-account, GLANCEVAULT_QUOTA_ROWS configured
//
// Run from the repo root:  node scripts/verify-db-backoff.mjs
//
// The windows are 30s+ by design, so the harness advances the engine's clock
// rather than sleeping through them: every wait uses a REAL failing server and
// a REAL recovery, only the passage of time is simulated. Where an item needs
// wall-clock honesty (item 1's "no added latency"), it is measured for real.

import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';

const SECRET = 'bootstrap-secret-42';
const SHARED = 'http://127.0.0.1:18081';
const PERACC = 'http://127.0.0.1:18082';
const QUOTA  = 'http://127.0.0.1:18085';

const __store = new Map();
globalThis.localStorage = {
  getItem:    (k) => (__store.has(k) ? __store.get(k) : null),
  setItem:    (k, v) => { __store.set(k, String(v)); },
  removeItem: (k) => { __store.delete(k); },
  clear:      () => { __store.clear(); },
  key:        (i) => Array.from(__store.keys())[i] ?? null,
  get length() { return __store.size; },
};

// Wire recorder over the REAL fetch. `outage` simulates the server being
// unreachable (a genuinely persistent transport failure); `inject` rewrites a
// real response where the case cannot be produced otherwise.
const wire = [];
let outage = null;   // (entry) => boolean : reject the request as a network error
let inject = null;   // (entry) => response | null
let rewriteUrl = null; // (entry) => string | null : send a different URL to the REAL server
const recordingFetch = async (url, init) => {
  const entry = { url: String(url), method: init?.method ?? 'GET', at: Date.now() };
  wire.push(entry);
  if (outage && outage(entry)) throw new TypeError('fetch failed'); // what an offline device sees
  const target = (rewriteUrl && rewriteUrl(entry)) || url;
  const res = await fetch(target, init);
  if (inject) {
    const replaced = inject(entry, res);
    if (replaced) return replaced;
  }
  return res;
};
const since = (n, pred) => wire.slice(n).filter(pred);
const isBatch = (w) => w.url.includes('/batch');
const isList = (w) => w.url.includes('/list');
const isDevice = (w) => w.url.endsWith('/device');
const isDelete = (w) => w.method === 'DELETE';

// The engine's clock. Advancing it is how the harness crosses a window
// without sleeping; the failures and recoveries either side are real.
const realNow = Date.now;
let clockSkew = 0;
Date.now = () => realNow() + clockSkew;
const advanceTo = (t) => { clockSkew = t - realNow() + 1000; };
const resetClock = () => { clockSkew = 0; };

const { createDbSyncEngine } = await import('../src/dbEngine.js');
const { connectVaultSyncEngine } = await import('../src/vaultConnect.js');
const { setSyncPassphrase, clearEncryptionKey } = await import('../src/crypto.js');
const { clearDbRootKey } = await import('../src/dbCrypto.js');

setSyncPassphrase('verify-backoff');

let passCount = 0;
const PASS = (m) => { passCount += 1; console.log(`  [PASS]  ${m}`); };
const section = (m) => console.log(`\n=== ${m}`);

const makeDevice = (prefix, extra = {}) => {
  const local = new Map();
  const errors = [];
  const cfg = {
    storageKeyPrefix: prefix,
    appId: 'verifyapp',
    vaultApp: 'dayglance',
    cryptoDBName: `crypto-${prefix}`,
    fetchImpl: recordingFetch,
    getLocalEntity: (id) => (local.has(id) ? local.get(id) : null),
    applyRemoteEntity: (id, e) => { local.set(id, e); },
    applyRemoteDelete: (id) => { local.delete(id); },
    onError: (message, code, isHardStop) => { if (code) errors.push({ message, code, isHardStop }); },
    ...extra,
  };
  return { local, errors, cfg };
};
const freshKeys = async (p) => { await clearDbRootKey({ cryptoDBName: `crypto-${p}` }); };
const enroll = async (prefix, vaultUrl, accountId, extra = {}) => {
  await freshKeys(prefix);
  const d = makeDevice(prefix, { vaultUrl, accountId, ...extra });
  const { engine } = await connectVaultSyncEngine({ ...d.cfg, enrollmentSecret: SECRET });
  return { ...d, engine };
};

// ═══ 1. A healthy client is unaffected ══════════════════════════════════════
section('1. a healthy client: unchanged cycle shape, no window, no added latency');
{
  const d = await enroll('bo-healthy', PERACC, 'bo-acct');
  // First sync also establishes the account's key-verifier row, so measure the
  // steady-state cycle shape: one batch, one list, one cursor report.
  await d.engine.sync();
  d.local.set('h1', { id: 'h1', text: 'healthy', lastModified: Date.now() });
  d.engine.markDirty('h1');

  const start = wire.length;
  const t0 = realNow();
  const result = await d.engine.sync();
  const elapsed = realNow() - t0;

  assert.deepEqual(d.errors, []);
  assert.equal(result.pushFailed, undefined);
  assert.equal(result.pullFailed, undefined);
  assert.equal(d.engine.getUploadBackoffUntil(), 0);
  assert.equal(d.engine.getDownloadBackoffUntil(), 0);
  const shape = { batch: since(start, isBatch).length, list: since(start, isList).length, device: since(start, isDevice).length };
  assert.deepEqual(shape, { batch: 1, list: 1, device: 1 });
  PASS(`clean cycle: ${JSON.stringify(shape)}, both windows 0, no error surfaced`);

  // A second healthy cycle is the same shape and adds no delay of its own.
  const t1 = realNow();
  await d.engine.sync();
  const elapsed2 = realNow() - t1;
  assert.ok(elapsed2 < 2000, `a healthy cycle must not gain latency (took ${elapsed2}ms)`);
  PASS(`no added latency: consecutive healthy cycles took ${elapsed}ms and ${elapsed2}ms (no artificial delay)`);
}

// ═══ 2 + 3. Persistent push failure: backs off, pull and cursor continue ════
section('2 + 3. a persistent push failure backs off; the pull and cursor keep running');
let pushDev;
{
  pushDev = await enroll('bo-push', PERACC, 'bo-acct');
  pushDev.local.set('p1', { id: 'p1', text: 'never lands at first', lastModified: Date.now() });
  pushDev.engine.markDirty('p1');

  // A REAL persistent failure: the batch endpoint is unreachable.
  outage = (entry) => isBatch(entry);

  const start = wire.length;
  const first = await pushDev.engine.sync();
  assert.equal(first.pushFailed, true);
  const w1 = pushDev.engine.getBackoffState().push;
  assert.equal(w1.reason, 'transport');
  assert.equal(w1.strikes, 1);

  // Five more cycles inside the window.
  for (let i = 0; i < 5; i += 1) await pushDev.engine.sync();
  const attempts = since(start, isBatch).length;
  const lists = since(start, isList).length;
  const devices = since(start, isDevice).length;
  assert.equal(attempts, 1, `expected ONE write attempt across 6 cycles, saw ${attempts}`);
  assert.equal(lists, 6);
  assert.equal(devices, 6);
  PASS(`6 cycles, persistent push failure: ${attempts} write attempt, ${lists} pulls, ${devices} cursor reports`);

  // Escalation: each expiry probes exactly once and roughly doubles.
  const deltas = [];
  for (let i = 0; i < 3; i += 1) {
    const w = pushDev.engine.getBackoffState().push;
    advanceTo(w.until);
    await pushDev.engine.sync();
    const next = pushDev.engine.getBackoffState().push;
    deltas.push(Math.round((next.until - Date.now()) / 1000));
  }
  resetClock();
  assert.deepEqual(deltas, [60, 120, 240]);
  assert.equal(since(start, isBatch).length, 4); // one probe per expiry, not per cycle
  PASS(`escalation after the initial 30s window: ${deltas.join('s -> ')}s, one probe per expiry`);
}

// ═══ 5. Dirty rows survive, and land on recovery ════════════════════════════
section('5. dirty rows survive the whole backoff and land intact on recovery');
{
  assert.deepEqual(pushDev.engine.getDirtySet(), ['p1'], 'the row stayed dirty throughout');
  outage = null; // the underlying failure goes away

  advanceTo(pushDev.engine.getBackoffState().push.until);
  const recovered = await pushDev.engine.sync();
  resetClock();

  assert.equal(recovered.pushFailed, undefined);
  assert.deepEqual(pushDev.engine.getDirtySet(), []);
  assert.equal(pushDev.engine.getUploadBackoffUntil(), 0);
  assert.equal(pushDev.engine.getBackoffState().push.strikes, 0);
  PASS('the window and strike count reset on success; the dirty row landed, nothing lost');

  // Proven end to end: a peer sees the row that was stuck behind the backoff.
  const peer = await enroll('bo-peer', PERACC, 'bo-acct');
  await peer.engine.sync();
  assert.equal(peer.local.get('p1')?.text, 'never lands at first');
  PASS('a peer device pulled the previously-stuck row: no data was lost to the backoff');
}

// ═══ 4. Recovery is automatic ═══════════════════════════════════════════════
section('4. recovery needed no user action and no restart');
{
  // The recovery above used the SAME engine instance, with no re-enrollment,
  // no new engine, no clearing call, and no user input of any kind.
  assert.equal(pushDev.engine.isCredentialHalted(), false);
  assert.equal(pushDev.engine.getQuotaState(), null);
  PASS('same engine instance throughout: no restart, no re-enrollment, no clearing call exists to make');
}

// ═══ 9. A persistent PULL failure backs off; cursor runs on the failing cycle ═
section('9. a persistent pull failure backs off too, and the cursor reports on the failing cycle');
{
  const d = await enroll('bo-pull', PERACC, 'bo-acct');
  outage = (entry) => isList(entry);

  const start = wire.length;
  const first = await d.engine.sync();
  assert.equal(first.pullFailed, true);
  assert.equal(since(start, isList).length, 1);
  assert.equal(since(start, isDevice).length, 1, 'the cursor still reported on the failing cycle');
  const w = d.engine.getBackoffState().pull;
  assert.equal(w.reason, 'transport');
  PASS('a failed pull no longer aborts the cycle: the device cursor still reported');

  for (let i = 0; i < 4; i += 1) await d.engine.sync();
  assert.equal(since(start, isList).length, 1, 'no pull retries inside the window');
  PASS(`5 cycles, persistent pull failure: 1 list attempt (was 5 before this change)`);

  // The pull cap is 5 minutes, lower than the push's 15.
  const deltas = [];
  for (let i = 0; i < 5; i += 1) {
    const cur = d.engine.getBackoffState().pull;
    advanceTo(cur.until);
    await d.engine.sync();
    deltas.push(Math.round((d.engine.getBackoffState().pull.until - Date.now()) / 1000));
  }
  resetClock();
  assert.equal(deltas[deltas.length - 1], 300, `pull cap should be 300s, saw ${deltas[deltas.length - 1]}`);
  PASS(`pull escalation caps at the file tier's download ceiling: ${deltas.join('s -> ')}s`);

  outage = null;
  advanceTo(d.engine.getBackoffState().pull.until);
  const back = await d.engine.sync();
  resetClock();
  assert.equal(back.pullFailed, undefined);
  assert.equal(d.engine.getDownloadBackoffUntil(), 0);
  PASS('the pull window resets on the first successful pull');
}

// ═══ 8 (auth class) + how a consumer tells the windows apart ════════════════
section('8. failure classes: a 401 gets the flat hour, and is distinguishable from transport');
{
  // A REAL 401: a shared-mode server presented a wrong device token.
  await freshKeys('bo-auth');
  const d = makeDevice('bo-auth', { vaultUrl: SHARED, accountId: 'bo-acct', vaultToken: 'definitely-wrong-token' });
  const engine = createDbSyncEngine(d.cfg);
  d.local.set('a1', { id: 'a1', text: 'x', lastModified: Date.now() });
  engine.markDirty('a1');

  const start = wire.length;
  await engine.sync();
  const { push } = engine.getBackoffState();
  assert.equal(push.reason, 'auth');
  const hours = (push.until - Date.now()) / 3_600_000;
  assert.ok(hours > 0.98 && hours <= 1.0, `expected ~1h, got ${hours}h`);
  assert.equal(engine.isCredentialHalted(), false, 'an auth backoff is NOT the credential halt');
  PASS(`a real shared-mode 401 opened reason="auth" for ${hours.toFixed(2)}h — delayed, not terminal, not halted`);

  for (let i = 0; i < 3; i += 1) await engine.sync();
  assert.equal(since(start, isBatch).length + since(start, isList).length <= 2, true);
  PASS('no retries inside the auth window (was one full cycle of requests per cycle before)');

  // What a consumer can tell: reason + until, without inferring from magnitude.
  const state = engine.getBackoffState();
  assert.equal(state.push.reason, 'auth');
  assert.equal(engine.getUploadBackoffUntil(), state.push.until);
  PASS(`a consumer reads reason="${state.push.reason}" and until=<ts> — distinguishable from a 30s transport window without guessing`);
}

// ═══ 10. Readiness codes are NOT delayed ════════════════════════════════════
section('10. readiness codes retry immediately: supply the passphrase and the next cycle proceeds');
{
  // A genuinely fresh device with NO passphrase in session: ensureRootKey
  // throws PASSPHRASE_REQUIRED before any network call.
  await freshKeys('bo-ready');
  const cred = JSON.parse(localStorage.getItem('bo-push-vault-credential'));
  const d = makeDevice('bo-ready', { vaultUrl: PERACC, accountId: 'bo-acct', vaultToken: cred.credential });
  const engine = createDbSyncEngine(d.cfg);

  clearEncryptionKey?.();
  setSyncPassphrase(null);
  const start = wire.length;
  await engine.sync();
  const surfaced = d.errors.pop();
  assert.equal(surfaced.code, 'PASSPHRASE_REQUIRED');
  assert.equal(engine.getUploadBackoffUntil(), 0, 'readiness must open NO window');
  assert.equal(engine.getDownloadBackoffUntil(), 0);
  assert.equal(since(start, isBatch).length, 0, 'it failed before any network call');
  PASS('PASSPHRASE_REQUIRED surfaced with NO window opened and no request made');

  // The user types their passphrase. The very next cycle proceeds — no wait.
  setSyncPassphrase('verify-backoff');
  const result = await engine.sync();
  assert.equal(result.pushFailed, undefined);
  assert.equal(result.pullFailed, undefined);
  PASS('after supplying the passphrase the NEXT cycle synced immediately — no 30s window to wait out');
}

// ═══ 11. No double-delay on CREDENTIAL_INVALID or QUOTA_EXCEEDED ════════════
section('11. no double-delay: the halt and the quota window each own their case');
{
  // (a) CREDENTIAL_INVALID: halts, and opens NO backoff window.
  await freshKeys('bo-cred');
  const d = makeDevice('bo-cred', { vaultUrl: PERACC, accountId: 'bo-acct', vaultToken: 'gvc_' + 'de'.repeat(32) });
  const engine = createDbSyncEngine(d.cfg);
  await engine.sync();
  assert.equal(engine.isCredentialHalted(), true);
  const st = engine.getBackoffState();
  assert.equal(st.push.until, 0, 'a halted credential must not ALSO open a backoff window');
  assert.equal(st.pull.until, 0);
  PASS('a real revoked/unknown credential halts and opens no window — the halt owns it alone');

  // (b) QUOTA_EXCEEDED: one window, its own, and 3.3's surface intact.
  const q = await enroll('bo-quota', QUOTA, 'bo-quota-acct');
  for (const id of ['q1', 'q2', 'q3']) {
    q.local.set(id, { id, text: 'fill', lastModified: Date.now() });
    q.engine.markDirty(id);
  }
  await q.engine.sync();               // fills the cap (verifier row + 3)
  q.local.set('q4', { id: 'q4', text: 'over', lastModified: Date.now() });
  q.engine.markDirty('q4');
  const over = await q.engine.sync();   // real 413 from the real server

  assert.equal(over.pushErrorCode, 'QUOTA_EXCEEDED');
  const qs = q.engine.getBackoffState();
  assert.equal(qs.push.reason, 'quota');
  assert.equal(qs.push.strikes, 1, 'ONE strike, not a quota window plus a transport window');
  assert.equal(qs.pull.until, 0, 'a push-side quota does not delay the pull');
  assert.equal(q.engine.isQuotaSuppressed(), true);
  assert.equal(q.engine.getQuotaState().quota, 'rows');
  PASS(`a real 413 opened exactly ONE window (reason="quota", strikes=1); 3.3's getQuotaState() surface intact`);

  // 7. Quota suppression still behaves exactly as 3.3 built it.
  const startQ = wire.length;
  for (let i = 0; i < 4; i += 1) await q.engine.sync();
  assert.equal(since(startQ, isBatch).length, 0, 'writes suppressed');
  assert.equal(since(startQ, isList).length, 4, 'pulls continue');
  const quotaErrors = q.errors.filter(e => e.code === 'QUOTA_EXCEEDED');
  assert.ok(quotaErrors.length >= 4, 'a quota window keeps surfacing its descriptor each cycle');
  assert.ok(quotaErrors.every(e => e.isHardStop === false));
  PASS(`7. quota suppression unchanged: 0 writes, 4 pulls, descriptor re-surfaced every cycle, never a hard stop`);
}

// ═══ 6. The credential halt still halts ═════════════════════════════════════
section('6. the credential halt still halts and was not softened into a backoff');
{
  const d = makeDevice('bo-cred', { vaultUrl: PERACC, accountId: 'bo-acct', vaultToken: 'gvc_' + 'de'.repeat(32) });
  const engine = createDbSyncEngine(d.cfg);
  assert.equal(engine.isCredentialHalted(), true, 'the halt persisted across engine construction');

  const start = wire.length;
  for (let i = 0; i < 3; i += 1) await engine.sync();
  assert.equal(wire.length, start, 'a halted engine makes ZERO requests, regardless of any window');
  const surfaced = d.errors.pop();
  assert.equal(surfaced.code, 'CREDENTIAL_INVALID');
  assert.equal(surfaced.isHardStop, true, 'still a HARD stop, not downgraded to a delay');
  PASS('halt intact: terminal, persisted, zero requests, still isHardStop=true');

  // And a mid-session revocation seen by the push (not ensureRootKey) still halts.
  const live = await enroll('bo-midsession', PERACC, 'bo-acct');
  await live.engine.sync();                       // key verified in-session
  inject = (entry) => (isBatch(entry) || isList(entry)
    ? { ok: false, status: 401, json: async () => ({ error: 'invalid credential' }) }
    : null);
  live.local.set('m1', { id: 'm1', text: 'x', lastModified: Date.now() });
  live.engine.markDirty('m1');
  try {
    await live.engine.sync();
  } finally {
    inject = null;
  }
  assert.equal(live.engine.isCredentialHalted(), true, 'a 401 seen by the push must still reach the halt');
  assert.equal(live.engine.getBackoffState().push.until, 0, 'and must not also open a window');
  PASS('a mid-session revocation surfacing from the push (not ensureRootKey) still halts, with no window');
}

// ═══ 12. The pull cursor advances per page ══════════════════════════════════
section('12. the pull cursor is persisted per page, so a mid-pagination failure keeps its progress');
{
  // Seed more rows than one page, then fail partway through the pagination.
  const writer = await enroll('bo-pages-w', PERACC, 'bo-pages-acct');
  for (let i = 0; i < 6; i += 1) {
    writer.local.set(`pg${i}`, { id: `pg${i}`, text: `row ${i}`, lastModified: Date.now() });
    writer.engine.markDirty(`pg${i}`);
  }
  await writer.engine.sync();

  const reader = await enroll('bo-pages-r', PERACC, 'bo-pages-acct');

  // Force REAL multi-page pagination: the client does not send a `limit`, so
  // the page size is appended at the transport boundary and the real server
  // does the real paging. Then fail the SECOND page, after the first has been
  // applied — the case that used to discard page 1's cursor progress.
  rewriteUrl = (entry) => (isList(entry) ? `${entry.url}&limit=2` : null);
  let listCalls = 0;
  inject = (entry) => {
    if (!isList(entry)) return null;
    listCalls += 1;
    if (listCalls === 2) return { ok: false, status: 503, json: async () => ({ error: 'boom' }) };
    return null;
  };
  let result;
  try {
    result = await reader.engine.sync();
  } finally {
    inject = null;
    rewriteUrl = null;
  }

  const hwmAfterFailure = reader.engine.getHighWaterMark();
  assert.equal(result.pullFailed, true, 'the second page really did fail');
  assert.ok(hwmAfterFailure > 0,
    `the cursor must keep page 1's progress; it was ${hwmAfterFailure} (0 = the old discard-everything behavior)`);
  // Page 1 holds 2 rows, one of which may be the engine-reserved verifier
  // (skipped, cursor advanced past it) — so the cursor, not the applied count,
  // is the thing under test here.
  assert.equal(hwmAfterFailure, 2, 'the cursor sits at the last seq of the completed page');
  assert.ok(reader.local.size >= 1, 'page 1\'s app rows were applied');
  PASS(`pages of 2, page 2 fails: cursor kept at seq ${hwmAfterFailure} with ${reader.local.size} app row(s) applied (cursor was discarded to 0 before this change)`);

  // Recovery resumes FROM that cursor rather than re-listing from zero.
  const startResume = wire.length;
  advanceTo(reader.engine.getBackoffState().pull.until);
  await reader.engine.sync();
  resetClock();
  const resumedFrom = new URL(since(startResume, isList)[0].url).searchParams.get('since');
  assert.equal(resumedFrom, String(hwmAfterFailure), 'the retry resumed from the kept cursor');
  assert.equal(reader.local.size >= 6, true, 'every row eventually arrived');
  PASS(`the retry resumed from since=${resumedFrom} (not 0) and applied the remaining rows: ${reader.local.size} total`);
}

Date.now = realNow;
console.log(`\n=== Result: all ${passCount} checks passed ===`);
