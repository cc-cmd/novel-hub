import { describe, expect, it } from 'vitest';
import { parseFanqieBookId } from './fanqie-url';

const SAMPLE = 'https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864&坏人?type=1';

describe('parseFanqieBookId', () => {
  it('AC7.1 样例链接解析出 book_id', () => {
    expect(parseFanqieBookId(SAMPLE)).toBe('7670888040847395864');
  });
  it('允许 www、http、首尾空白、无后缀', () => {
    expect(parseFanqieBookId(' http://www.fanqienovel.com/main/writer/chapter-manage/123 ')).toBe('123');
    expect(parseFanqieBookId('https://fanqienovel.com/main/writer/chapter-manage/123/')).toBe('123');
    expect(parseFanqieBookId('https://fanqienovel.com/main/writer/chapter-manage/123?type=1')).toBe('123');
  });
  it.each([
    'https://example.com/main/writer/chapter-manage/1',
    'https://fanqienovel.com/page/123',
    'https://fanqienovel.com/main/writer/chapter-manage/abc',
    'https://fanqienovel.com/main/writer/chapter-manage/',
    'https://fanqienovel.com.evil.com/main/writer/chapter-manage/1',
    'https://fanqienovel.com@evil.com/main/writer/chapter-manage/1',
    'ftp://fanqienovel.com/main/writer/chapter-manage/1',
    'not a url',
    '',
  ])('AC7.2 拒绝 %s', (u) => {
    expect(() => parseFanqieBookId(u)).toThrow('链接不符合番茄章节管理页格式');
  });
});
