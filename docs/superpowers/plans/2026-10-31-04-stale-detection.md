# REQ-04 过期提示（需更新）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布时记录发布形态 hash，之后本地内容变化即自动判定「需更新」，无需人工维护；提供统一的判定函数、徽标推导与提示文案，详情页、编辑页、看板共用。

**Architecture:** 「需更新」是**计算态，不入库**。本方案在 `publish.ts` 中追加三个纯函数：`isStale`、`deriveBadge`、`badgeHint`。写入 `published_hash` 的时机与「标记前先单章同步」由 REQ-03 的 `applyPublicationAction` 实现；本方案负责判定规则本身，以及一份端到端集成测试把整条链路钉住。

**Tech Stack:** TypeScript 纯函数、Vitest。

> **实施顺序（重要）：Task 1 必须在 REQ-03 方案开始前完成**（REQ-03 的矩阵直接 import `deriveBadge`/`badgeHint`）。Task 2 的集成测试依赖 REQ-03 的 service，必须在 REQ-03 完成后再做。

## Global Constraints

- 需更新判定（唯一定义）：`status ∈ {pending_review, published}` 且 `published_hash ≠ chapter.content_hash`。
- 优先级：`file_missing` → 显示「文件丢失」，**不**判需更新。
- `content_hash` 为空/NULL（尚未同步成功）→ **不**判需更新。
- `published_hash` 为空/NULL 而状态为审核中/已发布 → 按需更新处理（保守）。
- 不在渲染时读文件算 hash，只用已入库的 `content_hash`（同步负责保鲜）。
- 各平台独立判定；改回原样后自动恢复（自愈）。
- 提示文案：审核中徽标 `平台审核中，暂不能修改该章（番茄审核时段 7:00–24:00）`（括号部分仅平台名为「番茄」时附加）；审核中且已改稿 `本地内容已变更，待审核结束后再覆盖`；已发且已改稿 `本地内容已于 {M月D日 HH:mm} 变更，与 {平台} 已发版本不一致`（无 mtime 时省略「于 …」）；覆盖确认 `覆盖会重新审核，请确认已定稿。`

---

### Task 1: `isStale` / `deriveBadge` / `badgeHint`

**Files:**
- Modify: `src/lib/publish.ts`（文件末尾追加）
- Modify: `src/lib/publish.test.ts`（文件末尾追加，顶部 import 补充）

**Interfaces:**
- Consumes: `PublishStatus`、`Badge`（`src/lib/types.ts`）。
- Produces（**名称固定**）：
  - `interface ChapterForBadge { contentHash: string | null; fileMissing: boolean }`
  - `interface PublicationForBadge { status: PublishStatus; publishedHash: string | null }`
  - `isStale(ch: ChapterForBadge, pub?: PublicationForBadge | null): boolean`
  - `deriveBadge(ch: ChapterForBadge, pub?: PublicationForBadge | null): Badge`
  - `badgeHint(a: { badge: Badge; status: PublishStatus; platformName: string; mtimeMs?: number | null }): string | undefined`
  - `OVERWRITE_WARNING = '覆盖会重新审核，请确认已定稿。'`

- [ ] **Step 1: 追加失败测试**

```ts
// 追加到 src/lib/publish.test.ts（顶部 import 增加 badgeHint, deriveBadge, isStale）
describe('isStale / deriveBadge', () => {
  const ch = (h: string | null = 'H1', missing = false) => ({ contentHash: h, fileMissing: missing });
  const pub = (status: 'unpublished' | 'pending_review' | 'published', publishedHash: string | null) => ({ status, publishedHash });

  it.each([
    ['无发布记录', ch(), undefined, false, 'unpublished'],
    ['unpublished', ch(), pub('unpublished', null), false, 'unpublished'],
    ['已发且一致', ch('H1'), pub('published', 'H1'), false, 'published'],
    ['已发但不一致', ch('H2'), pub('published', 'H1'), true, 'stale'],
    ['审核中且一致', ch('H1'), pub('pending_review', 'H1'), false, 'pending_review'],
    ['审核中被改稿', ch('H2'), pub('pending_review', 'H1'), true, 'stale'],
    ['published_hash 为空（异常数据）', ch('H1'), pub('published', null), true, 'stale'],
    ['published_hash 空串', ch('H1'), pub('published', ''), true, 'stale'],
    ['content_hash 为 NULL → 不误报', ch(null), pub('published', 'H1'), false, 'published'],
    ['file_missing 优先于需更新', ch('H2', true), pub('published', 'H1'), false, 'missing'],
    ['file_missing 且无记录', ch('H1', true), undefined, false, 'missing'],
  ] as const)('%s', (_n, c, p, stale, badge) => {
    expect(isStale(c, p)).toBe(stale);
    expect(deriveBadge(c, p)).toBe(badge);
  });

  it('F4.5 自愈：内容改回后恢复已发', () => {
    expect(deriveBadge(ch('H1'), pub('published', 'H1'))).toBe('published');
    expect(deriveBadge(ch('H2'), pub('published', 'H1'))).toBe('stale');
    expect(deriveBadge(ch('H1'), pub('published', 'H1'))).toBe('published');
  });
});

describe('badgeHint', () => {
  const mtime = new Date(2026, 9, 31, 8, 5).getTime();
  it('审核中', () => {
    expect(badgeHint({ badge: 'pending_review', status: 'pending_review', platformName: '番茄' })).toBe(
      '平台审核中，暂不能修改该章（番茄审核时段 7:00–24:00）',
    );
    expect(badgeHint({ badge: 'pending_review', status: 'pending_review', platformName: '起点' })).toBe('平台审核中，暂不能修改该章');
  });
  it('需更新：审核中 / 已发（含与不含 mtime）', () => {
    expect(badgeHint({ badge: 'stale', status: 'pending_review', platformName: '番茄' })).toBe('本地内容已变更，待审核结束后再覆盖');
    expect(badgeHint({ badge: 'stale', status: 'published', platformName: '番茄', mtimeMs: mtime })).toBe(
      '本地内容已于 10月31日 08:05 变更，与 番茄 已发版本不一致',
    );
    expect(badgeHint({ badge: 'stale', status: 'published', platformName: '起点' })).toBe('本地内容已变更，与 起点 已发版本不一致');
  });
  it('其他徽标无提示（丢失除外）', () => {
    expect(badgeHint({ badge: 'published', status: 'published', platformName: '番茄' })).toBeUndefined();
    expect(badgeHint({ badge: 'missing', status: 'published', platformName: '番茄' })).toBe('文件丢失');
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/publish.test.ts` → FAIL（新函数未导出）。

