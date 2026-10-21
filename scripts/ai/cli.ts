import { readdir } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { defineCommand, runMain } from 'citty';
import { nodeIdFromPath } from '../../core/metadata.ts';
import { getPrimaryTag, inspectFrontmatter, readRawContentFile } from '../shared/content-file.ts';
import { openInEditor } from '../shared/editor.ts';
import { aiConfigSummary } from './client.ts';
import {
  FRONTMATTER_FIELDS,
  LANGUAGE_MODES,
  LANGUAGE_OUTPUTS,
  type FrontmatterField,
  type LanguageMode,
  type LanguageOutput,
} from './schemas.ts';
import {
  applyFrontmatter,
  currentFieldHint,
  defaultFields,
  formatProposal,
  generateFrontmatter,
} from './frontmatter.ts';
import {
  applyLanguage,
  formatSuggestions,
  generateLanguage,
} from './language.ts';

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function listContentFiles(root: string): Promise<string[]> {
  const contentDir = path.join(root, 'content');
  const names = await readdir(contentDir, { recursive: true });
  return names
    .map((name) => name.replace(/\\/gu, '/'))
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => `content/${name}`);
}

/** Accept either content/foo.md or content/foo.meta.yml. */
function normalizeContentArg(value: string): string {
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (normalized.toLowerCase().endsWith('.meta.yml')) {
    return `content/${nodeIdFromPath(normalized)}.md`;
  }
  return normalized;
}

function parseFields(value: string | undefined): FrontmatterField[] {
  if (!value) return [];
  const fields = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const field of fields) {
    if (!FRONTMATTER_FIELDS.includes(field as FrontmatterField)) {
      throw new Error(
        `未知字段 "${field}"。可用字段：${FRONTMATTER_FIELDS.join(', ')}。`,
      );
    }
  }

  return [...new Set(fields)] as FrontmatterField[];
}

function printFrontmatterResult(
  file: string,
  fields: FrontmatterField[],
  proposal: ReturnType<typeof formatProposal>,
  applied: FrontmatterField[],
): void {
  console.log(`文件：${file}`);
  console.log(`字段：${fields.join(', ')}`);
  console.log(proposal);
  if (applied.length > 0) console.log(`已应用：${applied.join(', ')}`);
}

