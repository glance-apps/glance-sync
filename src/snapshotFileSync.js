/**
 * @glance-apps/sync 2.1.0: the snapshot-file sync cycle, moved here from
 * dayGLANCE's src/sync/snapshotFileSync.js so every GLANCE app's iCloud and
 * Direct Access tiers run one cycle (dayGLANCE's docs/direct-access-sync.md).
 *
 * A snapshot-file transport is a local file that something else ferries
 * between devices: an iCloud ubiquity container, a Nextcloud / Google Drive /
 * Dropbox / Syncthing folder. There is no server and no ETag, so the cycle
 * is: read the whole file, merge it with local state by the same three-way
 * merge the WebDAV tier uses, apply what changed locally, and write the
 * merged result back. Pure: the transport, the merge, the apply, the crypto
 * and the app's storage keys all come in through the arguments. Every guard
 * has a test that fails when it is removed:
 *
 *   • an ABSENT file is seeded from local data, but only once the seed guard
 *     (evaluateMissingSnapshot) says absence is not a transient eviction, and
 *     only when the payload is not an empty copy of a populated store;
 *   • a 'downloading' placeholder and an unparseable file skip the cycle;
 *   • an 'error' object is surfaced, never merged;
 *   • an encrypted envelope is decrypted when the key is cached; when it cannot
 *     be, the transport decides whether local data may be written over it as
 *     plaintext (iCloud: yes, it is a legacy cleanup inside Apple's container;
 *     Direct Access: never, the folder is someone else's cloud);
 *   • a real snapshot stamps the transport's own last-synced key BEFORE the
 *     first-run prompt, because reading it is what proves the transport works;
 *   • a fresh device facing a populated snapshot is asked, not restored;
 *   • writes are throttled per transport so a daemon's round-trip is not raced;
 *   • health-store counts are stripped from every copy written out, on the
 *     transports that ask for it (`io.outgoing`): dayGLANCE's iCloud file does,
 *     for Apple's guideline 5.1.3; Direct Access is someone else's folder and
 *     carries them, exactly as GLANCEvault and WebDAV do;
 *   • a write happens only when what would be written differs from the file,
 *     and an apply only when the merged data differs from local state. The
 *     merge's own flags are necessary, not sufficient: with the strip above
 *     they fired on every cycle of every Mac holding health counts, and the
 *     resulting identical rewrites starved every phone (2026-10-05);
 *   • a change made on this device is written at once; a change that reached
 *     this device by another road is only relayed once the file has sat
 *     unchanged, still lacking it, for RELAY_CONFIRM_MS. A change reaches a
 *     device by two roads at different speeds, GLANCEvault in seconds and the
 *     folder's syncing tool in tens of seconds, so the second Mac learned of
 *     an iPhone's edit from the vault, found its folder copy stale, wrote the
 *     same data with a fresh stamp, and Nextcloud reported a conflict on
 *     every change (2026-10-08). Deferring every write by one poll did not
 *     help: it held the originating device's write back too, which only
 *     lengthened the window in which the others relayed it. "Made here" is
 *     the device's own last-edit stamp (`io.lastLocalEditAt`, set by the persist
 *     pass for an edit and not for an apply) being newer than this device's
 *     last write to, or before that last read of, this file.
 *
 * Nothing here touches React. An app's hook owns the poll, the mutex and the
 * prompt state (dayGLANCE: hooks/useSnapshotFileSync.js); the app owns i18n
 * and status UI.
 */

import { sliceDiffs, writeWorthy } from './snapshotMergeExplain.js';

// ─── The seed guard ────────────────────────────────────────────────────────────

/**
 * How long an absent snapshot is assumed to be a temporary eviction. iCloud
 * and the folder tools restore an evicted file within seconds; ten minutes is
 * far past that while still being a delay a user would sit through.
 */
export const MISSING_GRACE_MS = 10 * 60 * 1000;

