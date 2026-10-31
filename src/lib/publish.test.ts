import { describe, expect, it } from 'vitest';
import { badgeHint, buildPublishForm, countWords, deriveBadge, isStale, parseChineseNumber, parseH1, platformTitle, resolveTitle, toPublishBody } from './publish';

describe('parseChineseNumber', () => {
  it.each([['7', 7], ['十二', 12], ['二十', 20], ['一百零三', 103], ['两百', 200], ['十', 10]])('%s → %s', (s, n) => {
    expect(parseChineseNumber(s)).toBe(n);
  });
  it('非法返回 null', () => expect(parseChineseNumber('abc')).toBeNull());
});

describe('parseH1', () => {
  it('阿拉伯数字与中文数字', () => {
    expect(parseH1('# 第1章 开端\n正文')).toEqual({ chapterNo: 1, title: '开端' });
    expect(parseH1('\n\n# 第十二章 夜行\n')).toEqual({ chapterNo: 12, title: '夜行' });
    expect(parseH1('# 第3章：冒号分隔')).toEqual({ chapterNo: 3, title: '冒号分隔' });
  });
  it('真实稿件格式 `# 《书名》· 第N章 · 标题`（番茄发布技能 pipeline.py 使用）', () => {
    expect(parseH1('# 《陈波宁传》· 第1章 · 私信\n\n正文')).toEqual({ chapterNo: 1, title: '私信' });
    expect(parseH1('# 《书》・第二章・标题')).toEqual({ chapterNo: 2, title: '标题' });
  });
  it('忽略 BOM', () => expect(parseH1('\uFEFF# 第1章 x')).toEqual({ chapterNo: 1, title: 'x' }));
  it('无法解析 → null', () => {
    expect(parseH1('正文')).toBeNull();
    expect(parseH1('# 序章')).toBeNull();
    expect(parseH1('# 第3章')).toBeNull();
    expect(parseH1('## 第3章 二级标题')).toBeNull();
  });
});

describe('toPublishBody', () => {
  it('去 H1、标题井号、粗体斜体', () => {
    expect(toPublishBody('# 第1章 开端\n\n## 小节\n**加粗**和*斜体*\n')).toBe('小节\n加粗和斜体');
  });
  it('链接保留文字，图片移除', () => expect(toPublishBody('[文字](http://x)![图](a.png)')).toBe('文字'));
  it('AC5.5 连续空行压成一个', () => expect(toPublishBody('a\n\n\n\n\n\nb')).toBe('a\n\nb'));
  it('成对 * 去标记，孤立 * 保留', () => {
    expect(toPublishBody('*砰* 然后 5 * 3 孤立*号')).toBe('砰 然后 5 * 3 孤立*号');
  });
  it('POV、分隔线、引用、列表', () => {
    expect(toPublishBody('**【林】**\n---\n> 引用\n- 项\n* 项二\n1. 有序')).toBe('【林】\n\n引用\n· 项\n· 项二\n1. 有序');
  });
  it('转义还原', () => expect(toPublishBody('a\\*b\\*c')).toBe('a*b*c'));
  it('围栏内文字原样保留，行内代码去反引号', () => {
    expect(toPublishBody('```\n**x**\n```\n`行内`')).toBe('**x**\n行内');
  });
  it('保留全角缩进，CRLF 与行尾空白规整', () => {
    expect(toPublishBody('　　段落一\r\n\r\n　　段落二  \r\n')).toBe('　　段落一\n\n　　段落二');
  });
  it('HTML 注释移除', () => expect(toPublishBody('<!-- c -->\n正文')).toBe('正文'));
  it('幂等：对结果再次转换不变', () => {
    const once = toPublishBody('# 第1章 x\n\n**a**\n---\nb');
    expect(toPublishBody(once)).toBe(once);
  });
  it('空文件', () => expect(toPublishBody('')).toBe(''));
  it('忽略 BOM', () => expect(toPublishBody('\uFEFF# 第1章 x\n正文')).toBe('正文'));
});

