# 架构说明

本文记录 M1/M2 的实际实现，以及 M3 链上存证的实现与边界。目标是让未来的 AI 只读少量文件就能重写主题，而不会碰坏内容、时间与存证逻辑。

## 1. 核心原则

1. **内容与 UI 解耦**：`main` 负责内容、编译与契约；`theme/<id>` 分支只负责视图与样式。
2. **万物皆节点**：文章、想法、闪念、收藏都是 `.md`；主 Tag 决定形态，次 Tag 决定筛选与皮肤。
3. **时间不可手写**：日期由 Git 提交与链上锚定推导。
4. **追加优先**：新进展用 `extends` 新建节点；编辑只用于勘误。
5. **纯文本仓库**：Git 中不存图片等二进制；媒体走 R2 + 内容寻址（M3）。
6. **本地优先**：默认主题静态直出保 SEO；M2 用 Service Worker + VFS 做站内零延迟与主题切换。

## 2. M1 数据流

```text
content/*.md
  │  gray-matter + Zod
  ▼
ParsedContent ──► buildTree() ──► parent / ancestors / children / root
  │
  │  unified + remark + rehype + Shiki
  ▼
RenderedMarkdown (html / headings / plainText / excerpt / readingTime)
  │
  │  git log --follow + anchors 分支 (anchors.ndjson)
  ▼
RevisionProof[] ──► resolveAnchorTimes() ──► createdAt / updatedAt / displayTime
  │
  ▼
SiteData ──► build/generated/
             ├─ site-data.json
             ├─ search-index.json
             ├─ rss.xml / sitemap.xml / robots.txt
             └─ build-meta.json
```

### 关键文件

| 文件 | 职责 |
| --- | --- |
| `core/contract.ts` | 唯一数据契约；主题只能依赖它 |
| `core/schema.ts` | 元数据、anchor record、theme.contract 的 Zod 校验 |
| `core/metadata.ts` | `.meta.yml` 路径、YAML 解析/序列化、字段顺序 |
| `core/content.ts` | 成对发现 `.md` 正文与 `.meta.yml` 元数据 |
| `core/markdown.ts` | Markdown → HTML；GFM、GitHub alerts、Shiki 双主题 |
| `core/tree.ts` | `extends` 图；防断链/防环/别名；祖先与子节点 |
| `core/git.ts` | `git log --follow`、blob、diff、anchors 分支、工作区状态 |
| `core/anchor-index.ts` | `anchors.ndjson` 解析、commit 补零、记录过滤 |
| `core/anchors.ts` | 锚定覆盖与节点时间推导 |
| `core/build.ts` | 汇总 SiteData 并写出所有产物 |
| `scripts/prepare-theme.ts` | 把 harness 与生成数据注入主题 worktree |
| `scripts/dev.ts` | 编译 + 准备 + Astro dev + 监听 |
| `scripts/build.ts` | 编译 + 主题构建 + 组装 `dist/` |

## 3. 内容模型

每篇内容是一对文件：`content/{id}.md` 只放正文，`content/{id}.meta.yml` 放元数据。`.md` 不允许 `---` frontmatter。

元数据只允许：

```yaml
tags: 文章 建站        # 必填；空格分隔；第一个是主 Tag
title: 标题            # 可选
extends: parent-id    # 可选
description: 摘要      # 可选
url: https://...      # 可选；收藏类外链
aliases: [old-id]     # 可选
draft: false          # 可选
```

出现 `date`、`pubDate`、`createdAt`、`updatedAt` 等字段会直接报错。

- `id` = `content/` 下相对路径去掉 `.md`，URL 为 `/n/{id}`。
- 主 Tag 决定首页形态；显示策略在 `site.config.ts` 的 `ui.contentDisplay` 中：
  - `文章`：摘要 + 链接。
  - `想法`：正文 <= `maxChars` 时展开。
  - `闪念`：整条内联。
  - `收藏`：外链卡片。
  - 未知 Tag：回退 `excerpt`。
- `extends` 单向声明，编译期成树；断链/环/指向 draft 都会让编译失败。
- **首页节点**：主 Tag 等于 `site.config.ts` 的 `homeTag`（默认 `首页`）的节点。全站最多一个已发布首页节点；它的 `url` 被设为 `/`，不生成 `/n/{id}` 详情页，并从 `/archive`、RSS、sitemap、搜索中排除。`SiteData.homeNodeId` 告诉主题哪个节点是首页。
- **索引页**：`/archive`，渲染除首页节点外的全部内容；页头有“索引”链接。

## 4. 时间与存证

### 时间来源

