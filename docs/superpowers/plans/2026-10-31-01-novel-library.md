# REQ-01 小说库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户配置一个或多个小说根目录，系统把每个一级子目录识别为一本小说入库；支持归档/取消归档、配置章节目录。

**Architecture:** 目录校验与枚举是 `src/lib/fs-scan.ts` 里的薄函数；根目录/小说的业务逻辑在 `src/lib/library.ts`（同步、接收 `db`）；Server Action 做转发；设置页「小说根目录」区与可复用的 `AddRootForm` 组件负责 UI。**本方案的 `scanLibrary` 只做「发现小说」，不同步章节**——章节同步（F1.8 的「同时触发章节同步」）由 REQ-02 方案的 `scanAndSync` 完成，并在 REQ-02 方案中把本方案的 Action 接线到同步。

**Tech Stack:** Node `fs`（同步 API）、drizzle-orm、Vitest。前置：基础设施方案（`2026-10-31-00-foundation.md`）已完成。

## Global Constraints

- `novel.dir_path` 全局唯一；小说身份 = `dir_path`。小说名 = 目录名。
- 只扫描根目录的**一级**子目录；忽略以 `.` 开头的目录与非目录项；根目录本身不算小说。
- 平台永远不创建/重命名/删除小说目录；归档只改 `archived`，不动磁盘。
- 扫描幂等；已存在的小说保留 `archived` 等用户设置；空目录也入库（0 章）。
- 目录不存在/无权限：保留已有记录，不自动删除、不自动归档。
- 路径校验文案（逐字）：`请输入目录的绝对路径` / `路径不存在：请使用绝对路径` / `路径不存在：{路径}` / `不是目录：{路径}` / `无读取权限：{路径}` / `该目录已添加，无需重复添加`。
- 移除根目录文案：`移除后其下小说保留记录，磁盘文件不受影响。`

---

### Task 1: 目录校验与枚举（`fs-scan.ts` 第一部分）

**Files:**
- Create: `src/lib/fs-scan.ts`
- Test: `src/lib/fs-scan.test.ts`

> REQ-02 方案会在同一个文件里追加文件名解析函数，本任务不要写它们。

