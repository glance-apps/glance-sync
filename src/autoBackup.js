import { encryptData, decryptData, isEncryptedEnvelope, hasEncryptionReady } from './crypto.js';
import { webdavFetch } from './providers.js';

// btoa() throws InvalidCharacterError for codepoints > 255 (CJK, emoji, etc.).
const toBase64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

// Backup ids are `auto-<frequency>-<ISO timestamp>` (saveBackup below), so a
// record's frequency and timestamp can be read from its key alone. Listing and
// pruning rely on that to work from keys and never load a backup's `data`:
// with dozens of retained copies of a multi-megabyte payload, reading every
// record just to decide which few to delete was a memory spike on every
// backup (krelltunez/dayGLANCE#2144).
const ID_PATTERN = /^auto-(hourly|daily|weekly)-(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/;

function parseBackupId(id) {
  const m = typeof id === 'string' ? id.match(ID_PATTERN) : null;
  return m ? { id, frequency: m[1], timestamp: m[2] } : null;
}

// SHA-256 of the payload's JSON, or null where WebCrypto is unavailable (then
// nothing is deduplicated: a missing fingerprint never matches).
async function fingerprintOf(data) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/**
 * Creates an IndexedDB-backed auto-backup store.
 *
 * Version 2 adds the `fingerprints` store: per frequency, the id and content
 * fingerprint of the last deduped backup saved, so an unchanged payload is not
 * stored again (saveBackup's opt-in dedupe). Version 1 databases upgrade in
 * place; their backups are untouched.
 *
 * @param {object} config
 * @param {string} config.autoBackupDBName   - IDB database name (e.g. 'dayglance-auto-backups')
 * @returns {object} autoBackupDB instance
 */
export function createAutoBackupDB(config) {
  return {
    _db: null,
    async open() {
      if (this._db) return this._db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(config.autoBackupDBName, 2);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('backups')) {
            const store = db.createObjectStore('backups', { keyPath: 'id' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('frequency', 'frequency', { unique: false });
          }
          if (!db.objectStoreNames.contains('fingerprints')) {
            db.createObjectStore('fingerprints', { keyPath: 'frequency' });
          }
        };
        req.onsuccess = () => { this._db = req.result; resolve(req.result); };
        req.onerror = () => reject(req.error);
      });
    },
    /**
     * Save `data` as a backup of `frequency`.
     *
     * Opt-in dedupe: with a `fingerprint`, or `dedupe: true`, a payload
     * identical to the last backup of that frequency that still exists is not
     * stored again. Backups exist to capture change, not the clock. It is
     * opt-in because it changes what a caller's retention keeps (the last N
     * distinct states rather than the last N ticks), and a changed default is
     * a major version under this package's versioning rules.
     *
     * Options:
     *   fingerprint — the caller's own content fingerprint. Pass one when the
     *     payload carries fields that change on every build (an export
     *     timestamp), so they do not defeat the comparison. Implies dedupe.
     *   dedupe — true compares a SHA-256 of the whole payload when no
     *     fingerprint is given. Default: true when a fingerprint is passed,
     *     false otherwise.
     *
     * Resolves to the saved record, or, when skipped, to
     * `{ id, timestamp, frequency, skipped: true }` describing the existing
     * backup that already holds this content. A save without dedupe clears
     * the frequency's recorded fingerprint, so a later deduped save compares
     * against the newest backup, never an older one.
     */
    async saveBackup(frequency, data, { fingerprint, dedupe = fingerprint !== undefined } = {}) {
      const db = await this.open();
      const print = dedupe ? (fingerprint ?? await fingerprintOf(data)) : null;
      if (print) {
        const tx = db.transaction(['fingerprints', 'backups'], 'readonly');
        const last = await request(tx.objectStore('fingerprints').get(frequency));
        if (last && last.fingerprint === print) {
          // Only a backup that still exists counts: one the user deleted
          // holds nothing, and this content must be saved again.
          const stillThere = await request(tx.objectStore('backups').count(last.id));
          if (stillThere > 0) return { ...(parseBackupId(last.id) || { id: last.id, frequency }), skipped: true };
        }
      }
      const timestamp = new Date().toISOString();
      const id = `auto-${frequency}-${timestamp}`;
      const record = { id, timestamp, frequency, data };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['backups', 'fingerprints'], 'readwrite');
        tx.objectStore('backups').put(record);
        if (print) tx.objectStore('fingerprints').put({ frequency, id, fingerprint: print });
        else tx.objectStore('fingerprints').delete(frequency);
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error);
      });
    },
    /** Full records, `data` included. For a list to show, use listBackupMeta. */
    async listBackups(frequency) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('backups', 'readonly');
        const store = tx.objectStore('backups');
        const req = frequency
          ? store.index('frequency').getAll(frequency)
          : store.getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
        req.onerror = () => reject(req.error);
      });
    },
    /**
     * `{ id, timestamp, frequency }` for each backup, newest first, read from
     * the keys: no backup's `data` is loaded. A record whose id does not follow
     * saveBackup's format (none should) is read individually for its fields.
     */
    async listBackupMeta(frequency) {
      const db = await this.open();
      const tx = db.transaction('backups', 'readonly');
      const store = tx.objectStore('backups');
      const ids = await request(frequency ? store.index('frequency').getAllKeys(frequency) : store.getAllKeys());
      const meta = [];
      for (const id of ids) {
        const parsed = parseBackupId(id);
        if (parsed) { meta.push(parsed); continue; }
        const record = await request(store.get(id));
        if (record) meta.push({ id: record.id, timestamp: record.timestamp, frequency: record.frequency });
      }
      return meta.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    },
    async getBackup(id) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('backups', 'readonly');
        const req = tx.objectStore('backups').get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async deleteBackup(id) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite');
        tx.objectStore('backups').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    /**
     * Keep the newest `maxCount` backups of `frequency` and delete the rest.
     * Chooses from metadata only (listBackupMeta), so memory stays flat however
     * large or numerous the backups are. Resolves to the number deleted, or
     * undefined when there was nothing to prune.
     */
    async pruneBackups(frequency, maxCount) {
      const all = await this.listBackupMeta(frequency);
      if (all.length <= maxCount) return;
      const toDelete = all.slice(maxCount);
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite');
        const store = tx.objectStore('backups');
        toDelete.forEach(b => store.delete(b.id));
        tx.oncomplete = () => resolve(toDelete.length);
        tx.onerror = () => reject(tx.error);
      });
    }
  };
}

