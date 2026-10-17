/**
 * Service Worker: VFS cache, transparent theme switching, and lazy updates.
 *
 * The server always returns the default theme. Once this worker is active it
 * serves navigations and same-origin assets from the active theme's VFS.
 */

declare const __SW_CHECK_INTERVAL_MS__: number;
declare const __SW_BUILD__: string;

const sw = self as unknown as ServiceWorkerGlobalScope;

const DB_NAME = 'myblog-sw';
const DB_VERSION = 1;
const STORE = 'meta';
const STATE_KEY = 'state';
const VFS_PREFIX = 'myblog-vfs-v1:';
const MEDIA_CACHE = 'myblog-media-v1';
const CHECK_INTERVAL_MS = __SW_CHECK_INTERVAL_MS__;
const SW_BUILD = __SW_BUILD__;

interface ManifestTheme {
  id: string;
  displayName: string;
  model: string;
  description: string;
  isDefault: boolean;
  commit: string;
  updatedAt: string;
  vfsUrl: string;
  vfsSha256: string;
  sizeKB: number;
}

interface Manifest {
  schema: 1;
  releaseId: string;
  contentHash: string;
  anchorsHash: string;
  generatedAt: string;
  defaultTheme: string;
  themes: ManifestTheme[];
}

interface State {
  activeThemeId: string;
  activeReleaseId: string;
  previousReleaseId?: string;
  manifest: Manifest | null;
  lastCheckAt: number;
  updateReady: boolean;
  pendingReleaseId?: string;
  pendingThemeId?: string;
  pendingManifest?: Manifest | null;
}

interface VfsFile {
  type: string;
  body: string;
}

interface Vfs {
  schema: 1;
  themeId: string;
  files: Record<string, VfsFile>;
}

