import 'fake-indexeddb/auto'; // providers import crypto.js which needs IndexedDB
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webdavFetch, createProviders, normalizeEtag } from '../src/providers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal engine config — no native bridges, no proxy URL (relative path).
const BASE_ENGINE = {
  appFolderName: 'myapp',
  syncFilename: 'myapp-sync.json',
  nativeHttpRequest: null,
  electronProxyFetch: null,
  proxyUrl: '',
  cryptoDBName: 'providers-test-crypto',
};

// Build a mock HTTP response with the shape both native and web paths return.
const mockResp = (status, body = {}, extraHeaders = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  statusText: status === 200 ? 'OK' : String(status),
  headers: {
    get: (h) => extraHeaders[h.toLowerCase()] ?? null,
  },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// Fake user credentials for provider methods.
const USER_CFG = {
  username: 'alice',
  appPassword: 'secret',
  nextcloudUrl: 'https://cloud.example.com',
  webdavUrl: 'https://dav.example.com/mydir',
  encryptionEnabled: false,
};

// ─── webdavFetch — transport selection ───────────────────────────────────────

describe('webdavFetch — transport selection', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('native path: calls nativeHttpRequest and wraps the result', async () => {
    const nativeResult = {
      status: 200, ok: true, body: JSON.stringify({ ok: true }), headers: { etag: '"abc"' }
    };
    const nativeFn = vi.fn().mockReturnValue(nativeResult);
    const fetch = webdavFetch({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });

    const res = await fetch('GET', 'https://dav.host/file', { 'X-WebDAV-Auth': 'Basic xyz' });

    expect(nativeFn).toHaveBeenCalledOnce();
    expect(nativeFn.mock.calls[0][0]).toBe('GET');
    expect(nativeFn.mock.calls[0][1]).toBe('https://dav.host/file');
    // X-WebDAV-Auth should be re-mapped to Authorization
    expect(nativeFn.mock.calls[0][2]).toMatchObject({ Authorization: 'Basic xyz' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"abc"');
  });

  it('native path: ETag header accessible via res.headers.get("etag")', async () => {
    const nativeFn = vi.fn().mockReturnValue({
      status: 200, ok: true, body: '{}', headers: { etag: '"v42"' }
    });
    const fetch = webdavFetch({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    const res = await fetch('GET', 'https://h/f', {});
    expect(res.headers.get('etag')).toBe('"v42"');
    expect(res.headers.get('content-type')).toBeNull();
  });

  it('native path: throws when nativeHttpRequest returns null', async () => {
    const nativeFn = vi.fn().mockReturnValue(null);
    const fetch = webdavFetch({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    await expect(fetch('GET', 'https://h/f', {})).rejects.toThrow('Native HTTP bridge unavailable');
  });

  it('electron path: calls electronProxyFetch and wraps the result', async () => {
    const electronResult = {
      status: 201, ok: true, statusText: 'Created',
      body: '{}', headers: { etag: '"e1"' }
    };
    const electronFn = vi.fn().mockResolvedValue(electronResult);
    const fetch = webdavFetch({ ...BASE_ENGINE, electronProxyFetch: electronFn });

    const res = await fetch('PUT', 'https://dav.host/file', { 'X-WebDAV-Auth': 'Basic xyz' }, '{"a":1}');

    expect(electronFn).toHaveBeenCalledOnce();
    expect(electronFn.mock.calls[0][0]).toBe('PUT');
    expect(electronFn.mock.calls[0][1]).toBe('https://dav.host/file');
    expect(electronFn.mock.calls[0][2]).toMatchObject({ Authorization: 'Basic xyz' });
    expect(res.status).toBe(201);
  });

  it('electron path: throws when electronProxyFetch returns null', async () => {
    const electronFn = vi.fn().mockResolvedValue(null);
    const fetch = webdavFetch({ ...BASE_ENGINE, electronProxyFetch: electronFn });
    await expect(fetch('GET', 'https://h/f', {})).rejects.toThrow('Electron network bridge unavailable');
  });

  it('native takes priority over electron when both are present', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 200, ok: true, body: '{}', headers: {} });
    const electronFn = vi.fn().mockResolvedValue({ status: 200, ok: true, statusText: '', body: '{}', headers: {} });
    const fetch = webdavFetch({ ...BASE_ENGINE, nativeHttpRequest: nativeFn, electronProxyFetch: electronFn });
    await fetch('GET', 'https://h/f', {});
    expect(nativeFn).toHaveBeenCalledOnce();
    expect(electronFn).not.toHaveBeenCalled();
  });

  it('web path: calls global fetch with proxy URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResp(200));
    vi.stubGlobal('fetch', mockFetch);

    const fetch = webdavFetch({ ...BASE_ENGINE, proxyUrl: 'https://proxy.example.com' });
    await fetch('GET', 'https://dav.host/file', { 'Authorization': 'Basic abc' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('https://proxy.example.com/api/webdav-proxy/');
    expect(url).toContain(encodeURIComponent('https://dav.host/file'));
    expect(opts.method).toBe('GET');
    expect(opts.headers).toMatchObject({ Authorization: 'Basic abc' });
  });

  it('web path: relative proxy URL (proxyUrl empty string)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResp(200));
    vi.stubGlobal('fetch', mockFetch);

    const fetch = webdavFetch(BASE_ENGINE); // proxyUrl: ''
    await fetch('GET', 'https://dav.host/f', {});

    const [url] = mockFetch.mock.calls[0];
    expect(url).toMatch(/^\/api\/webdav-proxy\//);
  });

  it('iOS path: nativeHttpRequest=null falls through to web proxy', async () => {
    // Simulate iOS: nativeHttpRequest explicitly null, electronProxyFetch null
    const mockFetch = vi.fn().mockResolvedValue(mockResp(200));
    vi.stubGlobal('fetch', mockFetch);

    const fetch = webdavFetch({ ...BASE_ENGINE, nativeHttpRequest: null, electronProxyFetch: null });
    await fetch('GET', 'https://dav.host/f', {});

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('web path: body not sent for GET (no body arg)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResp(207));
    vi.stubGlobal('fetch', mockFetch);

    const fetch = webdavFetch(BASE_ENGINE);
    await fetch('PROPFIND', 'https://dav.host/dir', { 'X-WebDAV-Auth': 'Basic x' }, undefined, { Depth: '0' });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBeUndefined();
    expect(opts.headers).toMatchObject({ 'X-WebDAV-Auth': 'Basic x', Depth: '0' });
  });
});

// ─── URL / path construction ──────────────────────────────────────────────────

describe('URL and path construction', () => {
  it('Nextcloud getFileUrl uses appFolderName and syncFilename', () => {
    const p = createProviders(BASE_ENGINE);
    expect(p.nextcloud.getFileUrl({ ...USER_CFG, nextcloudUrl: 'https://nc.example.com' }))
      .toBe('https://nc.example.com/remote.php/dav/files/alice/myapp/myapp-sync.json');
  });

  it('Nextcloud getFileUrl strips trailing slash from nextcloudUrl', () => {
    const p = createProviders(BASE_ENGINE);
    expect(p.nextcloud.getFileUrl({ ...USER_CFG, nextcloudUrl: 'https://nc.example.com/' }))
      .toBe('https://nc.example.com/remote.php/dav/files/alice/myapp/myapp-sync.json');
  });

  it('Nextcloud getDirUrl ends with slash', () => {
    const p = createProviders(BASE_ENGINE);
    expect(p.nextcloud.getDirUrl({ ...USER_CFG, nextcloudUrl: 'https://nc.example.com' }))
      .toMatch(/\/$/);
  });

  it('Nextcloud getFileUrl percent-encodes username', () => {
    const p = createProviders(BASE_ENGINE);
    const url = p.nextcloud.getFileUrl({ ...USER_CFG, username: 'alice@example.com', nextcloudUrl: 'https://nc.example.com' });
    expect(url).toContain(encodeURIComponent('alice@example.com'));
  });

  it('Koofr getFileUrl uses appFolderName and syncFilename', () => {
    const p = createProviders(BASE_ENGINE);
    expect(p.koofr.getFileUrl())
      .toBe('https://app.koofr.net/dav/Koofr/myapp/myapp-sync.json');
  });

  it('Koofr getDirUrl ends with slash', () => {
    const p = createProviders(BASE_ENGINE);
    expect(p.koofr.getDirUrl()).toMatch(/\/$/);
  });

  it('Generic WebDAV getFileUrl uses appFolderName and syncFilename', () => {
    const p = createProviders(BASE_ENGINE);
    expect(p.webdav.getFileUrl({ ...USER_CFG, webdavUrl: 'https://dav.example.com' }))
      .toBe('https://dav.example.com/myapp/myapp-sync.json');
  });

  it('Generic WebDAV getFileUrl strips trailing slash from webdavUrl', () => {
    const p = createProviders(BASE_ENGINE);
    expect(p.webdav.getFileUrl({ ...USER_CFG, webdavUrl: 'https://dav.example.com/' }))
      .toBe('https://dav.example.com/myapp/myapp-sync.json');
  });
});

// ─── Auth headers ─────────────────────────────────────────────────────────────

describe('auth header encoding', () => {
  it('encodes username:password as Basic auth', () => {
    const p = createProviders(BASE_ENGINE);
    const h = p.nextcloud.getAuthHeaders({ username: 'user', appPassword: 'pass' });
    const decoded = atob(h['X-WebDAV-Auth'].replace('Basic ', ''));
    expect(decoded).toBe('user:pass');
  });

  it('handles multibyte characters in credentials without throwing', () => {
    const p = createProviders(BASE_ENGINE);
    // Emoji / CJK — toBase64 uses TextEncoder to avoid btoa codepoint limit
    expect(() => p.nextcloud.getAuthHeaders({ username: '用戶', appPassword: '密碼' })).not.toThrow();
  });
});

// ─── ETag normalization ───────────────────────────────────────────────────────

describe('normalizeEtag', () => {
  it('passes a plain strong etag through untouched', () => {
    expect(normalizeEtag('"abc123"')).toBe('"abc123"');
  });

  it('strips the weak-validator prefix', () => {
    expect(normalizeEtag('W/"abc123"')).toBe('"abc123"');
  });

  it('strips the Apache mod_deflate -gzip suffix', () => {
    expect(normalizeEtag('"abc123-gzip"')).toBe('"abc123"');
  });

  it('strips the Apache mod_brotli -br suffix', () => {
    expect(normalizeEtag('"abc123-br"')).toBe('"abc123"');
  });

  it('strips a combined weak prefix and -gzip suffix', () => {
    expect(normalizeEtag('W/"abc123-gzip"')).toBe('"abc123"');
  });

  it('passes null and undefined through unchanged', () => {
    expect(normalizeEtag(null)).toBe(null);
    expect(normalizeEtag(undefined)).toBe(undefined);
  });

  it('handles unquoted etag values', () => {
    expect(normalizeEtag('abc123')).toBe('abc123');
    expect(normalizeEtag('abc123-gzip')).toBe('abc123');
    expect(normalizeEtag('W/abc123')).toBe('abc123');
  });

  it('leaves etags that merely contain "gzip" or "br" untouched', () => {
    expect(normalizeEtag('"abcgzip"')).toBe('"abcgzip"');
    expect(normalizeEtag('"gzip-abc"')).toBe('"gzip-abc"');
    expect(normalizeEtag('"abc-gzipped"')).toBe('"abc-gzipped"');
    expect(normalizeEtag('"abr"')).toBe('"abr"');
  });

  it('is applied to etags captured from download responses', async () => {
    const nativeFn = vi.fn().mockReturnValue({
      status: 200, ok: true, body: '{}', headers: { etag: 'W/"v1-gzip"' }
    });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    const result = await p.webdav.download(USER_CFG);
    expect(result.etag).toBe('"v1"');
  });
});

// ─── Download behaviour ───────────────────────────────────────────────────────

describe('download', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null on 404', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 404, ok: false, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    const result = await p.nextcloud.download(USER_CFG);
    expect(result).toBeNull();
  });

  it('throws FORBIDDEN on 403', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 403, ok: false, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    await expect(p.nextcloud.download(USER_CFG)).rejects.toThrow('FORBIDDEN');
  });

  it('returns { payload, etag } on success', async () => {
    const data = { tasks: [{ id: '1' }] };
    const nativeFn = vi.fn().mockReturnValue({
      status: 200, ok: true, body: JSON.stringify(data), headers: { etag: '"v1"' }
    });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    const result = await p.nextcloud.download(USER_CFG);
    expect(result.payload).toEqual(data);
    expect(result.etag).toBe('"v1"');
  });

  it('returns etag=null when server omits ETag header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResp(200, { x: 1 }));
    vi.stubGlobal('fetch', mockFetch);
    const p = createProviders(BASE_ENGINE);
    const result = await p.webdav.download(USER_CFG);
    expect(result.etag).toBeNull();
  });
});

