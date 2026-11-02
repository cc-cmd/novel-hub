import { describe, expect, it } from 'vitest';
import { buildPublishForm, countWords, formatForCopy, parseChineseNumber, parseH1, platformTitle, resolveTitle, syncedStatus, syncHint, toPublishBody } from './publish';

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

describe('syncedStatus / syncHint', () => {
  it('只认 published / stale，其余（含 MVP 遗留的 pending_review）按未发布', () => {
    expect(syncedStatus('published')).toBe('published');
    expect(syncedStatus('stale')).toBe('stale');
    expect(syncedStatus('pending_review')).toBe('unpublished');
    expect(syncedStatus(undefined)).toBe('unpublished');
    expect(syncedStatus(null)).toBe('unpublished');
  });
  it('syncHint', () => expect(syncHint('番茄')).toBe('状态由番茄同步，点击重新扫描刷新'));
});

describe('formatForCopy', () => {
  const md = '# 第1章 开端\n\n## 小节\n**加粗**和*斜体*\n\n\n\n\n后文 [链接](http://x) ![图](a.png)\n';
  it('AC5.1/5.4/5.5 标题 + 空行 + 去标记正文，标题不重复，多空行压缩', () => {
    expect(formatForCopy(md, 1, '后备')).toBe('第1章 开端\n\n小节\n加粗和斜体\n\n后文 链接');
  });
  it('仅标题 / 仅正文', () => {
    expect(formatForCopy(md, 1, '后备', 'title')).toBe('第1章 开端');
    expect(formatForCopy(md, 1, '后备', 'body')).toBe('小节\n加粗和斜体\n\n后文 链接');
  });
  it('无 H1 时用后备标题；序号取自文件名而非 H1', () => {
    expect(formatForCopy('正文', 7, '文件名标题')).toBe('第7章 文件名标题\n\n正文');
    expect(formatForCopy('# 第9章 错号\n正文', 2, '后备')).toBe('第2章 错号\n\n正文');
  });
  it('正文为空时只输出标题（无多余空行）', () => {
    expect(formatForCopy('# 第1章 开端\n', 1, '后备')).toBe('第1章 开端');
  });
  it('真实稿件 H1 格式', () => {
    expect(formatForCopy('# 《陈波宁传》· 第1章 · 私信\n\n他推开门。', 1, 'x')).toBe('第1章 私信\n\n他推开门。');
  });
  it('幂等性：对「仅正文」结果再次转换不变', () => {
    const body = formatForCopy(md, 1, '后备', 'body');
    expect(toPublishBody(body)).toBe(body);
  });
});
