import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { defineCommand, runMain } from 'citty';
import { loadSiteConfig } from '../../core/config.ts';
import type { CompileIssue } from '../../core/contract.ts';
import { validateContent } from '../../core/validate.ts';
import { metaRelPathFor, nodeIdFromPath } from '../../core/metadata.ts';
import { TEMPLATE_META_SOURCE, TEMPLATE_PATH, TEMPLATE_SOURCE, hasTemplateMarker, normalizeContentFile } from '../shared/content-file.ts';
import { primaryTagOf } from '../shared/commit-message.ts';
import { openInEditor } from '../shared/editor.ts';
import { slugify } from '../shared/slug.ts';
import { pullFfOnly } from '../shared/git-cli.ts';
import { planCommit, commitCandidate, createTemplateFile, push, renameTemplate } from './actions.ts';
import { anchorCommit } from './anchor.ts';
import {
  describeCandidate,
  gatherBlogState,
  issueLabels,
  type BlogState,
  type Candidate,
} from './state.ts';

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printIssues(issues: CompileIssue[]): void {
  for (const line of issueLabels(issues)) {
    p.log.error(line);
  }
}

function stateJson(state: BlogState): Record<string, unknown> {
  return {
    ok: state.canCommit,
    root: state.root,
    git: {
      branch: state.git.branch,
      detached: state.git.detached,
      operation: state.git.operation,
      ahead: state.git.ahead,
      behind: state.git.behind,
      hasUpstream: state.git.hasUpstream,
      remotes: state.git.remotes,
      changes: state.git.status.map((entry) => ({
        path: entry.path,
        index: entry.indexStatus,
        worktree: entry.worktreeStatus,
      })),
      mergeCommits: state.git.mergeCommits,
    },
    content: {
      ok: state.validation.ok,
      nodes: state.validation.entries.length,
      issues: state.validation.issues,
    },
    candidates: state.candidates.map((candidate) => ({
      path: candidate.path,
      metaPath: candidate.metaPath,
      id: candidate.id,
      kind: candidate.kind,
      staged: candidate.staged,
      isTemplate: candidate.isTemplate,
      errors: candidate.errors,
      warnings: candidate.warnings,
    })),
    blockers: state.blockers,
    notes: state.notes,
    fixes: state.fixes,
    suggestedCommands: state.candidates
      .filter(
        (candidate) =>
          candidate.id === 'new-blog' ||
          candidate.errors.length > 0 ||
          Boolean(candidate.data && !candidate.data.description),
      )
      .map((candidate) => `npm run ai -- frontmatter ${candidate.path} --fields tags,description`),
  };
}

function renderSummary(state: BlogState): void {
  p.log.info(`repo: ${state.root}`);
  p.log.info(`branch: ${state.git.branch || '(none)'} · ${state.git.status.length === 0 ? 'clean' : `${state.git.status.length} change(s)`}`);
  p.log.info(`content: ${state.validation.entries.length} node(s) · ${state.validation.issues.filter((issue) => issue.level === 'error').length} error(s)`);
  if (state.git.remotes.length > 0) {
    p.log.info(`remote: ${state.git.remotes.join(', ')} · ahead ${state.git.ahead} / behind ${state.git.behind}`);
  }
  if (process.env.DEEPSEEK_API_KEY) {
    p.log.info(`ai: ${process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'} configured`);
  } else {
    p.log.warn('ai: DEEPSEEK_API_KEY is not set; AI enrichment is unavailable.');
  }
  for (const fix of state.fixes) p.log.success(`fixed ${fix}`);
  for (const note of state.notes) p.log.info(note);
}

async function handleBlockers(state: BlogState): Promise<'again' | number> {
  for (const blocker of state.blockers) p.log.error(blocker);

  if (
    state.blockers.some((blocker) =>
      /branch|detached|merge|rebase|cherry-pick|conflict/iu.test(blocker),
    )
  ) {
    p.outro('请先处理 Git 状态，然后重新运行 npm run blog。');
    return 1;
  }

  const target = state.candidates.find((candidate) => candidate.exists);
  if (!target) {
    p.outro('请先处理上面的问题，然后重新运行 npm run blog。');
    return 1;
  }

  const action = await p.select({
    message: '要做什么？',
    options: [
      { value: 'edit', label: '打开编辑器处理', hint: target.path },
      {
        value: 'ai',
        label: '运行 AI 补全元数据',
        hint: process.env.DEEPSEEK_API_KEY ? '子进程运行 npm run ai' : '需要 DEEPSEEK_API_KEY',
        disabled: !process.env.DEEPSEEK_API_KEY,
      },
      { value: 'exit', label: '退出' },
    ],
  });
  if (p.isCancel(action) || action === 'exit') {
    p.outro('未提交。');
    return 1;
  }

  if (action === 'edit') {
    const opened = await openInEditor(path.join(state.root, target.metaPath));
    if (!opened) p.log.error('无法打开编辑器，请手动打开：' + target.metaPath);
    return 'again';
  }

  return runAiFrontmatter(state.root, target.path) === 0 ? 'again' : 1;
}

