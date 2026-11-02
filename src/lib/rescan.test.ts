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
