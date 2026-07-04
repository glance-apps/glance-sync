import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createAutoBackupDB,
  createAutoBackupProviders,
  AUTO_BACKUP_RETENTION,
  AUTO_BACKUP_INTERVALS,
} from '../src/autoBackup.js';

// ---------------------------------------------------------------------------
// IDB setup — each test gets a fresh IDB instance so tests are isolated
// ---------------------------------------------------------------------------
function makeDB(dbName = 'test-auto-backups') {
  const idb = new IDBFactory();
  // Patch global so the module under test picks it up
  global.indexedDB = idb;
  return createAutoBackupDB({ autoBackupDBName: dbName });
}

// ---------------------------------------------------------------------------
// AUTO_BACKUP_INTERVALS constants
// ---------------------------------------------------------------------------
describe('AUTO_BACKUP_INTERVALS', () => {
  it('has correct second values for each frequency', () => {
    expect(AUTO_BACKUP_INTERVALS.hourly).toBe(3600);
    expect(AUTO_BACKUP_INTERVALS.daily).toBe(86400);
    expect(AUTO_BACKUP_INTERVALS.weekly).toBe(604800);
  });
});

describe('AUTO_BACKUP_RETENTION', () => {
  it('matches expected retention counts', () => {
    expect(AUTO_BACKUP_RETENTION.hourly).toBe(24);
    expect(AUTO_BACKUP_RETENTION.daily).toBe(30);
    expect(AUTO_BACKUP_RETENTION.weekly).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// IDB store creation with configurable DB name
// ---------------------------------------------------------------------------
describe('createAutoBackupDB — store creation', () => {
  it('opens without error using the configured DB name', async () => {
    const db = makeDB('my-app-auto-backups');
    await expect(db.open()).resolves.toBeDefined();
  });

  it('creates the backups object store on first open', async () => {
    const db = makeDB('store-creation-test');
    const idbInstance = await db.open();
    expect(idbInstance.objectStoreNames.contains('backups')).toBe(true);
  });

  it('opens against a different DB name without cross-contamination', async () => {
    const db1 = makeDB('app-one-backups');
    const db2 = makeDB('app-two-backups');
    await db1.saveBackup('hourly', { tasks: ['a'] });
    const list2 = await db2.listBackups();
    expect(list2).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// saveBackup / listBackups / getBackup / deleteBackup
// ---------------------------------------------------------------------------
describe('createAutoBackupDB — CRUD', () => {
  it('saves and retrieves a backup by frequency', async () => {
    const db = makeDB();
    const record = await db.saveBackup('hourly', { tasks: [1, 2, 3] });
    expect(record.frequency).toBe('hourly');
    expect(record.data).toEqual({ tasks: [1, 2, 3] });
    expect(record.id).toMatch(/^auto-hourly-/);

    const list = await db.listBackups('hourly');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(record.id);
  });

  it('listBackups with no frequency arg returns all backups', async () => {
    const db = makeDB();
    await db.saveBackup('hourly', {});
    await db.saveBackup('daily', {});
    const all = await db.listBackups();
    expect(all).toHaveLength(2);
  });

  it('getBackup returns the correct record by id', async () => {
    const db = makeDB();
    const { id } = await db.saveBackup('weekly', { note: 'weekly snapshot' });
    const fetched = await db.getBackup(id);
    expect(fetched.data).toEqual({ note: 'weekly snapshot' });
  });

  it('deleteBackup removes the record', async () => {
    const db = makeDB();
    const { id } = await db.saveBackup('daily', {});
    await db.deleteBackup(id);
    const fetched = await db.getBackup(id);
    expect(fetched).toBeUndefined();
  });

  it('listBackups returns results sorted newest-first', async () => {
    const db = makeDB();
    await db.saveBackup('daily', { seq: 1 });
    await new Promise(r => setTimeout(r, 5)); // ensure distinct timestamps
    await db.saveBackup('daily', { seq: 2 });
    const list = await db.listBackups('daily');
    expect(list[0].data.seq).toBe(2);
    expect(list[1].data.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Retention enforcement (pruneBackups)
// ---------------------------------------------------------------------------
describe('createAutoBackupDB — pruneBackups', () => {
  it('does nothing when backups are within the limit', async () => {
    const db = makeDB();
    await db.saveBackup('hourly', {});
    await new Promise(r => setTimeout(r, 5));
    await db.saveBackup('hourly', {});
    const pruned = await db.pruneBackups('hourly', 5);
    expect(pruned).toBeUndefined(); // returns undefined when nothing to prune
    expect(await db.listBackups('hourly')).toHaveLength(2);
  });

  it('deletes oldest backups beyond maxCount', async () => {
    const db = makeDB();
    for (let i = 0; i < 5; i++) {
      await db.saveBackup('hourly', { seq: i });
      await new Promise(r => setTimeout(r, 5));
    }
    const pruned = await db.pruneBackups('hourly', 3);
    expect(pruned).toBe(2);
    const remaining = await db.listBackups('hourly');
    expect(remaining).toHaveLength(3);
    // Newest three survive
    const seqs = remaining.map(r => r.data.seq);
    expect(seqs).toContain(4);
    expect(seqs).toContain(3);
    expect(seqs).toContain(2);
  });

  it('prunes per-frequency without touching other frequencies', async () => {
    const db = makeDB();
    for (let i = 0; i < 4; i++) {
      await db.saveBackup('hourly', {});
      await new Promise(r => setTimeout(r, 5));
    }
    await db.saveBackup('daily', { keep: true });
    await db.pruneBackups('hourly', 2);
    expect(await db.listBackups('hourly')).toHaveLength(2);
    expect(await db.listBackups('daily')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Backup filename construction with configurable prefix
// ---------------------------------------------------------------------------
describe('createAutoBackupProviders — filename prefix', () => {
  function makeProviders(prefix = 'myapp-backup-', appFolder = 'myapp') {
    const calls = [];
    const mockFetch = vi.fn(async (method, url, auth, body, extra) => {
      calls.push({ method, url });
      return { ok: true, status: 200, statusText: 'OK' };
    });
    const providers = createAutoBackupProviders({
      backupFilenamePrefix: prefix,
      appFolderName: appFolder,
      webdavFetch: mockFetch,
    });
    return { providers, mockFetch, calls };
  }

  it('uses backupFilenamePrefix in the uploaded filename', async () => {
    const { providers, calls } = makeProviders('custom-prefix-', 'myapp');
    await providers.webdav.uploadBackup(
      { webdavUrl: 'https://dav.example.com/dav/', username: 'u', appPassword: 'p' },
      { tasks: [] }
    );
    const putCall = calls.find(c => c.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall.url).toMatch(/custom-prefix-.*\.json$/);
  });

  it('uses the dayGLANCE prefix for the default shim config', async () => {
    const { providers, calls } = makeProviders('dayglance-backup-', 'dayglance');
    await providers.webdav.uploadBackup(
      { webdavUrl: 'https://dav.example.com/dav/', username: 'u', appPassword: 'p' },
      {}
    );
    const putCall = calls.find(c => c.method === 'PUT');
    expect(putCall.url).toMatch(/dayglance-backup-.*\.json$/);
  });

  it('listBackups filters by the configured prefix', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 404 }));
    const p2 = createAutoBackupProviders({
      backupFilenamePrefix: 'otherapp-backup-',
      appFolderName: 'otherapp',
      webdavFetch: mockFetch,
    });
    const list = await p2.webdav.listBackups({ webdavUrl: 'https://dav.example.com/dav/', username: 'u', appPassword: 'p' });
    expect(list).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nextcloud auto-backup path construction
// ---------------------------------------------------------------------------
describe('createAutoBackupProviders — Nextcloud path', () => {
  function makeNextcloudProviders(appFolder) {
    const calls = [];
    const mockFetch = vi.fn(async (method, url) => {
      calls.push({ method, url });
      return { ok: true, status: 200, statusText: 'OK' };
    });
    const providers = createAutoBackupProviders({
      backupFilenamePrefix: 'myapp-backup-',
      appFolderName: appFolder,
      webdavFetch: mockFetch,
    });
    return { providers, calls };
  }

  it('constructs the correct Nextcloud backup dir URL with appFolderName', async () => {
    const { providers, calls } = makeNextcloudProviders('dayglance');
    await providers.nextcloud.uploadBackup(
      { nextcloudUrl: 'https://cloud.example.com', username: 'alice', appPassword: 'pass' },
      {}
    );
    const putCall = calls.find(c => c.method === 'PUT');
    expect(putCall.url).toContain('/remote.php/dav/files/alice/dayglance/backups/');
  });

  it('uses a different appFolderName correctly', async () => {
    const { providers, calls } = makeNextcloudProviders('myotherapp');
    await providers.nextcloud.uploadBackup(
      { nextcloudUrl: 'https://cloud.example.com', username: 'bob', appPassword: 'pass' },
      {}
    );
    const putCall = calls.find(c => c.method === 'PUT');
    expect(putCall.url).toContain('/remote.php/dav/files/bob/myotherapp/backups/');
  });

  it('strips trailing slash from nextcloudUrl before building path', async () => {
    const { providers, calls } = makeNextcloudProviders('dayglance');
    await providers.nextcloud.uploadBackup(
      { nextcloudUrl: 'https://cloud.example.com/', username: 'alice', appPassword: 'pass' },
      {}
    );
    const putCall = calls.find(c => c.method === 'PUT');
    expect(putCall.url).not.toContain('//remote.php');
    expect(putCall.url).toContain('cloud.example.com/remote.php');
  });

  it('throws if nextcloudUrl is not configured', () => {
    const { providers } = makeNextcloudProviders('dayglance');
    expect(() =>
      providers.nextcloud._getBackupDirUrl({ nextcloudUrl: '', username: 'u', appPassword: 'p' })
    ).toThrow('Nextcloud URL is not configured');
  });

  it('creates parent dir before backup dir on 404', async () => {
    const calls = [];
    let putCount = 0;
    const mockFetch = vi.fn(async (method, url) => {
      calls.push({ method, url });
      if (method === 'PUT' && putCount++ === 0) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      return { ok: true, status: 200, statusText: 'OK' };
    });
    const providers = createAutoBackupProviders({
      backupFilenamePrefix: 'myapp-backup-',
      appFolderName: 'dayglance',
      webdavFetch: mockFetch,
    });
    await providers.nextcloud.uploadBackup(
      { nextcloudUrl: 'https://cloud.example.com', username: 'alice', appPassword: 'pass' },
      {}
    );
    const mkcolCalls = calls.filter(c => c.method === 'MKCOL');
    expect(mkcolCalls).toHaveLength(2);
    expect(mkcolCalls[0].url).toContain('/dayglance/');
    expect(mkcolCalls[0].url).not.toContain('/backups/');
    expect(mkcolCalls[1].url).toContain('/dayglance/backups/');
  });
});

// ---------------------------------------------------------------------------
// Generic WebDAV auto-backup path construction
//
// Regression coverage for lifeGLANCE issue #206: backups were written to the
// bare WebDAV root (`<webdavUrl>/<prefix><ts>.json`), which NAS targets
// (Synology/fnOS) reject with 405 because PUT is only allowed inside a shared
// folder. Backups must now nest under `<webdavUrl>/<appFolderName>/backups/`.
// ---------------------------------------------------------------------------
describe('createAutoBackupProviders — generic WebDAV path', () => {
  function makeWebdavProviders(appFolder = 'lifeglance', prefix = 'lifeglance-backup-') {
    const calls = [];
    const mockFetch = vi.fn(async (method, url) => {
      calls.push({ method, url });
      return { ok: true, status: 200, statusText: 'OK' };
    });
    const providers = createAutoBackupProviders({
      backupFilenamePrefix: prefix,
      appFolderName: appFolder,
      webdavFetch: mockFetch,
    });
    return { providers, calls };
  }

  it('nests the backup dir under appFolderName/backups/ (not the root)', () => {
    const { providers } = makeWebdavProviders('lifeglance');
    const dirUrl = providers.webdav._getBackupDirUrl({ webdavUrl: 'http://nas:5005' });
    expect(dirUrl).toBe('http://nas:5005/lifeglance/backups/');
  });

  it('PUTs the backup inside <webdavUrl>/<appFolderName>/backups/', async () => {
    const { providers, calls } = makeWebdavProviders('lifeglance', 'lifeglance-backup-');
    await providers.webdav.uploadBackup(
      { webdavUrl: 'http://nas:5005', username: 'u', appPassword: 'p' },
      { tasks: [] }
    );
    const putCall = calls.find(c => c.method === 'PUT');
    expect(putCall.url).toMatch(
      /^http:\/\/nas:5005\/lifeglance\/backups\/lifeglance-backup-.*\.json$/
    );
  });

  it('normalizes a trailing slash on webdavUrl without doubling', () => {
    const { providers } = makeWebdavProviders('lifeglance');
    const dirUrl = providers.webdav._getBackupDirUrl({ webdavUrl: 'http://nas:5005/' });
    expect(dirUrl).toBe('http://nas:5005/lifeglance/backups/');
    expect(dirUrl).not.toContain('//lifeglance');
  });

  it('creates the app folder before the backups/ subdir on 404', async () => {
    const calls = [];
    let putCount = 0;
    const mockFetch = vi.fn(async (method, url) => {
      calls.push({ method, url });
      if (method === 'PUT' && putCount++ === 0) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      return { ok: true, status: 200, statusText: 'OK' };
    });
    const providers = createAutoBackupProviders({
      backupFilenamePrefix: 'lifeglance-backup-',
      appFolderName: 'lifeglance',
      webdavFetch: mockFetch,
    });
    await providers.webdav.uploadBackup(
      { webdavUrl: 'http://nas:5005', username: 'u', appPassword: 'p' },
      {}
    );
    const mkcolCalls = calls.filter(c => c.method === 'MKCOL');
    expect(mkcolCalls).toHaveLength(2);
    expect(mkcolCalls[0].url).toBe('http://nas:5005/lifeglance/');
    expect(mkcolCalls[1].url).toBe('http://nas:5005/lifeglance/backups/');
  });

  it('retries the PUT after creating the directory (405-style fresh target)', async () => {
    const calls = [];
    let putCount = 0;
    const mockFetch = vi.fn(async (method, url) => {
      calls.push({ method, url });
      // First PUT to a missing collection returns 409 Conflict (parent absent).
      if (method === 'PUT' && putCount++ === 0) {
        return { ok: false, status: 409, statusText: 'Conflict' };
      }
      return { ok: true, status: 201, statusText: 'Created' };
    });
    const providers = createAutoBackupProviders({
      backupFilenamePrefix: 'lifeglance-backup-',
      appFolderName: 'lifeglance',
      webdavFetch: mockFetch,
    });
    const filename = await providers.webdav.uploadBackup(
      { webdavUrl: 'http://nas:5005', username: 'u', appPassword: 'p' },
      {}
    );
    const putCalls = calls.filter(c => c.method === 'PUT');
    expect(putCalls).toHaveLength(2);
    expect(putCalls.every(c => c.url.startsWith('http://nas:5005/lifeglance/backups/'))).toBe(true);
    expect(filename).toMatch(/^lifeglance-backup-.*\.json$/);
  });

  it('lists and deletes within the nested backups dir (retention targeting)', async () => {
    // DOMParser is not available under vitest's default node environment, so
    // exercise listBackups via its 404 short-circuit (returns [] before parsing)
    // and assert the PROPFIND/DELETE URLs both target the nested backups dir.
    const calls = [];
    const mockFetch = vi.fn(async (method, url) => {
      calls.push({ method, url });
      if (method === 'PROPFIND') return { ok: false, status: 404 };
      return { ok: true, status: 204, statusText: 'No Content' };
    });
    const providers = createAutoBackupProviders({
      backupFilenamePrefix: 'lifeglance-backup-',
      appFolderName: 'lifeglance',
      webdavFetch: mockFetch,
    });
    const cfg = { webdavUrl: 'http://nas:5005', username: 'u', appPassword: 'p' };

    const list = await providers.webdav.listBackups(cfg);
    expect(list).toEqual([]);
    expect(calls.find(c => c.method === 'PROPFIND').url).toBe('http://nas:5005/lifeglance/backups/');

    await providers.webdav.deleteBackup(cfg, 'lifeglance-backup-2026-07-04T10-00-00.json');
    const deleteCall = calls.find(c => c.method === 'DELETE');
    expect(deleteCall.url).toBe(
      'http://nas:5005/lifeglance/backups/lifeglance-backup-2026-07-04T10-00-00.json'
    );
  });
});
