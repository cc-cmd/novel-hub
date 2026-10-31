import { describe, expect, it } from 'vitest';
import { copyNotice } from './copy-notice';

describe('copyNotice', () => {
  const p = { title: '第3章 开端', wordCount: 1234, bodyEmpty: false, mode: 'both' as const };
  it('标题+正文', () => expect(copyNotice(p)).toBe('已复制《第3章 开端》，共 1234 字'));
  it('仅标题', () => expect(copyNotice({ ...p, mode: 'title' })).toBe('已复制标题：第3章 开端'));
  it('仅正文', () => expect(copyNotice({ ...p, mode: 'body' })).toBe('已复制《第3章 开端》正文，共 1234 字'));
  it('正文为空', () => expect(copyNotice({ ...p, bodyEmpty: true, wordCount: 0 })).toBe('已复制标题，正文为空'));
  it('未保存内容', () => expect(copyNotice(p, true)).toBe('已复制，复制的是未保存内容'));
});
