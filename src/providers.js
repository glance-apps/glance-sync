// WebDAV provider objects and transport routing for cloud sync.
// No hardcoded app names, paths, or platform globals — all injected via config.

import { encryptData, decryptData, isEncryptedEnvelope } from './crypto.js';

// btoa() throws InvalidCharacterError for codepoints > 255 (CJK, emoji, etc.).
const toBase64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

// ---------------------------------------------------------------------------
// Transport routing
// ---------------------------------------------------------------------------

/**
 * Creates the transport-selecting WebDAV fetcher for a given engine config.
 * Returns an async function with the same signature as the original webdavFetch.
 *
 * Transport priority:
 *   1. nativeHttpRequest != null  → Android HTTP bridge (direct, no CORS)
 *   2. electronProxyFetch != null → Electron main-process net.fetch
 *   3. fallback                   → server-side CORS proxy at proxyUrl
 *
 * iOS note: pass nativeHttpRequest = null on iOS (the iOS DayGlanceNative Proxy
 * makes every property truthy, so callers must apply the !DayGlanceIOS guard
 * before deciding whether to pass a function here).
 *
 * @param {object}        config
 * @param {Function|null} config.nativeHttpRequest  - Android bridge fn, or null
 * @param {Function|null} config.electronProxyFetch - Electron proxy fn, or null
 * @param {string}        [config.proxyUrl='']      - base URL for CORS proxy
 */
export const webdavFetch = (config) => async (method, targetUrl, authHeaders, body, extraHeaders = {}) => {
  if (config.nativeHttpRequest != null) {
    // Android: call the target URL directly via the native HTTP bridge.
    const headers = { ...extraHeaders };
    if (authHeaders['X-WebDAV-Auth']) {
      headers['Authorization'] = authHeaders['X-WebDAV-Auth'];
    } else {
      Object.assign(headers, authHeaders);
    }
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = extraHeaders['Content-Type'] || 'application/octet-stream';
    }
    const result = config.nativeHttpRequest(method, targetUrl, headers, body ?? '');
    if (!result) throw new Error('Native HTTP bridge unavailable');
    return {
      status: result.status,
      ok: result.ok,
      statusText: result.error || '',
      headers: { get: (h) => (h.toLowerCase() === 'etag' ? result.headers?.etag ?? null : null) },
      json: async () => {
        try { return JSON.parse(result.body); }
        catch { throw new Error(`Server returned non-JSON response (status ${result.status})`); }
      },
      text: async () => result.body,
    };
  }

  if (config.electronProxyFetch != null) {
    // Electron: route through the main process (net.fetch has no CORS restrictions).
    const headers = { ...extraHeaders };
    if (authHeaders['X-WebDAV-Auth']) {
      headers['Authorization'] = authHeaders['X-WebDAV-Auth'];
    } else {
      Object.assign(headers, authHeaders);
    }
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = extraHeaders['Content-Type'] || 'application/octet-stream';
    }
    const result = await config.electronProxyFetch(method, targetUrl, headers, body ?? null);
    if (!result) throw new Error('Electron network bridge unavailable');
    return {
      status: result.status,
      ok: result.ok,
      statusText: result.statusText,
      headers: { get: (h) => (h.toLowerCase() === 'etag' ? result.headers?.etag ?? null : null) },
      json: async () => {
        try { return JSON.parse(result.body); }
        catch { throw new Error(`Server returned non-JSON response (status ${result.status})`); }
      },
      text: async () => result.body,
    };
  }

  // Web / iOS: route through the server-side CORS proxy.
  return fetch(`${config.proxyUrl ?? ''}/api/webdav-proxy/?url=${encodeURIComponent(targetUrl)}`, {
    method,
    headers: { ...authHeaders, ...extraHeaders },
    ...(body !== undefined && body !== null ? { body } : {}),
  });
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function parseDownloadResponse(res, engineConfig) {
  const parsed = await res.json();
  const payload = isEncryptedEnvelope(parsed) ? await decryptData(parsed, engineConfig) : parsed;
  const etag = res.headers.get('etag') || null;
  return { payload, etag };
}

