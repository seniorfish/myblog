import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compileSite } from '../core/build.ts';
import { loadSiteConfig } from '../core/config.ts';
import type { BuildMeta, SiteConfig, SiteData } from '../core/contract.ts';
import { sha256Hex } from '../core/hash.ts';
import {
  TEXT_EXTENSIONS,
  contentTypeFor,
  encodePath,
  toUrlPath,
  validateVfs,
  type Vfs,
  type VfsFile,
} from '../core/vfs.ts';
import { buildRuntime, type RuntimePaths } from './build-runtime.ts';
import { prepareTheme, type PreparedTheme } from './prepare-theme.ts';

interface ThemeBranch {
  id: string;
  ref: string;
  local: boolean;
}

interface BuiltTheme {
  id: string;
  prepared: PreparedTheme;
  distDir: string;
  vfsText: string;
  vfsSha256: string;
  vfsBytes: number;
  routeCount: number;
}

interface ManifestTheme {
  id: string;
  displayName: string;
  model: string;
  description: string;
  author: string;
  isDefault: boolean;
  commit: string;
  updatedAt: string;
  vfsUrl: string;
  vfsSha256: string;
  sizeKB: number;
}

const MAX_VFS_BYTES = 25 * 1024 * 1024;
const WARN_VFS_BYTES = 5 * 1024 * 1024;

const HEADERS = `/*
  Cache-Control: public, max-age=0, must-revalidate

/manifest.json
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /

/_themes/*
  Cache-Control: public, max-age=31536000, immutable

/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/_sys/sys.js
  Cache-Control: no-cache

/raw/*
  Cache-Control: no-cache
  X-Content-Type-Options: nosniff

/proof/*
  Cache-Control: public, max-age=300
`;

