import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface StaticServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

async function resolveFile(root: string, pathname: string): Promise<string | null> {
  let clean = pathname.replace(/\/+/gu, '/');
  if (clean.length > 1) clean = clean.replace(/\/+$/u, '');

  const relative = clean.replace(/^\/+/u, '');
  const candidates =
    clean === '/'
      ? ['index.html']
      : [relative, `${relative}.html`, `${relative}/index.html`];

  for (const candidate of candidates) {
    const full = path.resolve(root, candidate);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) continue;

    try {
      const info = await stat(full);
      if (info.isFile()) return full;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export async function createStaticServer(
  distDir: string,
  port = 0,
): Promise<StaticServer> {
  const root = path.resolve(distDir);

  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? '127.0.0.1'}`,
    );

    let pathname: string;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad request');
      return;
    }

    let file = await resolveFile(root, pathname);
    let status = 200;

    if (!file) {
      const notFound = path.join(root, '404.html');
      if (existsSync(notFound)) {
        file = notFound;
        status = 404;
      }
    }

    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const relative = path.relative(root, file).replace(/\\/gu, '/');
    const headers: Record<string, string> = {
      'Content-Type':
        MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    };

    if (relative === 'sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache';
    } else if (relative === 'manifest.json') {
      headers['Cache-Control'] = 'no-cache';
    } else if (
      relative.startsWith('_themes/') ||
      relative.startsWith('_astro/')
    ) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }

    const body = await readFile(file);
    response.writeHead(status, headers);
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const actualPort =
    address && typeof address === 'object' ? address.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.cwd();
  const distDir = path.join(root, 'dist');

  if (!existsSync(path.join(distDir, 'manifest.json'))) {
    console.error('dist/manifest.json is missing. Run `npm run build:all` first.');
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 8080);
  const server = await createStaticServer(distDir, port);
  console.log(`Serving ${distDir}`);
  console.log(`  ${server.url}`);

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