describe('title / form / words', () => {
  it('resolveTitle：H1 优先，缺失用后备', () => {
    expect(resolveTitle('# 第1章 开端\nx', '文件名标题')).toEqual({ title: '开端', h1: { chapterNo: 1, title: '开端' } });
    expect(resolveTitle('x', '文件名标题')).toEqual({ title: '文件名标题', h1: null });
  });
  it('platformTitle / buildPublishForm', () => {
    expect(platformTitle(3, '开端')).toBe('第3章 开端');
    expect(buildPublishForm('# 第3章 开端\n正文', 3, '后备')).toEqual({ title: '第3章 开端', body: '正文' });
  });
  it('countWords 去全部空白、按码点计', () => {
    expect(countWords('你 好\n\n世界！')).toBe(5);
    expect(countWords('a😀b')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('isStale / deriveBadge', () => {
  const ch = (h: string | null = 'H1', missing = false) => ({ contentHash: h, fileMissing: missing });
  const pub = (status: 'unpublished' | 'pending_review' | 'published', publishedHash: string | null) => ({ status, publishedHash });

  it.each([
    ['无发布记录', ch(), undefined, false, 'unpublished'],
    ['unpublished', ch(), pub('unpublished', null), false, 'unpublished'],
    ['已发且一致', ch('H1'), pub('published', 'H1'), false, 'published'],
    ['已发但不一致', ch('H2'), pub('published', 'H1'), true, 'stale'],
    ['审核中且一致', ch('H1'), pub('pending_review', 'H1'), false, 'pending_review'],
    ['审核中被改稿', ch('H2'), pub('pending_review', 'H1'), true, 'stale'],
    ['published_hash 为空（异常数据）', ch('H1'), pub('published', null), true, 'stale'],
    ['published_hash 空串', ch('H1'), pub('published', ''), true, 'stale'],
    ['content_hash 为 NULL → 不误报', ch(null), pub('published', 'H1'), false, 'published'],
    ['file_missing 优先于需更新', ch('H2', true), pub('published', 'H1'), false, 'missing'],
    ['file_missing 且无记录', ch('H1', true), undefined, false, 'missing'],
  ] as const)('%s', (_n, c, p, stale, badge) => {
    expect(isStale(c, p)).toBe(stale);
    expect(deriveBadge(c, p)).toBe(badge);
  });

  it('F4.5 自愈：内容改回后恢复已发', () => {
    expect(deriveBadge(ch('H1'), pub('published', 'H1'))).toBe('published');
    expect(deriveBadge(ch('H2'), pub('published', 'H1'))).toBe('stale');
    expect(deriveBadge(ch('H1'), pub('published', 'H1'))).toBe('published');
  });
});

describe('badgeHint', () => {
  const mtime = new Date(2026, 9, 31, 8, 5).getTime();
  it('审核中', () => {
    expect(badgeHint({ badge: 'pending_review', status: 'pending_review', platformName: '番茄' })).toBe(
      '平台审核中，暂不能修改该章（番茄审核时段 7:00–24:00）',
    );
    expect(badgeHint({ badge: 'pending_review', status: 'pending_review', platformName: '起点' })).toBe('平台审核中，暂不能修改该章');
  });
  it('需更新：审核中 / 已发（含与不含 mtime）', () => {
    expect(badgeHint({ badge: 'stale', status: 'pending_review', platformName: '番茄' })).toBe('本地内容已变更，待审核结束后再覆盖');
    expect(badgeHint({ badge: 'stale', status: 'published', platformName: '番茄', mtimeMs: mtime })).toBe(
      '本地内容已于 10月31日 08:05 变更，与 番茄 已发版本不一致',
    );
    expect(badgeHint({ badge: 'stale', status: 'published', platformName: '起点' })).toBe('本地内容已变更，与 起点 已发版本不一致');
  });
  it('其他徽标无提示（丢失除外）', () => {
    expect(badgeHint({ badge: 'published', status: 'published', platformName: '番茄' })).toBeUndefined();
    expect(badgeHint({ badge: 'missing', status: 'published', platformName: '番茄' })).toBe('文件丢失');
  });
});