/**
 * Creates the auto-backup remote provider objects.
 * These are separate from cloudSyncProviders (real-time sync); they handle
 * periodic snapshot uploads.
 *
 * @param {object} config
 * @param {string} config.backupFilenamePrefix - e.g. 'dayglance-backup-'
 * @param {string} config.appFolderName        - e.g. 'dayglance' (used in Nextcloud path)
 * @param {Function} config.webdavFetch        - bound webdavFetch(method, url, auth, body, extra)
 * @returns {object} provider map keyed by provider id
 */
export function createAutoBackupProviders(config) {
  const wdFetch = config.webdavFetch;
  const prefix = config.backupFilenamePrefix;
  const appFolder = config.appFolderName;

  return {
    nextcloud: {
      name: 'Nextcloud / WebDAV',
      configFields: [
        { key: 'nextcloudUrl', label: 'Nextcloud URL', type: 'url', placeholder: 'https://cloud.example.com' },
        { key: 'username', label: 'Username', type: 'text', placeholder: 'your-username' },
        { key: 'appPassword', label: 'App Password', type: 'password', placeholder: 'xxxxx-xxxxx-xxxxx-xxxxx-xxxxx' }
      ],
      _getBackupDirUrl(providerConfig) {
        if (!providerConfig.nextcloudUrl) throw new Error('Nextcloud URL is not configured');
        return `${providerConfig.nextcloudUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(providerConfig.username)}/${appFolder}/backups/`;
      },
      _getAuthHeaders(providerConfig) {
        return { 'X-WebDAV-Auth': 'Basic ' + toBase64(providerConfig.username + ':' + providerConfig.appPassword) };
      },
      async uploadBackup(providerConfig, data) {
        const dirUrl = this._getBackupDirUrl(providerConfig);
        const authHeaders = this._getAuthHeaders(providerConfig);
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
        const filename = `${prefix}${timestamp}.json`;
        const fileUrl = dirUrl + filename;
        const payload = hasEncryptionReady() ? await encryptData(data) : data;
        const body = JSON.stringify(payload);

        const doUpload = () =>
          wdFetch('PUT', fileUrl, authHeaders, body, { 'Content-Type': 'application/json' });

        let res = await doUpload();
        if (res.status === 404 || res.status === 409) {
          const parentDir = `${providerConfig.nextcloudUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(providerConfig.username)}/${appFolder}/`;
          await wdFetch('MKCOL', parentDir, authHeaders);
          await wdFetch('MKCOL', dirUrl, authHeaders);
          res = await doUpload();
        }
        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
        return filename;
      },
      async listBackups(providerConfig) {
        const dirUrl = this._getBackupDirUrl(providerConfig);
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('PROPFIND', dirUrl, authHeaders, undefined, { 'Depth': '1' });
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`List failed: ${res.status}`);
        const xml = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'application/xml');
        const responses = doc.querySelectorAll('response');
        const files = [];
        responses.forEach(r => {
          const href = r.querySelector('href')?.textContent || '';
          const filename = decodeURIComponent(href.split('/').filter(Boolean).pop());
          if (filename.startsWith(prefix) && filename.endsWith('.json')) {
            const lastModified = r.querySelector('getlastmodified')?.textContent;
            files.push({ filename, lastModified: lastModified ? new Date(lastModified).toISOString() : null });
          }
        });
        return files.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
      },
      async downloadBackup(providerConfig, filename) {
        const fileUrl = this._getBackupDirUrl(providerConfig) + filename;
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('GET', fileUrl, authHeaders);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const parsed = await res.json();
        if (isEncryptedEnvelope(parsed)) return decryptData(parsed);
        return parsed;
      },
      async deleteBackup(providerConfig, filename) {
        const fileUrl = this._getBackupDirUrl(providerConfig) + filename;
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('DELETE', fileUrl, authHeaders);
        if (!res.ok && res.status !== 404) throw new Error(`Delete failed: ${res.status}`);
      },
      async testConnection(providerConfig) {
        const dirUrl = this._getBackupDirUrl(providerConfig);
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('PROPFIND', dirUrl, authHeaders, undefined, { 'Depth': '0' });
        if (res.status === 200 || res.status === 207 || res.status === 404) return { success: true };
        if (res.status === 401) return { success: false, error: 'Invalid credentials.' };
        return { success: false, error: `Unexpected response: ${res.status}` };
      }
    },
    webdav: {
      name: 'Generic WebDAV',
      configFields: [
        { key: 'webdavUrl', label: 'WebDAV URL', type: 'url', placeholder: 'https://app.koofr.net/dav/Koofr/dayGLANCE/' },
        { key: 'username', label: 'Username', type: 'text', placeholder: 'your-username' },
        { key: 'appPassword', label: 'Password / App Password', type: 'password', placeholder: 'your-password' }
      ],
      _getBackupDirUrl(providerConfig) {
        // Nest backups under the app folder (mirroring the sync file path
        // `${webdavUrl}/${appFolderName}/${syncFilename}` and the nextcloud
        // provider's `${appFolder}/backups/`). Writing to the bare WebDAV root
        // fails with 405 on NAS targets (Synology/fnOS) that only permit PUT
        // inside a shared folder.
        return `${providerConfig.webdavUrl.replace(/\/+$/, '')}/${appFolder}/backups/`;
      },
      _getAuthHeaders(providerConfig) {
        return { 'X-WebDAV-Auth': 'Basic ' + toBase64(providerConfig.username + ':' + providerConfig.appPassword) };
      },
      async uploadBackup(providerConfig, data) {
        const dirUrl = this._getBackupDirUrl(providerConfig);
        const authHeaders = this._getAuthHeaders(providerConfig);
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
        const filename = `${prefix}${timestamp}.json`;
        const fileUrl = dirUrl + filename;
        const payload = hasEncryptionReady() ? await encryptData(data) : data;
        const body = JSON.stringify(payload);
        const doUpload = () =>
          wdFetch('PUT', fileUrl, authHeaders, body, { 'Content-Type': 'application/json' });
        let res = await doUpload();
        if (res.status === 404 || res.status === 409) {
          // Create the app folder before the backups/ subdir so the first
          // backup to a fresh target doesn't 404/409 (mirrors the nextcloud
          // provider). MKCOL on an existing collection is a harmless no-op.
          const parentDir = `${providerConfig.webdavUrl.replace(/\/+$/, '')}/${appFolder}/`;
          await wdFetch('MKCOL', parentDir, authHeaders);
          await wdFetch('MKCOL', dirUrl, authHeaders);
          res = await doUpload();
        }
        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
        return filename;
      },
      async listBackups(providerConfig) {
        const dirUrl = this._getBackupDirUrl(providerConfig);
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('PROPFIND', dirUrl, authHeaders, undefined, { 'Depth': '1' });
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`List failed: ${res.status}`);
        const xml = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'application/xml');
        const responses = doc.querySelectorAll('response');
        const files = [];
        responses.forEach(r => {
          const href = r.querySelector('href')?.textContent || '';
          const filename = decodeURIComponent(href.split('/').filter(Boolean).pop());
          if (filename.startsWith(prefix) && filename.endsWith('.json')) {
            const lastModified = r.querySelector('getlastmodified')?.textContent;
            files.push({ filename, lastModified: lastModified ? new Date(lastModified).toISOString() : null });
          }
        });
        return files.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
      },
      async downloadBackup(providerConfig, filename) {
        const fileUrl = this._getBackupDirUrl(providerConfig) + filename;
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('GET', fileUrl, authHeaders);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const parsed = await res.json();
        if (isEncryptedEnvelope(parsed)) return decryptData(parsed);
        return parsed;
      },
      async deleteBackup(providerConfig, filename) {
        const fileUrl = this._getBackupDirUrl(providerConfig) + filename;
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('DELETE', fileUrl, authHeaders);
        if (!res.ok && res.status !== 404) throw new Error(`Delete failed: ${res.status}`);
      },
      async testConnection(providerConfig) {
        const dirUrl = this._getBackupDirUrl(providerConfig);
        const authHeaders = this._getAuthHeaders(providerConfig);
        const res = await wdFetch('PROPFIND', dirUrl, authHeaders, undefined, { 'Depth': '0' });
        if (res.status === 200 || res.status === 207 || res.status === 404) return { success: true };
        if (res.status === 401) return { success: false, error: 'Invalid credentials.' };
        return { success: false, error: `Unexpected response: ${res.status}` };
      }
    }
  };
}

// Auto-backup retention limits (app-agnostic constants)
export const AUTO_BACKUP_RETENTION = { hourly: 24, daily: 30, weekly: 12 };
export const AUTO_BACKUP_INTERVALS = { hourly: 3600, daily: 86400, weekly: 604800 };