function runAiSlug(
  root: string,
  relPath: string,
): { id: string | null; alternatives: string[]; reason: string } | null {
  const result = spawnSync('npm', ['run', 'ai', '--', 'slug', relPath, '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    env: process.env,
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      id?: string | null;
      alternatives?: string[];
      reason?: string;
    };
    if (payload.ok === false) return null;
    return {
      id: payload.id ?? null,
      alternatives: Array.isArray(payload.alternatives) ? payload.alternatives : [],
      reason: payload.reason ?? '',
    };
  } catch {
    return null;
  }
}

function runAiFrontmatter(root: string, relPath: string): number {
  const result = spawnSync('npm', ['run', 'ai', '--', 'frontmatter', relPath], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  return result.status ?? 1;
}

async function commitFlow(state: BlogState, candidate: Candidate): Promise<'again' | number> {
  if (candidate.id === 'new-blog') {
    const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
    const action = await p.select({
      message: 'new-blog.md 是临时文件名，提交前需要改成正式 id。',
      options: [
        {
          value: 'ai',
          label: 'AI 生成语义化 id',
          hint: hasKey ? '根据标题与正文建议拼音 / 英文 slug' : '需要 DEEPSEEK_API_KEY',
          disabled: !hasKey,
        },
        {
          value: 'derive',
          label: '从标题或首行推导',
          hint: '纯中文会退化为随机 post-xxxxxxxx',
        },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (p.isCancel(action) || action === 'cancel') {
      p.outro('未提交。');
      return 1;
    }

    let suggested = '';
    if (action === 'ai') {
      const spinner = p.spinner();
      spinner.start('正在生成 id…');
      const suggestion = runAiSlug(state.root, candidate.path);
      spinner.stop(suggestion ? '生成完成' : '生成失败');
      if (suggestion?.id) {
        suggested = suggestion.id;
        if (suggestion.reason) p.log.info(`理由：${suggestion.reason}`);
        const others = suggestion.alternatives.filter((item) => item !== suggestion.id);
        if (others.length > 0) p.log.info(`备选：${others.join(', ')}`);
      } else {
        p.log.warn('AI 没有给出可用的 id，请手动填写。');
      }
    }

    const input = await p.text({
      message: '确认 id（ASCII、小写、连字符）',
      placeholder: '例如 bing-shan',
      initialValue: suggested || undefined,
      validate: (value) => {
        const slug = slugify(String(value ?? ''));
        if (!slug) return '至少需要一个 ASCII 字母或数字。';
        if (slug === 'new-blog') return 'new-blog 是保留 id。';
        return undefined;
      },
    });
    if (p.isCancel(input)) {
      p.outro('未提交。');
      return 1;
    }

    const nextPath = await renameTemplate(state.root, candidate, String(input));
    p.log.success(`renamed ${candidate.path} -> ${nextPath}`);
    return 'again';
  }

  const plan = planCommit(state, candidate);
  p.note(
    [
      `body: ${candidate.path}`,
      `meta: ${candidate.metaPath}`,
      `tags: ${String(candidate.data?.tags ?? '(missing)')}`,
      `kind: ${plan.kind}`,
      `commit: ${plan.message}`,
    ].join('\n'),
    '将提交',
  );

  const ok = await p.confirm({ message: '提交这个内容改动？', initialValue: true });
  if (p.isCancel(ok) || !ok) {
    p.outro('未提交。');
    return 1;
  }

  try {
    const result = await commitCandidate(state, candidate);
    p.log.success(`已提交 ${result.commit.slice(0, 7)} · ${result.message}`);
    p.log.info(`url: ${result.url}`);

    if (state.git.remotes.length > 0) {
      const doPush = await p.confirm({ message: '现在推送到远端？', initialValue: false });
      if (!p.isCancel(doPush) && doPush) {
        try {
          const upstream = push(state);
          p.log.success(`已推送到 ${upstream}`);
        } catch (error) {
          p.log.error(error instanceof Error ? error.message : String(error));
        }
      }
    }

    p.outro(`完成：${result.path}`);
    return 0;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('提交失败，文件保留在工作区。');
    return 1;
  }
}

async function handleCandidate(state: BlogState, candidate: Candidate): Promise<'again' | number> {
  if (!candidate.exists) {
    p.log.error(`${candidate.path} 已被删除；请手动确认是否删除这个节点。`);
    return 1;
  }

  for (const warning of candidate.warnings) p.log.warn(warning.message);

  if (candidate.isTemplate && candidate.body && hasTemplateMarker(candidate.body)) {
    p.log.warn('文件里还有模板占位标记。请在编辑器中写完正文并删除 <!-- new-blog-template -->。');
    const opened = await openInEditor(path.join(state.root, candidate.path));
    if (!opened) p.log.error('无法打开编辑器，请手动编辑：' + candidate.path);
    return 'again';
  }

  if (candidate.errors.length > 0) {
    printIssues(candidate.errors);
    const action = await p.select({
      message: '元数据还有问题，要做什么？',
      options: [
        {
          value: 'ai',
          label: '运行 AI 补全',
          hint: process.env.DEEPSEEK_API_KEY ? '推荐' : '需要 DEEPSEEK_API_KEY',
          disabled: !process.env.DEEPSEEK_API_KEY,
        },
        { value: 'edit', label: '打开编辑器修改' },
        { value: 'exit', label: '退出' },
      ],
    });
    if (p.isCancel(action) || action === 'exit') {
      p.outro('未提交。');
      return 1;
    }
    if (action === 'edit') {
      const opened = await openInEditor(path.join(state.root, candidate.metaPath));
      if (!opened) p.log.error('无法打开编辑器，请手动编辑：' + candidate.metaPath);
      return 'again';
    }
    return runAiFrontmatter(state.root, candidate.path) === 0 ? 'again' : 1;
  }

  const data = candidate.data ?? {};
  const missingDescription = !data.description;
  const missingArticleTitle = !data.title && primaryTagOf(data) === '文章';
  if (missingDescription || missingArticleTitle) {
    const missing = [
      missingDescription ? 'description' : '',
      missingArticleTitle ? 'title' : '',
    ].filter(Boolean);
    p.log.info(`可选字段未填写：${missing.join(', ')}。`);

    const action = await p.select({
      message: '要先用 AI 补全这些字段吗？',
      options: [
        {
          value: 'ai',
          label: '运行 AI 补全',
          hint: process.env.DEEPSEEK_API_KEY ? '推荐' : '需要 DEEPSEEK_API_KEY',
          disabled: !process.env.DEEPSEEK_API_KEY,
        },
        { value: 'edit', label: '打开编辑器自己写' },
        { value: 'commit', label: '直接提交' },
        { value: 'exit', label: '退出' },
      ],
    });

    if (p.isCancel(action) || action === 'exit') {
      p.outro('未提交。');
      return 1;
    }
    if (action === 'edit') {
      const opened = await openInEditor(path.join(state.root, candidate.metaPath));
      if (!opened) p.log.error('无法打开编辑器，请手动编辑：' + candidate.metaPath);
      return 'again';
    }
    if (action === 'ai') {
      return runAiFrontmatter(state.root, candidate.path) === 0 ? 'again' : 1;
    }
  } else if (!data.title) {
    p.log.info('提示：没有 title 也可以提交；首页会使用正文前 20 字。');
  }

  return commitFlow(state, candidate);
}

async function runInteractive(root: string): Promise<number> {
  if (!canPrompt()) {
    console.error('交互模式需要 TTY。请使用 `npm run blog -- status` 或 `npm run blog -- check`。');
    return 2;
  }

  p.intro('myblog · content workflow');

  for (;;) {
    let state: BlogState;
    try {
      state = await gatherBlogState(root);
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
      p.outro('无法读取仓库状态。');
      return 1;
    }

    renderSummary(state);

    if (state.blockers.length > 0) {
      const result = await handleBlockers(state);
      if (result === 'again') continue;
      return result;
    }

    if (state.candidates.length === 0) {
      const action = await p.select({
        message: '没有待处理内容。要做什么？',
        options: [
          { value: 'new', label: '创建新文章', hint: '复制模板并打开编辑器' },
          {
            value: 'pull',
            label: '拉取远端更新',
            hint: state.git.behind > 0 ? `落后 ${state.git.behind} 个提交` : '已是最新',
            disabled: state.git.remotes.length === 0 || state.git.behind === 0,
          },
          {
            value: 'push',
            label: '推送到远端',
            hint: state.git.ahead > 0 ? `领先 ${state.git.ahead} 个提交` : '没有可推送的提交',
            disabled: state.git.remotes.length === 0 || state.git.ahead === 0,
          },
          { value: 'status', label: '查看详细状态' },
          { value: 'exit', label: '退出' },
        ],
      });
      if (p.isCancel(action) || action === 'exit') {
        p.outro('退出。');
        return 0;
      }
      if (action === 'status') {
        p.note(JSON.stringify(stateJson(state), null, 2), 'status');
        continue;
      }
      if (action === 'pull') {
        try {
          const head = pullFfOnly(state.root);
          p.log.success(`pulled; HEAD is ${head}`);
          p.outro('完成。');
          return 0;
        } catch (error) {
          p.log.error(error instanceof Error ? error.message : String(error));
          p.outro('拉取失败；请手动处理本地改动或分叉。');
          return 1;
        }
      }
      if (action === 'push') {
        try {
          const upstream = push(state);
          p.log.success(`已推送到 ${upstream}`);
          p.outro('完成。');
          return 0;
        } catch (error) {
          p.log.error(error instanceof Error ? error.message : String(error));
          p.outro('推送失败。');
          return 1;
        }
      }

      try {
        const created = await createTemplateFile(root);
        const bodyPath = created[0]!;
        p.log.success(`已复制模板到 ${created[0]} 与 ${created[1]}`);
        const opened = await openInEditor(path.join(root, bodyPath));
        if (!opened) {
          p.log.info(`请手动打开编辑器：${bodyPath}`);
          p.outro('编辑完成后重新运行 npm run blog。');
          return 0;
        }
        p.log.info('编辑完成后继续检测…');
        continue;
      } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        p.outro('创建模板失败。');
        return 1;
      }
    }

    let candidate = state.candidates[0]!;
    if (state.candidates.length > 1) {
      const selected = await p.select({
        message: `检测到 ${state.candidates.length} 个内容改动，处理哪一个？`,
        options: state.candidates.map((item) => ({
          value: item.path,
          label: describeCandidate(item),
          hint: item.errors.length > 0 ? '有元数据问题' : undefined,
        })),
      });
      if (p.isCancel(selected)) {
        p.outro('退出。');
        return 0;
      }
      candidate = state.candidates.find((item) => item.path === selected) ?? candidate;
    }

    const result = await handleCandidate(state, candidate);
    if (result === 'again') continue;
    return result;
  }
}

const statusCommand = defineCommand({
  meta: { name: 'status', description: '查看仓库与内容状态。' },
  args: {
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
  },
  async run({ args }) {
    const state = await gatherBlogState(process.cwd());
    if (args.json) {
      process.stdout.write(`${JSON.stringify(stateJson(state), null, 2)}\n`);
    } else {
      console.log(`branch: ${state.git.branch || '(none)'}`);
      console.log(`status: ${state.git.status.length === 0 ? 'clean' : `${state.git.status.length} change(s)`}`);
      console.log(`content: ${state.validation.entries.length} node(s)`);
      for (const candidate of state.candidates) console.log(`candidate: ${describeCandidate(candidate)}`);
      for (const blocker of state.blockers) console.log(`blocker: ${blocker}`);
      for (const note of state.notes) console.log(`note: ${note}`);
    }
    process.exitCode = state.blockers.length > 0 ? 1 : 0;
  },
});

const checkCommand = defineCommand({
  meta: { name: 'check', description: '校验所有内容，不渲染 Markdown。' },
  args: {
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
    fix: { type: 'boolean', default: false, description: '先应用安全的机械修复。' },
  },
  async run({ args }) {
    const root = process.cwd();
    const config = loadSiteConfig();

    if (args.fix) {
      const contentDir = path.join(root, 'content');
      const names = await readdir(contentDir, { recursive: true });
      for (const name of names) {
        const rel = name.replace(/\\/gu, '/');
        if (!rel.toLowerCase().endsWith('.md')) continue;
        await normalizeContentFile(root, `content/${rel}`);
      }
    }

    const result = await validateContent(root, config, { allowReservedId: false });
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: result.ok,
          issues: result.issues,
          nodes: result.entries.map((entry) => ({
            id: entry.id,
            path: entry.relPath,
            primaryTag: entry.tags.primaryTag,
            secondaryTags: entry.tags.secondaryTags,
            draft: entry.frontmatter.draft ?? false,
          })),
          homeNodeId: result.homeEntries[0]?.id ?? null,
        }, null, 2)}\n`,
      );
    } else {
      for (const issue of result.issues) {
        const field = issue.field ? ` [${issue.field}]` : '';
        console.log(`${issue.level.toUpperCase()}${issue.file ? ` ${issue.file}` : ''}${field}: ${issue.message}`);
      }
      console.log(result.ok ? '内容校验通过。' : '内容有错误。');
    }
    process.exitCode = result.ok ? 0 : 1;
  },
});

const newCommand = defineCommand({
  meta: { name: 'new', description: '把新文章模板复制到 content/。' },
  args: {
    slug: { type: 'string', description: '可选的文件 id。' },
    open: { type: 'boolean', default: false, description: '创建后打开编辑器。' },
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
  },
  async run({ args }) {
    const root = process.cwd();
    const requestedSlug = args.slug ? slugify(args.slug) : '';
    if (args.slug && !requestedSlug) {
      console.error('--slug 至少需要包含一个 ASCII 字母或数字。');
      process.exitCode = 2;
      return;
    }
    if (requestedSlug === 'new-blog') {
      console.error('new-blog 是保留的模板 id，请换一个 slug。');
      process.exitCode = 2;
      return;
    }
    const target = requestedSlug ? `content/${requestedSlug}.md` : TEMPLATE_PATH;
    const targetMeta = metaRelPathFor(target);
    const absPath = path.join(root, target);

    if (existsSync(absPath) || existsSync(path.join(root, targetMeta))) {
      console.error(`文件已存在：${target}`);
      process.exitCode = 1;
      return;
    }
    if (
      !existsSync(path.join(root, TEMPLATE_SOURCE)) ||
      !existsSync(path.join(root, TEMPLATE_META_SOURCE))
    ) {
      console.error(`缺少模板：${TEMPLATE_SOURCE} 或 ${TEMPLATE_META_SOURCE}`);
      process.exitCode = 1;
      return;
    }

    await createTemplateFile(root, target);
    if (args.open && canPrompt()) await openInEditor(absPath);

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, path: target, metaPath: targetMeta }, null, 2)}\n`,
      );
    } else {
      console.log(`created ${target}`);
      console.log(`meta: ${targetMeta}`);
      console.log(`next: npm run ai -- frontmatter ${target}`);
    }
  },
});

