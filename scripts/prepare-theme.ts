import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSiteConfig } from '../core/config.ts';
import { themeContractSchema, type ThemeContract } from '../core/schema.ts';

export interface PreparedTheme {
  id: string;
  dir: string;
  contract: ThemeContract;
  env: Record<string, string>;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function resolveRef(root: string, id: string, ref?: string): string {
  if (ref) return ref;

  const local = `theme/${id}`;
  try {
    execFileSync('git', ['rev-parse', '--verify', local], {
      cwd: root,
      stdio: 'ignore',
    });
    return local;
  } catch {
    const remote = `origin/theme/${id}`;
    try {
      execFileSync('git', ['rev-parse', '--verify', remote], {
        cwd: root,
        stdio: 'ignore',
      });
      return remote;
    } catch {
      throw new Error(
        `Theme branch "${local}" does not exist locally or at "${remote}".\n` +
          `Create it with:\n  git worktree add --orphan -b ${local} .worktrees/${id}`,
      );
    }
  }
}

function ensureWorktree(root: string, id: string, ref?: string): string {
  const dir = path.join(root, '.worktrees', id);
  const resolvedRef = resolveRef(root, id, ref);

  if (!existsSync(dir)) {
    execFileSync('git', ['worktree', 'add', dir, resolvedRef], {
      cwd: root,
      stdio: 'inherit',
    });
  }

  return dir;
}

export function syncGenerated(root: string, themeDir: string): void {
  const generatedDir = path.join(themeDir, 'src', 'generated');
  mkdirSync(generatedDir, { recursive: true });

  copyFileSync(
    path.join(root, 'build', 'generated', 'site-data.json'),
    path.join(generatedDir, 'site-data.json'),
  );
  copyFileSync(path.join(root, 'core', 'contract.ts'), path.join(generatedDir, 'contract.ts'));

  const searchIndex = path.join(root, 'build', 'generated', 'search-index.json');
  if (existsSync(searchIndex)) {
    copyFileSync(searchIndex, path.join(generatedDir, 'search-index.json'));
  }
}

function readThemeContract(themeDir: string, id: string): ThemeContract {
  const contractPath = path.join(themeDir, 'theme.contract.json');
  if (!existsSync(contractPath)) {
    throw new Error(`Missing ${contractPath}`);
  }

  const parsed = themeContractSchema.safeParse(
    JSON.parse(readFileSync(contractPath, 'utf8')),
  );
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid theme.contract.json:\n${details}`);
  }

  if (parsed.data.id !== id) {
    throw new Error(
      `theme.contract.json id "${parsed.data.id}" does not match branch theme/${id}.`,
    );
  }

  if (parsed.data.isDefault && id !== 'default') {
    throw new Error('Only theme/default may set isDefault: true.');
  }

  return parsed.data;
}

function mergeThemeDependencies(themeDir: string, harnessPackage: string): string {
  const base = JSON.parse(readFileSync(harnessPackage, 'utf8')) as Record<string, unknown>;
  const extraPath = path.join(themeDir, 'theme.package.json');

  if (existsSync(extraPath)) {
    const extra = JSON.parse(readFileSync(extraPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    base.dependencies = {
      ...((base.dependencies as Record<string, string> | undefined) ?? {}),
      ...(extra.dependencies ?? {}),
    };
    base.devDependencies = {
      ...((base.devDependencies as Record<string, string> | undefined) ?? {}),
      ...(extra.devDependencies ?? {}),
    };
  }

  return `${JSON.stringify(base, null, 2)}\n`;
}

function installIfNeeded(root: string, themeDir: string): void {
  const packageJsonPath = path.join(themeDir, 'package.json');
  const hash = sha256File(packageJsonPath);
  const cacheDir = path.join(root, '.cache');
  const hashPath = path.join(cacheDir, `theme-${path.basename(themeDir)}-package.hash`);

  mkdirSync(cacheDir, { recursive: true });

  if (existsSync(hashPath) && readFileSync(hashPath, 'utf8').trim() === hash) {
    return;
  }

  console.log(`Installing theme dependencies in ${themeDir}...`);
  execSync('npm install --no-audit --no-fund', {
    cwd: themeDir,
    stdio: 'inherit',
  });
  writeFileSync(hashPath, hash, 'utf8');
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function prepareTheme(root: string, id = 'default', ref?: string): PreparedTheme {
  if (!existsSync(path.join(root, 'build', 'generated', 'site-data.json'))) {
    throw new Error('build/generated/site-data.json is missing. Run `npm run compile` first.');
  }

  const config = loadSiteConfig();
  const dir = ensureWorktree(root, id, ref);
  const contract = readThemeContract(dir, id);

  copyFileSync(
    path.join(root, 'theme-harness', 'astro.config.mjs'),
    path.join(dir, 'astro.config.mjs'),
  );
  copyFileSync(
    path.join(root, 'theme-harness', 'tsconfig.json'),
    path.join(dir, 'tsconfig.json'),
  );
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  copyFileSync(
    path.join(root, 'theme-harness', 'src', 'env.d.ts'),
    path.join(dir, 'src', 'env.d.ts'),
  );

  const packageJson = mergeThemeDependencies(
    dir,
    path.join(root, 'theme-harness', 'package.json'),
  );
  writeFileSync(path.join(dir, 'package.json'), packageJson, 'utf8');

  syncGenerated(root, dir);
  installIfNeeded(root, dir);

  let contentHash = '';
  try {
    contentHash = gitOutput(root, ['log', '-1', '--format=%h', '--', 'content']);
  } catch {
    contentHash = '';
  }
  if (!contentHash) {
    contentHash = gitOutput(root, ['rev-parse', '--short', 'HEAD']);
  }

  const env = {
    THEME_ID: id,
    THEME_MODEL: contract.model,
    THEME_GIT_HASH: gitOutput(dir, ['rev-parse', '--short', 'HEAD']),
    THEME_UPDATED_AT: gitOutput(dir, ['log', '-1', '--format=%cd', '--date=short']),
    CONTENT_GIT_HASH: contentHash,
    SITE_URL: config.url,
  };

  return { id, dir, contract, env };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const themeId = process.argv[2] ?? 'default';
  const prepared = prepareTheme(process.cwd(), themeId);
  console.log(`Prepared ${prepared.dir}`);
}
