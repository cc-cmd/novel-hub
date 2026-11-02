import { UserError } from './result';

const FORMAT_ERROR = '链接不符合番茄章节管理页格式，示例：https://fanqienovel.com/main/writer/chapter-manage/<书号>';

/** 从番茄作家后台「章节管理」链接解析 book_id。格式不符抛 UserError。 */
export function parseFanqieBookId(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new UserError(FORMAT_ERROR);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError(FORMAT_ERROR);
  if (!/^(www\.)?fanqienovel\.com$/i.test(u.hostname)) throw new UserError(FORMAT_ERROR);
  // 样例路径形如 /main/writer/chapter-manage/7670…&书名，& 之后的内容是书名，忽略
  const m = /^\/main\/writer\/chapter-manage\/(\d+)(?=$|[&/])/.exec(u.pathname);
  if (!m) throw new UserError(FORMAT_ERROR);
  return m[1];
}
