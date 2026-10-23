import { describe, expect, it } from 'vitest';
import {
  contentTypeFor,
  toUrlPath,
  validateVfs,
  type Vfs,
} from '../core/vfs.ts';

function makeVfs(): Vfs {
  return {
    schema: 1,
    themeId: 'test',
    files: {
      '/': {
        type: 'text/html; charset=utf-8',
        body: '<link rel="stylesheet" href="/_astro/x.css"><script src="/_sys/sys.js"></script>',
      },
      '/404': { type: 'text/html; charset=utf-8', body: '' },
      '/n/hello': { type: 'text/html; charset=utf-8', body: '<a href="/n/hello">x</a>' },
      '/_astro/x.css': { type: 'text/css; charset=utf-8', body: '' },
      '/_sys/sys.js': { type: 'text/javascript; charset=utf-8', body: '' },
      '/search-index.json': { type: 'application/json; charset=utf-8', body: '' },
    },
  };
}

describe('toUrlPath', () => {
  it('maps index and node files to clean URLs', () => {
    expect(toUrlPath('index.html')).toBe('/');
    expect(toUrlPath('n/hello.html')).toBe('/n/hello');
    expect(toUrlPath('n/tech/pi.html')).toBe('/n/tech/pi');
    expect(toUrlPath('404.html')).toBe('/404');
    expect(toUrlPath('_astro/x.css')).toBe('/_astro/x.css');
  });

  it('encodes non-ASCII path segments', () => {
    expect(toUrlPath('n/你好.html')).toBe('/n/%E4%BD%A0%E5%A5%BD');
  });
});

describe('contentTypeFor', () => {
  it('returns UTF-8 content types', () => {
    expect(contentTypeFor('x.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.vfs.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('x.md')).toBe('text/markdown; charset=utf-8');
    expect(contentTypeFor('x.svg')).toBe('image/svg+xml');
  });
});

describe('validateVfs', () => {
  it('accepts a complete VFS', () => {
    expect(
      validateVfs(makeVfs(), { routes: ['/n/hello'], nodeIds: ['hello'] }),
    ).toBe(3);
  });

  it('rejects missing routes', () => {
    const vfs = makeVfs();
    delete vfs.files['/n/hello'];
    expect(() =>
      validateVfs(vfs, { routes: ['/n/hello'], nodeIds: ['hello'] }),
    ).toThrowError(/missing route/);
  });

  it('rejects missing local assets', () => {
    const vfs = makeVfs();
    delete vfs.files['/_astro/x.css'];
    expect(() =>
      validateVfs(vfs, { routes: ['/n/hello'], nodeIds: ['hello'] }),
    ).toThrowError(/missing asset/);
  });
});
