/**
 * One-off migration: move Markdown frontmatter into <article>.meta.yml.
 *
 * Usage:
 *   npm run migrate:meta              # dry run
 *   npm run migrate:meta -- --write   # apply
 *   npm run migrate:meta -- --check   # exit 1 when anything still needs migration
 *
 * Safe to re-run: articles that already use a sidecar are skipped.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import { stringify as stringifyYaml } from 'yaml';
import {
  ALLOWED_FRONTMATTER_KEYS,
  FrontmatterError,
  parseFrontmatter,
} from '../core/schema.ts';

type Status = 'migrate' | 'already' | 'conflict' | 'missing-meta' | 'error';

interface FileResult {
  id: string;
  mdPath: string;
  metaPath: string;
  status: Status;
  message?: string;
}

interface OrphanResult {
  metaPath: string;
  mdPath: string;
}

const FRONTMATTER_START = /^---\r?\n/u;

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/');
}

function orderData(data: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of ALLOWED_FRONTMATTER_KEYS) {
    if (key in data) ordered[key] = data[key];
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

function sidecarPath(mdPath: string): string {
  return mdPath.replace(/\.md$/iu, '.meta.yml');
}

function stripSeparatorNewline(body: string): string {
  if (body.startsWith('\r\n')) return body.slice(2);
  if (body.startsWith('\n')) return body.slice(1);
  return body;
}

async function writeAtomic(absPath: string, text: string): Promise<void> {
  const tempPath = `${absPath}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tempPath, text, 'utf8');
  await rename(tempPath, absPath);
}

function serializeMetadata(data: Record<string, unknown>): string {
  const text = stringifyYaml(orderData(data), {
    lineWidth: 0,
    minContentWidth: 0,
    blockQuote: 'literal',
  });
  return text.endsWith('\n') ? text : `${text}\n`;
}

function usage(): void {
  console.log(
    [
      '用法：npm run migrate:meta -- [选项]',
      '',
      '  --write     实际写入 sidecar 并移除 frontmatter（默认 dry run）',
      '  --check     只检查；仍有待迁移文件时以退出码 1 结束',
      '  --json      输出机器可读的 JSON',
      '  --root DIR  指定仓库根目录（默认当前目录）',
      '  --help      显示本帮助',
    ].join('\n'),
  );
}

interface Options {
  write: boolean;
  check: boolean;
  json: boolean;
  root: string;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const valueOf = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const rootArg = valueOf('--root');
  if (argv.includes('--root') && !rootArg) {
    throw new Error('--root 需要一个目录参数。');
  }
  return {
    write: argv.includes('--write'),
    check: argv.includes('--check'),
    json: argv.includes('--json'),
    root: path.resolve(rootArg ?? process.cwd()),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (options.help) {
    usage();
    return 0;
  }

  const contentDir = path.join(options.root, 'content');
  let names: string[];
  try {
    names = (await readdir(contentDir, { recursive: true })).map(toPosix);
  } catch {
    console.error(`找不到内容目录：${contentDir}`);
    return 2;
  }

  const markdownFiles = names
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .filter((name) => !name.toLowerCase().endsWith('.meta.md'))
    .sort((a, b) => a.localeCompare(b));

  const metaFiles = new Set(
    names
      .filter((name) => name.toLowerCase().endsWith('.meta.yml'))
      .map((name) => `content/${name}`),
  );
  const markdownSet = new Set(markdownFiles.map((name) => `content/${name}`));

  const results: FileResult[] = [];

  for (const relative of markdownFiles) {
    const mdPath = `content/${relative}`;
    const metaPath = sidecarPath(mdPath);
    const absMd = path.join(options.root, mdPath);
    const absMeta = path.join(options.root, metaPath);
    const hasMeta = existsSync(absMeta);
    const id = relative.replace(/\.md$/iu, '');

    let text: string;
    try {
      text = await readFile(absMd, 'utf8');
    } catch (error) {
      results.push({
        id,
        mdPath,
        metaPath,
        status: 'error',
        message: `无法读取：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const hadBom = text.charCodeAt(0) === 0xfeff;
    if (hadBom) text = text.slice(1);

    const parsed = matter(text);
    const hasFrontmatter = FRONTMATTER_START.test(text);

    if (!hasFrontmatter) {
      results.push({
        id,
        mdPath,
        metaPath,
        status: hasMeta ? 'already' : 'missing-meta',
        message: hasMeta
          ? hadBom
            ? '已使用 sidecar；正文有 BOM，可运行 npm run blog -- check --fix 修复。'
            : undefined
          : '正文没有 frontmatter，也没有对应的 .meta.yml；请手动补充至少 tags。',
      });
      continue;
    }

    if (hasMeta) {
      results.push({
        id,
        mdPath,
        metaPath,
        status: 'conflict',
        message: '正文仍有 frontmatter，且 sidecar 已存在；请手动合并后保留一份。',
      });
      continue;
    }

    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(parsed.data) as unknown as Record<string, unknown>;
    } catch (error) {
      const message =
        error instanceof FrontmatterError
          ? error.field
            ? `${error.field}: ${error.message}`
            : error.message
          : error instanceof Error
            ? error.message
            : String(error);
      results.push({
        id,
        mdPath,
        metaPath,
        status: 'error',
        message: `frontmatter 校验失败：${message}`,
      });
      continue;
    }

    if (!options.write) {
      results.push({ id, mdPath, metaPath, status: 'migrate' });
      continue;
    }

    let body = stripSeparatorNewline(parsed.content);
    if (body.length > 0 && !body.endsWith('\n')) body += '\n';

    try {
      await writeAtomic(absMeta, serializeMetadata(data));
      await writeAtomic(absMd, body);
      results.push({ id, mdPath, metaPath, status: 'migrate' });
    } catch (error) {
      results.push({
        id,
        mdPath,
        metaPath,
        status: 'error',
        message: `写入失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const orphans: OrphanResult[] = [];
  for (const metaPath of metaFiles) {
    if (markdownSet.has(metaPath)) continue;
    const mdPath = metaPath.replace(/\.meta\.yml$/iu, '.md');
    if (markdownSet.has(mdPath)) continue;
    orphans.push({ metaPath, mdPath });
  }

  results.sort((a, b) => a.id.localeCompare(b.id));

  const pending = results.filter((item) => item.status === 'migrate').length;
  const already = results.filter((item) => item.status === 'already').length;
  const problems = results.filter(
    (item) =>
      item.status === 'conflict' ||
      item.status === 'missing-meta' ||
      item.status === 'error',
  );

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: problems.length === 0 && orphans.length === 0,
          mode: options.write ? 'write' : 'dry-run',
          pending,
          already,
          files: results,
          orphans,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    console.log(`迁移${options.write ? '执行' : '计划（dry run）'}：${options.root}`);
    for (const item of results) {
      const detail = item.message ? `  ${item.message}` : '';
      console.log(`  ${item.status.padEnd(12)} ${item.id}${detail}`);
    }
    for (const orphan of orphans) {
      console.log(
        `  ${'orphan'.padEnd(12)} ${orphan.metaPath}  没有对应的 ${orphan.mdPath}`,
      );
    }
    console.log(
      `共 ${results.length} 篇：待迁移 ${pending}，已完成 ${already}，问题 ${problems.length}，孤立 sidecar ${orphans.length}。`,
    );
    if (!options.write && pending > 0) {
      console.log('使用 --write 应用；应用前请确认编译器改造已在同一提交中完成。');
    }
  }

  if (problems.length > 0 || orphans.length > 0) return 1;
  if (options.check && pending > 0) return 1;
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 2;
  });
