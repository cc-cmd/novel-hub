import { getDb } from '@/db';
import { getChapterCells } from '@/lib/matrix';
import { PlatformCard } from './platform-card';

export function PlatformCards({ chapterId, seq, fileMissing }: { chapterId: number; seq: number; fileMissing: boolean }) {
  const cells = getChapterCells(getDb(), chapterId);
  if (cells.length === 0) return <p className="text-sm text-stone-500">这本书还没有绑定发布平台。</p>;
  return (
    <>
      {cells.map((c) => (
        <PlatformCard key={`${c.platformId}:${c.status}:${c.publishedAt}:${c.platformUrl}`} cell={c} chapterId={chapterId} chapterLabel={`第${seq}章`} fileMissing={fileMissing} />
      ))}
    </>
  );
}
