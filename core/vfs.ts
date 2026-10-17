export interface VfsFile {
  type: string;
  body: string;
}

export interface Vfs {
  schema: 1;
  themeId: string;
  files: Record<string, VfsFile>;
}

export const TEXT_EXTENSIONS = new Set([
  '.html',
  '.css',
  '.js',
  '.json',
  '.svg',
  '.xml',
  '.md',
  '.txt',
  '.webmanifest',
]);

export function encodePath(rel: string): string {
  return rel.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** Map a built file path to its canonical URL path. */
export function toUrlPath(rel: string): string {
  const posix = rel.replace(/\\/gu, '/');
  if (posix === 'index.html') return '/';
  if (posix.endsWith('/index.html')) {
    return `/${encodePath(posix.slice(0, -'/index.html'.length))}`;
  }
  if (posix.endsWith('.html')) {
    return `/${encodePath(posix.slice(0, -'.html'.length))}`;
  }
  return `/${encodePath(posix)}`;
}

export function contentTypeFor(rel: string): string {
  const dot = rel.lastIndexOf('.');
  const extension = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

export interface VfsExpectations {
  /** Node URLs, e.g. /n/hello. */
  routes: string[];
  /** Node ids, used to check raw/proof files. */
  nodeIds: string[];
}

/** Validate routes, shared files, and local asset references. */
export function validateVfs(vfs: Vfs, expectations: VfsExpectations): number {
  const expected = ['/', '/404', ...expectations.routes];

  for (const route of expected) {
    const file = vfs.files[route];
    if (!file) throw new Error(`Theme ${vfs.themeId}: VFS is missing route ${route}.`);
    if (!file.type.startsWith('text/html')) {
      throw new Error(`Theme ${vfs.themeId}: route ${route} is not HTML.`);
    }
  }

  for (const id of expectations.nodeIds) {
    if (!vfs.files[`/raw/${encodePath(id)}.md`]) {
      throw new Error(`Theme ${vfs.themeId}: VFS is missing raw/${id}.md.`);
    }
    if (!vfs.files[`/proof/${encodePath(id)}.json`]) {
      throw new Error(`Theme ${vfs.themeId}: VFS is missing proof/${id}.json.`);
    }
  }

  if (!vfs.files['/search-index.json']) {
    throw new Error(`Theme ${vfs.themeId}: VFS is missing search-index.json.`);
  }

  const assetPattern = /(?:src|href)="(\/_(?:astro|sys)\/[^"]+)"/gu;
  for (const [url, file] of Object.entries(vfs.files)) {
    if (!file.type.startsWith('text/html')) continue;
    for (const match of file.body.matchAll(assetPattern)) {
      const asset = match[1];
      if (asset && !vfs.files[asset]) {
        throw new Error(
          `Theme ${vfs.themeId}: ${url} references missing asset ${asset}.`,
        );
      }
    }
  }

  return expected.length;
}
