import { getDb } from '@/db';
import { getChapterCells } from '@/lib/matrix';
import { PlatformCard } from './platform-card';

export function PlatformCards({ chapterId, novelId }: { chapterId: number; novelId: number }) {
  const cells = getChapterCells(getDb(), chapterId);
  if (cells.length === 0) return <p className="text-sm text-stone-500">这本书还没有绑定发布平台。</p>;
  return (
    <>
      {cells.map((c) => (
        <PlatformCard key={`${c.platformId}:${c.status}:${c.publishedAt}:${c.platformUrl}:${c.configured}`} cell={c} chapterId={chapterId} novelId={novelId} />
      ))}
    </>
  );
}
