import { createHash } from 'node:crypto';
import { buildPublishForm } from './publish';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 发布形态 hash = sha256(平台标题 + "\n" + 发布形态正文)。 */
export function contentHash(markdown: string, seq: number, fallbackTitle: string): string {
  const { title, body } = buildPublishForm(markdown, seq, fallbackTitle);
  return sha256(`${title}\n${body}`);
}