/**
 * Whether an absent file may be seeded, or is an eviction to wait out.
 *
 * @param {object} s
 * @param {boolean} s.hasSyncedBefore  this device has previously read a real snapshot
 * @param {number}  s.missingSince     epoch ms of the first consecutive sighting of
 *                                     the file as absent, or 0 if it was present last cycle
 * @param {number}  s.now              epoch ms
 * @param {number} [s.graceMs]
 * @returns {{skip: boolean, missingSince: number}}
 *   skip         — true to leave the file alone this cycle
 *   missingSince — the value to carry into the next cycle (0 clears the streak)
 */
export function evaluateMissingSnapshot({ hasSyncedBefore, missingSince, now, graceMs = MISSING_GRACE_MS } = {}) {
  // Never synced: nothing can have been evicted, so this is a real first run
  // and seeding is the correct, necessary behaviour.
  if (!hasSyncedBefore) return { skip: false, missingSince: 0 };
  // First cycle seeing it absent: start the clock and wait.
  if (!missingSince) return { skip: true, missingSince: now };
  // Still inside the window: keep waiting, preserving the original sighting so
  // the window measures the whole streak rather than restarting every cycle.
  if (now - missingSince < graceMs) return { skip: true, missingSince };
  // Gone long enough that eviction no longer explains it. Seed, and clear the
  // streak so the next absence starts its own window.
  return { skip: false, missingSince: 0 };
}

// ─── The first-run prompt ──────────────────────────────────────────────────────

/**
 * A fresh install facing populated remote data is asked whether to restore
 * rather than restored silently: only when no decision was recorded, the
 * remote copy has data, this device has none, and the transport is reachable.
 */
export function shouldPromptFirstRun({ decided, remoteHasData, localHasData, available = true } = {}) {
  return !!(!decided && remoteHasData && !localHasData && available);
}

/** The default `io.hasData`: any non-empty array in the data. Apps that know their content slices pass their own. */
export function payloadHasData(data) {
  if (!data || typeof data !== 'object') return false;
  return Object.values(data).some((v) => Array.isArray(v) && v.length > 0);
}

// The two stamps an app keeps around the cycle are the app's own storage keys,
// handed in through `io`: `io.localModifiedKey` (stamped on every apply, so the
// app's other engines see the device changed) and `io.lastLocalEditAt` (when
// this device itself last changed its data, set by the app's persist pass for
// an edit made here and not for an apply from a transport).

/**
 * How long a change that reached this device by another road must stay
 * missing from an unchanged file before this device relays it. Longer than
 * the folder's syncing tool takes to deliver the originating device's own
 * write (Nextcloud's desktop client polls every 30 s without push), so the
 * relay only happens when nobody else carried it.
 */
export const RELAY_CONFIRM_MS = 90 * 1000;

/**
 * How long a settled cycle may stand in for a full one (the idle gate in
 * runSnapshotFileCycle). The gate already requires the same file text and the
 * same local data; this bounds how long a mistake in that judgement could last.
 */
export const SETTLED_RECHECK_MS = 10 * 60 * 1000;

/**
 * The relay rule, shared with the event-set cycle (intents/folderIntents.js):
 * a change this device did not make goes out only once the same difference
 * (`fingerprint`, against the file version it was seen on) has been seen
 * again RELAY_CONFIRM_MS later. Returns whether to write now and the pending
 * look to carry: a different fingerprint starts over, the same one is kept.
 *
 * @param {{fingerprint: string, at: number}|null} pending
 * @param {string} fingerprint
 * @param {number} now
 * @returns {{write: boolean, pending: {fingerprint: string, at: number}}}
 */
export function relayDecision(pending, fingerprint, now, waitMs = RELAY_CONFIRM_MS) {
  if (pending && pending.fingerprint === fingerprint && now - pending.at >= waitMs) {
    return { write: true, pending };
  }
  return { write: false, pending: (!pending || pending.fingerprint !== fingerprint) ? { fingerprint, at: now } : pending };
}