- 每篇文章的修改历史来自 `git log --follow`。
- 每个 revision 记录 commit、Git 时间、unified diff、该版本原始 `.md` 的 SHA-256 与 Git blob SHA-1。
- 没有锚定时 `isVerified=false`；页面显示“尚无链上锚定记录”，排序使用最新 Git 时间。
- 工作区有未提交修改或文件未跟踪时，页面会标注；CI 构建要求工作区干净。

### 链上锚定（M3）

- 链：Base 主网（chainId 8453）；合约 `0x00000000009DE13419D7CFf80F6D2e1e992146aA`（deploy block 53014502），站点 sender 为 `0x000000000007C44d92De38e7CdBA161fE9CfBC4e`。
- 合约只发事件，不存状态、没有 owner、不可升级：
  `Anchored(address indexed sender, bytes32 indexed commit)`。
- 以 commit 为粒度；Git SHA-1 是 20 字节，右补零到 `bytes32`。
- 交易回执不写 `git notes`；索引放在孤儿分支 `anchors` 的 `anchors.ndjson`，作为构建的离线缓存。
- 编译期读 `refs/heads/anchors` 或 `refs/remotes/origin/anchors`，按 chain/contract/sender/repo 过滤；构建不联网。
- CI 在 `content/` 推送时自动锚定：anchor job 读 Environment secret `ANCHOR_PRIVATE_KEY`，build job 无 secret；`anchors` 分支可由链上事件重建。
- 合约源码、测试与部署记录在 `contracts/`；事件 topic0 为
  `0xee1610244dfc4b116b1433dd4459fd7b1d3d2bf737a05fc3f6d8f173005d7147`。

### 证明边界

链上只存 commit hash（事件/calldata），不存文件内容。Git commit 通过 tree/blob 密码学绑定内容，因此访客按三步核验：

1. 链上：打开交易，确认 `Anchored` 事件的 sender 与 commit；
2. GitHub：打开该 commit 与 `content/{id}.md`，确认是这一版正文；
3. 比对：GitHub API 返回的 blob `sha` 与页面上的 `gitBlobSha1` 一致。

页面不再生成 `raw/` 与 `proof/`；核验信息由 `site-data.json` 里的 revisions 提供，主题负责渲染链接。私有仓库阶段 GitHub 链接对外 404，链上交易仍可查；公开后三步核验才完整。

真正的 trustless 文件级证明需要把 `filesRoot` 写进 calldata 并附带 Merkle inclusion proof，列为后续增强。

## 5. 主题模型（混合模式）

- `theme/<id>` 是孤儿分支，只存：
  - `src/`（页面、布局、组件、样式）
  - `public/`
  - `theme.contract.json`
  - `theme.package.json`（可选，追加依赖）
  - `AGENTS.md`
- `theme-harness/` 在 main 上，提供 Astro 7 + Vite 8 + Tailwind 4 的固定工具链与 `vite.define` 宏。
- `scripts/prepare-theme.ts` 把 harness、`core/contract.ts`、`build/generated/site-data.json` 注入 worktree；这些文件被主题分支的 `.gitignore` 忽略。
- 主题只消费 `SiteData`，不直接读 `content/`，也不解析 Markdown。
- 构建期宏：`__THEME_ID__`、`__THEME_MODEL__`、`__THEME_GIT_HASH__`、`__THEME_UPDATED_AT__`、`__CONTENT_GIT_HASH__`、`__BUILD_TIME__`。
- `theme.contract.json` 的 `id` 必须与分支名一致；只有 `theme/default` 允许 `isDefault: true`。

## 6. M2：多主题、VFS 与 Service Worker（已实现）

### 6.1 构建流水线

`npm run build:all`（`scripts/build-all.ts`）：

1. 编译内容，生成 `build/generated/`。
2. 用 esbuild 构建 `host/sys.ts` → `build/runtime/sys.js`、`sw/sw.ts` → `build/runtime/sw.js`。
3. 发现 `refs/heads/theme/*` 与 `refs/remotes/origin/theme/*`；本地优先，CI 用远端 ref。
4. 对每个主题：`prepare-theme` → `astro build` → 注入 `/_sys/sys.js` 与 `<sys-theme-dock>`。
5. 打包 VFS、校验路由/资源/search（含 `/archive`；首页节点使用 `/`，不生成 `/n/home`），生成 manifest，组装 `dist/`。

### 6.2 VFS

```json
{
  "schema": 1,
  "themeId": "terminal",
  "files": {
    "/": { "type": "text/html; charset=utf-8", "body": "..." },
    "/n/iceberg": { "type": "text/html; charset=utf-8", "body": "..." },
    "/_astro/xxx.css": { "type": "text/css; charset=utf-8", "body": "..." },
    "/_sys/sys.js": { "type": "text/javascript; charset=utf-8", "body": "..." },
    "/search-index.json": { "type": "application/json; charset=utf-8", "body": "..." }
  }
}
```

