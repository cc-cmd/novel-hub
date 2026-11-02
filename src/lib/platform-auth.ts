import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { novelPlatform, platform } from '@/db/schema';
import { parseFanqieBookId } from './fanqie-url';
import { createFanqieClient, PlatformAuthError, type ClientFactory, type FanqieClient } from './fanqie-client';
import { bindPlatform, SYNC_PLATFORM } from './platforms';
import { UserError } from './result';

export const clientForPlatform: ClientFactory = (db, platformId) => {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p?.cookie || !p.csrfToken) throw new PlatformAuthError();
  return createFanqieClient({ cookie: p.cookie, csrfToken: p.csrfToken });
};

export function authSummaryOf(p: { cookie: string | null }): string | null {
  return p.cookie ? `已配置 · 末4位 ${p.cookie.slice(-4)}` : null;
}

function syncPlatformOrThrow(db: Db, platformId: number) {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.name !== SYNC_PLATFORM) throw new UserError('该平台暂不支持自动校验');
  return p;
}

/** 校验通过才保存。校验方式：用该认证请求书列表接口。 */
export async function saveFanqieAuth(
  db: Db,
  platformId: number,
  input: { cookie: string; csrfToken: string },
  createClient: (auth: { cookie: string; csrfToken: string }) => FanqieClient = createFanqieClient,
): Promise<void> {
  syncPlatformOrThrow(db, platformId);
  const cookie = input.cookie.trim();
  const csrfToken = input.csrfToken.trim();
  if (!cookie || !csrfToken) throw new UserError('请填写 Cookie 和 X-Secsdk-Csrf-Token');
  if (/[\r\n]/.test(cookie) || /[\r\n]/.test(csrfToken)) throw new UserError('Cookie 与 CSRF Token 不能包含换行');
  await createClient({ cookie, csrfToken }).listBookIds();
  db.update(platform).set({ cookie, csrfToken }).where(eq(platform.id, platformId)).run();
  clearSyncErrors(db, platformId); // 认证已更新，旧的失败记录不再成立
}

function clearSyncErrors(db: Db, platformId: number): void {
  db.update(novelPlatform).set({ lastSyncError: null }).where(eq(novelPlatform.platformId, platformId)).run();
}

export function clearAuth(db: Db, platformId: number): void {
  syncPlatformOrThrow(db, platformId);
  db.update(platform).set({ cookie: null, csrfToken: null }).where(eq(platform.id, platformId)).run();
  clearSyncErrors(db, platformId);
}

/** 绑定 + 校验。番茄且已有认证时，额外校验作品归属（book_id 必须在账号书列表内）。 */
export async function bindPlatformChecked(
  db: Db,
  novelId: number,
  platformId: number,
  bookUrl: string | null,
  makeClient: ClientFactory = clientForPlatform,
): Promise<void> {
  const p = db.select().from(platform).where(eq(platform.id, platformId)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.name === SYNC_PLATFORM && bookUrl?.trim()) {
    const bookId = parseFanqieBookId(bookUrl); // 先做格式校验，避免无意义的网络请求
    if (p.cookie && p.csrfToken) {
      const ids = await makeClient(db, platformId).listBookIds();
      if (!ids.includes(bookId)) throw new UserError('该作品不在当前认证账号下');
    }
  }
  bindPlatform(db, novelId, platformId, bookUrl);
}
