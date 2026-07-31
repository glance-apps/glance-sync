// Runtime verification for glance-sync Phase 2.2 (recovery from a halted
// credential) against a REAL GLANCEvault server running Phase 2.1 (no mocks).
// Extends the 1.4b harness (verify-phase-1.4b.mjs); see that file's header
// for server setup. Servers expected:
//   http://127.0.0.1:18081  shared mode       (token: shared-tok-1)
//   http://127.0.0.1:18082  per-account mode  (secret: bootstrap-secret-42)
// Env: PERACC_DB=<path to the per-account server's sqlite file>
// Run from the repo root: node scripts/verify-phase-2.2.mjs
//
// Ten items, restated by the phase owner. Revocation is the REAL mechanism:
// POST /admin/credentials/:id/revoke with the bootstrap secret as Bearer.

import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const SECRET = 'bootstrap-secret-42';
const SHARED = 'http://127.0.0.1:18081';
const PERACC = 'http://127.0.0.1:18082';
const ACCT = 'recover-acct-1';

// ── device storage shim with a full write recorder (item 6) ─────────────────
const __store = new Map();
const __writes = [];
globalThis.localStorage = {
  getItem:    (k) => (__store.has(k) ? __store.get(k) : null),
  setItem:    (k, v) => { __writes.push({ key: k, value: String(v) }); __store.set(k, String(v)); },
  removeItem: (k) => { __store.delete(k); },
  clear:      () => { __store.clear(); },
  key:        (i) => Array.from(__store.keys())[i] ?? null,
  get length() { return __store.size; },
};

// ── wire recorder around the REAL fetch ─────────────────────────────────────
const wire = [];
const recordingFetch = async (url, init) => {
  wire.push({ url: String(url), auth: init?.headers?.Authorization ?? null, method: init?.method ?? 'GET' });
  return fetch(url, init);
};

const { createDbSyncEngine } = await import('../src/dbEngine.js');
const { connectVaultSyncEngine, recoverVaultSyncEngine } = await import('../src/vaultConnect.js');
const { setSyncPassphrase } = await import('../src/crypto.js');
const { clearDbRootKey } = await import('../src/dbCrypto.js');

setSyncPassphrase('verify-pass-22');

let passCount = 0;
const PASS = (msg) => { passCount += 1; console.log(`  [PASS]  ${msg}`); };
const section = (msg) => console.log(`\n=== ${msg}`);

