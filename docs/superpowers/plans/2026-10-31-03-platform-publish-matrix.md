# REQ-03 平台与发布矩阵 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理平台列表；小说绑定平台；以「章节 × 平台」矩阵记录并展示发布状态，支持手动流转（标记审核中/已发布/重新提交/取消/撤销）与筛选。

**Architecture:** `platforms.ts`（平台 CRUD + 绑定）→ `publications.ts`（**纯状态机** `nextPublication` + 带「标记前先单章同步」的 `applyPublicationAction`）→ `matrix.ts`（矩阵查询、徽标推导、筛选与计数）→ Server Action → 小说详情页（矩阵 + 管理平台面板）、设置页平台区、编辑页平台状态卡。状态变更只改库，不碰文件，不调用外部。

**Tech Stack:** drizzle-orm、Vitest、React 客户端组件。前置：基础设施、REQ-01、REQ-02 已完成，且 **REQ-04 方案 Task 1（`isStale`/`deriveBadge`/`badgeHint`）已完成**。

## Global Constraints

- `publication.status` 入库仅 `unpublished | pending_review | published`；`(chapter_id, platform_id)` 唯一；记录**惰性创建**（首次标记才写入）。
- 发布记录受保护：解绑、同步、文件丢失都**不得删除** `publication`；解绑只删 `novel_platform`，重新绑定后记录恢复可见。
- 状态转换（F3.12–F3.15）：

| 动作 | 允许的当前状态 | 结果 |
|---|---|---|
| `mark_pending` 标记审核中 | unpublished | `pending_review`，`published_at=now`，`published_hash=当前content_hash` |
| `mark_published` 标记已发布 | unpublished / published | `published`，同样刷新 `published_at`、`published_hash` |
| `approve` 审核通过 | pending_review | `published`，**不改** `published_hash`/`published_at` |
| `resubmit` 重新提交（覆盖） | published | `pending_review`，刷新 `published_at`、`published_hash` |
| `cancel` 取消/取消已发 | pending_review / published | `unpublished`，清空 `published_at`、`published_hash`，**保留** `platform_url` |

- `file_missing` 章节：只允许 `cancel`；其余报 `文件丢失的章节没有可对照的内容，不能标记已发。`
- 需要 hash 的动作（`mark_pending`/`mark_published`/`resubmit`）执行前先 `syncChapter`（REQ-04 Q1），`content_hash` 仍为空则报 `该章尚未同步成功，请先重新扫描`。
- 平台名：trim 后长度 1–20，忽略大小写不可重名；预置平台（番茄、起点）不可删除、不可改名；自定义平台仅当无绑定且无发布记录才可删除。
- `book_url` / `platform_url` 非空时必须 `http(s)://`。
- 文案（逐字）：`平台已存在`、`平台名称长度应为 1–20 个字`、`无法删除：{平台}被 {N} 本小说绑定，并有 {M} 条发布记录。请保留该平台。`、`已有 N 条发布记录将被隐藏，重新绑定后恢复。`、`请先绑定发布平台`、`所有已发章节都是最新的`、`没有未发布的章节`、`显示 X / 共 Y 章`。
- 筛选语义：任一**已绑定**（或下拉选定的那一个）平台满足即命中；`file_missing` 的章节既不算「需更新」也不算「未发布」；URL 参数 `?filter=all|stale|unpublished&platform=<id>`。

---

### Task 1: 平台与绑定 service

**Files:**
- Create: `src/lib/platforms.ts`
- Test: `src/lib/platforms.test.ts`

**Interfaces:**
- Produces（**名称固定**）：
  - `listPlatforms(db): Array<Platform & { boundNovels: number }>`（按 id 升序，预置在前）
  - `addPlatform(db, name: string): Platform`
  - `renamePlatform(db, id: number, name: string): Platform`
  - `deletePlatform(db, id: number): void`
  - `validateUrl(input: string | null | undefined, label: string): string | null` —— 空 → `null`，非法抛 `UserError`
  - `bindPlatform(db, novelId, platformId, bookUrl?: string | null): void`（已绑定则更新 `book_url`）
  - `unbindPlatform(db, novelId, platformId): void`
  - `interface Binding { platform: Platform; bound: boolean; bookUrl: string | null; publicationCount: number }` 与 `listBindings(db, novelId): Binding[]` —— `publicationCount` = 该小说章节在该平台已有的 `publication` 记录数（用于解绑确认文案）

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/platforms.test.ts
import { describe, expect, it } from 'vitest';
import { chapter, platform, publication } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { UserError } from './result';
import { addPlatform, bindPlatform, deletePlatform, listBindings, listPlatforms, renamePlatform, unbindPlatform } from './platforms';

describe('平台管理', () => {
  it('AC3.1 预置平台存在且不可删/改名', () => {
    const db = makeDb();
    const [fanqie] = listPlatforms(db);
    expect(listPlatforms(db).map((p) => [p.name, p.builtin])).toEqual([['番茄', true], ['起点', true]]);
    expect(() => deletePlatform(db, fanqie.id)).toThrow('预置平台不可删除');
    expect(() => renamePlatform(db, fanqie.id, '别名')).toThrow('预置平台不可改名');
  });

  it('AC3.2 新增、去空白、重名（忽略大小写）被拒', () => {
    const db = makeDb();
    expect(addPlatform(db, '  晋江 ').name).toBe('晋江');
    expect(() => addPlatform(db, '晋江')).toThrow('平台已存在');
    addPlatform(db, 'Wattpad');
    expect(() => addPlatform(db, 'wattpad ')).toThrow('平台已存在');
  });

  it('长度校验', () => {
    const db = makeDb();
    expect(() => addPlatform(db, '   ')).toThrow('平台名称长度应为 1–20 个字');
    expect(() => addPlatform(db, 'a'.repeat(21))).toThrow('平台名称长度应为 1–20 个字');
  });

  it('自定义平台可改名（不与自己冲突）', () => {
    const db = makeDb();
    const p = addPlatform(db, '晋江');
    expect(renamePlatform(db, p.id, '晋江文学城').name).toBe('晋江文学城');
    expect(renamePlatform(db, p.id, '晋江文学城').name).toBe('晋江文学城');
    expect(() => renamePlatform(db, p.id, '番茄')).toThrow('平台已存在');
  });

  it('删除：被引用时拒绝并说明数量；无引用可删', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const p = addPlatform(db, '晋江');
    bindPlatform(db, n.id, p.id);
    const ch = db.insert(chapter).values({ novelId: n.id, seq: 1, title: 't', filePath: '/x/A/Ch01-t.md' }).returning().get();
    db.insert(publication).values({ chapterId: ch.id, platformId: p.id, status: 'published' }).run();
    expect(() => deletePlatform(db, p.id)).toThrow('无法删除：晋江被 1 本小说绑定，并有 1 条发布记录。请保留该平台。');
    const q = addPlatform(db, '七猫');
    deletePlatform(db, q.id);
    expect(listPlatforms(db).map((x) => x.name)).not.toContain('七猫');
  });
});

describe('绑定', () => {
  it('book_url 校验', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const [fanqie] = listPlatforms(db);
    expect(() => bindPlatform(db, n.id, fanqie.id, 'ftp://x')).toThrow(UserError);
    bindPlatform(db, n.id, fanqie.id, ' https://fanqie.example/book/1 ');
    expect(listBindings(db, n.id).find((b) => b.platform.id === fanqie.id)).toMatchObject({ bound: true, bookUrl: 'https://fanqie.example/book/1' });
    bindPlatform(db, n.id, fanqie.id, ''); // 再次绑定 = 更新链接
    expect(listBindings(db, n.id)[0].bookUrl).toBeNull();
  });

  it('AC3.6 解绑保留发布记录，重新绑定后仍在', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const [fanqie] = listPlatforms(db);
    bindPlatform(db, n.id, fanqie.id);
    const ch = db.insert(chapter).values({ novelId: n.id, seq: 1, title: 't', filePath: '/x/A/Ch01-t.md' }).returning().get();
    db.insert(publication).values({ chapterId: ch.id, platformId: fanqie.id, status: 'published', publishedHash: 'h' }).run();
    expect(listBindings(db, n.id)[0].publicationCount).toBe(1);
    unbindPlatform(db, n.id, fanqie.id);
    expect(listBindings(db, n.id)[0]).toMatchObject({ bound: false, publicationCount: 1 });
    expect(db.select().from(publication).all()).toHaveLength(1);
    bindPlatform(db, n.id, fanqie.id);
    expect(db.select().from(publication).get()).toMatchObject({ status: 'published', publishedHash: 'h' });
  });
});

