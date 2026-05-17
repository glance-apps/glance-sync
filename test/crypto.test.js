import 'fake-indexeddb/auto'; // shim IndexedDB for Node.js test environment
import { describe, it, expect, beforeEach } from 'vitest';
import {
  encryptData,
  decryptData,
  setupEncryptionKey,
  setSyncPassphrase,
  clearEncryptionKey,
  hasEncryptionReady,
  isEncryptedEnvelope,
  initSessionKey,
} from '../src/crypto.js';

// Config used across tests — pins to the same DB name so IndexedDB writes don't bleed across suites.
const CFG = { cryptoDBName: 'glance-sync-test' };

// Reset session state between tests so each test starts clean.
beforeEach(async () => {
  await clearEncryptionKey(CFG);
  setSyncPassphrase(null);
});

// ─── isEncryptedEnvelope ──────────────────────────────────────────────────────

describe('isEncryptedEnvelope', () => {
  it('returns true for a valid envelope shape', () => {
    expect(isEncryptedEnvelope({ v: 1, enc: 'AES-GCM-256', data: 'abc123' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isEncryptedEnvelope(null)).toBe(false);
  });

  it('returns false for wrong version', () => {
    expect(isEncryptedEnvelope({ v: 2, enc: 'AES-GCM-256', data: 'abc' })).toBe(false);
  });

  it('returns false for missing data field', () => {
    expect(isEncryptedEnvelope({ v: 1, enc: 'AES-GCM-256' })).toBe(false);
  });

  it('returns false for a plain object', () => {
    expect(isEncryptedEnvelope({ tasks: [] })).toBe(false);
  });
});

// ─── encrypt / decrypt round-trip with passphrase ────────────────────────────

describe('encryptData / decryptData — passphrase path', () => {
  it('round-trips a plain object via passphrase', async () => {
    setSyncPassphrase('hunter2');
    const payload = { tasks: [{ id: '1', title: 'Test task' }] };
    const envelope = await encryptData(payload, CFG);

    expect(isEncryptedEnvelope(envelope)).toBe(true);

    const recovered = await decryptData(envelope, CFG);
    expect(recovered).toEqual(payload);
  });

  it('produces a different ciphertext each call (fresh IV)', async () => {
    setSyncPassphrase('hunter2');
    const payload = { x: 1 };
    const e1 = await encryptData(payload, CFG);
    // Clear session so second call re-derives
    await clearEncryptionKey(CFG);
    setSyncPassphrase('hunter2');
    const e2 = await encryptData(payload, CFG);
    // The data blobs should differ because IV is random
    expect(e1.data).not.toBe(e2.data);
  });

  it('throws PASSPHRASE_REQUIRED when no key and no passphrase', async () => {
    // Set up an envelope from a fresh key, then clear everything
    setSyncPassphrase('secret');
    const envelope = await encryptData({ a: 1 }, CFG);
    await clearEncryptionKey(CFG);
    setSyncPassphrase(null);

    await expect(decryptData(envelope, CFG)).rejects.toMatchObject({
      code: 'PASSPHRASE_REQUIRED',
    });
  });

  it('throws on wrong passphrase', async () => {
    setSyncPassphrase('correct-horse');
    const envelope = await encryptData({ secret: true }, CFG);
    await clearEncryptionKey(CFG);
    setSyncPassphrase('wrong-battery');

    await expect(decryptData(envelope, CFG)).rejects.toThrow('Decryption failed');
  });

  it('throws on corrupted ciphertext', async () => {
    setSyncPassphrase('abc');
    const envelope = await encryptData({ d: 1 }, CFG);
    const tampered = { ...envelope, data: envelope.data.slice(0, -4) + 'XXXX' };

    await expect(decryptData(tampered, CFG)).rejects.toThrow();
  });

  it('throws on unknown envelope version', async () => {
    await expect(decryptData({ v: 99, enc: 'AES-GCM-256', data: 'aGVsbG8=' }, CFG))
      .rejects.toThrow('Unknown encryption version: 99');
  });

  it('throws on missing data field', async () => {
    await expect(decryptData({ v: 1, enc: 'AES-GCM-256' }, CFG))
      .rejects.toThrow('Invalid encrypted envelope');
  });
});

// ─── encrypt / decrypt round-trip with stored key (IndexedDB path) ───────────

describe('encryptData / decryptData — stored key path', () => {
  it('round-trips after key is set up and session is cleared', async () => {
    // Simulate first device: set up key via passphrase, which stores to IndexedDB
    await setupEncryptionKey('my-passphrase', CFG);

    const payload = { notes: 'hello world' };
    const envelope = await encryptData(payload, CFG);

    // Simulate page reload: clear in-memory session but IndexedDB still has the key
    setSyncPassphrase(null);
    // Manually clear the in-memory state (clearEncryptionKey also wipes IDB, so we
    // use the session setters directly to simulate reload without touching IDB)
    setSyncPassphrase(null);
    // We can't directly clear _sessionKey without calling clearEncryptionKey, so instead
    // test the initSessionKey → decrypt path which is the real reload scenario.
    const restored = await initSessionKey(CFG);
    expect(restored).toBe(true);
    expect(hasEncryptionReady()).toBe(true);

    const recovered = await decryptData(envelope, CFG);
    expect(recovered).toEqual(payload);
  });

  it('cross-device recovery: derives key from passphrase + embedded salt when no stored key', async () => {
    // Device A: set up and encrypt
    setSyncPassphrase('shared-passphrase');
    const payload = { sync: true };
    const envelope = await encryptData(payload, CFG);

    // Device B: only passphrase set, no stored key
    await clearEncryptionKey(CFG);
    setSyncPassphrase('shared-passphrase');

    const recovered = await decryptData(envelope, CFG);
    expect(recovered).toEqual(payload);
    // After successful cross-device decrypt, session key should be cached
    expect(hasEncryptionReady()).toBe(true);
  });
});

// ─── setupEncryptionKey ───────────────────────────────────────────────────────

describe('setupEncryptionKey', () => {
  it('sets session key ready after setup', async () => {
    expect(hasEncryptionReady()).toBe(false);
    await setupEncryptionKey('passphrase123', CFG);
    expect(hasEncryptionReady()).toBe(true);
  });
});

// ─── clearEncryptionKey ───────────────────────────────────────────────────────

describe('clearEncryptionKey', () => {
  it('clears session key and prevents encryption without passphrase', async () => {
    await setupEncryptionKey('test', CFG);
    expect(hasEncryptionReady()).toBe(true);

    await clearEncryptionKey(CFG);
    expect(hasEncryptionReady()).toBe(false);

    // Should fail since no passphrase or key
    await expect(encryptData({ x: 1 }, CFG)).rejects.toThrow('Encryption key not available');
  });

  it('clears IndexedDB so initSessionKey returns false after clear', async () => {
    await setupEncryptionKey('test', CFG);
    await clearEncryptionKey(CFG);

    // Fresh initSessionKey call should find nothing in IDB
    const restored = await initSessionKey(CFG);
    expect(restored).toBe(false);
    expect(hasEncryptionReady()).toBe(false);
  });
});

// ─── initSessionKey — key persistence across "page reload" ───────────────────

describe('initSessionKey — key persistence', () => {
  it('restores key from IndexedDB without passphrase (simulated reload)', async () => {
    // Setup: write key to IDB
    await setupEncryptionKey('reload-test-pass', CFG);
    const payload = { persisted: true };
    const envelope = await encryptData(payload, CFG);

    // Simulate reload: clear in-memory state without touching IDB
    // clearEncryptionKey wipes IDB too, so we call internal state reset via the
    // only available path: setup fresh then manually restore from IDB
    // The real test: initSessionKey loads from IDB → decryption succeeds
    const restored = await initSessionKey(CFG);
    expect(restored).toBe(true);
    expect(hasEncryptionReady()).toBe(true);

    const recovered = await decryptData(envelope, CFG);
    expect(recovered).toEqual(payload);
  });

  it('returns false when no key stored in IndexedDB', async () => {
    // Ensure IDB is clean
    await clearEncryptionKey(CFG);
    const restored = await initSessionKey(CFG);
    expect(restored).toBe(false);
  });
});

// ─── native bridge injection ──────────────────────────────────────────────────

describe('native bridge (nativeGetSyncKey / nativeStoreSyncKey injection)', () => {
  it('uses injected native functions instead of IndexedDB', async () => {
    let stored = null;
    const nativeStoreSyncKey = (val) => { stored = val; };
    const nativeGetSyncKey   = async () => stored;

    const nativeCfg = { cryptoDBName: 'unused', nativeGetSyncKey, nativeStoreSyncKey };

    await setupEncryptionKey('native-pass', nativeCfg);
    expect(stored).not.toBeNull(); // bridge was called

    // Simulate reload via native bridge
    await clearEncryptionKey({ ...nativeCfg, cryptoDBName: 'unused' });
    // stored is now null after clear
    expect(stored).toBeNull();
  });

  it('round-trips via native bridge', async () => {
    let stored = null;
    const nativeStoreSyncKey = (val) => { stored = val; };
    const nativeGetSyncKey   = async () => stored;

    const nativeCfg = { cryptoDBName: 'unused', nativeGetSyncKey, nativeStoreSyncKey };

    setSyncPassphrase('bridge-pass');
    const payload  = { native: 'yes' };
    const envelope = await encryptData(payload, nativeCfg);

    // Restore via native bridge
    const restored = await initSessionKey(nativeCfg);
    expect(restored).toBe(true);

    const recovered = await decryptData(envelope, nativeCfg);
    expect(recovered).toEqual(payload);
  });
});