const saveCommand = defineCommand({
  meta: { name: 'save', description: '校验并提交一个内容文件。' },
  args: {
    file: { type: 'positional', required: false, description: '要提交的内容文件。' },
    message: { type: 'string', description: '覆盖自动生成的 commit message。' },
    push: { type: 'boolean', default: false, description: '提交后推送。' },
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
  },
  async run({ args }) {
    const root = process.cwd();
    const state = await gatherBlogState(root);
    if (state.blockers.length > 0) {
      if (args.json) process.stdout.write(`${JSON.stringify(stateJson(state), null, 2)}\n`);
      else for (const blocker of state.blockers) console.error(`blocker: ${blocker}`);
      process.exitCode = 1;
      return;
    }

    let candidate: Candidate | undefined;
    if (args.file) {
      const normalized = args.file.replace(/\\/gu, '/').replace(/^\.\//u, '');
      const id = nodeIdFromPath(normalized);
      candidate = state.candidates.find(
        (item) =>
          item.path === normalized ||
          item.metaPath === normalized ||
          item.id === id,
      );
      if (!candidate) {
        console.error(`没有待提交的内容改动：${normalized}`);
        process.exitCode = 1;
        return;
      }
    } else if (state.candidates.length === 1) {
      candidate = state.candidates[0];
    } else if (state.candidates.length === 0) {
      console.error('没有待提交的内容改动。');
      process.exitCode = 0;
      return;
    } else {
      console.error('有多个内容改动；请显式指定一个路径：');
      for (const item of state.candidates) console.error(`  ${item.path}`);
      process.exitCode = 2;
      return;
    }

    if (!candidate) {
      console.error('没有选中内容文件。');
      process.exitCode = 2;
      return;
    }

    if (!candidate.exists) {
      console.error(`${candidate.path} 已被删除；请手动确认是否删除这个节点。`);
      process.exitCode = 1;
      return;
    }
    if (candidate.isTemplate && candidate.body && hasTemplateMarker(candidate.body)) {
      console.error('模板占位标记还在；请编辑文件后再提交。');
      process.exitCode = 1;
      return;
    }
    if (candidate.errors.length > 0) {
      for (const issue of candidate.errors) console.error(`${issue.level}: ${issue.message}`);
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = await commitCandidate(state, candidate, args.message);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    if (args.push) {
      try {
        push(state);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    } else {
      console.log(`已提交 ${result.commit.slice(0, 7)} · ${result.message}`);
      console.log(`url: ${result.url}`);
    }
  },
});

const pullCommand = defineCommand({
  meta: { name: 'pull', description: '以 --ff-only 从远端更新 main。' },
  args: {
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
  },
  async run({ args }) {
    const state = await gatherBlogState(process.cwd());
    if (state.blockers.length > 0) {
      console.error(state.blockers.join('\n'));
      process.exitCode = 1;
      return;
    }
    if (state.git.remotes.length === 0) {
      console.error('没有配置 Git 远端。');
      process.exitCode = 1;
      return;
    }
    if (state.git.behind === 0) {
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, pulled: false }, null, 2)}\n`);
      else console.log('已经是最新。');
      return;
    }

    try {
      const head = pullFfOnly(state.root);
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, pulled: true, head }, null, 2)}\n`);
      else console.log(`pulled; HEAD is ${head}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },
});

const pushCommand = defineCommand({
  meta: { name: 'push', description: '把 main 推送到远端。' },
  args: {
    yes: { type: 'boolean', default: false, description: '跳过确认。' },
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
  },
  async run({ args }) {
    const state = await gatherBlogState(process.cwd());
    if (state.blockers.length > 0) {
      console.error(state.blockers.join('\n'));
      process.exitCode = 1;
      return;
    }
    if (state.git.remotes.length === 0) {
      console.error('没有配置 Git 远端。');
      process.exitCode = 1;
      return;
    }
    if (state.git.behind > 0) {
      console.error(`分支落后远端 ${state.git.behind} 个提交；请先运行 npm run blog -- pull。`);
      process.exitCode = 1;
      return;
    }
    if (state.git.ahead === 0) {
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, pushed: false }, null, 2)}\n`);
      else console.log('没有可推送的提交。');
      return;
    }

    if (!args.yes && canPrompt()) {
      const ok = await p.confirm({ message: `Push ${state.git.ahead} commit(s)?`, initialValue: true });
      if (p.isCancel(ok) || !ok) {
        process.exitCode = 1;
        return;
      }
    } else if (!args.yes && !canPrompt()) {
      console.error('非交互推送需要 --yes。');
      process.exitCode = 2;
      return;
    }

    try {
      const upstream = push(state);
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, upstream }, null, 2)}\n`);
      else console.log(`已推送到 ${upstream}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },
});

