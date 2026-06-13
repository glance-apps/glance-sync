# Phase 3: Database sync transport

This document covers the database (GLANCEvault) sync transport added in Phase 3,
the key design decisions, deviations from the original spec, the coordinated
GLANCEvault change, and what the Phase 4 cutover in the app repos will need to
do. The file-tier transport is unchanged: file-tier users run the exact same
code path as before.

## What shipped in glance-sync

New, fully additive modules (nothing in the file tier was modified):

- `src/dbCrypto.js`: per-entity encryption. A single root key is derived once
  from the passphrase with PBKDF2 (SHA-256, 310,000 iterations) and a per-account
  salt. Per-entity AES-256-GCM keys are HKDF-derived from the root key using the
  entityId as the HKDF info context. Each entity is encrypted with a fresh
  12-byte IV; the stored ciphertext is `base64(IV || AES-GCM output)`.
- `src/vaultClient.js`: a thin HTTP client for the GLANCEvault sync, salt, and
  device endpoints. Bearer-authenticated, with an injectable fetch.
- `src/dbEngine.js`: the row-grained sync engine. Dirty tracking, seq-based
  incremental pull with entity-grain last-writer-wins, and a best-effort device
  cursor update.
- `createSyncEngine({ transportMode: 'database', ... })` delegates to the DB
  engine. The default (`'file'` or unset) is untouched.
- `markDirty(entityId)` is exposed as a method on the DB engine instance.

Public exports added to `src/index.js`: `createDbSyncEngine`, `createVaultClient`,
`setupDbRootKey`, `initDbRootKey`, `clearDbRootKey`, `hasDbRootKey`,
`encryptEntity`, `decryptEntity`.

## The sync cycle

`dbSyncCycle()` runs on the same schedule the file tier uses for `download()`:

1. PUSH dirty rows. Each dirty entityId is encrypted into
   `{ entityId, ciphertext, createdAt }` and upserted via
   `POST /sync/:app/batch`. The dirty set is cleared and the high water mark is
   advanced to `maxSeq` only on full server acknowledgment. On any failure the
   dirty set is kept and re-sent idempotently next cycle (rows are keyed by
   entityId server-side, so re-sending produces no duplicates).
2. PULL remote changes from `GET /sync/:app/list?since=<hwm>`, paginating on
   `hasMore`. For each row: deletes apply a local delete; new entities are
   applied; insert-only types are applied as an idempotent union; everything
   else is resolved by entity-grain LWW on `lastModified`. The high water mark
   advances to the max seq seen.
3. UPDATE the device cursor via `POST /sync/:app/device` (best-effort).

Contended path: if a row in the pull is also locally dirty, LWW runs against the
dirty local copy. Remote wins only when its `lastModified` is strictly newer, and
when it does the entity is dropped from the dirty set so a superseded local
version is never re-pushed. Local changes are never discarded without comparing
`lastModified`.

## Key design decisions

- **Per-entity HKDF, single PBKDF2.** Re-running PBKDF2 per entity would be far
  too slow. The root key pays the PBKDF2 cost once; per-row keys are cheap HKDF
  derivations. This mirrors the per-envelope pattern in `@glance-apps/intents`.
- **entityId as HKDF context.** Binding the per-entity key to the entityId means
  a ciphertext only decrypts under its own id, which also prevents row-swapping.
- **`markDirty` is app-driven, not merge-derived.** The DB transport has no full
  array to diff, so dirtiness cannot be inferred. The app calls `markDirty` on
  every local write (and at creation time for insert-only types).
- **Injectable vault client and fetch.** `config.vaultClient` (or `fetchImpl`)
  lets tests use synthetic transports and native shells route through their own
  network bridge, without coupling the engine to global fetch.
- **Local deletes are handled.** A dirty entityId whose local entity is gone is
  pushed as a soft-delete via `DELETE /sync/:app/:entityId`, then the dirty set
  clears with the rest of the batch. This is an extension beyond the spec's
  push-only-upserts description, kept idempotent.

## Deviations from the spec