it('platform 表由迁移预置，且 seed 幂等', () => {
  const db = makeDb();
  expect(db.select().from(platform).all()).toHaveLength(2);
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/platforms.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/platforms.ts
import { and, count, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, platform, publication, type Platform } from '@/db/schema';
import { UserError } from './result';

function cleanName(input: string, selfId?: number, db?: Db): string {
  const name = input.trim();
  if (name.length < 1 || name.length > 20) throw new UserError('平台名称长度应为 1–20 个字');
  if (db) {
    const dup = db.select().from(platform).all().some((p) => p.id !== selfId && p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) throw new UserError('平台已存在');
  }
  return name;
}

export function listPlatforms(db: Db): Array<Platform & { boundNovels: number }> {
  return db
    .select()
    .from(platform)
    .orderBy(platform.id)
    .all()
    .map((p) => ({
      ...p,
      boundNovels: db.select({ c: count() }).from(novelPlatform).where(eq(novelPlatform.platformId, p.id)).get()!.c,
    }));
}

export function addPlatform(db: Db, name: string): Platform {
  return db.insert(platform).values({ name: cleanName(name, undefined, db), builtin: false }).returning().get();
}

export function renamePlatform(db: Db, id: number, name: string): Platform {
  const p = db.select().from(platform).where(eq(platform.id, id)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.builtin) throw new UserError('预置平台不可改名');
  return db.update(platform).set({ name: cleanName(name, id, db) }).where(eq(platform.id, id)).returning().get();
}

export function deletePlatform(db: Db, id: number): void {
  const p = db.select().from(platform).where(eq(platform.id, id)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.builtin) throw new UserError('预置平台不可删除');
  const bound = db.select({ c: count() }).from(novelPlatform).where(eq(novelPlatform.platformId, id)).get()!.c;
  const pubs = db.select({ c: count() }).from(publication).where(eq(publication.platformId, id)).get()!.c;
  if (bound > 0 || pubs > 0) {
    throw new UserError(`无法删除：${p.name}被 ${bound} 本小说绑定，并有 ${pubs} 条发布记录。请保留该平台。`);
  }
  db.delete(platform).where(eq(platform.id, id)).run();
}

export function validateUrl(input: string | null | undefined, label: string): string | null {
  const v = (input ?? '').trim();
  if (!v) return null;
  let ok = /^https?:\/\//i.test(v);
  if (ok) {
    try {
      new URL(v);
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new UserError(`${label}格式错误：需以 http:// 或 https:// 开头`);
  return v;
}

export function bindPlatform(db: Db, novelId: number, platformId: number, bookUrl?: string | null): void {
  const url = validateUrl(bookUrl, '作品主页链接');
  db.insert(novelPlatform)
    .values({ novelId, platformId, bookUrl: url })
    .onConflictDoUpdate({ target: [novelPlatform.novelId, novelPlatform.platformId], set: { bookUrl: url } })
    .run();
}

export function unbindPlatform(db: Db, novelId: number, platformId: number): void {
  db.delete(novelPlatform).where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId))).run();
}

export interface Binding {
  platform: Platform;
  bound: boolean;
  bookUrl: string | null;
  publicationCount: number;
}

export function listBindings(db: Db, novelId: number): Binding[] {
  const links = new Map(db.select().from(novelPlatform).where(eq(novelPlatform.novelId, novelId)).all().map((l) => [l.platformId, l]));
  return db
    .select()
    .from(platform)
    .orderBy(platform.id)
    .all()
    .map((p) => ({
      platform: p,
      bound: links.has(p.id),
      bookUrl: links.get(p.id)?.bookUrl ?? null,
      publicationCount: db
        .select({ c: count() })
        .from(publication)
        .innerJoin(chapter, eq(chapter.id, publication.chapterId))
        .where(and(eq(chapter.novelId, novelId), eq(publication.platformId, p.id)))
        .get()!.c,
    }));
}
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/platforms.test.ts` → PASS。

- [ ] **Step 5: 提交** —— `git add src/lib/platforms.* && git commit -m "feat(platform): platform CRUD and novel binding"`

---

### Task 2: 发布状态机与 service

**Files:**
- Create: `src/lib/publications.ts`
- Test: `src/lib/publications.test.ts`

**Interfaces:**
- Consumes: `syncChapter`（REQ-02）；`validateUrl`。
- Produces（**名称固定**）：
  - `type PubAction = 'mark_pending' | 'mark_published' | 'approve' | 'resubmit' | 'cancel'`
  - `interface PubSnapshot { status: PublishStatus; publishedAt: number | null; publishedHash: string | null; platformUrl: string | null }`
  - `nextPublication(prev: PubSnapshot, action: PubAction, ctx: { contentHash: string | null; fileMissing: boolean; now: number }): PubSnapshot` —— **纯函数**，非法转换抛 `UserError`
  - `applyPublicationAction(db, chapterId, platformId, action, now?): { before: PubSnapshot; after: PubSnapshot }`
  - `restorePublication(db, chapterId, platformId, snapshot: PubSnapshot): void`（撤销）
  - `updatePublicationInfo(db, chapterId, platformId, patch: { platformUrl?: string | null; publishedAt?: number | null }): PubSnapshot`
  - `expectedStatus(action: PubAction): PublishStatus`（乐观更新用）

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/publications.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { publication } from '@/db/schema';
import { insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { listChapters } from './chapters';
import { bindPlatform, listPlatforms } from './platforms';
import { applyPublicationAction, nextPublication, restorePublication, updatePublicationInfo, type PubSnapshot } from './publications';
import { syncNovel } from './sync';

const E: PubSnapshot = { status: 'unpublished', publishedAt: null, publishedHash: null, platformUrl: null };
const ctx = { contentHash: 'H', fileMissing: false, now: 1000 };
const snap = (status: PubSnapshot['status'], over: Partial<PubSnapshot> = {}): PubSnapshot => ({ ...E, status, publishedAt: 1, publishedHash: 'OLD', ...over });

describe('nextPublication（纯状态机）', () => {
  it('mark_pending / mark_published 从未发出发：写入状态、时间、当前 hash', () => {
    expect(nextPublication(E, 'mark_pending', ctx)).toEqual({ ...E, status: 'pending_review', publishedAt: 1000, publishedHash: 'H' });
    expect(nextPublication(E, 'mark_published', ctx)).toEqual({ ...E, status: 'published', publishedAt: 1000, publishedHash: 'H' });
  });
  it('approve 只改 status，不改 hash 与时间', () => {
    expect(nextPublication(snap('pending_review'), 'approve', ctx)).toEqual(snap('published'));
  });
  it('mark_published 对 published 刷新为当前版本（F4.10）', () => {
    expect(nextPublication(snap('published'), 'mark_published', ctx)).toMatchObject({ status: 'published', publishedHash: 'H', publishedAt: 1000 });
  });
  it('resubmit：published → pending_review 并刷新', () => {
    expect(nextPublication(snap('published'), 'resubmit', ctx)).toMatchObject({ status: 'pending_review', publishedHash: 'H', publishedAt: 1000 });
  });
  it('cancel 清空时间与 hash，保留 platformUrl', () => {
    expect(nextPublication(snap('published', { platformUrl: 'https://a.b/c' }), 'cancel', ctx)).toEqual({
      status: 'unpublished', publishedAt: null, publishedHash: null, platformUrl: 'https://a.b/c',
    });
  });
  it('非法转换', () => {
    expect(() => nextPublication(snap('published'), 'mark_pending', ctx)).toThrow(/不能/);
    expect(() => nextPublication(E, 'approve', ctx)).toThrow(/不能/);
    expect(() => nextPublication(E, 'resubmit', ctx)).toThrow(/不能/);
    expect(() => nextPublication(snap('pending_review'), 'mark_published', ctx)).toThrow(/不能/);
    expect(() => nextPublication(E, 'cancel', ctx)).toThrow(/不能/);
  });
  it('AC3.9 file_missing：仅允许 cancel', () => {
    const missing = { ...ctx, fileMissing: true };
    expect(() => nextPublication(E, 'mark_published', missing)).toThrow('文件丢失的章节没有可对照的内容，不能标记已发。');
    expect(nextPublication(snap('published'), 'cancel', missing).status).toBe('unpublished');
  });
  it('content_hash 为空时拒绝需要 hash 的动作', () => {
    expect(() => nextPublication(E, 'mark_published', { ...ctx, contentHash: null })).toThrow('该章尚未同步成功，请先重新扫描');
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup() {
  const t = makeTmpDir({ 'Ch01-开端.md': '# 第1章 开端\n\n第一版。\n' });
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  const [fanqie, qidian] = listPlatforms(db);
  bindPlatform(db, n.id, fanqie.id);
  syncNovel(db, n.id);
  const ch = listChapters(db, n.id)[0];
  const row = () => db.select().from(publication).where(eq(publication.chapterId, ch.id)).get();
  return { db, n, ch, fanqie, qidian, file: path.join(t.dir, 'Ch01-开端.md'), row };
}

describe('applyPublicationAction（含库）', () => {
  it('AC3.4 惰性创建记录，published_hash = 当前 content_hash', () => {
    const s = setup();
    expect(s.row()).toBeUndefined();
    const { after } = applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'mark_published', 5000);
    expect(after).toMatchObject({ status: 'published', publishedAt: 5000, publishedHash: s.ch.contentHash });
    expect(s.row()).toMatchObject({ status: 'published', publishedHash: s.ch.contentHash });
  });

  it('AC3.5 取消后撤销，恢复原状态与字段', () => {
    const s = setup();
    applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'mark_published', 5000);
    const { before } = applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'cancel');
    expect(s.row()).toMatchObject({ status: 'unpublished', publishedAt: null, publishedHash: null });
    restorePublication(s.db, s.ch.id, s.fanqie.id, before);
    expect(s.row()).toMatchObject({ status: 'published', publishedAt: 5000, publishedHash: s.ch.contentHash });
  });

  it('REQ-04 Q1：标记前先单章同步，避免记录陈旧 hash', () => {
    const s = setup();
    fs.writeFileSync(s.file, '# 第1章 开端\n\n外部改过，库里还没同步。\n');
    const { after } = applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'mark_published');
    const fresh = listChapters(s.db, s.n.id)[0];
    expect(fresh.contentHash).not.toBe(s.ch.contentHash);
    expect(after.publishedHash).toBe(fresh.contentHash);
  });

  it('未绑定的平台被拒绝', () => {
    const s = setup();
    expect(() => applyPublicationAction(s.db, s.ch.id, s.qidian.id, 'mark_published')).toThrow('该小说未绑定此平台');
  });

  it('文件丢失后只能取消', () => {
    const s = setup();
    applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'mark_published');
    fs.rmSync(s.file);
    syncNovel(s.db, s.n.id);
    expect(() => applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'resubmit')).toThrow(/文件丢失/);
    applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'cancel');
    expect(s.row()!.status).toBe('unpublished');
  });
});

describe('updatePublicationInfo', () => {
  it('更新链接与发布时间；链接校验；未发状态不可设发布时间', () => {
    const s = setup();
    expect(() => updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { platformUrl: 'nope' })).toThrow('章节链接格式错误');
    expect(updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { platformUrl: 'https://a.b/c' }).platformUrl).toBe('https://a.b/c');
    expect(() => updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { publishedAt: 9 })).toThrow('未发布的章节没有发布时间');
    applyPublicationAction(s.db, s.ch.id, s.fanqie.id, 'mark_published', 1);
    expect(updatePublicationInfo(s.db, s.ch.id, s.fanqie.id, { publishedAt: 9 }).publishedAt).toBe(9);
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/publications.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/publications.ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, publication, type Chapter, type Publication } from '@/db/schema';
import { validateUrl } from './platforms';
import { UserError } from './result';
import { syncChapter } from './sync';
import type { PublishStatus } from './types';

export type PubAction = 'mark_pending' | 'mark_published' | 'approve' | 'resubmit' | 'cancel';

export interface PubSnapshot {
  status: PublishStatus;
  publishedAt: number | null;
  publishedHash: string | null;
  platformUrl: string | null;
}

const EMPTY: PubSnapshot = { status: 'unpublished', publishedAt: null, publishedHash: null, platformUrl: null };

export const snapshotOf = (row?: Publication | null): PubSnapshot =>
  row ? { status: row.status, publishedAt: row.publishedAt, publishedHash: row.publishedHash, platformUrl: row.platformUrl } : { ...EMPTY };

export function expectedStatus(action: PubAction): PublishStatus {
  return action === 'mark_pending' || action === 'resubmit' ? 'pending_review' : action === 'cancel' ? 'unpublished' : 'published';
}

const NEEDS_HASH: PubAction[] = ['mark_pending', 'mark_published', 'resubmit'];
const ALLOWED_FROM: Record<Exclude<PubAction, 'cancel'>, PublishStatus[]> = {
  mark_pending: ['unpublished'],
  mark_published: ['unpublished', 'published'],
  approve: ['pending_review'],
  resubmit: ['published'],
};
const ACTION_LABEL: Record<PubAction, string> = {
  mark_pending: '标记审核中', mark_published: '标记已发布', approve: '标记审核通过', resubmit: '重新提交', cancel: '取消',
};

export function nextPublication(
  prev: PubSnapshot,
  action: PubAction,
  ctx: { contentHash: string | null; fileMissing: boolean; now: number },
): PubSnapshot {
  if (action === 'cancel') {
    if (prev.status === 'unpublished') throw new UserError('当前未发布，不能取消');
    return { ...prev, status: 'unpublished', publishedAt: null, publishedHash: null };
  }
  if (ctx.fileMissing) throw new UserError('文件丢失的章节没有可对照的内容，不能标记已发。');
  if (!ALLOWED_FROM[action].includes(prev.status)) throw new UserError(`当前状态不能${ACTION_LABEL[action]}`);
  if (action === 'approve') return { ...prev, status: 'published' };
  if (NEEDS_HASH.includes(action) && !ctx.contentHash) throw new UserError('该章尚未同步成功，请先重新扫描');
  return { ...prev, status: expectedStatus(action), publishedAt: ctx.now, publishedHash: ctx.contentHash };
}

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

export function applyPublicationAction(db: Db, chapterId: number, platformId: number, action: PubAction, now = Date.now()) {
  let ch = getChapter(db, chapterId);
  const bound = db
    .select()
    .from(novelPlatform)
    .where(and(eq(novelPlatform.novelId, ch.novelId), eq(novelPlatform.platformId, platformId)))
    .get();
  if (!bound) throw new UserError('该小说未绑定此平台');
  if (NEEDS_HASH.includes(action)) {
    syncChapter(db, chapterId); // REQ-04 Q1：记录的必须是此刻磁盘上的版本
    ch = getChapter(db, chapterId);
  }
  const before = snapshotOf(rowOf(db, chapterId, platformId));
  const after = nextPublication(before, action, { contentHash: ch.contentHash, fileMissing: ch.fileMissing, now });
  write(db, chapterId, platformId, after);
  return { before, after };
}

export function restorePublication(db: Db, chapterId: number, platformId: number, snapshot: PubSnapshot): void {
  write(db, chapterId, platformId, snapshot);
}

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

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/publications.test.ts` → PASS。

- [ ] **Step 5: 提交** —— `git add src/lib/publications.* && git commit -m "feat(publish): publication state machine and actions"`

---

### Task 3: 矩阵查询（徽标、筛选、计数）

**Files:**
- Create: `src/lib/matrix.ts`
- Test: `src/lib/matrix.test.ts`

**Interfaces:**
- Consumes: `deriveBadge`、`badgeHint`（REQ-04 Task 1）；`listChapters`。
- Produces（**名称固定**，均为可序列化的纯数据，直接传给客户端组件）：
  - `type Filter = 'all' | 'stale' | 'unpublished'`；`parseFilter(v: string | undefined): Filter`
  - `interface MatrixCell { platformId: number; platformName: string; status: PublishStatus; badge: Badge; publishedAt: number | null; platformUrl: string | null; hint?: string }`
  - `interface MatrixRow { chapter: Chapter; cells: MatrixCell[] }`
  - `interface Matrix { platforms: Array<{ id: number; name: string; bookUrl: string | null }>; rows: MatrixRow[]; counts: { all: number; stale: number; unpublished: number }; total: number }`
  - `getMatrix(db, novelId, opts?: { filter?: Filter; platformId?: number | null }): Matrix` —— `rows` 为筛选后的结果；`counts` 与 `total` 不受 `filter` 影响，但受 `platformId` 限定
  - `getChapterCells(db, chapterId): MatrixCell[]` —— 编辑页平台状态卡用

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/matrix.test.ts
import { describe, expect, it } from 'vitest';
import { chapter, publication } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { getChapterCells, getMatrix, parseFilter } from './matrix';
import { bindPlatform, listPlatforms, unbindPlatform } from './platforms';

function setup() {
  const db = makeDb();
  const n = insertNovel(db, '/x/A');
  const [fanqie, qidian] = listPlatforms(db);
  bindPlatform(db, n.id, fanqie.id);
  bindPlatform(db, n.id, qidian.id);
  const mk = (seq: number, over: Partial<typeof chapter.$inferInsert> = {}) =>
    db.insert(chapter).values({ novelId: n.id, seq, title: `T${seq}`, filePath: `/x/A/Ch${seq}.md`, contentHash: `H${seq}`, ...over }).returning().get();
  return { db, n, fanqie, qidian, mk };
}

describe('getMatrix', () => {
  it('AC3.3 只显示已绑定平台的列', () => {
    const s = setup();
    unbindPlatform(s.db, s.n.id, s.qidian.id);
    s.mk(1);
    const m = getMatrix(s.db, s.n.id);
    expect(m.platforms.map((p) => p.name)).toEqual(['番茄']);
    expect(m.rows[0].cells).toHaveLength(1);
  });

  it('无记录等同未发布；徽标与计数', () => {
    const s = setup();
    const c1 = s.mk(1); // 番茄已发且一致
    const c2 = s.mk(2); // 番茄已发但过期
    s.mk(3); // 全未发
    const c4 = s.mk(4, { fileMissing: true });
    s.db.insert(publication).values([
      { chapterId: c1.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'H1' },
      { chapterId: c2.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'OLD' },
      { chapterId: c4.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'H4' },
    ]).run();
    const m = getMatrix(s.db, s.n.id);
    expect(m.rows.map((r) => r.cells[0].badge)).toEqual(['published', 'stale', 'unpublished', 'missing']);
    // 第 1、2 章在起点未发，第 3 章两个平台都未发 → 3；文件丢失的第 4 章不计入
    expect(m.counts).toEqual({ all: 4, stale: 1, unpublished: 3 });
    expect(m.total).toBe(4);
    expect(m.rows[1].cells[0].hint).toContain('与 番茄 已发版本不一致');
  });

  it('AC3.7 / 筛选语义：任一平台命中；平台下拉限定范围；missing 不算未发布', () => {
    const s = setup();
    const c1 = s.mk(1);
    s.mk(2);
    s.mk(3, { fileMissing: true });
    s.db.insert(publication).values([
      { chapterId: c1.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'H1' },
      { chapterId: c1.id, platformId: s.qidian.id, status: 'published', publishedHash: 'H1' },
    ]).run();
    expect(getMatrix(s.db, s.n.id, { filter: 'unpublished' }).rows.map((r) => r.chapter.seq)).toEqual([2]);
    // 限定到番茄：第 1 章已发 → 不出现；第 2 章未发 → 出现
    const m = getMatrix(s.db, s.n.id, { filter: 'unpublished', platformId: s.fanqie.id });
    expect(m.rows.map((r) => r.chapter.seq)).toEqual([2]);
    expect(m.counts.unpublished).toBe(1);
  });

  it('filter=all 返回全部', () => {
    const s = setup();
    s.mk(1);
    s.mk(2);
    expect(getMatrix(s.db, s.n.id, { filter: 'all' }).rows).toHaveLength(2);
  });
});

it('parseFilter', () => {
  expect(parseFilter('stale')).toBe('stale');
  expect(parseFilter('xx')).toBe('all');
  expect(parseFilter(undefined)).toBe('all');
});

describe('getChapterCells', () => {
  it('返回该章在每个已绑定平台的单元格', () => {
    const s = setup();
    const c = s.mk(1);
    expect(getChapterCells(s.db, c.id).map((x) => [x.platformName, x.badge])).toEqual([['番茄', 'unpublished'], ['起点', 'unpublished']]);
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/matrix.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/matrix.ts
import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, platform, publication, type Chapter, type Publication } from '@/db/schema';
import { listChapters } from './chapters';
import { badgeHint, deriveBadge } from './publish';
import type { Badge, PublishStatus } from './types';

export type Filter = 'all' | 'stale' | 'unpublished';
export const parseFilter = (v: string | undefined): Filter => (v === 'stale' || v === 'unpublished' ? v : 'all');

export interface MatrixCell {
  platformId: number;
  platformName: string;
  status: PublishStatus;
  badge: Badge;
  publishedAt: number | null;
  platformUrl: string | null;
  hint?: string;
}
export interface MatrixRow {
  chapter: Chapter;
  cells: MatrixCell[];
}
export interface Matrix {
  platforms: Array<{ id: number; name: string; bookUrl: string | null }>;
  rows: MatrixRow[];
  counts: { all: number; stale: number; unpublished: number };
  total: number;
}

function makeCell(ch: Chapter, pl: { id: number; name: string }, pub?: Publication): MatrixCell {
  const status = pub?.status ?? 'unpublished';
  const badge = deriveBadge(ch, pub);
  return {
    platformId: pl.id,
    platformName: pl.name,
    status,
    badge,
    publishedAt: pub?.publishedAt ?? null,
    platformUrl: pub?.platformUrl ?? null,
    hint: badgeHint({ badge, status, platformName: pl.name, mtimeMs: ch.mtimeMs }),
  };
}

function boundPlatforms(db: Db, novelId: number) {
  return db
    .select({ id: platform.id, name: platform.name, bookUrl: novelPlatform.bookUrl })
    .from(novelPlatform)
    .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
    .where(eq(novelPlatform.novelId, novelId))
    .orderBy(platform.id)
    .all();
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
    cells: platforms.map((pl) => makeCell(ch, pl, byKey.get(`${ch.id}:${pl.id}`))),
  }));

  const scoped = (r: MatrixRow) => (opts.platformId ? r.cells.filter((c) => c.platformId === opts.platformId) : r.cells);
  const has = (r: MatrixRow, b: Badge) => scoped(r).some((c) => c.badge === b);
  const counts = {
    all: all.length,
    stale: all.filter((r) => has(r, 'stale')).length,
    unpublished: all.filter((r) => has(r, 'unpublished')).length,
  };
  const filter = opts.filter ?? 'all';
  const rows = filter === 'all' ? all : all.filter((r) => has(r, filter === 'stale' ? 'stale' : 'unpublished'));
  return { platforms, rows, counts, total: all.length };
}

export function getChapterCells(db: Db, chapterId: number): MatrixCell[] {
  const ch = db.select().from(chapter).where(eq(chapter.id, chapterId)).get();
  if (!ch) return [];
  const pubs = new Map(db.select().from(publication).where(eq(publication.chapterId, chapterId)).all().map((p) => [p.platformId, p]));
  return boundPlatforms(db, ch.novelId).map((pl) => makeCell(ch, pl, pubs.get(pl.id)));
}
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/matrix.test.ts` → PASS。同时跑 REQ-04 Task 2 的集成测试：`npx vitest run src/lib/stale.integration.test.ts` → PASS。

- [ ] **Step 5: 提交** —— `git add src/lib/matrix.* && git commit -m "feat(matrix): matrix query, badges, filters"`

---

### Task 4: Server Actions

**Files:**
- Create: `src/app/actions/platforms.ts`, `src/app/actions/publications.ts`

**Interfaces:**
- Produces（**名称固定**）：
  - `addPlatformAction(name)`, `renamePlatformAction(id, name)`, `deletePlatformAction(id)`
  - `bindPlatformAction(novelId, platformId, bookUrl)`, `unbindPlatformAction(novelId, platformId)`
  - `publicationAction(chapterId, platformId, action: PubAction): ActionResult<{ before: PubSnapshot; after: PubSnapshot }>`
  - `restorePublicationAction(chapterId, platformId, snapshot: PubSnapshot)`
  - `updatePublicationInfoAction(chapterId, platformId, patch)`

- [ ] **Step 1: 实现**

```ts
// src/app/actions/platforms.ts
'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { addPlatform, bindPlatform, deletePlatform, renamePlatform, unbindPlatform } from '@/lib/platforms';

const refresh = () => {
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/novels/[id]', 'page');
};

export async function addPlatformAction(name: string) {
  return wrap(() => { const p = addPlatform(getDb(), name); refresh(); return p; });
}
export async function renamePlatformAction(id: number, name: string) {
  return wrap(() => { const p = renamePlatform(getDb(), id, name); refresh(); return p; });
}
export async function deletePlatformAction(id: number) {
  return wrap(() => { deletePlatform(getDb(), id); refresh(); });
}
export async function bindPlatformAction(novelId: number, platformId: number, bookUrl: string | null) {
  return wrap(() => { bindPlatform(getDb(), novelId, platformId, bookUrl); refresh(); });
}
export async function unbindPlatformAction(novelId: number, platformId: number) {
  return wrap(() => { unbindPlatform(getDb(), novelId, platformId); refresh(); });
}
```

```ts
// src/app/actions/publications.ts
'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { applyPublicationAction, restorePublication, updatePublicationInfo, type PubAction, type PubSnapshot } from '@/lib/publications';

const refresh = () => {
  revalidatePath('/');
  revalidatePath('/novels/[id]', 'page');
  revalidatePath('/novels/[id]/chapters/[cid]', 'page');
};

export async function publicationAction(chapterId: number, platformId: number, action: PubAction) {
  return wrap(() => { const r = applyPublicationAction(getDb(), chapterId, platformId, action); refresh(); return r; });
}
export async function restorePublicationAction(chapterId: number, platformId: number, snapshot: PubSnapshot) {
  return wrap(() => { restorePublication(getDb(), chapterId, platformId, snapshot); refresh(); });
}
export async function updatePublicationInfoAction(
  chapterId: number,
  platformId: number,
  patch: { platformUrl?: string | null; publishedAt?: number | null },
) {
  return wrap(() => { const r = updatePublicationInfo(getDb(), chapterId, platformId, patch); refresh(); return r; });
}
```

- [ ] **Step 2: 类型检查并提交** —— `npx tsc --noEmit` 无错误；`git add src/app/actions && git commit -m "feat(platform): server actions"`

---

### Task 5: 设置页「发布平台」区

**Files:**
- Create: `src/app/settings/platforms-section.tsx`, `src/app/settings/platform-row.tsx`, `src/app/settings/add-platform-form.tsx`
- Modify: `src/app/settings/page.tsx`

- [ ] **Step 1: 行与表单**

```tsx
// src/app/settings/platform-row.tsx
'use client';
import { useState, useTransition } from 'react';
import { deletePlatformAction, renamePlatformAction } from '@/app/actions/platforms';
import { useNotice } from '@/components/notice';

export function PlatformRow({ id, name, builtin, boundNovels }: { id: number; name: string; builtin: boolean; boundNovels: number }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const rename = () =>
    start(async () => {
      const r = await renamePlatformAction(id, draft);
      if (!r.ok) return setError(r.error);
      setRenaming(false);
    });
  const remove = () =>
    start(async () => {
      const r = await deletePlatformAction(id);
      if (!r.ok) notify({ kind: 'error', text: r.error });
    });

  return (
    <li className="space-y-1 py-3">
      <div className="flex items-center gap-3">
        {renaming ? (
          <input className="rounded border px-2" value={draft} onChange={(e) => { setDraft(e.target.value); setError(''); }} />
        ) : (
          <span className="font-medium">{name}</span>
        )}
        {builtin && <span className="rounded bg-stone-100 px-2 text-xs text-stone-600">预置</span>}
        <span className="flex-1 text-xs text-stone-500">被 {boundNovels} 本小说绑定</span>
        {!builtin && !renaming && (
          <>
            <button className="rounded border px-3" onClick={() => setRenaming(true)}>重命名</button>
            <button className="rounded border px-3 text-red-700" disabled={pending} onClick={remove}>删除</button>
          </>
        )}
        {renaming && (
          <>
            <button className="rounded bg-stone-900 px-3 text-white" disabled={pending} onClick={rename}>保存</button>
            <button className="rounded border px-3" onClick={() => { setRenaming(false); setDraft(name); setError(''); }}>取消</button>
          </>
        )}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </li>
  );
}
```

```tsx
// src/app/settings/add-platform-form.tsx
'use client';
import { useState, useTransition } from 'react';
import { addPlatformAction } from '@/app/actions/platforms';

export function AddPlatformForm() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await addPlatformAction(value);
      if (!r.ok) return setError(r.error);
      setValue('');
    });
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input className="flex-1 rounded border px-3" placeholder="新增平台，如：晋江" value={value}
          onChange={(e) => { setValue(e.target.value); setError(''); }} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <button className="rounded bg-stone-900 px-4 text-white" disabled={pending} onClick={submit}>添加</button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: 区块并挂到设置页**