const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: '检查本地工具与仓库配置。' },
  args: {
    json: { type: 'boolean', default: false, description: '输出机器可读的 JSON。' },
  },
  async run({ args }) {
    const root = process.cwd();
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const major = Number(process.versions.node.split('.')[0] ?? 0);
    checks.push({ name: 'node', ok: major >= 22, detail: process.versions.node });
    checks.push({
      name: 'template',
      ok:
        existsSync(path.join(root, TEMPLATE_SOURCE)) &&
        existsSync(path.join(root, TEMPLATE_META_SOURCE)),
      detail: `${TEMPLATE_SOURCE}, ${TEMPLATE_META_SOURCE}`,
    });
    checks.push({
      name: 'deepseek-key',
      ok: Boolean(process.env.DEEPSEEK_API_KEY),
      detail: process.env.DEEPSEEK_API_KEY ? 'configured' : 'DEEPSEEK_API_KEY is not set',
    });
    checks.push({
      name: 'editor',
      ok: Boolean(process.env.VISUAL || process.env.EDITOR),
      detail: process.env.VISUAL ?? process.env.EDITOR ?? 'auto-detect via open-editor',
    });

    try {
      const state = await gatherBlogState(root);
      checks.push({ name: 'git', ok: true, detail: state.git.branch || '(detached)' });
      checks.push({
        name: 'content',
        ok: state.validation.ok,
        detail: `${state.validation.entries.length} node(s), ${state.validation.issues.filter((issue) => issue.level === 'error').length} error(s)`,
      });
    } catch (error) {
      checks.push({
        name: 'git',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2)}\n`);
    } else {
      for (const check of checks) {
        console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`);
      }
    }
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  },
});

