# myblog

一个面向 AI 主题生成、Git/链上时间戳与本地优先体验的个人博客。

当前状态：**M1 + M2 已完成**。

- M1：内容编译器、默认主题、本地开发与静态构建。
- M2：多主题构建、VFS、`manifest.json`、Service Worker 主题切换、离线访问、宿主主题 dock、本地预览服务器与真实浏览器端到端测试。
- M3（未实现）：Base Sepolia 链上锚定、R2 图床、Cloudflare Pages 部署。

## 快速开始

要求 Node.js >= 22.22。

```powershell
cd repo
npm install
npm run dev
```

`npm run dev` 编译内容、把共享工具链注入 `.worktrees/default`，然后在默认主题 worktree 里启动 Astro dev。若 4321 端口被占用，Astro 会打印实际端口。

开发另一个主题：

```powershell
npm run dev -- terminal
```

## 构建与预览

```powershell
npm run build       # 只构建默认主题，输出 dist/
npm run build:all   # 构建所有 theme/*，打包 VFS + manifest，组装完整 dist/
npm run serve       # 本地静态服务器，默认 http://127.0.0.1:8080
npm run test:e2e    # 无头 Chrome：SW 接管 → 切主题 → URL 不变 → 断网可用
```

`npm run test:e2e` 需要本机 Chrome；可通过 `CHROME_PATH` 指定路径。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | 只运行内容编译器 |
| `npm run prepare-theme -- <id>` | 准备某个主题的 worktree 与依赖 |
| `npm test` | Vitest 单元/集成测试 |
| `npm run typecheck` | 主程序 + Service Worker 类型检查 |
| `npm run build:runtime` | 单独构建 `host/sys.ts` 与 `sw/sw.ts` |

## 首页与索引

- `content/home.md`（主 Tag `首页`，可在 `site.config.ts` 的 `homeTag` 修改）渲染在 `/`，用来写自我介绍。
- 全站只能有一个已发布的首页节点；它会从索引、RSS、sitemap、搜索中排除。
- 文章索引在 `/archive`，页头有“索引”链接。
- 首页节点不生成 `/n/{id}` 详情页，但仍保留 raw/proof 存证产物。

## 开发期 Service Worker 更新

- 本地 `npm run build:all` 默认把内容更新检查间隔设为 **1000ms**；CI 设为 **30 分钟**。
- 如需覆盖：

  ```powershell
  $env:SW_CHECK_INTERVAL_MS = 1000
  npm run build:all
  ```

- 每次本地构建默认生成新的 `SW_BUILD_ID`（时间戳），`sw.js` 字节会变化，浏览器下次加载会安装新 worker；CI 使用 commit SHA。
- 打开主题 dock，点“检查”可强制立即检查 `manifest.json`；有新内容时会出现“刷新”。
- 如果浏览器仍然停留在旧 SW：DevTools → Application → Service Workers → **Update** 或 **Unregister**，然后硬刷新；或清除该站点的站点数据。
- 控制台会打印 `[sw] build ...; update check interval ...ms`，可据此确认版本与间隔。

## 主题博物馆

M2 内置两个主题：

- `theme/default`：Default Minimal，默认铺在根路径。
- `theme/terminal`：Terminal，深色等宽终端风。

构建后 `dist/` 同时包含：

```text
index.html / n/*.html / 404.html     # 默认主题（SEO 直出）
_themes/default.<sha>.vfs.json       # 全站文本 VFS
_themes/terminal.<sha>.vfs.json
manifest.json                        # releaseId + 主题元数据
sw.js                                # Service Worker
_sys/sys.js                          # 主题 dock + SW 注册
_headers                             # Cloudflare Pages 缓存策略
raw/ proof/ search-index.json        # 共享文本产物
```

浏览器首次加载默认主题；Service Worker 激活后，右下角出现 `Themes` 胶囊。切换主题时 URL 不变，SW 从本地 VFS 返回目标主题的 HTML/CSS/JS。已缓存过的站内导航与断网导航都不需要网络。

## 仓库结构

```text
content/          所有 .md 内容
core/             编译器、契约、Git/锚定、VFS 纯逻辑
host/             sys-theme-dock 宿主组件（TypeScript）
sw/               Service Worker（TypeScript）
scripts/          compile / prepare-theme / dev / build / build-all / serve / e2e
theme-harness/    Astro + Tailwind 共享工具链（main）
tests/            Vitest
.worktrees/       theme/* 分支的本地 worktree（gitignore）
build/generated/  编译器产物（gitignore）
build/runtime/    sys.js / sw.js（gitignore）
dist/             最终部署产物（gitignore）
```

## 分支

- `main`：内容、编译器、契约、运行时、构建脚本、文档。
- `theme/default`：默认主题 UI（孤儿分支）。
- `theme/terminal`：终端风参考主题（孤儿分支）。

主题分支只提交 `src/`、`public/`、`theme.contract.json`、可选 `theme.package.json`、`AGENTS.md`；harness 与 `src/generated/` 由脚本注入并忽略。

## 离线与缓存边界

- 离线保证 HTML/CSS/JS、raw、proof、search-index 等**文本**可用。
- R2 图片只有被访问过才在本地缓存（M3）。
- 更新检查是**惰性**的：只在导航/页面可见时执行，且距上次检查至少 30 分钟；SW 休眠时不保证按时轮询。
- VFS 单文件硬上限 25MB（Cloudflare Pages）；初期约 110KB/主题。

## 内容与时间

- 内容只写标准 Markdown，frontmatter 至少要有 `tags`。
- **不允许手写日期**。时间来自 Git 提交；链上锚定在 M3 接入后，以区块时间为权威。
- 主 Tag 决定形态：`文章`、`想法`、`闪念`、`收藏`，也允许未来任意新 Tag；没有专门样式时自动回退。
- 新进展通过 `extends` 新建节点，不直接改写旧文章。

详见 [CONTENT.md](CONTENT.md)。

## 设计文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：整体架构、M1/M2 实现、M3 接口与边界。
- [AGENTS.md](AGENTS.md)：给未来 AI 的工作约束。
- [THEME_AGENT_PROMPT.md](THEME_AGENT_PROMPT.md)：新主题的复制即用提示词。

## 语言约定

- 代码注释、变量名、提交信息：英文。
- 文档与站点 UI 文案：中文。

## 安全

私钥、助记词与 keystore 密码不得进入仓库、`.env`、对话或任何 Claude 可读取的文件。链上锚定使用本机专用 burner 钱包的加密 keystore，详见 `ARCHITECTURE.md`。