async function mkcolWithParents(dirUrl, authHeaders, wf) {
  const res = await wf('MKCOL', dirUrl, authHeaders);
  if (res.status === 409 || res.status === 404 || res.status === 405) {
    // Derive parent by stripping the last path segment via URL() to avoid
    // producing malformed strings on root-level inputs.
    let parent;
    try {
      const u = new URL(dirUrl);
      const stripped = u.pathname.replace(/\/+$/, '').replace(/\/[^/]+$/, '/');
      if (!stripped || stripped === u.pathname.replace(/\/+$/, '')) return;
      u.pathname = stripped;
      parent = u.toString();
    } catch { return; }
    if (parent && parent !== dirUrl) {
      await mkcolWithParents(parent, authHeaders, wf);
      await wf('MKCOL', dirUrl, authHeaders);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Creates the cloud sync provider objects for the given engine config.
 * Provider methods keep the same per-call signature as dayGLANCE's original
 * cloudSyncProviders — callers pass user credentials via `config`.
 *
 * @param {object} engineConfig
 * @param {string}        engineConfig.appFolderName       - e.g. 'dayglance'
 * @param {string}        engineConfig.syncFilename        - e.g. 'dayglance-sync.json'
 * @param {Function|null} engineConfig.nativeHttpRequest   - Android bridge, or null
 * @param {Function|null} engineConfig.electronProxyFetch  - Electron proxy, or null
 * @param {string}        [engineConfig.proxyUrl='']       - CORS proxy base URL
 * @param {string}        engineConfig.cryptoDBName        - IndexedDB name for key storage
 * @param {Function|null} [engineConfig.nativeGetSyncKey]  - Android crypto key bridge
 * @param {Function|null} [engineConfig.nativeStoreSyncKey]
 */
export function createProviders(engineConfig) {
  const { appFolderName, syncFilename } = engineConfig;
  const wf = webdavFetch(engineConfig);

  const parseDownload = (res) => parseDownloadResponse(res, engineConfig);
  const mkcol = (dirUrl, authHeaders) => mkcolWithParents(dirUrl, authHeaders, wf);

  return {
    nextcloud: {
      name: 'Nextcloud / WebDAV',
      getFileUrl: (config) =>
        `${config.nextcloudUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(config.username)}/${appFolderName}/${syncFilename}`,
      getDirUrl: (config) =>
        `${config.nextcloudUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(config.username)}/${appFolderName}/`,
      getAuthHeaders: (config) => ({
        'X-WebDAV-Auth': 'Basic ' + toBase64(config.username + ':' + config.appPassword)
      }),
      async upload(config, data, etag = null) {
        const fileUrl = this.getFileUrl(config);
        const dirUrl = this.getDirUrl(config);
        const authHeaders = this.getAuthHeaders(config);
        const payload = config.encryptionEnabled ? await encryptData(data, engineConfig) : data;
        const body = JSON.stringify(payload);
        const extraHeaders = { 'Content-Type': 'application/json' };
        if (etag) extraHeaders['If-Match'] = etag;
        const doUpload = () => wf('PUT', fileUrl, authHeaders, body, extraHeaders);
        let res = await doUpload();
        if (res.status === 404 || res.status === 409) {
          await mkcol(dirUrl, authHeaders);
          res = await doUpload();
        }
        if (res.status === 403) throw new Error('FORBIDDEN');
        if (res.status === 412) throw new Error('PRECONDITION_FAILED');
        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
        return true;
      },
      async download(config) {
        const fileUrl = this.getFileUrl(config);
        const authHeaders = this.getAuthHeaders(config);
        const res = await wf('GET', fileUrl, authHeaders);
        if (res.status === 404) return null;
        if (res.status === 403) throw new Error('FORBIDDEN');
        if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
        return parseDownload(res);
      },
      async test(config) {
        const dirUrl = this.getDirUrl(config);
        const authHeaders = this.getAuthHeaders(config);
        const res = await wf('PROPFIND', dirUrl, authHeaders, undefined, { 'Depth': '0' });
        if (res.status === 200 || res.status === 207 || res.status === 404) return { success: true };
        if (res.status === 401) return { success: false, error: 'Invalid credentials. Check your username and app password.' };
        if (res.status === 403) return { success: false, error: "Access forbidden (403). If using a self-hosted server, it may be blocking requests from Vercel's IP addresses." };
        return { success: false, error: `Unexpected response: ${res.status}${res.statusText ? ' ' + res.statusText : ''}` };
      },
      configFields: [
        { key: 'nextcloudUrl', label: 'Nextcloud URL', type: 'url', placeholder: 'https://cloud.example.com' },
        { key: 'username', label: 'Username', type: 'text', placeholder: 'your-username' },
        { key: 'appPassword', label: 'App Password', type: 'password', placeholder: 'xxxxx-xxxxx-xxxxx-xxxxx-xxxxx' }
      ],
      helpText: 'Go to Nextcloud Settings → Security → Devices & sessions → Create new app password'
    },

    koofr: {
      name: 'Koofr',
      getFileUrl: () => `https://app.koofr.net/dav/Koofr/${appFolderName}/${syncFilename}`,
      getDirUrl: () => `https://app.koofr.net/dav/Koofr/${appFolderName}/`,
      getAuthHeaders: (config) => ({
        'X-WebDAV-Auth': 'Basic ' + toBase64(config.username + ':' + config.appPassword)
      }),
      async upload(config, data, etag = null) {
        const fileUrl = this.getFileUrl();
        const dirUrl = this.getDirUrl();
        const authHeaders = this.getAuthHeaders(config);
        const payload = config.encryptionEnabled ? await encryptData(data, engineConfig) : data;
        const body = JSON.stringify(payload);
        const extraHeaders = { 'Content-Type': 'application/json' };
        if (etag) extraHeaders['If-Match'] = etag;
        const doUpload = () => wf('PUT', fileUrl, authHeaders, body, extraHeaders);
        let res = await doUpload();
        if (res.status === 404 || res.status === 409) {
          await mkcol(dirUrl, authHeaders);
          res = await doUpload();
        }
        if (res.status === 403) throw new Error('FORBIDDEN');
        if (res.status === 412) throw new Error('PRECONDITION_FAILED');
        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
        return true;
      },
      async download(config) {
        const fileUrl = this.getFileUrl();
        const authHeaders = this.getAuthHeaders(config);
        const res = await wf('GET', fileUrl, authHeaders);
        if (res.status === 404) return null;
        if (res.status === 403) throw new Error('FORBIDDEN');
        if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
        return parseDownload(res);
      },
      async test(config) {
        const dirUrl = this.getDirUrl();
        const authHeaders = this.getAuthHeaders(config);
        const res = await wf('PROPFIND', dirUrl, authHeaders, undefined, { 'Depth': '0' });
        if (res.status === 200 || res.status === 207 || res.status === 404) return { success: true };
        if (res.status === 401) return { success: false, error: 'Invalid credentials. Use your Koofr email and an app password, not your account password.' };
        if (res.status === 403) {
          // nativeHttpRequest != null means the Android HTTP bridge is available,
          // which bypasses Koofr's server-side block on Vercel proxy IPs.
          const onAndroid = engineConfig.nativeHttpRequest != null;
          if (!onAndroid) {
            if (engineConfig.isHostedApp) {
              return { success: false, error: "Koofr blocks requests from dayglance.app's servers. Use a self-hosted instance or the Android app to connect directly." };
            }
            return { success: false, error: "Access forbidden. If requests are going through a proxy, Koofr may be blocking that server's IP." };
          }
          return { success: false, error: 'Access forbidden. Check that your app password is correct and has not been revoked.' };
        }
        return { success: false, error: `Unexpected response: ${res.status}${res.statusText ? ' ' + res.statusText : ''}` };
      },
      configFields: [
        { key: 'username', label: 'Email', type: 'text', placeholder: 'you@example.com' },
        { key: 'appPassword', label: 'App Password', type: 'password', placeholder: 'your-app-password' },
      ],
      helpText: "Go to Koofr → Preferences → App passwords → New app password. Use your Koofr email as the username. Note: sync works on the Android app (direct connection); the web app may be blocked by Koofr's server-side restrictions.",
    },

    webdav: {
      name: 'Generic WebDAV',
      getFileUrl: (config) =>
        `${config.webdavUrl.replace(/\/+$/, '')}/${appFolderName}/${syncFilename}`,
      getDirUrl: (config) =>
        `${config.webdavUrl.replace(/\/+$/, '')}/${appFolderName}/`,
      getAuthHeaders: (config) => ({
        'X-WebDAV-Auth': 'Basic ' + toBase64(config.username + ':' + config.appPassword)
      }),
      async upload(config, data, etag = null) {
        const fileUrl = this.getFileUrl(config);
        const dirUrl = this.getDirUrl(config);
        const authHeaders = this.getAuthHeaders(config);
        const payload = config.encryptionEnabled ? await encryptData(data, engineConfig) : data;
        const body = JSON.stringify(payload);
        const extraHeaders = { 'Content-Type': 'application/json' };
        if (etag) extraHeaders['If-Match'] = etag;
        const doUpload = () => wf('PUT', fileUrl, authHeaders, body, extraHeaders);
        let res = await doUpload();
        if (res.status === 404 || res.status === 409 || res.status === 403) {
          await mkcol(dirUrl, authHeaders);
          res = await doUpload();
        }
        if (res.status === 403) throw new Error('FORBIDDEN');
        if (res.status === 412) throw new Error('PRECONDITION_FAILED');
        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
        return true;
      },
      async download(config) {
        const fileUrl = this.getFileUrl(config);
        const authHeaders = this.getAuthHeaders(config);
        const res = await wf('GET', fileUrl, authHeaders);
        if (res.status === 404) return null;
        if (res.status === 403) throw new Error('FORBIDDEN');
        if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
        return parseDownload(res);
      },
      async test(config) {
        // GET the sync file rather than PROPFIND — Apache mod_dav and other strict
        // servers return 400 for a bodyless PROPFIND (RFC 4918 requires XML body).
        const fileUrl = this.getFileUrl(config);
        const authHeaders = this.getAuthHeaders(config);
        const res = await wf('GET', fileUrl, authHeaders);
        if (res.status === 200 || res.status === 404) return { success: true };
        if (res.status === 401) return { success: false, error: 'Invalid credentials. Check your username and password.' };
        if (res.status === 403) return { success: false, error: 'Access forbidden (403). Check that the WebDAV URL and path are correct.' };
        return { success: false, error: `Unexpected response: ${res.status}${res.statusText ? ' ' + res.statusText : ''}` };
      },
      configFields: [
        { key: 'webdavUrl', label: 'WebDAV URL', type: 'url', placeholder: 'https://dav.example.com' },
        { key: 'username', label: 'Username', type: 'text', placeholder: 'your-username' },
        { key: 'appPassword', label: 'Password / App Password', type: 'password', placeholder: 'your-password' }
      ],
      helpText: 'Enter the server root URL (e.g. https://dav.example.com). The sync folder is configured separately via the Sync Folder setting. pCloud, Seafile, and most self-hosted WebDAV providers are supported.'
    }
  };
}
