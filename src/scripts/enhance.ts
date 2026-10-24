import type { SearchDoc, SearchIndex } from '../generated/contract';
import type { RevisionItemData, RevisionPayload } from '../lib/revisions';

const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function makeEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function makeLink(url: string | null, text: string, className?: string): HTMLElement {
  const safe = safeUrl(url);
  if (!safe) return makeEl('span', className, text);

  const anchor = makeEl('a', className, text);
  anchor.href = safe;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

/* ---------------------------------------------------------------------------
 * Theme toggle
 * ------------------------------------------------------------------------- */

const LIGHT_THEME_COLOR = '#fbfaf7';
const DARK_THEME_COLOR = '#0a0a0c';

function applyThemeColor(dark: boolean): void {
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  const meta = makeEl('meta');
  meta.name = 'theme-color';
  meta.content = dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  document.head.append(meta);
}

function initThemeToggle(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;

  const root = document.documentElement;
  const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = (): boolean =>
    root.dataset.theme ? root.dataset.theme === 'dark' : systemDark();

  const sync = (): void => {
    const dark = isDark();
    button.dataset.mode = dark ? 'dark' : 'light';
    const label = dark ? '切换到亮色模式' : '切换到暗色模式';
    button.setAttribute('aria-label', label);
    button.title = label;
  };

  button.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    applyThemeColor(next === 'dark');
    sync();
  });

  sync();
  try {
    if (localStorage.getItem('theme')) applyThemeColor(isDark());
  } catch {}
}

/* ---------------------------------------------------------------------------
 * Back to top
 * ------------------------------------------------------------------------- */

