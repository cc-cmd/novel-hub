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
