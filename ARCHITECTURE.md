# 架构说明

本文记录 M1 的实际实现，以及 M2/M3 已经定下的接口与边界。目标是让未来的 AI 只读少量文件就能重写主题，而不会碰坏内容、时间与存证逻辑。

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
  │  git log --follow + git notes
  ▼
RevisionProof[] ──► resolveAnchorTimes() ──► createdAt / updatedAt / displayTime
  │
  ▼
SiteData ──► build/generated/
             ├─ site-data.json
             ├─ search-index.json
             ├─ rss.xml / sitemap.xml / robots.txt
             ├─ raw/{id}.md
             ├─ proof/{id}.json
             └─ build-meta.json
```

### 关键文件

| 文件 | 职责 |
| --- | --- |
| `core/contract.ts` | 唯一数据契约；主题只能依赖它 |
| `core/schema.ts` | frontmatter、anchor note、theme.contract 的 Zod 校验 |
| `core/content.ts` | 发现 `.md`、解析 frontmatter |
| `core/markdown.ts` | Markdown → HTML；GFM、GitHub alerts、Shiki 双主题 |
| `core/tree.ts` | `extends` 图；防断链/防环/别名；祖先与子节点 |
| `core/git.ts` | `git log --follow`、blob、diff、notes、工作区状态 |
| `core/anchors.ts` | 锚定覆盖与节点时间推导 |
| `core/build.ts` | 汇总 SiteData 并写出所有产物 |
| `scripts/prepare-theme.ts` | 把 harness 与生成数据注入主题 worktree |
| `scripts/dev.ts` | 编译 + 准备 + Astro dev + 监听 |
| `scripts/build.ts` | 编译 + 主题构建 + 组装 `dist/` |

## 3. 内容模型

Frontmatter 只允许：

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

### M1

- 每篇文章的修改历史来自 `git log --follow`。
- 每个 revision 记录 commit、Git 时间、unified diff、该版本原始 `.md` 的 SHA-256。
- 没有锚定时 `isVerified=false`；页面显示“尚无链上锚定记录”，排序使用最新 Git 时间。
- 工作区有未提交修改或文件未跟踪时，页面会标注；CI 构建要求工作区干净。

### M3（已定接口）

- 以 Git commit 为粒度，把 `BLOG_ANCHOR|repo:...|commit:<sha>` 写进 Base Sepolia 自转账 calldata。
- 交易回执写入 `git notes --ref=blockchain`，不改变 commit hash。
- 编译期按“线性扫描 + 最近锚定后代”推导 `verifiedAt`；`proof/{id}.json` 已按最终形态输出。
- 签名使用本机专用 burner 钱包的加密 keystore：

```powershell
cast send <self> --from <address> --data 0x... `
  --keystore <dir> --account blog-anchor --password-file <path> `
  --rpc-url https://sepolia.base.org --async
