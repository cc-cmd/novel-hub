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
import { parsePositiveInt } from '@/lib/parse-id';
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
  const novelId = parsePositiveInt(id);
  if (novelId === null) notFound();
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n) notFound();

  const sync = syncNovel(db, n.id); // F2.8：打开页面时同步
  const filter = parseFilter(sp.filter);
  const platformId = parsePositiveInt(sp.platform);
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
