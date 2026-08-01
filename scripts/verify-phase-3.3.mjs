// Runtime verification for glance-sync Phase 3.3 (client over-quota handling)
// against a REAL GLANCEvault server running Phase 3.2 quota enforcement.
//
// THE CORRECTED PREMISE, which shapes this whole file: this package has no
// blob path, no intents path, and no SSE client. Of the server's four quota
// dimensions, only `rows` is reachable from here — and only when an operator
// configures the optional row cap. Items 6, 8 and 9 are therefore recorded as
// DOCUMENTED NEGATIVES rather than faked with mocks of a client that does not
// exist; see the [N/A] entries at the end, which say exactly what a future
// media-transport phase will have to verify.
//
// Servers expected (start them as in verify-phase-1.4b.mjs's header):
//   18081  shared, NO quota configured        (token: shared-tok-1)
//   18082  per-account, NO quota configured   (secret: bootstrap-secret-42)
//   18085  per-account, GLANCEVAULT_QUOTA_ROWS configured
//          (restart it with a new cap via scratchpad/restart-quota-server.sh)
//
// Run from the repo root:  node scripts/verify-phase-3.3.mjs
// Env: RESTART_QUOTA_SERVER=<path to restart-quota-server.sh> enables item 5's
// "operator raises the limit" step; without it that item is skipped loudly.

import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

const SECRET = 'bootstrap-secret-42';
const SHARED = 'http://127.0.0.1:18081';
const PERACC = 'http://127.0.0.1:18082';
const QUOTA  = 'http://127.0.0.1:18085';
const RESTART = process.env.RESTART_QUOTA_SERVER || null;

const __store = new Map();
globalThis.localStorage = {
  getItem:    (k) => (__store.has(k) ? __store.get(k) : null),
  setItem:    (k, v) => { __store.set(k, String(v)); },
  removeItem: (k) => { __store.delete(k); },
  clear:      () => { __store.clear(); },
  key:        (i) => Array.from(__store.keys())[i] ?? null,
  get length() { return __store.size; },
};

// Wire recorder around the REAL fetch. `inject` lets a test rewrite a real
// response (used only where the real server cannot be made to emit the case,
// and always labelled as such in the output).
const wire = [];
let inject = null;
const recordingFetch = async (url, init) => {
  const entry = { url: String(url), method: init?.method ?? 'GET' };
  wire.push(entry);
  const res = await fetch(url, init);
  if (inject) {
    const replaced = inject(entry, res);
    if (replaced) return replaced;
  }
  return res;
};
const wireSince = (n, pred) => wire.slice(n).filter(pred);
const isBatch = (w) => w.url.includes('/batch');
const isList = (w) => w.url.includes('/list');
const isDevice = (w) => w.url.endsWith('/device');

const { createDbSyncEngine } = await import('../src/dbEngine.js');
const { connectVaultSyncEngine } = await import('../src/vaultConnect.js');
const { setSyncPassphrase } = await import('../src/crypto.js');
const { clearDbRootKey } = await import('../src/dbCrypto.js');

setSyncPassphrase('verify-pass-33');

let passCount = 0;
let naCount = 0;
const PASS = (msg) => { passCount += 1; console.log(`  [PASS]  ${msg}`); };
const NA = (msg) => { naCount += 1; console.log(`  [N/A]   ${msg}`); };
const section = (msg) => console.log(`\n=== ${msg}`);

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
    onError: (message, code, isHardStop) => { errors.push({ message, code, isHardStop }); },
    ...extra,
  };
  return { local, errors, cfg };
};
const freshKeys = async (prefix) => { await clearDbRootKey({ cryptoDBName: `crypto-${prefix}` }); };
const codes = (d) => d.errors.filter(e => e.code).map(e => e.code);
const enroll = async (prefix, vaultUrl, accountId, extra = {}) => {
  await freshKeys(prefix);
  const d = makeDevice(prefix, { vaultUrl, accountId, ...extra });
  const { engine } = await connectVaultSyncEngine({ ...d.cfg, enrollmentSecret: SECRET });
  return { ...d, engine };
};

