import { encryptData, decryptData, isEncryptedEnvelope, hasEncryptionReady } from './crypto.js';
import { webdavFetch } from './providers.js';

// btoa() throws InvalidCharacterError for codepoints > 255 (CJK, emoji, etc.).
const toBase64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

/**
 * Creates an IndexedDB-backed auto-backup store.
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
        const req = indexedDB.open(config.autoBackupDBName, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('backups')) {
            const store = db.createObjectStore('backups', { keyPath: 'id' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('frequency', 'frequency', { unique: false });
          }
        };
        req.onsuccess = () => { this._db = req.result; resolve(req.result); };
        req.onerror = () => reject(req.error);
      });
    },
    async saveBackup(frequency, data) {
      const db = await this.open();
      const timestamp = new Date().toISOString();
      const id = `auto-${frequency}-${timestamp}`;
      const record = { id, timestamp, frequency, data };
      return new Promise((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite');
        tx.objectStore('backups').put(record);
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error);
      });
    },
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
    async pruneBackups(frequency, maxCount) {
      const all = await this.listBackups(frequency);
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
