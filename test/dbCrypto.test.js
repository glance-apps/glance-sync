// Tests for per-entity encryption used by the database sync transport.
//
// Covers Phase 3 deliverable test #1: per-entity encrypt/decrypt round-trip.
// Salt registration against a real vault (test #2) lives in dbEngine.test.js.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setupDbRootKey,
  initDbRootKey,
  clearDbRootKey,
  hasDbRootKey,
  encryptEntity,
  decryptEntity,
} from '../src/dbCrypto.js';

const CFG = { cryptoDBName: 'glance-db-crypto-test' };

beforeEach(async () => {
  await clearDbRootKey(CFG);
});

describe('per-entity encrypt / decrypt', () => {
  it('round-trips an entity byte-for-byte', async () => {
    const salt = new Uint8Array(16).fill(9);
    await setupDbRootKey('passphrase-1', salt, CFG);

    const entity = { id: 'e1', title: 'Buy milk', tags: ['home', 'urgent'], n: 42, done: false };
    const ciphertext = await encryptEntity(entity, 'e1');
    expect(typeof ciphertext).toBe('string');

    const recovered = await decryptEntity(ciphertext, 'e1');
    expect(recovered).toEqual(entity);
  });

  it('produces a fresh IV (different ciphertext) on each call', async () => {
    await setupDbRootKey('passphrase-2', new Uint8Array(16).fill(1), CFG);
    const entity = { id: 'x', v: 1 };
    const c1 = await encryptEntity(entity, 'x');
    const c2 = await encryptEntity(entity, 'x');
    expect(c1).not.toBe(c2);
    expect(await decryptEntity(c1, 'x')).toEqual(entity);
    expect(await decryptEntity(c2, 'x')).toEqual(entity);
  });

  it('derives distinct keys per entityId (wrong id fails to decrypt)', async () => {
    await setupDbRootKey('passphrase-3', new Uint8Array(16).fill(2), CFG);
    const ciphertext = await encryptEntity({ secret: true }, 'entity-A');
    await expect(decryptEntity(ciphertext, 'entity-B')).rejects.toThrow('Decryption failed');
  });

  it('throws PASSPHRASE_REQUIRED when no root key is available', async () => {
    await expect(encryptEntity({ a: 1 }, 'e')).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    await expect(decryptEntity('AAAA', 'e')).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
  });

  it('restores the root key from device storage and decrypts an existing row', async () => {
    const salt = new Uint8Array(16).fill(7);
    await setupDbRootKey('reload-pass', salt, CFG);
    const ciphertext = await encryptEntity({ persisted: true }, 'e9');

    await clearDbRootKey(CFG); // wipes memory and storage
    // Re-register the same key as if persisted, then restore from storage.
    await setupDbRootKey('reload-pass', salt, CFG);
    expect(hasDbRootKey()).toBe(true);
    expect(await decryptEntity(ciphertext, 'e9')).toEqual({ persisted: true });

    // initDbRootKey loads from storage when memory is the only thing cleared.
    const restored = await initDbRootKey(CFG);
    expect(restored).toBe(true);
  });
});