/**
 * Relays are staggered across devices, a minute per rank. A change that
 * arrives by another road (the vault's push nudge, an edit from a phone whose
 * folder tool round-trips slowly) reaches every device on the folder within
 * the same second, so with one relay clock they all wrote the same file
 * together, 90 s later, and the folder kept a conflict copy per pair (two
 * Macs, 2026-10-10). Each writer stamps its device id in the file header;
 * each device ranks itself among the writers it has seen there, and waits an
 * extra RELAY_STAGGER_MS per rank. The first-ranked device writes at 90 s;
 * the next sees the file catch up before its own clock runs out and drops
 * the relay. A device that has not seen the others yet ranks first, collides
 * at most once, then learns them from the file.
 */
export const RELAY_STAGGER_MS = 60 * 1000;
const WRITERS_LIMIT = 32;

/** The writers seen in a transport's file, under `${transport.lastSyncedKey}:writers`. */
export function readWriters(storage, key) {
  try {
    const v = JSON.parse(storage?.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((w) => typeof w === 'string') : [];
  } catch { return []; }
}

/** Records a writer id read from the file. Returns true when it was new. */
export function noteWriter(storage, key, writer) {
  if (typeof writer !== 'string' || !writer) return false;
  const seen = readWriters(storage, key);
  if (seen.includes(writer)) return false;
  seen.push(writer);
  try { storage?.setItem(key, JSON.stringify(seen.slice(-WRITERS_LIMIT))); } catch { /* ignore */ }
  return true;
}

/** This device's relay wait: RELAY_CONFIRM_MS plus a minute per rank among the writers seen (its own id included). */
export function relayWaitMs(storage, key, self) {
  if (typeof self !== 'string' || !self) return RELAY_CONFIRM_MS;
  const ids = [...new Set([...readWriters(storage, key), self])].sort();
  return RELAY_CONFIRM_MS + ids.indexOf(self) * RELAY_STAGGER_MS;
}

/**
 * Classifies the raw text a transport read.
 *
 * @param {string|null|undefined} str
 * @returns {{kind: 'absent'}
 *        | {kind: 'unparseable'}
 *        | {kind: 'downloading'}
 *        | {kind: 'error', error: string}
 *        | {kind: 'snapshot', remote: object}}
 */
export function classifySnapshotText(str) {
  if (!str || str === 'null') return { kind: 'absent' };
  let remote;
  try { remote = JSON.parse(str); } catch { return { kind: 'unparseable' }; }
  if (remote?.downloading) return { kind: 'downloading' };
  if (remote?.error) return { kind: 'error', error: String(remote.error) };
  return { kind: 'snapshot', remote };
}

/**
 * Runs one cycle. Never throws for a transport outcome; a thrown error from
 * `io` (a bug) propagates so the caller's `finally` still releases its lock.
 *
 * @param {object} args
 * @param {object} args.transport
 * @param {string}   args.transport.id                     for log lines
 * @param {() => Promise<string|null>} args.transport.read
 * @param {(text: string) => Promise<boolean>} args.transport.write
 * @param {string}   args.transport.lastSyncedKey          storage key this transport stamps
 * @param {() => boolean} args.transport.firstRunDecided   has the user answered the restore prompt
 * @param {number}   args.transport.writeThrottleMs
 * @param {boolean}  args.transport.allowsPlaintextReseed  may an undecryptable envelope be overwritten
 * @param {() => boolean} [args.transport.encryptsWrites]  the per-device switch: seed and upgrade as an envelope
 * @param {object} args.io
 * @param {() => object} args.io.buildSyncPayload          `{ version, lastModified?, data }`
 * @param {(data: object, opts: {allowEmpty: boolean}) => void} args.io.applyEngineData
 * @param {(local: object, remote: object, retentionDays: number) => {data: object, localChanged: boolean, remoteChanged: boolean, deviceLocalKeys?: string[]}} args.io.mergeSyncData
 * @param {(payload: object) => object} [args.io.outgoing]  what the transport actually writes, from the plaintext payload (a strip of slices the file must not carry); identity by default
 * @param {number}   args.io.syncRetentionDays
 * @param {(envelope: object) => boolean} args.io.isEncryptedEnvelope
 * @param {(envelope: object) => Promise<object>} args.io.decryptData
 * @param {(payload: object) => Promise<object>} [args.io.encryptData]  plaintext payload → envelope
 * @param {() => boolean} [args.io.encryptionReady]  can encryptData succeed now (a key or the passphrase is in memory)
 * @param {Storage}  args.io.storage                        localStorage-like
 * @param {() => string|null} [args.io.lastLocalEditAt]      when this device itself last changed its data (absent: never, every change is relayed)
 * @param {string} [args.io.localModifiedKey]                 stamped with the time of every apply, for the app's other engines
 * @param {() => number} [args.io.localItemCount]             how many items the app's own storage holds (the empty-state guard: a payload of nothing over a store of something is not seeded)
 * @param {(data: object) => boolean} [args.io.hasData]       does a payload carry anything worth restoring (default payloadHasData)
 * @param {string|(() => string)} [args.io.deviceId]          stamped as `writtenBy` in the file header; ranks this device's relay (relayWaitMs)
 * @param {() => number} [args.io.now]
 * @param {Console}  [args.io.log]
 * @param {{missingSince: number, lastWriteAt: number, lastWrittenAt?: number, pendingWrite?: {fingerprint: string, at: number}|null, settled?: object|null}} args.state  carried between cycles
 * @returns {Promise<{state: {missingSince: number, lastWriteAt: number, lastWrittenAt: number, pendingWrite: object|null, settled: object|null}, outcome: object}>}
 *   outcome.kind is one of:
 *     'skipped'   (reason: 'missing-grace' | 'empty-state-guard' | 'downloading' |
 *                  'unparseable' | 'no-data' | 'encrypted-unreadable' | 'key-needed' |
 *                  'unchanged')
 *                 unchanged: the idle gate; the file and local data are as a
 *                 settled cycle left them
 *                 encrypted-unreadable carries needsKey: true when no key and no
 *                 passphrase are in memory (the prompt collects one), false when
 *                 the key in memory is the wrong one
 *     'seeded'    the absent file was written from local data (wrote: boolean)
 *     'reseeded'  an undecryptable envelope was replaced with local plaintext
 *     'error'     (reason: 'unavailable', error) the transport reported an error
 *     'prompted'  (info) a first-run restore choice is needed; nothing was written
 *     'merged'    (localChanged, remoteChanged, applied, wrote, deferred, ownEdits, keyNeeded)
 *                 deferred: a relay is wanted and waits for the file to catch up
 *                 ownEdits: this device has a change of its own not yet written
 *                 keyNeeded: a write is wanted as an envelope and no key is ready
 *
 * Encryption (docs/direct-access-sync.md, Phase 6): the file decides, the
 * switch decides the first write. A file read as an envelope is written back
 * as an envelope whatever the switch says (never downgrade someone else's
 * cloud folder); a plaintext or absent file is written as an envelope when
 * `transport.encryptsWrites()` is on. Every guard, the content gate and the
 * made-here rule look at plaintext, before the envelope. A wanted envelope
 * with no key ready is held, never written plaintext.
 */
export async function runSnapshotFileCycle({ transport, io, state }) {
  const log = io.log ?? console;
  const now = io.now ?? Date.now;
  const next = {
    missingSince: state?.missingSince ?? 0,
    lastWriteAt: state?.lastWriteAt ?? 0,
    // The last SUCCESSFUL write to this file (lastWriteAt counts attempts, for
    // the throttle), or before any, the read before this cycle: the baseline
    // an edit made here has to be newer than to count as not yet written.
    lastWrittenAt: state?.lastWrittenAt ?? 0,
    pendingWrite: state?.pendingWrite ?? null,
    // The idle gate (krelltunez/dayGLANCE#2142): after a merged cycle that had
    // nothing to apply and nothing to write, the file's text and this device's
    // data as they stood. See SETTLED_RECHECK_MS.
    settled: state?.settled ?? null,
  };
  const lastLocalEdit = (() => {
    try {
      const v = io.lastLocalEditAt ? io.lastLocalEditAt() : null;
      const t = v ? new Date(v).getTime() : NaN;
      return Number.isFinite(t) ? t : 0;
    } catch { return 0; }
  })();
  const deviceId = (() => {
    try { const v = typeof io.deviceId === 'function' ? io.deviceId() : io.deviceId; return typeof v === 'string' && v ? v : null; }
    catch { return null; }
  })();
  const writersKey = `${transport.lastSyncedKey}:writers`;
  // The header every write carries: who wrote it (relayWaitMs).
  const header = () => (deviceId ? { writtenBy: deviceId } : {});

  // Writing faster than the daemon's round-trip piles conflict versions onto
  // the remote; skip writes inside the window. The next poll re-runs the merge
  // and writes any genuinely deferred change. The stamp is taken before the
  // write so a failing write is throttled like a succeeding one.
  const throttledWrite = async (text) => {
    if (now() - next.lastWriteAt < transport.writeThrottleMs) return false;
    next.lastWriteAt = now();
    const ok = await transport.write(text);
    if (!ok) log.error(`[${transport.id}] snapshot write failed`);
    return ok;
  };
  // What the transport actually writes, from the plaintext payload: an app
  // may strip slices a file must not carry (dayGLANCE's iCloud file leaves out
  // HealthKit-derived counts for Apple's guideline 5.1.3). The strip reads
  // plaintext, before any envelope, and never touches what is applied locally.
  const strip = typeof io.outgoing === 'function' ? (payload) => io.outgoing(payload) ?? payload : (payload) => payload;

  const text = await transport.read();

  // The idle gate. A poll that reads the very text a settled cycle read, while
  // this device's data is still what it was then and no relay is waiting, has
  // nothing to merge: stop before parsing, decrypting and comparing the file.
  // The read still counts as a read (lastSyncedKey). Re-checked in full every
  // SETTLED_RECHECK_MS, as a safety net.
  let gateLocal = null;
  if (next.settled && typeof text === 'string' && text === next.settled.text && !next.pendingWrite
      && now() - next.settled.at < SETTLED_RECHECK_MS) {
    gateLocal = io.buildSyncPayload();
    if (JSON.stringify(gateLocal.data) === next.settled.fingerprint) {
      io.storage.setItem(transport.lastSyncedKey, new Date(now()).toISOString());
      next.missingSince = 0;
      return { state: next, outcome: { kind: 'skipped', reason: 'unchanged' } };
    }
  }
  next.settled = null;

  const read = classifySnapshotText(text);

  // The file decides; the switch decides the first write.
  const envelopeRead = read.kind === 'snapshot' && !!io.isEncryptedEnvelope(read.remote);
  const envelopeOut = envelopeRead || !!transport.encryptsWrites?.();
  const canEncrypt = typeof io.encryptData === 'function' && (io.encryptionReady ? !!io.encryptionReady() : true);
  const keyNeeded = envelopeOut && !canEncrypt;
  // Serialised after the health strip (the strip reads plaintext).
  const encode = async (payload) => JSON.stringify(envelopeOut ? await io.encryptData(payload) : payload);
  const outgoing = (payload) => encode(strip(payload));

  if (read.kind === 'absent') {
    // No remote file yet — seed it with local data, but only if the absence is
    // real (not a transient eviction) and state is hydrated: if React state is
    // empty while localStorage has tasks, seeding would wipe the remote copy.
    const missing = evaluateMissingSnapshot({
      hasSyncedBefore: !!io.storage.getItem(transport.lastSyncedKey),
      missingSince: next.missingSince,
      now: now(),
    });
    next.missingSince = missing.missingSince;
    if (missing.skip) return { state: next, outcome: { kind: 'skipped', reason: 'missing-grace' } };
    const localCount = typeof io.localItemCount === 'function' ? (io.localItemCount() || 0) : 0;
    const payload = io.buildSyncPayload();
    const hasData = io.hasData ?? payloadHasData;
    if (localCount > 0 && !hasData(payload.data)) {
      return { state: next, outcome: { kind: 'skipped', reason: 'empty-state-guard' } };
    }
    if (keyNeeded) return { state: next, outcome: { kind: 'skipped', reason: 'key-needed' } };
    const wrote = await throttledWrite(await outgoing({ ...payload, ...header() }));
    return { state: next, outcome: { kind: 'seeded', wrote } };
  }

  // Exists but is still coming down from the cloud, or is mid-write by the
  // daemon: let the next poll retry.
  if (read.kind === 'downloading') return { state: next, outcome: { kind: 'skipped', reason: 'downloading' } };
  if (read.kind === 'unparseable') return { state: next, outcome: { kind: 'skipped', reason: 'unparseable' } };
  if (read.kind === 'error') {
    return { state: next, outcome: { kind: 'error', reason: 'unavailable', error: read.error } };
  }

  let remote = read.remote;
  if (envelopeRead) {
    let needsKey = false;
    try { remote = await io.decryptData(remote); }
    catch (decErr) {
      log.warn(`[${transport.id}] encrypted snapshot could not be decrypted:`, decErr?.message ?? decErr);
      needsKey = decErr?.code === 'PASSPHRASE_REQUIRED';
      remote = null;
    }
    if (!remote?.data) {
      if (!transport.allowsPlaintextReseed) {
        // Someone else's cloud folder: never downgrade a file we cannot read.
        // Nothing is applied and nothing is written; with no key in memory
        // at all the caller prompts for the passphrase.
        return { state: next, outcome: { kind: 'skipped', reason: 'encrypted-unreadable', needsKey } };
      }
      // iCloud's legacy-envelope cleanup: the file could not be followed, so
      // this is the one write that is plaintext by design.
      const wrote = await throttledWrite(JSON.stringify(strip(io.buildSyncPayload())));
      return { state: next, outcome: { kind: 'reseeded', wrote } };
    }
  }
  if (!remote?.data) return { state: next, outcome: { kind: 'skipped', reason: 'no-data' } };

  // A real snapshot came back, so the transport demonstrably works from this
  // device. Record that — it is what a later absence is measured against — and
  // record it BEFORE the first-run prompt: reading the snapshot is what proves
  // the transport works, whatever the user then chooses to do with it.
  const previousRead = (() => {
    try { const v = io.storage.getItem(transport.lastSyncedKey); const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : 0; }
    catch { return 0; }
  })();
  io.storage.setItem(transport.lastSyncedKey, new Date(now()).toISOString());
  next.missingSince = 0;
  if (!next.lastWrittenAt) next.lastWrittenAt = previousRead;
  if (remote.writtenBy !== deviceId) noteWriter(io.storage, writersKey, remote.writtenBy);

  // First launch on a device with no data of its own, facing a populated
  // remote copy. Ask instead of restoring silently (shouldPromptFirstRun).
  const localData = (gateLocal ?? io.buildSyncPayload()).data;
  const hasData = io.hasData ?? payloadHasData;
  if (shouldPromptFirstRun({
    decided: transport.firstRunDecided(),
    remoteHasData: hasData(remote.data),
    localHasData: hasData(localData),
    available: true,
  })) {
    return {
      state: next,
      outcome: {
        kind: 'prompted',
        info: {
          // The app names its own slices; these two are dayGLANCE's and stay
          // for its prompt. An app with other slices reads `data` itself.
          taskCount: remote.data.tasks?.length ?? 0,
          inboxCount: remote.data.unscheduledTasks?.length ?? 0,
          lastModified: remote.lastModified ?? null,
          data: remote.data,
        },
      },
    };
  }

  const { data: mergedData, localChanged, remoteChanged, deviceLocalKeys = [] } =
    io.mergeSyncData(localData, remote.data, io.syncRetentionDays);

  // The merge's flags say whether it picked anything from either side. They do
  // NOT say whether the file or the device would actually change, and the two
  // questions differ: the iCloud write strips HealthKit-derived habit counts
  // (the app's strip), so a device that holds those counts (any Mac
  // receiving them through GLANCEvault) sees them "missing" from the file on
  // every cycle, and the flag alone rewrote an identical stripped file every
  // 15 s on every Mac in a fleet — which kept every phone's copy non-current
  // and its edits stuck for minutes (2026-10-05). So a write needs a flag AND
  // a real difference between what would be written and the file; an apply
  // needs the flag AND a real difference between the merged data and local
  // state. snapshotMergeExplain.js is that comparison, and an app's
  // diagnostics panel can run the identical function. An order-only difference
  // does not count for the write: the merge keeps each device's own order,
  // so writing it changes nothing on the other device (writeWorthy).
  const outPayload = strip({
    version: 2,
    lastModified: new Date(now()).toISOString(),
    ...header(),
    data: mergedData,
  });
  const applyNeeded = localChanged && sliceDiffs(mergedData, localData, { ignoreDropped: true }).length > 0;
  // Device-local keys (the merge names them) are left out of the file
  // question: every device keeps its own value, so the file's is nobody's.
  const writable = (remoteChanged || localChanged)
    ? writeWorthy(sliceDiffs(outPayload.data, remote.data, { ignoreKeys: deviceLocalKeys }))
    : [];
  const writeNeeded = writable.length > 0;

  if (applyNeeded) {
    // Apply the FULL merged data locally (health-sourced counts stay on-device).
    io.applyEngineData(mergedData, { allowEmpty: !!remote.lastModified });
    if (io.localModifiedKey) io.storage.setItem(io.localModifiedKey, new Date(now()).toISOString());
  }

  // Made here, or relayed (header). A change of this device's own goes out
  // now. Anything else is relayed only after the file has sat unchanged,
  // still lacking it, for RELAY_CONFIRM_MS: what was seen (the differences a
  // write would resolve, against the file version they were seen on) has to
  // be seen again that much later. A different file version starts over,
  // since the slower road may just have delivered it.
  const ownEdits = lastLocalEdit > next.lastWrittenAt;
  let wrote = false;
  let deferred = false;
  if (writeNeeded && keyNeeded) {
    // An envelope is wanted and nothing can seal it: hold the write where it
    // is (the relay clock, if any, keeps running) and say so.
  } else if (writeNeeded && ownEdits) {
    wrote = await throttledWrite(await encode(outPayload));
    if (wrote) next.lastWrittenAt = now();
    next.pendingWrite = null;
  } else if (writeNeeded) {
    const fingerprint = `${remote.lastModified ?? ''}\u0000${writable.map((d) => d.summary).join('\n')}`;
    const decision = relayDecision(next.pendingWrite, fingerprint, now(), relayWaitMs(io.storage, writersKey, deviceId));
    next.pendingWrite = decision.pending;
    if (decision.write) {
      wrote = await throttledWrite(await encode(outPayload));
      if (wrote) next.lastWrittenAt = now();
    } else {
      deferred = true;
    }
  } else {
    next.pendingWrite = null;
  }
  // Nothing applied and nothing wanted on the file: the next poll may stop at
  // the read if neither side moves. (A cycle that applied or wrote changed one
  // side, and the next full cycle settles it.)
  if (!applyNeeded && !writeNeeded && typeof text === 'string') {
    next.settled = { text, fingerprint: JSON.stringify(localData), at: now() };
  }
  return {
    state: next,
    outcome: { kind: 'merged', localChanged, remoteChanged, applied: applyNeeded, wrote, deferred, ownEdits, keyNeeded: writeNeeded && keyNeeded },
  };
}
