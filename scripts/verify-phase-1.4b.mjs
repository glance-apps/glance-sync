// Runtime verification for glance-sync Phase 1.4b against REAL GLANCEvault
// servers (no mocks). Eight items, restated by the phase owner, in order.
//
// Setup (run `npm install` here first; needs a glance-vault checkout built
// with `npm install && npm run build`):
//   GLANCEVAULT_PORT=18081 GLANCEVAULT_STORAGE_PATH=<dirA>/db.sqlite \
//     GLANCEVAULT_DEVICE_TOKEN=shared-tok-1 node <vault>/dist/index.js
//   GLANCEVAULT_PORT=18082 GLANCEVAULT_STORAGE_PATH=<dirB>/db.sqlite \
//     GLANCEVAULT_DEVICE_TOKEN=unused-shared-tok GLANCEVAULT_AUTH_MODE=per-account \
//     GLANCEVAULT_ENROLLMENT_SECRET=bootstrap-secret-42 node <vault>/dist/index.js
//   http://127.0.0.1:18083: the same, from a checkout of vault commit 67b535c
//     (pre-1.4a, /healthz without authMode), GLANCEVAULT_DEVICE_TOKEN=shared-tok-old
//
// Then: SHARED_DB=<dirA>/db.sqlite PERACC_DB=<dirB>/db.sqlite \
//         node scripts/verify-phase-1.4b.mjs
// (SHARED_DB/PERACC_DB let items 6 and 8 assert directly against the server's
// SQLite; the better-sqlite3 module is loaded from the vault checkout via the
// path in createRequire below — adjust if your checkout lives elsewhere.)

import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const SECRET = 'bootstrap-secret-42';
const SHARED = 'http://127.0.0.1:18081';
const PERACC = 'http://127.0.0.1:18082';
const OLD    = 'http://127.0.0.1:18083';

// ── device storage shim, with a full write recorder (item 4) ────────────────
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

// ── wire recorder wrapped around the REAL fetch (items 5, 8) ────────────────
const wire = [];
const recordingFetch = async (url, init) => {
  wire.push({ url: String(url), auth: init?.headers?.Authorization ?? null, method: init?.method ?? 'GET' });
  return fetch(url, init);
};

const { createDbSyncEngine, getOrCreateDeviceId } = await import('../src/dbEngine.js');
const { connectVaultSyncEngine } = await import('../src/vaultConnect.js');
const { fetchVaultHealth } = await import('../src/vaultClient.js');
const { setSyncPassphrase } = await import('../src/crypto.js');
const { clearDbRootKey } = await import('../src/dbCrypto.js');

setSyncPassphrase('verify-pass-1');

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
    accountId: 'verify-acct-1',
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

// ═══ 1. Shared-mode server: a client configured as today syncs, unchanged ═══
section('1. shared server + pre-1.4b construction path (createDbSyncEngine + device token)');
{
  const a = makeDevice('s1-devA', { vaultUrl: SHARED, vaultToken: 'shared-tok-1' });
  const engineA = createDbSyncEngine(a.cfg);
  a.local.set('note-1', { id: 'note-1', text: 'hello from shared A', lastModified: Date.now() });
  engineA.markDirty('note-1');
  await engineA.sync();
  assert.deepEqual(a.errors.filter(e => e.code), [], `no errors expected, got ${JSON.stringify(a.errors)}`);
  PASS('device A pushed a row with the shared device token (createDbSyncEngine, exactly as today)');

  await freshKeys('s1-devB');
  const b = makeDevice('s1-devB', { vaultUrl: SHARED, vaultToken: 'shared-tok-1' });
  const engineB = createDbSyncEngine(b.cfg);
  await engineB.sync();
  assert.deepEqual(b.errors.filter(e => e.code), []);
  assert.equal(b.local.get('note-1')?.text, 'hello from shared A');
  PASS('device B pulled the row: full round-trip on a shared server, behavior unchanged');
}

// ═══ 5 (first half). Discovery identifies each server's mode before auth ════
section('5. mode discovery, unauthenticated, before any authenticated request');
{
  const hShared = await fetchVaultHealth({ vaultUrl: SHARED, fetchImpl: recordingFetch });
  const hPer = await fetchVaultHealth({ vaultUrl: PERACC, fetchImpl: recordingFetch });
  assert.equal(hShared.authMode, 'shared');
  assert.equal(hPer.authMode, 'per-account');
  PASS(`discovery: ${SHARED} -> "${hShared.authMode}", ${PERACC} -> "${hPer.authMode}"`);
}

