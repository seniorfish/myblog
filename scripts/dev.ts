import { spawn } from 'node:child_process';
import path from 'node:path';
import { watch } from 'chokidar';
import { compileSite } from '../core/build.ts';
import { prepareTheme, syncGenerated, type PreparedTheme } from './prepare-theme.ts';

const root = process.cwd();
const themeId = process.argv[2] ?? 'default';

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

console.log('Compiling content...');
let compileResult = await compileSite({ root });
printIssues(compileResult);

if (!compileResult.ok) {
  console.error('Compile failed. Fix the errors above before starting the dev server.');
  process.exit(1);
}

let prepared: PreparedTheme;
try {
  prepared = prepareTheme(root, themeId);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const child = spawn('npm', ['run', 'dev'], {
  cwd: prepared.dir,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ...prepared.env },
});

let timer: NodeJS.Timeout | undefined;
const watcher = watch(['content', 'core', 'site.config.ts'], {
  cwd: root,
  ignoreInitial: true,
  ignored: /(^|[/\\])(node_modules|build|dist|\.worktrees)/u,
});

watcher.on('all', () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    console.log('Content changed; recompiling...');
    compileResult = await compileSite({ root });
    printIssues(compileResult);
    if (compileResult.ok) {
      syncGenerated(root, prepared.dir);
      console.log(`Recompiled ${compileResult.buildMeta?.nodeCount ?? 0} node(s).`);
    }
  }, 200);
});

const shutdown = (): void => {
  watcher.close().catch(() => undefined);
  child.kill();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

child.on('exit', (code) => {
  watcher.close().catch(() => undefined);
  process.exit(code ?? 0);
});

console.log(`Theme worktree: ${path.relative(root, prepared.dir)}`);
