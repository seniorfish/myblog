# 新主题提示词

把下面这段整段复制给未来的模型。它只实现 UI，不碰数据层。

---

你在一个个人博客仓库的 `theme/<id>` 孤儿分支上工作。`main` 分支在同一个仓库的另一个 worktree 中；需要了解全貌时先读 main 分支的 `AGENTS.md` 与 `ARCHITECTURE.md`。

## 先读

1. main 分支的 `AGENTS.md`
2. main 分支的 `ARCHITECTURE.md`（主题模型、VFS 与运行时不变量）
3. 当前 worktree 的 `src/generated/contract.ts`（唯一数据契约）

## 编辑范围

只允许修改：

- `src/**`
- `public/**`
- `theme.contract.json`
- `theme.package.json`（可选；只加必要依赖，版本写死）

不要修改 `src/generated/**`、`package.json`、`astro.config.mjs`、`tsconfig.json`、`src/env.d.ts`、`core/`、`scripts/`、`theme-harness/`。不要读 `content/`，不要自己解析 Markdown。

## 运行时注入

`build:all` 会在每个 HTML 中注入 `/_sys/sys.js` 与 `<sys-theme-dock>`。不要自己实现主题切换器或注册 Service Worker。你只需：

- 在 `<html>` 上设置 `data-theme-id={__THEME_ID__}`。
- 可选地桥接 dock 配色：

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

- `/`：如果 `data.homeNodeId` 存在，找到该节点并渲染 `node.html`；否则回退到时间流。
- `/archive`：文章索引。过滤掉 `data.homeNodeId`，按 `node.displayDate.year` 分组；按 `site.ui.contentDisplay` 决定展开策略（摘要 / 全文 / 内联 / 外链卡片），未知主 Tag 回退摘要。
- `/n/{id}`：详情页。`getStaticPaths` 必须过滤 `data.homeNodeId`；正文用 `<div class="prose" set:html={node.html} />`；展示 `node.parent` 的前情提要、`node.children` 的后续进展、`node.revisions` 的修订与存证。
- `/404`。

页头加一个指向 `/archive` 的“索引”链接。首页节点的 `url` 是 `/`，不要为它生成 `/n/{id}`。

## 数据契约

只使用 `src/generated/contract.ts` 中的 `SiteData` / `ContentNode` / `NodeRef`。常用字段：

- `site.title`、`site.description`、`site.url`、`site.buildId`、`site.ui`
- `node.id`、`node.url`、`node.primaryTag`、`node.rawTags`
- `node.html`（已渲染的 Markdown）
- `node.displayTitle`、`node.excerpt`、`node.displayDate`
- `node.parent`、`node.ancestors`、`node.children`
- `node.revisions`、`node.isVerified`、`node.isDirty`、`node.isUntracked`

## 设计建议

以下是默认主题的审美取向，新主题可以按自己的设计目标调整：

- 单栏、阅读宽度约 43rem；无封面图、无卡片阴影。
- 用 `oklch()` + `light-dark()` 定义灰阶，避免刺眼的彩色。
- 日期与数字用等宽字体；标题 `text-wrap: balance`，正文 `text-wrap: pretty`。
- 默认不引入客户端框架；交互用原生 HTML/CSS 与少量 vanilla JS，保证无 JS 时可完整阅读。
- View Transitions 用原生 `@view-transition`，不要引入 Astro `<ClientRouter />`。

## 完成条件

在 worktree 根目录运行 `npm run build`，确认 `dist/index.html`、`dist/n/*.html`、`dist/404.html` 都存在。回到 main 后运行：

```powershell
npm run build:all
npm run serve
npm run test:e2e
```

验证该主题能被打包、切换与离线访问。提交时只包含主题允许的路径，使用 Conventional Commits：

```powershell
git add src public theme.contract.json theme.package.json
git commit -m "feat: add <id> theme"
```
