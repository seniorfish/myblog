import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { compileSite } from '../core/build.ts';
import { prepareTheme } from './prepare-theme.ts';

const root = process.cwd();
const themeId = process.argv[2] ?? 'default';
const outDir = path.join(root, 'dist');

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

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(target);
    } else if (entry.isFile()) {
      total += (await stat(target)).size;
    }
  }

  return total;
}

console.log('Compiling content...');
const compileResult = await compileSite({
  root,
  requireCleanWorktree: process.env.CI === 'true',
});
printIssues(compileResult);

if (!compileResult.ok) {
  console.error('Compile failed.');
  process.exit(1);
}

const prepared = prepareTheme(root, themeId);
console.log(`Building theme in ${path.relative(root, prepared.dir)}...`);

const build = spawnSync('npm', ['run', 'build'], {
  cwd: prepared.dir,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ...prepared.env },
});

if (build.status !== 0) {
  console.error('Theme build failed.');
  process.exit(build.status ?? 1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(path.join(prepared.dir, 'dist'), outDir, { recursive: true });

const generatedDir = path.join(root, 'build', 'generated');
await mkdir(outDir, { recursive: true });

for (const file of ['rss.xml', 'sitemap.xml', 'robots.txt', 'search-index.json']) {
  const source = path.join(generatedDir, file);
  if (existsSync(source)) {
    await cp(source, path.join(outDir, file));
  }
}

for (const dir of ['raw', 'proof']) {
  const source = path.join(generatedDir, dir);
  if (existsSync(source)) {
    await cp(source, path.join(outDir, dir), { recursive: true });
  }
}

for (const required of ['index.html', '404.html']) {
  if (!existsSync(path.join(outDir, required))) {
    console.error(`Missing required build output: ${required}`);
    process.exit(1);
  }
}

const contentCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const size = await directorySize(outDir);

console.log('');
console.log(`Built ${compileResult.buildMeta?.nodeCount ?? 0} node(s).`);
console.log(`buildId: ${compileResult.buildMeta?.buildId ?? 'unknown'}`);
console.log(`content: ${contentCommit}`);
console.log(`output:  ${outDir}`);
console.log(`size:    ${(size / 1024).toFixed(1)} KiB`);