async function runFrontmatterInteractive(root: string, relPath: string): Promise<number> {
  const target = await readRawContentFile(root, relPath);
  const inspected = inspectFrontmatter(target.data);
  if (inspected.issues.length > 0) {
    for (const issue of inspected.issues) p.log.error(issue);
    const action = await p.select({
      message: '元数据有格式问题，要做什么？',
      options: [
        { value: 'edit', label: '打开编辑器修复' },
        { value: 'exit', label: '退出' },
      ],
    });
    if (!p.isCancel(action) && action === 'edit') {
      await openInEditor(target.metaExists ? target.metaAbsPath : path.join(root, relPath));
    }
    return 1;
  }

  const defaults = new Set(defaultFields(target.data));
  const selected = await p.multiselect({
    message: '本轮建议哪些字段？',
    required: false,
    initialValues: FRONTMATTER_FIELDS.filter((field) => defaults.has(field)),
    options: FRONTMATTER_FIELDS.map((field) => ({
      value: field,
      label: field,
      hint: currentFieldHint(target.data, field),
    })),
  });

  if (p.isCancel(selected) || selected.length === 0) {
    p.cancel('未选择字段。');
    return 0;
  }

  const fields = selected as FrontmatterField[];
  const hasExisting = fields.some((field) => Boolean(target.data[field]));
  let force = false;
  if (hasExisting) {
    const overwrite = await p.confirm({
      message: '选中的字段里有已存在的值，要覆盖它们吗？',
      initialValue: false,
    });
    if (p.isCancel(overwrite)) return 0;
    force = overwrite;
  }

  let noCache = false;
  for (;;) {
    const spinner = p.spinner();
    spinner.start('正在生成元数据…');
    let generation;
    try {
      generation = await generateFrontmatter(root, relPath, fields, { noCache });
      spinner.stop(`生成完成${generation.cached ? '（缓存）' : ''}`);
    } catch (error) {
      spinner.stop('生成失败');
      p.log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    for (const warning of generation.warnings) p.log.warn(warning);
    p.note(formatProposal(generation.proposal, fields), 'AI 建议');

    const action = await p.select({
      message: '要如何处理这个建议？',
      options: [
        { value: 'apply', label: '应用' },
        { value: 'edit', label: '应用并打开编辑器微调' },
        { value: 'again', label: '重新生成' },
        { value: 'cancel', label: '取消' },
      ],
    });

    if (p.isCancel(action) || action === 'cancel') {
      p.outro('未应用。');
      return 0;
    }
    if (action === 'again') {
      noCache = true;
      continue;
    }

    try {
      const result = await applyFrontmatter(root, relPath, generation.proposal, fields, {
        force,
        expectedHash: generation.fileHash,
      });
      for (const warning of result.warnings) p.log.warn(warning);
      p.log.success(
        result.applied.length > 0
          ? `已更新：${result.applied.join(', ')}`
          : '没有需要补全的字段。',
      );

      if (action === 'edit') {
        await openInEditor(target.metaExists ? target.metaAbsPath : path.join(root, relPath));
      }

      p.outro(`下一步：npm run blog -- save ${relPath}`);
      return 0;
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
}

async function runLanguageInteractive(root: string, relPath: string): Promise<number> {
  const mode = await p.select({
    message: '优化目标',
    options: [
      { value: 'proofread', label: '校对', hint: '错别字 / 标点 / 明显语法' },
      { value: 'concise', label: '精简', hint: '去冗余、收紧句子' },
      { value: 'formal', label: '书面化', hint: '更正式的表达' },
      { value: 'casual', label: '口语化', hint: '更自然的表达' },
    ],
  });
  if (p.isCancel(mode)) return 0;

  const output = await p.select({
    message: '输出方式',
    options: [
      { value: 'advice', label: '只给建议', hint: '不改文件' },
      { value: 'rewrite', label: '生成改写 diff', hint: '确认后写入' },
    ],
  });
  if (p.isCancel(output)) return 0;

  const spinner = p.spinner();
  spinner.start('正在分析文本…');
  let generation;
  try {
    generation = await generateLanguage(
      root,
      relPath,
      mode as LanguageMode,
      output as LanguageOutput,
    );
    spinner.stop(`分析完成${generation.cached ? '（缓存）' : ''}`);
  } catch (error) {
    spinner.stop('分析失败');
    p.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (output === 'advice') {
    p.note(formatSuggestions(generation.proposal), '语言优化建议');
    p.outro('未修改文件。');
    return 0;
  }

  if (!generation.diff.changed) {
    if (generation.proposal.suggestions.length > 0) {
      p.note(formatSuggestions(generation.proposal), '语言优化建议');
    }
    p.outro('没有需要修改的地方。');
    return 0;
  }

  p.log.info('变更预览：');
  process.stdout.write(`${generation.diff.patch}\n`);

  const ok = await p.confirm({ message: '应用这份改写？', initialValue: true });
  if (p.isCancel(ok) || !ok) {
    p.outro('未应用。');
    return 0;
  }

  try {
    await applyLanguage(root, relPath, generation.proposal, {
      expectedHash: generation.fileHash,
    });
    p.log.success('已写入改写。');
    p.outro(`下一步：npm run blog -- save ${relPath}`);
    return 0;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runInteractive(root: string): Promise<number> {
  if (!canPrompt()) {
    console.error('交互模式需要 TTY。请使用 `npm run ai -- frontmatter <file>`。');
    return 2;
  }

  p.intro('ai · content assistant');
  const files = await listContentFiles(root);
  if (files.length === 0) {
    p.outro('content/ 里没有 Markdown 文件。');
    return 0;
  }

  const file = await p.autocomplete({
    message: '选择文件',
    options: files.map((item) => ({ value: item, label: item })),
  });
  if (p.isCancel(file)) {
    p.outro('已取消。');
    return 0;
  }

  const operation = await p.select({
    message: '选择操作',
    options: [
      { value: 'frontmatter', label: '元数据', hint: '补全 tags / title / description' },
      { value: 'language', label: '语言优化建议', hint: '校对 / 精简 / 改写' },
      { value: 'translate', label: '翻译', hint: '即将支持', disabled: true },
    ],
  });
  if (p.isCancel(operation)) {
    p.outro('已取消。');
    return 0;
  }

  if (operation === 'frontmatter') {
    return runFrontmatterInteractive(root, file as string);
  }
  if (operation === 'language') {
    return runLanguageInteractive(root, file as string);
  }

  p.outro('该操作尚未实现。');
  return 0;
}

const frontmatterCommand = defineCommand({
  meta: {
    name: 'frontmatter',
    description: '为单个文件建议或应用元数据（.meta.yml）。',
  },
  args: {
    file: { type: 'positional', required: true, description: '内容文件。' },
    fields: { type: 'string', description: '逗号分隔的字段列表。' },
    write: { type: 'boolean', default: false, description: '写入建议。' },
    force: { type: 'boolean', default: false, description: '覆盖已有字段。' },
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
    'no-cache': { type: 'boolean', default: false, description: '绕过 AI 缓存。' },
  },
  async run({ args }) {
    const root = process.cwd();
    const relPath = normalizeContentArg(String(args.file));
    try {
      const target = await readRawContentFile(root, relPath);
      const inspected = inspectFrontmatter(target.data);
      if (inspected.issues.length > 0) {
        throw new Error(inspected.issues.join(' '));
      }

      const fields = parseFields(args.fields);
      const effectiveFields =
        fields.length > 0 ? fields : defaultFields(target.data);
      if (effectiveFields.length === 0) {
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: true,
              file: relPath,
              fields: [],
              proposal: null,
              applied: [],
              message: '没有缺失字段。可以用 --fields 指定要重写的字段。',
            }, null, 2)}\n`,
          );
        } else {
          console.log('没有缺失字段。可以用 --fields 指定要重写的字段。');
        }
        return;
      }

      const generation = await generateFrontmatter(root, relPath, effectiveFields, {
        noCache: args['no-cache'],
      });

      let applied: FrontmatterField[] = [];
      if (args.write) {
        const result = await applyFrontmatter(
          root,
          relPath,
          generation.proposal,
          effectiveFields,
          { force: args.force, expectedHash: generation.fileHash },
        );
        applied = result.applied;
      }

      if (args.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              file: relPath,
              fields: effectiveFields,
              proposal: generation.proposal,
              warnings: generation.warnings,
              applied,
              cached: generation.cached,
              model: generation.model,
              usage: generation.usage,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        printFrontmatterResult(
          relPath,
          effectiveFields,
          formatProposal(generation.proposal, effectiveFields),
          applied,
        );
        for (const warning of generation.warnings) console.warn(`warning: ${warning}`);
      }
    } catch (error) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }, null, 2)}\n`,
        );
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }
      process.exitCode = 1;
    }
  },
});

const languageCommand = defineCommand({
  meta: {
    name: 'language',
    description: '给单篇内容语言建议或改写。',
  },
  args: {
    file: { type: 'positional', required: true, description: '内容文件。' },
    mode: {
      type: 'enum',
      options: [...LANGUAGE_MODES],
      default: 'proofread',
      description: '优化目标：proofread / concise / formal / casual。',
    },
    output: {
      type: 'enum',
      options: [...LANGUAGE_OUTPUTS],
      default: 'advice',
      description: 'advice 只给建议，rewrite 生成改写正文。',
    },
    write: { type: 'boolean', default: false, description: '写入改写正文。' },
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
    'no-cache': { type: 'boolean', default: false, description: '绕过 AI 缓存。' },
  },
  async run({ args }) {
    const root = process.cwd();
    const relPath = normalizeContentArg(String(args.file));
    const mode = (args.mode ?? 'proofread') as LanguageMode;
    const output = (args.output ?? 'advice') as LanguageOutput;
    if (args.write && output !== 'rewrite') {
      console.error('--write 只能和 --output rewrite 一起使用。');
      process.exitCode = 2;
      return;
    }

    try {
      const generation = await generateLanguage(root, relPath, mode, output, {
        noCache: args['no-cache'],
      });

      const hasRewrite = Boolean(generation.proposal.rewritten?.trim());
      if (output === 'rewrite' && !hasRewrite) {
        const hasSuggestions = generation.proposal.suggestions.length > 0;
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: true,
              file: relPath,
              mode,
              output,
              suggestions: generation.proposal.suggestions,
              rewrittenBody: null,
              applied: false,
              cached: generation.cached,
              model: generation.model,
              usage: generation.usage,
              message: hasSuggestions
                ? 'AI returned suggestions but no rewritten body; the file was not changed.'
                : 'No changes suggested.',
            }, null, 2)}\n`,
          );
        } else if (hasSuggestions) {
          console.log(formatSuggestions(generation.proposal));
          console.log('AI 没有返回改写正文；未修改文件。');
        } else {
          console.log('没有需要修改的地方。');
        }
        return;
      }

      let rewritten = false;
      if (args.write) {
        await applyLanguage(root, relPath, generation.proposal, {
          expectedHash: generation.fileHash,
        });
        rewritten = true;
      }

      if (args.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              file: relPath,
              mode,
              output,
              suggestions: generation.proposal.suggestions,
              rewrittenBody: generation.proposal.rewritten ?? null,
              applied: rewritten,
              cached: generation.cached,
              model: generation.model,
              usage: generation.usage,
            },
            null,
            2,
          )}\n`,
        );
      } else if (output === 'advice') {
        console.log(formatSuggestions(generation.proposal));
      } else {
        process.stdout.write(`${generation.diff.patch}\n`);
        console.log(rewritten ? '改写已写入。' : '改写未写入（加 --write 才会应用）。');
      }
    } catch (error) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }, null, 2)}\n`,
        );
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }
      process.exitCode = 1;
    }
  },
});

const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: '检查 DeepSeek 配置。' },
  args: {
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
  },
  run({ args }) {
    const checks = aiConfigSummary();
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2)}\n`,
      );
    } else {
      for (const check of checks) {
        console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`);
      }
    }
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  },
});

const main = defineCommand({
  meta: {
    name: 'ai',
    version: '0.1.0',
    description: '单文件 AI 助手：元数据、语言优化。',
  },
  subCommands: {
    frontmatter: frontmatterCommand,
    language: languageCommand,
    doctor: doctorCommand,
  },
  async run({ rawArgs }) {
    if (rawArgs.length > 0) return;
    process.exitCode = await runInteractive(process.cwd());
  },
});

runMain(main);
