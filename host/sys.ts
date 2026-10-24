/**
 * Host runtime for every theme.
 *
 * Registers <sys-theme-dock>, a small floating theme museum. It talks to the
 * Service Worker over a MessageChannel and never touches theme internals.
 */

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

interface StateResponse {
  type: 'STATE';
  activeThemeId: string;
  activeReleaseId: string;
  themes: ManifestTheme[];
  cachedThemes: string[];
  updateReady: boolean;
  defaultTheme: string;
}

interface ThemeResponse {
  ok: boolean;
  error?: string;
}

const STYLE = `
  :host {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 2147483647;
    font-family: var(--sys-font, ui-monospace, "SFMono-Regular", Consolas, monospace);
    font-size: 12px;
    line-height: 1.5;
    color: var(--sys-fg, CanvasText);
    contain: layout style;
  }

  :host([hidden]) { display: none; }

  .dock { position: relative; }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    border: 1px solid var(--sys-border, rgba(128, 128, 128, .35));
    border-radius: 999px;
    background: var(--sys-bg, Canvas);
    color: inherit;
    padding: .35rem .7rem;
    font: inherit;
    cursor: pointer;
    box-shadow: 0 2px 10px rgb(0 0 0 / .08);
  }

  .trigger:hover { border-color: var(--sys-fg, CanvasText); }
  .dot { width: .45rem; height: .45rem; border-radius: 999px; background: currentColor; opacity: .55; }
  .dot[data-ready="true"] { opacity: 1; }

  .panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + .5rem);
    width: min(22rem, calc(100vw - 2rem));
    max-height: 60vh;
    overflow: auto;
    padding: .45rem;
    border: 1px solid var(--sys-border, rgba(128, 128, 128, .35));
    border-radius: .65rem;
    background: var(--sys-bg, Canvas);
    box-shadow: 0 14px 44px rgb(0 0 0 / .18);
  }

  .panel[hidden] { display: none; }

  .head {
    padding: .25rem .4rem .45rem;
    color: var(--sys-muted, GrayText);
    font-size: .72rem;
    letter-spacing: .06em;
    text-transform: uppercase;
  }

  .list { display: flex; flex-direction: column; gap: .1rem; }

  .theme {
    display: block;
    width: 100%;
    border: 0;
    border-radius: .4rem;
    background: transparent;
    color: inherit;
    padding: .45rem .5rem;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .theme:hover { background: color-mix(in oklab, var(--sys-fg, CanvasText) 8%, transparent); }
  .theme[data-active="true"] { background: color-mix(in oklab, var(--sys-fg, CanvasText) 12%, transparent); }
  .theme:disabled { cursor: default; opacity: .55; }

  .row { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
  .name { font-weight: 600; }
  .model, .meta { color: var(--sys-muted, GrayText); font-size: .78em; }
  .badge {
    display: inline-block;
    margin-left: .25rem;
    padding: 0 .3rem;
    border: 1px solid var(--sys-border, rgba(128, 128, 128, .35));
    border-radius: 999px;
    color: var(--sys-muted, GrayText);
    font-size: .68rem;
    line-height: 1.5;
  }

  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: .5rem;
    margin-top: .35rem;
    padding: .45rem .4rem 0;
    border-top: 1px solid var(--sys-border, rgba(128, 128, 128, .35));
    color: var(--sys-muted, GrayText);
    font-size: .72rem;
  }

  .refresh {
    border: 1px solid var(--sys-border, rgba(128, 128, 128, .35));
    border-radius: .3rem;
    background: transparent;
    color: inherit;
    padding: .1rem .4rem;
    font: inherit;
    cursor: pointer;
  }

  .refresh:hover { border-color: var(--sys-fg, CanvasText); }
`;

async function loadManifest(): Promise<Manifest | null> {
  try {
    const response = await fetch('/manifest.json', { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as Manifest;
  } catch {
    return null;
  }
}

function request<T>(
  type: string,
  payload: Record<string, unknown> = {},
  timeout = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      reject(new Error('service worker is not controlling this page'));
      return;
    }

    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error('service worker timeout'));
    }, timeout);

    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      channel.port1.close();
      resolve(event.data as T);
    };

    controller.postMessage({ type, ...payload }, [channel.port2]);
  });
}

