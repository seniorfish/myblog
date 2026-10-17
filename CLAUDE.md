# CLAUDE.md

本项目的完整 agent 说明见 `AGENTS.md`。以下是必须遵守的最小约束：

- 先读 `AGENTS.md`、`ARCHITECTURE.md`、`core/contract.ts`。
- 代码注释、变量名、提交信息用英文；文档与 UI 文案用中文。
- 内容 frontmatter 不允许手写日期；时间来自 Git 与链上锚定。
- `main` 保持线性历史；不要制造 merge commit。
- 主题工作只在 `theme/<id>` 分支的 `src/`、`public/`、`theme.contract.json`、可选 `theme.package.json` 中进行。
- 不要修改 `src/generated/`、`build/`、`dist/`、`.worktrees/`。
- 私钥、助记词、keystore 密码不得进入仓库、`.env`、对话或任何 Claude 可读取的文件。
- 修改 `core/contract.ts` 前，确认所有主题仍能构建。
- 构建/测试命令：`npm test`、`npm run typecheck`、`npm run build`。
