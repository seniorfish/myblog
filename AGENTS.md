# AGENTS.md

本文件给未来在此仓库工作的 AI。先读本文件，再读 `ARCHITECTURE.md` 与 `core/contract.ts`。

## 当前状态

M1 + M2 已完成：内容编译器、默认主题、多主题构建、VFS、manifest、Service Worker 主题切换/离线、宿主 dock、本地 serve 与浏览器 e2e。写作工具已拆成 `npm run blog`（仓库/Git）与 `npm run ai`（单文件 AI）。M3 链上存证已接入 Base 主网（事件合约 + `anchors` 分支 + CI 自动锚定）；R2 图床与 Cloudflare Pages 部署待做。

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
npm run blog           # 交互式：检查/创建/提交/推送内容
npm run ai             # 交互式：单文件元数据 / id 建议 / 语言优化
npm run blog -- status --json
npm run ai -- frontmatter content/foo.md --fields tags,description --json
npm run ai -- slug content/foo.md --json         # 语义化 id（拼音/英文）
npm run ai -- slug content/foo.md --write        # 确认后重命名 .md + .meta.yml
npm test               # Vitest
npm run typecheck      # 主程序 + Service Worker 类型检查
npm run prepare-theme -- default
npm run contract:test  # Foundry：锚定合约测试
npm run blog -- anchor --commit <sha> --dry-run --json
npm run blog -- anchor --commit <sha> --recover-only --no-push --json
```

SW 更新间隔：本地 `build:all` 默认 1000ms，CI/生产 30 分钟；用 `SW_CHECK_INTERVAL_MS` 覆盖。`SW_BUILD_ID` 默认时间戳，CI 用 commit SHA。生产更新不依赖访客手动卸载：`sys.js` 在页面加载/重新可见时 `registration.update()` + `SOFT_CHECK`，新 worker `skipWaiting`/`clients.claim`；release 变化时 dock 提示刷新。排障时才用 DevTools Update/Unregister。

## 目录与修改边界

| 路径 | 规则 |
| --- | --- |
| `content/` | 正文 `.md` + 元数据 `.meta.yml`，两者成对出现 |
| `core/contract.ts` | 全系统数据契约。修改前必须同步所有主题 |
| `core/` 其他 | 编译器。改动后跑 `npm test` 与 `npm run build` |
| `core/anchor-index.ts` | `anchors.ndjson` 解析、commit 补零、记录过滤 |
| `scripts/` | 构建/开发脚本。保持 `prepare-theme` 的注入契约 |
| `scripts/blog/` | `npm run blog`：仓库状态机、模板、校验、commit/push、anchor。只在这里做 Git 写操作 |
| `scripts/ai/` | `npm run ai`：单文件元数据 / id 建议 / 语言操作。禁止执行 Git 命令 |
| `scripts/shared/` | 两个 CLI 共享的 Git 查询、元数据 IO、slug、diff、编辑器 |
| `contracts/` | 事件合约、Foundry 测试与部署记录 |
| `templates/new-blog.md` + `templates/new-blog.meta.yml` | 新文章模板，不参与编译；成对复制到 `content/` 后使用 |
| `.githooks/pre-commit` | 可选的内容校验钩子；`npm run hooks:install` 安装 |
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

1. **不手写日期**。元数据文件禁止 `date` / `pubDate` / `createdAt` / `updatedAt`。
2. **main 保持线性历史**。出现 merge commit 时编译会失败；PR 用 squash/rebase。
3. **id 发布后不改名**。需要改名时加 `aliases`。
4. **私钥、助记词、keystore 密码永不进入仓库、`.env`、对话或任何 Claude 可读取的文件**。开发签名用本机加密 keystore；CI 只在 anchor job 的 Environment secret `ANCHOR_PRIVATE_KEY` 中使用 burner 私钥，build job 不接触 secret。
5. **主题只做布局与 CSS**。不要读 `content/`、不要自己解析 Markdown、不要复制编译器逻辑。
6. **主题分支不提交 harness 生成物**：`package.json`、`astro.config.mjs`、`tsconfig.json`、`src/env.d.ts`、`src/generated/` 都被 `.gitignore` 忽略。
7. **build job 不接触敏感 secret**。只有 anchor job 读取 `ANCHOR_PRIVATE_KEY`；Cloudflare token 只在 deploy step。
8. 代码注释用英文；文档与 UI 文案用中文。
9. **主题不自己实现 dock/SW**：`sys.js` 与 `<sys-theme-dock>` 由构建期注入；主题只需设置 `<html data-theme-id={__THEME_ID__}>`，可选桥接 `--sys-*` CSS 变量。
10. **VFS 只放文本**：HTML/CSS/JS/JSON/SVG/XML/MD/TXT。图片等二进制走 R2（M3），不要塞进 VFS。
11. **VFS 文件名必须含内容哈希**：`/_themes/{id}.{vfsSha256}.vfs.json`；不要改成无哈希固定名再设 immutable。
12. **不要破坏 canonical 路径**：`index.html`→`/`，`n/foo.html`→`/n/foo`，`404.html`→`/404`。改动后跑 `npm run build:all` 与 `npm run test:e2e`。
13. **theme.contract.json 的 id 必须等于分支名**；只有 `theme/default` 允许 `isDefault: true`。
14. **首页节点**：主 Tag = `site.config.ts` 的 `homeTag`（默认 `首页`），全站最多一个已发布；`url='/'`，不生成 `/n/{id}`，从 `/archive`、RSS、sitemap、搜索中排除。主题用 `SiteData.homeNodeId` 找到它，并在 `/` 渲染其 HTML；索引页固定为 `/archive`。
15. **CLI 职责分离**：`scripts/blog` 负责 Git 写操作；`scripts/ai` 只读写目标文件，禁止 `git add/commit/push`。不要把一个命令的内部逻辑复制到另一个命令。
16. **AI 只在写作时调用**：`DEEPSEEK_API_KEY` 只从环境变量读取；构建、CI、Service Worker 都不调用模型。生成内容必须经用户确认后写入文件。
17. **`content/new-blog.md` 是保留 id**：不能提交；`scripts/blog` 提交前会把正文与 sidecar 一起重命名为 slug。模板源在 `templates/new-blog.md` 与 `templates/new-blog.meta.yml`。
18. **正文与元数据分离**：`.md` 只放正文，不得包含 `---` frontmatter；元数据放同名 `.meta.yml`。改标签只改 sidecar，不产生正文修订。
19. **锚定以 commit 为粒度**：链上只写 commit hash；索引在 `anchors` 孤儿分支的 `anchors.ndjson`，构建不联网。
20. **站点只认 config 里的 contract/sender**：链上事件可由任何人发；页面和索引按 `site.config.ts` 的 `chain.contract` / `chain.address` 过滤。

## 数据流

`content/*.md` + `content/*.meta.yml` → `core/content.ts` → `core/tree.ts` → `core/markdown.ts` → `core/git.ts` + `anchors` 分支 → `core/anchor-index.ts` → `core/anchors.ts` → `core/build.ts` → `build/generated/site-data.json` → 主题 `src/generated/site-data.json` → Astro 静态 HTML → `build-all` 注入 `sys.js`/dock → VFS + manifest + Service Worker → `dist/`。

主题只依赖 `SiteData`（见 `core/contract.ts`）。正文 HTML 已由编译器渲染好，主题用 `<Fragment set:html={node.html} />` 或 `<div set:html={node.html} />` 注入。

## 验证

```powershell
npm test
npm run typecheck
npm run blog -- check --json
npm run build:all
npm run serve
npm run test:e2e
npm run contract:test
npm run blog -- anchor --dry-run --commit <sha> --json
```

构建后检查 `dist/index.html`、`dist/n/*.html`、`dist/manifest.json`、`dist/sw.js`、`dist/_sys/sys.js`、`dist/_themes/*.vfs.json`、`dist/rss.xml`、`dist/sitemap.xml`、`dist/search-index.json`。开发时若 4321 被占用，Astro 会打印实际端口；`npm run serve` 默认 8080。

## 参考

- `ARCHITECTURE.md`：M1/M2 实现与 M3 接口。
- `CONTENT.md`：写作规范。
- `core/contract.ts`：唯一数据契约。
- `core/metadata.ts`：sidecar 路径、YAML 解析与序列化。
- `THEME_AGENT_PROMPT.md`：新主题的复制即用提示词。