```tsx
// src/app/settings/platforms-section.tsx
import { getDb } from '@/db';
import { listPlatforms } from '@/lib/platforms';
import { AddPlatformForm } from './add-platform-form';
import { PlatformRow } from './platform-row';

export function PlatformsSection() {
  const platforms = listPlatforms(getDb());
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">发布平台</h2>
      <ul className="divide-y rounded border bg-white px-4">
        {platforms.map((p) => <PlatformRow key={p.id} id={p.id} name={p.name} builtin={p.builtin} boundNovels={p.boundNovels} />)}
      </ul>
      <AddPlatformForm />
    </section>
  );
}
```

修改 `src/app/settings/page.tsx`：把 `{/* REQ-03 在此追加 ... */}` 注释行替换为 `<PlatformsSection />`，并在文件顶部 `import { PlatformsSection } from './platforms-section';`（保留 REQ-05 的锚点注释：`{/* REQ-05 在此追加 <CopyFormatSection /> */}`）。

- [ ] **Step 3: 手动验证（AC3.1 / 3.2）**

`/settings`：番茄、起点带「预置」且无重命名/删除按钮；添加「晋江」成功；再添加「晋江 」→ 红字「平台已存在」；添加 21 字名称 → 「平台名称长度应为 1–20 个字」；重命名、删除自定义平台可用。