// ═══ 2. Per-account: fresh client enrolls, receives credential, syncs ═══════
section('2. per-account server: fresh client enrolls via connectVaultSyncEngine and syncs');
const wireStartPer = wire.length;
let credA;
{
  await freshKeys('p1-devA');
  const a = makeDevice('p1-devA', { vaultUrl: PERACC });
  const { engine, authMode, enrolled, deviceId } = await connectVaultSyncEngine({ ...a.cfg, enrollmentSecret: SECRET });
  assert.equal(authMode, 'per-account');
  assert.equal(enrolled, true);
  assert.equal(deviceId, localStorage.getItem('p1-devA-device-id'));
  credA = JSON.parse(localStorage.getItem('p1-devA-vault-credential'));
  assert.match(credA.credential, /^gvc_[0-9a-f]{64}$/);
  PASS(`enrolled: credentialId ${credA.credentialId}, credential ${credA.credential.slice(0, 12)}…, deviceId ${deviceId.slice(0, 8)}…`);

  a.local.set('note-p1', { id: 'note-p1', text: 'hello from per-account A', lastModified: Date.now() });
  engine.markDirty('note-p1');
  await engine.sync();
  assert.deepEqual(a.errors.filter(e => e.code), [], `no errors expected, got ${JSON.stringify(a.errors)}`);
  PASS('fresh client synced (push cycle clean) using its enrolled credential as the Bearer value');

  // Item 5, per-account half: on this server the FIRST request was /healthz,
  // unauthenticated, before anything carrying Authorization.
  const perWire = wire.slice(wireStartPer).filter(w => w.url.startsWith(PERACC));
  assert.ok(perWire[0].url.endsWith('/healthz') && perWire[0].auth === null);
  const firstAuthed = perWire.findIndex(w => w.auth !== null);
  assert.ok(firstAuthed > 0);
  PASS('the client identified the mode before attempting to authenticate (healthz first, no Authorization)');
}

// ═══ 3. Two devices enroll the same account, distinct credentials, both sync ═
section('3. second device enrolls: distinct credential, same account, data flows');
let credB;
{
  await freshKeys('p1-devB');
  const b = makeDevice('p1-devB', { vaultUrl: PERACC });
  const { engine, enrolled } = await connectVaultSyncEngine({ ...b.cfg, enrollmentSecret: SECRET });
  assert.equal(enrolled, true);
  credB = JSON.parse(localStorage.getItem('p1-devB-vault-credential'));
  assert.notEqual(credB.credential, credA.credential);
  assert.notEqual(credB.credentialId, credA.credentialId);
  assert.equal(credB.accountId, credA.accountId);
  PASS(`device B minted a DISTINCT credential (${credB.credential.slice(0, 12)}… vs ${credA.credential.slice(0, 12)}…), same account`);

  await engine.sync();
  assert.deepEqual(b.errors.filter(e => e.code), []);
  assert.equal(b.local.get('note-p1')?.text, 'hello from per-account A');
  PASS('device B pulled device A\'s row using its own credential');
}

// ═══ 4. Bootstrap secret provably absent from client storage ════════════════
section('4. the bootstrap secret is absent from every client storage write');
{
  assert.ok(__writes.length > 0);
  const dirty = __writes.filter(w => w.key.includes(SECRET) || w.value.includes(SECRET));
  assert.deepEqual(dirty, []);
  const finalDirty = [...__store.entries()].filter(([k, v]) => k.includes(SECRET) || v.includes(SECRET));
  assert.deepEqual(finalDirty, []);
  PASS(`${__writes.length} storage writes recorded across the whole run so far — none contains the secret`);
  PASS(`${__store.size} keys in final storage — none contains the secret (it existed only as a call argument and in the one enroll request body)`);
}

// ═══ 6. Existing install, upgraded: keeps syncing, no user action ═══════════
section('6. existing configured install (device token, pre-existing state, NO deviceId) after upgrade');
{
  // Simulate the pre-upgrade install: sync state exists, no {prefix}-device-id.
  localStorage.setItem('s2-old-db-sync-hwm', '0');
  localStorage.setItem('s2-old-db-sync-config', JSON.stringify({ enabled: true }));
  assert.equal(localStorage.getItem('s2-old-device-id'), null);

  await freshKeys('s2-old');
  const a = makeDevice('s2-old', { vaultUrl: SHARED, vaultToken: 'shared-tok-1' });
  const engine = createDbSyncEngine(a.cfg); // exactly the construction an existing app does
  await engine.sync();
  assert.deepEqual(a.errors.filter(e => e.code), []);
  assert.equal(a.local.get('note-1')?.text, 'hello from shared A');
  PASS('upgraded install synced with its existing device token, zero user action');

  const generated = localStorage.getItem('s2-old-device-id');
  assert.ok(generated && engine.deviceId === generated);
  const cursor = await engine.updateDeviceCursor();
  assert.equal(cursor.updated, true);
  PASS(`latent no-op fixed: a deviceId was generated (${generated.slice(0, 8)}…) and the device cursor now updates ({updated:true} from the real server)`);

  const require2 = createRequire('/workspace/glance-vault/dist/index.js');
  const Database = require2('better-sqlite3');
  const db = new Database(process.env.SHARED_DB, { readonly: true });
  const dev = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(generated);
  db.close();
  assert.ok(dev, 'devices row should exist server-side');
  PASS('server-side devices row exists for the generated id (tombstone GC now has an accurate cursor)');
}