- [ ] **Step 3: 实现（追加到 `src/lib/publish.ts` 末尾，并在文件顶部加 `import type { Badge, PublishStatus } from './types';`）**

```ts
export interface ChapterForBadge {
  contentHash: string | null;
  fileMissing: boolean;
}
export interface PublicationForBadge {
  status: PublishStatus;
  publishedHash: string | null;
}

export const OVERWRITE_WARNING = '覆盖会重新审核，请确认已定稿。';

/** 需更新 := status ∈ {pending_review, published} 且 published_hash ≠ content_hash。看板 SQL 必须与此等价。 */
export function isStale(ch: ChapterForBadge, pub?: PublicationForBadge | null): boolean {
  if (ch.fileMissing || !pub || pub.status === 'unpublished') return false;
  if (!ch.contentHash) return false;
  return !pub.publishedHash || pub.publishedHash !== ch.contentHash;
}

export function deriveBadge(ch: ChapterForBadge, pub?: PublicationForBadge | null): Badge {
  if (ch.fileMissing) return 'missing';
  if (!pub || pub.status === 'unpublished') return 'unpublished';
  return isStale(ch, pub) ? 'stale' : pub.status;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function badgeHint(a: {
  badge: Badge;
  status: PublishStatus;
  platformName: string;
  mtimeMs?: number | null;
}): string | undefined {
  switch (a.badge) {
    case 'pending_review':
      return `平台审核中，暂不能修改该章${a.platformName === '番茄' ? '（番茄审核时段 7:00–24:00）' : ''}`;
    case 'stale':
      if (a.status === 'pending_review') return '本地内容已变更，待审核结束后再覆盖';
      return `本地内容已${a.mtimeMs ? `于 ${fmtDate(a.mtimeMs)} ` : ''}变更，与 ${a.platformName} 已发版本不一致`;
    case 'missing':
      return '文件丢失';
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/publish.test.ts` → PASS（含 REQ-02 的用例）。

- [ ] **Step 5: 提交** —— `git add src/lib/publish.* && git commit -m "feat(stale): isStale, deriveBadge, badgeHint"`

---

### Task 2:（在 REQ-03 完成后）端到端集成测试

**Files:**
- Test: `src/lib/stale.integration.test.ts`

**Interfaces:**
- Consumes（REQ-03 提供）：`bindPlatform(db, novelId, platformId, bookUrl?)`、`applyPublicationAction(db, chapterId, platformId, action)`、`getMatrix(db, novelId, opts)`；（REQ-02）`syncNovel`；`listChapters`。

- [ ] **Step 1: 写测试（覆盖 AC4.1–AC4.7、AC4.9）**