- [ ] **Step 4: 提交** —— `git add src/app/settings && git commit -m "feat(platform): settings platforms section"`

---

### Task 6: 发布操作条（详情页与编辑页共用）

**Files:**
- Create: `src/components/publication-actions.tsx`

**Interfaces:**
- Consumes: `publicationAction`、`restorePublicationAction`、`useNotice`、`OVERWRITE_WARNING`（`publish.ts`，客户端可用）。
- Produces: `<PublicationActions chapterId platformId platformName chapterLabel status fileMissing platformUrl editHref? onOptimistic?(next: PublishStatus | null) />`
  - `status` 为当前入库状态；文件丢失时仅当 `status !== 'unpublished'`（即存在有效发布状态）才提供「取消已发」。
  - 按钮集合（F3.12 / F3.17）：
    - `unpublished`：「标记审核中」`mark_pending`、「标记已发布」`mark_published`
    - `pending_review`：「标记已发布（审核通过）」`approve`、「取消」`cancel`
    - `published`：「取消已发」`cancel`、「重新提交（覆盖，进入审核中）」`resubmit`、「标记已发布（更新为当前版本）」`mark_published`、「编辑发布信息」（`editHref` 链接）、有 `platformUrl` 时「打开链接」（新窗口）；并显示 `OVERWRITE_WARNING`
    - `fileMissing`：仅 `cancel`（仅 `status !== 'unpublished'` 时），并显示「文件丢失的章节没有可对照的内容，不能标记已发。」
  - 成功后 `notify`；`cancel` 的提示条带「撤销」（调用 `restorePublicationAction(chapterId, platformId, before)`）；失败时 `notify({kind:'error'})` 并调用 `onOptimistic(null)` 回滚；调用前 `onOptimistic(expectedStatus)` 实现乐观更新；完成后 `router.refresh()`。