- 路径归一化：`index.html` → `/`，`n/foo.html` → `/n/foo`，`404.html` → `/404`；非 ASCII 段用 `encodeURIComponent`。
- 文件名 `/_themes/{id}.{vfsSha256}.vfs.json`；manifest 记录同一哈希。无哈希文件名不能设 `immutable`。
- 体积硬上限 25MB/文件（Cloudflare Pages），5MB 起警告；当前每个主题约 113KB。

### 6.3 manifest 与 releaseId

- `manifest.json`：`releaseId`、`contentHash`、`anchorsHash`、`defaultTheme`、`site`、`chain`、`themes[]`。
- 每个主题：`id`、`displayName`、`model`、`description`、`author`、`isDefault`、`commit`、`updatedAt`、`vfsUrl`、`vfsSha256`、`sizeKB`。
- `releaseId = SHA-256(contentHash, anchorsHash, 站点配置, 主题 commits + VFS hashes)`；**不包含构建时间**。
- `anchorsHash` 去重后包含 chainId、contract、sender、tx、blockTimestamp；`manifest.chain` 带 `contract`/`deployBlock`/`address`。
- 主题 HTML 里的 `__CONTENT_GIT_HASH__` 取“最后一次修改 `content/` 的提交”，因此只改文档/脚本不会让所有客户端重新下载。

### 6.4 宿主运行时

- `host/sys.ts` 注册 `<sys-theme-dock>` 并注册 `/sw.js`。
- 存证 UI 在主题的 `Revisions.astro`；host 只负责 dock/SW，不做链上核验。
- 构建后注入每个主题 HTML：head 里的 `<script type="module" src="/_sys/sys.js">` 与 body 末尾的 `<sys-theme-dock>`；主题无需自己实现。
- dock 通过 MessageChannel 与 SW 通信：`GET_STATE`、`SET_THEME`；显示主题列表、commit、cached 状态与更新提示。
- 主题可通过 CSS 变量桥接配色：`--sys-bg`、`--sys-fg`、`--sys-muted`、`--sys-border`、`--sys-font`。

### 6.5 Service Worker

存储：

- IndexedDB `myblog-sw` / `meta`：`activeThemeId`、`activeReleaseId`、`previousReleaseId`、`manifest`、`lastCheckAt`、`pending*`。
- CacheStorage：`myblog-vfs-v1:<releaseId>:<themeId>` 每个主题一份；保留 active、previous、pending release。

启动与导航：

- `install`：拉 manifest，缓存 active theme（与默认主题）VFS，校验 SHA-256，`skipWaiting`。
- `activate`：`clients.claim()`。
- 导航：先 promote pending（若有），再按 `canonicalPath` 在 active VFS 查找；未命中依次尝试 previous release、默认主题、`/404`、网络。
- 子资源：任何同源 GET 先查 active/previous/default VFS，再走网络；`/sw.js`、`/manifest.json`、`/_themes/*` 明确绕过。
- 主题切换：`SET_THEME` → 拉取/校验/写入目标 VFS → 写 `activeThemeId` → ACK；页面 reload，URL 不变。
- 更新检查：导航/可见时惰性执行，先写 `lastCheckAt` 防抖；间隔由构建期 `__SW_CHECK_INTERVAL_MS__` 注入——本地默认 **1000ms**，CI/生产 **30 分钟**，可用 `SW_CHECK_INTERVAL_MS` 覆盖。dock 的“检查”按钮通过 `CHECK_UPDATE` 强制忽略 TTL。`releaseId` 变化时缓存新 VFS，设置 pending，发 `UPDATE_READY`；下一次导航自动 promote。
- `sw.js` 包含 `__SW_BUILD__` 构建标记：本地默认时间戳，CI 用 commit SHA；确保每次构建的 worker 字节变化，浏览器会安装新 worker。
- 生产自动更新：页面加载/重新可见时调用 `registration.update()` 并发送 `SOFT_CHECK`（尊重 TTL）；新 worker 用 `skipWaiting`/`clients.claim` 接管。`initialize` 发现 release 变化时设置 `updateReady`，`handleNavigation` 在首次导航消费后清除；dock 据此提示“刷新”。访客无需手动卸载 SW。
- 离线：文本资源来自 VFS；R2 图片需访问过才有缓存（M3）。

### 6.6 本地验证

