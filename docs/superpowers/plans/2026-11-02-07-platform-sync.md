# 平台连接校验与发布状态自动同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 番茄平台配置时校验作品链接与认证信息；点击「重新扫描」后自动拉取番茄线上章节，把每章状态同步为 未发布 / 已发布 / 需更新；未配置平台无状态。

**Architecture:** 新增一个可注入的番茄 HTTP 客户端（只读 GET），一个纯判定 + 落库的同步引擎，一个把「本地扫描 → 平台同步」串起来的编排层；矩阵 / 看板按「是否已配置」分流展示，并移除 MVP 的手动标记流程。所有业务逻辑在 `src/lib`，Server Action 与组件只做薄封装。

**Tech Stack:** Next.js 15 (Server Actions)、React 19、drizzle-orm + better-sqlite3、Vitest 5、Tailwind。无新增依赖（用全局 `fetch`）。

**Spec:** `docs/requirements/REQ-07-platform-sync.md`

**UX 基准（已通过）：** [Novel Hub UI 设计](https://claude.ai/artifact/5qTYWHaaX2M4goaaw3EYSY) 的「REQ-07 平台同步」页，文字版见 REQ-07 §6。文案以 §6 为准；颜色沿用代码现有 Tailwind 色板（主按钮 `bg-stone-900`，已发 `blue-600`，需更新 `orange-*`，错误 `red-*`，新鲜度条 `blue-50` / 失败 `orange-50`），布局与层级以原型为准。

## Global Constraints

- 仅接入番茄；平台名常量 `SYNC_PLATFORM = '番茄'`（预置平台不可改名，故按名称识别安全）。起点与自定义平台显示"暂不支持自动校验"，不展示状态。
- 链接格式：主机 `fanqienovel.com`（允许 `www.`），协议 `http`/`https`，路径匹配 `/main/writer/chapter-manage/<数字book_id>`，其后 `&书名`、`?type=1` 忽略。样例：`https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864&坏人?type=1` → `7670888040847395864`。
- "已配置" = 平台为番茄 且 已保存 `cookie` + `csrf_token` 且 该小说该平台的 `book_id` 非空。三者缺一即未配置。
- 已配置平台状态只有 `unpublished` / `published` / `stale`，由同步覆盖，不可手动标记；`stale` 入库。未配置平台：无状态、无徽标、无手动入口、不计入看板。
- 三态判定：线上无该章 → 未发布；标题与字数都一致 → 已发布；否则标题不一致 → 需更新；标题一致字数不一致 → 拉正文比对（去全部空白后逐字比较），有差异需更新、无差异已发布；线上审核中（`display_status = 5`）读不到正文，只比标题与字数（都一致已发布，否则需更新）。
- 字数口径：线上 `word_number` 对比本地 `chapter.word_count`（发布形态正文去空白字符数，不含标题）。标题口径：两端都归一化为 `第N章 标题` 再比较。
- 同步只读：只发 GET；失败（认证失效、网络、结构异常）时各章状态**保持不变**，绝不当成"线上没有"。
- 认证信息只存本地 SQLite，**不得**出现在任何错误文案、日志、通知、传给客户端组件的 props 中；界面只显示掩码（`已配置 · 末4位 xxxx`）。
- 全局重新扫描按小说串行，每本有配置平台的小说同步后间隔 300ms。
- 文件落盘与稿件目录不被同步修改。
- 同步是否失败、失败原因从 `novel_platform.last_sync_error` 读取；失败时 `last_synced_at` 保留上次成功时间。文案判断集中在 `src/lib/sync-status.ts`。
- 所有面向用户文案为简体中文，沿用现有风格。提交信息结尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 测试命令：`npx vitest run <file>`；类型检查：`npx tsc --noEmit`。

## 已知假设（需用真实账号验证，见 Task 9）

番茄接口返回结构只在 `platform-facts.md` 里给出了路径和部分字段，下面这些**字段路径是推断**，集中在 `fanqie-client.ts` 的解析函数里，便于一处修正：

- `book_list` → `data.book_list[].book_id`
- `volume_list` → `data.volume_list[].volume_id`
- `chapter_list` → `data.item_list[]` 含 `item_id` / `title` / `word_number` / `display_status`
- `edit_article` → 正文 HTML 在 `data.content`（兜底 `data.article_info.content`）；审核中返回 `code=-2014`
- 分页 `page_index` 是 0 起还是 1 起未知：用"去重后没有新条目即停"的循环，对两种都成立。

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/lib/types.ts` | `PublishStatus` / `Badge` 类型 | 改 |
| `src/db/schema.ts`、`drizzle/0001_*.sql` | 新增列 | 改 / 生成 |
| `src/lib/fanqie-url.ts` | 链接解析 `parseFanqieBookId` | 新 |
| `src/lib/fanqie-client.ts` | 番茄只读客户端、错误类型、`ClientFactory` | 新 |
| `src/lib/platforms.ts` | `SYNC_PLATFORM`、`isSyncConfigured`、`bindPlatform`、`listBindings` | 改 |
| `src/lib/platform-auth.ts` | 保存/清除认证、`bindPlatformChecked`、`clientForPlatform` | 新 |
| `src/lib/platform-sync.ts` | 判定 `decideStatus`、`syncNovelPlatform(s)` | 新 |
| `src/lib/rescan.ts` | `listSyncableNovels`（全局扫描要同步哪些小说） | 新 |
| `src/lib/rescan-flow.ts` | 客户端编排：本地扫描 → 平台同步，上报阶段与进度 | 新 |
| `src/lib/sync-status.ts` | 新鲜度条、差异原因、卡片同步行、时间格式等纯函数 | 新 |
| `src/lib/sync-notice.ts` | 汇总提示文案 | 新 |
| `src/lib/sync.ts` | `FullSyncSummary.failedNovelIds` | 改 |
| `src/lib/publish.ts`、`publications.ts`、`matrix.ts`、`stats.ts` | 移除手动/hash 过期逻辑，按已配置分流 | 改 |
| `src/app/actions/{library,platforms,publications}.ts` | Server Actions | 改 |
| `src/components/use-rescan-novel.ts` | 详情页按钮与卡片菜单共用的单本重新扫描 | 新 |
| `src/components/sync-strip.tsx`、`setup-checklist.tsx` | 新鲜度条、未配置清单 | 新 |
| 组件（见各 Task） | UI | 改 / 删 |

---

### Task 1: 数据模型与类型（可加性迁移）

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/lib/types.ts`
- Create: `drizzle/0001_*.sql`（由 drizzle-kit 生成）
- Test: `src/db/db.test.ts`（追加）

**Interfaces:**
- Produces: `platform.cookie` / `platform.csrfToken`；`novelPlatform.bookId` / `lastSyncedAt` / `lastSyncError`；`publication.platformItemId` / `platformWordCount` / `syncedAt`；`PublishStatus` 增加 `'stale'`（本 Task 暂不删 `'pending_review'`，Task 7 再收窄）。

- [ ] **Step 1: 写失败测试** — 在 `src/db/db.test.ts` 末尾追加：

```ts
import { makeDb } from '@/test/helpers';

describe('REQ-07 新增列', () => {
  const cols = (db: ReturnType<typeof makeDb>, table: string) =>
    (db.$client.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);

  it('platform / novel_platform / publication 带有同步所需列', () => {
    const db = makeDb();
    expect(cols(db, 'platform')).toEqual(expect.arrayContaining(['cookie', 'csrf_token']));
    expect(cols(db, 'novel_platform')).toEqual(expect.arrayContaining(['book_id', 'last_synced_at', 'last_sync_error']));
    expect(cols(db, 'publication')).toEqual(expect.arrayContaining(['platform_item_id', 'platform_word_count', 'synced_at']));
  });
});
```

若该文件顶部尚未导入 `describe/it/expect`，保持与文件现有导入一致（该文件是 Vitest 测试，补齐缺失的导入即可）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/db/db.test.ts`
Expected: FAIL（列不存在）

- [ ] **Step 3: 改 schema** — `src/db/schema.ts`：

`platform` 表在 `builtin` 后加：
```ts
  cookie: text('cookie'),
  csrfToken: text('csrf_token'),
```
`novelPlatform` 表在 `bookUrl` 后加：
```ts
    bookId: text('book_id'),
    lastSyncedAt: integer('last_synced_at'),
    lastSyncError: text('last_sync_error'),
```
`publication` 表在 `publishedHash` 后加：
```ts
    platformItemId: text('platform_item_id'),
    platformWordCount: integer('platform_word_count'),
    syncedAt: integer('synced_at'),
```

`src/lib/types.ts` 第 1 行改为：
```ts
export type PublishStatus = 'unpublished' | 'pending_review' | 'published' | 'stale';
```

- [ ] **Step 4: 生成迁移**

Run: `npx drizzle-kit generate --name platform_sync`
Expected: 生成 `drizzle/0001_platform_sync.sql`，内容只有 `ALTER TABLE ... ADD ...` 七条；`drizzle/meta/_journal.json` 新增一项。确认没有 DROP / 重建表语句。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS（`'stale'` 只是联合类型新增成员，不影响现有代码；若 tsc 报 `Record<PublishStatus, …>` 缺键，临时在该处补 `stale` 键——Task 7 会整体清理）。

- [ ] **Step 6: 提交**

```bash
git add src/db/schema.ts src/lib/types.ts drizzle src/db/db.test.ts
git commit -m "feat(db): add platform sync columns" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 番茄作品链接解析

**Files:**
- Create: `src/lib/fanqie-url.ts`
- Test: `src/lib/fanqie-url.test.ts`

**Interfaces:**
- Produces: `parseFanqieBookId(input: string): string`（格式错误抛 `UserError`，文案 `链接不符合番茄章节管理页格式，示例：https://fanqienovel.com/main/writer/chapter-manage/<书号>`）。

- [ ] **Step 1: 写失败测试** — `src/lib/fanqie-url.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseFanqieBookId } from './fanqie-url';

const SAMPLE = 'https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864&坏人?type=1';

describe('parseFanqieBookId', () => {
  it('AC7.1 样例链接解析出 book_id', () => {
    expect(parseFanqieBookId(SAMPLE)).toBe('7670888040847395864');
  });
  it('允许 www、http、首尾空白、无后缀', () => {
    expect(parseFanqieBookId(' http://www.fanqienovel.com/main/writer/chapter-manage/123 ')).toBe('123');
    expect(parseFanqieBookId('https://fanqienovel.com/main/writer/chapter-manage/123/')).toBe('123');
    expect(parseFanqieBookId('https://fanqienovel.com/main/writer/chapter-manage/123?type=1')).toBe('123');
  });
  it.each([
    'https://example.com/main/writer/chapter-manage/1',
    'https://fanqienovel.com/page/123',
    'https://fanqienovel.com/main/writer/chapter-manage/abc',
    'https://fanqienovel.com/main/writer/chapter-manage/',
    'https://fanqienovel.com.evil.com/main/writer/chapter-manage/1',
    'https://fanqienovel.com@evil.com/main/writer/chapter-manage/1',
    'ftp://fanqienovel.com/main/writer/chapter-manage/1',
    'not a url',
    '',
  ])('AC7.2 拒绝 %s', (u) => {
    expect(() => parseFanqieBookId(u)).toThrow('链接不符合番茄章节管理页格式');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/fanqie-url.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** — `src/lib/fanqie-url.ts`：

```ts
import { UserError } from './result';

const FORMAT_ERROR = '链接不符合番茄章节管理页格式，示例：https://fanqienovel.com/main/writer/chapter-manage/<书号>';

/** 从番茄作家后台「章节管理」链接解析 book_id。格式不符抛 UserError。 */
export function parseFanqieBookId(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new UserError(FORMAT_ERROR);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError(FORMAT_ERROR);
  if (!/^(www\.)?fanqienovel\.com$/i.test(u.hostname)) throw new UserError(FORMAT_ERROR);
  // 样例路径形如 /main/writer/chapter-manage/7670…&书名，& 之后的内容是书名，忽略
  const m = /^\/main\/writer\/chapter-manage\/(\d+)(?=$|[&/])/.exec(u.pathname);
  if (!m) throw new UserError(FORMAT_ERROR);
  return m[1];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/fanqie-url.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/fanqie-url.ts src/lib/fanqie-url.test.ts
git commit -m "feat: parse fanqie chapter-manage url" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 番茄只读客户端

**Files:**
- Create: `src/lib/fanqie-client.ts`
- Test: `src/lib/fanqie-client.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RemoteChapter { itemId: string; title: string; wordNumber: number; displayStatus: number }
export interface FanqieClient {
  listBookIds(): Promise<string[]>;
  listChapters(bookId: string): Promise<RemoteChapter[]>;
  /** 返回线上正文 HTML；审核中读不到时返回 null */
  getChapterHtml(bookId: string, itemId: string): Promise<string | null>;
}
export type ClientFactory = (db: Db, platformId: number) => FanqieClient;
export class PlatformAuthError extends UserError {}        // 认证无效或已过期
export class PlatformUnavailableError extends UserError {} // 网络/5xx
export class PlatformFormatError extends UserError {}      // 返回结构无法识别
export class PlatformApiError extends UserError {}         // 其他非 0 code
export function createFanqieClient(auth: { cookie: string; csrfToken: string }, fetchImpl?: typeof fetch): FanqieClient
```
- 错误文案固定：认证 `认证无效或已过期，请重新获取 Cookie 与 CSRF Token`；网络 `番茄暂时无法访问，稍后重试`；结构 `番茄返回格式无法识别，接口可能已变更`；API `番茄接口返回错误（code=N）`。**任何文案不得包含 cookie / token。**

- [ ] **Step 1: 写失败测试** — `src/lib/fanqie-client.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  createFanqieClient, PlatformApiError, PlatformAuthError, PlatformFormatError, PlatformUnavailableError,
} from './fanqie-client';

const AUTH = { cookie: 'sessionid=SECRET-COOKIE', csrfToken: 'SECRET-CSRF' };
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'ok', data }));
const body = (code: number, data: unknown = {}, message = '') => new Response(JSON.stringify({ code, message, data }));

/** 路由表：键为 URL path，值为 (URL) => Response。记录每次请求。 */
function fakeFetch(routes: Record<string, (u: URL) => Response>) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected ${url.pathname}`);
    return route(url);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('listBookIds', () => {
  it('解析 book_id，并带上鉴权头与公共参数', async () => {
    const { f, calls } = fakeFetch({ '/api/author/book/book_list/v0': () => ok({ book_list: [{ book_id: 111 }, { book_id: '222' }] }) });
    const ids = await createFanqieClient(AUTH, f).listBookIds();
    expect(ids).toEqual(['111', '222']);
    expect(calls[0].headers.get('cookie')).toBe(AUTH.cookie);
    expect(calls[0].headers.get('x-secsdk-csrf-token')).toBe(AUTH.csrfToken);
    expect(calls[0].url.searchParams.get('aid')).toBe('2503');
    expect(calls[0].url.searchParams.get('app_name')).toBe('muye_novel');
  });

  it('多页：用去重后无新条目作为终止条件', async () => {
    const pages: Record<string, Array<{ book_id: string }>> = {
      '0': Array.from({ length: 50 }, (_, i) => ({ book_id: `a${i}` })),
      '1': [{ book_id: 'b1' }],
    };
    const { f } = fakeFetch({ '/api/author/book/book_list/v0': (u) => ok({ book_list: pages[u.searchParams.get('page_index')!] ?? [] }) });
    const ids = await createFanqieClient(AUTH, f).listBookIds();
    expect(ids).toHaveLength(51);
  });
});

describe('错误分类', () => {
  const run = (resp: () => Response) =>
    createFanqieClient(AUTH, fakeFetch({ '/api/author/book/book_list/v0': resp }).f).listBookIds();

  it('code=-1 / HTTP 401 → PlatformAuthError', async () => {
    await expect(run(() => body(-1, null, '未授权'))).rejects.toBeInstanceOf(PlatformAuthError);
    await expect(run(() => new Response('', { status: 401 }))).rejects.toBeInstanceOf(PlatformAuthError);
  });
  it('HTTP 500 / 抛网络错误 → PlatformUnavailableError', async () => {
    await expect(run(() => new Response('', { status: 500 }))).rejects.toBeInstanceOf(PlatformUnavailableError);
    const f = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(createFanqieClient(AUTH, f).listBookIds()).rejects.toBeInstanceOf(PlatformUnavailableError);
  });
  it('非 JSON / 缺 code / 缺 book_list → PlatformFormatError', async () => {
    await expect(run(() => new Response('<html>'))).rejects.toBeInstanceOf(PlatformFormatError);
    await expect(run(() => new Response('{"hello":1}'))).rejects.toBeInstanceOf(PlatformFormatError);
    await expect(run(() => ok({}))).rejects.toBeInstanceOf(PlatformFormatError);
  });
  it('其他非 0 code → PlatformApiError，文案含 code', async () => {
    await expect(run(() => body(-1019))).rejects.toThrow('code=-1019');
    await expect(run(() => body(-1019))).rejects.toBeInstanceOf(PlatformApiError);
  });
  it('AC7.14 错误文案不含认证信息', async () => {
    for (const resp of [() => body(-1), () => new Response('', { status: 500 }), () => body(-1019), () => new Response('x')]) {
      const e = await run(resp).catch((x) => x as Error);
      expect(e.message).not.toContain('SECRET');
    }
  });
});

describe('listChapters', () => {
  const item = (id: string, title: string, w: number, s = 1) => ({ item_id: id, title, word_number: w, display_status: s });

  it('遍历分卷与分页并去重', async () => {
    const all = Array.from({ length: 250 }, (_, i) => item(`i${i}`, `第${i + 1}章 t`, 10));
    const { f } = fakeFetch({
      '/api/author/volume/volume_list/v1': () => ok({ volume_list: [{ volume_id: 'v1' }, { volume_id: 'v2' }] }),
      '/api/author/chapter/chapter_list/v1': (u) => {
        if (u.searchParams.get('volume_id') === 'v2') return ok({ item_list: [item('x1', '第251章 t', 5, 5)] });
        const p = Number(u.searchParams.get('page_index'));
        return ok({ item_list: all.slice(p * 200, p * 200 + 200) });
      },
    });
    const list = await createFanqieClient(AUTH, f).listChapters('B');
    expect(list).toHaveLength(251);
    expect(list.at(-1)).toEqual({ itemId: 'x1', title: '第251章 t', wordNumber: 5, displayStatus: 5 });
  });

  it('无分卷 → 空数组', async () => {
    const { f } = fakeFetch({ '/api/author/volume/volume_list/v1': () => ok({ volume_list: [] }) });
    expect(await createFanqieClient(AUTH, f).listChapters('B')).toEqual([]);
  });
});

describe('getChapterHtml', () => {
  it('返回正文 HTML；-2014（审核中）→ null；缺 content → PlatformFormatError', async () => {
    const mk = (resp: () => Response) =>
      createFanqieClient(AUTH, fakeFetch({ '/api/author/edit_article/v0/': resp }).f).getChapterHtml('B', 'I');
    expect(await mk(() => ok({ content: '<p>你好</p>' }))).toBe('<p>你好</p>');
    expect(await mk(() => ok({ article_info: { content: '<p>兜底</p>' } }))).toBe('<p>兜底</p>');
    expect(await mk(() => body(-2014, null, '审核中'))).toBeNull();
    await expect(mk(() => ok({}))).rejects.toBeInstanceOf(PlatformFormatError);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/fanqie-client.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** — `src/lib/fanqie-client.ts`：

```ts
import type { Db } from '@/db';
import { UserError } from './result';

const BASE = 'https://fanqienovel.com';
const BOOK_PAGE = 50;
const CHAPTER_PAGE = 200;
const MAX_PAGES = 100;
const TIMEOUT_MS = 15_000;

export class PlatformAuthError extends UserError {
  constructor() { super('认证无效或已过期，请重新获取 Cookie 与 CSRF Token'); }
}
export class PlatformUnavailableError extends UserError {
  constructor() { super('番茄暂时无法访问，稍后重试'); }
}
export class PlatformFormatError extends UserError {
  constructor() { super('番茄返回格式无法识别，接口可能已变更'); }
}
export class PlatformApiError extends UserError {
  constructor(code: number) { super(`番茄接口返回错误（code=${code}）`); }
}

export interface RemoteChapter { itemId: string; title: string; wordNumber: number; displayStatus: number }
export interface FanqieClient {
  listBookIds(): Promise<string[]>;
  listChapters(bookId: string): Promise<RemoteChapter[]>;
  /** 返回线上正文 HTML；审核中读不到时返回 null */
  getChapterHtml(bookId: string, itemId: string): Promise<string | null>;
}
export type ClientFactory = (db: Db, platformId: number) => FanqieClient;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;

export function createFanqieClient(auth: { cookie: string; csrfToken: string }, fetchImpl: typeof fetch = fetch): FanqieClient {
  /** GET 调用。code=0 或在 okCodes 内返回 {code, data}；-1/未授权抛认证错误；其余抛 ApiError。 */
  async function call(path: string, params: Record<string, string | number>, okCodes: number[] = []) {
    const url = new URL(path, BASE);
    url.searchParams.set('aid', '2503');
    url.searchParams.set('app_name', 'muye_novel');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Cookie: auth.cookie, 'X-Secsdk-Csrf-Token': auth.csrfToken, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PlatformUnavailableError();
    }
    if (res.status === 401 || res.status === 403) throw new PlatformAuthError();
    if (!res.ok) throw new PlatformUnavailableError();
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PlatformFormatError();
    }
    if (!isObj(json) || typeof json.code !== 'number') throw new PlatformFormatError();
    const code = json.code;
    if (code === -1 || (code !== 0 && /登录|未授权/.test(String(json.message ?? '')))) throw new PlatformAuthError();
    if (code !== 0 && !okCodes.includes(code)) throw new PlatformApiError(code);
    return { code, data: json.data };
  }

  const arrayAt = (data: unknown, key: string): Json[] => {
    const v = isObj(data) ? data[key] : undefined;
    if (!Array.isArray(v)) throw new PlatformFormatError();
    return v.filter(isObj);
  };

  /** 分页取全：以「本页没有新条目」或「不足一页」为终止，不依赖 page_index 是 0 起还是 1 起。 */
  async function paged<T extends { key: string }>(
    fetchPage: (page: number) => Promise<T[]>,
    pageSize: number,
  ): Promise<T[]> {
    const seen = new Set<string>();
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchPage(page);
      const fresh = rows.filter((r) => r.key && !seen.has(r.key));
      fresh.forEach((r) => seen.add(r.key));
      out.push(...fresh);
      if (fresh.length === 0 || rows.length < pageSize) break;
    }
    return out;
  }

  return {
    async listBookIds() {
      const rows = await paged(async (page) => {
        const { data } = await call('/api/author/book/book_list/v0', { page_index: page, page_count: BOOK_PAGE });
        return arrayAt(data, 'book_list').map((b) => ({ key: String(b.book_id ?? '') }));
      }, BOOK_PAGE);
      return rows.map((r) => r.key);
    },

    async listChapters(bookId) {
      const { data } = await call('/api/author/volume/volume_list/v1', { book_id: bookId });
      const volumes = arrayAt(data, 'volume_list').map((v) => String(v.volume_id ?? '')).filter(Boolean);
      const out: RemoteChapter[] = [];
      for (const volumeId of volumes) {
        const rows = await paged(async (page) => {
          const { data: d } = await call('/api/author/chapter/chapter_list/v1', {
            book_id: bookId, volume_id: volumeId, page_index: page, page_count: CHAPTER_PAGE,
          });
          return arrayAt(d, 'item_list').map((c) => ({
            key: String(c.item_id ?? ''),
            chapter: {
              itemId: String(c.item_id ?? ''),
              title: String(c.title ?? ''),
              wordNumber: Number(c.word_number) || 0,
              displayStatus: Number(c.display_status) || 0,
            } satisfies RemoteChapter,
          }));
        }, CHAPTER_PAGE);
        out.push(...rows.map((r) => r.chapter));
      }
      return out;
    },

    async getChapterHtml(bookId, itemId) {
      const { code, data } = await call('/api/author/edit_article/v0/', { book_id: bookId, item_id: itemId, from_source: 0 }, [-2014]);
      if (code === -2014) return null;
      const d = isObj(data) ? data : {};
      const html = typeof d.content === 'string' ? d.content : isObj(d.article_info) && typeof d.article_info.content === 'string' ? d.article_info.content : null;
      if (html === null) throw new PlatformFormatError();
      return html;
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/fanqie-client.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/fanqie-client.ts src/lib/fanqie-client.test.ts
git commit -m "feat: add read-only fanqie client" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 平台配置、认证保存与链接校验

**Files:**
- Modify: `src/lib/platforms.ts`
- Create: `src/lib/platform-auth.ts`
- Modify: `src/test/helpers.ts`
- Test: `src/lib/platforms.test.ts`（追加）、`src/lib/platform-auth.test.ts`（新）

**Interfaces:**
- Consumes: `parseFanqieBookId`（Task 2）、`FanqieClient` / `ClientFactory` / `PlatformAuthError`（Task 3）。
- Produces（`platforms.ts`）：
```ts
export const SYNC_PLATFORM = '番茄';
export function isSyncConfigured(x: { name: string; cookie: string | null; csrfToken: string | null; bookId: string | null }): boolean;
export function bindPlatform(db, novelId, platformId, bookUrl?): void   // 番茄: 格式校验 + 写 bookId；其余沿用 http(s) 校验
export interface Binding { platform: Platform; bound; bookUrl; publicationCount; syncSupported: boolean; hasAuth: boolean; configured: boolean; lastSyncedAt: number | null; lastSyncError: string | null }
```
- Produces（`platform-auth.ts`）：
```ts
export function saveFanqieAuth(db: Db, platformId: number, input: { cookie: string; csrfToken: string }, makeClient?: ClientFactory-like): Promise<void>
export function clearAuth(db: Db, platformId: number): void
export function authSummaryOf(p: { cookie: string | null }): string | null   // '已配置 · 末4位 abcd'
export function bindPlatformChecked(db, novelId, platformId, bookUrl: string | null, makeClient?): Promise<void>
export const clientForPlatform: ClientFactory
```
  其中 `saveFanqieAuth` 的校验客户端用传入的 `createClient: (auth) => FanqieClient`（默认 `createFanqieClient`），便于测试注入；`bindPlatformChecked` 的 `makeClient` 为 `ClientFactory`（默认 `clientForPlatform`）。
- `src/test/helpers.ts` 新增 `configureFanqie(db, novelId): { platformId: number }`：给番茄写 `cookie='c'`、`csrfToken='t'`，并以样例链接绑定该小说。

- [ ] **Step 1: 写失败测试** — `src/lib/platform-auth.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { novelPlatform, platform } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { PlatformAuthError, type FanqieClient } from './fanqie-client';
import { authSummaryOf, bindPlatformChecked, clearAuth, saveFanqieAuth } from './platform-auth';
import { listPlatforms } from './platforms';

const SAMPLE = 'https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864&坏人?type=1';
const client = (ids: string[] | Error): FanqieClient => ({
  listBookIds: async () => { if (ids instanceof Error) throw ids; return ids; },
  listChapters: async () => [],
  getChapterHtml: async () => null,
});

function setup() {
  const db = makeDb();
  const [fanqie, qidian] = listPlatforms(db);
  const n = insertNovel(db, '/x/A');
  return { db, fanqie, qidian, n };
}
const row = (db: ReturnType<typeof makeDb>, id: number) => db.select().from(platform).where(eq(platform.id, id)).get()!;

describe('saveFanqieAuth', () => {
  it('AC7.3 校验失败不保存', async () => {
    const s = setup();
    await expect(saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'c', csrfToken: 't' }, () => client(new PlatformAuthError())))
      .rejects.toThrow('认证无效或已过期');
    expect(row(s.db, s.fanqie.id).cookie).toBeNull();
  });
  it('校验通过后保存（去首尾空白）', async () => {
    const s = setup();
    await saveFanqieAuth(s.db, s.fanqie.id, { cookie: ' c ', csrfToken: ' t ' }, () => client(['1']));
    expect(row(s.db, s.fanqie.id)).toMatchObject({ cookie: 'c', csrfToken: 't' });
  });
  it('空值、含换行（头注入）、非番茄平台均拒绝', async () => {
    const s = setup();
    const ok = () => client(['1']);
    await expect(saveFanqieAuth(s.db, s.fanqie.id, { cookie: ' ', csrfToken: 't' }, ok)).rejects.toThrow('请填写');
    await expect(saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'a\nb', csrfToken: 't' }, ok)).rejects.toThrow('不能包含换行');
    await expect(saveFanqieAuth(s.db, s.qidian.id, { cookie: 'c', csrfToken: 't' }, ok)).rejects.toThrow('暂不支持自动校验');
  });
  it('clearAuth 清除；authSummaryOf 只露末 4 位', async () => {
    const s = setup();
    await saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'sessionid=abcd1234', csrfToken: 't' }, () => client(['1']));
    expect(authSummaryOf(row(s.db, s.fanqie.id))).toBe('已配置 · 末4位 1234');
    s.db.insert(novelPlatform).values({ novelId: s.n.id, platformId: s.fanqie.id, lastSyncError: 'x' }).run();
    clearAuth(s.db, s.fanqie.id);
    expect(row(s.db, s.fanqie.id)).toMatchObject({ cookie: null, csrfToken: null });
    // 认证变化后旧的失败记录不再成立，否则「认证已失效」不会消失（saveFanqieAuth 同样清除）
    expect(s.db.select().from(novelPlatform).get()!.lastSyncError).toBeNull();
    expect(authSummaryOf(row(s.db, s.fanqie.id))).toBeNull();
  });
});

