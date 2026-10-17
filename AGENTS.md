# AGENTS.md

本文件给未来在此仓库工作的 AI。先读本文件，再读 `ARCHITECTURE.md` 与 `core/contract.ts`。

## 当前状态

M1 + M2 已完成：内容编译器、默认主题、多主题构建、VFS、manifest、Service Worker 主题切换/离线、宿主 dock、本地 serve 与浏览器 e2e。M3（链上存证 + R2 + Cloudflare Pages）尚未实现。

## 语言

- 代码注释、变量名、提交信息：**英文**。
- 文档与站点 UI 文案：**中文**。

## 常用命令

```powershell
npm run dev            # 编译 + 准备主题 + Astro dev（默认主题）
npm run dev -- terminal
npm run build          # 只构建默认主题 -> dist/
npm run build:all      # 构建所有 theme/* + VFS + manifest -> dist/
npm run build:runtime  # 只构建 host/sys.ts 与 sw/sw.ts
npm run serve          # 本地静态服务器（需要先 build:all）
npm run test:e2e       # 无头 Chrome 端到端（需要先 build:all）
npm run compile        # 只编译内容
npm test               # Vitest
npm run typecheck      # 主程序 + Service Worker 类型检查
npm run prepare-theme -- default
```

SW 更新间隔：本地 `build:all` 默认 1000ms，CI/生产 30 分钟；用 `SW_CHECK_INTERVAL_MS` 覆盖。`SW_BUILD_ID` 默认时间戳，CI 用 commit SHA。若浏览器仍停留在旧 SW，用 DevTools → Application → Service Workers → Update/Unregister，或在 dock 点“检查”。

## 目录与修改边界

| 路径 | 规则 |
| --- | --- |
| `content/` | 内容。只写 Markdown 与允许的 frontmatter |
| `core/contract.ts` | 全系统数据契约。修改前必须同步所有主题 |
| `core/` 其他 | 编译器。改动后跑 `npm test` 与 `npm run build` |
| `scripts/` | 构建/开发脚本。保持 `prepare-theme` 的注入契约 |
| `host/sys.ts` | 主题 dock + SW 注册；构建后注入每个主题 HTML |
| `sw/sw.ts` | Service Worker：VFS 缓存、主题切换、30 分钟惰性更新 |
| `core/vfs.ts` | VFS 路径归一化、content type、路由/资源校验 |
| `scripts/build-all.ts` | 多主题构建、VFS、manifest、dist 组装 |
| `scripts/serve.ts` / `scripts/e2e.ts` | 本地静态服务器与 Chrome e2e |
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
9. **主题不自己实现 dock/SW**：`sys.js` 与 `<sys-theme-dock>` 由构建期注入；主题只需设置 `<html data-theme-id={__THEME_ID__}>`，可选桥接 `--sys-*` CSS 变量。
10. **VFS 只放文本**：HTML/CSS/JS/JSON/SVG/XML/MD/TXT。图片等二进制走 R2（M3），不要塞进 VFS。
11. **VFS 文件名必须含内容哈希**：`/_themes/{id}.{vfsSha256}.vfs.json`；不要改成无哈希固定名再设 immutable。
12. **不要破坏 canonical 路径**：`index.html`→`/`，`n/foo.html`→`/n/foo`，`404.html`→`/404`。改动后跑 `npm run build:all` 与 `npm run test:e2e`。
13. **theme.contract.json 的 id 必须等于分支名**；只有 `theme/default` 允许 `isDefault: true`。
14. **首页节点**：主 Tag = `site.config.ts` 的 `homeTag`（默认 `首页`），全站最多一个已发布；`url='/'`，不生成 `/n/{id}`，从 `/archive`、RSS、sitemap、搜索中排除。主题用 `SiteData.homeNodeId` 找到它，并在 `/` 渲染其 HTML；索引页固定为 `/archive`。

## 数据流

`content/*.md` → `core/content.ts` → `core/tree.ts` → `core/markdown.ts` → `core/git.ts` → `core/anchors.ts` → `core/build.ts` → `build/generated/site-data.json` → 主题 `src/generated/site-data.json` → Astro 静态 HTML → `build-all` 注入 `sys.js`/dock → VFS + manifest + Service Worker → `dist/`。

主题只依赖 `SiteData`（见 `core/contract.ts`）。正文 HTML 已由编译器渲染好，主题用 `<Fragment set:html={node.html} />` 或 `<div set:html={node.html} />` 注入。

## 验证

```powershell
npm test
npm run typecheck
npm run build:all
npm run serve
npm run test:e2e
```

构建后检查 `dist/index.html`、`dist/n/*.html`、`dist/manifest.json`、`dist/sw.js`、`dist/_sys/sys.js`、`dist/_themes/*.vfs.json`、`dist/rss.xml`、`dist/sitemap.xml`、`dist/raw/`、`dist/proof/`。开发时若 4321 被占用，Astro 会打印实际端口；`npm run serve` 默认 8080。

## 参考

- `ARCHITECTURE.md`：M1/M2 实现与 M3 接口。
- `CONTENT.md`：写作规范。
- `core/contract.ts`：唯一数据契约。
- `THEME_AGENT_PROMPT.md`：新主题的复制即用提示词。
