# Novel Hub MVP 设计文档

日期：2026-10-31
项目位置：`/Users/tutuu/go/code/novel-hub`

## 1. 目标与范围

一个本地运行的网页平台，用来管理多本本地小说的原文，并追踪各发布平台（番茄、起点等）的发布情况。

### MVP 做

1. **小说库**：配置一个或多个小说根目录，扫描出多本小说（每个子目录一本），支持添加/归档。
2. **章节管理**：读取 `ChNN-标题.md`，显示字数，Markdown 纯文本编辑并写回文件。
3. **平台与发布矩阵**：预置番茄、起点（可自行添加）；每本小说绑定平台；每章 × 每平台记录发布状态。
4. **过期提示**：提交/发布时记录发布形态 hash（标题 + 转换后正文），本地改稿后自动提示"需更新"。
5. **一键复制正文**：去 Markdown 标记的纯文本，供粘贴到作家后台。
6. **总览看板**：每本书的总章数、总字数、各平台已发/审核中/需更新/未发计数。

### MVP 不做（后续）

- AI 辅助生成（想法 → 大纲 → 逐章生成），列为第二期
- 自动发布（浏览器自动化）：无公开 API，易失效且有平台风控/条款风险
- 多用户、登录、云部署、平台数据统计抓取、文件监听（watcher）、富文本编辑

## 2. 技术栈

- **Next.js（TypeScript, App Router）**：全栈单项目，Server Actions / Route Handlers 直接读写本地文件与数据库
- **SQLite + Drizzle ORM**：数据文件 `data/novel-hub.db`
- **Tailwind CSS + shadcn/ui**
- **Vitest**：单元测试
- 第二期接 AI 时在服务端使用 Anthropic SDK，流式输出

## 3. 架构原则

**文件是真相，数据库是索引。** 章节正文只存在于本地 Markdown 文件，数据库保存元数据和发布状态，可随时从文件重建（发布记录除外）。

### 目录结构

```
novel-hub/
├── src/
│   ├── app/
│   │   ├── page.tsx                          # 总览看板
│   │   ├── novels/[id]/page.tsx              # 小说详情：章节列表 + 发布矩阵
│   │   ├── novels/[id]/chapters/[cid]/       # 章节编辑
│   │   └── settings/                         # 目录、平台、复制格式
│   ├── lib/
│   │   ├── fs-scan.ts                        # 扫描目录、解析 ChNN-标题.md
│   │   ├── sync.ts                           # 文件系统 → 数据库同步
│   │   ├── hash.ts                           # 归一化后 sha256
│   │   └── publish.ts                        # 需更新判断、复制格式化
│   └── db/                                   # Drizzle schema + 连接
├── data/novel-hub.db
├── drizzle/                                  # 迁移
└── docs/superpowers/specs/                   # 设计文档
```

### 同步策略

- 触发时机：打开页面，或点击"重新扫描"。不使用文件监听。
- `sync` 对比磁盘与数据库：
  - 新文件 → 新增章节
  - 文件缺失 → `file_missing = true`，保留章节及发布记录，不删除
  - 文件改动 → 更新 `word_count`、`content_hash`
- 平台内编辑：先写回 `.md` 文件，成功后再触发单章同步；写文件失败则不更新数据库。外部编辑器修改的文件在下次扫描时自然同步。

### hash 归一化

对**发布形态**取 sha256：`标题 + "\n" + 转换后的正文`。标题取文件首行 H1（`# 第N章 标题` 或 `# 《书名》· 第N章 · 标题`，缺失时用文件名标题）；正文按"复制格式"规则去 Markdown 标记、统一换行符（`\r\n` → `\n`）、折叠空行、去首尾空白。这样换行符、首尾空白、仅 Markdown 写法不同的改动不会造成误报，改标题或正文文字则会触发"需更新"。转换规则全局只有一份实现（`publish.ts`），`hash.ts` 调用它。

字数 = 发布形态正文去掉所有空白后的字符数（不含标题），与番茄后台字数口径一致。

### 章节文件约定

- 每本小说可配置「章节目录」`chapter_subdir`（相对小说目录，默认空），只扫描该目录一级的 `ChNN-标题.md`，忽略子目录。
- 章节标题以文件首行 H1 为准；H1 章号须与文件名序号一致，不一致时入库并告警。

## 4. 数据模型