- [ ] **Step 1: 实现**

```tsx
// src/components/publication-actions.tsx
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { publicationAction, restorePublicationAction } from '@/app/actions/publications';
import { OVERWRITE_WARNING } from '@/lib/publish';
import type { PubAction } from '@/lib/publications';
import type { PublishStatus } from '@/lib/types';
import { useNotice } from './notice';

const EXPECTED: Record<PubAction, PublishStatus> = {
  mark_pending: 'pending_review', mark_published: 'published', approve: 'published', resubmit: 'pending_review', cancel: 'unpublished',
};
const DONE_TEXT: Record<PubAction, string> = {
  mark_pending: '已标记为审核中', mark_published: '已标记为已发布', approve: '已标记为审核通过（已发布）',
  resubmit: '已重新提交，进入审核中', cancel: '已取消发布状态',
};

interface Props {
  chapterId: number;
  platformId: number;
  platformName: string;
  chapterLabel: string; // 例：第3章
  status: PublishStatus;
  fileMissing: boolean;
  platformUrl: string | null;
  editHref?: string;
  onOptimistic?: (next: PublishStatus | null) => void;
}

export function PublicationActions(p: Props) {
  const router = useRouter();
  const { notify } = useNotice();
  const [pending, start] = useTransition();

  const run = (action: PubAction) =>
    start(async () => {
      p.onOptimistic?.(EXPECTED[action]);
      const r = await publicationAction(p.chapterId, p.platformId, action);
      if (!r.ok) {
        p.onOptimistic?.(null);
        return notify({ kind: 'error', text: r.error });
      }
      const text = `${p.chapterLabel} · ${p.platformName}：${DONE_TEXT[action]}`;
      if (action === 'cancel') {
        const before = r.data.before;
        notify({
          kind: 'success', text,
          undo: async () => {
            const u = await restorePublicationAction(p.chapterId, p.platformId, before);
            if (!u.ok) notify({ kind: 'error', text: u.error });
            router.refresh();
          },
        });
      } else {
        notify({ kind: 'success', text });
      }
      router.refresh();
    });

  const Btn = ({ action, label, danger }: { action: PubAction; label: string; danger?: boolean }) => (
    <button className={`rounded border px-3 text-sm ${danger ? 'text-red-700' : ''}`} disabled={pending} onClick={() => run(action)}>
      {label}
    </button>
  );

  if (p.fileMissing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-stone-600">文件丢失的章节没有可对照的内容，不能标记已发。</span>
        {p.status !== 'unpublished' && <Btn action="cancel" label="取消已发" danger />}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {p.status === 'unpublished' && (<><Btn action="mark_pending" label="标记审核中" /><Btn action="mark_published" label="标记已发布" /></>)}
      {p.status === 'pending_review' && (<><Btn action="approve" label="标记已发布（审核通过）" /><Btn action="cancel" label="取消" danger /></>)}
      {p.status === 'published' && (
        <>
          <Btn action="cancel" label="取消已发" danger />
          <Btn action="resubmit" label="重新提交（覆盖，进入审核中）" />
          <Btn action="mark_published" label="标记已发布（更新为当前版本）" />
          {p.editHref && <Link className="inline-flex min-h-[44px] items-center rounded border px-3 text-sm" href={p.editHref}>编辑发布信息</Link>}
          {p.platformUrl && (
            <a className="inline-flex min-h-[44px] items-center rounded border px-3 text-sm" href={p.platformUrl} target="_blank" rel="noreferrer">打开链接</a>
          )}
          <span className="text-xs text-amber-800">{OVERWRITE_WARNING}</span>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查并提交** —— `npx tsc --noEmit`；`git add src/components/publication-actions.tsx && git commit -m "feat(platform): publication action bar"`

---

### Task 7: 小说详情页（矩阵 + 管理平台 + 筛选）

**Files:**
- Create: `src/app/novels/[id]/page.tsx`, `src/components/matrix-table.tsx`, `src/components/matrix-toolbar.tsx`, `src/components/manage-platforms-panel.tsx`, `src/components/rescan-novel-button.tsx`

**Interfaces:**
- Consumes: `syncNovel`、`getMatrix`、`parseFilter`、`listBindings`、`listProblems`、`ProblemFiles`、`ChapterSubdirEditor`、`Badge`、`PublicationActions`、`rescanNovelAction`、`bindPlatformAction`、`unbindPlatformAction`。
- Produces: 路由 `/novels/[id]`；矩阵每行末尾的「操作」单元格留有 `{/* REQ-05: <CopyMenu/> */}` 锚点位置（REQ-05 方案给出 diff）。

- [ ] **Step 1: 页面（服务端）**

```tsx
// src/app/novels/[id]/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { novel } from '@/db/schema';
import { ChapterSubdirEditor } from '@/components/chapter-subdir-editor';
import { ManagePlatformsPanel } from '@/components/manage-platforms-panel';
import { MatrixTable } from '@/components/matrix-table';
import { MatrixToolbar } from '@/components/matrix-toolbar';
import { ProblemFiles } from '@/components/problem-files';
import { RescanNovelButton } from '@/components/rescan-novel-button';
import { listChapters, listProblems } from '@/lib/chapters';
import { getMatrix, parseFilter } from '@/lib/matrix';
import { listBindings } from '@/lib/platforms';
import { syncNovel } from '@/lib/sync';

