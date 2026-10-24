# 架构说明

本文描述当前实现与边界，供维护者和主题作者阅读。写作规范见 [CONTENT.md](CONTENT.md)，贡献约束见 [AGENTS.md](AGENTS.md)。

## 1. 核心原则

1. **内容与 UI 解耦**：`main` 负责内容、编译与契约；`theme/<id>` 分支只负责视图与样式。
2. **万物皆节点**：文章、想法、闪念、收藏都是 `.md`；主 Tag 决定形态，次 Tag 决定筛选与皮肤。
3. **时间不可手写**：日期由 Git 提交与链上锚定推导。
4. **追加优先**：新进展用 `extends` 新建节点；编辑只用于勘误。
5. **纯文本仓库**：Git 中不存图片等二进制；媒体以后走对象存储，目前用外链。
6. **本地优先**：默认主题静态直出保 SEO；Service Worker + VFS 负责站内零延迟与主题切换。

## 2. 数据流

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

### 模块职责

| 文件 | 职责 |
| --- | --- |
| `core/contract.ts` | 唯一数据契约；主题只能依赖它 |
| `core/schema.ts` | 元数据、anchor record、theme.contract 的 Zod 校验 |
| `core/metadata.ts` | `.meta.yml` 路径、YAML 解析/序列化、字段顺序 |
| `core/content.ts` / `core/tree.ts` | 成对发现正文与元数据；解析 `extends` 图，防断链/环/别名 |
| `core/markdown.ts` | Markdown → HTML；GFM、GitHub alerts、MathJax、Shiki 双主题 |
| `core/git.ts` | `git log --follow`、blob、diff、anchors 分支、工作区状态 |
| `core/anchor-index.ts` / `core/anchors.ts` | `anchors.ndjson` 解析、commit 补零、锚定覆盖与时间推导 |
| `core/build.ts` | 汇总 `SiteData` 并写出所有产物 |
| `scripts/prepare-theme.ts` / `scripts/dev.ts` | 注入 harness 与生成数据；编译 + Astro dev + 监听 |
| `scripts/build-all.ts` / `scripts/build.ts` | 多主题构建、VFS、manifest、`dist/` 组装 |

## 3. 内容模型

每篇内容是一对文件：`content/{id}.md` 只放正文，`content/{id}.meta.yml` 放元数据。字段、主 Tag、`extends`、草稿与首页写法以 [CONTENT.md](CONTENT.md) 为准。

编译期只关心这些约束：

- `id` 是 `content/` 下的相对路径去掉 `.md`，详情页为 `/n/{id}`；发布后不改名，改名需写 `aliases`。
- 主 Tag 决定首页形态（摘要、展开、整条内联、外链卡片）；未知 Tag 回退为摘要。
- `extends` 单向声明并成树；断链、成环、指向 draft 都会让编译失败。
- 主 Tag 等于 `site.config.ts` 的 `homeTag` 的节点是首页：全站至多一个已发布节点，其 `url` 为 `/`，不生成 `/n/{id}`，并从索引、RSS、sitemap、搜索中排除。`SiteData.homeNodeId` 告诉主题是哪一个。
- 文章索引固定为 `/archive`，渲染除首页节点外的全部内容。

## 4. 时间与存证

### 时间来源

- 每个节点的修改历史来自 `git log --follow`。
- 每个 revision 记录 commit、Git 时间、unified diff、该版本正文的 SHA-256 与 Git blob SHA-1。
- 没有锚定时 `isVerified=false`，排序使用最新 Git 时间；工作区有未提交修改或文件未跟踪时，页面会标注。
- CI 构建要求工作区干净。

### 链上锚定

- 链：Base 主网（chainId 8453）；合约 `0x00000000009DE13419D7CFf80F6D2e1e992146aA`，站点 sender 为 `0x000000000007C44d92De38e7CdBA161fE9CfBC4e`。
- 合约只发事件，不存状态、没有 owner、不可升级：`Anchored(address indexed sender, bytes32 indexed commit)`。
- 以 commit 为粒度；Git SHA-1 是 20 字节，右补零到 `bytes32`。
- 索引放在孤儿分支 `anchors` 的 `anchors.ndjson`，作为构建的离线缓存；链上事件是可枚举的真相源，索引可由事件重建。
- 编译期读 `refs/heads/anchors` 或 `refs/remotes/origin/anchors`，按 chain / contract / sender / repo 过滤，构建不联网。
- CI 在 `content/` 变化时自动锚定：anchor job 读 Environment secret `ANCHOR_PRIVATE_KEY`，build job 无 secret。

### 证明边界

链上只存 commit hash，不存文件内容。Git commit 通过 tree/blob 密码学绑定内容，因此访客按三步核验：

