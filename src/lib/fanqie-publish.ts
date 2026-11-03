// 发布 / 覆盖章节到番茄（流程同 fanqie-publish 技能的 revise：plan → run）。
// 有平台章节 ID → 复用该 item_id 覆盖（章节回到审核中）；没有 → 新建草稿再发。
// 自动跳过：审核中、平台找不到该章节、目标分卷缺失且无法创建、文件不可读等，绝不硬发。

import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, platform, publication, type Chapter } from '@/db/schema';
import { listChapters } from './chapters';
import { PlatformApiError, PlatformAuthError, PlatformQuotaError, type FanqiePublisher, type RemoteChapter } from './fanqie-client';
import { readChapterFile } from './file-io';
import { contentHash } from './hash';
import { SYNC_PLATFORM } from './platforms';
import { buildPublishForm, countWords, syncedStatus, toPublishHtml } from './publish';
import { UserError } from './result';
import type { PublishStatus } from './types';
import { loadVolumeRules, matchRemoteVolume, parseVolumeRules, resolveVolume, type RemoteVolume } from './volumes';

const REVIEWING = 5; // chapter_list.display_status：审核中
const EMPTY_VOLUME = -4054; // 平台不允许同时存在两个无章节的分卷
export const PUBLISH_INTERVAL_MS = 3000;

export interface PlanRow {
  chapterId: number;
  seq: number;
  title: string; // 平台标题：第N章 标题
  wordCount: number;
  status: PublishStatus;
  mode: 'new' | 'overwrite';
  itemId: string | null;
  volumeName: string | null;
  createVolume: boolean;
  blocked: string | null;
}
export interface PublishPlan {
  rows: PlanRow[];
  usedToday: number;
  dailyLimit: number;
  useAi: number;
}

function context(db: Db, novelId: number, platformId: number) {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.name !== SYNC_PLATFORM) throw new UserError('该平台暂不支持自动发布');
  const link = db.select().from(novelPlatform)
    .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId))).get();
  if (!link?.bookId) throw new UserError('未填写有效的作品链接');
  if (!p.cookie || !p.csrfToken) throw new PlatformAuthError();
  return { p, link, bookId: link.bookId };
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 今日（本地时区）经本工具新发的字数。额度按账号计，覆盖不计入（技能实测）。 */
export function usedToday(db: Db, platformId: number, now: number): number {
  return db.select({ w: publication.quotaWords }).from(publication)
    .where(and(eq(publication.platformId, platformId), gte(publication.submittedAt, startOfDay(now))))
    .all()
    .reduce((s, r) => s + (r.w ?? 0), 0);
}

function readForm(ch: Chapter): { title: string; body: string } | string {
  if (ch.fileMissing) return '文件丢失';
  let r;
  try {
    r = readChapterFile(ch.filePath);
  } catch {
    return '文件无法读取';
  }
  if (!r.ok) return '编码不支持（不是 UTF-8）';
  return buildPublishForm(r.text, ch.seq, ch.title);
}

/** 列出「未发布 / 需更新」的章节及各自的发布方式与阻塞原因。只读，不改平台。 */
export async function planPublish(db: Db, novelId: number, platformId: number, client: FanqiePublisher, now = Date.now()): Promise<PublishPlan> {
  const { p, link, bookId } = context(db, novelId, platformId);
  const pubs = new Map(db.select().from(publication)
    .where(and(eq(publication.platformId, platformId), inArray(publication.chapterId, db.select({ id: chapter.id }).from(chapter).where(eq(chapter.novelId, novelId)))))
    .all().map((x) => [x.chapterId, x]));
  const remoteById = new Map<string, RemoteChapter>((await client.listChapters(bookId)).map((r) => [r.itemId, r]));
  const volumes = await client.listVolumes(bookId);
  const rules = loadVolumeRules(link.volumes);

  const rows: PlanRow[] = [];
  for (const ch of listChapters(db, novelId)) {
    const pub = pubs.get(ch.id);
    const status = syncedStatus(pub?.status);
    if (status === 'published' || ch.fileMissing) continue;
    const itemId = pub?.platformItemId ?? null;
    const form = readForm(ch);
    const row: PlanRow = {
      chapterId: ch.id, seq: ch.seq, title: typeof form === 'string' ? `第${ch.seq}章 ${ch.title}` : form.title,
      wordCount: typeof form === 'string' ? ch.wordCount : countWords(form.body),
      status, mode: itemId ? 'overwrite' : 'new', itemId, volumeName: null, createVolume: false, blocked: null,
    };
    const target = resolveVolume(ch.seq, rules, volumes);
    if (target.kind === 'ok') row.volumeName = target.volume.volumeName;
    if (target.kind === 'missing') { row.volumeName = target.name; row.createVolume = true; }
    const remote = itemId ? remoteById.get(itemId) : undefined;
    row.blocked =
      typeof form === 'string' ? form
      : ch.warning === 'h1_mismatch' ? 'H1 章号与文件序号不一致'
      : !form.body ? '正文为空'
      : itemId && !remote ? '平台上找不到该章节，请先重新扫描'
      : remote?.displayStatus === REVIEWING ? '审核中，暂不支持修改'
      : target.kind === 'blocked' ? target.reason
      : null;
    rows.push(row);
  }
  return { rows, usedToday: usedToday(db, platformId, now), dailyLimit: p.dailyWordLimit, useAi: p.useAi };
}

export type PublishOutcome = 'published' | 'skipped' | 'failed' | 'deferred';
export interface PublishResult { chapterId: number; seq: number; title: string; mode: PlanRow['mode']; outcome: PublishOutcome; message?: string }