```ts
// src/lib/stale.integration.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platform } from '@/db/schema';
import { insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { listChapters } from './chapters';
import { getMatrix } from './matrix';
import { applyPublicationAction } from './publications';
import { bindPlatform } from './platforms';
import { syncNovel } from './sync';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

let tick = 0;
function put(file: string, content: string) {
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() + ++tick * 5000);
  fs.utimesSync(file, t, t);
}

const V1 = '# 第1章 开端\n\n第一版正文。\n';
const V2 = '# 第1章 开端\n\n第二版正文，有改动。\n';

function setup() {
  const t = makeTmpDir({ 'Ch01-开端.md': V1 });
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  const [fanqie, qidian] = db.select().from(platform).orderBy(platform.id).all();
  bindPlatform(db, n.id, fanqie.id);
  bindPlatform(db, n.id, qidian.id);
  syncNovel(db, n.id);
  const file = path.join(t.dir, 'Ch01-开端.md');
  const chId = listChapters(db, n.id)[0].id;
  const badges = () => getMatrix(db, n.id).rows[0].cells.map((c) => c.badge);
  return { db, n, file, chId, fanqie, qidian, badges };
}

describe('需更新完整链路', () => {
  it('AC4.1/4.2/4.5：标记已发 → 改稿 → 需更新 → 标记已发布（更新为当前版本）→ 已发', () => {
    const s = setup();
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_published');
    expect(s.badges()).toEqual(['published', 'unpublished']);
    put(s.file, V2);
    syncNovel(s.db, s.n.id);
    expect(s.badges()).toEqual(['stale', 'unpublished']);
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_published');
    expect(s.badges()).toEqual(['published', 'unpublished']);
  });

  it('AC4.3：仅 CRLF / 首尾空白变化不触发需更新', () => {
    const s = setup();
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_published');
    put(s.file, '\n' + V1.replace(/\n/g, '\r\n') + '\n\n');
    syncNovel(s.db, s.n.id);
    expect(s.badges()).toEqual(['published', 'unpublished']);
  });

  it('AC4.4：改回与已发版本一致后自动恢复', () => {
    const s = setup();
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_published');
    put(s.file, V2);
    syncNovel(s.db, s.n.id);
    expect(s.badges()[0]).toBe('stale');
    put(s.file, V1);
    syncNovel(s.db, s.n.id);
    expect(s.badges()[0]).toBe('published');
  });

  it('AC4.6：多平台独立判定', () => {
    const s = setup();
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_published');
    put(s.file, V2);
    syncNovel(s.db, s.n.id);
    applyPublicationAction(s.db, s.chId, s.qidian.id, 'mark_published'); // 起点用新版本
    expect(s.badges()).toEqual(['stale', 'published']);
  });

  it('AC4.7：只看需更新', () => {
    const s = setup();
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_published');
    expect(getMatrix(s.db, s.n.id, { filter: 'stale' }).rows).toHaveLength(0);
    put(s.file, V2);
    syncNovel(s.db, s.n.id);
    expect(getMatrix(s.db, s.n.id, { filter: 'stale' }).rows).toHaveLength(1);
  });

  it('Q5：审核中被改稿显示需更新，通过审核不刷新 hash 因而仍是需更新', () => {
    const s = setup();
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_pending');
    put(s.file, V2);
    syncNovel(s.db, s.n.id);
    expect(s.badges()[0]).toBe('stale');
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'approve');
    expect(s.badges()[0]).toBe('stale');
  });

  it('AC4.9：文件丢失显示丢失而非需更新', () => {
    const s = setup();
    applyPublicationAction(s.db, s.chId, s.fanqie.id, 'mark_published');
    put(s.file, V2);
    syncNovel(s.db, s.n.id);
    fs.rmSync(s.file);
    syncNovel(s.db, s.n.id);
    expect(s.badges()).toEqual(['missing', 'missing']);
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `npx vitest run src/lib/stale.integration.test.ts`
Expected: PASS。若 `AC4.2` 失败，检查 REQ-03 的 `applyPublicationAction('mark_published')` 在 `published → published` 时是否刷新了 `published_hash`；若「标记前同步」用例相关失败，检查 `applyPublicationAction` 是否先调用 `syncChapter`。

- [ ] **Step 3: 手动验证（AC4.2 / 4.5 界面链路）**

在详情页（REQ-03）：标记番茄某章已发 → 用外部编辑器改一个字 → 点「重新扫描」→ 徽标变橙色「需更新」、悬浮提示含「与 番茄 已发版本不一致」→ 点徽标 →「标记已发布（更新为当前版本）」→ 回到蓝色「已发」。再测：只把文件换行符改为 CRLF 后重新扫描，徽标不应变化。

- [ ] **Step 4: 提交** —— `git add src/lib/stale.integration.test.ts && git commit -m "test(stale): end-to-end stale detection chain"`

---

## Self-Review

- 覆盖：F4.1（Task 1）、F4.2（REQ-02 Task 2 已实现）、F4.3/F4.10（REQ-03 的 `nextPublication`，Task 2 集成测试验证）、F4.4–4.5（计算态 + 自愈用例）、F4.6（`badgeHint`）、F4.7（`getMatrix` filter，Task 2）、F4.8（REQ-03 编辑页状态卡复用 `deriveBadge`）、F4.9（REQ-06 的 SQL 与 `isStale` 做一致性对拍）、F4.11（只读入库 hash）。AC4.8（详情页与看板数量一致）由 REQ-06 的对拍测试保证。
- 异常场景：`content_hash` NULL、`published_hash` 为空、文件丢失 —— Task 1 参数化用例全覆盖。
- 类型一致性：`Badge`、`PublishStatus` 来自基础方案 `types.ts`；`deriveBadge` 的入参只需 `{contentHash, fileMissing}` / `{status, publishedHash}`，`Chapter`/`Publication` 行对象可直接传入。