**Interfaces:**
- Produces:
  - `normalizeRootPath(input: string): string` —— `trim` 后 `path.resolve`（去末尾斜杠、解析 `..`）
  - `validateDirPath(input: string): { ok: true; path: string } | { ok: false; error: string }`
  - `type DirState = 'ok' | 'missing' | 'denied'`；`checkDir(p: string): DirState`
  - `listSubdirs(root: string): string[]` —— 非隐藏一级子目录的绝对路径，按名称排序（含指向目录的符号链接）

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/fs-scan.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '@/test/helpers';
import { checkDir, listSubdirs, normalizeRootPath, validateDirPath } from './fs-scan';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const tmp = (files?: Record<string, string>) => {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('normalizeRootPath', () => {
  it('去末尾斜杠、解析 ..、trim', () => {
    expect(normalizeRootPath(' /a/b/ ')).toBe('/a/b');
    expect(normalizeRootPath('/a/b/../c')).toBe('/a/c');
  });
});

describe('validateDirPath', () => {
  it('空输入', () => {
    expect(validateDirPath('  ')).toEqual({ ok: false, error: '请输入目录的绝对路径' });
  });
  it('相对路径', () => {
    expect(validateDirPath('a/b')).toEqual({ ok: false, error: '路径不存在：请使用绝对路径' });
  });
  it('不存在', () => {
    expect(validateDirPath('/no/such/dir-xyz')).toEqual({ ok: false, error: '路径不存在：/no/such/dir-xyz' });
  });
  it('指向文件', () => {
    const d = tmp({ 'f.txt': 'x' });
    const f = path.join(d, 'f.txt');
    expect(validateDirPath(f)).toEqual({ ok: false, error: `不是目录：${f}` });
  });
  it('合法目录返回规范化路径', () => {
    const d = tmp();
    expect(validateDirPath(d + '/')).toEqual({ ok: true, path: d });
  });
  it('无读取权限', () => {
    const d = tmp({ 'sub/x.md': '' });
    const sub = path.join(d, 'sub');
    fs.chmodSync(sub, 0o000);
    try {
      // root 用户不受权限限制，跳过断言
      if (process.getuid?.() === 0) return;
      expect(validateDirPath(sub)).toEqual({ ok: false, error: `无读取权限：${sub}` });
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });
});

describe('checkDir / listSubdirs', () => {
  it('checkDir 区分 ok / missing', () => {
    const d = tmp();
    expect(checkDir(d)).toBe('ok');
    expect(checkDir(path.join(d, 'nope'))).toBe('missing');
  });
  it('listSubdirs 忽略隐藏项与文件，按名称排序', () => {
    const d = tmp({ 'b/x.md': '', 'a/x.md': '', '.git/HEAD': '', 'file.txt': '' });
    expect(listSubdirs(d)).toEqual([path.join(d, 'a'), path.join(d, 'b')]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/fs-scan.test.ts`
Expected: FAIL（`./fs-scan` 不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/fs-scan.ts
import fs from 'node:fs';
import path from 'node:path';

export function normalizeRootPath(input: string): string {
  return path.resolve(input.trim());
}

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

const isDenied = (e: unknown) => ['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '');

export function validateDirPath(input: string): PathCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: '请输入目录的绝对路径' };
  if (!path.isAbsolute(raw)) return { ok: false, error: '路径不存在：请使用绝对路径' };
  const p = normalizeRootPath(raw);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (e) {
    return { ok: false, error: isDenied(e) ? `无读取权限：${p}` : `路径不存在：${p}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `不是目录：${p}` };
  try {
    fs.readdirSync(p);
  } catch {
    return { ok: false, error: `无读取权限：${p}` };
  }
  return { ok: true, path: p };
}

export type DirState = 'ok' | 'missing' | 'denied';

export function checkDir(p: string): DirState {
  try {
    if (!fs.statSync(p).isDirectory()) return 'missing';
    fs.readdirSync(p);
    return 'ok';
  } catch (e) {
    return isDenied(e) ? 'denied' : 'missing';
  }
}

export function listSubdirs(root: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(root, ent.name);
    let isDir = ent.isDirectory();
    if (!isDir && ent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) out.push(full);
  }
  return out.sort();
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/fs-scan.test.ts` → Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/fs-scan.ts src/lib/fs-scan.test.ts
git commit -m "feat(library): directory validation and enumeration"
```

---

### Task 2: 小说库 service（根目录 / 扫描 / 归档 / 章节目录）

**Files:**
- Create: `src/lib/library.ts`
- Test: `src/lib/library.test.ts`

**Interfaces:**
- Consumes: `validateDirPath, checkDir, listSubdirs, normalizeRootPath`（Task 1）；`UserError`；表 `libraryRoot, novel`。
- Produces:
  - `addRoot(db, input: string): { id: number; path: string }` —— 失败抛 `UserError`（文案见 Global Constraints）
  - `removeRoot(db, id: number): void`
  - `listRoots(db): RootInfo[]`，`RootInfo = { id; path; state: DirState; novelCount: number }`
  - `scanLibrary(db): ScanSummary`，`ScanSummary = { newNovels: number; roots: Array<{ path: string; state: DirState }> }`
  - `setArchived(db, novelId: number, archived: boolean): Novel`
  - `setChapterSubdir(db, novelId: number, subdir: string): Novel` —— 规范化为相对路径；非法抛 `UserError`
  - `chapterDirOf(n: Pick<Novel,'dirPath'|'chapterSubdir'>): string`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/library.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { novel } from '@/db/schema';
import { makeDb, makeTmpDir } from '@/test/helpers';
import { UserError } from '@/lib/result';
import { addRoot, chapterDirOf, listRoots, removeRoot, scanLibrary, setArchived, setChapterSubdir } from './library';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function lib(files: Record<string, string>) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('addRoot', () => {
  it('AC1.5 不存在的路径被拒绝且不写库', () => {
    const db = makeDb();
    expect(() => addRoot(db, '/no/such/xyz')).toThrow(UserError);
    expect(listRoots(db)).toHaveLength(0);
  });
  it('AC1.6 规范化后重复被拒绝', () => {
    const db = makeDb();
    const d = lib({});
    addRoot(db, d);
    expect(() => addRoot(db, d + '/')).toThrow('该目录已添加，无需重复添加');
  });
});

describe('scanLibrary', () => {
  it('AC1.1/1.2/1.7 发现小说、新增、幂等', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '', 'B/x': '', 'C/x': '' });
    addRoot(db, d);
    expect(scanLibrary(db).newNovels).toBe(3);
    expect(db.select().from(novel).all().map((n) => n.name).sort()).toEqual(['A', 'B', 'C']);
    fs.mkdirSync(path.join(d, 'D'));
    expect(scanLibrary(db).newNovels).toBe(1);
    expect(scanLibrary(db).newNovels).toBe(0);
    expect(db.select().from(novel).all()).toHaveLength(4);
  });
  it('已有小说保留 archived 设置', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    setArchived(db, n.id, true);
    scanLibrary(db);
    expect(db.select().from(novel).get()!.archived).toBe(true);
  });
  it('AC1.4 目录消失 → 记录保留并标记 dirMissing', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    fs.rmSync(path.join(d, 'A'), { recursive: true });
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    expect(n.dirMissing).toBe(true);
    // 目录恢复后清除标记
    fs.mkdirSync(path.join(d, 'A'));
    scanLibrary(db);
    expect(db.select().from(novel).get()!.dirMissing).toBe(false);
  });
  it('根目录不可访问 → 其他根目录照常扫描，已有记录不动', () => {
    const db = makeDb();
    const a = lib({ 'A/x': '' });
    const b = lib({ 'B/x': '' });
    addRoot(db, a);
    addRoot(db, b);
    scanLibrary(db);
    fs.rmSync(a, { recursive: true });
    fs.mkdirSync(path.join(b, 'C'));
    const s = scanLibrary(db);
    expect(s.roots.find((r) => r.path === a)!.state).toBe('missing');
    expect(s.newNovels).toBe(1);
    expect(db.select().from(novel).all()).toHaveLength(3);
  });
});