// ═══ 7. Server whose /healthz omits authMode: ordinary shared mode ══════════
section('7. pre-1.4a server (healthz has NO authMode field) treated as ordinary shared mode');
{
  const raw = await (await fetch(`${OLD}/healthz`)).json();
  assert.ok(!('authMode' in raw));
  const h = await fetchVaultHealth({ vaultUrl: OLD, fetchImpl: recordingFetch });
  assert.equal(h.authMode, 'shared');
  PASS(`raw /healthz body ${JSON.stringify(raw)} -> normalized authMode "shared"`);

  await freshKeys('old-dev');
  const a = makeDevice('old-dev', { vaultUrl: OLD });
  const { engine, authMode, enrolled } = await connectVaultSyncEngine({ ...a.cfg, vaultToken: 'shared-tok-old' });
  assert.equal(authMode, 'shared');
  assert.equal(enrolled, false);
  a.local.set('note-old', { id: 'note-old', text: 'against a pre-1.4a server', lastModified: Date.now() });
  engine.markDirty('note-old');
  await engine.sync();
  assert.deepEqual(a.errors.filter(e => e.code), []);
  PASS('connectVaultSyncEngine against the pre-1.4a build syncs normally on the shared token (version skew is an ordinary case)');
}

// ═══ 8. Rejected credential: loop stops, NO re-enrollment, no new rows ══════
section('8. rejected credential: halt, no automatic re-enrollment, no credential row minted');
{
  const require2 = createRequire('/workspace/glance-vault/dist/index.js');
  const Database = require2('better-sqlite3');
  const countCreds = () => {
    const db = new Database(process.env.PERACC_DB, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM device_credentials').get().n;
    db.close();
    return n;
  };
  const rowsBefore = countCreds();

  // Simulate a revoked/dead credential (revocation itself is server Phase 2.1):
  // tamper the stored value so the server no longer recognizes it.
  const tampered = { ...credA, credential: 'gvc_' + 'de'.repeat(32) };
  localStorage.setItem('p1-devA-vault-credential', JSON.stringify(tampered));

  await freshKeys('p1-devA');
  const a = makeDevice('p1-devA', { vaultUrl: PERACC });
  // NOTE: a secret is supplied — and must be ignored, because a credential is stored.
  const { engine, enrolled } = await connectVaultSyncEngine({ ...a.cfg, enrollmentSecret: SECRET });
  assert.equal(enrolled, false);

  const wireBeforeFail = wire.length;
  await engine.sync();
  const surfaced = a.errors.pop();
  assert.equal(surfaced.code, 'CREDENTIAL_INVALID');
  assert.equal(surfaced.isHardStop, true);
  assert.equal(engine.isCredentialHalted(), true);
  PASS(`first cycle with the dead credential: onError('CREDENTIAL_INVALID', isHardStop true), engine halted (halt record at ${engine.getCredentialHalt().at})`);

  const wireAfterFail = wire.length;
  await engine.sync();
  await engine.sync();
  await engine.sync();
  assert.equal(wire.length, wireAfterFail);
  PASS('three further sync attempts produced ZERO network requests — the retry loop is stopped');

  const relaunched = createDbSyncEngine(makeDevice('p1-devA', { vaultUrl: PERACC, vaultToken: tampered.credential }).cfg);
  assert.equal(relaunched.isCredentialHalted(), true);
  const w = wire.length;
  await relaunched.sync();
  assert.equal(wire.length, w);
  PASS('the halt survives engine recreation (persisted): a relaunched engine makes no requests either');

  const enrolls = wire.slice(wireBeforeFail).filter(x => x.url.includes('/enroll'));
  assert.deepEqual(enrolls, []);
  assert.equal(countCreds(), rowsBefore);
  PASS(`no /enroll request was ever sent after the failure, and the server's device_credentials row count is unchanged (${rowsBefore} before, ${countCreds()} after repeated auth failures)`);
}

console.log(`\n=== Result: all ${passCount} checks passed (8/8 items) ===`);
