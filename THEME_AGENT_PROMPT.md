# 新主题提示词

把下面这段整段复制给未来的模型。它只实现 UI，不碰数据层。

---

你在一个个人博客仓库的 `theme/<id>` 孤儿分支上工作。仓库根目录是 `D:\websites\myblog\repo`，主题 worktree 在 `.worktrees/<id>`。

## 先读

1. `AGENTS.md`
2. `ARCHITECTURE.md`
3. `src/generated/contract.ts`
4. `src/generated/site-data.json` 的结构（可以只读前 200 行）

## 你只能修改

- `src/**`
- `public/**`
- `theme.contract.json`
- `theme.package.json`（可选；只加必要的依赖，写死版本）

## 绝对不要修改

- `src/generated/**`（编译器生成）
- `package.json`、`astro.config.mjs`、`tsconfig.json`、`src/env.d.ts`（harness 注入）
- `core/`、`scripts/`、`theme-harness/`（在 main 分支）
- 不要读 `content/`，不要自己解析 Markdown

## 运行时注入

`build:all` 会自动在每个 HTML 里注入：

```html
<script type="module" src="/_sys/sys.js"></script>
<sys-theme-dock></sys-theme-dock>
```

所以**不要**自己实现主题切换器或注册 Service Worker。你只需：

- 在 `<html>` 上设置 `data-theme-id={__THEME_ID__}`（用于端到端验证与调试）。
- 可选地在 CSS 里桥接 dock 配色：
  ```css
  sys-theme-dock {
    --sys-bg: var(--surface);
    --sys-fg: var(--text);
    --sys-muted: var(--muted);
    --sys-border: var(--border);
    --sys-font: var(--font-mono);
  }
  ```

## 必须实现的路由

- `/`：首页时间流。按 `node.displayDate.year` 分组；按 `site.ui.contentDisplay` 决定展开策略：
  - `文章`：摘要 + 链接
  - `想法`：`plainTextLength <= maxChars` 时展开全文
  - `闪念`：整条内联
  - `收藏`：外链卡片
  - 未知主 Tag：摘要
- `/n/{id}`：详情页。正文用 `<div class="prose" set:html={node.html} />`；展示 `node.parent` 的前情提要、`node.children` 的后续进展、`node.revisions` 的修订与存证。
- `/404`。

## 数据契约

只使用 `src/generated/contract.ts` 中的 `SiteData` / `ContentNode` / `NodeRef`。关键字段：

- `site.title` / `site.description` / `site.url` / `site.buildId` / `site.ui`
- `node.id` / `node.url` / `node.primaryTag` / `node.rawTags`
- `node.html`（已渲染的 Markdown）
- `node.displayTitle` / `node.excerpt` / `node.displayDate`
- `node.parent` / `node.ancestors` / `node.children`
- `node.revisions` / `node.isVerified` / `node.isDirty` / `node.isUntracked`

## 设计约束

- 简约、单栏、阅读宽度约 43rem；无封面图、无卡片阴影。
- 用 `oklch()` + `light-dark()` 定义灰阶；不要引入刺眼的彩色。
- 日期与数字用等宽字体；标题 `text-wrap: balance`，正文 `text-wrap: pretty`。
- 默认不引入客户端框架；交互用原生 HTML/CSS 与少量 vanilla JS。
- 渐进增强：无 JS 时至少能完整阅读。
- View Transitions 用原生 `@view-transition`，不要引入 Astro `<ClientRouter />`。
- 代码注释英文；UI 文案中文。

## 完成后

在 worktree 根目录运行：

```powershell
npm run build
```

确认 `dist/index.html`、`dist/n/*.html`、`dist/404.html` 都存在。回到 main 后可以跑：

```powershell
npm run build:all
npm run serve
npm run test:e2e
```

验证该主题能被打包、切换与离线访问。然后在 `theme/<id>` 分支提交：

```powershell
git add src public theme.contract.json theme.package.json
git commit -m "feat: add <id> theme"
```

不要提交 `package.json`、`astro.config.mjs`、`tsconfig.json`、`src/env.d.ts`、`src/generated/`、`node_modules/`、`dist/`。