1. 链上：打开交易，确认 `Anchored` 事件的 sender 与 commit；
2. GitHub：打开该 commit 与 `content/{id}.md`，确认是这一版正文；
3. 比对：GitHub API 返回的 blob `sha` 与页面上的 `gitBlobSha1` 一致。

核验信息由 `site-data.json` 的 revisions 提供，主题负责渲染链接。

## 5. 主题模型

- `theme/<id>` 是孤儿分支，只存 `src/`、`public/`、`theme.contract.json`、可选的 `theme.package.json` 与 `AGENTS.md`。
- `theme-harness/` 在 main 上，提供 Astro 7 + Tailwind 4 的固定工具链与 Vite define 宏。
- `scripts/prepare-theme.ts` 把 harness、`core/contract.ts`、`build/generated/site-data.json` 注入 worktree；这些文件被主题分支的 `.gitignore` 忽略。
- 主题只消费 `SiteData`，不直接读 `content/`，也不解析 Markdown。正文 HTML 已由编译器渲染好，用 `<Fragment set:html={node.html} />` 注入。
- 构建期宏：`__THEME_ID__`、`__THEME_MODEL__`、`__THEME_GIT_HASH__`、`__THEME_UPDATED_AT__`、`__CONTENT_GIT_HASH__`、`__BUILD_TIME__`。
- `theme.contract.json` 的 `id` 必须与分支名一致；只有 `theme/default` 允许 `isDefault: true`。

## 6. 构建、VFS 与运行时

### 构建流水线

`npm run build:all`（`scripts/build-all.ts`）：

1. 编译内容，生成 `build/generated/`。
2. 用 esbuild 构建 `host/sys.ts` → `build/runtime/sys.js`、`sw/sw.ts` → `build/runtime/sw.js`。
3. 发现 `refs/heads/theme/*` 与 `refs/remotes/origin/theme/*`；本地优先，CI 用远端 ref。
4. 对每个主题：`prepare-theme` → `astro build` → 注入 `/_sys/sys.js` 与 `<sys-theme-dock>`。
5. 打包 VFS、校验路由/资源/search，生成 manifest，组装 `dist/`。

### VFS

```json
{
  "schema": 1,
  "themeId": "terminal",
  "files": {
    "/": { "type": "text/html; charset=utf-8", "body": "..." },
    "/n/iceberg": { "type": "text/html; charset=utf-8", "body": "..." },
    "/_astro/xxx.css": { "type": "text/css; charset=utf-8", "body": "..." }
  }
}
```

- 路径归一化：`index.html` → `/`，`n/foo.html` → `/n/foo`，`404.html` → `/404`；非 ASCII 段用 `encodeURIComponent`。
- 文件名 `/_themes/{id}.{vfsSha256}.vfs.json`；manifest 记录同一哈希。无哈希文件名不能设 `immutable`。
- 只放文本：HTML/CSS/JS/JSON/SVG/XML/MD/TXT；单文件硬上限 25MB，5MB 起警告。

### manifest 与 releaseId

- `manifest.json`：`releaseId`、`contentHash`、`anchorsHash`、`defaultTheme`、`site`、`chain`、`themes[]`。
- 每个主题：`id`、`displayName`、`model`、`description`、`author`、`isDefault`、`commit`、`updatedAt`、`vfsUrl`、`vfsSha256`、`sizeKB`。
- `releaseId = SHA-256(contentHash, anchorsHash, 站点配置, 主题 commits + VFS hashes)`，**不包含构建时间**。
- `anchorsHash` 去重后包含 chainId、contract、sender、tx、blockTimestamp；`manifest.chain` 带 `contract` / `deployBlock` / `address`。
- 主题 HTML 里的 `__CONTENT_GIT_HASH__` 取“最后一次修改 `content/` 的提交”，只改文档或脚本不会让客户端重新下载。

### 宿主运行时

- `host/sys.ts` 注册 `<sys-theme-dock>` 并注册 `/sw.js`；构建后注入每个主题 HTML。
- dock 通过 MessageChannel 与 SW 通信：`GET_STATE`、`SET_THEME`；显示主题列表、commit、cached 状态与更新提示。
- 存证 UI 在主题的 `Revisions.astro`；host 只负责 dock 与 SW。
- 主题可通过 CSS 变量桥接配色：`--sys-bg`、`--sys-fg`、`--sys-muted`、`--sys-border`、`--sys-font`。

### Service Worker

