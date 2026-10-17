# myblog

一个面向 AI 主题生成、Git/链上时间戳与本地优先体验的个人博客。

当前状态：**里程碑 1（M1）**。内容编译、默认主题、本地开发与静态构建已打通；多主题 VFS、Service Worker、链上锚定、R2 图床与 Cloudflare Pages 部署属于后续里程碑。

## 快速开始

要求 Node.js >= 22.22。

```powershell
cd repo
npm install
npm run dev
```

`npm run dev` 会：

1. 读取 `content/` 与 Git 历史，生成 `build/generated/site-data.json` 等产物；
2. 把共享工具链注入 `.worktrees/default`；
3. 在主题 worktree 里启动 Astro dev。

Astro 默认使用 4321 端口；如果该端口已被占用，终端会打印实际端口。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | 只运行内容编译器 |
| `npm run build` | 编译 + 构建默认主题，输出到 `dist/` |
| `npm run preview` | 在主题 worktree 里运行 Astro preview |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |

## 仓库结构

```text
content/          所有 .md 内容
core/             编译器、数据契约、Git/锚定逻辑
scripts/          compile / prepare-theme / dev / build
theme-harness/    Astro + Tailwind 共享工具链（main）
tests/            Vitest
.worktrees/       theme/* 分支的本地 worktree（gitignore）
build/generated/  编译产物（gitignore）
dist/             最终静态输出（gitignore）
```

## 分支

- `main`：内容、编译器、契约、构建脚本、文档。
- `theme/default`：默认主题的 UI 源码。它是孤儿分支，只提交 `src/`、`public/`、`theme.contract.json`、`AGENTS.md`；harness 文件与 `src/generated/` 由脚本注入并忽略。

未来每个 AI 主题是一个新的孤儿分支 `theme/<model>`，只实现 UI，不碰数据层。

## 内容与时间

- 内容只写标准 Markdown，frontmatter 至少要有 `tags`。
- **不允许手写日期**。时间来自 Git 提交；链上锚定在 M3 接入后，以区块时间为权威。
- 主 Tag 决定形态：`文章`、`想法`、`闪念`、`收藏`，也允许未来任意新 Tag；没有专门样式时自动回退。
- 新进展通过 `extends` 新建节点，不直接改写旧文章。

详见 [CONTENT.md](CONTENT.md)。

## 设计文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：整体架构、M1 实现、M2/M3 接口与边界。
- [AGENTS.md](AGENTS.md)：给未来 AI 的工作约束。
- [THEME_AGENT_PROMPT.md](THEME_AGENT_PROMPT.md)：新主题的复制即用提示词。

## 语言约定

- 代码注释、变量名、提交信息：英文。
- 文档与站点 UI 文案：中文。

## 安全

私钥、助记词与 keystore 密码不得进入仓库、`.env`、对话或任何 Claude 可读取的文件。链上锚定使用本机专用 burner 钱包的加密 keystore，详见 `ARCHITECTURE.md`。