function initBackToTop(): void {
  const link = document.querySelector<HTMLAnchorElement>('[data-back-to-top]');
  if (!link) return;

  link.addEventListener('click', (event) => {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
}

/* ---------------------------------------------------------------------------
 * Revision timeline
 * ------------------------------------------------------------------------- */

function makeVerifyDetails(item: RevisionItemData): HTMLElement | null {
  if (!item.anchor || !item.commitUrl || !item.blobUrl || !item.apiUrl) return null;

  const details = makeEl('details', 'revision-verify');
  details.append(makeEl('summary', undefined, '三步核验'));

  const list = makeEl('ol');

  const first = makeEl('li');
  first.append(
    document.createTextNode('链上：打开'),
    makeLink(item.anchor.txUrl, '交易'),
    document.createTextNode('，确认 '),
    makeEl('code', undefined, 'Anchored'),
    document.createTextNode(' 事件的 sender 与 commit。'),
  );

  const second = makeEl('li');
  second.append(
    document.createTextNode('GitHub：打开'),
    makeLink(item.commitUrl, `commit ${item.shortCommit}`),
    document.createTextNode('与'),
    makeLink(item.blobUrl, '这一版正文'),
    document.createTextNode('，确认内容一致。'),
  );

  const third = makeEl('li');
  third.append(
    document.createTextNode('比对：'),
    makeLink(item.apiUrl, 'GitHub API'),
    document.createTextNode('返回的 '),
    makeEl('code', undefined, 'sha'),
    document.createTextNode(' 应与上面的 '),
    makeEl('code', undefined, item.blobSha1),
    document.createTextNode(' 一致。'),
  );

  list.append(first, second, third);
  details.append(list);
  return details;
}

function makeRevisionItem(item: RevisionItemData): HTMLLIElement {
  const entry = makeEl('li', 'revision-item');

  const head = makeEl('div', 'revision-head');
  head.append(makeEl('span', 'revision-index', item.label));

  if (item.commitUrl) {
    head.append(makeLink(item.commitUrl, item.shortCommit, 'revision-commit'));
  } else {
    head.append(makeEl('code', undefined, '未提交'));
  }

  const time = makeEl('time', undefined, item.timeLabel);
  time.dateTime = item.dateTime;
  head.append(time);

  const changes = makeEl('span', 'revision-changes');
  changes.append(
    makeEl('span', 'diff-add', `+${item.additions}`),
    makeEl('span', 'diff-del', `−${item.deletions}`),
  );
  head.append(changes);
  entry.append(head);

  entry.append(makeEl('p', 'revision-message', item.message));

  if (item.blobSha1 && item.apiUrl) {
    const blob = makeEl('p', 'revision-blob');
    blob.append(
      document.createTextNode('blob SHA-1 '),
      makeEl('code', undefined, item.blobSha1),
      document.createTextNode(' '),
      makeLink(item.apiUrl, 'GitHub API ↗'),
    );
    entry.append(blob);
  }

  if (item.anchor) {
    const anchor = makeEl('p', 'revision-anchor');
    anchor.append(
      makeLink(item.anchor.txUrl, `交易 ${item.anchor.txShort} ↗`),
      makeLink(item.anchor.contractUrl, `合约 ${item.anchor.contractShort} ↗`),
      makeLink(item.anchor.senderUrl, `签名 ${item.anchor.senderShort} ↗`),
    );
    entry.append(anchor);

    const verify = makeVerifyDetails(item);
    if (verify) entry.append(verify);
  } else {
    entry.append(makeEl('p', 'revision-anchor', '未锚定'));
  }

  return entry;
}

function initRevisions(): void {
  document.querySelectorAll<HTMLElement>('[data-revisions]').forEach((details) => {
    const dataScript = details.querySelector<HTMLScriptElement>('[data-revision-data]');
    const log = details.querySelector<HTMLElement>('[data-revision-log]');
    const fallback = details.querySelector<HTMLElement>('[data-revision-fallback]');
    if (!dataScript || !log || !fallback) return;

    let payload: RevisionPayload;
    try {
      payload = JSON.parse(dataScript.textContent ?? '') as RevisionPayload;
    } catch {
      return;
    }

    if (payload.schema !== 1 || !Array.isArray(payload.revisions) || payload.revisions.length === 0) {
      return;
    }

    try {
      const list = makeEl('ol', 'revision-list');
      for (const item of payload.revisions) list.append(makeRevisionItem(item));
      log.replaceChildren(list);
      fallback.hidden = true;
      log.hidden = false;
    } catch {
      // Keep the server-rendered fallback when rendering fails.
    }
  });
}

/* ---------------------------------------------------------------------------
 * Search
 * ------------------------------------------------------------------------- */

let searchIndex: SearchIndex | null = null;
let searchIndexPromise: Promise<SearchIndex> | null = null;

function loadSearchIndex(): Promise<SearchIndex> {
  if (searchIndex) return Promise.resolve(searchIndex);
  searchIndexPromise ??= fetch('/search-index.json').then(async (response) => {
    if (!response.ok) throw new Error(`search index ${response.status}`);
    return (await response.json()) as SearchIndex;
  });

  return searchIndexPromise.then(
    (index) => {
      searchIndex = index;
      return index;
    },
    (error: unknown) => {
      searchIndexPromise = null;
      throw error;
    },
  );
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function makeSnippet(doc: SearchDoc, tokens: string[]): string {
  const text = doc.text;
  if (!text) return '';

  const lower = normalize(text);
  const positions = tokens
    .map((token) => lower.indexOf(token))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b);
  const first = positions[0];

  if (first === undefined) {
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }

  const start = Math.max(0, first - 30);
  const end = Math.min(text.length, first + 70);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function initSearch(): void {
  const openButton = document.querySelector<HTMLButtonElement>('[data-search-open]');
  const dialog = document.querySelector<HTMLDialogElement>('[data-search-dialog]');
  if (!openButton || !dialog || typeof dialog.showModal !== 'function') return;

  const closeButton = dialog.querySelector<HTMLButtonElement>('[data-search-close]');
  const input = dialog.querySelector<HTMLInputElement>('[data-search-input]');
  const status = dialog.querySelector<HTMLElement>('[data-search-status]');
  const results = dialog.querySelector<HTMLElement>('[data-search-results]');
  if (!closeButton || !input || !status || !results) return;

  openButton.hidden = false;

  const timezone = document.documentElement.dataset.timezone;
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  let timer: number | undefined;

  const renderResults = (index: SearchIndex, query: string): void => {
    const tokens = normalize(query).split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) {
      status.textContent = '输入关键词开始搜索';
      results.replaceChildren();
      return;
    }

    const matches: Array<{ doc: SearchDoc; score: number }> = [];
    for (const doc of index.docs) {
      const title = normalize(doc.title);
      const tags = normalize(doc.tags.join(' '));
      const body = normalize(doc.text);
      let score = 0;
      let matched = true;

      for (const token of tokens) {
        if (title.includes(token)) score += 3;
        else if (tags.includes(token)) score += 2;
        else if (body.includes(token)) score += 1;
        else {
          matched = false;
          break;
        }
      }

      if (matched) matches.push({ doc, score });
    }

    matches.sort((a, b) => b.score - a.score || b.doc.time - a.doc.time);
    const visible = matches.slice(0, 20);

    if (visible.length === 0) {
      status.textContent = '没有找到相关内容';
      results.replaceChildren();
      return;
    }

    status.textContent = `找到 ${matches.length} 条结果`;

    const list = makeEl('ul', 'search-result-list');
    for (const { doc } of visible) {
      const item = makeEl('li');
      const anchor = makeEl('a', 'search-result');
      anchor.href = doc.url;

      anchor.append(
        makeEl('span', 'search-result-title', doc.title),
        makeEl(
          'span',
          'search-result-meta',
          `${dateFormatter.format(new Date(doc.time * 1000))}${
            doc.tags.length > 0 ? ` · ${doc.tags.join(' / ')}` : ''
          }`,
        ),
        makeEl('span', 'search-result-excerpt', makeSnippet(doc, tokens)),
      );

      item.append(anchor);
      list.append(item);
    }

    results.replaceChildren(list);
  };

  const runSearch = async (): Promise<void> => {
    const query = input.value.trim();
    if (!query) {
      status.textContent = '输入关键词开始搜索';
      results.replaceChildren();
      return;
    }

    status.textContent = '正在载入索引…';
    try {
      const index = await loadSearchIndex();
      renderResults(index, query);
    } catch {
      status.textContent = '搜索索引加载失败';
      results.replaceChildren();
    }
  };

  const open = (): void => {
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.select();
    if (input.value.trim()) void runSearch();
  };

  const close = (): void => {
    if (dialog.open) dialog.close();
  };

  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', () => openButton.focus());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runSearch(), 120);
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key !== 'ArrowDown') return;
    const first = results.querySelector<HTMLAnchorElement>('a');
    if (!first) return;
    event.preventDefault();
    first.focus();
  });

  results.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape') return;
    if (event.key === 'Escape') {
      close();
      return;
    }

    const links = Array.from(results.querySelectorAll<HTMLAnchorElement>('a'));
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (current < 0) return;

    event.preventDefault();
    if (event.key === 'ArrowDown') {
      links[current + 1]?.focus();
    } else if (current === 0) {
      input.focus();
    } else {
      links[current - 1]?.focus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.matches('input, textarea, select') || target.isContentEditable)) return;

    const isSearchShortcut = event.key === '/';
    const isCommandShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
    if (!isSearchShortcut && !isCommandShortcut) return;
    if (event.altKey || event.shiftKey) return;

    event.preventDefault();
    open();
  });
}