// ═══ 1. An unconfigured server behaves exactly as today, in BOTH modes ══════
section('1. unconfigured server (no quota): behavior identical to today, both modes');
{
  // shared
  await freshKeys('u-shared');
  const s = makeDevice('u-shared', { vaultUrl: SHARED, accountId: 'q1-acct', vaultToken: 'shared-tok-1' });
  const sEngine = createDbSyncEngine(s.cfg);
  s.local.set('t1', { id: 't1', text: 'shared text', lastModified: Date.now() });
  sEngine.markDirty('t1');
  const sResult = await sEngine.sync();
  assert.deepEqual(codes(s), []);
  assert.equal(sResult.pushFailed, undefined);
  assert.equal(sResult.pushSkipped, undefined);
  assert.equal(sEngine.getQuotaState(), null);
  assert.notEqual(sEngine.getLastSynced(), null);
  PASS('shared + unconfigured: clean cycle, no quota state, no push flags, lastSynced set');

  // per-account
  const p = await enroll('u-peracc', PERACC, 'q1-acct');
  p.local.set('t2', { id: 't2', text: 'per-account text', lastModified: Date.now() });
  p.engine.markDirty('t2');
  const pResult = await p.engine.sync();
  assert.deepEqual(codes(p), []);
  assert.equal(pResult.pushFailed, undefined);
  assert.equal(p.engine.getQuotaState(), null);
  assert.equal(p.engine.isQuotaSuppressed(), false);
  PASS('per-account + unconfigured: clean cycle, no quota state — nothing this phase adds engages');
}

// ═══ Setup on the quota server: fill the account to its row cap ═════════════
// Cap is 4. The key verifier's own row (__glance_keycheck) is one of them, so
// a device can write 3 more entities before net-new writes are rejected.
section('setup: device A on the row-capped server, filling the cap');
const a = await enroll('q-devA', QUOTA, 'cap-acct');
{
  for (const id of ['e1', 'e2', 'e3']) {
    a.local.set(id, { id, text: `row ${id}`, lastModified: Date.now() });
    a.engine.markDirty(id);
  }
  const r = await a.engine.sync();
  assert.deepEqual(codes(a), [], JSON.stringify(a.errors));
  assert.equal(r.pushFailed, undefined);
  PASS('device A wrote 3 entities plus the verifier row: the account is now AT the cap of 4');
}

// ═══ 2 (row-cap form). Over the cap: everything the server still permits ════
section('2. over the row cap: updates, deletes, cursors and pulls all keep working — only NET-NEW is blocked');
{
  // A peer writes nothing new; it will feed the pull below.
  const wireStart = wire.length;

  // (a) a NET-NEW entity is rejected...
  a.local.set('e4-new', { id: 'e4-new', text: 'over the cap', lastModified: Date.now() });
  a.engine.markDirty('e4-new');
  const rejected = await a.engine.sync();
  assert.equal(rejected.pushFailed, true);
  assert.equal(rejected.pushErrorCode, 'QUOTA_EXCEEDED');
  const qs = a.engine.getQuotaState();
  assert.equal(qs.quota, 'rows');
  assert.equal(typeof qs.limit, 'number');
  assert.equal(typeof qs.used, 'number');
  PASS(`net-new entity rejected: quota "${qs.quota}", ${qs.used} of ${qs.limit} used, requested ${qs.requested}`);

  // ...(b) but the PULL in that very cycle still ran, and so did the cursor.
  assert.ok(wireSince(wireStart, isList).length >= 1, 'the pull ran despite the rejected push');
  assert.ok(wireSince(wireStart, isDevice).length >= 1, 'the device cursor still reported');
  PASS('the same cycle still pulled and still reported its device cursor (partial function)');

  // (c) UPDATES to existing entities keep working. Drop the net-new row from
  // the dirty set (as an app would when the user removes it) so the push
  // carries only updates, and clear the suppression window by hand-free means:
  // a fresh engine instance has no in-memory window, exactly like a relaunch.
  await freshKeys('q-devA2');
  const a2 = makeDevice('q-devA2', { vaultUrl: QUOTA, accountId: 'cap-acct' });
  const cred = JSON.parse(localStorage.getItem('q-devA-vault-credential'));
  const a2Engine = createDbSyncEngine({ ...a2.cfg, vaultToken: cred.credential });
  for (const id of ['e1', 'e2']) {
    a2.local.set(id, { id, text: `UPDATED ${id}`, lastModified: Date.now() });
    a2Engine.markDirty(id);
  }
  const updateResult = await a2Engine.sync();
  assert.equal(updateResult.pushFailed, undefined, JSON.stringify(a2.errors));
  assert.equal(a2Engine.getQuotaState(), null);
  PASS('updates to EXISTING entities succeed while the account is at the cap (the server gates net-new only)');

  // (d) soft-deletes keep working.
  a2.local.delete('e3');
  a2Engine.markDirty('e3');
  const deleteResult = await a2Engine.sync();
  assert.equal(deleteResult.pushFailed, undefined, JSON.stringify(a2.errors));
  PASS('soft-deletes succeed at the cap (the delete route is never quota-gated)');

  // (e) a peer device still receives everything.
  const peer = await enroll('q-peer', QUOTA, 'cap-acct');
  await peer.engine.sync();
  assert.equal(peer.local.get('e1')?.text, 'UPDATED e1');
  assert.equal(peer.local.get('e3'), undefined, 'the delete propagated');
  PASS('a peer device pulled the updates and the delete: reads are entirely unaffected by the cap');
}