describe('bindPlatformChecked', () => {
  const link = (s: ReturnType<typeof setup>) =>
    s.db.select().from(novelPlatform).where(eq(novelPlatform.novelId, s.n.id)).get();

  it('AC7.2 格式错误阻止保存', async () => {
    const s = setup();
    await expect(bindPlatformChecked(s.db, s.n.id, s.fanqie.id, 'https://fanqienovel.com/page/1', () => client([]))).rejects.toThrow('链接不符合番茄章节管理页格式');
    expect(link(s)).toBeUndefined();
  });
  it('AC7.4 有认证时校验作品归属', async () => {
    const s = setup();
    await saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'c', csrfToken: 't' }, () => client(['1']));
    await expect(bindPlatformChecked(s.db, s.n.id, s.fanqie.id, SAMPLE, () => client(['999']))).rejects.toThrow('该作品不在当前认证账号下');
    expect(link(s)).toBeUndefined();
    await bindPlatformChecked(s.db, s.n.id, s.fanqie.id, SAMPLE, () => client(['7670888040847395864']));
    expect(link(s)).toMatchObject({ bookId: '7670888040847395864', bookUrl: SAMPLE });
  });
  it('F7.5 无认证：只做格式校验，仍保存（未配置）', async () => {
    const s = setup();
    await bindPlatformChecked(s.db, s.n.id, s.fanqie.id, SAMPLE, () => { throw new Error('不应联网'); });
    expect(link(s)).toMatchObject({ bookId: '7670888040847395864' });
  });
  it('F7.6 非番茄平台沿用 http(s) 校验，不写 bookId', async () => {
    const s = setup();
    await bindPlatformChecked(s.db, s.n.id, s.qidian.id, 'https://book.qidian.com/x', () => { throw new Error('不应联网'); });
    expect(link(s)).toMatchObject({ bookUrl: 'https://book.qidian.com/x', bookId: null });
    await expect(bindPlatformChecked(s.db, s.n.id, s.qidian.id, 'nope', () => client([]))).rejects.toThrow('作品主页链接格式错误');
  });
});
```

追加到 `src/lib/platforms.test.ts`（文件顶部补 `import { isSyncConfigured } from './platforms'`、`import { configureFanqie } from '@/test/helpers'` 等缺失导入）：

```ts
describe('REQ-07 已配置判定与绑定', () => {
  it('isSyncConfigured：番茄 + cookie + csrf + bookId 缺一不可', () => {
    const ok = { name: '番茄', cookie: 'c', csrfToken: 't', bookId: '1' };
    expect(isSyncConfigured(ok)).toBe(true);
    expect(isSyncConfigured({ ...ok, name: '起点' })).toBe(false);
    expect(isSyncConfigured({ ...ok, cookie: null })).toBe(false);
    expect(isSyncConfigured({ ...ok, csrfToken: '' })).toBe(false);
    expect(isSyncConfigured({ ...ok, bookId: null })).toBe(false);
  });
  it('bindPlatform 番茄：解析 bookId；换链接时清空同步记录；listBindings 反映 configured', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const { platformId } = configureFanqie(db, n.id);
    db.update(novelPlatform).set({ lastSyncedAt: 5, lastSyncError: 'x' }).run();
    expect(listBindings(db, n.id).find((b) => b.platform.id === platformId)).toMatchObject({
      bound: true, syncSupported: true, hasAuth: true, configured: true, lastSyncedAt: 5, lastSyncError: 'x',
    });
    bindPlatform(db, n.id, platformId, 'https://fanqienovel.com/main/writer/chapter-manage/42');
    expect(db.select().from(novelPlatform).get()).toMatchObject({ bookId: '42', lastSyncedAt: null, lastSyncError: null });
  });
  it('bindPlatform 番茄：不填链接 → bookId 为空（未配置）', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const [fanqie] = listPlatforms(db);
    bindPlatform(db, n.id, fanqie.id, '');
    expect(db.select().from(novelPlatform).get()).toMatchObject({ bookUrl: null, bookId: null });
  });
});
```

`src/test/helpers.ts` 追加：

```ts
import { eq } from 'drizzle-orm';
import { platform } from '@/db/schema';
import { bindPlatform, listPlatforms } from '@/lib/platforms';

export const SAMPLE_BOOK_URL = 'https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864&坏人?type=1';

/** 给番茄写入测试认证，并以样例链接绑定该小说 → 该（小说, 番茄）为「已配置」。 */
export function configureFanqie(db: Db, novelId: number): { platformId: number } {
  const fanqie = listPlatforms(db).find((p) => p.name === '番茄')!;
  db.update(platform).set({ cookie: 'c', csrfToken: 't' }).where(eq(platform.id, fanqie.id)).run();
  bindPlatform(db, novelId, fanqie.id, SAMPLE_BOOK_URL);
  return { platformId: fanqie.id };
}
```
（合并进文件已有的 `import { novel, type Novel } from '@/db/schema'`，不要重复导入同一模块。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/platform-auth.test.ts src/lib/platforms.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 `platforms.ts`** — 顶部导入加 `parseFanqieBookId`：`import { parseFanqieBookId } from './fanqie-url';`。把 `bindPlatform` 与 `Binding` / `listBindings` 替换为：

```ts
export const SYNC_PLATFORM = '番茄';

export function isSyncConfigured(x: { name: string; cookie: string | null; csrfToken: string | null; bookId: string | null }): boolean {
  return x.name === SYNC_PLATFORM && !!x.cookie && !!x.csrfToken && !!x.bookId;
}

export function bindPlatform(db: Db, novelId: number, platformId: number, bookUrl?: string | null): void {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p) throw new UserError('平台不存在');
  const isSync = p.name === SYNC_PLATFORM;
  const raw = (bookUrl ?? '').trim();
  const url = isSync ? (raw ? (parseFanqieBookId(raw), raw) : null) : validateUrl(bookUrl, '作品主页链接');
  const bookId = isSync && url ? parseFanqieBookId(url) : null;
  db.insert(novelPlatform)
    .values({ novelId, platformId, bookUrl: url, bookId })
    .onConflictDoUpdate({
      target: [novelPlatform.novelId, novelPlatform.platformId],
      // 换了作品 → 之前的同步结果不再适用
      set: { bookUrl: url, bookId, lastSyncedAt: null, lastSyncError: null },
    })
    .run();
}
```

`Binding` 与 `listBindings` 改为：

```ts
export interface Binding {
  platform: Platform;
  bound: boolean;
  bookUrl: string | null;
  publicationCount: number;
  syncSupported: boolean;
  hasAuth: boolean;
  configured: boolean;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
}

export function listBindings(db: Db, novelId: number): Binding[] {
  const links = new Map(db.select().from(novelPlatform).where(eq(novelPlatform.novelId, novelId)).all().map((l) => [l.platformId, l]));
  return db
    .select()
    .from(platform)
    .orderBy(platform.id)
    .all()
    .map((p) => {
      const link = links.get(p.id);
      return {
        platform: p,
        bound: !!link,
        bookUrl: link?.bookUrl ?? null,
        publicationCount: db
          .select({ c: count() })
          .from(publication)
          .innerJoin(chapter, eq(chapter.id, publication.chapterId))
          .where(and(eq(chapter.novelId, novelId), eq(publication.platformId, p.id)))
          .get()!.c,
        syncSupported: p.name === SYNC_PLATFORM,
        hasAuth: !!p.cookie && !!p.csrfToken,
        configured: !!link && isSyncConfigured({ name: p.name, cookie: p.cookie, csrfToken: p.csrfToken, bookId: link.bookId }),
        lastSyncedAt: link?.lastSyncedAt ?? null,
        lastSyncError: link?.lastSyncError ?? null,
      };
    });
}
```

- [ ] **Step 4: 新建 `platform-auth.ts`**：

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { platform } from '@/db/schema';
import { parseFanqieBookId } from './fanqie-url';
import { createFanqieClient, PlatformAuthError, type ClientFactory, type FanqieClient } from './fanqie-client';
import { bindPlatform, SYNC_PLATFORM } from './platforms';
import { UserError } from './result';

export const clientForPlatform: ClientFactory = (db, platformId) => {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p?.cookie || !p.csrfToken) throw new PlatformAuthError();
  return createFanqieClient({ cookie: p.cookie, csrfToken: p.csrfToken });
};

export function authSummaryOf(p: { cookie: string | null }): string | null {
  return p.cookie ? `已配置 · 末4位 ${p.cookie.slice(-4)}` : null;
}

function syncPlatformOrThrow(db: Db, platformId: number) {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.name !== SYNC_PLATFORM) throw new UserError('该平台暂不支持自动校验');
  return p;
}

/** 校验通过才保存。校验方式：用该认证请求书列表接口。 */
export async function saveFanqieAuth(
  db: Db,
  platformId: number,
  input: { cookie: string; csrfToken: string },
  createClient: (auth: { cookie: string; csrfToken: string }) => FanqieClient = createFanqieClient,
): Promise<void> {
  syncPlatformOrThrow(db, platformId);
  const cookie = input.cookie.trim();
  const csrfToken = input.csrfToken.trim();
  if (!cookie || !csrfToken) throw new UserError('请填写 Cookie 和 X-Secsdk-Csrf-Token');
  if (/[\r\n]/.test(cookie) || /[\r\n]/.test(csrfToken)) throw new UserError('Cookie 与 CSRF Token 不能包含换行');
  await createClient({ cookie, csrfToken }).listBookIds();
  db.update(platform).set({ cookie, csrfToken }).where(eq(platform.id, platformId)).run();
  clearSyncErrors(db, platformId); // 认证已更新，旧的失败记录不再成立
}

function clearSyncErrors(db: Db, platformId: number): void {
  db.update(novelPlatform).set({ lastSyncError: null }).where(eq(novelPlatform.platformId, platformId)).run();
}

export function clearAuth(db: Db, platformId: number): void {
  syncPlatformOrThrow(db, platformId);
  db.update(platform).set({ cookie: null, csrfToken: null }).where(eq(platform.id, platformId)).run();
  clearSyncErrors(db, platformId);
}

/** 绑定 + 校验。番茄且已有认证时，额外校验作品归属（book_id 必须在账号书列表内）。 */
export async function bindPlatformChecked(
  db: Db,
  novelId: number,
  platformId: number,
  bookUrl: string | null,
  makeClient: ClientFactory = clientForPlatform,
): Promise<void> {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.name === SYNC_PLATFORM && bookUrl?.trim()) {
    const bookId = parseFanqieBookId(bookUrl); // 先做格式校验，避免无意义的网络请求
    if (p.cookie && p.csrfToken) {
      const ids = await makeClient(db, platformId).listBookIds();
      if (!ids.includes(bookId)) throw new UserError('该作品不在当前认证账号下');
    }
  }
  bindPlatform(db, novelId, platformId, bookUrl);
}
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run src/lib/platform-auth.test.ts src/lib/platforms.test.ts && npx tsc --noEmit`
Expected: PASS。若 `platforms.test.ts` 里已有用非番茄格式 URL 绑定番茄的旧测试失败，把该测试的 URL 改为样例番茄链接（这是行为变更所致）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/platforms.ts src/lib/platform-auth.ts src/lib/platform-auth.test.ts src/lib/platforms.test.ts src/test/helpers.ts
git commit -m "feat: validate fanqie auth and book url on bind" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 同步引擎（三态判定与落库）

