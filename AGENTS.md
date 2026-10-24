# theme/terminal

Terminal：深色等宽终端风。

本分支是孤儿分支，只包含主题 UI。完整规则见 main：

- [AGENTS.md](https://github.com/seniorfish/myblog/blob/main/AGENTS.md)
- [ARCHITECTURE.md](https://github.com/seniorfish/myblog/blob/main/ARCHITECTURE.md)
- [THEME_AGENT_PROMPT.md](https://github.com/seniorfish/myblog/blob/main/THEME_AGENT_PROMPT.md)
- 本地数据契约：`src/generated/contract.ts`

## 路由

- `/`：渲染 `SiteData.homeNodeId` 对应节点；没有首页节点时回退时间流。
- `/archive`：文章索引，过滤首页节点后按时间混排。
- `/n/{id}`：节点详情；`getStaticPaths` 必须过滤 `homeNodeId`。
- `/404`。

## 命令

在 worktree 根目录运行 `npm run dev`、`npm run build`、`npm run preview`。

## 边界

只提交 `src/`、`public/`、`theme.contract.json`、`theme.package.json`、`AGENTS.md`；`LICENSE`（MIT）只随仓库存在，不要修改。不要提交 harness 注入物或 `src/generated/`。修改范围与完成条件以 `THEME_AGENT_PROMPT.md` 为准。
