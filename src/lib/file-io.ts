import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash';

export type Eol = '\n' | '\r\n';
export type ReadResult =
  | { ok: true; text: string; hasBom: boolean; eol: Eol; rawHash: string }
  | { ok: false; reason: 'encoding' };

const decoder = new TextDecoder('utf-8', { fatal: true });

export function readChapterFile(file: string): ReadResult {
  const raw = fs.readFileSync(file);
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let text: string;
  try {
    text = decoder.decode(raw); // 默认剥离 BOM
  } catch {
    return { ok: false, reason: 'encoding' };
  }
  return { ok: true, text, hasBom, eol: text.includes('\r\n') ? '\r\n' : '\n', rawHash: sha256(raw) };
}

export function writeChapterFileAtomic(file: string, textLF: string, style: { hasBom: boolean; eol: Eol }): void {
  fs.accessSync(file, fs.constants.W_OK); // rename 会无视目标文件的只读位，这里显式检查
  const body = style.eol === '\r\n' ? textLF.replace(/\r?\n/g, '\r\n') : textLF.replace(/\r\n/g, '\n');
  const data = Buffer.concat([style.hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, 'utf8')]);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.chmodSync(tmp, fs.statSync(file).mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