**Files:**
- Create: `src/lib/platform-sync.ts`
- Test: `src/lib/platform-sync.test.ts`

**Interfaces:**
- Consumes: `FanqieClient` / `RemoteChapter` / `ClientFactory` / `PlatformAuthError`（Task 3）、`configureFanqie`（Task 4）、`listChapters(db, novelId)`（`./chapters`）、`readChapterFile`（`./file-io`，返回 `{ ok, text }`）、`toPublishBody` / `platformTitle`（`./publish`）、`parseChineseNumber`（`./publish`）。
- Produces:
```ts
export type SyncedStatus = 'unpublished' | 'published' | 'stale';
export interface PlatformSyncCounts { published: number; stale: number; unpublished: number; skipped: number; unreadable: number; remoteExtra: number }
export type PlatformSyncOutcome =
  | ({ ok: true; novelId: number; novelName: string; platformId: number; platformName: string } & PlatformSyncCounts)
  | { ok: false; novelId: number; novelName: string; platformId: number; platformName: string; error: string; authFailed: boolean };
export function parseRemoteTitle(title: string): { seq: number; title: string } | null;
export function htmlToText(html: string): string;
export function decideStatus(i: { local: { seq: number; title: string; wordCount: number }; remote: RemoteChapter | undefined; localBody: () => string | null; remoteHtml: () => Promise<string | null> }): Promise<SyncedStatus | null>; // null = 无法比对
export function syncNovelPlatform(db: Db, novelId: number, platformId: number, client: FanqieClient, now?: number): Promise<PlatformSyncCounts>;
export function syncNovelPlatforms(db: Db, novelId: number, makeClient: ClientFactory, now?: number): Promise<PlatformSyncOutcome[]>;
```

- [ ] **Step 1: 写失败测试** — `src/lib/platform-sync.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chapter, novelPlatform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { PlatformAuthError, PlatformUnavailableError, type FanqieClient, type RemoteChapter } from './fanqie-client';
import { decideStatus, htmlToText, parseRemoteTitle, syncNovelPlatform, syncNovelPlatforms } from './platform-sync';
import { syncNovel } from './sync';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe('parseRemoteTitle / htmlToText', () => {
  it('解析章号（阿拉伯与中文数字），其余为标题', () => {
    expect(parseRemoteTitle('第12章 开端')).toEqual({ seq: 12, title: '开端' });
    expect(parseRemoteTitle('第十二章  开端 ')).toEqual({ seq: 12, title: '开端' });
    expect(parseRemoteTitle('序章')).toBeNull();
  });
  it('htmlToText：段落换行、去标签、反转义', () => {
    expect(htmlToText('<p>a &amp; b</p><p>&lt;c&gt;&#20320;</p>')).toBe('a & b\n<c>你\n');
    expect(htmlToText('x<br/>y')).toBe('x\ny');
  });
});

describe('decideStatus（三态判定表）', () => {
  const local = { seq: 1, title: '开端', wordCount: 6 };
  const remote = (over: Partial<RemoteChapter> = {}): RemoteChapter =>
    ({ itemId: 'i', title: '第1章 开端', wordNumber: 6, displayStatus: 1, ...over });
  const run = (r: RemoteChapter | undefined, body: string | null = '你好，世界。', html: string | null = '<p>你好，世界。</p>') => {
    let htmlCalls = 0;
    const p = decideStatus({ local, remote: r, localBody: () => body, remoteHtml: async () => { htmlCalls++; return html; } });
    return p.then((status) => ({ status, htmlCalls }));
  };

  it('线上没有该章 → 未发布', async () => expect((await run(undefined)).status).toBe('unpublished'));
  it('标题与字数一致 → 已发布，且不拉正文', async () => expect(await run(remote())).toEqual({ status: 'published', htmlCalls: 0 }));
  it('AC7.6 标题不一致 → 需更新，且不拉正文', async () =>
    expect(await run(remote({ title: '第1章 别的', wordNumber: 9 }))).toEqual({ status: 'stale', htmlCalls: 0 }));
  it('AC7.6 标题不一致但字数一致 → 也是需更新', async () =>
    expect((await run(remote({ title: '第1章 别的' }))).status).toBe('stale'));
  it('AC7.7 字数不同、标题一致、正文有差异 → 需更新', async () =>
    expect(await run(remote({ wordNumber: 7 }), '你好，世界。', '<p>你好，世界！</p>')).toEqual({ status: 'stale', htmlCalls: 1 }));
  it('AC7.8 字数不同但正文去空白后一致 → 已发布', async () =>
    expect((await run(remote({ wordNumber: 7 }), '你好，\n世界。', '<p>你好， 世界。</p>')).status).toBe('published'));
  it('AC7.9 审核中：只比标题与字数，不拉正文', async () => {
    expect(await run(remote({ displayStatus: 5 }))).toEqual({ status: 'published', htmlCalls: 0 });
    expect(await run(remote({ displayStatus: 5, wordNumber: 0 }))).toEqual({ status: 'stale', htmlCalls: 0 });
  });
  it('无法比对（本地正文读不到 / 线上正文读不到）→ null', async () => {
    expect((await run(remote({ wordNumber: 7 }), null)).status).toBeNull();
    expect((await run(remote({ wordNumber: 7 }), '你好，世界。', null)).status).toBeNull();
  });
});

// ---------- 带库集成 ----------
const CH = (n: number, title: string, body: string) => `# 第${n}章 ${title}\n\n${body}\n`;

function setup(files: Record<string, string>) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  syncNovel(db, n.id);
  const { platformId } = configureFanqie(db, n.id);
  return { db, n, platformId, dir: t.dir };
}
const rc = (seq: number, title: string, w: number, displayStatus = 1): RemoteChapter =>
  ({ itemId: `item${seq}`, title: `第${seq}章 ${title}`, wordNumber: w, displayStatus });
const wc = (db: ReturnType<typeof makeDb>, seq: number) => db.select().from(chapter).where(eq(chapter.seq, seq)).get()!.wordCount;
const statusOf = (db: ReturnType<typeof makeDb>, platformId: number, seq: number) => {
  const ch = db.select().from(chapter).where(eq(chapter.seq, seq)).get()!;
  return db.select().from(publication).where(and(eq(publication.chapterId, ch.id), eq(publication.platformId, platformId))).get();
};
function fakeClient(remote: RemoteChapter[] | Error, html: Record<string, string | null | Error> = {}) {
  const htmlCalls: string[] = [];
  const c: FanqieClient = {
    listBookIds: async () => [],
    listChapters: async () => { if (remote instanceof Error) throw remote; return remote; },
    getChapterHtml: async (_b, itemId) => {
      htmlCalls.push(itemId);
      const v = html[itemId];
      if (v instanceof Error) throw v;
      return v === undefined ? null : v;
    },
  };
  return { c, htmlCalls };
}

describe('syncNovelPlatform', () => {
  const files = {
    'Ch01-甲.md': CH(1, '甲', '第一章正文。'),
    'Ch02-乙.md': CH(2, '乙', '第二章正文。'),
    'Ch03-丙.md': CH(3, '丙', '第三章正文。'),
    'Ch04-丁.md': CH(4, '丁', '第四章正文。'),
  };

  it('AC7.5 综合：已发布 / 未发布 / 需更新，并记录线上 ID 与字数', async () => {
    const s = setup(files);
    const { c, htmlCalls } = fakeClient(
      [
        rc(1, '甲', wc(s.db, 1)),          // 一致 → 已发布
        rc(3, '改了标题', wc(s.db, 3)),     // 标题不同 → 需更新
        rc(4, '丁', 999),                  // 字数不同 + 正文有差异 → 需更新
        rc(99, '本地没有', 5),              // 线上多出
      ],
      { item4: '<p>完全不一样的正文</p>' },
    );
    const counts = await syncNovelPlatform(s.db, s.n.id, s.platformId, c, 1234);
    expect(counts).toEqual({ published: 1, stale: 2, unpublished: 1, skipped: 0, unreadable: 0, remoteExtra: 1 });
    expect(htmlCalls).toEqual(['item4']);
    expect(statusOf(s.db, s.platformId, 1)).toMatchObject({ status: 'published', platformItemId: 'item1', platformWordCount: wc(s.db, 1), syncedAt: 1234 });
    expect(statusOf(s.db, s.platformId, 2)).toMatchObject({ status: 'unpublished', platformItemId: null });
    expect(statusOf(s.db, s.platformId, 3)?.status).toBe('stale');
    expect(statusOf(s.db, s.platformId, 4)?.status).toBe('stale');
    expect(s.db.select().from(novelPlatform).get()).toMatchObject({ lastSyncedAt: 1234, lastSyncError: null });
  });

  it('再次同步可从需更新回到已发布 / 从已发布变回未发布', async () => {
    const s = setup(files);
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([rc(1, '甲', 1)], { item1: '<p>不同</p>' }).c);
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('stale');
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([rc(1, '甲', wc(s.db, 1))]).c);
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('published');
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([]).c);
    expect(statusOf(s.db, s.platformId, 1)).toMatchObject({ status: 'unpublished', platformItemId: null, platformWordCount: null });
  });

  it('线上同章号重复 → 取列表中最后一条', async () => {
    const s = setup(files);
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([rc(1, '甲', 1), rc(1, '甲', wc(s.db, 1))]).c);
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('published');
  });

  it('文件丢失的章节不参与，保持原状态', async () => {
    const s = setup(files);
    s.db.insert(publication).values({ chapterId: s.db.select().from(chapter).where(eq(chapter.seq, 2)).get()!.id, platformId: s.platformId, status: 'published' }).run();
    s.db.update(chapter).set({ fileMissing: true }).where(eq(chapter.seq, 2)).run();
    const counts = await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([]).c);
    expect(counts.skipped).toBe(1);
    expect(statusOf(s.db, s.platformId, 2)?.status).toBe('published');
  });

  it('单章读正文失败（非认证）→ 该章状态不变、计入无法比对，其他章继续', async () => {
    const s = setup(files);
    const { c } = fakeClient([rc(1, '甲', 1), rc(2, '乙', wc(s.db, 2))], { item1: new PlatformUnavailableError() });
    const counts = await syncNovelPlatform(s.db, s.n.id, s.platformId, c);
    expect(counts.unreadable).toBe(1);
    expect(statusOf(s.db, s.platformId, 1)).toBeUndefined();
    expect(statusOf(s.db, s.platformId, 2)?.status).toBe('published');
  });

  it('读正文时认证失效 → 整个同步中止，不写任何状态', async () => {
    const s = setup(files);
    const { c } = fakeClient([rc(1, '甲', wc(s.db, 1)), rc(2, '乙', 1)], { item2: new PlatformAuthError() });
    await expect(syncNovelPlatform(s.db, s.n.id, s.platformId, c)).rejects.toBeInstanceOf(PlatformAuthError);
    expect(s.db.select().from(publication).all()).toHaveLength(0);
  });
});