class ThemeDock extends HTMLElement {
  private readonly root: ShadowRoot;
  private button!: HTMLButtonElement;
  private panel!: HTMLDivElement;
  private list!: HTMLDivElement;
  private status!: HTMLDivElement;
  private state: StateResponse | null = null;
  private loading = false;
  private cacheResetNotice = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.renderShell();
    this.button.addEventListener('click', () => this.toggle());
    document.addEventListener('keydown', this.onKeydown);
    document.addEventListener('click', this.onDocumentClick);
    navigator.serviceWorker?.addEventListener('controllerchange', this.onControllerChange);
    navigator.serviceWorker?.addEventListener('message', this.onMessage);
    void this.refresh();
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('click', this.onDocumentClick);
    navigator.serviceWorker?.removeEventListener('controllerchange', this.onControllerChange);
    navigator.serviceWorker?.removeEventListener('message', this.onMessage);
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.panel.hidden = true;
  };

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (!event.composedPath().includes(this)) this.panel.hidden = true;
  };

  private readonly onControllerChange = (): void => {
    void this.refresh();
  };

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.data?.type === 'UPDATE_READY') {
      if (this.state) this.state.updateReady = true;
      this.updateStatus();
    }

    if (event.data?.type === 'CACHE_RESET') {
      this.showCacheReset();
    }
  };

  private renderShell(): void {
    this.root.innerHTML = `
      <style>${STYLE}</style>
      <div class="dock">
        <button class="trigger" type="button" aria-haspopup="true" aria-expanded="false">
          <span class="dot" data-ready="false"></span>
          <span>Themes</span>
        </button>
        <div class="panel" role="dialog" aria-label="主题选择" hidden>
          <div class="head">Theme museum</div>
          <div class="list"></div>
          <div class="status"></div>
        </div>
      </div>
    `;

    this.button = this.root.querySelector('.trigger') as HTMLButtonElement;
    this.panel = this.root.querySelector('.panel') as HTMLDivElement;
    this.list = this.root.querySelector('.list') as HTMLDivElement;
    this.status = this.root.querySelector('.status') as HTMLDivElement;
  }

  private toggle(): void {
    this.panel.hidden = !this.panel.hidden;
    this.button.setAttribute('aria-expanded', String(!this.panel.hidden));
  }

  private async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      let state: StateResponse | null = null;

      if (navigator.serviceWorker?.controller) {
        try {
          state = await request<StateResponse>('GET_STATE');
        } catch {
          state = null;
        }
      }

      if (!state) {
        const manifest = await loadManifest();
        if (manifest) {
          state = {
            type: 'STATE',
            activeThemeId: manifest.defaultTheme,
            activeReleaseId: '',
            themes: manifest.themes,
            cachedThemes: [],
            updateReady: false,
            defaultTheme: manifest.defaultTheme,
          };
        }
      }

      if (!state) {
        this.setStatus('无法读取主题清单');
        return;
      }

      this.state = state;
      this.dataset.activeTheme = state.activeThemeId;
      this.renderThemes();
      this.updateStatus();
    } finally {
      this.loading = false;
    }
  }

  private renderThemes(): void {
    this.list.replaceChildren();
    if (!this.state) return;

    for (const theme of this.state.themes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme';
      button.dataset.active = String(theme.id === this.state.activeThemeId);
      button.disabled = !navigator.serviceWorker?.controller;

      const row = document.createElement('span');
      row.className = 'row';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = theme.displayName;
      row.append(name);

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = theme.commit ? theme.commit.slice(0, 7) : theme.id;
      row.append(meta);

      button.append(row);

      const model = document.createElement('span');
      model.className = 'model';
      model.textContent = theme.model || 'unknown model';
      button.append(document.createElement('br'), model);

      if (theme.isDefault) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'default';
        button.append(badge);
      }

      if (this.state.cachedThemes.includes(theme.id)) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'cached';
        button.append(badge);
      }

      button.addEventListener('click', () => {
        void this.selectTheme(theme.id);
      });

      this.list.append(button);
    }
  }

  private async selectTheme(themeId: string): Promise<void> {
    if (!navigator.serviceWorker?.controller) {
      this.setStatus('需要 Service Worker 才能切换主题');
      return;
    }

    if (themeId === this.state?.activeThemeId) {
      this.setStatus('已是当前主题');
      return;
    }

    this.setStatus('正在切换…');
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.theme')) {
      button.disabled = true;
    }

    try {
      const result = await request<ThemeResponse>('SET_THEME', { themeId }, 30_000);
      if (result.ok) {
        location.reload();
      } else {
        this.setStatus(`切换失败：${result.error ?? 'unknown error'}`);
        this.renderThemes();
      }
    } catch (error) {
      this.setStatus(`切换失败：${error instanceof Error ? error.message : String(error)}`);
      this.renderThemes();
    }
  }

  private updateStatus(message?: string): void {
    if (this.cacheResetNotice) {
      this.showCacheReset();
      return;
    }

    if (!this.state) return;

    this.status.replaceChildren();

    const text = document.createElement('span');
    if (message) {
      text.textContent = message;
    } else if (!navigator.serviceWorker?.controller) {
      text.textContent = '首次访问：刷新后启用主题切换';
    } else if (this.state.updateReady) {
      text.textContent = '有新内容，刷新后生效';
    } else if (this.state.cachedThemes.length > 0) {
      text.textContent = `已缓存 ${this.state.cachedThemes.length} 个主题 · ${this.state.activeReleaseId.slice(0, 8)}`;
    } else {
      text.textContent = '等待离线缓存';
    }

    this.status.append(text);

    if (this.state.updateReady) {
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'refresh';
      refresh.textContent = '刷新';
      refresh.addEventListener('click', () => location.reload());
      this.status.append(refresh);
    }

    if (navigator.serviceWorker?.controller) {
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'refresh';
      check.textContent = '检查';
      check.addEventListener('click', () => {
        void this.checkForUpdate();
      });
      this.status.append(check);
    }

    const dot = this.root.querySelector('.dot');
    if (dot) {
      dot.setAttribute(
        'data-ready',
        String(Boolean(navigator.serviceWorker?.controller && this.state.cachedThemes.length > 0)),
      );
    }
  }

  private async checkForUpdate(): Promise<void> {
    if (!navigator.serviceWorker?.controller) {
      this.setStatus('需要 Service Worker');
      return;
    }

    this.setStatus('正在检查更新…');
    try {
      const result = await request<{ ok: boolean; error?: string }>(
        'CHECK_UPDATE',
        {},
        15_000,
      );
      if (!result.ok) {
        this.updateStatus(`检查失败：${result.error ?? 'unknown error'}`);
        return;
      }

      await this.refresh();
      this.updateStatus(
        this.state?.updateReady ? '有新内容，刷新后生效' : '已是最新',
      );
    } catch (error) {
      this.updateStatus(
        `检查失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private showCacheReset(): void {
    this.cacheResetNotice = true;
    this.status.replaceChildren();

    const text = document.createElement('span');
    text.textContent = '缓存已重置，刷新后生效';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'refresh';
    refresh.textContent = '刷新';
    refresh.addEventListener('click', () => location.reload());

    this.status.append(text, refresh);
  }

  private setStatus(message: string): void {
    this.status.replaceChildren();
    const text = document.createElement('span');
    text.textContent = message;
    this.status.append(text);
  }
}

/**
 * Register the worker and keep it fresh without asking visitors to do
 * anything. `registration.update()` re-checks sw.js; SOFT_CHECK lets the
 * worker fetch a new manifest, but still respects its own TTL.
 */
async function setupUpdates(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });

    const softCheck = async (): Promise<void> => {
      try {
        await registration.update();
      } catch {
        // The network may be offline; the worker will retry later.
      }

      if (!navigator.serviceWorker.controller) return;
      try {
        await request('SOFT_CHECK', {}, 10_000);
      } catch {
        // The worker may be activating; the next visibility change retries.
      }
    };

    void softCheck();

    let lastVisibilityCheck = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      if (now - lastVisibilityCheck < 5 * 60_000) return;
      lastVisibilityCheck = now;
      void softCheck();
    });
  } catch (error) {
    console.warn('[sys] service worker registration failed', error);
  }
}

void setupUpdates();

if (!customElements.get('sys-theme-dock')) {
  customElements.define('sys-theme-dock', ThemeDock);
}

export {};