```

keystore 与密码文件都在仓库外，脚本只拿路径，不读取内容。不使用 GitHub Actions 存放私钥。

### 证明边界

Git commit 通过 tree/blob 密码学绑定了文件内容，但链上只存 commit hash。访客要验证“眼前文件属于该 commit”，必须从 GitHub 等来源取得 tree/blob 数据，再用本地 SHA-256 / Git blob SHA-1 比对。因此 M3 的 `sys-chain-proof` 做三级核验：

1. 链上 calldata 与页面的 anchor commit 匹配；
2. GitHub 确认该 commit 的 tree 中存在该路径，并给出 blob SHA-1；
3. 本地 raw 字节的 SHA-256 与 proof JSON 一致，Git blob SHA-1 与 GitHub blob SHA 一致。

这仍依赖 GitHub 的数据可用性。真正的 trustless 文件级证明需要把 `filesRoot` 写进 calldata 并附带 Merkle inclusion proof，列为后续增强。

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
5. 打包 VFS、校验路由/资源/raw/proof/search（含 `/archive`；首页节点使用 `/`，不生成 `/n/home`），生成 manifest，组装 `dist/`。

### 6.2 VFS

```json
{
  "schema": 1,
  "themeId": "terminal",
  "files": {
    "/": { "type": "text/html; charset=utf-8", "body": "..." },
    "/n/hello": { "type": "text/html; charset=utf-8", "body": "..." },
    "/_astro/xxx.css": { "type": "text/css; charset=utf-8", "body": "..." },
    "/_sys/sys.js": { "type": "text/javascript; charset=utf-8", "body": "..." },
    "/raw/hello.md": { "type": "text/markdown; charset=utf-8", "body": "..." },
    "/proof/hello.json": { "type": "application/json; charset=utf-8", "body": "..." },
    "/search-index.json": { "type": "application/json; charset=utf-8", "body": "..." }
  }
}
```

- 路径归一化：`index.html` → `/`，`n/foo.html` → `/n/foo`，`404.html` → `/404`；非 ASCII 段用 `encodeURIComponent`。
- 文件名 `/_themes/{id}.{vfsSha256}.vfs.json`；manifest 记录同一哈希。无哈希文件名不能设 `immutable`。
- 体积硬上限 25MB/文件（Cloudflare Pages），5MB 起警告；当前每个主题约 110KB。

### 6.3 manifest 与 releaseId

- `manifest.json`：`releaseId`、`contentHash`、`anchorsHash`、`defaultTheme`、`site`、`chain`、`themes[]`。
- 每个主题：`id`、`displayName`、`model`、`description`、`author`、`isDefault`、`commit`、`updatedAt`、`vfsUrl`、`vfsSha256`、`sizeKB`。
- `releaseId = SHA-256(contentHash, anchorsHash, 站点配置, 主题 commits + VFS hashes)`；**不包含构建时间**。
- 主题 HTML 里的 `__CONTENT_GIT_HASH__` 取“最后一次修改 `content/` 的提交”，因此只改文档/脚本不会让所有客户端重新下载。

### 6.4 宿主运行时

- `host/sys.ts` 注册 `<sys-theme-dock>` 并注册 `/sw.js`。
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
- 30 分钟检查：导航/可见时惰性执行，先写 `lastCheckAt` 防抖；`releaseId` 变化时缓存新 VFS，设置 pending，发 `UPDATE_READY`；下一次导航自动 promote。
- 离线：文本资源来自 VFS；R2 图片需访问过才有缓存（M3）。

### 6.6 本地验证

- `npm run serve`：`scripts/serve.ts` 静态服务器（clean URL、SW 头、`_headers` 等价缓存头）。
- `npm run test:e2e`：`playwright-core` + 本机 Chrome，验证“默认主题 → SW 接管 → 切 Terminal → URL 不变 → 断网导航”。
- CI：`.github/workflows/build.yml` 在 main push / 手动 / 每 30 分钟构建，上传 `dist` artifact；不带 deploy，避免 build job 接触 Cloudflare token。`theme/*` push 不会自动触发 main 的 workflow。

## 7. M3：媒体与部署

- 图片由 `scripts/upload-media.ts` 转 WebP/AVIF，按内容 SHA-256 命名，上传 Cloudflare R2（S3 兼容 API）。
- 仓库只出现 `https://cdn.<domain>/<sha256>.webp`。
- Cloudflare Pages 用 `wrangler pages deploy dist`；`_headers` 让 `manifest.json`/`sw.js` 不缓存，`/_themes/*` 与 `/_astro/*` 长缓存。
- 生产前在 Base Sepolia 跑通“提交 → 锚定 → notes → 编译 → 浏览器核验”全流程，再切 Base 主网。

## 8. 已知边界

- v1 要求 main 线性历史；出现 merge commit 时编译失败。
- `git log --follow` 对 rename/evil merge 有边界；id 发布后不应改名，改名需写 `aliases`。
- 博客短期 <100 篇，锚定覆盖使用最简单的 O(n) 线性扫描。
- 主题源码是可信代码，但仍保持 build/deploy 分离，构建 job 不挂敏感 secret。
- 一键核验依赖公开 GitHub 仓库；私有仓库时 `sys-chain-proof` 降级。
- 离线只保证文本（HTML/CSS/JS/raw/proof/search）；R2 图片需被访问过才有本地缓存。
- 30 分钟更新检查是惰性的，SW 休眠时不保证按时轮询。
- VFS 单文件硬上限 25MB；当前每主题约 110KB。接近上限时再拆共享 content shard 或做压缩。
- SW 只保留 active / previous / pending release；更老的 tab 可能加载不到旧哈希资源。
- `npm run test:e2e` 依赖本机 Chrome，CI 只跑单元测试与 build:all 校验。
- `sw.js`、`sys.js` 不参与 VFS 内容哈希；靠 `Cache-Control: no-cache` 让浏览器重新校验。

## 9. 参考

- Astro / Tailwind / Shiki / Zod 官方文档。
- Foundry `cast` 与 JSON-RPC 文档（本机离线资料库）。
- Cloudflare Pages / R2 文档（本机离线资料库）。