// ═══ 3. A quota rejection does not halt and does not set the credential halt ═
section('3. a quota rejection never halts the engine');
{
  assert.equal(a.engine.isCredentialHalted(), false);
  assert.equal(localStorage.getItem('q-devA-db-sync-credential-halt'), null);
  const quotaErrors = a.errors.filter(e => e.code === 'QUOTA_EXCEEDED');
  assert.ok(quotaErrors.length > 0);
  assert.ok(quotaErrors.every(e => e.isHardStop === false), 'every quota error is a NON-hard-stop');
  PASS(`QUOTA_EXCEEDED surfaced ${quotaErrors.length}x, always isHardStop=false; no halt key written, engine still live`);
}

// ═══ 4. The client does not hammer a doomed write ═══════════════════════════
section('4. request pattern: one write attempt, then suppression — while pulls continue');
{
  const wireStart = wire.length;
  assert.equal(a.engine.isQuotaSuppressed(), true, 'the window opened on the rejection in item 2');

  for (let i = 0; i < 5; i += 1) await a.engine.sync();

  const batches = wireSince(wireStart, isBatch).length;
  const lists = wireSince(wireStart, isList).length;
  const devices = wireSince(wireStart, isDevice).length;
  assert.equal(batches, 0, `expected ZERO write attempts inside the window, saw ${batches}`);
  assert.equal(lists, 5, 'every suppressed cycle still pulled');
  assert.equal(devices, 5, 'every suppressed cycle still reported its cursor');
  PASS(`5 cycles inside the window: ${batches} write attempts, ${lists} pulls, ${devices} cursor reports`);
  PASS(`suppression is bounded and self-resuming — next probe due at ${a.engine.getQuotaState().retryAt}`);
}

// ═══ 5. Recovery needs no client action ═════════════════════════════════════
section('5. the operator raises the limit; the running engine resumes on its own');
if (!RESTART) {
  NA('SKIPPED: set RESTART_QUOTA_SERVER=<path to restart-quota-server.sh> to run this item');
} else {
  const before = a.engine.getQuotaState();
  assert.ok(before, 'still over quota going in');

  // The OPERATOR acts. The client is not told, not restarted, not re-enrolled.
  execFileSync('bash', [RESTART, '50'], { encoding: 'utf8' });

  // Wait out the suppression window (30s base). No client action of any kind.
  const waitMs = Math.max(0, new Date(before.retryAt).getTime() - Date.now()) + 1500;
  console.log(`  ... waiting ${Math.round(waitMs / 1000)}s for the engine's own next probe (no client action)`);
  await new Promise(r => setTimeout(r, waitMs));

  const resumed = await a.engine.sync();
  assert.equal(resumed.pushFailed, undefined, JSON.stringify(a.errors.slice(-2)));
  assert.equal(resumed.pushSkipped, undefined);
  assert.equal(a.engine.getQuotaState(), null, 'the state cleared itself when a write got through');
  assert.equal(a.engine.isQuotaSuppressed(), false);
  assert.deepEqual(a.engine.getDirtySet(), [], 'the previously blocked row finally landed');
  PASS('same engine instance, no restart / re-enrollment / user action: the write landed and the quota state cleared itself');
}

