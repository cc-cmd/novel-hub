import Link from 'next/link';
import { getDb } from '@/db';
import { AddRootForm } from '@/components/add-root-form';
import { DashboardToolbar } from '@/components/dashboard-toolbar';
import { NovelCard } from '@/components/novel-card';
import { listRoots } from '@/lib/library';
import { getDashboard, parseSort } from '@/lib/stats';
import { scanAndSync } from '@/lib/sync';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ archived?: string; sort?: string }> }) {
  const sp = await searchParams;
  const db = getDb();

  // F6.1：进入页面先同步；失败不阻塞，展示库中已有数据 + 警告
  let syncWarnings: string[] = [];
  try {
    syncWarnings = scanAndSync(db).errors;
  } catch (e) {
    syncWarnings = [`同步失败：${(e as Error).message}`];
  }

  const roots = listRoots(db);
  const badRoots = roots.filter((r) => r.state !== 'ok');
  const sort = parseSort(sp.sort);
  const showArchived = sp.archived === '1';
  const dash = getDashboard(db, { showArchived, sort });

  if (roots.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4 py-16 text-center">
        <h1 className="font-serif text-2xl">先告诉我你的小说放在哪</h1>
        <p className="text-stone-600">添加一个目录，它下面的每个子目录会被识别为一本书。</p>
        <div className="text-left"><AddRootForm submitLabel="添加小说目录" /></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <DashboardToolbar novelCount={dash.novels.length} rootCount={dash.rootCount} showArchived={showArchived} sort={sort} />

      {(badRoots.length > 0 || syncWarnings.length > 0) && (
        <div role="alert" className="space-y-1 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {badRoots.map((r) => (
            <div key={r.id}>
              <span className="font-mono">{r.path}</span> {r.state === 'missing' ? '目录不存在' : '无读取权限'}，已有记录保留
            </div>
          ))}
          {syncWarnings.map((w) => <div key={w}>{w}</div>)}
          <Link href="/settings" className="underline">前往设置处理</Link>
        </div>
      )}

      {dash.novels.length === 0 ? (
        <div className="rounded border bg-white p-10 text-center">
          <h2 className="font-serif text-xl">未发现小说</h2>
          <p className="text-sm text-stone-600">未发现小说，请确认目录结构：根目录下每个子目录为一本书</p>
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(400px, 100%), 1fr))' }}>
          {dash.novels.map((s) => <NovelCard key={s.novel.id} s={s} />)}
        </div>
      )}
    </div>
  );
}