// ─── Upload behaviour ─────────────────────────────────────────────────────────

describe('upload', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends If-Match header when etag is provided', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 204, ok: true, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    await p.nextcloud.upload(USER_CFG, { tasks: [] }, '"etag123"');
    const headers = nativeFn.mock.calls[0][2];
    expect(headers['If-Match']).toBe('"etag123"');
  });

  it('omits If-Match when etag is null', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 201, ok: true, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    await p.nextcloud.upload(USER_CFG, { tasks: [] }, null);
    const headers = nativeFn.mock.calls[0][2];
    expect(headers['If-Match']).toBeUndefined();
  });

  it('throws FORBIDDEN on 403', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 403, ok: false, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    await expect(p.nextcloud.upload(USER_CFG, {})).rejects.toThrow('FORBIDDEN');
  });

  it('throws PRECONDITION_FAILED on 412', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 412, ok: false, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    await expect(p.nextcloud.upload(USER_CFG, {}, '"stale"')).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('returns true on success', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 201, ok: true, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    expect(await p.webdav.upload(USER_CFG, { tasks: [] })).toBe(true);
  });
});

// ─── Koofr: native-required behaviour ────────────────────────────────────────

describe('Koofr test — native-required 403 handling', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('on web hosted (nativeHttpRequest=null, isHostedApp=true): 403 returns "use Android app" message', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResp(403));
    vi.stubGlobal('fetch', mockFetch);
    const p = createProviders({ ...BASE_ENGINE, isHostedApp: true });
    const result = await p.koofr.test({ username: 'u', appPassword: 'p' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Android app/);
  });

  it('on web self-hosted (nativeHttpRequest=null, isHostedApp=false): 403 returns proxy-block message', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResp(403));
    vi.stubGlobal('fetch', mockFetch);
    const p = createProviders(BASE_ENGINE); // nativeHttpRequest: null, isHostedApp: undefined
    const result = await p.koofr.test({ username: 'u', appPassword: 'p' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/proxy/);
  });

  it('on Android (nativeHttpRequest present): 403 returns credential error message', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 403, ok: false, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    const result = await p.koofr.test({ username: 'u', appPassword: 'p' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/app password/);
    expect(result.error).not.toMatch(/Android app/);
  });

  it('Koofr test: 200 returns success', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 200, ok: true, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    expect(await p.koofr.test({ username: 'u', appPassword: 'p' })).toEqual({ success: true });
  });

  it('Koofr test: 401 returns credential error', async () => {
    const nativeFn = vi.fn().mockReturnValue({ status: 401, ok: false, body: '', headers: {} });
    const p = createProviders({ ...BASE_ENGINE, nativeHttpRequest: nativeFn });
    const result = await p.koofr.test({ username: 'u', appPassword: 'p' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/credentials/i);
  });
});

// ─── Provider metadata ────────────────────────────────────────────────────────

describe('provider metadata', () => {
  it('all three providers have name, configFields, helpText', () => {
    const p = createProviders(BASE_ENGINE);
    for (const key of ['nextcloud', 'koofr', 'webdav']) {
      expect(p[key].name).toBeTruthy();
      expect(Array.isArray(p[key].configFields)).toBe(true);
      expect(p[key].configFields.length).toBeGreaterThan(0);
      expect(p[key].helpText).toBeTruthy();
    }
  });
});