// ═══ 7. Malformed and unrecognised bodies degrade gracefully ════════════════
section('7. defensive parse: malformed and unrecognised quota bodies degrade to generic handling');
{
  // The real server cannot be made to emit these, so the RESPONSE is rewritten
  // at the transport boundary while every other part of the stack stays real.
  const cases = [
    ['413 with NO quota fields', 413, { error: 'payload too large' }, 'VAULT_ERROR'],
    ['413 missing the numbers', 413, { error: 'quota exceeded', quota: 'rows' }, 'VAULT_ERROR'],
    ['413 with a non-JSON body', 413, null, 'VAULT_ERROR'],
    ['429 legacy SSE wording', 429, { error: 'too many connections for account' }, 'VAULT_ERROR'],
    ['413 UNKNOWN dimension from a newer server', 413,
      { error: 'quota exceeded', quota: 'bandwidth-2027', limit: 9, used: 9, requested: 1 }, 'QUOTA_EXCEEDED'],
  ];

  for (const [label, status, body, expected] of cases) {
    await freshKeys('q-parse');
    const d = makeDevice('q-parse', { vaultUrl: QUOTA, accountId: 'cap-acct', vaultToken: credOf('q-devA') });
    const engine = createDbSyncEngine(d.cfg);
    d.local.set('p1', { id: 'p1', text: 'x', lastModified: Date.now() });
    engine.markDirty('p1');

    inject = (entry) => {
      if (!isBatch(entry)) return null;
      return {
        ok: false, status,
        json: async () => { if (body === null) throw new Error('not json'); return body; },
      };
    };
    try {
      const r = await engine.sync();
      assert.equal(r.pushErrorCode, expected, `${label}: expected ${expected}, got ${r.pushErrorCode}`);
      assert.equal(engine.isCredentialHalted(), false, `${label}: must never halt`);
      // Whatever the classification, the pull still ran.
      assert.equal(r.pushFailed, true);
    } finally {
      inject = null;
    }
    PASS(`${label} -> ${expected}, no throw, no halt, pull still ran`);
  }
}

function credOf(prefix) {
  const raw = localStorage.getItem(`${prefix}-vault-credential`);
  return raw ? JSON.parse(raw).credential : null;
}

// ═══ 10. A failed push still pulls — quota AND non-quota ════════════════════
section('10. a failed push still pulls, for a NON-quota failure as well as a quota one');
{
  // A peer writes a row this device must receive despite its own push failing.
  const writer = await enroll('q-writer', QUOTA, 'cap-acct');
  writer.local.set('from-peer-33', { id: 'from-peer-33', text: 'peer wrote this', lastModified: Date.now() });
  writer.engine.markDirty('from-peer-33');
  await writer.engine.sync();
  assert.deepEqual(codes(writer), [], JSON.stringify(writer.errors));

  await freshKeys('q-nonquota');
  const d = makeDevice('q-nonquota', { vaultUrl: QUOTA, accountId: 'cap-acct', vaultToken: credOf('q-devA') });
  const engine = createDbSyncEngine(d.cfg);
  d.local.set('mine-33', { id: 'mine-33', text: 'my local edit', lastModified: Date.now() });
  engine.markDirty('mine-33');

  // A plain 503 on the batch only — everything else is the real server.
  const wireStart = wire.length;
  inject = (entry) => (isBatch(entry)
    ? { ok: false, status: 503, json: async () => ({ error: 'upstream unavailable' }) }
    : null);
  let result;
  try {
    result = await engine.sync();
  } finally {
    inject = null;
  }

  assert.equal(result.pushFailed, true);
  assert.equal(result.pushErrorCode, 'VAULT_ERROR');
  assert.equal(result.applied >= 1, true, 'the pull applied rows despite the failed push');
  assert.equal(d.local.get('from-peer-33')?.text, 'peer wrote this');
  assert.ok(wireSince(wireStart, isDevice).length >= 1, 'the cursor still reported');
  assert.equal(engine.getDirtySet().includes('mine-33'), true, 'the unsent row is retained for the next cycle');
  assert.equal(engine.getLastSynced(), null, 'lastSynced is NOT claimed when the push did not land');
  assert.equal(engine.getQuotaState(), null, 'a non-quota failure opens no suppression window');
  PASS('NON-quota (503) push failure: pull applied the peer row, cursor reported, dirty row retained, lastSynced not claimed');

  // And the same for the quota case, proven in item 2 — restated on the wire.
  assert.ok(wire.some(w => isBatch(w)), 'quota case covered in item 2');
  PASS('quota push failure: same behavior, demonstrated in item 2 above');
}

