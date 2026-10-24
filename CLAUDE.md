# CLAUDE.md

完整规则见 [AGENTS.md](AGENTS.md)；先读 `AGENTS.md`、`ARCHITECTURE.md` 与 `core/contract.ts`。

- 代码注释、变量名、提交信息用英文；文档与 UI 文案用中文。
- 元数据不写日期；`.md` 只放正文，元数据放同名 `.meta.yml`。
- 主题只在 `theme/<id>` 的 `src/`、`public/`、`theme.contract.json`、可选 `theme.package.json` 内修改；不要手改 `src/generated/`、`build/`、`dist/`、`.worktrees/`。
- 私钥、助记词、keystore 密码不得进入仓库、`.env`、对话或任何 Claude 可读取的文件。
- 提交信息不要添加 `Co-Authored-By` 或其他署名尾行。
