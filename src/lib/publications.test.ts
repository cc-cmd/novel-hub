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