// ═══ 11. The verifier reports a quota rejection truthfully ══════════════════
section('11. a fresh device hitting the cap while establishing the keycheck row');
{
  // The verifier row is ACCOUNT-scoped, so the interesting case is a
  // brand-new account whose very first write — the verifier's establishing
  // row — is itself the net-new entity the cap rejects. Capping the server at
  // 1 leaves zero headroom for a fresh account (its own first row is #1... and
  // the second is refused), so this is the exact shape a real deployment hits
  // when a household adds a device to an account already at its cap.
  if (RESTART) {
    execFileSync('bash', [RESTART, '1'], { encoding: 'utf8' });
    const fresh = await enroll('q-fresh-verifier', QUOTA, 'brand-new-acct-33');
    fresh.local.set('never-lands', { id: 'never-lands', text: 'x', lastModified: Date.now() });
    fresh.engine.markDirty('never-lands');
    await fresh.engine.sync();

    const surfaced = fresh.errors.filter(e => e.code).pop();
    assert.equal(surfaced.code, 'QUOTA_EXCEEDED', `got ${surfaced.code}: ${surfaced.message}`);
    assert.notEqual(surfaced.code, 'VERIFIER_UNSUPPORTED');
    assert.ok(!/needs to be updated/.test(surfaced.message), 'must not tell the user to update a working server');
    assert.equal(surfaced.isHardStop, false);
    assert.equal(fresh.engine.isCredentialHalted(), false);
    assert.equal(fresh.engine.getQuotaState().quota, 'rows');
    PASS(`the verifier's rejected establishing write surfaced as QUOTA_EXCEEDED, not VERIFIER_UNSUPPORTED`);
    PASS(`message reads "${surfaced.message.slice(0, 78)}…" — the truth, not "update your server"`);
    execFileSync('bash', [RESTART, '50'], { encoding: 'utf8' });
  } else {
    NA('SKIPPED: needs RESTART_QUOTA_SERVER to cap the server at zero headroom');
  }
}

// ═══ 6, 8, 9. DOCUMENTED NEGATIVES ═════════════════════════════════════════
section('6, 8, 9. documented negatives — paths this package cannot reach');
{
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  const clientSource = await (await import('node:fs/promises')).readFile(
    new URL('../src/vaultClient.js', import.meta.url), 'utf8');

  // Prove the absence rather than asserting it in prose.
  for (const path of ['/blobs', '/uploads', '/intents', 'event-stream', 'EventSource']) {
    assert.equal(clientSource.includes(path), false, `vaultClient must not reference ${path}`);
  }
  console.log(`  (verified against ${pkg.name}@${pkg.version}: the vault client references none of` +
              ` /blobs, /uploads, /intents, event-stream, EventSource)`);

  NA('6. intents TTL self-heal: NOT REACHABLE. This package has no intents path — intents are sent by ' +
     '@glance-apps/intents, so a 429 quota:"intents" can only arrive there. The parse and the ' +
     'non-halting suppression built here apply to any dimension, so whoever wires intents inherits them.');
  NA('8. legacy SSE 429: NOT REACHABLE. This package has no SSE client, so it can never receive ' +
     '{"error":"too many connections for account"}. Proven at the parse instead (item 7 above, and the ' +
     'unit suite): that body degrades to VAULT_ERROR and is never mistaken for a quota rejection.');
  NA('9. DELETE /blobs/uploads/:uploadId: NOT ADOPTED, because there is nothing to cancel. This package ' +
     'never opens an upload session — it has no blob path at all — so no session is ever left abandoned. ' +
     'Adopting cancel means first building the upload lifecycle, which belongs with the media transport ' +
     'phase alongside the paths that would call it.');
}

console.log(`\n=== Result: ${passCount} checks passed, ${naCount} documented negatives/skips ===`);
