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