export interface RunOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

/** 发布选中的章节（必须显式给出，不做隐式批量）。每章提交后立即落库，中断不丢状态。
 *  遇到额度上限、认证失效或其他接口错误即停止，剩余章节记为顺延 / 未执行。 */
export async function runPublish(
  db: Db, novelId: number, platformId: number, chapterIds: number[], client: FanqiePublisher, opts: RunOptions = {},
): Promise<PublishResult[]> {
  if (chapterIds.length === 0) throw new UserError('请选择要发布的章节');
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? PUBLISH_INTERVAL_MS;
  const { bookId } = context(db, novelId, platformId);
  const plan = await planPublish(db, novelId, platformId, client, now());
  const wanted = new Set(chapterIds);
  const rows = plan.rows.filter((r) => wanted.has(r.chapterId));
  if (rows.length === 0) throw new UserError('所选章节都已发布或不可发布，请刷新后重试');

  let volumes: RemoteVolume[] | null = null;
  let used = plan.usedToday;
  let stop: { outcome: PublishOutcome; message: string } | null = null;
  let submitted = 0;
  const results: PublishResult[] = [];
  for (const row of rows) {
    const base = { chapterId: row.chapterId, seq: row.seq, title: row.title, mode: row.mode };
    if (stop) { results.push({ ...base, ...stop }); continue; }
    if (row.blocked) { results.push({ ...base, outcome: 'skipped', message: row.blocked }); continue; }
    if (row.mode === 'new' && used + row.wordCount > plan.dailyLimit) {
      stop = { outcome: 'deferred', message: `今日额度不足（已用 ${used} / ${plan.dailyLimit} 字），顺延到明天` };
      results.push({ ...base, ...stop });
      continue;
    }
    try {
      volumes ??= await client.listVolumes(bookId);
      let volume = matchRemoteVolume(row.volumeName!, volumes);
      if (!volume && row.createVolume) {
        try {
          await client.addVolume(bookId, row.volumeName!);
        } catch (e) {
          if (e instanceof PlatformApiError && e.code === EMPTY_VOLUME) {
            results.push({ ...base, outcome: 'skipped', message: `分卷「${row.volumeName}」暂不能创建：平台不允许同时存在两个空卷，等上一卷有章节后再建` });
            continue;
          }
          throw e;
        }
        volumes = await client.listVolumes(bookId);
        volume = matchRemoteVolume(row.volumeName!, volumes);
      }
      if (!volume) { results.push({ ...base, outcome: 'skipped', message: `目标分卷「${row.volumeName}」不存在` }); continue; }

      const ch = db.select().from(chapter).where(eq(chapter.id, row.chapterId)).get()!;
      const r = readChapterFile(ch.filePath);
      if (!r.ok) { results.push({ ...base, outcome: 'skipped', message: '编码不支持（不是 UTF-8）' }); continue; }
      const form = buildPublishForm(r.text, ch.seq, ch.title);
      const words = countWords(form.body);
      if (submitted > 0 && interval > 0) await sleep(interval);
      const itemId = row.itemId ?? (await client.newDraft(bookId));
      await client.publishArticle({
        bookId, itemId, title: form.title, html: toPublishHtml(form.body),
        volumeId: volume.volumeId, volumeName: volume.volumeName, useAi: plan.useAi,
      });
      submitted++;
      const t = now();
      const quotaWords = row.mode === 'new' ? words : 0;
      const set = {
        status: 'published' as const, platformItemId: itemId, publishedAt: t, publishedHash: contentHash(r.text, ch.seq, ch.title),
        platformWordCount: words, submittedAt: t, quotaWords,
      };
      db.insert(publication).values({ chapterId: ch.id, platformId, ...set })
        .onConflictDoUpdate({ target: [publication.chapterId, publication.platformId], set }).run();
      used += quotaWords;
      results.push({ ...base, outcome: 'published' });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      const message = e instanceof PlatformQuotaError ? '今日提交字数已达番茄上限，顺延到明天' : e.message;
      stop = e instanceof PlatformQuotaError
        ? { outcome: 'deferred', message }
        : { outcome: 'skipped', message: '前一章失败，已停止' };
      results.push({ ...base, outcome: e instanceof PlatformQuotaError ? 'deferred' : 'failed', message });
    }
  }
  return results;
}

export function setPublishSettings(db: Db, platformId: number, input: { useAi: number; dailyWordLimit: number }): void {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.name !== SYNC_PLATFORM) throw new UserError('该平台暂不支持自动发布');
  if (input.useAi !== 1 && input.useAi !== 2) throw new UserError('AI 标记只能是 1（已使用 AI）或 2（未使用 / 其他）');
  if (!Number.isInteger(input.dailyWordLimit) || input.dailyWordLimit < 1000 || input.dailyWordLimit > 200000) {
    throw new UserError('每日字数上限应为 1000–200000 的整数');
  }
  db.update(platform).set({ useAi: input.useAi, dailyWordLimit: input.dailyWordLimit }).where(eq(platform.id, platformId)).run();
}

export function setVolumeRules(db: Db, novelId: number, platformId: number, text: string): void {
  const link = db.select().from(novelPlatform)
    .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId))).get();
  if (!link) throw new UserError('请先绑定该平台');
  const rules = parseVolumeRules(text);
  db.update(novelPlatform).set({ volumes: rules.length ? JSON.stringify(rules) : null })
    .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId))).run();
}