describe('syncNovelPlatforms（容错与记录）', () => {
  const files = { 'Ch01-甲.md': CH(1, '甲', '第一章正文。') };

  it('AC7.10 认证失效：状态不变，记录 lastSyncError，authFailed=true', async () => {
    const s = setup(files);
    s.db.insert(publication).values({ chapterId: s.db.select().from(chapter).get()!.id, platformId: s.platformId, status: 'published' }).run();
    const out = await syncNovelPlatforms(s.db, s.n.id, () => fakeClient(new PlatformAuthError()).c);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ok: false, authFailed: true, platformName: '番茄', novelName: s.n.name });
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('published');
    expect(s.db.select().from(novelPlatform).get()!.lastSyncError).toContain('认证无效或已过期');
  });

  it('未配置的绑定不参与同步', async () => {
    const s = setup(files);
    s.db.update(novelPlatform).set({ bookId: null }).run();
    expect(await syncNovelPlatforms(s.db, s.n.id, () => { throw new Error('不应创建客户端'); })).toEqual([]);
  });

  it('成功：返回 ok 结果', async () => {
    const s = setup(files);
    const out = await syncNovelPlatforms(s.db, s.n.id, () => fakeClient([rc(1, '甲', wc(s.db, 1))]).c);
    expect(out[0]).toMatchObject({ ok: true, published: 1, stale: 0, unpublished: 0 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/platform-sync.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** — `src/lib/platform-sync.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novel, novelPlatform, platform, publication, type Chapter } from '@/db/schema';
import { listChapters } from './chapters';
import { PlatformAuthError, type ClientFactory, type FanqieClient, type RemoteChapter } from './fanqie-client';
import { readChapterFile } from './file-io';
import { isSyncConfigured } from './platforms';
import { parseChineseNumber, toPublishBody } from './publish';
import { UserError } from './result';

export type SyncedStatus = 'unpublished' | 'published' | 'stale';
export interface PlatformSyncCounts {
  published: number;
  stale: number;
  unpublished: number;
  skipped: number;
  unreadable: number;
  remoteExtra: number;
}
interface OutcomeBase { novelId: number; novelName: string; platformId: number; platformName: string }
export type PlatformSyncOutcome =
  | (OutcomeBase & { ok: true } & PlatformSyncCounts)
  | (OutcomeBase & { ok: false; error: string; authFailed: boolean });

const REVIEWING = 5; // chapter_list.display_status：审核中
const REMOTE_TITLE_RE = /^\s*第\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*章\s*(.*?)\s*$/;

export function parseRemoteTitle(title: string): { seq: number; title: string } | null {
  const m = REMOTE_TITLE_RE.exec(title);
  if (!m) return null;
  const seq = parseChineseNumber(m[1]);
  return seq === null ? null : { seq, title: m[2] };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** 线上 HTML 正文 → 纯文本（每个 <p> 一行）。先去标签再反转义，故 &lt;p&gt; 不会被当成标签。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const normTitle = (seq: number, title: string) => `第${seq}章 ${title.replace(/\s+/g, ' ').trim()}`;
const squash = (s: string) => s.replace(/\s/g, '');

export async function decideStatus(i: {
  local: { seq: number; title: string; wordCount: number };
  remote: RemoteChapter | undefined;
  localBody: () => string | null;
  remoteHtml: () => Promise<string | null>;
}): Promise<SyncedStatus | null> {
  const { local, remote } = i;
  if (!remote) return 'unpublished';
  const remoteTitle = parseRemoteTitle(remote.title)?.title ?? remote.title;
  const titleSame = normTitle(local.seq, remoteTitle) === normTitle(local.seq, local.title);
  const wordSame = remote.wordNumber === local.wordCount;
  if (titleSame && wordSame) return 'published';
  if (remote.displayStatus === REVIEWING) return 'stale'; // 审核中读不到正文，标题或字数已不一致
  if (!titleSame) return 'stale';
  const body = i.localBody();
  if (body === null) return null;
  const html = await i.remoteHtml();
  if (html === null) return null;
  return squash(htmlToText(html)) === squash(body) ? 'published' : 'stale';
}

function localBodyOf(ch: Chapter): string | null {
  try {
    const r = readChapterFile(ch.filePath);
    return r.ok ? toPublishBody(r.text) : null;
  } catch {
    return null;
  }
}

export async function syncNovelPlatform(
  db: Db,
  novelId: number,
  platformId: number,
  client: FanqieClient,
  now = Date.now(),
): Promise<PlatformSyncCounts> {
  const link = db
    .select()
    .from(novelPlatform)
    .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId)))
    .get();
  const bookId = link?.bookId;
  if (!bookId) throw new UserError('未填写有效的作品链接');

  const bySeq = new Map<number, RemoteChapter>();
  for (const r of await client.listChapters(bookId)) {
    const t = parseRemoteTitle(r.title);
    if (t) bySeq.set(t.seq, r); // 同章号重复：后出现的覆盖前面的
  }
  const locals = listChapters(db, novelId);
  const localSeqs = new Set(locals.map((c) => c.seq));
  const counts: PlatformSyncCounts = {
    published: 0, stale: 0, unpublished: 0, skipped: 0, unreadable: 0,
    remoteExtra: [...bySeq.keys()].filter((s) => !localSeqs.has(s)).length,
  };

  // 所有网络读取先于任何写库：认证中途失效时不会留下半截结果
  const decided: Array<{ ch: Chapter; status: SyncedStatus; remote: RemoteChapter | undefined }> = [];
  for (const ch of locals) {
    if (ch.fileMissing) {
      counts.skipped++;
      continue;
    }
    const remote = bySeq.get(ch.seq);
    try {
      const status = await decideStatus({
        local: ch,
        remote,
        localBody: () => localBodyOf(ch),
        remoteHtml: () => client.getChapterHtml(bookId, remote!.itemId),
      });
      if (status === null) {
        counts.unreadable++;
        continue;
      }
      decided.push({ ch, status, remote });
    } catch (e) {
      if (e instanceof PlatformAuthError) throw e;
      if (e instanceof UserError) {
        counts.unreadable++;
        continue;
      }
      throw e;
    }
  }

  db.$client.transaction(() => {
    for (const d of decided) {
      const set = {
        status: d.status,
        platformItemId: d.remote?.itemId ?? null,
        platformWordCount: d.remote?.wordNumber ?? null,
        syncedAt: now,
      };
      db.insert(publication)
        .values({ chapterId: d.ch.id, platformId, ...set })
        .onConflictDoUpdate({ target: [publication.chapterId, publication.platformId], set })
        .run();
      counts[d.status]++;
    }
    db.update(novelPlatform)
      .set({ lastSyncedAt: now, lastSyncError: null })
      .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId)))
      .run();
  })();
  return counts;
}

/** 对一本小说所有「已配置」平台同步。UserError 级失败记录到 lastSyncError 并作为失败结果返回，不抛出。 */
export async function syncNovelPlatforms(
  db: Db,
  novelId: number,
  makeClient: ClientFactory,
  now = Date.now(),
): Promise<PlatformSyncOutcome[]> {
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n) throw new UserError('小说不存在');
  const rows = db
    .select({ platformId: platform.id, name: platform.name, cookie: platform.cookie, csrfToken: platform.csrfToken, bookId: novelPlatform.bookId })
    .from(novelPlatform)
    .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
    .where(eq(novelPlatform.novelId, novelId))
    .orderBy(platform.id)
    .all()
    .filter(isSyncConfigured);
  const out: PlatformSyncOutcome[] = [];
  for (const r of rows) {
    const base = { novelId, novelName: n.name, platformId: r.platformId, platformName: r.name };
    try {
      out.push({ ok: true, ...base, ...(await syncNovelPlatform(db, novelId, r.platformId, makeClient(db, r.platformId), now)) });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      db.update(novelPlatform)
        .set({ lastSyncError: e.message })
        .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, r.platformId)))
        .run();
      out.push({ ok: false, ...base, error: e.message, authFailed: e instanceof PlatformAuthError });
    }
  }
  return out;
}
```

注意：上面 `.filter(isSyncConfigured)` 的入参需要 `{name, cookie, csrfToken, bookId}`，select 里已提供这四个字段（外加 `platformId`），类型兼容。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/platform-sync.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/platform-sync.ts src/lib/platform-sync.test.ts
git commit -m "feat: sync fanqie publish status into three states" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 重新扫描编排与提示文案

> 按钮要显示真实阶段（"扫描本地文件…""同步番茄…""同步中 X/Y…"，REQ-07 F7.20），一次 Server Action 无法上报进度，所以由客户端依次调用薄 Action，编排逻辑放在可单测的 `rescan-flow.ts`。

**Files:**
- Modify: `src/lib/sync.ts`（`FullSyncSummary.failedNovelIds`）
- Create: `src/lib/rescan.ts`、`src/lib/rescan-flow.ts`、`src/lib/sync-notice.ts`、`src/components/use-rescan-novel.ts`
- Modify: `src/app/actions/library.ts`
- Modify: `src/components/notice.tsx`、`src/components/rescan-novel-button.tsx`、`src/components/card-menu.tsx`、`src/components/dashboard-toolbar.tsx`
- Test: `src/lib/rescan.test.ts`、`src/lib/rescan-flow.test.ts`、`src/lib/sync-notice.test.ts`

**Interfaces:**
- Consumes: `syncNovelPlatforms` / `PlatformSyncOutcome`（Task 5）、`clientForPlatform`（Task 4）。
- Produces：
```ts
// rescan.ts
export function listSyncableNovels(db, failedNovelIds: number[]): Array<{ id: number; name: string }>;
// rescan-flow.ts（无服务端依赖，客户端可用）
export function unwrap<T>(r: ActionResult<T>): T;
export function runRescanNovel(steps, onStage): Promise<{ local: SyncResult; platformSync: PlatformSyncOutcome[] }>;
export function runRescanAll(steps, onProgress, delayMs?): Promise<{ summary: LocalScan; platformSync: PlatformSyncOutcome[] }>;
// sync-notice.ts
export function buildRescanNotice(localText: string, outcomes: PlatformSyncOutcome[], scope: 'novel' | 'all'): RescanNotice;
export interface RescanNotice { kind: 'success' | 'warn'; text: string; alert: { text: string; settingsLink: boolean } | null }
// actions/library.ts（替换 rescanAction / rescanNovelAction）
scanAllLocalAction(); scanNovelLocalAction(novelId); syncPlatformsAction(novelId);
// sync.ts
interface FullSyncSummary { …; failedNovelIds: number[] }
```
- `NoticeInput` 增加可选 `alert?: { text: string; link?: { href: string; label: string } }`：在提示条下方单独显示一条错误条（REQ-07 F7.21）。

- [ ] **Step 1: 写失败测试**

`src/lib/sync-notice.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { PlatformSyncOutcome } from './platform-sync';
import { buildRescanNotice } from './sync-notice';

const ok = (over: Partial<Extract<PlatformSyncOutcome, { ok: true }>> = {}): PlatformSyncOutcome => ({
  ok: true, novelId: 1, novelName: 'A', platformId: 1, platformName: '番茄',
  published: 38, stale: 2, unpublished: 10, skipped: 0, unreadable: 0, remoteExtra: 0, ...over,
});
const bad = (over: Partial<Extract<PlatformSyncOutcome, { ok: false }>> = {}): PlatformSyncOutcome => ({
  ok: false, novelId: 1, novelName: 'A', platformId: 1, platformName: '番茄', error: '番茄暂时无法访问，稍后重试', authFailed: false, ...over,
});

describe('buildRescanNotice', () => {
  it('无已配置平台：只有本地文案', () => {
    expect(buildRescanNotice('本地扫描完成', [], 'novel')).toEqual({ kind: 'success', text: '本地扫描完成', alert: null });
  });
  it('F7.13 成功汇总：丢失、线上多出、无法比对都计入', () => {
    expect(buildRescanNotice('本地扫描完成', [ok({ published: 6, stale: 2, unpublished: 3, skipped: 1, remoteExtra: 1, unreadable: 2 })], 'novel').text)
      .toBe('本地扫描完成。番茄同步完成：已发布 6、需更新 2、未发布 3；1 章文件丢失未比对；线上多出 1 章本地没有；2 章无法比对，状态未改动');
  });
  it('F7.21 单本失败：本地结果保留，错误单独一条', () => {
    expect(buildRescanNotice('本地扫描完成', [bad()], 'novel')).toEqual({
      kind: 'success', text: '本地扫描完成',
      alert: { text: '番茄暂时无法访问，稍后重试。各章状态未改动', settingsLink: false },
    });
  });
  it('单本认证失效：带去设置', () => {
    expect(buildRescanNotice('x', [bad({ authFailed: true, error: '认证无效或已过期' })], 'novel').alert).toEqual({
      text: '番茄同步失败：认证已失效，各章状态未改动', settingsLink: true,
    });
  });
  it('全局全部成功：求和', () => {
    expect(buildRescanNotice('x', [ok(), ok({ novelId: 2, published: 1, stale: 0, unpublished: 0 })], 'all').text).toContain('已发布 39、需更新 2、未发布 10');
  });
  it('AC7.15 全局部分失败：只汇总本数，详情在卡片上', () => {
    expect(buildRescanNotice('x', [ok(), bad({ novelId: 2 })], 'all')).toEqual({ kind: 'warn', text: 'x。番茄同步：1 本成功，1 本失败', alert: null });
  });
  it('全局认证失效：不重复错误条（看板顶部已有常驻错误条）', () => {
    expect(buildRescanNotice('x', [bad({ authFailed: true })], 'all')).toEqual({ kind: 'warn', text: 'x。番茄同步未执行：认证已失效', alert: null });
  });
});
```

`src/lib/rescan-flow.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { PlatformSyncOutcome } from './platform-sync';
import type { SyncResult } from './sync';
import { runRescanAll, runRescanNovel, unwrap } from './rescan-flow';

const local = { added: 1, updated: 0, issues: 0 } as unknown as SyncResult;
const okOut = { ok: true, novelId: 1, novelName: 'A', platformId: 1, platformName: '番茄', published: 1, stale: 0, unpublished: 0, skipped: 0, unreadable: 0, remoteExtra: 0 } as PlatformSyncOutcome;

describe('runRescanNovel', () => {
  it('F7.8/F7.20 先本地后同步，并依次上报阶段', async () => {
    const stages: string[] = [];
    const r = await runRescanNovel({ local: async () => local, platforms: async () => [okOut] }, (s) => stages.push(s));
    expect(stages).toEqual(['local', 'remote']);
    expect(r.platformSync).toEqual([okOut]);
  });
  it('F7.15 本地扫描报错 → 不同步', async () => {
    const r = await runRescanNovel(
      { local: async () => ({ ...local, error: '目录不可读' }), platforms: async () => { throw new Error('不应联网'); } },
      () => {},
    );
    expect(r.platformSync).toEqual([]);
  });
  it('同步抛错不影响本地结果，转为失败结果', async () => {
    const r = await runRescanNovel({ local: async () => local, platforms: async () => { throw new Error('boom'); } }, () => {});
    expect(r.local).toBe(local);
    expect(r.platformSync[0]).toMatchObject({ ok: false, error: 'boom', authFailed: false });
  });
});

describe('runRescanAll', () => {
  const summary = (syncable: Array<{ id: number; name: string }>) => ({ syncable } as never);
  it('F7.9/F7.20 串行同步并上报 X/Y；AC7.15 一本失败不影响另一本', async () => {
    const seen: string[] = [];
    const calls: number[] = [];
    const r = await runRescanAll(
      {
        local: async () => summary([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]),
        sync: async (id) => {
          calls.push(id);
          if (id === 1) throw new Error('boom');
          return [okOut];
        },
      },
      (p) => seen.push(`${p.done}/${p.total}`),
      0,
    );
    expect(calls).toEqual([1, 2]);
    expect(seen).toEqual(['1/2', '2/2']);
    expect(r.platformSync.map((o) => o.ok)).toEqual([false, true]);
    expect(r.platformSync[0]).toMatchObject({ novelName: 'A', error: 'boom' });
  });
});

it('unwrap', () => {
  expect(unwrap({ ok: true, data: 1 })).toBe(1);
  expect(() => unwrap({ ok: false, error: 'x' })).toThrow('x');
});
```

`src/lib/rescan.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { configureFanqie, insertNovel, makeDb } from '@/test/helpers';
import { setArchived } from './library';
import { listSyncableNovels } from './rescan';

describe('listSyncableNovels', () => {
  it('只含未归档、已配置、本地扫描未失败的小说', () => {
    const db = makeDb();
    const a = insertNovel(db, '/x/A', { name: 'A' });
    configureFanqie(db, a.id);
    insertNovel(db, '/x/B', { name: 'B' }); // 未配置
    const c = insertNovel(db, '/x/C', { name: 'C' });
    configureFanqie(db, c.id);
    const d = insertNovel(db, '/x/D', { name: 'D' });
    configureFanqie(db, d.id);
    setArchived(db, d.id, true);
    expect(listSyncableNovels(db, [c.id])).toEqual([{ id: a.id, name: 'A' }]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/sync-notice.test.ts src/lib/rescan-flow.test.ts src/lib/rescan.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 `sync.ts`** — `FullSyncSummary` 增加 `failedNovelIds: number[]`；`scanAndSync` 初始化 `failedNovelIds: []`；循环里 `if (r.error) { out.errors.push(...); out.failedNovelIds.push(n.id); }`，`catch` 里同样 push。

- [ ] **Step 4: 新建 `rescan.ts` 与 `rescan-flow.ts`**

`src/lib/rescan.ts`：

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { novel, novelPlatform, platform } from '@/db/schema';
import { isSyncConfigured } from './platforms';

/** 全局重新扫描要同步的小说：未归档、至少一个已配置平台、本地扫描未失败（F7.9 / F7.15）。 */
export function listSyncableNovels(db: Db, failedNovelIds: number[]): Array<{ id: number; name: string }> {
  const failed = new Set(failedNovelIds);
  const configured = new Set(
    db
      .select({ novelId: novelPlatform.novelId, name: platform.name, cookie: platform.cookie, csrfToken: platform.csrfToken, bookId: novelPlatform.bookId })
      .from(novelPlatform)
      .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
      .all()
      .filter(isSyncConfigured)
      .map((r) => r.novelId),
  );
  return db
    .select({ id: novel.id, name: novel.name })
    .from(novel)
    .where(eq(novel.archived, false))
    .all()
    .filter((n) => configured.has(n.id) && !failed.has(n.id));
}
```

`src/lib/rescan-flow.ts`（只用 `import type`，不引入服务端模块）：

```ts
import type { PlatformSyncOutcome } from './platform-sync';
import type { ActionResult } from './result';
import type { FullSyncSummary, SyncResult } from './sync';

export type LocalScan = FullSyncSummary & { syncable: Array<{ id: number; name: string }> };

export function unwrap<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failure = (novelId: number, novelName: string, e: unknown): PlatformSyncOutcome => ({
  ok: false, novelId, novelName, platformId: 0, platformName: '番茄', error: (e as Error).message, authFailed: false,
});

/** 单本：本地扫描成功后再同步。同步抛错不影响已拿到的本地结果。 */
export async function runRescanNovel(
  steps: { local: () => Promise<SyncResult>; platforms: () => Promise<PlatformSyncOutcome[]> },
  onStage: (stage: 'local' | 'remote') => void,
): Promise<{ local: SyncResult; platformSync: PlatformSyncOutcome[] }> {
  onStage('local');
  const local = await steps.local();
  if (local.error) return { local, platformSync: [] };
  onStage('remote');
  try {
    return { local, platformSync: await steps.platforms() };
  } catch (e) {
    return { local, platformSync: [failure(0, '', e)] };
  }
}

/** 全局：本地扫描后逐本串行同步（间隔 delayMs），每本完成后上报进度。 */
export async function runRescanAll(
  steps: { local: () => Promise<LocalScan>; sync: (novelId: number) => Promise<PlatformSyncOutcome[]> },
  onProgress: (p: { done: number; total: number }) => void,
  delayMs = 300,
): Promise<{ summary: LocalScan; platformSync: PlatformSyncOutcome[] }> {
  const summary = await steps.local();
  const platformSync: PlatformSyncOutcome[] = [];
  const total = summary.syncable.length;
  for (const [i, n] of summary.syncable.entries()) {
    onProgress({ done: i + 1, total });
    try {
      platformSync.push(...(await steps.sync(n.id)));
    } catch (e) {
      platformSync.push(failure(n.id, n.name, e));
    }
    if (delayMs > 0 && i < total - 1) await sleep(delayMs);
  }
  return { summary, platformSync };
}
```

- [ ] **Step 5: 新建 `sync-notice.ts`**：

```ts
import type { PlatformSyncOutcome } from './platform-sync';

export interface RescanNotice {
  kind: 'success' | 'warn';
  text: string;
  alert: { text: string; settingsLink: boolean } | null;
}

type Ok = Extract<PlatformSyncOutcome, { ok: true }>;
type Bad = Extract<PlatformSyncOutcome, { ok: false }>;

function successText(oks: Ok[]): string {
  const sum = (k: 'published' | 'stale' | 'unpublished' | 'skipped' | 'unreadable' | 'remoteExtra') => oks.reduce((s, o) => s + o[k], 0);
  let t = `番茄同步完成：已发布 ${sum('published')}、需更新 ${sum('stale')}、未发布 ${sum('unpublished')}`;
  if (sum('skipped') > 0) t += `；${sum('skipped')} 章文件丢失未比对`;
  if (sum('remoteExtra') > 0) t += `；线上多出 ${sum('remoteExtra')} 章本地没有`;
  if (sum('unreadable') > 0) t += `；${sum('unreadable')} 章无法比对，状态未改动`;
  return t;
}

export function buildRescanNotice(localText: string, outcomes: PlatformSyncOutcome[], scope: 'novel' | 'all'): RescanNotice {
  const oks = outcomes.filter((o): o is Ok => o.ok);
  const bads = outcomes.filter((o): o is Bad => !o.ok);
  if (bads.length === 0) {
    return { kind: 'success', text: oks.length ? `${localText}。${successText(oks)}` : localText, alert: null };
  }
  const authFailed = bads.some((b) => b.authFailed);
  if (scope === 'novel') {
    return {
      kind: 'success',
      text: oks.length ? `${localText}。${successText(oks)}` : localText,
      alert: authFailed
        ? { text: '番茄同步失败：认证已失效，各章状态未改动', settingsLink: true }
        : { text: `${bads[0].error}。各章状态未改动`, settingsLink: false },
    };
  }
  return {
    kind: 'warn',
    text: authFailed ? `${localText}。番茄同步未执行：认证已失效` : `${localText}。番茄同步：${oks.length} 本成功，${bads.length} 本失败`,
    alert: null,
  };
}
```

- [ ] **Step 6: 改 Server Action 与组件**

`src/app/actions/library.ts`：删除 `rescanAction`、`rescanNovelAction`，新增（`setArchivedAction` 等继续用 `syncNovel`）：

```ts
import { clientForPlatform } from '@/lib/platform-auth';
import { syncNovelPlatforms } from '@/lib/platform-sync';
import { listSyncableNovels } from '@/lib/rescan';

/** 手动重新扫描：忽略 mtime/size 短路；同步由客户端随后逐本调用 syncPlatformsAction。 */
export async function scanAllLocalAction() {
  return wrap(() => {
    try {
      const db = getDb();
      const s = scanAndSync(db, { force: true });
      return { ...s, syncable: listSyncableNovels(db, s.failedNovelIds) };
    } finally {
      refresh();
    }
  });
}

export async function scanNovelLocalAction(novelId: number) {
  return wrap(() => {
    try {
      return syncNovel(getDb(), novelId, { force: true });
    } finally {
      refresh();
    }
  });
}

export async function syncPlatformsAction(novelId: number) {
  return wrap(async () => {
    try {
      return await syncNovelPlatforms(getDb(), novelId, clientForPlatform);
    } finally {
      refresh();
    }
  });
}
```

`src/components/notice.tsx`：`NoticeInput` 增加 `alert?: { text: string; link?: { href: string; label: string } };`，顶部 `import Link from 'next/link';`。把现有提示条和下面的错误条放在同一个容器里：

```tsx
      {n?.alert && (
        <div role="alert" className="mx-auto mt-2 flex max-w-6xl items-center gap-3 rounded border border-dashed border-red-400 bg-red-50 px-4 py-2 font-medium text-red-800">
          <span className="flex-1">{n.alert.text}</span>
          {n.alert.link && <Link className="font-bold underline" href={n.alert.link.href}>{n.alert.link.label}</Link>}
        </div>
      )}
```

新建 `src/components/use-rescan-novel.ts`（详情页按钮与卡片菜单共用）：

```ts
'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { scanNovelLocalAction, syncPlatformsAction } from '@/app/actions/library';
import { runRescanNovel, unwrap } from '@/lib/rescan-flow';
import { buildRescanNotice } from '@/lib/sync-notice';
import { useNotice } from './notice';

export function useRescanNovel(novelId: number, prefix = '') {
  const [pending, start] = useTransition();
  const [stage, setStage] = useState<'local' | 'remote'>('local');
  const router = useRouter();
  const { notify } = useNotice();
  const rescan = (after?: () => void) =>
    start(async () => {
      try {
        const { local, platformSync } = await runRescanNovel(
          { local: async () => unwrap(await scanNovelLocalAction(novelId)), platforms: async () => unwrap(await syncPlatformsAction(novelId)) },
          setStage,
        );
        if (local.error) {
          notify({ kind: 'warn', text: `${prefix}本地目录不可访问，未执行同步，各章状态未改动` });
        } else {
          const added = local.added > 0 ? `新增 ${local.added} 章、` : '';
          const n = buildRescanNotice(`${prefix}本地扫描完成：${added}更新 ${local.updated} 章，${local.issues} 个文件需要处理`, platformSync, 'novel');
          notify({
            kind: n.kind, text: n.text,
            alert: n.alert ? { text: n.alert.text, link: n.alert.settingsLink ? { href: '/settings#fanqie', label: '去设置' } : undefined } : undefined,
          });
        }
        router.refresh();
      } catch (e) {
        notify({ kind: 'error', text: (e as Error).message });
      } finally {
        after?.();
      }
    });
  return { pending, stage, rescan };
}
```

`src/components/rescan-novel-button.tsx` 替换为：

```tsx
'use client';
import { useRescanNovel } from './use-rescan-novel';

/** hasSync：这本书有已配置平台时按钮作为主操作，并显示同步阶段（F7.20）。 */
export function RescanNovelButton({ novelId, hasSync }: { novelId: number; hasSync: boolean }) {
  const { pending, stage, rescan } = useRescanNovel(novelId);
  const label = !pending ? '重新扫描' : !hasSync ? '扫描中…' : stage === 'local' ? '扫描本地文件…' : '同步番茄…';
  return (
    <button className={`min-w-[124px] rounded px-4 ${hasSync ? 'bg-stone-900 font-medium text-white' : 'border'}`} disabled={pending} onClick={() => rescan()}>
      {label}
    </button>
  );
}
```

`src/components/card-menu.tsx`：去掉 `rescanNovelAction` 导入与 `rescan` 函数，改用 `const { pending: scanning, rescan } = useRescanNovel(novelId, `《${name}》`);`；"重新扫描此书"按钮 `disabled={pending || scanning}`，`onClick={() => rescan(() => setOpen(false))}`。

`src/components/dashboard-toolbar.tsx`：导入改为 `scanAllLocalAction, syncPlatformsAction`，增加 `import { runRescanAll, unwrap } from '@/lib/rescan-flow';`、`import { buildRescanNotice } from '@/lib/sync-notice';`；增加 `const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);`。`scan` 替换为：

```tsx
  const scan = async (prefix?: string) => {
    try {
      const { summary: s, platformSync } = await runRescanAll(
        { local: async () => unwrap(await scanAllLocalAction()), sync: async (id) => unwrap(await syncPlatformsAction(id)) },
        setProgress,
      );
      const changed = s.chapters.added + s.chapters.updated + s.chapters.restored;
      const issues = s.issues > 0 ? `、${s.issues} 个文件无法识别` : '';
      const n = buildRescanNotice(prefix ?? `本地扫描完成：新增 ${s.newNovels} 本、更新 ${changed} 章${issues}`, platformSync, 'all');
      notify({ kind: s.errors.length ? 'warn' : n.kind, text: n.text });
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message });
    } finally {
      setProgress(null);
      router.refresh();
    }
  };
```
按钮文案：`{progress ? `同步中 ${progress.done}/${progress.total}…` : scanning ? '扫描中…' : '重新扫描'}`，并加 `min-w-[110px]`。

- [ ] **Step 7: 运行测试与类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS（`sync.test.ts` 里若断言 `scanAndSync` 返回值的整体相等，需补上 `failedNovelIds: []`）。再确认旧 Action 无残留：

Run: `grep -rnE "rescanAction|rescanNovelAction" src`
Expected: 无输出。

- [ ] **Step 8: 提交**

```bash
git add src/lib/sync.ts src/lib/rescan.ts src/lib/rescan.test.ts src/lib/rescan-flow.ts src/lib/rescan-flow.test.ts src/lib/sync-notice.ts src/lib/sync-notice.test.ts src/app/actions/library.ts src/components/notice.tsx src/components/use-rescan-novel.ts src/components/rescan-novel-button.tsx src/components/card-menu.tsx src/components/dashboard-toolbar.tsx
git commit -m "feat: sync configured platforms on rescan with staged progress" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 状态展示分流，移除手动标记与 hash 过期逻辑

> 这一步是对 MVP 的破坏性清理，范围由 REQ-07 §4.2 / §7 规定：已配置平台不可手动标记、未配置平台无状态。`publication.published_hash` 列保留（不做破坏性迁移），代码不再读写它。

**Files:**
- Modify: `src/lib/types.ts`、`src/lib/publish.ts`、`src/lib/publications.ts`、`src/lib/matrix.ts`、`src/lib/stats.ts`
- Delete: `src/components/publication-actions.tsx`、`src/lib/stale.integration.test.ts`
- Create: `src/lib/sync-status.ts`、`src/components/sync-strip.tsx`、`src/components/setup-checklist.tsx`
- Modify: `src/app/actions/publications.ts`、`src/components/badge.tsx`、`src/components/matrix-table.tsx`、`src/components/platform-card.tsx`、`src/components/platform-cards.tsx`、`src/components/ratio-bar.tsx`、`src/components/novel-card.tsx`
- Modify: `src/app/page.tsx`、`src/app/novels/[id]/page.tsx`、`src/components/copy-menu.tsx`
- Test: 新增 `src/lib/sync-status.test.ts`；重写 `src/lib/matrix.test.ts`、`src/lib/stats.test.ts`、`src/lib/publications.test.ts`；改 `src/lib/publish.test.ts`、`src/lib/publication-patch.test.ts`（如需要）

**Interfaces:**
- Produces：
```ts
// types.ts
export type PublishStatus = 'unpublished' | 'published' | 'stale';
export type Badge = PublishStatus;
// publish.ts（新增；删除 isStale / deriveBadge / badgeHint / OVERWRITE_WARNING / ChapterForBadge / PublicationForBadge）
export function syncedStatus(raw: string | null | undefined): PublishStatus;
export const syncHint: (platformName: string) => string;
// matrix.ts
interface MatrixCell { platformId; platformName; configured: boolean; status: PublishStatus; badge: Badge | null; publishedAt; platformUrl; hint?: string; platformWordCount: number | null; syncedAt: number | null; lastSyncedAt: number | null; changedSinceSync: boolean }
Matrix.platforms: Array<{ id: number; name: string; bookUrl: string | null; configured: boolean; lastSyncedAt: number | null; lastSyncError: string | null }>
Matrix.changedCount: number // 已配置平台上，同步后有本地改动的章节数
// sync-status.ts
export function isAuthSyncError(e: string | null | undefined): boolean;
export function syncErrorLabel(e: string): string;
export function fmtSyncTime(ms: number, now?: number): string;
export function syncStrip(i: { lastSyncedAt: number | null; lastSyncError: string | null; changedCount: number; now?: number }): { tone: 'info' | 'warn'; title: string; detail: string };
export function staleReason(platformWordCount: number | null, localWordCount: number): string;
export function cardSyncLine(i: { lastSyncedAt: number | null; lastSyncError: string | null; now?: number }): { text: string; failed: boolean };
// stats.ts
interface PlatformStat { platformId; platformName; configured: boolean; published: number; stale: number; unpublished: number; lastSyncedAt: number | null; lastSyncError: string | null }
```
- `publications.ts` 只保留：`PubSnapshot`、`snapshotOf`、`updatePublicationInfo`（及其私有 helper `getChapter` / `rowOf` / `write`）。删除：`PubAction`、`expectedStatus`、`nextPublication`、`applyPublicationAction`、`restorePublication`。
- `actions/publications.ts` 只保留 `updatePublicationInfoAction`。

- [ ] **Step 1: 先写新测试（会失败）**

**`src/lib/matrix.test.ts` 整体替换为：**

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { chapter, platform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb } from '@/test/helpers';
import { getChapterCells, getMatrix, parseFilter } from './matrix';
import { bindPlatform, listPlatforms, unbindPlatform } from './platforms';

function setup() {
  const db = makeDb();
  const n = insertNovel(db, '/x/A');
  const [fanqie, qidian] = listPlatforms(db);
  configureFanqie(db, n.id); // 番茄：已配置
  bindPlatform(db, n.id, qidian.id); // 起点：未配置
  const mk = (seq: number, over: Partial<typeof chapter.$inferInsert> = {}) =>
    db.insert(chapter).values({ novelId: n.id, seq, title: `T${seq}`, filePath: `/x/A/Ch${seq}.md`, contentHash: `H${seq}`, ...over }).returning().get();
  const pub = (chapterId: number, platformId: number, status: string) =>
    db.insert(publication).values({ chapterId, platformId, status: status as never }).run();
  return { db, n, fanqie, qidian, mk, pub };
}

describe('getMatrix', () => {
  it('platform 参数指向未绑定平台时归为全部平台', () => {
    const s = setup();
    s.mk(1);
    unbindPlatform(s.db, s.n.id, s.qidian.id);
    const m = getMatrix(s.db, s.n.id, { filter: 'unpublished', platformId: s.qidian.id });
    expect(m.platformId).toBeNull();
    expect(m.counts.unpublished).toBe(1);
    expect(getMatrix(s.db, s.n.id, { platformId: s.fanqie.id }).platformId).toBe(s.fanqie.id);
  });

  it('AC3.3 只显示已绑定平台的列，并标注是否已配置', () => {
    const s = setup();
    unbindPlatform(s.db, s.n.id, s.qidian.id);
    s.mk(1);
    const m = getMatrix(s.db, s.n.id);
    expect(m.platforms).toMatchObject([{ name: '番茄', configured: true }]);
  });

  it('AC7.11/7.12 已配置列三态徽标；未配置列无徽标', () => {
    const s = setup();
    const c1 = s.mk(1);
    const c2 = s.mk(2);
    s.mk(3);
    const c4 = s.mk(4, { fileMissing: true });
    s.pub(c1.id, s.fanqie.id, 'published');
    s.pub(c2.id, s.fanqie.id, 'stale');
    s.pub(c4.id, s.fanqie.id, 'published');
    s.pub(c1.id, s.qidian.id, 'published'); // 未配置平台的遗留记录：不展示
    const m = getMatrix(s.db, s.n.id);
    expect(m.rows.map((r) => r.cells[0].badge)).toEqual(['published', 'stale', 'unpublished', 'published']);
    expect(m.rows.map((r) => r.cells[1].badge)).toEqual([null, null, null, null]);
    expect(m.rows[0].cells[0].hint).toBe('状态由番茄同步，点击重新扫描刷新');
    expect(m.rows[0].cells[1]).toMatchObject({ configured: false, hint: '未配置，无状态' });
    expect(m.counts).toEqual({ all: 4, stale: 1, unpublished: 1 });
  });

  it('F7.22 同步后有改动：文件修改时间晚于该章同步时间；从未同步或文件丢失不算', () => {
    const s = setup();
    const c1 = s.mk(1, { mtimeMs: 2000 });
    const c2 = s.mk(2, { mtimeMs: 500 });
    const c3 = s.mk(3, { mtimeMs: 2000 });
    const c4 = s.mk(4, { mtimeMs: 2000, fileMissing: true });
    for (const c of [c1, c2, c4]) {
      s.db.insert(publication).values({ chapterId: c.id, platformId: s.fanqie.id, status: 'published', syncedAt: 1000, platformWordCount: 77 }).run();
    }
    const m = getMatrix(s.db, s.n.id);
    expect(m.rows.map((r) => r.cells[0].changedSinceSync)).toEqual([true, false, false, false]);
    expect(m.changedCount).toBe(1);
    expect(m.rows[0].cells[0].platformWordCount).toBe(77);
    expect(c3.id).toBeGreaterThan(0);
  });

  it('清除认证 → 番茄变为未配置，整列无徽标', () => {
    const s = setup();
    const c = s.mk(1);
    s.pub(c.id, s.fanqie.id, 'published');
    s.db.update(platform).set({ cookie: null }).where(eq(platform.id, s.fanqie.id)).run();
    const m = getMatrix(s.db, s.n.id);
    expect(m.platforms.find((p) => p.name === '番茄')!.configured).toBe(false);
    expect(m.rows[0].cells.map((x) => x.badge)).toEqual([null, null]);
  });

  it('MVP 遗留的 pending_review 按未发布展示', () => {
    const s = setup();
    const c = s.mk(1);
    s.pub(c.id, s.fanqie.id, 'pending_review');
    expect(getMatrix(s.db, s.n.id).rows[0].cells[0].badge).toBe('unpublished');
  });

  it('筛选：任一已配置平台命中；平台下拉限定范围；filter=all 返回全部', () => {
    const s = setup();
    const c1 = s.mk(1);
    s.mk(2);
    s.pub(c1.id, s.fanqie.id, 'stale');
    expect(getMatrix(s.db, s.n.id, { filter: 'stale' }).rows.map((r) => r.chapter.seq)).toEqual([1]);
    expect(getMatrix(s.db, s.n.id, { filter: 'unpublished' }).rows.map((r) => r.chapter.seq)).toEqual([2]);
    expect(getMatrix(s.db, s.n.id, { filter: 'unpublished', platformId: s.qidian.id }).rows).toHaveLength(0); // 起点未配置，无状态
    expect(getMatrix(s.db, s.n.id, { filter: 'all' }).rows).toHaveLength(2);
  });
});

it('parseFilter', () => {
  expect(parseFilter('stale')).toBe('stale');
  expect(parseFilter('unpublished')).toBe('unpublished');
  expect(parseFilter('xx')).toBe('all');
  expect(parseFilter(undefined)).toBe('all');
});

describe('getChapterCells', () => {
  it('返回该章在每个已绑定平台的单元格', () => {
    const s = setup();
    const c = s.mk(1);
    expect(getChapterCells(s.db, c.id).map((x) => [x.platformName, x.configured, x.badge])).toEqual([['番茄', true, 'unpublished'], ['起点', false, null]]);
  });
});
```

**`src/lib/stats.test.ts` 整体替换为：**

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { chapter, libraryRoot, novel, platform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb } from '@/test/helpers';
import { bindPlatform, listPlatforms } from './platforms';
import { getDashboard, parseSort } from './stats';
import { setArchived } from './library';

type Db = ReturnType<typeof makeDb>;
function base() {
  const db = makeDb();
  const [fanqie, qidian] = listPlatforms(db);
  const mkNovel = (name: string, over: Partial<typeof novel.$inferInsert> = {}) => insertNovel(db, `/x/${name}`, over);
  const mkCh = (novelId: number, seq: number, over: Partial<typeof chapter.$inferInsert> = {}) =>
    db.insert(chapter).values({ novelId, seq, title: `T${seq}`, filePath: `/x/${seq}.md`, wordCount: 100, contentHash: `H${seq}`, ...over }).returning().get();
  const pub = (chapterId: number, platformId: number, status: string) =>
    db.insert(publication).values({ chapterId, platformId, status: status as never }).run();
  return { db, fanqie, qidian, mkNovel, mkCh, pub };
}
const stat = (db: Db, name: string) => getDashboard(db, { showArchived: true }).novels.find((n) => n.novel.name === name)!;

describe('getDashboard 统计口径', () => {
  it('AC6.1/6.2 章数、字数（不含丢失）、已配置平台计数与恒等式', () => {
    const s = base();
    const n = s.mkNovel('A');
    configureFanqie(s.db, n.id);
    bindPlatform(s.db, n.id, s.qidian.id); // 未配置
    const c1 = s.mkCh(n.id, 1);
    const c2 = s.mkCh(n.id, 2);
    s.mkCh(n.id, 3);
    const c4 = s.mkCh(n.id, 4, { fileMissing: true, wordCount: 999 });
    s.pub(c1.id, s.fanqie.id, 'published');
    s.pub(c2.id, s.fanqie.id, 'stale');
    s.pub(c4.id, s.fanqie.id, 'published');
    s.pub(c1.id, s.qidian.id, 'published'); // 未配置：不计入

    const a = stat(s.db, 'A');
    expect([a.chapterCount, a.wordCount, a.missingCount]).toEqual([4, 300, 1]);
    expect(a.platforms[0]).toEqual({ platformId: s.fanqie.id, platformName: '番茄', configured: true, published: 2, stale: 1, unpublished: 1, lastSyncedAt: null, lastSyncError: null });
    expect(a.platforms[1]).toEqual({ platformId: s.qidian.id, platformName: '起点', configured: false, published: 0, stale: 0, unpublished: 0, lastSyncedAt: null, lastSyncError: null });
    expect(a.platforms[0].published + a.platforms[0].stale + a.platforms[0].unpublished).toBe(a.chapterCount);
    expect(a.staleChapters).toBe(1);
  });

  it('F7.19 未配置的番茄（无认证 / 无链接）不计入，staleChapters 为 0', () => {
    const s = base();
    const n = s.mkNovel('A');
    configureFanqie(s.db, n.id);
    const c = s.mkCh(n.id, 1);
    s.pub(c.id, s.fanqie.id, 'stale');
    expect(stat(s.db, 'A').staleChapters).toBe(1);
    s.db.update(platform).set({ cookie: null }).where(eq(platform.id, s.fanqie.id)).run();
    const a = stat(s.db, 'A');
    expect(a.platforms[0]).toMatchObject({ configured: false, stale: 0 });
    expect(a.staleChapters).toBe(0);
  });

  it('AC6.5 未绑定平台 → platforms 为空', () => {
    const s = base();
    s.mkNovel('A');
    expect(stat(s.db, 'A').platforms).toEqual([]);
  });

  it('绑定了平台但 0 章 → 计数为 0；未绑定平台的发布记录不计入', () => {
    const s = base();
    const n = s.mkNovel('A');
    configureFanqie(s.db, n.id);
    expect(stat(s.db, 'A').platforms[0]).toMatchObject({ published: 0, stale: 0, unpublished: 0 });
    const c = s.mkCh(n.id, 1);
    s.pub(c.id, s.qidian.id, 'published'); // 起点未绑定
    expect(stat(s.db, 'A').platforms.map((p) => p.platformName)).toEqual(['番茄']);
  });

  it('F6.8 归档默认隐藏，且排在末尾', () => {
    const s = base();
    s.mkNovel('A');
    const b = s.mkNovel('B');
    setArchived(s.db, b.id, true);
    s.mkNovel('C');
    expect(getDashboard(s.db, { sort: 'name' }).novels.map((x) => x.novel.name)).toEqual(['A', 'C']);
    expect(getDashboard(s.db, { showArchived: true, sort: 'name' }).novels.map((x) => x.novel.name)).toEqual(['A', 'C', 'B']);
  });

  it('F6.13 排序：recent / name / stale', () => {
    const s = base();
    const a = s.mkNovel('甲');
    const b = s.mkNovel('乙');
    for (const n of [a, b]) configureFanqie(s.db, n.id);
    const ca = s.mkCh(a.id, 1, { mtimeMs: 1000 });
    const cb = s.mkCh(b.id, 1, { mtimeMs: 2000 });
    s.pub(ca.id, s.fanqie.id, 'stale');
    s.pub(cb.id, s.fanqie.id, 'published');
    const names = (sort: 'recent' | 'name' | 'stale') => getDashboard(s.db, { sort }).novels.map((x) => x.novel.name);
    expect(names('recent')).toEqual(['乙', '甲']);
    expect(names('stale')).toEqual(['甲', '乙']);
    expect(names('name')).toEqual(['甲', '乙'].sort((x, y) => x.localeCompare(y, 'zh')));
  });

  it('rootCount', () => {
    const s = base();
    s.db.insert(libraryRoot).values({ path: '/x' }).run();
    expect(getDashboard(s.db).rootCount).toBe(1);
  });

  it('parseSort', () => {
    expect([parseSort('name'), parseSort('stale'), parseSort('zzz'), parseSort(undefined)]).toEqual(['name', 'stale', 'recent', 'recent']);
  });
});

describe('F6.12 规模', () => {
  it('20 本 × 500 章，聚合查询应在 1 秒内完成', () => {
    const s = base();
    s.db.$client.transaction(() => {
      for (let i = 0; i < 20; i++) {
        const n = s.mkNovel(`N${i}`);
        configureFanqie(s.db, n.id);
        for (let seq = 1; seq <= 500; seq++) {
          const c = s.mkCh(n.id, seq);
          if (seq % 2 === 0) s.pub(c.id, s.fanqie.id, seq % 10 === 0 ? 'stale' : 'published');
        }
      }
    })();
    const t0 = performance.now();
    const d = getDashboard(s.db);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(d.novels).toHaveLength(20);
  });
});
```

**`src/lib/publications.test.ts` 整体替换为：**

```ts
import { describe, expect, it } from 'vitest';
import { chapter } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { bindPlatform, listPlatforms } from './platforms';
import { updatePublicationInfo } from './publications';

function setup() {
  const db = makeDb();
  const n = insertNovel(db, '/x/A');
  const [fanqie] = listPlatforms(db);
  bindPlatform(db, n.id, fanqie.id);
  const ch = db.insert(chapter).values({ novelId: n.id, seq: 1, title: 'T', filePath: '/x/A/Ch01.md' }).returning().get();
  return { db, fanqie, ch };
}

describe('updatePublicationInfo', () => {
  it('更新链接；链接校验；未发状态不可设发布时间；已同步为已发布后可设', () => {
    const s = setup();
    expect(() => updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { platformUrl: 'nope' })).toThrow('章节链接格式错误');
    expect(updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { platformUrl: 'https://a.b/c' }).platformUrl).toBe('https://a.b/c');
    expect(() => updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { publishedAt: 9 })).toThrow('未发布的章节没有发布时间');
    s.db.$client.prepare("UPDATE publication SET status = 'published'").run();
    expect(updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { publishedAt: 9 }).publishedAt).toBe(9);
  });
});
```

**`src/lib/publish.test.ts`**：删除从 `describe('isStale / deriveBadge'` 起到 `describe('formatForCopy'` 之前的两个 `describe` 块（`isStale / deriveBadge`、`badgeHint`）；在原位置补：

```ts
describe('syncedStatus / syncHint', () => {
  it('只认 published / stale，其余（含 MVP 遗留的 pending_review）按未发布', () => {
    expect(syncedStatus('published')).toBe('published');
    expect(syncedStatus('stale')).toBe('stale');
    expect(syncedStatus('pending_review')).toBe('unpublished');
    expect(syncedStatus(undefined)).toBe('unpublished');
    expect(syncedStatus(null)).toBe('unpublished');
  });
  it('syncHint', () => expect(syncHint('番茄')).toBe('状态由番茄同步，点击重新扫描刷新'));
});
```
并修正文件顶部 import：去掉 `isStale, deriveBadge, badgeHint`，加入 `syncedStatus, syncHint`。

删除 `src/lib/stale.integration.test.ts`。

**`src/lib/sync-status.test.ts`（新建）：**

```ts
import { describe, expect, it } from 'vitest';
import { cardSyncLine, fmtSyncTime, isAuthSyncError, staleReason, syncErrorLabel, syncStrip } from './sync-status';

const NOW = new Date(2026, 10, 2, 15, 0).getTime();
const TODAY = new Date(2026, 10, 2, 14, 32).getTime();
const AUTH = '认证无效或已过期，请重新获取 Cookie 与 CSRF Token';

describe('syncStrip（F7.20 文案，REQ-07 §6）', () => {
  it('从未同步', () => {
    expect(syncStrip({ lastSyncedAt: null, lastSyncError: null, changedCount: 0, now: NOW }))
      .toEqual({ tone: 'info', title: '尚未同步', detail: '点“重新扫描”获取番茄线上状态。' });
  });
  it('刚同步（1 分钟内）', () => {
    expect(syncStrip({ lastSyncedAt: NOW - 1000, lastSyncError: null, changedCount: 0, now: NOW }))
      .toMatchObject({ title: '番茄状态已是最新', detail: '刚刚同步。状态由番茄同步，不能手动修改。' });
  });
  it('有过同步：显示时间；有改动才提示', () => {
    expect(syncStrip({ lastSyncedAt: TODAY, lastSyncError: null, changedCount: 2, now: NOW }))
      .toEqual({ tone: 'info', title: '最近同步：今天 14:32', detail: '2 章在同步后有本地改动，重新扫描后状态才会更新。' });
    expect(syncStrip({ lastSyncedAt: TODAY, lastSyncError: null, changedCount: 0, now: NOW }).detail).toBe('状态由番茄同步，不能手动修改。');
  });
  it('上次失败：提醒状态可能过期，优先于其他文案', () => {
    expect(syncStrip({ lastSyncedAt: TODAY, lastSyncError: AUTH, changedCount: 2, now: NOW }))
      .toEqual({ tone: 'warn', title: '上次同步失败', detail: '下方仍是今天 14:32 的状态，可能已过期。' });
    expect(syncStrip({ lastSyncedAt: null, lastSyncError: AUTH, changedCount: 0, now: NOW }).detail).toBe('尚无成功同步的记录。');
  });
});

it('staleReason：只用已入库字段推断', () => {
  expect(staleReason(3190, 3190)).toBe('字数相同，标题不同');
  expect(staleReason(3198, 3245)).toBe('字数不同，内容不一致');
  expect(staleReason(null, 3245)).toBe('线上内容不一致');
});

it('失败原因', () => {
  expect(isAuthSyncError(AUTH)).toBe(true);
  expect(isAuthSyncError('番茄暂时无法访问，稍后重试')).toBe(false);
  expect(isAuthSyncError(null)).toBe(false);
  expect(syncErrorLabel(AUTH)).toBe('认证已失效');
  expect(syncErrorLabel('番茄暂时无法访问，稍后重试')).toBe('番茄暂时无法访问，稍后重试');
});

it('fmtSyncTime', () => {
  expect(fmtSyncTime(TODAY, NOW)).toBe('今天 14:32');
  expect(fmtSyncTime(new Date(2026, 9, 24, 9, 5).getTime(), NOW)).toBe('10-24 09:05');
});

it('cardSyncLine', () => {
  expect(cardSyncLine({ lastSyncedAt: TODAY, lastSyncError: null, now: NOW })).toEqual({ text: '最近同步：今天 14:32', failed: false });
  expect(cardSyncLine({ lastSyncedAt: TODAY, lastSyncError: AUTH, now: NOW })).toEqual({ text: '同步失败：认证已失效，状态未改动', failed: true });
  expect(cardSyncLine({ lastSyncedAt: null, lastSyncError: null, now: NOW })).toEqual({ text: '尚未同步', failed: false });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/sync-status.test.ts src/lib/matrix.test.ts src/lib/stats.test.ts src/lib/publications.test.ts src/lib/publish.test.ts`
Expected: FAIL（新签名尚未实现）

- [ ] **Step 2b: 新建 `src/lib/sync-status.ts`**（纯函数，客户端可用）：

```ts
const AUTH_MARK = '认证无效或已过期';

export const isAuthSyncError = (e: string | null | undefined): boolean => !!e && e.includes(AUTH_MARK);
export const syncErrorLabel = (e: string): string => (isAuthSyncError(e) ? '认证已失效' : e);

const pad = (n: number) => String(n).padStart(2, '0');

export function fmtSyncTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? `今天 ${time}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function syncStrip(i: { lastSyncedAt: number | null; lastSyncError: string | null; changedCount: number; now?: number }) {
  const now = i.now ?? Date.now();
  if (i.lastSyncError) {
    return {
      tone: 'warn' as const,
      title: '上次同步失败',
      detail: i.lastSyncedAt ? `下方仍是${fmtSyncTime(i.lastSyncedAt, now)} 的状态，可能已过期。` : '尚无成功同步的记录。',
    };
  }
  if (!i.lastSyncedAt) return { tone: 'info' as const, title: '尚未同步', detail: '点“重新扫描”获取番茄线上状态。' };
  const fixed = '状态由番茄同步，不能手动修改。';
  if (now - i.lastSyncedAt < 60_000 && i.changedCount === 0) return { tone: 'info' as const, title: '番茄状态已是最新', detail: `刚刚同步。${fixed}` };
  return {
    tone: 'info' as const,
    title: `最近同步：${fmtSyncTime(i.lastSyncedAt, now)}`,
    detail: i.changedCount > 0 ? `${i.changedCount} 章在同步后有本地改动，重新扫描后状态才会更新。` : fixed,
  };
}

/** 同步不保存线上标题，原因由线上字数与本地字数推断：字数相同仍判需更新，只可能是标题不同。 */
export function staleReason(platformWordCount: number | null, localWordCount: number): string {
  if (platformWordCount === null) return '线上内容不一致';
  return platformWordCount === localWordCount ? '字数相同，标题不同' : '字数不同，内容不一致';
}

export function cardSyncLine(i: { lastSyncedAt: number | null; lastSyncError: string | null; now?: number }) {
  if (i.lastSyncError) return { text: `同步失败：${syncErrorLabel(i.lastSyncError)}，状态未改动`, failed: true };
  return { text: i.lastSyncedAt ? `最近同步：${fmtSyncTime(i.lastSyncedAt, i.now)}` : '尚未同步', failed: false };
}
```

- [ ] **Step 3: 改 `types.ts`**：

```ts
export type PublishStatus = 'unpublished' | 'published' | 'stale';
export type Badge = PublishStatus;
export type ChapterWarning = 'h1_mismatch' | 'no_h1' | 'encoding' | null;
```

- [ ] **Step 4: 改 `publish.ts`** — 顶部 `import type { Badge, PublishStatus } from './types';` 改为 `import type { PublishStatus } from './types';`。删除自 `export interface ChapterForBadge` 到 `badgeHint` 函数结束（含 `OVERWRITE_WARNING`、`isStale`、`deriveBadge`、`fmtDate`）。保留 `CopyMode` / `formatForCopy`。在原位置加入：

```ts
/** 库内 status 的读取口径：只有 published / stale 有意义，其余（含 MVP 遗留的 pending_review）按未发布。 */
export function syncedStatus(raw: string | null | undefined): PublishStatus {
  return raw === 'published' || raw === 'stale' ? raw : 'unpublished';
}

export const syncHint = (platformName: string) => `状态由${platformName}同步，点击重新扫描刷新`;
```

- [ ] **Step 5: 改 `publications.ts`** — 仅保留下列内容（其余全部删除）：

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, publication, type Chapter, type Publication } from '@/db/schema';
import { validateUrl } from './platforms';
import { UserError } from './result';
import type { PublishStatus } from './types';

export interface PubSnapshot {
  status: PublishStatus;
  publishedAt: number | null;
  publishedHash: string | null;
  platformUrl: string | null;
}

const EMPTY: PubSnapshot = { status: 'unpublished', publishedAt: null, publishedHash: null, platformUrl: null };

export const snapshotOf = (row?: Publication | null): PubSnapshot =>
  row ? { status: row.status, publishedAt: row.publishedAt, publishedHash: row.publishedHash, platformUrl: row.platformUrl } : { ...EMPTY };

function getChapter(db: Db, id: number): Chapter {
  const ch = db.select().from(chapter).where(eq(chapter.id, id)).get();
  if (!ch) throw new UserError('章节不存在');
  return ch;
}

const rowOf = (db: Db, chapterId: number, platformId: number) =>
  db.select().from(publication).where(and(eq(publication.chapterId, chapterId), eq(publication.platformId, platformId))).get();

function write(db: Db, chapterId: number, platformId: number, s: PubSnapshot) {
  db.insert(publication)
    .values({ chapterId, platformId, ...s })
    .onConflictDoUpdate({ target: [publication.chapterId, publication.platformId], set: s })
    .run();
}

/** 保存章节链接 / 发布时间（不改变状态）。 */
export function updatePublicationInfo(
  db: Db,
  chapterId: number,
  platformId: number,
  patch: { platformUrl?: string | null; publishedAt?: number | null },
): PubSnapshot {
  getChapter(db, chapterId);
  const prev = snapshotOf(rowOf(db, chapterId, platformId));
  const next = { ...prev };
  if ('platformUrl' in patch) next.platformUrl = validateUrl(patch.platformUrl, '章节链接');
  if ('publishedAt' in patch) {
    if (prev.status === 'unpublished') throw new UserError('未发布的章节没有发布时间');
    next.publishedAt = patch.publishedAt ?? null;
  }
  write(db, chapterId, platformId, next);
  return next;
}
```
（`updatePublicationInfo` 写回时保留 `publishedHash` 原值，行为与此前一致。`syncChapter` 的导入随删除的函数一起移除。）

- [ ] **Step 6: 改 `matrix.ts`** — 全文替换为：

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, platform, publication, type Chapter, type Publication } from '@/db/schema';
import { listChapters } from './chapters';
import { isSyncConfigured, SYNC_PLATFORM } from './platforms';
import { syncedStatus, syncHint } from './publish';
import type { Badge, PublishStatus } from './types';

export type Filter = 'all' | 'stale' | 'unpublished';
export const parseFilter = (v: string | undefined): Filter => (v === 'stale' || v === 'unpublished' ? v : 'all');

export interface MatrixCell {
  platformId: number;
  platformName: string;
  /** 未配置的平台没有状态：badge 为 null */
  configured: boolean;
  status: PublishStatus;
  badge: Badge | null;
  publishedAt: number | null;
  platformUrl: string | null;
  hint?: string;
  platformWordCount: number | null;
  syncedAt: number | null;
  /** 该平台是否支持同步（决定未配置时显示"去配置"还是"暂不支持自动校验"） */
  syncSupported: boolean;
  /** 该（小说，平台）最近一次成功同步时间 */
  lastSyncedAt: number | null;
  /** 文件修改时间晚于该章同步时间：状态可能已落后，要等重新扫描（F7.22） */
  changedSinceSync: boolean;
}
export interface MatrixRow {
  chapter: Chapter;
  cells: MatrixCell[];
}
export interface Matrix {
  platforms: Array<{ id: number; name: string; bookUrl: string | null; configured: boolean; lastSyncedAt: number | null; lastSyncError: string | null }>;
  rows: MatrixRow[];
  counts: { all: number; stale: number; unpublished: number };
  /** 不受筛选影响 */
  changedCount: number;
  total: number;
  /** 实际生效的平台筛选；URL 里指向未绑定平台时归为 null。 */
  platformId: number | null;
}

type Bound = Matrix['platforms'][number];

function makeCell(pl: Bound, ch: Chapter, pub?: Publication): MatrixCell {
  if (!pl.configured) {
    return {
      platformId: pl.id, platformName: pl.name, configured: false, status: 'unpublished', badge: null, publishedAt: null, platformUrl: null, hint: '未配置，无状态',
      syncSupported: pl.name === SYNC_PLATFORM, platformWordCount: null, syncedAt: null, lastSyncedAt: null, changedSinceSync: false,
    };
  }
  const status = syncedStatus(pub?.status);
  return {
    platformId: pl.id,
    platformName: pl.name,
    configured: true,
    status,
    badge: status,
    publishedAt: pub?.publishedAt ?? null,
    platformUrl: pub?.platformUrl ?? null,
    hint: syncHint(pl.name),
    syncSupported: true,
    platformWordCount: pub?.platformWordCount ?? null,
    syncedAt: pub?.syncedAt ?? null,
    lastSyncedAt: pl.lastSyncedAt,
    changedSinceSync: !ch.fileMissing && !!pub?.syncedAt && (ch.mtimeMs ?? 0) > pub.syncedAt,
  };
}

function boundPlatforms(db: Db, novelId: number): Bound[] {
  return db
    .select({
      id: platform.id, name: platform.name, bookUrl: novelPlatform.bookUrl,
      cookie: platform.cookie, csrfToken: platform.csrfToken, bookId: novelPlatform.bookId,
      lastSyncedAt: novelPlatform.lastSyncedAt, lastSyncError: novelPlatform.lastSyncError,
    })
    .from(novelPlatform)
    .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
    .where(eq(novelPlatform.novelId, novelId))
    .orderBy(platform.id)
    .all()
    .map((r) => ({ id: r.id, name: r.name, bookUrl: r.bookUrl, configured: isSyncConfigured(r), lastSyncedAt: r.lastSyncedAt, lastSyncError: r.lastSyncError }));
}

export function getMatrix(db: Db, novelId: number, opts: { filter?: Filter; platformId?: number | null } = {}): Matrix {
  const platforms = boundPlatforms(db, novelId);
  const pubs = db
    .select({ p: publication })
    .from(publication)
    .innerJoin(chapter, eq(chapter.id, publication.chapterId))
    .where(eq(chapter.novelId, novelId))
    .all()
    .map((r) => r.p);
  const byKey = new Map(pubs.map((p) => [`${p.chapterId}:${p.platformId}`, p]));
  const all: MatrixRow[] = listChapters(db, novelId).map((ch) => ({
    chapter: ch,
    cells: platforms.map((pl) => makeCell(pl, ch, byKey.get(`${ch.id}:${pl.id}`))),
  }));

  const platformId = opts.platformId && platforms.some((p) => p.id === opts.platformId) ? opts.platformId : null;
  const scoped = (r: MatrixRow) => (platformId ? r.cells.filter((c) => c.platformId === platformId) : r.cells);
  const has = (r: MatrixRow, b: Badge) => scoped(r).some((c) => c.badge === b);
  const counts = {
    all: all.length,
    stale: all.filter((r) => has(r, 'stale')).length,
    unpublished: all.filter((r) => has(r, 'unpublished')).length,
  };
  const filter = opts.filter ?? 'all';
  const rows = filter === 'all' ? all : all.filter((r) => has(r, filter === 'stale' ? 'stale' : 'unpublished'));
  const changedCount = all.filter((r) => r.cells.some((c) => c.changedSinceSync)).length;
  return { platforms, rows, counts, changedCount, total: all.length, platformId };
}

export function getChapterCells(db: Db, chapterId: number): MatrixCell[] {
  const ch = db.select().from(chapter).where(eq(chapter.id, chapterId)).get();
  if (!ch) return [];
  const pubs = new Map(db.select().from(publication).where(eq(publication.chapterId, chapterId)).all().map((p) => [p.platformId, p]));
  return boundPlatforms(db, ch.novelId).map((pl) => makeCell(pl, ch, pubs.get(pl.id)));
}
```

- [ ] **Step 7: 改 `stats.ts`**

(a) 删除 `STALE` 常量及其注释；把 `Q_PLATFORMS`、`Q_STALE_CHAPTERS` 替换为（并新增 `CONFIGURED`）：

```ts
/** 「已配置」的 SQL 形式，必须与 platforms.ts 的 isSyncConfigured 等价（pl = platform, np = novel_platform；参数 1 = SYNC_PLATFORM）。 */
const CONFIGURED = `(pl.name = ? AND pl.cookie IS NOT NULL AND pl.cookie <> ''
  AND pl.csrf_token IS NOT NULL AND pl.csrf_token <> ''
  AND np.book_id IS NOT NULL AND np.book_id <> '')`;

const Q_PLATFORMS = `
  SELECT np.novel_id, np.platform_id,
         SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) AS published,
         SUM(CASE WHEN p.status = 'stale' THEN 1 ELSE 0 END) AS stale
  FROM novel_platform np
  JOIN platform pl ON pl.id = np.platform_id
  JOIN chapter c ON c.novel_id = np.novel_id
  LEFT JOIN publication p ON p.chapter_id = c.id AND p.platform_id = np.platform_id
  WHERE ${CONFIGURED}
  GROUP BY np.novel_id, np.platform_id`;

const Q_STALE_CHAPTERS = `
  SELECT c.novel_id, COUNT(DISTINCT c.id) AS n
  FROM chapter c
  JOIN novel_platform np ON np.novel_id = c.novel_id
  JOIN platform pl ON pl.id = np.platform_id
  JOIN publication p ON p.chapter_id = c.id AND p.platform_id = np.platform_id
  WHERE ${CONFIGURED} AND p.status = 'stale'
  GROUP BY c.novel_id`;
```
`Q_CHAPTERS` 保持不变。

(b) `PlatformStat` 改为：
```ts
export interface PlatformStat {
  platformId: number;
  platformName: string;
  configured: boolean;
  published: number;
  stale: number;
  unpublished: number;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
}
```

(c) 顶部加 `import { SYNC_PLATFORM } from './platforms';`；`getDashboard` 里查询改为带参数，并重写 `platRows` 类型与 `platforms` 映射：

```ts
  const platRows = new Map(
    (raw.prepare(Q_PLATFORMS).all(SYNC_PLATFORM) as Array<{ novel_id: number; platform_id: number; published: number; stale: number }>)
      .map((r) => [`${r.novel_id}:${r.platform_id}`, r]),
  );
  const staleRows = new Map(
    (raw.prepare(Q_STALE_CHAPTERS).all(SYNC_PLATFORM) as Array<{ novel_id: number; n: number }>).map((r) => [r.novel_id, r.n]),
  );
```
```ts
        const platforms: PlatformStat[] = bindings
          .filter((b) => b.novelId === n.id)
          .map((b) => {
            const r = platRows.get(`${n.id}:${b.platformId}`);
            const [published, stale] = [r?.published ?? 0, r?.stale ?? 0];
            return {
              platformId: b.platformId,
              platformName: platformNames.get(b.platformId) ?? '',
              configured: !!r,
              published,
              stale,
              unpublished: r ? chapterCount - published - stale : 0,
              lastSyncedAt: b.lastSyncedAt,
              lastSyncError: b.lastSyncError,
            };
          });
```
注意：`!!r` 依赖 `Q_PLATFORMS` 对已配置且有章节的绑定才返回行。**0 章的已配置绑定没有行**（`JOIN chapter`），会被误判为未配置。改为：先单独算出已配置集合：

```ts
  const configuredKeys = new Set(
    (raw.prepare(
      `SELECT np.novel_id, np.platform_id FROM novel_platform np JOIN platform pl ON pl.id = np.platform_id WHERE ${CONFIGURED}`,
    ).all(SYNC_PLATFORM) as Array<{ novel_id: number; platform_id: number }>).map((r) => `${r.novel_id}:${r.platform_id}`),
  );
```
并把 `configured: !!r` 改为 `configured: configuredKeys.has(\`${n.id}:${b.platformId}\`)`，`unpublished` 改为 `configured ? chapterCount - published - stale : 0`（用局部变量 `configured`）。同时在 `stats.test.ts` 的"绑定了平台但 0 章"用例已覆盖该情形（期望 `unpublished: 0`，且应满足 `configured: true`——在该用例补一行 `expect(stat(s.db, 'A').platforms[0].configured).toBe(true);`）。

- [ ] **Step 8: 改 `actions/publications.ts`** — 仅保留：

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { updatePublicationInfo } from '@/lib/publications';

const refresh = () => {
  revalidatePath('/');
  revalidatePath('/novels/[id]', 'page');
  revalidatePath('/novels/[id]/chapters/[cid]', 'page');
};

export async function updatePublicationInfoAction(
  chapterId: number,
  platformId: number,
  patch: { platformUrl?: string | null; publishedAt?: number | null },
) {
  return wrap(() => { const r = updatePublicationInfo(getDb(), chapterId, platformId, patch); refresh(); return r; });
}
```

- [ ] **Step 9: 改组件**

`src/components/publication-actions.tsx`：`git rm`。

`src/components/badge.tsx`：`META` 只保留三项：
```tsx
const META: Record<BadgeKind, { icon: string; label: string; cls: string }> = {
  unpublished: { icon: '○', label: '未发', cls: 'bg-white border-stone-300 text-stone-600' },
  published: { icon: '✓', label: '已发', cls: 'bg-blue-600 border-blue-600 text-white' },
  stale: { icon: '↻', label: '需更新', cls: 'bg-orange-100 border-orange-300 text-orange-800' },
};
```

`src/components/copy-menu.tsx`：增加可选 prop `label?: string`，主按钮文案改为 `{done ? '已复制 ✓' : (label ?? '复制')}`（需更新操作条用"复制标题+正文"）。

`src/components/matrix-table.tsx` 全文替换为（已发、未发徽标不可点；只有"需更新"展开操作条，F7.16）：

```tsx
'use client';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { Filter, MatrixRow } from '@/lib/matrix';
import { staleReason } from '@/lib/sync-status';
import { Badge } from './badge';
import { CopyMenu } from './copy-menu';

export function MatrixTable({
  novelId, platforms, rows, filter,
}: {
  novelId: number;
  platforms: Array<{ id: number; name: string; bookUrl: string | null; configured: boolean }>;
  rows: MatrixRow[];
  filter: Filter;
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="rounded border bg-white p-6 text-center text-stone-600">
        {filter === 'stale' ? '所有已发章节都是最新的' : filter === 'unpublished' ? '没有未发布的章节' : '没有章节'}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-stone-100 text-left">
          <tr>
            <th className="p-2">章号</th><th className="p-2">标题</th><th className="p-2 text-right">字数</th>
            {platforms.map((p) => (
              <th key={p.id} className="p-2">
                {p.configured && p.bookUrl ? <a className="underline" href={p.bookUrl} target="_blank" rel="noreferrer">{p.name} ↗</a> : p.name}
                {!p.configured && <span className="font-normal text-stone-500" title="未配置，无状态"> · 未配置</span>}
              </th>
            ))}
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ chapter: ch, cells }) => {
            const openCell = cells.find((c) => open === `${ch.id}:${c.platformId}`);
            const changed = cells.some((c) => c.changedSinceSync);
            return (
              <Fragment key={ch.id}>
                <tr className="border-t">
                  <td className="p-2 font-mono">{ch.seq}</td>
                  <td className="p-2 font-serif">
                    {ch.fileMissing ? (
                      <>
                        <span className="text-stone-600">{ch.title}</span>
                        <span className="ml-2 rounded border border-dashed border-red-400 bg-red-50 px-1.5 font-sans text-xs font-medium text-red-700" title="本地文件缺失，本章未参与同步，状态保持不变">! 文件丢失</span>
                      </>
                    ) : (
                      <Link className="underline" href={`/novels/${novelId}/chapters/${ch.id}`}>{ch.title}</Link>
                    )}
                    {changed && <span className="ml-2 whitespace-nowrap font-sans text-xs text-orange-800">同步后有改动</span>}
                  </td>
                  <td className="p-2 text-right font-mono">{ch.fileMissing ? '—' : ch.wordCount}</td>
                  {cells.map((c) => {
                    const key = `${ch.id}:${c.platformId}`;
                    return (
                      <td key={c.platformId} className={`p-2 ${c.configured ? '' : 'bg-stone-50'}`}>
                        {!c.badge ? (
                          <span className="text-stone-500" title={c.hint}>—</span>
                        ) : c.badge === 'stale' ? (
                          <button aria-label={`第${ch.seq}章 ${c.platformName}：需更新，查看差异`} aria-expanded={open === key} title={c.hint} onClick={() => setOpen(open === key ? null : key)}>
                            <Badge kind="stale" suffix=" ▾" />
                          </button>
                        ) : (
                          <Badge kind={c.badge} title={c.hint} />
                        )}
                      </td>
                    );
                  })}
                  <td className="p-2">
                    <div className="flex gap-2">
                      <CopyMenu chapterId={ch.id} fileMissing={ch.fileMissing} />
                      {!ch.fileMissing && (
                        <Link className="inline-flex min-h-[44px] items-center rounded border px-3" href={`/novels/${novelId}/chapters/${ch.id}`}>编辑</Link>
                      )}
                    </div>
                  </td>
                </tr>
                {openCell && (
                  <tr className="border-t border-orange-300 bg-orange-50 text-orange-900">
                    <td colSpan={4 + platforms.length} className="p-3">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <span className="font-bold">{staleReason(openCell.platformWordCount, ch.wordCount)}</span>
                        <span className="text-xs">
                          本地 <b className="font-mono font-medium">{ch.fileMissing ? '—' : ch.wordCount}</b> 字 · 线上 <b className="font-mono font-medium">{openCell.platformWordCount ?? '—'}</b> 字
                        </span>
                        <span className="flex-1" />
                        <CopyMenu chapterId={ch.id} fileMissing={ch.fileMissing} label="复制标题+正文" />
                        {platforms.find((p) => p.id === openCell.platformId)?.bookUrl && (
                          <a className="underline" href={platforms.find((p) => p.id === openCell.platformId)!.bookUrl!} target="_blank" rel="noreferrer">打开{openCell.platformName}后台 ↗</a>
                        )}
                        <span className="basis-full text-xs">在{openCell.platformName}覆盖后点“重新扫描”，状态会自动更新。覆盖会重新审核，请确认已定稿。</span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

`src/components/badge.tsx`：`Badge` 增加可选 prop `suffix?: string`，渲染在文案之后。

`src/components/sync-strip.tsx`（新建）：

```tsx
import { syncStrip } from '@/lib/sync-status';

export function SyncStrip(p: { lastSyncedAt: number | null; lastSyncError: string | null; changedCount: number }) {
  const s = syncStrip(p);
  const cls = s.tone === 'warn' ? 'border-orange-300 bg-orange-50 text-orange-900' : 'border-blue-200 bg-blue-50 text-blue-950';
  return (
    <div className={`flex flex-wrap gap-x-3 rounded border px-3 py-2 text-sm ${cls}`}>
      <span className="font-medium">{s.title}</span>
      <span>{s.detail}</span>
    </div>
  );
}
```

`src/components/setup-checklist.tsx`（新建）：

```tsx
import Link from 'next/link';

/** 番茄已绑定但未配置时显示（F7.23）。 */
export function SetupChecklist({ hasAuth, hasLink }: { hasAuth: boolean; hasLink: boolean }) {
  return (
    <section aria-label="开启番茄同步" className="space-y-1 rounded border bg-white p-4 text-sm">
      <h2 className="text-base font-semibold">还差一步开启番茄同步</h2>
      <p className={hasAuth ? 'text-stone-500' : ''}>{hasAuth ? '✓' : '○'} 番茄认证信息 {!hasAuth && <Link className="underline" href="/settings#fanqie">去设置</Link>}</p>
      <p className={hasLink ? 'text-stone-500' : ''}>{hasLink ? '✓' : '○'} 本书的作品链接 {!hasLink && <a className="underline" href="#manage-platforms">去填写</a>}</p>
    </section>
  );
}
```

`src/app/novels/[id]/page.tsx`：

```tsx
  const fanqie = bindings.find((b) => b.syncSupported && b.bound);
  const anyConfigured = matrix.platforms.some((p) => p.configured);
  const fanqiePlatform = matrix.platforms.find((p) => p.id === fanqie?.platform.id);
```
- `<RescanNovelButton novelId={n.id} hasSync={anyConfigured} />`；`ManagePlatformsPanel` 外层加 `id="manage-platforms"`，`defaultOpen` 增加"番茄缺链接"：`matrix.platforms.length === 0 || (!!fanqie && !fanqie.bookUrl)`。
- 在 `<ProblemFiles>` 之前：
```tsx
      {fanqie && !fanqie.configured && <SetupChecklist hasAuth={fanqie.hasAuth} hasLink={!!fanqie.bookUrl} />}
      {fanqiePlatform?.configured && (
        <SyncStrip lastSyncedAt={fanqiePlatform.lastSyncedAt} lastSyncError={fanqiePlatform.lastSyncError} changedCount={matrix.changedCount} />
      )}
```
- `MatrixToolbar` 只在 `anyConfigured` 时渲染，`platforms` 传 `matrix.platforms.filter((p) => p.configured)`（F7.18）；未配置时用 `<p className="ml-auto font-mono text-xs text-stone-600">共 {matrix.total} 章</p>` 代替。

`src/components/platform-card.tsx`：删除 `PublicationActions` 的导入与使用；props 去掉 `fileMissing`、`chapterLabel`（同步修改 `platform-cards.tsx` 调用处）。未配置时提前返回：

```tsx
  if (!cell.configured) {
    return (
      <section className="space-y-1 rounded border bg-stone-50 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{cell.platformName}</h3>
          <span className="text-stone-500">—</span>
        </div>
        <p className="text-xs text-stone-600">
          未配置，无状态。{cell.syncSupported ? <Link className="underline" href="/settings#fanqie">去配置</Link> : '暂不支持自动校验。'}
        </p>
      </section>
    );
  }
```
（`MatrixCell` 另加 `syncSupported: boolean`，`makeCell` 里取 `pl.name === SYNC_PLATFORM`，从 `./platforms` 导入。）已配置时，把原 `{cell.hint && …}` 与 `PublicationActions` 替换为：

```tsx
      <p className="text-xs text-stone-600">
        状态由{cell.platformName}同步 · {cell.lastSyncedAt ? `最近同步：${fmtSyncTime(cell.lastSyncedAt)}` : '尚未同步'}
        {cell.platformWordCount !== null && <><br />同步时线上 <span className="font-mono">{cell.platformWordCount}</span> 字</>}
      </p>
      {cell.changedSinceSync && (
        <p role="status" className="rounded border border-orange-300 bg-orange-50 p-2 text-xs text-orange-900">
          本地已改动，这里的状态要等重新扫描才更新。<Link className="font-bold underline" href={`/novels/${novelId}`}>去重新扫描</Link>
        </p>
      )}
```
props 增加 `novelId: number`（`platform-cards.tsx` 从 `chapters/[cid]/page.tsx` 接收并透传）。保存改稿后 `chapter-editor` 已 `router.refresh()`，`changedSinceSync` 由服务端重算，无需客户端状态；徽标不变（REQ-07 §7 对 F2.19 的修订）。

`src/components/ratio-bar.tsx` 替换为：
```tsx
export function RatioBar(p: { published: number; stale: number; unpublished: number }) {
  const total = p.published + p.stale + p.unpublished;
  const seg = [['bg-blue-600', p.published, '已发'], ['bg-orange-400', p.stale, '需更新'], ['bg-stone-200', p.unpublished, '未发']] as const;
  const label = seg.filter(([, n]) => n > 0).map(([, n, l]) => `${l} ${n}`).join('，') || '无章节';
  return (
    <div role="img" aria-label={label} className="flex h-2 w-full overflow-hidden rounded bg-stone-100">
      {total > 0 && seg.map(([cls, n, l]) => n > 0 && <div key={l} className={cls} style={{ width: `${(n / total) * 100}%` }} />)}
    </div>
  );
}
```

`src/components/novel-card.tsx`：`dirMissing` 标签在有已配置平台时显示"目录丢失，未同步"。平台区（`s.platforms.length === 0` 分支之后）替换为：

```tsx
      ) : !s.platforms.some((p) => p.configured) ? (
        <p className="text-sm text-stone-600">未配置同步。<Link className="underline" href={`/novels/${n.id}`}>去配置</Link></p>
      ) : (
        <>
          <ul className="space-y-3">
            {s.platforms.filter((p) => p.configured).map((p) => {
              const line = n.dirMissing ? { text: '状态保持上次同步结果', failed: false } : cardSyncLine(p);
              return (
                <li key={p.platformId} className="space-y-1">
                  <RatioBar published={p.published} stale={p.stale} unpublished={p.unpublished} />
                  <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <span className="font-medium">{p.platformName}</span>
                    <span className="font-mono text-xs text-stone-700">
                      已发 {p.published} ·{' '}
                      {p.stale > 0 ? (
                        <Link className="font-bold text-orange-700 underline" href={`/novels/${n.id}?filter=stale&platform=${p.platformId}`}>需更新 {p.stale}</Link>
                      ) : (
                        <>需更新 {p.stale}</>
                      )}{' '}
                      ·{' '}
                      {p.unpublished > 0 ? (
                        <Link className="underline" href={`/novels/${n.id}?filter=unpublished&platform=${p.platformId}`}>未发 {p.unpublished}</Link>
                      ) : (
                        <>未发 {p.unpublished}</>
                      )}
                    </span>
                  </div>
                  <p className={`text-xs ${line.failed ? 'text-red-700' : 'text-stone-500'}`}>{line.text}</p>
                </li>
              );
            })}
          </ul>
          {s.platforms.some((p) => !p.configured) && (
            <p className="text-xs text-stone-500">{s.platforms.filter((p) => !p.configured).map((p) => p.platformName).join('、')} 未配置，不计入统计</p>
          )}
        </>
      )}
```
顶部加 `import { cardSyncLine } from '@/lib/sync-status';`。

`src/app/page.tsx`：在工具栏之后加常驻错误条（F7.24，认证失效影响所有小说）：

```tsx
      {dash.novels.some((s) => s.platforms.some((p) => p.configured && isAuthSyncError(p.lastSyncError))) && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed border-red-400 bg-red-50 px-4 py-2 text-sm font-medium text-red-800">
          番茄认证已失效，所有小说暂停同步，各章状态未改动。
          <Link href="/settings#fanqie" className="font-bold underline">去设置</Link>
        </div>
      )}
```
顶部加 `import { isAuthSyncError } from '@/lib/sync-status';`。

- [ ] **Step 10: 全量验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全部 PASS。tsc 报错处按上面的类型变更修正（例如 `sync.test.ts` 里若还引用 `publishedHash` 之外已删除的导出，更新之）。再 grep 确认无残留：

Run: `grep -rnE "isStale|deriveBadge|badgeHint|OVERWRITE_WARNING|applyPublicationAction|restorePublication|nextPublication|PublicationActions|pending_review" src | grep -v test`
Expected: 除 `publish.ts` 的 `syncedStatus` 注释外无输出。

- [ ] **Step 11: 提交**

```bash
git add -A src
git commit -m "refactor: show synced three-state status, drop manual marking" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 设置页认证面板与绑定行状态

**Files:**
- Modify: `src/app/actions/platforms.ts`
- Create: `src/app/settings/platform-auth-panel.tsx`
- Modify: `src/app/settings/platform-row.tsx`、`src/app/settings/platforms-section.tsx`
- Modify: `src/components/manage-platforms-panel.tsx`、`src/app/novels/[id]/page.tsx`

**Interfaces:**
- Consumes: `saveFanqieAuth` / `clearAuth` / `bindPlatformChecked` / `authSummaryOf`（Task 4）、`Binding`（Task 4）。
- Produces：Server Actions `savePlatformAuthAction(platformId, cookie, csrfToken)`、`clearPlatformAuthAction(platformId)`；`bindPlatformAction` 改为走 `bindPlatformChecked`。

本 Task 是纯 UI / 胶水，业务逻辑已在 Task 4 测过；验证靠 `tsc` + 浏览器手动检查（Step 6）。

- [ ] **Step 1: 改 `actions/platforms.ts`** — 导入 `import { bindPlatformChecked, clearAuth, saveFanqieAuth } from '@/lib/platform-auth';`，从 `@/lib/platforms` 的导入里去掉 `bindPlatform`。替换 `bindPlatformAction` 并新增两个 action：

```ts
export async function bindPlatformAction(novelId: number, platformId: number, bookUrl: string | null) {
  return wrap(async () => { await bindPlatformChecked(getDb(), novelId, platformId, bookUrl); refresh(); });
}
export async function savePlatformAuthAction(platformId: number, cookie: string, csrfToken: string) {
  return wrap(async () => { await saveFanqieAuth(getDb(), platformId, { cookie, csrfToken }); refresh(); });
}
export async function clearPlatformAuthAction(platformId: number) {
  return wrap(() => { clearAuth(getDb(), platformId); refresh(); });
}
```

`src/lib/platform-auth.ts` 顶部加 `import { isAuthSyncError } from './sync-status';`，末尾加：

```ts
/** 是否有小说因认证失效而同步失败（设置页「认证已失效」状态）。 */
export function hasAuthFailure(db: Db, platformId: number): boolean {
  return db.select({ e: novelPlatform.lastSyncError }).from(novelPlatform).where(eq(novelPlatform.platformId, platformId)).all()
    .some((r) => isAuthSyncError(r.e));
}
```

- [ ] **Step 2: 新建 `src/app/settings/platform-auth-panel.tsx`**：

```tsx
'use client';
import { useState, useTransition } from 'react';
import { clearPlatformAuthAction, savePlatformAuthAction } from '@/app/actions/platforms';
import { useNotice } from '@/components/notice';

/** 番茄认证信息。已保存时只显示掩码（服务端传入），原文永不回传到浏览器。 */
export function PlatformAuthPanel({ platformId, summary, authFailed }: { platformId: number; summary: string | null; authFailed: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cookie, setCookie] = useState('');
  const [csrf, setCsrf] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const save = () =>
    start(async () => {
      const r = await savePlatformAuthAction(platformId, cookie, csrf);
      if (!r.ok) return setError(r.error.includes('暂时无法访问') ? `${r.error}。认证信息未保存` : r.error);
      setEditing(false);
      setSaved(true);
      setCookie('');
      setCsrf('');
      setError('');
    });
  const clear = () =>
    start(async () => {
      const r = await clearPlatformAuthAction(platformId);
      setConfirming(false);
      setSaved(false);
      if (!r.ok) notify({ kind: 'error', text: r.error });
    });
  const cancel = () => { setEditing(false); setCookie(''); setCsrf(''); setError(''); };

  return (
    <div className="space-y-2 rounded border bg-stone-50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">认证信息</span>
        <span className="flex-1 font-mono text-stone-600">{summary ?? '未配置'}</span>
        {!editing && !confirming && <button className="rounded border bg-white px-3" onClick={() => { setEditing(true); setSaved(false); }}>{summary ? '更新' : '配置'}</button>}
        {summary && !editing && !confirming && <button className="px-2 text-red-700" onClick={() => { setConfirming(true); setSaved(false); }}>清除</button>}
      </div>
      {authFailed && !editing && (
        <p role="alert" className="rounded border border-dashed border-red-400 bg-red-50 px-3 py-2 font-medium text-red-800">认证已失效，番茄同步已暂停。请重新获取后点“更新”。</p>
      )}
      {confirming && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded border border-orange-300 bg-orange-50 p-3 text-orange-900">
          <span className="flex-1">清除后，所有小说的番茄列显示“—”，看板不再统计。已有记录保留，重新配置并扫描后恢复。</span>
          <button className="rounded bg-red-700 px-3 text-white" disabled={pending} onClick={clear}>确认清除</button>
          <button className="rounded border bg-white px-3" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
      {editing && (
        <div className="space-y-2">
          <p className="text-xs text-stone-600">在已登录的番茄作家后台，从浏览器开发者工具中复制请求头。只保存在本机数据库，保存后不再显示原文。</p>
          <label className="block font-medium">Cookie
            <textarea className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs font-normal" rows={3} autoComplete="off" spellCheck={false} value={cookie}
              onChange={(e) => { setCookie(e.target.value); setError(''); }} />
          </label>
          <label className="block font-medium">X-Secsdk-Csrf-Token
            <input type="password" className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs font-normal" autoComplete="off" value={csrf}
              onChange={(e) => { setCsrf(e.target.value); setError(''); }} />
          </label>
          {error && <p role="alert" className="font-medium text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button className="rounded bg-stone-900 px-3 py-1 font-medium text-white" disabled={pending} onClick={save}>{pending ? '校验中…' : '保存并校验'}</button>
            <button className="rounded border bg-white px-3" onClick={cancel}>取消</button>
          </div>
        </div>
      )}
      {saved && !editing && <p role="status" className="text-blue-900">✓ 认证信息已校验并保存。回到小说详情页点“重新扫描”即可同步。</p>}
    </div>
  );
}
```

- [ ] **Step 3: 改设置页**

`platforms-section.tsx`：只向客户端传脱敏字段：

```tsx
import { getDb } from '@/db';
import { authSummaryOf, hasAuthFailure } from '@/lib/platform-auth';
import { listPlatforms, SYNC_PLATFORM } from '@/lib/platforms';
import { AddPlatformForm } from './add-platform-form';
import { PlatformRow } from './platform-row';

export function PlatformsSection() {
  const db = getDb();
  const platforms = listPlatforms(db);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">发布平台</h2>
      <ul className="divide-y rounded border bg-white px-4">
        {platforms.map((p) => (
          <PlatformRow
            key={p.id} id={p.id} name={p.name} builtin={p.builtin} boundNovels={p.boundNovels}
            syncSupported={p.name === SYNC_PLATFORM} authSummary={authSummaryOf(p)}
            authFailed={p.name === SYNC_PLATFORM && hasAuthFailure(db, p.id)}
          />
        ))}
      </ul>
      <AddPlatformForm />
    </section>
  );
}
```

`platform-row.tsx`：props 增加 `syncSupported: boolean; authSummary: string | null; authFailed: boolean`；顶部 `import { PlatformAuthPanel } from './platform-auth-panel';`。行根元素在 `syncSupported` 时加 `id="fanqie"` 和 `className` 的 `scroll-mt-4`（各处"去设置"都定位到这里）；名称行行尾加标签：

```tsx
      {syncSupported && (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${authFailed ? 'bg-red-50 text-red-800' : authSummary ? 'bg-blue-50 text-blue-900' : 'bg-orange-100 text-orange-900'}`}>
          {authFailed ? '认证已失效' : authSummary ? '可同步' : '缺认证'}
        </span>
      )}
```
在 `{error && …}` 之后追加：

```tsx
      {syncSupported ? <PlatformAuthPanel platformId={id} summary={authSummary} authFailed={authFailed} /> : (
        <p className="text-xs text-stone-500">暂不支持自动校验</p>
      )}
```

- [ ] **Step 4: 改小说详情页绑定行**

`src/app/novels/[id]/page.tsx`：`ManagePlatformsPanel` 的 `bindings` 映射改为（只传脱敏字段，不含 cookie）：

```tsx
          bindings={bindings.map((b) => ({
            id: b.platform.id, name: b.platform.name, bound: b.bound, bookUrl: b.bookUrl, publicationCount: b.publicationCount,
            syncSupported: b.syncSupported, hasAuth: b.hasAuth, configured: b.configured,
            lastSyncedAt: b.lastSyncedAt, lastSyncError: b.lastSyncError,
          }))}
```

`manage-platforms-panel.tsx`：`Item` 增加 `syncSupported: boolean; hasAuth: boolean; configured: boolean; lastSyncedAt: number | null; lastSyncError: string | null`。顶部加：

```tsx
import { UserError } from '@/lib/result';
import { parseFanqieBookId } from '@/lib/fanqie-url';
import { fmtSyncTime, isAuthSyncError, syncErrorLabel } from '@/lib/sync-status';

/** 输入时的即时提示（F7.3）；真正的校验在保存时由服务端完成。 */
function linkHint(url: string): { text: string; warn: boolean } {
  if (!url.trim()) return { text: '从番茄作家后台打开本书“章节管理”，复制地址栏的链接。', warn: false };
  try {
    return { text: `✓ 格式正确，书号 ${parseFanqieBookId(url)}`, warn: false };
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return { text: '格式不对：应为 fanqienovel.com/main/writer/chapter-manage/<书号>', warn: true };
  }
}
```
`Row` 里：`label` 那一行行尾加配置标签，`{item.bound && (…)}` 块替换为：

```tsx
      {item.bound && item.syncSupported && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded px-2 py-0.5 font-medium ${item.configured ? 'bg-blue-50 text-blue-900' : 'bg-orange-100 text-orange-900'}`}>
              {item.configured ? '已配置' : !item.hasAuth ? '缺认证' : '缺链接'}
            </span>
            {item.lastSyncError ? (
              <span className="text-red-700">
                上次同步失败：{syncErrorLabel(item.lastSyncError)}{' '}
                {isAuthSyncError(item.lastSyncError) && <a className="underline" href="/settings#fanqie">去设置</a>}
              </span>
            ) : item.configured ? (
              <span className="text-stone-600">{item.lastSyncedAt ? `最近同步：${fmtSyncTime(item.lastSyncedAt)} · 成功` : '尚未同步'}</span>
            ) : null}
          </div>
          <label className="block text-xs text-stone-600" htmlFor={`url-${item.id}`}>作品链接（作家后台“章节管理”页）</label>
          <div className="flex gap-2">
            <input id={`url-${item.id}`} className="flex-1 rounded border px-2 font-mono text-xs" placeholder="https://fanqienovel.com/main/writer/chapter-manage/<书号>"
              value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }} />
            <button className="rounded border px-3 text-sm" disabled={pending} onClick={() => bind(url)}>{pending ? '校验中…' : '保存并校验'}</button>
          </div>
          {!error && <p className={`text-xs ${linkHint(url).warn ? 'text-orange-800' : 'text-stone-600'}`}>{linkHint(url).text}</p>}
          {!item.hasAuth && <p className="text-xs text-orange-900">未配置认证信息，不会同步状态。<a className="underline" href="/settings#fanqie">去设置</a></p>}
          {item.hasAuth && !item.bookUrl && <p className="text-xs text-orange-900">未填写作品链接，不会同步状态</p>}
        </div>
      )}
      {item.bound && !item.syncSupported && (
        <div className="space-y-1">
          <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600">暂不支持自动校验</span>
          <div className="flex gap-2">
            <input className="flex-1 rounded border px-2 text-sm" placeholder="作品主页链接（可选）" value={url}
              onChange={(e) => { setUrl(e.target.value); setError(''); }} />
            <button className="rounded border px-3 text-sm" disabled={pending} onClick={() => bind(url)}>保存链接</button>
          </div>
        </div>
      )}
```
原有的 `{error && …}` 保持（`role="alert"`、`font-medium`）。`fanqie-url.ts` 只依赖 `result.ts`，客户端可用；保存时的错误文案以 REQ-07 F7.3 / F7.4 为准。

- [ ] **Step 5: 类型检查与全量测试**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: 全部成功（`build` 验证 Server Action 与客户端组件边界无误）。

- [ ] **Step 6: 浏览器手动检查（无真实账号时）**

Run: `npm run dev`，打开 <http://127.0.0.1:3000/settings>
- 番茄行出现"认证信息 未配置 [配置]"和"缺认证"标签；起点行显示"暂不支持自动校验"。
- 在小说详情页「管理平台」勾选番茄，输入时提示随格式变化；输入 `https://example.com/x` 点「保存并校验」→ 行内显示格式错误，且未保存；输入样例链接 → 保存成功，显示"缺认证"和"未配置认证信息，不会同步状态。去设置"，矩阵番茄列显示"—"和"未配置"，表格上方出现"还差一步开启番茄同步"，筛选隐藏。
- 点"去设置"定位到番茄行；"清除"先要确认。
- 与 `R7*` 原型逐页对照文案和层级（新鲜度条、需更新操作条、文件丢失标签、编辑页提示、看板卡片）。
- 查看页面源码 / Network 响应，确认不含任何 Cookie 文本。

- [ ] **Step 7: 提交**

```bash
git add -A src
git commit -m "feat: platform auth panel and binding sync status" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 文档同步与真实账号验证

**Files:**
- Modify: `docs/requirements/REQ-02-chapter-management.md`、`REQ-03-platform-publish-matrix.md`、`REQ-04-stale-detection.md`、`REQ-06-dashboard.md`、`README.md`（需求索引）、仓库根 `README.md`
- Modify: `docs/requirements/REQ-07-platform-sync.md`（状态 → 已实现；回写接口结构验证结果）

- [ ] **Step 1: 在 REQ-02 / 03 / 04 / 06 文档顶部信息表后各加一段修订说明**

```markdown
> **已被 [REQ-07](REQ-07-platform-sync.md) 部分修订**：<REQ-02：F2.19 保存后不再即时刷新已配置平台的状态，改为提示需重新扫描。 | REQ-03：已配置平台的状态由番茄同步（仅 未发布/已发布/需更新），不可手动标记；未配置平台无状态。 | REQ-04：已配置平台的「需更新」由线上比对判定，不再比较 published_hash；未配置平台不参与。 | REQ-06：看板状态计数、占比条仅统计已配置平台；移除审核中/丢失。> 本文其余内容为 MVP 原始口径，与 REQ-07 冲突处以 REQ-07 为准。
```
（每个文件只写与其相关的那一句。）

- [ ] **Step 2: 更新根 `README.md`** — 功能表"平台与发布矩阵 / 过期提示"两行改为 REQ-07 口径，并新增一行"平台同步：番茄配置认证与作品链接后，重新扫描自动同步 未发布/已发布/需更新"；"使用方式"补一节"配置番茄同步"（设置页填认证 → 小说详情页绑定番茄并填章节管理页链接 → 重新扫描）。

- [ ] **Step 3: 用真实番茄账号验证接口假设**

1. 参考用户 `fanqie-publish` 技能的"鉴权抓取"，取得 `Cookie` 与 `X-Secsdk-Csrf-Token`。
2. `npm run dev` → 设置页保存认证（应校验通过；若报"返回格式无法识别"，说明 `book_list` 结构与假设不符）。
3. 对照 curl 实测各接口的真实响应结构（不要把 Cookie 写进命令历史：用环境变量）：

```bash
curl -s 'https://fanqienovel.com/api/author/book/book_list/v0?aid=2503&app_name=muye_novel&page_index=0&page_count=50' \
  -H "Cookie: $FQ_COOKIE" -H "X-Secsdk-Csrf-Token: $FQ_CSRF" | head -c 2000
```
   对 `volume_list`、`chapter_list`（含 `page_index` 取 0 / 1 的差异）、`edit_article` 同样检查。若字段路径或分页与"已知假设"不同，只改 `src/lib/fanqie-client.ts` 的解析与对应测试夹具，重跑 `npx vitest run src/lib/fanqie-client.test.ts`。
4. 用样例链接绑定番茄 → 点「重新扫描」，核对三态与作家后台一致。逐项验证：故意改一个字（字数变化 → 需更新）、改标题（需更新）、本地新增一章（未发布）；清除 Cookie 后重新扫描应提示认证失效且各章状态保持不变；本地改稿后详情页显示"同步后有改动"，重新扫描后消失。
5. 夜间审核时段（或有审核中章节时）验证审核中章节按 AC7.9 处理。

- [ ] **Step 4: 最终回归**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: 全部 PASS。

- [ ] **Step 5: 更新 REQ-07 状态并提交**

把 `REQ-07-platform-sync.md` 信息表中"状态"改为"已实现"，如有接口结构修正，在 §4.1 或 §7 末尾补一句"实测结构见 `src/lib/fanqie-client.ts`"。

```bash
git add docs README.md
git commit -m "docs: sync REQ-02/03/04/06 and README with REQ-07" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec 覆盖：**
- F7.1–F7.2 认证配置/校验 → Task 4（lib）+ Task 8（UI）；F7.3–F7.6 链接格式/归属/无认证/非番茄 → Task 2、4；F7.7 绑定行状态与最近同步 → Task 4（`listBindings`）+ Task 8。
- F7.8–F7.9 单本/全局重新扫描 → Task 6；F7.10–F7.11 判定与按需拉正文 → Task 5；F7.12 落库 → Task 5；F7.13 汇总文案 → Task 6；F7.14 pending → 沿用现有 `useTransition`；F7.15 目录不可读不同步 → Task 6（`rescanNovel`/`rescanAll`）。
- F7.16–F7.19 展示分流、筛选、看板 → Task 7。
- F7.20 阶段进度 → Task 6（`rescan-flow`）；F7.21 结果分条 → Task 6（`buildRescanNotice`、`NoticeInput.alert`）；F7.22 同步后有改动、F7.23 未配置清单、F7.24 新鲜度条、F7.25 需更新操作条、F7.26 文件丢失标签、F7.27 编辑页、F7.28 看板卡片 → Task 7；F7.29 认证面板与去设置定位、F7.30 绑定行即时提示 → Task 8。
- §4.2-1（不可手动）→ Task 7 删除手动 API 与 Server Action（服务端强制，而非仅隐藏按钮）；§4.2-4 失败不改状态 → Task 5（先读后写、事务）；§4.2-5 认证不外泄 → Task 3 固定文案 + 测试、Task 8 只传脱敏字段。
- AC7.1–AC7.15 均有对应测试：7.1/7.2 → Task 2；7.3/7.4 → Task 4；7.5–7.9 → Task 5；7.10 → Task 5/6；7.11/7.12 → Task 7；7.13（只发 GET）→ 客户端只实现 GET；7.14 → Task 3；7.15 → Task 6；7.16–7.18 → Task 6/7 单测；7.19–7.23 → `sync-status` 单测 + Task 8 Step 6 / Task 9 Step 3 手动验证。
- 数据迁移"遗留记录保留" → Task 1 仅加列；Task 7 `syncedStatus` 兜底遗留 `pending_review`，`published_hash` 列保留。

**占位符扫描：** 无 TBD/TODO。Task 7 对 `matrix-table.tsx` / `platform-card.tsx` 给出了关键片段与删除清单，其余为机械性删减，由 `tsc` 兜底。

**UX 取舍：** `RescanNovelButton` 与卡片菜单共用 `useRescanNovel`；重新扫描由客户端串联薄 Action，因此旧的 `rescanAction` / `rescanNovelAction` 被移除。

**类型一致性：** `RemoteChapter` / `FanqieClient` / `ClientFactory`（Task 3）→ Task 4 `bindPlatformChecked(makeClient: ClientFactory)`、Task 5/6 同名使用；`PlatformSyncOutcome`（Task 5）→ Task 6 `buildRescanNotice` 一致（`ok`/`authFailed`/`novelName`）；`isSyncConfigured` 入参 `{name,cookie,csrfToken,bookId}` 在 Task 4/5/7 三处调用字段一致；`MatrixCell.configured/badge:null`（Task 7）与组件使用一致；`PlatformStat` 新形状与 `RatioBar` / `NovelCard` 一致；`FullSyncSummary.failedNovelIds`（Task 6）仅 `listSyncableNovels` 使用；`MatrixCell` 新增字段在 `makeCell` 的两个分支都赋值。

**已识别风险：** 番茄接口字段路径为推断（见"已知假设"），Task 9 Step 3 是唯一的真实验证点，修正面集中在 `fanqie-client.ts`。