describe('removeRoot', () => {
  it('F1.3 移除后小说保留并标记 rootRemoved', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    const { id } = addRoot(db, d);
    scanLibrary(db);
    removeRoot(db, id);
    const n = db.select().from(novel).get()!;
    expect(n.rootRemoved).toBe(true);
    expect(listRoots(db)).toHaveLength(0);
    expect(fs.existsSync(path.join(d, 'A'))).toBe(true);
  });
});

describe('setChapterSubdir', () => {
  it('规范化并保存；空串表示小说目录本身', () => {
    const db = makeDb();
    const d = lib({ 'A/改稿/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    expect(setChapterSubdir(db, n.id, ' 改稿/ ').chapterSubdir).toBe('改稿');
    expect(chapterDirOf(db.select().from(novel).get()!)).toBe(path.join(d, 'A', '改稿'));
    expect(setChapterSubdir(db, n.id, '').chapterSubdir).toBe('');
  });
  it('拒绝绝对路径、越界、不存在的目录', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    expect(() => setChapterSubdir(db, n.id, '/etc')).toThrow(UserError);
    expect(() => setChapterSubdir(db, n.id, '../B')).toThrow(UserError);
    expect(() => setChapterSubdir(db, n.id, '不存在')).toThrow('目录不存在');
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/library.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/library.ts
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { libraryRoot, novel, type Novel } from '@/db/schema';
import { UserError } from './result';
import { checkDir, listSubdirs, validateDirPath, type DirState } from './fs-scan';

export function chapterDirOf(n: Pick<Novel, 'dirPath' | 'chapterSubdir'>): string {
  return n.chapterSubdir ? path.join(n.dirPath, n.chapterSubdir) : n.dirPath;
}

export function addRoot(db: Db, input: string) {
  const v = validateDirPath(input);
  if (!v.ok) throw new UserError(v.error);
  const dup = db.select().from(libraryRoot).where(eq(libraryRoot.path, v.path)).get();
  if (dup) throw new UserError('该目录已添加，无需重复添加');
  const row = db.insert(libraryRoot).values({ path: v.path }).returning().get();
  return { id: row.id, path: row.path };
}

export function removeRoot(db: Db, id: number): void {
  db.delete(libraryRoot).where(eq(libraryRoot.id, id)).run();
  refreshNovelFlags(db);
}

export interface RootInfo {
  id: number;
  path: string;
  state: DirState;
  novelCount: number;
}

export function listRoots(db: Db): RootInfo[] {
  const novels = db.select({ dirPath: novel.dirPath }).from(novel).all();
  return db
    .select()
    .from(libraryRoot)
    .orderBy(libraryRoot.id)
    .all()
    .map((r) => ({
      id: r.id,
      path: r.path,
      state: checkDir(r.path),
      novelCount: novels.filter((n) => path.dirname(n.dirPath) === r.path).length,
    }));
}

/** 重新计算每本小说的 dirMissing / rootRemoved。只在值变化时写库。 */
export function refreshNovelFlags(db: Db): void {
  const roots = new Set(db.select().from(libraryRoot).all().map((r) => r.path));
  for (const n of db.select().from(novel).all()) {
    const dirMissing = checkDir(n.dirPath) === 'missing';
    const rootRemoved = !roots.has(path.dirname(n.dirPath));
    if (dirMissing !== n.dirMissing || rootRemoved !== n.rootRemoved) {
      db.update(novel).set({ dirMissing, rootRemoved }).where(eq(novel.id, n.id)).run();
    }
  }
}

export interface ScanSummary {
  newNovels: number;
  roots: Array<{ path: string; state: DirState }>;
}

/** 只发现小说，不同步章节（章节同步见 REQ-02 的 scanAndSync）。幂等。 */
export function scanLibrary(db: Db): ScanSummary {
  const summary: ScanSummary = { newNovels: 0, roots: [] };
  for (const root of db.select().from(libraryRoot).orderBy(libraryRoot.id).all()) {
    const state = checkDir(root.path);
    summary.roots.push({ path: root.path, state });
    if (state !== 'ok') continue;
    for (const dir of listSubdirs(root.path)) {
      const exists = db.select({ id: novel.id }).from(novel).where(eq(novel.dirPath, dir)).get();
      if (exists) continue;
      db.insert(novel).values({ name: path.basename(dir), dirPath: dir }).run();
      summary.newNovels++;
    }
  }
  refreshNovelFlags(db);
  return summary;
}

export function setArchived(db: Db, novelId: number, archived: boolean): Novel {
  return db.update(novel).set({ archived }).where(eq(novel.id, novelId)).returning().get();
}

export function setChapterSubdir(db: Db, novelId: number, subdir: string): Novel {
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n) throw new UserError('小说不存在');
  let rel = subdir.trim();
  if (rel) {
    if (path.isAbsolute(rel)) throw new UserError('章节目录必须是小说目录内的相对路径');
    rel = path.normalize(rel).replace(/[\\/]+$/, '');
    if (rel === '..' || rel.startsWith('..' + path.sep)) throw new UserError('章节目录必须是小说目录内的相对路径');
    if (rel === '.') rel = '';
  }
  if (rel) {
    const full = path.join(n.dirPath, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new UserError(`目录不存在：${full}`);
  }
  return db.update(novel).set({ chapterSubdir: rel }).where(eq(novel.id, novelId)).returning().get();
}
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/library.test.ts` → PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/library.ts src/lib/library.test.ts
git commit -m "feat(library): roots, discovery scan, archive, chapter subdir"
```

---

### Task 3: Server Actions

**Files:**
- Create: `src/app/actions/library.ts`

**Interfaces:**
- Consumes: `getDb`、Task 2 全部函数、`wrap`。
- Produces（供 UI 与 REQ-02/06 使用，**名称固定**）：
  - `addRootAction(input: string): Promise<ActionResult<{ id: number; path: string }>>`
  - `removeRootAction(id: number): Promise<ActionResult>`
  - `rescanAction(): Promise<ActionResult<ScanSummary>>` —— REQ-02 方案会把函数体改为 `scanAndSync`
  - `setArchivedAction(novelId: number, archived: boolean): Promise<ActionResult<{ name: string }>>` —— REQ-02 方案在取消归档时追加 `syncNovel`
  - `setChapterSubdirAction(novelId: number, subdir: string): Promise<ActionResult>` —— REQ-02 方案追加 `syncNovel`

- [ ] **Step 1: 实现**

```ts
// src/app/actions/library.ts
'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { addRoot, removeRoot, scanLibrary, setArchived, setChapterSubdir } from '@/lib/library';

function refresh() {
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/novels/[id]', 'page');
}

export async function addRootAction(input: string) {
  return wrap(() => {
    const r = addRoot(getDb(), input);
    refresh();
    return r;
  });
}

export async function removeRootAction(id: number) {
  return wrap(() => {
    removeRoot(getDb(), id);
    refresh();
  });
}

export async function rescanAction() {
  return wrap(() => {
    const s = scanLibrary(getDb());
    refresh();
    return s;
  });
}

export async function setArchivedAction(novelId: number, archived: boolean) {
  return wrap(() => {
    const n = setArchived(getDb(), novelId, archived);
    refresh();
    return { name: n.name };
  });
}

export async function setChapterSubdirAction(novelId: number, subdir: string) {
  return wrap(() => {
    setChapterSubdir(getDb(), novelId, subdir);
    refresh();
  });
}
```

- [ ] **Step 2: 类型检查并提交**

Run: `npx tsc --noEmit` → Expected: 无错误。

```bash
git add src/app/actions/library.ts
git commit -m "feat(library): server actions"
```

---

### Task 4: 添加目录表单 + 设置页「小说根目录」区

**Files:**
- Create: `src/components/add-root-form.tsx`, `src/app/settings/roots-section.tsx`, `src/app/settings/root-row.tsx`, `src/app/settings/page.tsx`

**Interfaces:**
- Consumes: Task 3 的 Action；`useNotice`。
- Produces:
  - `<AddRootForm submitLabel: string; onSuccess?: (path: string) => void | Promise<void> />` —— REQ-06 看板的「添加小说目录」面板复用它（`submitLabel="添加并扫描"`，`onSuccess` 里调用 `rescanAction`）；设置页使用 `submitLabel="添加"`。
  - `src/app/settings/page.tsx` 导出默认页面，**章节顺序固定**：小说根目录 → 发布平台（REQ-03 追加）→ 复制格式（REQ-05 追加）。

- [ ] **Step 1: 表单组件**

```tsx
// src/components/add-root-form.tsx
'use client';
import { useState, useTransition } from 'react';
import { addRootAction } from '@/app/actions/library';

export function AddRootForm({
  submitLabel,
  onSuccess,
  onCancel,
}: {
  submitLabel: string;
  onSuccess?: (path: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const r = await addRootAction(value);
      if (!r.ok) return setError(r.error);
      setValue('');
      await onSuccess?.(r.data.path);
    });

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border px-3 font-mono text-sm"
          placeholder="/Users/me/小说"
          value={value}
          aria-invalid={!!error}
          onChange={(e) => { setValue(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="rounded bg-stone-900 px-4 text-white disabled:opacity-50" disabled={pending} onClick={submit}>
          {pending ? '处理中…' : submitLabel}
        </button>
        {onCancel && <button className="rounded border px-4" onClick={onCancel}>取消</button>}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: 根目录列表行（内联确认移除）**

```tsx
// src/app/settings/root-row.tsx
'use client';
import { useState, useTransition } from 'react';
import { removeRootAction } from '@/app/actions/library';
import { useNotice } from '@/components/notice';
import type { RootInfo } from '@/lib/library';

const STATE_TEXT = (r: RootInfo) =>
  r.state === 'ok'
    ? `正常 · 已识别 ${r.novelCount} 本小说`
    : r.state === 'missing'
      ? '目录不存在 · 已有记录保留'
      : '无读取权限 · 已有记录保留';

export function RootRow({ root }: { root: RootInfo }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const remove = () =>
    start(async () => {
      const r = await removeRootAction(root.id);
      if (!r.ok) return notify({ kind: 'error', text: r.error });
      notify({ kind: 'success', text: `已移除 ${root.path}，磁盘文件未改动` });
    });

  return (
    <li className="space-y-2 py-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-mono text-sm">{root.path}</div>
          <div className={`text-xs ${root.state === 'ok' ? 'text-stone-500' : 'text-red-700'}`}>{STATE_TEXT(root)}</div>
        </div>
        {!confirming && <button className="rounded border px-3" onClick={() => setConfirming(true)}>移除</button>}
      </div>
      {confirming && (
        <div className="flex items-center gap-3 rounded bg-amber-50 p-3 text-sm">
          <span className="flex-1">移除后其下小说保留记录，磁盘文件不受影响。</span>
          <button className="rounded bg-red-700 px-3 text-white" disabled={pending} onClick={remove}>确认移除</button>
          <button className="rounded border px-3" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
    </li>
  );
}
```

- [ ] **Step 3: 区块与页面**

```tsx
// src/app/settings/roots-section.tsx
import { getDb } from '@/db';
import { listRoots } from '@/lib/library';
import { AddRootForm } from '@/components/add-root-form';
import { RootRow } from './root-row';

export function RootsSection() {
  const roots = listRoots(getDb());
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">小说根目录</h2>
      {roots.length === 0 && <p className="text-sm text-stone-500">还没有根目录。根目录下的每个子目录会被识别为一本小说。</p>}
      <ul className="divide-y rounded border bg-white px-4">
        {roots.map((r) => <RootRow key={r.id} root={r} />)}
      </ul>
      <AddRootForm submitLabel="添加" />
    </section>
  );
}
```

```tsx
// src/app/settings/page.tsx
import { RootsSection } from './roots-section';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <div className="space-y-10">
      <h1 className="font-serif text-2xl">设置</h1>
      <RootsSection />
      {/* REQ-03 在此追加 <PlatformsSection />；REQ-05 在此追加 <CopyFormatSection /> */}
    </div>
  );
}
```

> 上面注释是给后续方案的**锚点**，对应的修改在 REQ-03/REQ-05 方案里有明确 diff，本方案不遗留未实现内容。

- [ ] **Step 4: 手动验证（对应 AC1.1/1.5/1.6）**

```bash
mkdir -p /tmp/nh-lib/书A /tmp/nh-lib/书B && npm run dev
```

打开 `http://localhost:3000/settings`：
1. 输入 `abc` → 红字「路径不存在：请使用绝对路径」；输入框修改后红字消失。
2. 输入 `/tmp/nh-lib/` → 添加成功，行显示「正常 · 已识别 0 本小说」（此时尚未扫描，REQ-02/06 完成后会刷新为 2）。
3. 再次添加 `/tmp/nh-lib` → 「该目录已添加，无需重复添加」。
4. 点「移除」→ 行内展开确认文案 → 「取消」收起；「确认移除」后提示条出现。

- [ ] **Step 5: 提交**

```bash
git add src/components/add-root-form.tsx src/app/settings
git commit -m "feat(library): settings page roots section"
```

---

### Task 5: 章节目录编辑器组件（供 REQ-03 的详情页挂载）

**Files:**
- Create: `src/components/chapter-subdir-editor.tsx`

**Interfaces:**
- Produces: `<ChapterSubdirEditor novelId: number; value: string />` —— 显示「章节目录：改稿/ [修改]」，点击「修改」就地变为输入框 +「保存并同步」；留空表示小说目录本身。保存调用 `setChapterSubdirAction`，成功后 `notify` 并 `router.refresh()`。

- [ ] **Step 1: 实现**

```tsx
// src/components/chapter-subdir-editor.tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setChapterSubdirAction } from '@/app/actions/library';
import { useNotice } from './notice';

export function ChapterSubdirEditor({ novelId, value }: { novelId: number; value: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();
  const { notify } = useNotice();

  const save = () =>
    start(async () => {
      const r = await setChapterSubdirAction(novelId, draft);
      if (!r.ok) return setError(r.error);
      setEditing(false);
      notify({ kind: 'success', text: '章节目录已更新并同步' });
      router.refresh();
    });

  if (!editing) {
    return (
      <span className="text-sm text-stone-600">
        章节目录：<span className="font-mono">{value ? `${value}/` : '（小说目录本身）'}</span>{' '}
        <button className="underline" onClick={() => { setDraft(value); setEditing(true); }}>修改</button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex gap-2">
        <input
          className="rounded border px-2 font-mono text-sm"
          value={draft}
          placeholder="留空 = 小说目录本身，例如：改稿"
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
        />
        <button className="rounded bg-stone-900 px-3 text-white" disabled={pending} onClick={save}>保存并同步</button>
        <button className="rounded border px-3" onClick={() => setEditing(false)}>取消</button>
      </span>
      {error && <span className="text-sm text-red-700">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 2: 类型检查并提交**

Run: `npx tsc --noEmit` → 无错误。

```bash
git add src/components/chapter-subdir-editor.tsx
git commit -m "feat(library): chapter subdir inline editor"
```

---

## Self-Review

- 覆盖：F1.1/1.2（Task 1–2）、F1.3（removeRoot + rootRemoved）、F1.4–1.7（scanLibrary + refreshNovelFlags）、F1.9（setArchived）、F1.11（setChapterSubdir + 编辑器）、§6 设置页根目录区（Task 4）、AC1.1–1.7（单测覆盖 1.1/1.2/1.4/1.5/1.6/1.7，1.3 的看板隐藏由 REQ-06 完成，磁盘无变化由 `setArchived` 只写库保证）。
- **移交给其他方案的项**（均在对应方案有明确任务）：F1.8 章节同步与「归档小说不参与同步」(F1.10)、取消归档/改章节目录后立即同步 → REQ-02 Task 7；看板入口 / 卡片菜单 / 标签 / 已归档显示 → REQ-06；详情页挂载 `ChapterSubdirEditor` → REQ-03。
- 无占位内容；函数名与基础契约一致（`UserError`/`wrap`/`Db`）。
