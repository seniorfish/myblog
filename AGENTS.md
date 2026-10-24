# AGENTS.md

本文件给在此仓库工作的 AI 与贡献者。先读本文件，再读 [ARCHITECTURE.md](ARCHITECTURE.md)；写作前读 [CONTENT.md](CONTENT.md)；做主题前读 [THEME_AGENT_PROMPT.md](THEME_AGENT_PROMPT.md)。

## 不可协商的规则

1. **契约优先**：`core/contract.ts` 是唯一数据契约，主题只依赖其中的 `SiteData`。修改它之前，确认所有主题仍能构建。
2. **尊重分层**：`main` 负责内容、编译器、契约、运行时与脚本；`theme/<id>` 只负责 UI。不要手改 `src/generated/`、`build/`、`dist/`、`.worktrees/`，也不要把 harness 生成物提交到主题分支。
3. **内容是写出来的，不是标出来的**：正文与 `.meta.yml` 分离，日期不可手写，id 发布后不改名。规则见 [CONTENT.md](CONTENT.md)。
4. **历史与存证只追加**：`main` 保持线性；不要改写已发布历史或伪造时间。锚定以 commit 为粒度，机制见 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [contracts/README.md](contracts/README.md)。
5. **密钥不跨越信任边界**：私钥、助记词、keystore 密码不得进入仓库、`.env`、对话或任何 Claude 可读取的文件。只有指定的 CI job 读取自己的 secret，build job 不接触敏感信息。
6. **不要另造运行时**：dock / Service Worker 由构建期注入，VFS、缓存与路径不变量见 [ARCHITECTURE.md](ARCHITECTURE.md)；主题和脚本应复用，不要重写一套。
7. **工具职责分离**：`npm run blog` 负责 Git 写操作；`npm run ai` 只处理单个文件，禁止执行 Git。AI 只在写作时调用，提案必须经用户确认后才落盘。
8. **验证后再声称完成**：跑相关测试、类型检查、内容校验与 `build:all`；CI 是最终判据。提交前确认工作区只包含预期的源文件。

## 约定

- **一个事实只写一处**：本文件、`ARCHITECTURE.md`、`CONTENT.md` 各有明确职责；新增内容前先确认归属，用链接代替复制。
- 文档不写状态、里程碑、日期、构建体积或测试数量，这些会很快过时。
- 代码注释、变量名、提交信息用**英文**；文档与站点 UI 文案用**中文**。
- 提交遵循 Conventional Commits；不要添加 `Co-Authored-By` 等署名尾行。

## 修改边界

- `content/`：只写正文与元数据；结构规则以 `CONTENT.md` 为准。
- `core/`：编译器与契约；改完跑单元测试与完整构建。
- `scripts/blog/`：唯一允许做 Git 写操作的地方；`scripts/ai/` 不得调用 Git。
- `theme/<id>` 分支：只改 `src/`、`public/`、`theme.contract.json`、可选 `theme.package.json` 与 `AGENTS.md`。

## 验证

```powershell
npm test
npm run typecheck
npm run blog -- check --json
npm run build:all
npm run test:e2e      # 需要本机 Chrome
```

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：数据流、内容模型、时间与锚定、主题/VFS/SW、部署与边界。
- [CONTENT.md](CONTENT.md)：写作流程、元数据、首页、主 Tag、`extends`。
- [contracts/README.md](contracts/README.md)：合约事件、commit 编码与部署。
- [THEME_AGENT_PROMPT.md](THEME_AGENT_PROMPT.md)：新主题的复制即用提示词。
