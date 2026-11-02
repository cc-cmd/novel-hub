import type { Db } from '@/db';
import { UserError } from './result';

const BASE = 'https://fanqienovel.com';
const BOOK_PAGE = 50;
const CHAPTER_PAGE = 200;
const MAX_PAGES = 100;
const TIMEOUT_MS = 15_000;

export class PlatformAuthError extends UserError {
  constructor() { super('认证无效或已过期，请重新获取 Cookie 与 CSRF Token'); }
}
export class PlatformUnavailableError extends UserError {
  constructor() { super('番茄暂时无法访问，稍后重试'); }
}
export class PlatformFormatError extends UserError {
  constructor() { super('番茄返回格式无法识别，接口可能已变更'); }
}
export class PlatformApiError extends UserError {
  constructor(code: number) { super(`番茄接口返回错误（code=${code}）`); }
}

export interface RemoteChapter { itemId: string; title: string; wordNumber: number; displayStatus: number }
export interface FanqieClient {
  listBookIds(): Promise<string[]>;
  listChapters(bookId: string): Promise<RemoteChapter[]>;
  /** 返回线上正文 HTML；审核中读不到时返回 null */
  getChapterHtml(bookId: string, itemId: string): Promise<string | null>;
}
export type ClientFactory = (db: Db, platformId: number) => FanqieClient;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;

export function createFanqieClient(auth: { cookie: string; csrfToken: string }, fetchImpl: typeof fetch = fetch): FanqieClient {
  /** GET 调用。code=0 或在 okCodes 内返回 {code, data}；-1/未授权抛认证错误；其余抛 ApiError。 */
  async function call(path: string, params: Record<string, string | number>, okCodes: number[] = []) {
    const url = new URL(path, BASE);
    url.searchParams.set('aid', '2503');
    url.searchParams.set('app_name', 'muye_novel');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Cookie: auth.cookie, 'X-Secsdk-Csrf-Token': auth.csrfToken, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PlatformUnavailableError();
    }
    if (res.status === 401 || res.status === 403) throw new PlatformAuthError();
    if (!res.ok) throw new PlatformUnavailableError();
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new PlatformUnavailableError();
      throw new PlatformFormatError();
    }
    if (!isObj(json) || typeof json.code !== 'number') throw new PlatformFormatError();
    const code = json.code;
    if (code === -1 || (code !== 0 && /登录|未授权/.test(String(json.message ?? '')))) throw new PlatformAuthError();
    if (code !== 0 && !okCodes.includes(code)) throw new PlatformApiError(code);
    return { code, data: json.data };
  }

  const arrayAt = (data: unknown, key: string): Json[] => {
    const v = isObj(data) ? data[key] : undefined;
    if (!Array.isArray(v)) throw new PlatformFormatError();
    return v.filter(isObj);
  };

  /** 分页取全：仅以「本页没有新条目」为终止（番茄可能把 page_count 压到小于请求值，不能按「不足一页」判断），
   *  不依赖 page_index 是 0 起还是 1 起。到达 MAX_PAGES 仍未终止则报错，绝不返回被截断的列表。 */
  async function paged<T extends { key: string }>(
    fetchPage: (page: number) => Promise<T[]>,
  ): Promise<T[]> {
    const seen = new Set<string>();
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchPage(page);
      const fresh = rows.filter((r) => r.key && !seen.has(r.key));
      fresh.forEach((r) => seen.add(r.key));
      out.push(...fresh);
      if (fresh.length === 0) return out;
    }
    throw new PlatformFormatError();
  }

  return {
    async listBookIds() {
      const rows = await paged(async (page) => {
        const { data } = await call('/api/author/book/book_list/v0', { page_index: page, page_count: BOOK_PAGE });
        return arrayAt(data, 'book_list').map((b) => ({ key: String(b.book_id ?? '') }));
      });
      return rows.map((r) => r.key);
    },

    async listChapters(bookId) {
      const { data } = await call('/api/author/volume/volume_list/v1', { book_id: bookId });
      const volumes = arrayAt(data, 'volume_list').map((v) => String(v.volume_id ?? '')).filter(Boolean);
      const out: RemoteChapter[] = [];
      for (const volumeId of volumes) {
        const rows = await paged(async (page) => {
          const { data: d } = await call('/api/author/chapter/chapter_list/v1', {
            book_id: bookId, volume_id: volumeId, page_index: page, page_count: CHAPTER_PAGE,
          });
          return arrayAt(d, 'item_list').map((c) => ({
            key: String(c.item_id ?? ''),
            chapter: {
              itemId: String(c.item_id ?? ''),
              title: String(c.title ?? ''),
              wordNumber: Number(c.word_number) || 0,
              displayStatus: Number(c.display_status) || 0,
            } satisfies RemoteChapter,
          }));
        });
        out.push(...rows.map((r) => r.chapter));
      }
      return out;
    },

    async getChapterHtml(bookId, itemId) {
      const { code, data } = await call('/api/author/edit_article/v0/', { book_id: bookId, item_id: itemId, from_source: 0 }, [-2014]);
      if (code === -2014) return null;
      const d = isObj(data) ? data : {};
      const html = typeof d.content === 'string' ? d.content : isObj(d.article_info) && typeof d.article_info.content === 'string' ? d.article_info.content : null;
      if (html === null) throw new PlatformFormatError();
      return html;
    },
  };
}