- `npm run serve`：`scripts/serve.ts` 静态服务器（clean URL、SW 头、`_headers` 等价缓存头）。
- `npm run test:e2e`：`playwright-core` + 本机 Chrome，验证“默认主题 → SW 接管 → 切 Terminal → URL 不变 → 断网导航”。
- CI：`.github/workflows/build.yml` 在 main / theme 分支 push、手动触发或每日兜底时构建；`content/` 变化时先由 anchor job 锚定，再由无密钥的 build job 构建并上传 `dist` artifact。`theme/*` push 现在会触发 workflow（checkout main 再 fetch 主题分支）。build 成功后，独立的 deploy job 下载 artifact 并直传 Cloudflare Pages；只有 deploy job 读 `CLOUDFLARE_API_TOKEN`。

## 7. M3：媒体与部署

- 图片由 `scripts/upload-media.ts` 转 WebP/AVIF，按内容 SHA-256 命名，上传 Cloudflare R2（S3 兼容 API）。
- 仓库只出现 `https://cdn.<domain>/<sha256>.webp`。
- Cloudflare Pages 项目 `chenbase-blog`，生产域名 `https://chenbase.cc`（`www.chenbase.cc` 同一项目）。DNS 仍在阿里云：根域名与 `www` 都是 CNAME 到 `chenbase-blog.pages.dev`，Cloudflare 已完成验证并签发证书。
- 部署用 `wrangler pages deploy dist`；`_headers` 让 `manifest.json`/`sw.js` 不缓存，`/_themes/*` 与 `/_astro/*` 长缓存。
- 生产前先用测试提交跑通“锚定 → anchors 分支 → 构建 → 页面三步核验”，再锚定正式文章；合约已在 Base 主网部署。

## 8. 已知边界

- v1 要求 main 线性历史；出现 merge commit 时编译失败。
- `git log --follow` 对 rename/evil merge 有边界；id 发布后不应改名，改名需写 `aliases`。
- 博客短期 <100 篇，锚定覆盖使用最简单的 O(n) 线性扫描。
- 主题源码是可信代码，但仍保持 build/deploy 分离，构建 job 不挂敏感 secret。
- 三步核验依赖公开 GitHub 仓库；私有仓库阶段 GitHub 链接对外 404，链上交易仍可查。
- 离线只保证文本（HTML/CSS/JS/search）；R2 图片需被访问过才有本地缓存。
- 30 分钟更新检查是惰性的，SW 休眠时不保证按时轮询。
- VFS 单文件硬上限 25MB；当前每主题约 113KB。接近上限时再拆共享 content shard 或做压缩。
- SW 只保留 active / previous / pending release；更老的 tab 可能加载不到旧哈希资源。
- `npm run test:e2e` 依赖本机 Chrome，CI 只跑单元测试与 build:all 校验。
- `sw.js`、`sys.js` 不参与 VFS 内容哈希；靠 `Cache-Control: no-cache` 让浏览器重新校验。

## 9. 内容工作流 CLI

写作工具分成两个互不依赖的命令：

| 命令 | 研究对象 | 负责 | 禁止 |
| --- | --- | --- | --- |
| `npm run blog` | 仓库 / Git / 文件 | 状态检查、模板、校验、commit、push、anchor | 不改写正文语义 |
| `npm run ai` | 单个 `.md` + `.meta.yml` | 元数据建议、id（slug）建议与改名、语言建议/改写、未来翻译 | 不执行 Git 写操作 |

- `scripts/blog/state.ts` 采集 Git 与内容状态；`blocking` 直接阻止，`decision` 交给交互层，安全机械问题由 `scripts/shared/content-file.ts` 修复。
- `npm run blog -- anchor --dry-run --commit <sha> --json` 只读预检；`--recover-only` 从链上事件回填 `anchors` 索引；`--yes` 才会发交易。
- `scripts/blog/cli.ts` 用 `@clack/prompts` 做交互、`citty` 做子命令。非交互模式始终提供 `--json`，遇到需要决策的情况返回非零退出码而不是猜测。
- `scripts/ai/` 用 DeepSeek OpenAI 兼容端点：`deepseek-flash`、显式 `thinking: disabled`、`response_format: json_object`。1M 上下文只用于紧凑的节点索引 + 当前正文，不发送全站原文。
- AI 提案必须经用户确认；`--write` 才落盘。写入前校验文件哈希，写入后跑 `validateContent`，新增错误会回滚。
- `templates/new-blog.md` 不参与编译；`content/new-blog.md` 是保留 id，提交前自动改成 slug。
- 构建与 CI 不读取 `DEEPSEEK_API_KEY`，也不调用模型。

## 10. 参考

- Astro / Tailwind / Shiki / Zod 官方文档。
- Foundry `cast` 与 JSON-RPC 文档（本机离线资料库）。
- Cloudflare Pages / R2 文档（本机离线资料库）。