| 表 | 字段 | 说明 |
|---|---|---|
| `library_root` | id, path, created_at | 小说根目录配置，`path` 唯一 |
| `novel` | id, name, dir_path, chapter_subdir, archived, created_at | `dir_path` 唯一；`chapter_subdir` 为章节所在子目录，默认空；归档仅隐藏，不动文件 |
| `chapter` | id, novel_id, seq, title, file_path, word_count, content_hash, file_missing | `(novel_id, seq)` 唯一 |
| `platform` | id, name, builtin | 预置番茄、起点，可新增 |
| `novel_platform` | novel_id, platform_id, book_url | 小说绑定的平台，可附作品主页链接 |
| `publication` | chapter_id, platform_id, status, published_at, platform_url, published_hash | `(chapter_id, platform_id)` 唯一 |

- `status` 存三种手动值：`unpublished`（未发布）/ `pending_review`（审核中）/ `published`（已发布）。番茄等平台提交后需审核，覆盖已发布章节会重新进入审核，且审核期间平台不允许修改。
- **"需更新"不入库**，查询时计算：`status ∈ {pending_review, published}` 且 `published_hash ≠ chapter.content_hash`。避免状态与内容不一致。
- 点击"标记审核中"或"标记已发布"（从未发布出发）、"重新提交（覆盖）"时，将 `published_hash` 置为当前 `content_hash`，并写入 `published_at`；审核中 → 已发布只改 `status`，不改 hash 与时间。
- 被驳回或撤回时点"取消"回到 `unpublished`，MVP 不单设状态。
- 章节编号来源：文件名中的 `NN`。

## 5. 页面与交互

UX 基准为 [Novel Hub UI 设计 · MVP 版本](https://claude.ai/artifact/5qTYWHaaX2M4goaaw3EYSY)，详细交互见各需求文档 §6 及 [需求索引的 UX 基准](../../requirements/README.md)。

1. **总览看板 `/`**：小说卡片，显示总章数、总字数、各绑定平台的已发/审核中/需更新/未发计数；顶部有"添加小说目录"（页内面板）、"重新扫描"、"显示已归档"和排序。
2. **小说详情 `/novels/[id]`**：表格，行 = 章节，列 = 章号、标题、字数、各绑定平台状态徽标。点击徽标在行下方展开操作条（标记审核中/标记已发布/重新提交/取消）；每行有"复制 ▾""编辑"；支持筛选"只看需更新/未发布"并可限定平台。
3. **章节编辑 `/novels/[id]/chapters/[cid]`**：纯 textarea 编辑 Markdown，保存即写回文件并更新字数/hash；顶部有"复制标题+正文""保存"，右侧为各平台状态卡（状态、发布时间、章节链接、操作）。
4. **设置 `/settings`**：管理小说根目录与平台列表，并只读说明内置复制格式。

### 复制格式

默认复制"标题 + 换行 + 正文"，标题输出为平台格式 `第N章 标题`，正文去掉首行 H1 和 Markdown 标记（`**`、`>`、反引号、`---` 转空行、`- x` 转 `· x` 等）。因番茄后台标题与正文是两个输入框，另提供「仅标题」「仅正文」选项。MVP 内置一个默认格式，不做可视化模板配置。转换规则以番茄发布技能为基准，详见 `docs/requirements/PLATFORM-NOTES-fanqie.md`。

## 6. 错误处理

- 目录不存在或无权限：页面提示，保留已有记录。
- 文件名不符合 `ChNN-标题.md`：列入"未识别文件"提示，不报错。
- 写回文件失败：提示错误，不更新数据库。
- 章节文件缺失：保留发布记录，徽标显示"文件丢失"。

## 7. 测试

对三个纯函数模块写单元测试（Vitest）：

- `fs-scan`：文件名解析（正常、异常命名、无序号）
- `hash`：发布形态 hash（换行、首尾空白、纯 Markdown 写法差异应得相同 hash；标题或正文文字变化应得不同 hash）
- `publish`：需更新判断（含审核中）、复制文本格式化（Markdown 标记剥离，用番茄发布技能样章对拍）

页面层 MVP 阶段仅做手动验证。

## 8. 后续（第二期方向）

AI 辅助生成：想法 → 设定与大纲 → 确认后逐章生成并存为 `.md`，生成时带上设定和前文摘要以保持连贯。数据模型无需改动，新增生成任务相关表和页面即可。
