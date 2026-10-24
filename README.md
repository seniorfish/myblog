# myblog

一个面向 AI 协作、Git/链上时间戳与本地优先体验的个人博客。线上：<https://chenbase.cc>。

## 特性

- **内容编译**：Markdown 正文 + `.meta.yml` 元数据；主 Tag 决定形态，`extends` 表达后续进展。
- **可验证的时间**：时间来自 Git 提交；内容 commit 锚定到 Base 主网事件合约，页面提供三步核验。
- **多主题与离线**：主题是独立的孤儿分支；构建产出 VFS，Service Worker 负责站内零延迟、主题切换与离线访问。
- **写作工具**：`npm run blog` 管仓库与 Git，`npm run ai` 管单文件元数据 / id / 语言建议。
- **静态部署**：Cloudflare Pages，CI 在内容推送后自动锚定、构建并发布。

## 快速开始

要求 Node.js >= 22.22。

```powershell
git clone https://github.com/seniorfish/myblog.git
cd myblog
npm install
npm run dev
```

`npm run dev` 编译内容、把共享工具链注入 `.worktrees/default`，然后在默认主题 worktree 里启动 Astro dev。开发另一个主题用 `npm run dev -- terminal`。

## 写作

```powershell
npm run blog      # 检查工作区；干净时复制模板并打开编辑器
npm run ai        # 选择文件 → 元数据 / id 建议 / 语言优化
npm run blog      # 校验并提交
```

`npm run blog` 负责 Git 与文件状态；`npm run ai` 只处理单个文件，不执行 Git。日期不允许手写，正文与元数据分开存放，具体规则见 [CONTENT.md](CONTENT.md)。

## 构建与命令

```powershell
npm run build       # 只构建默认主题 -> dist/
npm run build:all   # 构建所有 theme/* + VFS + manifest -> dist/
npm run serve       # 本地静态服务器（默认 8080）
npm run test        # Vitest
npm run test:e2e    # 无头 Chrome 端到端（需要本机 Chrome）
npm run typecheck   # 主程序 + Service Worker
```

`package.json` 是命令的准确来源；`npm run contract:test` 运行 Foundry 合约测试，`npm run deploy:pages` 直传 Cloudflare Pages。

## 主题

内置 `theme/default`（Default Minimal）与 `theme/terminal`（Terminal）。主题分支只放 UI；harness、数据契约与生成数据由 `scripts/prepare-theme.ts` 注入。新建主题见 [THEME_AGENT_PROMPT.md](THEME_AGENT_PROMPT.md)。

## 仓库结构

```text
content/          正文 .md + 元数据 .meta.yml
core/             编译器、契约、Git/锚定、VFS 纯逻辑
host/             sys-theme-dock 宿主组件
sw/               Service Worker
scripts/          compile / dev / build / build-all / serve / e2e
scripts/blog/     npm run blog：仓库状态机与 Git 操作
scripts/ai/       npm run ai：DeepSeek 元数据 / id / 语言建议
theme-harness/    Astro + Tailwind 共享工具链（main）
contracts/        事件合约、Foundry 测试与部署记录
tests/            Vitest
```

## 部署

- Cloudflare Pages 项目 `chenbase-blog`，生产域名 <https://chenbase.cc>（`www` 同一项目）。
- CI：`content/` 变化时先锚定，再由无密钥的 build job 构建；独立的 deploy job 用 `wrangler pages deploy` 发布。
- 仓库 secret：`CLOUDFLARE_API_TOKEN`（仅 Pages 权限）与 `CLOUDFLARE_ACCOUNT_ID`，只有 deploy job 读取。
- 本地发布：`CLOUDFLARE_API_TOKEN=... npm run deploy:pages`。
- 缓存策略来自 `dist/_headers`：`manifest.json` / `sw.js` 不缓存，`/_themes/*` 与 `/_astro/*` 长期 immutable。

更完整的信任边界与缓存设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 链上存证

- 合约：Base 主网 `0x00000000009DE13419D7CFf80F6D2e1e992146aA`，只发 `Anchored(address indexed sender, bytes32 indexed commit)` 事件。
- 索引：孤儿分支 `anchors` 的 `anchors.ndjson`；构建离线读取，链上事件可重建索引。
- 页面显示 tx、合约、签名地址与 Git blob SHA-1，可按“链上事件 → GitHub commit/文件 → 比对 blob SHA-1”核验。
- 合约细节、commit 编码与部署记录见 [contracts/README.md](contracts/README.md)。

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：数据流、主题/VFS/Service Worker、部署与边界。
- [AGENTS.md](AGENTS.md)：贡献者与 AI 的工作约束。
- [CONTENT.md](CONTENT.md)：写作流程与元数据规范。
- [THEME_AGENT_PROMPT.md](THEME_AGENT_PROMPT.md)：新主题的复制即用提示词。
- [contracts/README.md](contracts/README.md)：事件合约与部署。

## 约定

- 代码注释、变量名、提交信息用英文；文档与站点 UI 文案用中文。
- 私钥、助记词与 keystore 密码不得进入仓库、`.env`、对话或任何 Claude 可读取的文件。详见 [AGENTS.md](AGENTS.md)。
