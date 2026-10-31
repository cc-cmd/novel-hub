// src/lib/publish.fanqie.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseH1, toPublishBody } from './publish';

const dir = path.join(__dirname, '..', 'test', 'fixtures', 'fanqie');
const nos = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.expected.json')).map((f) => f.slice(2, 4))
  : [];

describe('与番茄发布技能 draft_chapter 对拍', () => {
  it('夹具存在', () => expect(nos).toContain('09'));
  it.each(nos)('ch%s：标题、章号与正文一致', (nn) => {
    const md = fs.readFileSync(path.join(dir, `ch${nn}.md`), 'utf8');
    const exp = JSON.parse(fs.readFileSync(path.join(dir, `ch${nn}.expected.json`), 'utf8'));
    expect(parseH1(md)).toEqual({ chapterNo: exp.no, title: exp.title });
    expect(toPublishBody(md)).toBe(exp.body);
  });
});