interface StateResponse {
  type: 'STATE';
  activeThemeId: string;
  activeReleaseId: string;
  themes: ManifestTheme[];
  cachedThemes: string[];
  updateReady: boolean;
  defaultTheme: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
const inflightVfs = new Map<string, Promise<void>>();

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function readState(): Promise<State | null> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(STATE_KEY);
    request.onsuccess = () => resolve((request.result as State | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function writeState(state: State): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(state, STATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function cacheName(releaseId: string, themeId: string): string {
  return `${VFS_PREFIX}${releaseId}:${themeId}`;
}

async function fetchManifest(): Promise<Manifest> {
  const response = await fetch('/manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`manifest ${response.status}`);
  return (await response.json()) as Manifest;
}

async function fetchVfs(manifest: Manifest, themeId: string): Promise<Vfs> {
  const theme = manifest.themes.find((entry) => entry.id === themeId);
  if (!theme) throw new Error(`theme ${themeId} is not in the manifest`);

  const response = await fetch(theme.vfsUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`vfs ${response.status}`);

  const text = await response.text();
  const hash = await sha256Hex(text);
  if (hash !== theme.vfsSha256) throw new Error('vfs hash mismatch');

  const vfs = JSON.parse(text) as Vfs;
  if (vfs.schema !== 1 || vfs.themeId !== themeId) {
    throw new Error('vfs schema or theme mismatch');
  }

  return vfs;
}

async function cacheVfs(manifest: Manifest, themeId: string, vfs: Vfs): Promise<void> {
  const name = cacheName(manifest.releaseId, themeId);
  await caches.delete(name);
  const cache = await caches.open(name);

  await Promise.all(
    Object.entries(vfs.files).map(([path, file]) => {
      const url = new URL(path, sw.location.origin).toString();
      return cache.put(
        new Request(url),
        new Response(file.body, {
          headers: {
            'Content-Type': file.type,
            'X-Content-Type-Options': 'nosniff',
          },
        }),
      );
    }),
  );
}

async function hasCachedVfs(releaseId: string, themeId: string): Promise<boolean> {
  const cache = await caches.open(cacheName(releaseId, themeId));
  const root = await cache.match(new Request(new URL('/', sw.location.origin).toString()));
  return Boolean(root);
}

async function ensureVfs(manifest: Manifest, themeId: string): Promise<void> {
  const key = `${manifest.releaseId}:${themeId}`;
  if (await hasCachedVfs(manifest.releaseId, themeId)) return;

  const existing = inflightVfs.get(key);
  if (existing) return existing;

  const task = (async () => {
    const vfs = await fetchVfs(manifest, themeId);
    await cacheVfs(manifest, themeId, vfs);
  })();

  inflightVfs.set(key, task);
  try {
    await task;
  } finally {
    inflightVfs.delete(key);
  }
}

async function cleanupOldReleases(...keepReleaseIds: Array<string | undefined>): Promise<void> {
  const keep = new Set(keepReleaseIds.filter((value): value is string => Boolean(value)));
  for (const name of await caches.keys()) {
    if (!name.startsWith(VFS_PREFIX)) continue;
    const releaseId = name.slice(VFS_PREFIX.length).split(':')[0] ?? '';
    if (!keep.has(releaseId)) await caches.delete(name);
  }
}

async function listCachedThemes(releaseId: string): Promise<string[]> {
  const prefix = `${VFS_PREFIX}${releaseId}:`;
  const names = await caches.keys();
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
}

async function initialize(): Promise<void> {
  const previous = await readState();
  const manifest = await fetchManifest();
  const themeId =
    previous && manifest.themes.some((theme) => theme.id === previous.activeThemeId)
      ? previous.activeThemeId
      : manifest.defaultTheme;

  const state: State = {
    activeThemeId: themeId,
    activeReleaseId: manifest.releaseId,
    previousReleaseId: previous?.activeReleaseId,
    manifest,
    lastCheckAt: Date.now(),
    updateReady: Boolean(
      previous?.activeReleaseId &&
        previous.activeReleaseId !== manifest.releaseId,
    ),
  };

  await writeState(state);

  try {
    await ensureVfs(manifest, themeId);
  } catch (error) {
    console.warn('[sw] failed to cache the active theme', error);
  }

  if (manifest.defaultTheme !== themeId) {
    try {
      await ensureVfs(manifest, manifest.defaultTheme);
    } catch (error) {
      console.warn('[sw] failed to cache the default theme', error);
    }
  }

  await cleanupOldReleases(manifest.releaseId, previous?.activeReleaseId);
}

function canonicalPath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/gu, '/');
  if (path.length > 1) path = path.replace(/\/+$/u, '');
  if (path === '/index.html') return '/';
  if (path.endsWith('/index.html')) return path.slice(0, -'/index.html'.length) || '/';
  if (path.endsWith('.html')) path = path.slice(0, -'.html'.length);
  return path || '/';
}

async function matchVfs(
  releaseId: string,
  themeId: string,
  path: string,
): Promise<Response | null> {
  if (!releaseId || !themeId) return null;
  const cache = await caches.open(cacheName(releaseId, themeId));
  const url = new URL(path, sw.location.origin).toString();
  const direct = await cache.match(new Request(url));
  if (direct) return direct;

  const alias = path === '/' ? '/index.html' : `${path}/index.html`;
  return (await cache.match(new Request(new URL(alias, sw.location.origin).toString()))) ?? null;
}

async function promotePending(state: State): Promise<State> {
  if (!state.pendingReleaseId) return state;

  const next: State = {
    ...state,
    activeReleaseId: state.pendingReleaseId,
    previousReleaseId: state.activeReleaseId,
    activeThemeId: state.pendingThemeId ?? state.activeThemeId,
    manifest: state.pendingManifest ?? state.manifest,
    updateReady: false,
    pendingReleaseId: undefined,
    pendingThemeId: undefined,
    pendingManifest: null,
  };

  await writeState(next);
  return next;
}

async function handleNavigation(request: Request): Promise<Response> {
  let state = await readState();

  if (state?.pendingReleaseId) {
    state = await promotePending(state);
  } else if (state?.updateReady) {
    // The new worker already made this release active. The next navigation
    // (for example the dock's refresh button) consumes the notice.
    state = { ...state, updateReady: false };
    await writeState(state);
  }

  if (state?.activeReleaseId) {
    const path = canonicalPath(new URL(request.url).pathname);
    const active = await matchVfs(state.activeReleaseId, state.activeThemeId, path);
    if (active) return active;

    if (state.previousReleaseId) {
      const previous = await matchVfs(
        state.previousReleaseId,
        state.activeThemeId,
        path,
      );
      if (previous) return previous;
    }

    const defaultTheme = state.manifest?.defaultTheme;
    if (defaultTheme && defaultTheme !== state.activeThemeId) {
      const fallback = await matchVfs(state.activeReleaseId, defaultTheme, path);
      if (fallback) return fallback;
    }

    const notFound = await matchVfs(state.activeReleaseId, state.activeThemeId, '/404');
    if (notFound) {
      return new Response(notFound.body, {
        status: 404,
        headers: notFound.headers,
      });
    }
  }

  try {
    return await fetch(request);
  } catch {
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function serveAsset(path: string, request: Request): Promise<Response> {
  const state = await readState();

  if (state?.activeReleaseId) {
    const active = await matchVfs(state.activeReleaseId, state.activeThemeId, path);
    if (active) return active;

    if (state.previousReleaseId) {
      const previous = await matchVfs(
        state.previousReleaseId,
        state.activeThemeId,
        path,
      );
      if (previous) return previous;
    }

    const defaultTheme = state.manifest?.defaultTheme;
    if (defaultTheme && defaultTheme !== state.activeThemeId) {
      const fallback = await matchVfs(state.activeReleaseId, defaultTheme, path);
      if (fallback) return fallback;
    }
  }

  try {
    return await fetch(request);
  } catch {
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function notify(message: unknown): Promise<void> {
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

async function checkForUpdate(force = false): Promise<void> {
  const state = await readState();
  if (!state?.manifest) return;

  const now = Date.now();
  if (!force && now - state.lastCheckAt < CHECK_INTERVAL_MS) return;

  await writeState({ ...state, lastCheckAt: now });

  try {
    const manifest = await fetchManifest();
    if (manifest.releaseId === state.activeReleaseId) {
      await writeState({ ...state, manifest, lastCheckAt: now });
      return;
    }

    const themeId = manifest.themes.some((theme) => theme.id === state.activeThemeId)
      ? state.activeThemeId
      : manifest.defaultTheme;

    await ensureVfs(manifest, themeId);

    await writeState({
      ...state,
      lastCheckAt: now,
      updateReady: true,
      pendingReleaseId: manifest.releaseId,
      pendingThemeId: themeId,
      pendingManifest: manifest,
    });

    await cleanupOldReleases(state.activeReleaseId, manifest.releaseId);
    await notify({ type: 'UPDATE_READY', releaseId: manifest.releaseId });
  } catch (error) {
    console.warn('[sw] update check failed', error);
  }
}

async function maybeCheckForUpdate(): Promise<void> {
  await checkForUpdate(false);
}

async function selectTheme(themeId: string): Promise<{ ok: boolean; error?: string }> {
  const state = await readState();
  if (!state?.manifest) return { ok: false, error: 'manifest is not available' };

  if (!state.manifest.themes.some((theme) => theme.id === themeId)) {
    return { ok: false, error: `theme ${themeId} is not in the manifest` };
  }

  try {
    await ensureVfs(state.manifest, themeId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await writeState({
    ...state,
    activeThemeId: themeId,
    updateReady: false,
    pendingReleaseId: undefined,
    pendingThemeId: undefined,
    pendingManifest: null,
  });

  return { ok: true };
}

async function getState(): Promise<StateResponse> {
  const state = await readState();

  if (!state?.manifest) {
    try {
      const manifest = await fetchManifest();
      return {
        type: 'STATE',
        activeThemeId: manifest.defaultTheme,
        activeReleaseId: '',
        themes: manifest.themes,
        cachedThemes: [],
        updateReady: false,
        defaultTheme: manifest.defaultTheme,
      };
    } catch {
      return {
        type: 'STATE',
        activeThemeId: '',
        activeReleaseId: '',
        themes: [],
        cachedThemes: [],
        updateReady: false,
        defaultTheme: '',
      };
    }
  }

  return {
    type: 'STATE',
    activeThemeId: state.activeThemeId,
    activeReleaseId: state.activeReleaseId,
    themes: state.manifest.themes,
    cachedThemes: await listCachedThemes(state.activeReleaseId),
    updateReady: state.updateReady,
    defaultTheme: state.manifest.defaultTheme,
  };
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      console.info(
        `[sw] build ${SW_BUILD}; update check interval ${CHECK_INTERVAL_MS}ms`,
      );
      try {
        await initialize();
      } catch (error) {
        console.warn('[sw] install failed', error);
      }
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (
    url.pathname === '/sw.js' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/_themes/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    event.waitUntil(maybeCheckForUpdate());
    return;
  }

  event.respondWith(serveAsset(url.pathname, request));
});

sw.addEventListener('message', (event) => {
  const port = event.ports[0];
  const data = event.data as { type?: string; themeId?: string } | undefined;
  if (!data?.type) return;

  const respond = (payload: unknown): void => {
    port?.postMessage(payload);
  };

  if (data.type === 'GET_STATE') {
    event.waitUntil(
      getState()
        .then(respond)
        .catch((error) => respond({ type: 'ERROR', message: String(error) })),
    );
    return;
  }

  if (data.type === 'SET_THEME' && data.themeId) {
    event.waitUntil(
      selectTheme(data.themeId)
        .then(respond)
        .catch((error) => respond({ ok: false, error: String(error) })),
    );
    return;
  }

  if (data.type === 'CHECK_UPDATE') {
    event.waitUntil(
      checkForUpdate(true)
        .then(() => respond({ ok: true }))
        .catch((error) => respond({ ok: false, error: String(error) })),
    );
    return;
  }

  if (data.type === 'SOFT_CHECK') {
    event.waitUntil(
      checkForUpdate(false)
        .then(() => respond({ ok: true }))
        .catch((error) => respond({ ok: false, error: String(error) })),
    );
    return;
  }

  if (data.type === 'APPLY_UPDATE') {
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (state?.pendingReleaseId) await promotePending(state);
        respond({ ok: true });
      })().catch((error) => respond({ ok: false, error: String(error) })),
    );
  }
});

// Keep the media cache name referenced for future R2 integration.
void MEDIA_CACHE;
