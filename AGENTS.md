# theme/default

## 你只能修改

- `src/**`
- `public/**`
- `theme.contract.json`
- `theme.package.json`（可选，用于追加依赖；必须写死版本）

## 不要修改

- `src/generated/**`：编译器生成的 `site-data.json` 与 `contract.ts`
- `package.json`、`astro.config.mjs`、`tsconfig.json`、`src/env.d.ts`：由 main 的 `theme-harness` 注入
- `core/`：在 main 分支，不属于主题

## 数据契约

先读 `src/generated/contract.ts`。页面从 `src/generated/site-data.json` 读取 `SiteData`。

关键字段：

- `site.buildId`、`site.url`、`site.ui.contentDisplay`
- `node.id`、`node.url`、`node.primaryTag`、`node.rawTags`
- `node.html`：已经渲染好的 Markdown，用 `<Fragment set:html={node.html} />` 注入
- `node.displayTitle`、`node.excerpt`、`node.displayDate`
- `node.parent`、`node.ancestors`、`node.children`
- `node.revisions`、`node.isVerified`、`node.isDirty`、`node.isUntracked`

## 路由

- `/` 首页：渲染 `SiteData.homeNodeId` 对应节点的 HTML（自我介绍）；没有首页节点时回退时间流。
- `/archive` 文章索引：过滤掉首页节点后按时间混排。
- `/n/{id}` 节点详情：`getStaticPaths` 必须过滤掉 `homeNodeId`。
- `/404`

## 命令

在 worktree 根目录运行：

```bash
npm run dev
npm run build
npm run preview
```

提交前确认 `git status` 只显示 UI 源文件，不包含 harness 生成物。

## 语言

代码注释、变量名用英文；文档和 UI 文案用中文。