- IndexedDB `myblog-sw` / `meta`：`activeThemeId`、`activeReleaseId`、`previousReleaseId`、`manifest`、`lastCheckAt`、`pending*`。
- CacheStorage：`myblog-vfs-v1:<releaseId>:<themeId>` 每个主题一份；只保留 active、previous、pending release。
- `install` 拉 manifest、缓存 active 与默认主题 VFS、校验 SHA-256 后 `skipWaiting`；`activate` 调 `clients.claim()`。
- 导航先 promote pending，再按 canonicalPath 查 active VFS；未命中依次尝试 previous release、默认主题、`/404`、网络。子资源同样先查 VFS，`/sw.js`、`/manifest.json`、`/_themes/*` 明确绕过。
- `SET_THEME` 拉取并校验目标 VFS、写入 `activeThemeId` 后 ACK，页面 reload，URL 不变。
- 更新检查是惰性的：导航或页面可见时执行，先写 `lastCheckAt` 防抖；间隔由构建期 `__SW_CHECK_INTERVAL_MS__` 注入（本地 1000ms，CI/生产 30 分钟，可用 `SW_CHECK_INTERVAL_MS` 覆盖）。dock 的“检查”按钮通过 `CHECK_UPDATE` 强制忽略 TTL。
- 生产自动更新：`sys.js` 在页面加载/重新可见时调用 `registration.update()` 并发送 `SOFT_CHECK`；新 worker 用 `skipWaiting`/`clients.claim` 接管，release 变化时 dock 提示刷新。
- **7 天自毁**：首次安装时在 `myblog-lifecycle-v1` 写入 first-seen 时间；满 7 天后清理全部缓存、广播 `CACHE_RESET`、注销自身，dock 提示“缓存已重置，刷新后生效”。
- `sw.js` 含 `__SW_BUILD__` 标记：本地默认时间戳，CI 用 commit SHA，确保每次构建的 worker 字节变化。
- 离线只覆盖文本资源；图片需访问过才有浏览器 HTTP 缓存。

### 不变量

- VFS 文件名必须含内容哈希；canonical 路径固定为 `index.html` → `/`、`n/foo.html` → `/n/foo`、`404.html` → `/404`。
- `theme.contract.json` 的 `id` 等于分支名；只有 `theme/default` 可设 `isDefault: true`。
- 全站至多一个已发布首页节点；它不生成 `/n/{id}`。
- `sw.js`、`sys.js` 不参与 VFS 内容哈希，靠 `Cache-Control: no-cache` 重新校验。

### 本地验证

- `npm run serve`：静态服务器，模拟 clean URL、SW 头与 `_headers` 缓存策略。
- `npm run test:e2e`：`playwright-core` + 本机 Chrome，验证默认主题 → SW 接管 → 切主题 → URL 不变 → 断网导航。
- CI：`.github/workflows/build.yml` 在 main push、手动触发或每日兜底时构建。主题分支没有自己的 workflow 文件，主题 push 不会直接触发；其改动由下一次 main push、手动 dispatch 或每日任务带入。`content/` 变化时先锚定，再由无密钥的 build job 构建并上传 artifact，最后由独立 deploy job 发布。

## 7. 部署与缓存

- Cloudflare Pages 项目 `chenbase-blog`，生产域名 `https://chenbase.cc`（`www` 同一项目）。
- 部署用 `wrangler pages deploy dist`。仓库 secret `CLOUDFLARE_API_TOKEN`（仅 Pages 权限）与 `CLOUDFLARE_ACCOUNT_ID` 只被 deploy job 读取；anchor job 只读 `ANCHOR_PRIVATE_KEY`。
- `_headers`：`manifest.json` / `sw.js` 不缓存，`/_themes/*` 与 `/_astro/*` 长缓存并 immutable。

## 8. 已知边界

- `main` 要求线性历史；出现 merge commit 时编译失败。
- `git log --follow` 对 rename / evil merge 有边界；id 发布后不应改名。
- 面向短期个人博客，锚定覆盖使用 O(n) 线性扫描。
- 主题源码是可信代码，但仍保持 build/deploy 分离，构建 job 不挂敏感 secret。
- 三步核验依赖公开的 GitHub 仓库；链上交易本身始终可查。
- 图床尚未实现，图片暂用外链，不要提交二进制。
- 更新检查是惰性的，SW 休眠时不保证按时轮询；只保留 active / previous / pending 三个 release，更老的标签页可能加载不到旧哈希资源。
- `npm run test:e2e` 依赖本机 Chrome，CI 只跑单元测试与 `build:all` 校验。

## 9. 写作工具边界

| 命令 | 负责 | 禁止 |
| --- | --- | --- |
| `npm run blog` | 仓库状态检查、模板、校验、commit/push、anchor | 不改写正文语义 |
| `npm run ai` | 单个 `.md` + `.meta.yml` 的元数据、id、语言建议 | 不执行 Git 写操作 |

`blog anchor` 默认只预检；`--recover-only` 从链上事件回填索引；`--yes` 才发交易。AI 提案必须经用户确认，`--write` 才落盘；构建与 CI 不读取 `DEEPSEEK_API_KEY`，也不调用模型。

## 10. 参考

- Astro、Tailwind CSS、Shiki、Zod 官方文档。
- Foundry `cast` 与 JSON-RPC 文档。
- Cloudflare Pages 与 Wrangler 文档。
