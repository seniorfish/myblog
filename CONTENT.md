# 写作规范

所有内容都是 `content/` 下的 `.md` 文件。文件名（去掉 `.md`）就是节点 id，详情页 URL 为 `/n/{id}`。

## 推荐工作流

```powershell
npm run blog      # 检查工作区；干净时复制模板并打开编辑器
npm run ai        # 选择文件 → 元数据 / id 建议 / 语言优化
npm run blog      # 校验并提交
```

- `npm run blog` 负责 Git 与文件状态；它不会静默调用 AI。
- `npm run ai` 只处理单个文件，生成建议或改写；它不会执行 `git add/commit/push`。
- 文件名只允许 ASCII，中文标题直接推导会得到 `post-xxxxxxxx` 这种随机 id；用 `npm run ai -- slug <file>` 生成拼音/英文 id，确认后再重命名。
- `content/new-blog.md` 是临时模板 id，不能提交；`npm run blog` 会要求改成正式 slug。正文与元数据会一起重命名。
- 模板文件在 `templates/new-blog.md` 与 `templates/new-blog.meta.yml`；正文里的 `<!-- new-blog-template -->` 标记要在完成正文后删除。
- AI 使用 `DEEPSEEK_API_KEY`，只在写作时调用；构建和 CI 不调用模型。

常用非交互命令：

```powershell
npm run blog -- check --json
npm run blog -- save content/foo.md --json
npm run ai -- frontmatter content/foo.md --fields tags,description --json
npm run ai -- frontmatter content/foo.md --fields tags,description --write
npm run ai -- slug content/foo.md --json
npm run ai -- slug content/foo.md --write
npm run ai -- language content/foo.md --mode proofread --output advice --json
```

## 元数据（`*.meta.yml`）

正文与元数据分开存放：

- `content/foo.md`：**只放正文**，不允许 `---` frontmatter。
- `content/foo.meta.yml`：元数据，至少要有 `tags`。

```yaml
# content/foo.meta.yml
tags: 文章 建站
title: 标题
description: 一句话摘要
extends: parent-id
url: https://example.com
aliases: [old-id]
draft: false
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `tags` | 是 | 空格分隔。第一个是主 Tag，后续是次 Tag |
| `title` | 否 | 想法/闪念可以省略 |
| `description` | 否 | 列表与 RSS 摘要；缺省取正文首段 |
| `extends` | 否 | 父节点 id（相对路径去 `.md`） |
| `url` | 否 | 收藏类外链 |
| `aliases` | 否 | 旧 id，用于未来重定向与引用解析 |
| `draft` | 否 | `true` 时不进入构建产物 |

修改标签、标题、摘要都只改 `.meta.yml`。正文文件的字节不变，因此不会产生新的正文修订，也不会影响已有的正文存证。

**不要写日期。** `date`、`pubDate`、`createdAt`、`updatedAt` 等字段会让编译直接失败；时间由 Git 提交与链上锚定推导。

AI 补全规则：

- AI 只写 `*.meta.yml`，不改正文。
- 默认只补缺失字段；已有内容不覆盖。
- `tags` 是必填；AI 会优先复用已有 Tag。
- `extends` 只给候选，写入前必须确认。
- `description`、`title` 由正文推导，不编造事实。
- `draft`、`aliases` 不由 AI 自动生成。

## 首页（主 Tag: 首页）

- 全站只能有**一个已发布**的节点使用 `site.config.ts` 里的 `homeTag`（默认 `首页`）；多个会让编译失败。
- 它渲染在 `/`，并从索引 `/archive`、RSS、sitemap、搜索中排除。
- 首页节点不生成 `/n/{id}` 详情页；存证信息在页面底部的修订框里。
- 首页内容用标准 Markdown，建议写自我介绍、正在做的事和常用链接。
- 首页页脚会自动带上该节点的“修订与存证”折叠框。

```yaml
# content/home.meta.yml
tags: 首页
title: 你好，我是……
description: 一句话介绍。
```

```markdown
<!-- content/home.md -->
你好，我是……
```

文章索引在 `/archive`；站点页头有“索引”链接。

## 四种主 Tag

下面只展示各自的 `*.meta.yml`：

```yaml
# 文章：长文，首页只显示摘要 + 链接（content/article.meta.yml）
tags: 文章 建站
title: 构建面向 AI Agent 的个人博客

# 想法：短卡片；正文不超过 400 字时首页直接展开（content/thought.meta.yml）
tags: 想法 硬件 树莓派
extends: parent-id

# 闪念：单行；首页整条内联（content/flash.meta.yml）
tags: 闪念 日常
extends: parent-id

# 收藏：外链卡片（content/bookmark.meta.yml）
tags: 收藏 工具
title: 树莓派官方 GPIO 速查表
url: https://www.raspberrypi.com/documentation/computers/raspberry-pi.html
```

主 Tag 决定形态，次 Tag 决定筛选与皮肤。你可以发明新主 Tag；没有专门样式时，首页会回退到摘要模式。

## extends：用追加代替改写

编辑只用于勘误；新的体会新建一个节点，用 `extends` 指向旧节点：

```yaml
# content/child-id.meta.yml
tags: 想法 硬件 树莓派
extends: parent-id
```

```markdown
<!-- content/child-id.md -->
换了铜片散热之后，连续编译十分钟温度从 82 度降到 67 度。
```

编译期会：

- 检查父节点是否存在（断链报错，并给出相近 id）；
- 检查循环继承；
- 在旧文章底部自动生成“后续进展”列表；
- 在首页给新节点渲染“继承自《…》”的前情提要。

**id 发布后不要改名。** 如果必须改，在 `.meta.yml` 写 `aliases: [旧 id]`；未来会生成重定向。

## 草稿与未提交内容

- `draft: true`：参与 id 解析，但不进入构建产物；已发布节点不能指向 draft。
- 本地开发时，未提交的文件会以文件 mtime 作为临时时间，并在详情页标注“文件未提交”。
- CI 构建要求 Git 工作区干净。

## 本地预览

```powershell
npm run dev
```

修改 `content/` 后，`dev.ts` 会自动重新编译并同步给主题 worktree。

## 图片（M3）

图片不进 Git 仓库。M3 会提供：

```powershell
npm run media ./screenshot.png
```

脚本会转 WebP、按 SHA-256 命名、上传 Cloudflare R2，并输出可粘贴的 Markdown 链接。当前请使用外链，或先不插图。

## 时间显示

时间来自 Git 提交；已锚定版本以区块时间为权威，并区分：

- 当前版本已锚定；
- 当前版本待锚定，上次锚定于 X；
- 尚无任何锚定记录。

已锚定的修订会显示 tx、合约与签名地址；页面还列出 Git blob SHA-1。访客可以按“链上事件 → GitHub commit/文件 → 比对 blob SHA-1”三步核验。私有仓库阶段 GitHub 链接对外 404，链上交易仍可查；公开后才完整。页面不再生成 `raw/` 与 `proof/`。