- **Local sync state lives in `localStorage`, not IndexedDB.** The spec suggested
  IndexedDB. The file engine already persists all of its sync metadata in
  `localStorage` keyed by `storageKeyPrefix`, and `markDirty` benefits from a
  synchronous store it can call inside the app's write path. We followed the
  existing pattern for consistency and simplicity. The keys are
  `<prefix>-db-sync-hwm`, `<prefix>-db-sync-dirty`, `<prefix>-db-sync-config`,
  and `<prefix>-db-sync-last-synced`. If a future need arises (very large dirty
  sets), this is a localized swap behind the same accessors.
- **`glance-intents` was not read directly** (no repo access in this session).
  The per-entity crypto was implemented from the Phase 3 spec's description of
  `buildEncryptedEnvelope` (HKDF-from-root-key keyed by entityId, AES-GCM with a
  fresh IV). The on-the-wire row format matches the spec exactly.
- **The GLANCEvault device endpoint is provided as a snippet below** rather than
  committed, because this session's repository scope is limited to
  `glance-apps/glance-sync`. It needs to be applied to `glance-vault` as the
  coordinated commit.

## Coordinated GLANCEvault change: `POST /sync/:app/device`

Add an endpoint that updates `devices.last_seen_seq`. Body
`{ accountId, deviceId, lastSeenSeq }`, response `200 { updated: true }`. This is
best-effort from the client; a failure only affects tombstone GC timing, not
sync correctness. Example Express/SQLite handler in the existing vault style:

```ts
// router: app.use('/sync/:app', syncRouter)
// Upserts the device row and bumps last_seen_seq monotonically.
syncRouter.post('/device', requireAuth, (req, res) => {
  const { app } = req.params;
  const { accountId, deviceId, lastSeenSeq } = req.body ?? {};
  if (!accountId || !deviceId || typeof lastSeenSeq !== 'number') {
    return res.status(400).json({ error: 'accountId, deviceId, lastSeenSeq required' });
  }

  db.prepare(`
    INSERT INTO devices (app, account_id, device_id, last_seen_seq, updated_at)
    VALUES (@app, @accountId, @deviceId, @lastSeenSeq, @now)
    ON CONFLICT(app, account_id, device_id) DO UPDATE SET
      last_seen_seq = MAX(devices.last_seen_seq, excluded.last_seen_seq),
      updated_at    = excluded.updated_at
  `).run({ app, accountId, deviceId, lastSeenSeq, now: Date.now() });

  return res.status(200).json({ updated: true });
});
```

If the `devices` table does not already carry these columns, add a migration:

```sql
CREATE TABLE IF NOT EXISTS devices (
  app           TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  device_id     TEXT    NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, account_id, device_id)
);
```

## Phase 4 cutover (lastGLANCE app repo)

To flip lastGLANCE onto the DB transport:

1. **Set the transport flag.** Where the app builds its sync config today, add
   `transportMode: 'database'` plus `vaultUrl`, `vaultToken`, `accountId`, and a
   stable `deviceId`. Keep the existing WebDAV config so file-tier fallback stays
   available. The same passphrase mechanism is reused: call `setSyncPassphrase`
   once as today; the DB engine fetches or registers the salt automatically on
   first use.
2. **Wire the data callbacks.** Provide `getLocalEntity(entityId)`,
   `applyRemoteEntity(entityId, entity)`, and `applyRemoteDelete(entityId)`
   against the app's local store. Provide `isInsertOnly(entity, entityId)` so
   CompletionEvents (and any other insert-only type) union without conflict, and
   `getEntityLastModified(entity)` if entities do not use a top-level
   `lastModified` field.
3. **Call `markDirty` on every local write.** Anywhere the app mutates an entity,
   call `engine.markDirty(entityId)`. For insert-only types (CompletionEvents,
   instance completions, habit logs), call `markDirty` with the freshly generated
   UUID at creation time. This is the single most important integration step: the
   dirty set is the only signal the DB engine has.
4. **Schedule the cycle.** Call `engine.dbSyncCycle()` (aliased as
   `engine.sync()`) on the same debounce/poll/visibility schedule the app uses
   for the file engine's `download()` today.
5. **Leave the file payload alone.** Nothing in Phase 3 reads, writes, or deletes
   the file-tier WebDAV payload, even for DB-transport users. It remains intact
   as a fallback.
