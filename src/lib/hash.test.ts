import { describe, expect, it } from 'vitest';
import { contentHash } from './hash';

const h = (md: string, seq = 1, fb = '开端') => contentHash(md, seq, fb);
const base = '# 第1章 开端\n\n第一段。\n\n第二段。\n';

describe('contentHash 不应变的改动', () => {
  it('LF → CRLF', () => expect(h(base.replace(/\n/g, '\r\n'))).toBe(h(base)));
  it('首尾空白与行尾空白', () => expect(h('\n\n' + base.replace('第一段。', '第一段。  ') + '\n\n')).toBe(h(base)));
  it('仅 Markdown 写法不同', () => expect(h('# 第1章 开端\n\n**第一段。**\n\n第二段。')).toBe(h(base)));
  it('H1 缺失但文件名标题相同', () => expect(h('第一段。\n\n第二段。', 1, '开端')).toBe(h(base)));
});

describe('contentHash 应变化的改动', () => {
  it('H1 标题变化', () => expect(h(base.replace('开端', '序幕'))).not.toBe(h(base)));
  it('正文文字变化', () => expect(h(base.replace('第一段', '首段'))).not.toBe(h(base)));
  it('行内空格变化', () => expect(h(base.replace('第一段。', '第 一段。'))).not.toBe(h(base)));
  it('标点变化', () => expect(h(base.replace('第一段。', '第一段！'))).not.toBe(h(base)));
});

it('空文件有确定的 64 位 hash', () => {
  expect(h('')).toMatch(/^[0-9a-f]{64}$/);
  expect(h('')).toBe(h('\n\n'));
});
