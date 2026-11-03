import { describe, expect, it } from 'vitest';
import {
  createFanqieClient, PlatformApiError, PlatformAuthError, PlatformFormatError, PlatformQuotaError, PlatformUnavailableError,
} from './fanqie-client';

const AUTH = { cookie: 'sessionid=SECRET-COOKIE', csrfToken: 'SECRET-CSRF' };
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'ok', data }));
const body = (code: number, data: unknown = {}, message = '') => new Response(JSON.stringify({ code, message, data }));

/** 路由表：键为 URL path，值为 (URL) => Response。记录每次请求。 */
function fakeFetch(routes: Record<string, (u: URL) => Response>) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected ${url.pathname}`);
    return route(url);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('listBookIds', () => {
  it('解析 book_id，并带上鉴权头与公共参数', async () => {
    const { f, calls } = fakeFetch({ '/api/author/book/book_list/v0': () => ok({ book_list: [{ book_id: 111 }, { book_id: '222' }] }) });
    const ids = await createFanqieClient(AUTH, f).listBookIds();
    expect(ids).toEqual(['111', '222']);
    expect(calls[0].headers.get('cookie')).toBe(AUTH.cookie);
    expect(calls[0].headers.get('x-secsdk-csrf-token')).toBe(AUTH.csrfToken);
    expect(calls[0].url.searchParams.get('aid')).toBe('2503');
    expect(calls[0].url.searchParams.get('app_name')).toBe('muye_novel');
  });

  it('多页：用去重后无新条目作为终止条件', async () => {
    const pages: Record<string, Array<{ book_id: string }>> = {
      '0': Array.from({ length: 50 }, (_, i) => ({ book_id: `a${i}` })),
      '1': [{ book_id: 'b1' }],
    };
    const { f } = fakeFetch({ '/api/author/book/book_list/v0': (u) => ok({ book_list: pages[u.searchParams.get('page_index')!] ?? [] }) });
    const ids = await createFanqieClient(AUTH, f).listBookIds();
    expect(ids).toHaveLength(51);
  });
});

describe('分页完整性', () => {
  const item = (id: string) => ({ item_id: id, title: id, word_number: 1, display_status: 1 });

  it('服务端把每页上限压到 100（小于请求的 200）时仍取全 250 章', async () => {
    const all = Array.from({ length: 250 }, (_, i) => item(`i${i}`));
    const { f } = fakeFetch({
      '/api/author/volume/volume_list/v1': () => ok({ volume_list: [{ volume_id: 'v1' }] }),
      '/api/author/chapter/chapter_list/v1': (u) => {
        const p = Number(u.searchParams.get('page_index'));
        return ok({ item_list: all.slice(p * 100, p * 100 + 100) });
      },
    });
    expect(await createFanqieClient(AUTH, f).listChapters('B')).toHaveLength(250);
  });

  it('永远有新条目（到达页数上限）→ PlatformFormatError，而不是返回截断列表', async () => {
    const { f } = fakeFetch({
      '/api/author/book/book_list/v0': (u) => ok({ book_list: [{ book_id: `p${u.searchParams.get('page_index')}` }] }),
    });
    await expect(createFanqieClient(AUTH, f).listBookIds()).rejects.toBeInstanceOf(PlatformFormatError);
  });
});

describe('读取响应体', () => {
  const withJson = (json: () => Promise<unknown>) =>
    (async () => ({ ok: true, status: 200, json }) as unknown as Response) as unknown as typeof fetch;

  it('读 body 时超时/中止 → PlatformUnavailableError', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const f = withJson(async () => { throw new DOMException('x', name); });
      await expect(createFanqieClient(AUTH, f).listBookIds()).rejects.toBeInstanceOf(PlatformUnavailableError);
    }
  });

  it('JSON 解析失败 → PlatformFormatError', async () => {
    const f = withJson(async () => JSON.parse('<html>'));
    await expect(createFanqieClient(AUTH, f).listBookIds()).rejects.toBeInstanceOf(PlatformFormatError);
  });
});

describe('错误分类', () => {
  const run = (resp: () => Response) =>
    createFanqieClient(AUTH, fakeFetch({ '/api/author/book/book_list/v0': resp }).f).listBookIds();

  it('code=-1 / HTTP 401 → PlatformAuthError', async () => {
    await expect(run(() => body(-1, null, '未授权'))).rejects.toBeInstanceOf(PlatformAuthError);
    await expect(run(() => new Response('', { status: 401 }))).rejects.toBeInstanceOf(PlatformAuthError);
  });
  it('HTTP 500 / 抛网络错误 → PlatformUnavailableError', async () => {
    await expect(run(() => new Response('', { status: 500 }))).rejects.toBeInstanceOf(PlatformUnavailableError);
    const f = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(createFanqieClient(AUTH, f).listBookIds()).rejects.toBeInstanceOf(PlatformUnavailableError);
  });
  it('非 JSON / 缺 code / 缺 book_list → PlatformFormatError', async () => {
    await expect(run(() => new Response('<html>'))).rejects.toBeInstanceOf(PlatformFormatError);
    await expect(run(() => new Response('{"hello":1}'))).rejects.toBeInstanceOf(PlatformFormatError);
    await expect(run(() => ok({}))).rejects.toBeInstanceOf(PlatformFormatError);
  });
  it('其他非 0 code → PlatformApiError，文案含 code', async () => {
    await expect(run(() => body(-9999))).rejects.toThrow('code=-9999');
    await expect(run(() => body(-9999))).rejects.toBeInstanceOf(PlatformApiError);
  });
  it('AC7.14 错误文案不含认证信息', async () => {
    for (const resp of [() => body(-1), () => new Response('', { status: 500 }), () => body(-1019), () => new Response('x')]) {
      const e = (await run(resp).catch((x) => x as Error)) as Error;
      expect(e.message).not.toContain('SECRET');
    }
  });
});

describe('listChapters', () => {
  const item = (id: string, title: string, w: number, s = 1) => ({ item_id: id, title, word_number: w, display_status: s });

  it('遍历分卷与分页并去重', async () => {
    const all = Array.from({ length: 250 }, (_, i) => item(`i${i}`, `第${i + 1}章 t`, 10));
    const { f } = fakeFetch({
      '/api/author/volume/volume_list/v1': () => ok({ volume_list: [{ volume_id: 'v1' }, { volume_id: 'v2' }] }),
      '/api/author/chapter/chapter_list/v1': (u) => {
        if (u.searchParams.get('volume_id') === 'v2') return ok({ item_list: [item('x1', '第251章 t', 5, 5)] });
        const p = Number(u.searchParams.get('page_index'));
        return ok({ item_list: all.slice(p * 200, p * 200 + 200) });
      },
    });
    const list = await createFanqieClient(AUTH, f).listChapters('B');
    expect(list).toHaveLength(251);
    expect(list.at(-1)).toEqual({ itemId: 'x1', title: '第251章 t', wordNumber: 5, displayStatus: 5 });
  });

  it('无分卷 → 空数组', async () => {
    const { f } = fakeFetch({ '/api/author/volume/volume_list/v1': () => ok({ volume_list: [] }) });
    expect(await createFanqieClient(AUTH, f).listChapters('B')).toEqual([]);
  });
});

describe('getChapterHtml', () => {
  it('返回正文 HTML；-2014（审核中）→ null；缺 content → PlatformFormatError', async () => {
    const mk = (resp: () => Response) =>
      createFanqieClient(AUTH, fakeFetch({ '/api/author/edit_article/v0/': resp }).f).getChapterHtml('B', 'I');
    expect(await mk(() => ok({ content: '<p>你好</p>' }))).toBe('<p>你好</p>');
    expect(await mk(() => ok({ article_info: { content: '<p>兜底</p>' } }))).toBe('<p>兜底</p>');
    expect(await mk(() => body(-2014, null, '审核中'))).toBeNull();
    await expect(mk(() => ok({}))).rejects.toBeInstanceOf(PlatformFormatError);
  });
});

describe('写接口', () => {
  function postFetch(respond: (path: string, form: URLSearchParams) => Response) {
    const calls: Array<{ path: string; method: string; form: URLSearchParams; headers: Headers }> = [];
    const f = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const form = new URLSearchParams(init?.method === 'POST' ? String(init.body) : url.search);
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', form, headers: new Headers(init?.headers) });
      return respond(url.pathname, form);
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('publishArticle：POST 表单编码，参数与技能一致', async () => {
    const { f, calls } = postFetch(() => ok({}));
    await createFanqieClient(AUTH, f).publishArticle({ bookId: 'B', itemId: 'I', title: '第1章 甲', html: '<p>a&amp;b</p>', volumeId: 'V', volumeName: '第一卷：崩塌', useAi: 2 });
    const c = calls[0];
    expect(c).toMatchObject({ path: '/api/author/publish_article/v0/', method: 'POST' });
    expect(c.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    expect(Object.fromEntries(c.form)).toMatchObject({
      aid: '2503', app_name: 'muye_novel', item_id: 'I', book_id: 'B', title: '第1章 甲', content: '<p>a&amp;b</p>',
      volume_id: 'V', volume_name: '第一卷：崩塌', use_ai: '2', publish_status: '1', timer_status: '0', need_pay: '0',
    });
  });

  it('newDraft 返回 item_id；listVolumes 解析卷；addVolume 发 POST', async () => {
    const { f, calls } = postFetch((p) =>
      p.includes('new_article') ? ok({ item_id: 123 }) : p.includes('volume_list') ? ok({ volume_list: [{ volume_id: 1, volume_name: '第一卷' }, { volume_name: '无id' }] }) : ok({}));
    const c = createFanqieClient(AUTH, f);
    expect(await c.newDraft('B')).toBe('123');
    expect(await c.listVolumes('B')).toEqual([{ volumeId: '1', volumeName: '第一卷' }]);
    await c.addVolume('B', '第二卷');
    expect(calls.map((x) => x.method)).toEqual(['POST', 'GET', 'POST']);
    expect(calls[2].form.get('volume_name')).toBe('第二卷');
  });

  it('-1019 抛额度错误；其他非 0 码带 code 与 message', async () => {
    const quota = postFetch(() => body(-1019, {}, '提交字数超出每日上限'));
    await expect(createFanqieClient(AUTH, quota.f).newDraft('B')).rejects.toBeInstanceOf(PlatformQuotaError);
    const other = postFetch(() => body(-4054, {}, '暂不支持创建多个无章节的分卷'));
    const e = (await createFanqieClient(AUTH, other.f).addVolume('B', 'x').catch((x) => x)) as PlatformApiError;
    expect(e).toBeInstanceOf(PlatformApiError);
    expect(e.code).toBe(-4054);
  });
});