function gitOutput(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function printIssues(result: Awaited<ReturnType<typeof compileSite>>): void {
  for (const issue of result.issues) {
    const level = issue.level === 'error' ? 'ERROR' : 'WARN';
    const location = issue.file ? ` ${issue.file}` : '';
    const field = issue.field ? ` [${issue.field}]` : '';
    console.error(`${level}${location}${field}: ${issue.message}`);
    if (issue.suggestion) console.error(`  ${issue.suggestion}`);
  }
  for (const warning of result.buildMeta?.warnings ?? []) {
    console.warn(`WARN: ${warning}`);
  }
}

function discoverThemes(root: string): ThemeBranch[] {
  const output = gitOutput(root, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/theme',
    'refs/remotes/origin/theme',
  ]);

  const themes = new Map<string, ThemeBranch>();
  for (const raw of output.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const isRemote = raw.startsWith('origin/');
    const id = raw.replace(/^origin\//u, '').replace(/^theme\//u, '');
    if (!id) continue;

    const existing = themes.get(id);
    if (!existing || (!isRemote && !existing.local)) {
      themes.set(id, { id, ref: raw, local: !isRemote });
    }
  }

  return [...themes.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function walkFiles(dir: string, base = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }

  return files;
}

async function injectRuntime(distDir: string, runtime: RuntimePaths): Promise<void> {
  const files = (await walkFiles(distDir)).filter((rel) => rel.endsWith('.html'));

  for (const rel of files) {
    const absPath = path.join(distDir, rel);
    let html = await readFile(absPath, 'utf8');

    if (!html.includes('/_sys/sys.js')) {
      html = html.replace(
        '</head>',
        '<script type="module" src="/_sys/sys.js"></script></head>',
      );
    }
    if (!html.includes('<sys-theme-dock')) {
      html = html.replace('</body>', '<sys-theme-dock></sys-theme-dock></body>');
    }

    await writeFile(absPath, html, 'utf8');
  }

  await mkdir(path.join(distDir, '_sys'), { recursive: true });
  await cp(runtime.sysJs, path.join(distDir, '_sys', 'sys.js'));
}

async function buildTheme(
  root: string,
  branch: ThemeBranch,
  runtime: RuntimePaths,
): Promise<{ prepared: PreparedTheme; distDir: string }> {
  const prepared = prepareTheme(root, branch.id, branch.ref);
  console.log(`\nBuilding theme ${branch.id} (${branch.ref})...`);

  const result = spawnSync('npm', ['run', 'build'], {
    cwd: prepared.dir,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...prepared.env },
  });

  if (result.status !== 0) {
    throw new Error(`Theme ${branch.id} build failed with status ${result.status}.`);
  }

  const distDir = path.join(prepared.dir, 'dist');
  await injectRuntime(distDir, runtime);
  return { prepared, distDir };
}

async function collectVfsFiles(
  root: string,
  distDir: string,
): Promise<Map<string, { abs: string; type: string }>> {
  const files = new Map<string, { abs: string; type: string }>();

  for (const rel of await walkFiles(distDir)) {
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    files.set(toUrlPath(rel), {
      abs: path.join(distDir, rel),
      type: contentTypeFor(rel),
    });
  }

  const generatedDir = path.join(root, 'build', 'generated');
  for (const [source, prefix] of [
    ['raw', '/raw/'],
    ['proof', '/proof/'],
  ] as const) {
    const sourceDir = path.join(generatedDir, source);
    if (!existsSync(sourceDir)) continue;

    for (const rel of await walkFiles(sourceDir)) {
      files.set(`${prefix}${encodePath(rel)}`, {
        abs: path.join(sourceDir, rel),
        type: contentTypeFor(rel),
      });
    }
  }

  const searchIndex = path.join(generatedDir, 'search-index.json');
  if (existsSync(searchIndex)) {
    files.set('/search-index.json', {
      abs: searchIndex,
      type: contentTypeFor('search-index.json'),
    });
  }

  return files;
}

async function packageTheme(
  root: string,
  themeId: string,
  distDir: string,
  siteData: SiteData,
): Promise<{ vfsText: string; vfsSha256: string; vfsBytes: number; routeCount: number }> {
  const sources = await collectVfsFiles(root, distDir);
  const files: Record<string, VfsFile> = {};

  for (const [url, source] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    files[url] = {
      type: source.type,
      body: await readFile(source.abs, 'utf8'),
    };
  }

  const vfs: Vfs = { schema: 1, themeId, files };
  const vfsText = JSON.stringify(vfs);
  const vfsBytes = Buffer.byteLength(vfsText, 'utf8');

  if (vfsBytes > MAX_VFS_BYTES) {
    throw new Error(
      `Theme ${themeId}: VFS is ${(vfsBytes / 1024 / 1024).toFixed(1)} MiB, above the 25 MiB limit.`,
    );
  }
  if (vfsBytes > WARN_VFS_BYTES) {
    console.warn(
      `WARN: theme ${themeId} VFS is ${(vfsBytes / 1024).toFixed(0)} KiB; consider splitting content.`,
    );
  }

  const routeCount = validateVfs(vfs, {
    routes: siteData.nodes.map((node) => node.url),
    nodeIds: siteData.nodes.map((node) => node.id),
  });
  return {
    vfsText,
    vfsSha256: sha256Hex(vfsText),
    vfsBytes,
    routeCount,
  };
}

function anchorsHash(siteData: SiteData): string {
  const keys = siteData.nodes
    .flatMap((node) =>
      node.revisions
        .filter((revision) => revision.anchor !== null)
        .map(
          (revision) =>
            `${revision.anchor!.chainId}:${revision.anchor!.txHash}:${revision.anchor!.blockTimestamp}`,
        ),
    )
    .sort();
  return sha256Hex(keys.join('\n'));
}

function makeReleaseId(
  config: SiteConfig,
  buildMeta: BuildMeta,
  anchorHash: string,
  themes: BuiltTheme[],
): string {
  return sha256Hex(
    JSON.stringify({
      schema: 1,
      compiler: 'm2',
      contentHash: buildMeta.contentHash,
      anchorsHash: anchorHash,
      site: {
        title: config.title,
        description: config.description,
        url: config.url,
        repo: config.repo,
      },
      themes: themes
        .map((theme) => ({
          id: theme.id,
          commit: theme.prepared.env.THEME_GIT_HASH ?? '',
          vfsSha256: theme.vfsSha256,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
}

async function main(): Promise<void> {
  const root = process.cwd();
  const config = loadSiteConfig();

  console.log('Compiling content...');
  const compileResult = await compileSite({
    root,
    requireCleanWorktree: process.env.CI === 'true',
  });
  printIssues(compileResult);

  if (!compileResult.ok || !compileResult.siteData || !compileResult.buildMeta) {
    console.error('Compile failed.');
    process.exit(1);
  }

  const siteData = compileResult.siteData;
  const buildMeta = compileResult.buildMeta;
  const runtime = await buildRuntime(root);

  const branches = discoverThemes(root);
  if (branches.length === 0) {
    console.error('No theme/* branches found.');
    process.exit(1);
  }

  console.log(
    `Discovered ${branches.length} theme(s): ${branches.map((branch) => branch.id).join(', ')}`,
  );

  const built: BuiltTheme[] = [];
  for (const branch of branches) {
    const { prepared, distDir } = await buildTheme(root, branch, runtime);
    const packaged = await packageTheme(root, branch.id, distDir, siteData);

    built.push({
      id: branch.id,
      prepared,
      distDir,
      vfsText: packaged.vfsText,
      vfsSha256: packaged.vfsSha256,
      vfsBytes: packaged.vfsBytes,
      routeCount: packaged.routeCount,
    });

    console.log(
      `  ${branch.id}: ${(packaged.vfsBytes / 1024).toFixed(1)} KiB, ` +
        `${packaged.routeCount} routes, ${prepared.contract.displayName}`,
    );
  }

  const defaultTheme = built.find((theme) => theme.id === config.defaultTheme);
  if (!defaultTheme) {
    console.error(`Default theme "${config.defaultTheme}" was not built.`);
    process.exit(1);
  }

  const anchorHash = anchorsHash(siteData);
  const releaseId = makeReleaseId(config, buildMeta, anchorHash, built);
  const manifestThemes: ManifestTheme[] = built
    .map((theme) => ({
      id: theme.id,
      displayName: theme.prepared.contract.displayName,
      model: theme.prepared.contract.model,
      description: theme.prepared.contract.description,
      author: theme.prepared.contract.author,
      isDefault: theme.id === config.defaultTheme,
      commit: theme.prepared.env.THEME_GIT_HASH ?? '',
      updatedAt: theme.prepared.env.THEME_UPDATED_AT ?? '',
      vfsUrl: `/_themes/${theme.id}.${theme.vfsSha256}.vfs.json`,
      vfsSha256: theme.vfsSha256,
      sizeKB: Number((theme.vfsBytes / 1024).toFixed(1)),
    }))
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id),
    );

  const manifest = {
    schema: 1,
    releaseId,
    contentHash: buildMeta.contentHash,
    anchorsHash: anchorHash,
    generatedAt: new Date().toISOString(),
    defaultTheme: config.defaultTheme,
    site: {
      title: config.title,
      description: config.description,
      url: config.url,
      repo: config.repo,
    },
    chain: config.chain,
    themes: manifestThemes,
  };

  console.log('\nAssembling dist...');
  const distDir = path.join(root, 'dist');
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(defaultTheme.distDir, distDir, { recursive: true });

  await mkdir(path.join(distDir, '_themes'), { recursive: true });
  for (const theme of built) {
    await writeFile(
      path.join(
        distDir,
        '_themes',
        `${theme.id}.${theme.vfsSha256}.vfs.json`,
      ),
      theme.vfsText,
      'utf8',
    );
  }

  await writeFile(
    path.join(distDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await cp(runtime.swJs, path.join(distDir, 'sw.js'));
  await mkdir(path.join(distDir, '_sys'), { recursive: true });
  await cp(runtime.sysJs, path.join(distDir, '_sys', 'sys.js'));
  await writeFile(path.join(distDir, '_headers'), HEADERS, 'utf8');

  const generatedDir = path.join(root, 'build', 'generated');
  for (const file of ['rss.xml', 'sitemap.xml', 'robots.txt', 'search-index.json']) {
    const source = path.join(generatedDir, file);
    if (existsSync(source)) await cp(source, path.join(distDir, file));
  }
  for (const dir of ['raw', 'proof']) {
    const source = path.join(generatedDir, dir);
    if (existsSync(source)) {
      await cp(source, path.join(distDir, dir), { recursive: true });
    }
  }

  for (const required of ['index.html', '404.html', 'manifest.json', 'sw.js']) {
    if (!existsSync(path.join(distDir, required))) {
      console.error(`Missing required build output: ${required}`);
      process.exit(1);
    }
  }

  console.log('');
  console.log(`Themes: ${manifestThemes.map((theme) => theme.id).join(', ')}`);
  console.log(`Release: ${releaseId}`);
  console.log(`Default: ${config.defaultTheme}`);
  console.log(`Output:  ${distDir}`);
  for (const theme of manifestThemes) {
    console.log(
      `  ${theme.id.padEnd(12)} ${theme.commit}  ${theme.sizeKB.toFixed(1)} KiB`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
