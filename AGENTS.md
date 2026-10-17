# AGENTS.md

本文件给未来在此仓库工作的 AI。先读本文件，再读 `ARCHITECTURE.md` 与 `core/contract.ts`。

## 当前状态

里程碑 1 已完成：内容编译器、默认主题、本地开发与静态构建。M2（多主题 + VFS/Service Worker）与 M3（链上存证 + R2 + Cloudflare Pages）尚未实现。

## 语言

- 代码注释、变量名、提交信息：**英文**。
- 文档与站点 UI 文案：**中文**。

## 常用命令

```powershell
npm run dev            # 编译 + 准备主题 + Astro dev
npm run build          # 编译 + 构建默认主题 -> dist/
npm run compile        # 只编译内容
npm test               # Vitest
npm run typecheck      # tsc --noEmit
npm run prepare-theme -- default
```

## 目录与修改边界

| 路径 | 规则 |
| --- | --- |
| `content/` | 内容。只写 Markdown 与允许的 frontmatter |
| `core/contract.ts` | 全系统数据契约。修改前必须同步所有主题 |
| `core/` 其他 | 编译器。改动后跑 `npm test` 与 `npm run build` |
| `scripts/` | 构建/开发脚本。保持 `prepare-theme` 的注入契约 |
| `theme-harness/` | 共享 Astro/Tailwind 工具链。不要在每个主题分支里复制 |
| `theme/<id>` 分支 | 只放 UI：`src/`、`public/`、`theme.contract.json`、可选 `theme.package.json` |
| `src/generated/`（主题 worktree） | 编译器生成，禁止手改 |
| `build/`、`dist/`、`.worktrees/` | 生成物，已 gitignore |

## 硬性规则

1. **不手写日期**。内容 frontmatter 禁止 `date` / `pubDate` / `createdAt` / `updatedAt`。
2. **main 保持线性历史**。出现 merge commit 时编译会失败；PR 用 squash/rebase。
3. **id 发布后不改名**。需要改名时加 `aliases`。
4. **私钥、助记词、keystore 密码永不进入仓库、`.env`、对话或任何 Claude 可读取的文件**。链上签名只通过本机 keystore + `cast`。
5. **主题只做布局与 CSS**。不要读 `content/`、不要自己解析 Markdown、不要复制编译器逻辑。
6. **主题分支不提交 harness 生成物**：`package.json`、`astro.config.mjs`、`tsconfig.json`、`src/env.d.ts`、`src/generated/` 都被 `.gitignore` 忽略。
7. **构建 job 不接触敏感 secret**。Cloudflare token 只在 deploy step。
8. 代码注释用英文；文档与 UI 文案用中文。

## 数据流

`content/*.md` → `core/content.ts` → `core/tree.ts` → `core/markdown.ts` → `core/git.ts` → `core/anchors.ts` → `core/build.ts` → `build/generated/site-data.json` → 主题 `src/generated/site-data.json` → Astro 静态 HTML。

主题只依赖 `SiteData`（见 `core/contract.ts`）。正文 HTML 已由编译器渲染好，主题用 `<Fragment set:html={node.html} />` 或 `<div set:html={node.html} />` 注入。

## 验证

```powershell
npm test
npm run typecheck
npm run build
npm run dev
```

构建后检查 `dist/index.html`、`dist/n/*.html`、`dist/rss.xml`、`dist/sitemap.xml`、`dist/raw/`、`dist/proof/`。开发时若 4321 被占用，Astro 会打印实际端口。

## 参考

- `ARCHITECTURE.md`：M1 实现与 M2/M3 接口。
- `CONTENT.md`：写作规范。
- `core/contract.ts`：唯一数据契约。
- `THEME_AGENT_PROMPT.md`：新主题的复制即用提示词。
