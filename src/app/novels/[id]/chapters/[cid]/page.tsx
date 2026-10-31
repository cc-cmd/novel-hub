import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { novel } from '@/db/schema';
import { loadChapterForEdit } from '@/lib/chapters';
import { platformTitle } from '@/lib/publish';
import { syncChapter } from '@/lib/sync';
import { ChapterEditor } from '@/components/chapter-editor';
import { PlatformCards } from '@/components/platform-cards';

export const dynamic = 'force-dynamic';

export default async function ChapterPage({ params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  const db = getDb();
  const novelId = Number(id);
  const chapterId = Number(cid);
  if (!Number.isInteger(novelId) || !Number.isInteger(chapterId)) notFound();

  try {
    syncChapter(db, chapterId); // F2.8：打开时保证库与磁盘一致
  } catch {
    notFound();
  }
  const data = loadChapterForEdit(db, chapterId);
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n || data.chapter.novelId !== novelId) notFound();

  return (
    <ChapterEditor
      novelId={n.id}
      novelName={n.name}
      chapterId={data.chapter.id}
      heading={platformTitle(data.chapter.seq, data.chapter.title)}
      filePath={data.chapter.filePath}
      initialContent={data.content}
      initialBaseHash={data.baseHash}
      fileMissing={data.chapter.fileMissing}
      readError={data.readError}
      seq={data.chapter.seq}
      fallbackTitle={data.chapter.title}
      aside={<PlatformCards chapterId={data.chapter.id} seq={data.chapter.seq} fileMissing={data.chapter.fileMissing} />}
    />
  );
}