/* ---------------------------------------------------------------------------
 * Code copy, tables, images
 * ------------------------------------------------------------------------- */

function initCodeCopy(): void {
  document.querySelectorAll<HTMLPreElement>('.prose pre').forEach((pre) => {
    if (pre.closest('.revision-diff')) return;
    if (pre.parentElement?.classList.contains('code-block')) return;

    const wrapper = makeEl('div', 'code-block');
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.append(pre);

    const button = makeEl('button', 'copy-code', '复制');
    button.type = 'button';
    button.setAttribute('aria-label', '复制代码');

    button.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      try {
        await navigator.clipboard.writeText(code.replace(/\n$/u, ''));
        button.textContent = '已复制';
      } catch {
        button.textContent = '复制失败';
      }
      window.setTimeout(() => {
        button.textContent = '复制';
      }, 1600);
    });

    wrapper.append(button);
  });
}

function initTables(): void {
  document.querySelectorAll<HTMLTableElement>('.prose table').forEach((table) => {
    if (table.parentElement?.classList.contains('table-wrap')) return;

    const wrapper = makeEl('div', 'table-wrap');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    const caption = table.querySelector('caption')?.textContent?.trim();
    wrapper.setAttribute('aria-label', caption ? `表格：${caption}` : '可横向滚动的表格');

    table.parentNode?.insertBefore(wrapper, table);
    wrapper.append(table);
  });
}

function initImages(): void {
  document.querySelectorAll<HTMLImageElement>('.prose img').forEach((image, index) => {
    if (index === 0) return;
    image.loading = 'lazy';
    image.decoding = 'async';
  });
}

/* ---------------------------------------------------------------------------
 * Tag filter
 * ------------------------------------------------------------------------- */

function initTagFilter(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tag]'));
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-filter-item]'));
  const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-year-group]'));
  if (buttons.length === 0) return;

  const empty = document.querySelector<HTMLElement>('[data-tag-empty]');
  const count = document.querySelector<HTMLElement>('[data-tag-count]');

  const readTag = (): string => {
    const params = new URLSearchParams(location.search);
    const value = params.get('tag') ?? '全部';
    return buttons.some((button) => button.dataset.tag === value) ? value : '全部';
  };

  const apply = (tag: string, updateUrl: boolean): void => {
    let visible = 0;

    for (const item of items) {
      const tags = (item.dataset.tags ?? '').split(/\s+/u).filter(Boolean);
      item.hidden = tag !== '全部' && !tags.includes(tag);
      if (!item.hidden) visible += 1;
    }

    for (const group of groups) {
      const hasVisible = Array.from(
        group.querySelectorAll<HTMLElement>('[data-filter-item]'),
      ).some((item) => !item.hidden);
      group.hidden = !hasVisible;
    }

    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.tag === tag));
    }

    if (empty) empty.hidden = visible !== 0;
    if (count) count.textContent = `显示 ${visible} 条`;

    if (updateUrl) {
      const url = new URL(location.href);
      if (tag === '全部') url.searchParams.delete('tag');
      else url.searchParams.set('tag', tag);
      history.pushState(null, '', url.toString());
    }
  };

  for (const button of buttons) {
    button.addEventListener('click', () => {
      apply(button.dataset.tag ?? '全部', true);
    });
  }

  window.addEventListener('popstate', () => {
    apply(readTag(), false);
  });

  apply(readTag(), false);
}

/* ---------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------- */

function init(): void {
  initThemeToggle();
  initBackToTop();
  initRevisions();
  initSearch();
  initCodeCopy();
  initTables();
  initImages();
  initTagFilter();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