const makeDevice = (prefix, extra = {}) => {
  const local = new Map();
  const errors = [];
  const cfg = {
    storageKeyPrefix: prefix,
    appId: 'verifyapp',
    vaultApp: 'dayglance',
    accountId: ACCT,
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
const noErrors = (d) => assert.deepEqual(d.errors.filter(e => e.code), [], JSON.stringify(d.errors));

// Server-side truth: the admin listing (real 2.1 surface) and direct SQLite.
const adminList = async () => {
  const res = await fetch(`${PERACC}/admin/credentials`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.equal(res.status, 200);
  return (await res.json()).credentials;
};
const adminRevoke = async (credentialId) => {
  const res = await fetch(`${PERACC}/admin/credentials/${credentialId}/revoke`, {
    method: 'POST', headers: { Authorization: `Bearer ${SECRET}` },
  });
  assert.equal(res.status, 200);
  return res.json();
};
const require2 = createRequire('/workspace/glance-vault/dist/index.js');
const Database = require2('better-sqlite3');
const dbRows = (sql, ...args) => {
  const db = new Database(process.env.PERACC_DB, { readonly: true });
  const rows = db.prepare(sql).all(...args);
  db.close();
  return rows;
};

// ═══ Setup: a healthy device R on a fresh account, synced once ══════════════
section('setup: device R enrolls on a fresh account and syncs');
await freshKeys('r-dev');
const r = makeDevice('r-dev', { vaultUrl: PERACC });
let { engine: engineR, deviceId: deviceIdR } = await connectVaultSyncEngine({ ...r.cfg, enrollmentSecret: SECRET });
const credV1 = JSON.parse(localStorage.getItem('r-dev-vault-credential'));
r.local.set('note-r', { id: 'note-r', text: 'v1', lastModified: Date.now() });
engineR.markDirty('note-r');
await engineR.sync();
noErrors(r);
PASS(`device R enrolled (credentialId ${credV1.credentialId}) and synced; deviceId ${deviceIdR.slice(0, 8)}…`);

// ═══ 1 (first half). Real revocation → the device halts ═════════════════════
section('1a. operator revokes device R\'s credential (real POST /admin/.../revoke); R halts');
{
  const rev = await adminRevoke(credV1.credentialId);
  assert.equal(rev.revokedNow, true);
  await engineR.sync();
  const surfaced = r.errors.filter(e => e.code === 'CREDENTIAL_INVALID').pop();
  assert.ok(surfaced && surfaced.isHardStop === true);
  assert.equal(engineR.isCredentialHalted(), true);
  PASS('revoked credential -> 401 invalid credential -> CREDENTIAL_INVALID hard stop, halt persisted');
}

// ═══ 3. No automatic recovery: left alone, halted stays halted ══════════════
section('3. a halted device left alone stays halted; zero credential rows minted');
{
  const rowsBefore = (await adminList()).length;
  const wireBefore = wire.length;
  await engineR.sync();
  await engineR.sync();
  assert.equal(wire.length, wireBefore, 'no network from halted cycles');

  // Restart: a recreated engine (same device state) is still halted and quiet.
  const relaunch = makeDevice('r-dev', { vaultUrl: PERACC, vaultToken: credV1.credential });
  const engineRelaunch = createDbSyncEngine(relaunch.cfg);
  assert.equal(engineRelaunch.isCredentialHalted(), true);
  await engineRelaunch.sync();
  await engineRelaunch.sync();
  assert.equal(wire.length, wireBefore);

  // connect() on the halted device does not enroll either, even with a secret.
  const reconnected = await connectVaultSyncEngine({ ...makeDevice('r-dev', { vaultUrl: PERACC }).cfg, enrollmentSecret: SECRET });
  assert.equal(reconnected.enrolled, false);
  assert.equal(reconnected.engine.isCredentialHalted(), true);

  assert.equal((await adminList()).length, rowsBefore);
  assert.equal(wire.slice(wireBefore).filter(w => w.url.includes('/enroll')).length, 0);
  PASS(`halted across cycles, restarts, and reconnects: zero /enroll requests, credential rows ${rowsBefore} -> ${(await adminList()).length}`);
}

// ═══ 5. Failed recovery (wrong secret) leaves the device halted ═════════════
section('5. recovery with a WRONG secret fails and changes nothing');
{
  const staleRaw = localStorage.getItem('r-dev-vault-credential');
  let threw = null;
  try {
    await recoverVaultSyncEngine({ ...makeDevice('r-dev', { vaultUrl: PERACC }).cfg, enrollmentSecret: 'wrong-secret' });
  } catch (e) { threw = e; }
  assert.equal(threw?.code, 'ENROLLMENT_REJECTED');
  assert.equal(localStorage.getItem('r-dev-vault-credential'), staleRaw, 'stale record byte-identical');
  assert.notEqual(localStorage.getItem('r-dev-db-sync-credential-halt'), null, 'halt not cleared');
  PASS('wrong secret -> ENROLLMENT_REJECTED; stale record byte-identical, halt intact, device stays halted');
}

// ═══ 1 (second half) + 6. User-initiated recovery, then syncing again ═══════
section('1b. user-initiated recovery with the real secret; device syncs again');
const secretScanStart = __writes.length;
let engineR2;
{
  const r2 = makeDevice('r-dev', { vaultUrl: PERACC });
  const recovered = await recoverVaultSyncEngine({ ...r2.cfg, enrollmentSecret: SECRET });
  engineR2 = recovered.engine;
  assert.equal(recovered.enrolled, true);
  assert.equal(recovered.authMode, 'per-account');
  assert.equal(localStorage.getItem('r-dev-db-sync-credential-halt'), null, 'halt cleared');

  r2.local.set('note-r', { id: 'note-r', text: 'v2 after recovery', lastModified: Date.now() });
  engineR2.markDirty('note-r');
  await engineR2.sync();
  noErrors(r2);
  assert.equal(engineR2.isCredentialHalted(), false);
  PASS('recovery enrolled a new credential, cleared the halt, and the fresh engine syncs cleanly');
}

// ═══ 2. Recovery rotates: predecessor revoked, exactly one active ═══════════
section('2. rotation: the predecessor is revoked server-side; exactly one active credential remains');
{
  const credV2 = JSON.parse(localStorage.getItem('r-dev-vault-credential'));
  assert.notEqual(credV2.credential, credV1.credential);
  const mine = (await adminList()).filter(c => c.accountId === ACCT && c.deviceId === deviceIdR);
  const active = mine.filter(c => c.revokedAt === null);
  const v1Row = mine.find(c => c.credentialId === credV1.credentialId);
  assert.equal(active.length, 1, `expected exactly one active credential, got ${JSON.stringify(mine)}`);
  assert.equal(active[0].credentialId, credV2.credentialId);
  assert.notEqual(v1Row.revokedAt, null);
  PASS(`(${ACCT}, ${deviceIdR.slice(0, 8)}…) holds ${mine.length} rows, exactly 1 active (${credV2.credentialId}); predecessor ${credV1.credentialId} has revokedAt ${v1Row.revokedAt}`);
}

// ═══ 4. deviceId unchanged; cursor row intact server-side ═══════════════════
section('4. deviceId unchanged through halt and recovery; device cursor row intact');
{
  assert.equal(localStorage.getItem('r-dev-device-id'), deviceIdR);
  assert.equal(engineR2.deviceId, deviceIdR);
  const cursorRows = dbRows('SELECT device_id, last_seen_seq FROM devices WHERE device_id = ?', deviceIdR);
  assert.equal(cursorRows.length, 1);
  PASS(`deviceId ${deviceIdR.slice(0, 8)}… identical before/after; devices row intact (last_seen_seq ${cursorRows[0].last_seen_seq})`);
}

// ═══ 6. Secret absent from storage across the whole recovery ════════════════
section('6. the bootstrap secret is absent from every storage write of the recovery');
{
  const span = __writes.slice(secretScanStart);
  assert.ok(span.length > 0);
  assert.deepEqual(span.filter(w => w.key.includes(SECRET) || w.value.includes(SECRET)), []);
  assert.deepEqual([...__store.entries()].filter(([k, v]) => k.includes(SECRET) || v.includes(SECRET)), []);
  PASS(`${span.length} storage writes during recovery+resync — none contains the secret; final storage clean`);
}

// ═══ 9. The stale-engine hazard is defused ══════════════════════════════════
section('9. a stale engine still holding the superseded credential cannot brick the recovered device');
{
  // engineR (and engineRelaunch) still close over the REVOKED v1 credential.
  // Post-recovery the halt is clear, so the stale engine wakes and fails —
  // but the stored record now differs from its bearer, so it goes inert
  // without touching the shared halt key.
  await engineR.sync();
  assert.equal(engineR.isSuperseded(), true);
  assert.equal(localStorage.getItem('r-dev-db-sync-credential-halt'), null, 'shared halt key untouched');

  const wireBefore = wire.length;
  await engineR.sync();
  await engineR.sync();
  assert.equal(wire.length, wireBefore, 'stale engine is inert: zero further requests');

  // The recovered engine keeps syncing.
  await engineR2.sync();
  assert.equal(engineR2.isCredentialHalted(), false);
  assert.equal(engineR2.isSuperseded(), false);

  // And a second device still sees R's post-recovery data (full round-trip).
  await freshKeys('r-peer');
  const peer = makeDevice('r-peer', { vaultUrl: PERACC });
  const { engine: peerEngine } = await connectVaultSyncEngine({ ...peer.cfg, enrollmentSecret: SECRET });
  await peerEngine.sync();
  noErrors(peer);
  assert.equal(peer.local.get('note-r')?.text, 'v2 after recovery');
  PASS('stale engine went inert (once-surfaced, then silent, halt key untouched); recovered engine keeps syncing; peers see its data');
}

// ═══ 10. The missing-record case halts (fail toward halting) ════════════════
section('10. a 401 with the credential record missing still sets the halt');
{
  await freshKeys('m-dev');
  const m = makeDevice('m-dev', { vaultUrl: PERACC, vaultToken: 'gvc_' + '00'.repeat(32) });
  const engineM = createDbSyncEngine(m.cfg);
  assert.equal(localStorage.getItem('m-dev-vault-credential'), null);
  await engineM.sync();
  assert.equal(engineM.isCredentialHalted(), true);
  assert.equal(engineM.isSuperseded(), false);
  PASS('no stored record + dead bearer -> halt set, not an infinite retry');
}

// ═══ 7. A healthy per-account device is unaffected ══════════════════════════
section('7. a healthy per-account device is unaffected by everything this phase adds');
{
  await freshKeys('h-dev');
  const h = makeDevice('h-dev', { vaultUrl: PERACC });
  const { engine } = await connectVaultSyncEngine({ ...h.cfg, enrollmentSecret: SECRET });
  h.local.set('note-h', { id: 'note-h', text: 'healthy', lastModified: Date.now() });
  engine.markDirty('note-h');
  await engine.sync();
  await engine.sync();
  noErrors(h);
  assert.equal(engine.isCredentialHalted(), false);
  assert.equal(engine.isSuperseded(), false);
  PASS('healthy device: enrolls once, syncs repeatedly, no halt, no inertness, no errors');
}

// ═══ 8. Shared mode is unaffected and cannot enter halt or recovery ═════════
section('8. shared mode: unchanged, unhaltable, and recovery refuses it');
{
  await freshKeys('s-dev');
  const s = makeDevice('s-dev', { vaultUrl: SHARED, vaultToken: 'shared-tok-1' });
  const engineS = createDbSyncEngine(s.cfg);
  s.local.set('note-s', { id: 'note-s', text: 'shared ok', lastModified: Date.now() });
  engineS.markDirty('note-s');
  await engineS.sync();
  noErrors(s);
  PASS('a correctly configured shared-mode device syncs exactly as today');

  // A WRONG shared token errors but never halts, and keeps retrying.
  await freshKeys('s-bad');
  const bad = makeDevice('s-bad', { vaultUrl: SHARED, vaultToken: 'wrong-token' });
  const engineBad = createDbSyncEngine(bad.cfg);
  await engineBad.sync();
  assert.equal(engineBad.isCredentialHalted(), false);
  assert.ok(bad.errors.every(e => e.code !== 'CREDENTIAL_INVALID'));
  const before = wire.length;
  await engineBad.sync();
  assert.ok(wire.length > before, 'still retrying — no halt in shared mode');
  PASS('a wrong shared token is an ordinary retryable error: no CREDENTIAL_INVALID, no halt');

  // Recovery structurally refuses a shared-mode server, even if a halt
  // record somehow exists on the device.
  localStorage.setItem('s-bad-db-sync-credential-halt', JSON.stringify({ message: 'x', at: 'y' }));
  let threw = null;
  try {
    await recoverVaultSyncEngine({ ...makeDevice('s-bad', { vaultUrl: SHARED }).cfg, enrollmentSecret: SECRET });
  } catch (e) { threw = e; }
  assert.equal(threw?.code, 'RECOVERY_UNSUPPORTED');
  assert.equal(wire.filter(w => w.url.startsWith(SHARED) && w.url.includes('/enroll')).length, 0);
  PASS('recoverVaultSyncEngine against the shared server -> RECOVERY_UNSUPPORTED, nothing enrolled');
}

console.log(`\n=== Result: all ${passCount} checks passed (10/10 items) ===`);