const anchorCommand = defineCommand({
  meta: {
    name: 'anchor',
    description: '在 Base 主网上锚定一个 commit（写事件 + 更新 anchors 分支）。',
  },
  args: {
    commit: { type: 'string', default: 'HEAD' },
    rpcUrl: { type: 'string' },
    contract: { type: 'string' },
    keystore: { type: 'string' },
    account: { type: 'string' },
    passwordFile: { type: 'string' },
    privateKeyEnv: { type: 'string' },
    confirmations: { type: 'string' },
    dryRun: { type: 'boolean', default: false },
    recoverOnly: { type: 'boolean', default: false },
    forceResend: { type: 'boolean', default: false },
    allowAnyCommit: { type: 'boolean', default: false },
    keepWorktree: { type: 'boolean', default: false },
    noPush: { type: 'boolean', default: false },
    authorName: { type: 'string' },
    authorEmail: { type: 'string' },
    yes: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    const fail = (message: string, code = 1): void => {
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
      } else {
        console.error(message);
      }
      process.exitCode = code;
    };

    if (!args.dryRun && !args.recoverOnly && !args.yes) {
      fail('拒绝在未确认的情况下锚定；请加 --yes，或使用 --dry-run/--recover-only。', 2);
      return;
    }

    let confirmations: number | undefined;
    if (args.confirmations !== undefined) {
      confirmations = Number(args.confirmations);
      if (!Number.isInteger(confirmations) || confirmations < 1) {
        fail('--confirmations 必须是正整数。', 2);
        return;
      }
    }

    try {
      const result = await anchorCommit({
        root: process.cwd(),
        env: process.env,
        commit: args.commit,
        auth: {
          keystore: args.keystore,
          account: args.account,
          passwordFile: args.passwordFile,
          privateKeyEnv: args.privateKeyEnv,
        },
        rpcUrl: args.rpcUrl,
        contract: args.contract,
        confirmations,
        dryRun: Boolean(args.dryRun),
        recoverOnly: Boolean(args.recoverOnly),
        forceResend: Boolean(args.forceResend),
        allowAnyCommit: Boolean(args.allowAnyCommit),
        keepWorktree: Boolean(args.keepWorktree),
        noPush: Boolean(args.noPush),
        authorName: args.authorName,
        authorEmail: args.authorEmail,
      });

      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        const labels: Record<string, string> = {
          anchored: '已锚定',
          recovered: '已从链上回填',
          skipped: '已存在，跳过',
          'would-anchor': '待锚定（dry-run）',
          'not-found': '链上未找到',
        };
        console.log(`${labels[result.action] ?? result.action}: ${result.commitShort}`);
        if (result.tx) console.log(`tx: ${result.tx}`);
        if (result.block !== undefined) console.log(`block: ${result.block}`);
        if (result.explorerUrl) console.log(`explorer: ${result.explorerUrl}`);
        if (result.pushed) console.log('anchors 分支已推送');
        for (const warning of result.warnings) console.error(`warning: ${warning}`);
      }

      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), 1);
    }
  },
});

const main = defineCommand({
  meta: {
    name: 'blog',
    version: '0.1.0',
    description: '仓库级内容工作流：检查、创建、提交、推送。',
  },
  subCommands: {
    status: statusCommand,
    check: checkCommand,
    new: newCommand,
    save: saveCommand,
    pull: pullCommand,
    push: pushCommand,
    doctor: doctorCommand,
    anchor: anchorCommand,
  },
  async run({ rawArgs }) {
    if (rawArgs.length > 0) return;
    process.exitCode = await runInteractive(process.cwd());
  },
});

runMain(main);