export const dynamic = 'force-dynamic';

export default async function NovelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; platform?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const n = db.select().from(novel).where(eq(novel.id, Number(id))).get();
  if (!n) notFound();

  const sync = syncNovel(db, n.id); // F2.8：打开页面时同步
  const filter = parseFilter(sp.filter);
  const platformId = sp.platform ? Number(sp.platform) : null;
  const matrix = getMatrix(db, n.id, { filter, platformId });
  const bindings = listBindings(db, n.id);
  const problems = listProblems(db, n.id);
  const all = listChapters(db, n.id);
  const totalWords = all.filter((c) => !c.fileMissing).reduce((s, c) => s + c.wordCount, 0);
  const missing = all.filter((c) => c.fileMissing).length;

  return (
    <div className="space-y-4">
      <Link href="/" className="text-sm underline">← 看板</Link>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 space-y-1">
          <h1 className="font-serif text-2xl">{n.name}</h1>
          <div className="font-mono text-xs text-stone-500">
            {all.length} 章 · {totalWords} 字{missing > 0 && ` · 丢失 ${missing} 章`} · {n.dirPath}
          </div>
          <ChapterSubdirEditor novelId={n.id} value={n.chapterSubdir} />
          {sync.error && <p className="text-sm text-red-700">{sync.error}</p>}
        </div>
        <RescanNovelButton novelId={n.id} />
        <ManagePlatformsPanel
          novelId={n.id}
          defaultOpen={matrix.platforms.length === 0}
          bindings={bindings.map((b) => ({ id: b.platform.id, name: b.platform.name, bound: b.bound, bookUrl: b.bookUrl, publicationCount: b.publicationCount }))}
        />
      </div>

      <ProblemFiles problems={problems} />

      {all.length === 0 ? (
        <div className="rounded border bg-white p-8 text-center">
          <p className="font-medium">这本书还没有章节</p>
          <p className="text-sm text-stone-500">在章节目录中新建 <code>Ch01-标题.md</code>，再回到这里重新扫描</p>
        </div>
      ) : matrix.platforms.length === 0 ? (
        <div className="rounded border bg-white p-8 text-center">
          <p className="font-medium">请先绑定发布平台</p>
          <p className="text-sm text-stone-500">点击右上角「管理平台」勾选这本书在发的平台</p>
        </div>
      ) : (
        <>
          <MatrixToolbar
            novelId={n.id}
            filter={filter}
            platformId={platformId}
            counts={matrix.counts}
            shown={matrix.rows.length}
            total={matrix.total}
            platforms={matrix.platforms.map((p) => ({ id: p.id, name: p.name }))}
          />
          <MatrixTable novelId={n.id} platforms={matrix.platforms} rows={matrix.rows} filter={filter} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 工具栏（URL 即状态，F3.21）**

```tsx
// src/components/matrix-toolbar.tsx
'use client';
import { useRouter } from 'next/navigation';
import type { Filter } from '@/lib/matrix';

export function MatrixToolbar(p: {
  novelId: number;
  filter: Filter;
  platformId: number | null;
  counts: { all: number; stale: number; unpublished: number };
  shown: number;
  total: number;
  platforms: Array<{ id: number; name: string }>;
}) {
  const router = useRouter();
  const go = (filter: Filter, platformId: number | null) => {
    const q = new URLSearchParams();
    if (filter !== 'all') q.set('filter', filter);
    if (platformId) q.set('platform', String(platformId));
    const s = q.toString();
    router.replace(`/novels/${p.novelId}${s ? `?${s}` : ''}`);
  };
  const seg: Array<[Filter, string, number]> = [
    ['all', '全部', p.counts.all], ['stale', '只看需更新', p.counts.stale], ['unpublished', '只看未发布', p.counts.unpublished],
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div role="group" className="inline-flex overflow-hidden rounded border">
        {seg.map(([f, label, n]) => (
          <button key={f} aria-pressed={p.filter === f} onClick={() => go(f, p.platformId)}
            className={`px-3 text-sm ${p.filter === f ? 'bg-stone-900 text-white' : 'bg-white'}`}>
            {label} <span className="font-mono">{n}</span>
          </button>
        ))}
      </div>
      <select className="rounded border px-2 text-sm" value={p.platformId ?? ''} aria-label="限定平台"
        onChange={(e) => go(p.filter, e.target.value ? Number(e.target.value) : null)}>
        <option value="">全部平台</option>
        {p.platforms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <span className="ml-auto font-mono text-xs text-stone-600">显示 {p.shown} / 共 {p.total} 章</span>
    </div>
  );
}
```

- [ ] **Step 3: 矩阵表格（徽标点击展开操作条 + 乐观更新）**

```tsx
// src/components/matrix-table.tsx
'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import type { Filter, MatrixRow } from '@/lib/matrix';
import type { Badge as BadgeKind, PublishStatus } from '@/lib/types';
import { Badge } from './badge';
import { PublicationActions } from './publication-actions';

const BADGE_OF: Record<PublishStatus, BadgeKind> = { unpublished: 'unpublished', pending_review: 'pending_review', published: 'published' };

export function MatrixTable({
  novelId, platforms, rows, filter,
}: {
  novelId: number;
  platforms: Array<{ id: number; name: string; bookUrl: string | null }>;
  rows: MatrixRow[];
  filter: Filter;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // 乐观覆盖：key = `${chapterId}:${platformId}`，值为预期状态；失败时置 null 回滚
  const [override, setOverride] = useState<Record<string, PublishStatus | null>>({});
  // router.refresh() 带来新的 rows 后，由服务端数据接管，清除所有乐观覆盖
  useEffect(() => setOverride({}), [rows]);

  if (rows.length === 0) {
    return (
      <p className="rounded border bg-white p-6 text-center text-stone-600">
        {filter === 'stale' ? '所有已发章节都是最新的' : filter === 'unpublished' ? '没有未发布的章节' : '没有章节'}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-left">
          <tr>
            <th className="p-2">章号</th><th className="p-2">标题</th><th className="p-2 text-right">字数</th>
            {platforms.map((p) => (
              <th key={p.id} className="p-2">
                {p.bookUrl ? <a className="underline" href={p.bookUrl} target="_blank" rel="noreferrer">{p.name} ↗</a> : p.name}
              </th>
            ))}
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ chapter: ch, cells }) => {
            const openCell = cells.find((c) => open === `${ch.id}:${c.platformId}`);
            return (
              <Fragment key={ch.id}>
                <tr className="border-t">
                  <td className="p-2 font-mono">{ch.seq}</td>
                  <td className="p-2 font-serif">
                    {ch.fileMissing ? ch.title : <Link className="underline" href={`/novels/${novelId}/chapters/${ch.id}`}>{ch.title}</Link>}
                  </td>
                  <td className="p-2 text-right font-mono">{ch.fileMissing ? '—' : ch.wordCount}</td>
                  {cells.map((c) => {
                    const key = `${ch.id}:${c.platformId}`;
                    const ov = override[key];
                    const badge = ov ? BADGE_OF[ov] : c.badge;
                    const clickable = !(ch.fileMissing && c.status === 'unpublished');
                    return (
                      <td key={c.platformId} className="p-2">
                        <button disabled={!clickable} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                          <Badge kind={badge} title={c.hint} />
                        </button>
                      </td>
                    );
                  })}
                  <td className="p-2">
                    <div className="flex gap-2">
                      {/* REQ-05: <CopyMenu .../> 加在这里 */}
                      {!ch.fileMissing && (
                        <Link className="inline-flex min-h-[44px] items-center rounded border px-3" href={`/novels/${novelId}/chapters/${ch.id}`}>编辑</Link>
                      )}
                    </div>
                  </td>
                </tr>
                {openCell && (
                  <tr className="bg-stone-50">
                    <td colSpan={4 + platforms.length} className="p-3">
                      <div className="mb-1 text-xs text-stone-500">{openCell.platformName}</div>
                      <PublicationActions
                        chapterId={ch.id}
                        platformId={openCell.platformId}
                        platformName={openCell.platformName}
                        chapterLabel={`第${ch.seq}章`}
                        status={openCell.status}
                        fileMissing={ch.fileMissing}
                        platformUrl={openCell.platformUrl}
                        editHref={`/novels/${novelId}/chapters/${ch.id}`}
                        onOptimistic={(next) => setOverride((o) => ({ ...o, [`${ch.id}:${openCell.platformId}`]: next }))}
                      />
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

- [ ] **Step 4: 管理平台面板 + 重新扫描按钮**

```tsx
// src/components/manage-platforms-panel.tsx
'use client';
import { useState, useTransition } from 'react';
import { bindPlatformAction, unbindPlatformAction } from '@/app/actions/platforms';
import { useNotice } from './notice';

interface Item { id: number; name: string; bound: boolean; bookUrl: string | null; publicationCount: number }

export function ManagePlatformsPanel({ novelId, bindings, defaultOpen }: { novelId: number; bindings: Item[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="w-full sm:w-auto">
      <button className="rounded border px-4" aria-expanded={open} onClick={() => setOpen(!open)}>管理平台</button>
      {open && (
        <ul className="mt-2 w-full min-w-[320px] divide-y rounded border bg-white px-3">
          {bindings.map((b) => <Row key={b.id} novelId={novelId} item={b} />)}
        </ul>
      )}
    </div>
  );
}

function Row({ novelId, item }: { novelId: number; item: Item }) {
  const [url, setUrl] = useState(item.bookUrl ?? '');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const bind = (u: string) =>
    start(async () => {
      const r = await bindPlatformAction(novelId, item.id, u || null);
      if (!r.ok) return setError(r.error);
      notify({ kind: 'success', text: `已${item.bound ? '更新' : '绑定'} ${item.name}` });
    });
  const unbind = () =>
    start(async () => {
      const r = await unbindPlatformAction(novelId, item.id);
      if (!r.ok) return notify({ kind: 'error', text: r.error });
      setConfirming(false);
      notify({ kind: 'success', text: `已解绑 ${item.name}，发布记录已保留` });
    });

  return (
    <li className="space-y-2 py-3">
      <label className="flex items-center gap-2">
        <input type="checkbox" className="h-5 w-5" checked={item.bound} disabled={pending}
          onChange={(e) => {
            if (e.target.checked) bind(url);
            else if (item.publicationCount > 0) setConfirming(true);
            else unbind();
          }} />
        <span className="font-medium">{item.name}</span>
      </label>
      {item.bound && (
        <div className="flex gap-2">
          <input className="flex-1 rounded border px-2 text-sm" placeholder="作品主页链接（可选）" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(''); }} />
          <button className="rounded border px-3 text-sm" disabled={pending} onClick={() => bind(url)}>保存链接</button>
        </div>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {confirming && (
        <div className="flex items-center gap-3 rounded bg-amber-50 p-3 text-sm">
          <span className="flex-1">已有 {item.publicationCount} 条发布记录将被隐藏，重新绑定后恢复。</span>
          <button className="rounded bg-red-700 px-3 text-white" disabled={pending} onClick={unbind}>确认解绑</button>
          <button className="rounded border px-3" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
    </li>
  );
}
```

```tsx
// src/components/rescan-novel-button.tsx
'use client';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { rescanNovelAction } from '@/app/actions/library';
import { useNotice } from './notice';

export function RescanNovelButton({ novelId }: { novelId: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { notify } = useNotice();
  return (
    <button className="rounded border px-4" disabled={pending}
      onClick={() => start(async () => {
        const r = await rescanNovelAction(novelId);
        if (!r.ok) return notify({ kind: 'error', text: r.error });
        notify({ kind: 'success', text: `扫描完成：新增 ${r.data.added} 章、更新 ${r.data.updated} 章、${r.data.issues} 个文件无法识别` });
        router.refresh();
      })}>
      {pending ? '扫描中…' : '重新扫描'}
    </button>
  );
}
```

- [ ] **Step 5: 手动验证（AC3.3–3.10，在 `/tmp/nh-lib` 准备 3 章样稿）**

1. 未绑定任何平台 → 显示「请先绑定发布平台」，「管理平台」面板默认展开（AC3.10）。
2. 只勾选番茄 → 表格只有番茄一列（AC3.3）；填写 `book_url` 后列头出现 ↗。
3. 点某章番茄徽标 → 行下方展开操作条；点「标记已发布」→ 徽标变蓝「已发」；点「取消已发」→ 变回「未发」，提示条出现「撤销」，点后恢复（AC3.4/3.5）。
4. 解绑番茄（已有记录）→ 内联出现「已有 N 条发布记录将被隐藏，重新绑定后恢复。」；确认后列消失，重新绑定后徽标状态仍在（AC3.6）。
5. 点「只看未发布」→ URL 变为 `?filter=unpublished`，刷新后保持，右侧显示「显示 X / 共 Y 章」（AC3.7/3.8）。
6. 删除某章文件并点「重新扫描」→ 徽标显示红色虚线「文件丢失」，字数显示「—」，标题不可点击（AC3.9）。

- [ ] **Step 6: 提交** —— `git add src/app/novels src/components && git commit -m "feat(platform): novel detail page with publish matrix"`

---

### Task 8: 编辑页平台状态卡

**Files:**
- Create: `src/components/platform-cards.tsx`（服务端组件）、`src/components/platform-card.tsx`（客户端）
- Modify: `src/app/novels/[id]/chapters/[cid]/page.tsx`

**Interfaces:**
- Consumes: `getChapterCells`、`PublicationActions`、`updatePublicationInfoAction`、`Badge`。
- Produces: `<PlatformCards chapterId novelId />`。

- [ ] **Step 1: 客户端卡片（发布时间可改，链接可编辑）**

```tsx
// src/components/platform-card.tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { updatePublicationInfoAction } from '@/app/actions/publications';
import type { MatrixCell } from '@/lib/matrix';
import { Badge } from './badge';
import { useNotice } from './notice';
import { PublicationActions } from './publication-actions';

const toLocalInput = (ms: number | null) => {
  if (!ms) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

export function PlatformCard({ cell, chapterId, chapterLabel, fileMissing }: {
  cell: MatrixCell; chapterId: number; chapterLabel: string; fileMissing: boolean;
}) {
  const router = useRouter();
  const { notify } = useNotice();
  const [url, setUrl] = useState(cell.platformUrl ?? '');
  const [at, setAt] = useState(toLocalInput(cell.publishedAt));
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const patch: { platformUrl: string | null; publishedAt?: number | null } = { platformUrl: url || null };
      if (cell.status !== 'unpublished') patch.publishedAt = at ? new Date(at).getTime() : null;
      const r = await updatePublicationInfoAction(chapterId, cell.platformId, patch);
      if (!r.ok) return setError(r.error);
      notify({ kind: 'success', text: `已保存 ${cell.platformName} 发布信息` });
      router.refresh();
    });

  return (
    <section className="space-y-3 rounded border bg-white p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{cell.platformName}</h3>
        <Badge kind={cell.badge} title={cell.hint} />
      </div>
      {cell.hint && <p className="text-xs text-stone-600">{cell.hint}</p>}
      <PublicationActions
        chapterId={chapterId} platformId={cell.platformId} platformName={cell.platformName} chapterLabel={chapterLabel}
        status={cell.status} fileMissing={fileMissing} platformUrl={cell.platformUrl}
      />
      <div className="space-y-2 text-sm">
        {cell.status !== 'unpublished' && (
          <label className="block">发布时间
            <input type="datetime-local" className="mt-1 w-full rounded border px-2" value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
        )}
        <label className="block">章节链接
          <input className="mt-1 w-full rounded border px-2" placeholder="https://…" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(''); }} />
        </label>
        {error && <p className="text-red-700">{error}</p>}
        <button className="rounded border px-3" disabled={pending} onClick={save}>保存发布信息</button>
      </div>
    </section>
  );
}
```

```tsx
// src/components/platform-cards.tsx
import { getDb } from '@/db';
import { getChapterCells } from '@/lib/matrix';
import { PlatformCard } from './platform-card';

export function PlatformCards({ chapterId, seq, fileMissing }: { chapterId: number; seq: number; fileMissing: boolean }) {
  const cells = getChapterCells(getDb(), chapterId);
  if (cells.length === 0) return <p className="text-sm text-stone-500">这本书还没有绑定发布平台。</p>;
  return (
    <>
      {cells.map((c) => (
        <PlatformCard key={c.platformId} cell={c} chapterId={chapterId} chapterLabel={`第${seq}章`} fileMissing={fileMissing} />
      ))}
    </>
  );
}
```

- [ ] **Step 2: 挂到编辑页** —— 在 `src/app/novels/[id]/chapters/[cid]/page.tsx` 中，把 `aside={null /* REQ-03 在此传入 <PlatformCards /> */}` 替换为：

```tsx
aside={<PlatformCards chapterId={data.chapter.id} seq={data.chapter.seq} fileMissing={data.chapter.fileMissing} />}
```

并在文件顶部添加 `import { PlatformCards } from '@/components/platform-cards';`。

- [ ] **Step 3: 手动验证（F2.19 / F4.8）**

打开某章编辑页：右侧显示各已绑定平台的卡片。点「标记已发布」→ 徽标变「已发」；回到左侧改一个字并保存 → 保存成功后右侧自动变为「需更新」（无需手动刷新）；点「标记已发布（更新为当前版本）」→ 回到「已发」。未保存的改动不影响徽标。

- [ ] **Step 4: 提交** —— `git add src/components src/app/novels && git commit -m "feat(platform): platform status cards on editor page"`

---

## Self-Review

- 覆盖：F3.1–3.4（Task 1/5）、F3.5–3.8（Task 1/7）、F3.9–3.18（Task 2/3/6/7）、F3.19–3.23（Task 3/7，F3.23 由 REQ-04 `badgeHint` 提供）、§6 编辑页状态卡（Task 8）；AC3.1–3.10 均有单测或手动步骤。Q5（批量）保持不做，但 `applyPublicationAction` 单章签名不排斥批量。
- 乐观更新：`MatrixTable` 在收到新的 `rows`（`router.refresh()` 之后）时清空覆盖；失败路径由 `PublicationActions` 调用 `onOptimistic(null)` 回滚。
- 与其他方案的接口：REQ-05 在 `matrix-table.tsx` 的锚点处加入 `CopyMenu`；REQ-06 复用 `listBindings` 的绑定语义与 `deriveBadge` 的 SQL 等价实现。类型名称与 REQ-04 一致（`Badge`、`deriveBadge`、`badgeHint`）。
