# REQ-02 章节管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ChNN-标题.md` 同步成章节记录（序号、H1 标题、字数、发布形态 hash），提供纯文本编辑并安全写回，外部修改在重新扫描后自然同步。

**Architecture:** 纯函数层（`publish.ts` 转换核心、`hash.ts`、`fs-scan.ts` 文件名解析、`file-io.ts` 读写）→ 同步层（`sync.ts`：`syncNovel` / `syncChapter` / `scanAndSync`）→ 查询/编辑层（`chapters.ts`）→ Action → 编辑页。同步全部是同步函数，批量写库包在 `db.$client.transaction` 中。**平台内编辑 = 先写文件、成功后再单章同步，顺序不可颠倒。**

**Tech Stack:** Node `fs` / `crypto` / `TextDecoder`、drizzle-orm、Vitest、React 客户端组件。前置：基础设施方案与 REQ-01 方案已完成。

## Global Constraints

- 章节文件名 `^ch(\d+)-(.+)\.md$`（忽略大小写，仅半角 `-`，标题 trim 后非空）；只读 `chapter_subdir` 目录的**一级**，不递归；非 `.md` 与隐藏文件静默忽略。
- 无标题 `Ch01.md`、`第一章.md`、`notes.md` → 未识别（只提示，不报错、不阻塞其它章节）。
- 重复序号：按文件名字典序保留第一个，其余列入冲突提示（`kind='duplicate'`）。
- 标题以文件首个非空行 H1 为准。**H1 有两种写法都必须识别**：`# 第N章 标题`（需求文档约定）与 `# 《书名》· 第N章 · 标题`（用户真实稿件，见 `陈波宁传/改稿/Ch01-私信.md`，与 `pipeline.py` 的 `_TITLE_RE` 一致；`·` 也可为 `・`）；N 为阿拉伯或中文数字。已用 25 章真实稿件验证：章号与标题 25/25 与 pipeline 一致。无法解析则用文件名标题并写 `warning='no_h1'`；H1 章号 ≠ 文件名 `seq` 写 `warning='h1_mismatch'`，仍以文件名 `seq` 入库。
- 字数 = 发布形态正文去掉全部空白后的**码点数**；H1 不计入。hash = `sha256_hex(第${seq}章 ${标题} + "\n" + 发布形态正文)`。**转换规则只有 `publish.ts` 一份实现。**
- 同步：新文件→新增；改动→更新；缺失→`file_missing=true` 且保留章节与发布记录；恢复→`file_missing=false`；幂等（磁盘无变化时数据库不发生任何写入）。
- 非 UTF-8 文件：`warning='encoding'`，不更新字数/hash（新章 hash 为 `NULL`）。带 BOM 读取时忽略 BOM，写回时保持。
- 写回：原子写（同目录临时文件 + `rename`），保持原换行风格（`\r\n` 不强改 `\n`）；写失败不更新数据库；保存前检测外部修改（原始字节 sha256 与加载时不一致 → `文件已被外部修改`）。
- 文案（逐字）：`文件丢失，无法编辑`、`保存失败，文件未被修改`、`文件已被外部修改`、`已写回文件，字数与状态已更新`、`与文件一致`、`未保存修改`。

---

### Task 1: `publish.ts` 转换核心

**Files:**
- Create: `src/lib/publish.ts`
- Test: `src/lib/publish.test.ts`

**Interfaces:**
- Produces（REQ-04/05/06 复用，**名称固定**）：
  - `parseChineseNumber(s: string): number | null`
  - `parseH1(markdown: string): { chapterNo: number; title: string } | null`
  - `stripLeadingH1(markdown: string): string`
  - `toPublishBody(markdown: string): string` —— 发布形态正文（去 H1 与 Markdown 标记，规则见下表）
  - `platformTitle(seq: number, title: string): string` → `第${seq}章 ${title}`
  - `resolveTitle(markdown: string, fallbackTitle: string): { title: string; h1: H1Info | null }`
  - `buildPublishForm(markdown: string, seq: number, fallbackTitle: string): { title: string; body: string }` —— `title` 已是 `第N章 标题`
  - `countWords(body: string): number`

转换规则（REQ-05 §4.1，已在草稿中用 node 验证）：

| 输入 | 输出 |
|---|---|
| 首个非空行 `# …`（H1，两种写法皆然） | 整行移除 |
| `#`~`######` 标题 | 去井号 |
| `**x**` `__x__` `*x*` `_x_` `~~x~~` `` `x` `` | 去标记留文字（**成对**才处理，孤立 `*` 保留） |
| `> x` | `x` |
| `- x` `* x` `+ x` | `· x` |
| `1. x` | 保留 |
| `[文字](url)` | `文字`；`![alt](url)` 整体移除 |
| `---` `***` `___` 独占一行 | 空行 |
| 代码围栏行 | 移除围栏行，保留内部文字（不再处理内部标记） |
| `<!-- -->` | 移除 |
| `\*` 等转义 | 还原字面量 |
| 空白 | `\r\n`→`\n`；行尾空白去除；3 个以上换行压成 1 个空行；去首部空行与尾部空白；**行首全角缩进保留** |

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/publish.test.ts
import { describe, expect, it } from 'vitest';
import { buildPublishForm, countWords, parseChineseNumber, parseH1, platformTitle, resolveTitle, toPublishBody } from './publish';

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
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/publish.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/publish.ts
// 唯一的「发布形态」转换实现。字数、hash、复制、需更新判断都依赖这里；不得在别处复制规则。

export function parseChineseNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in digits) {
      cur = digits[ch];
      seen = true;
    } else if (ch in units) {
      total += (cur || 1) * units[ch];
      cur = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + cur : null;
}

export interface H1Info {
  chapterNo: number;
  title: string;
}

// 同时支持 `# 第N章 标题`（需求文档约定）与真实稿件的 `# 《书名》· 第N章 · 标题`（pipeline.py 的 _TITLE_RE）
const H1_RE = /^#\s+(?:《[^》]+》\s*[·・]\s*)?第\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*章\s*(?:[·・:：]\s*|\s+)(.+?)\s*$/;

export function parseH1(markdown: string): H1Info | null {
  const first = markdown
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .find((l) => l.trim() !== '');
  if (!first) return null;
  const m = H1_RE.exec(first.trim());
  if (!m) return null;
  const chapterNo = parseChineseNumber(m[1]);
  const title = m[2].trim();
  if (chapterNo === null || !title) return null;
  return { chapterNo, title };
}

/** 移除首个非空行（若它是一级标题 `# `）。 */
export function stripLeadingH1(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i >= 0 && /^#\s+/.test(lines[i])) lines.splice(i, 1);
  return lines.join('\n');
}

const ESC_BASE = 0xe000; // 把转义字符暂存到私有区，避免被后续规则误处理

function convertLine(line: string): string {
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return '';
  let s = line.replace(/\\([\\`*_{}\[\]()#+\-.!~>|])/g, (_, c: string) => String.fromCharCode(ESC_BASE + c.charCodeAt(0)));
  s = s
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}(?:>\s?)+/, '')
    .replace(/^(\s*)[-*+]\s+/, '$1· ');
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '$1')
    .replace(/(?<!\*)\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1')
    .replace(/(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1');
  return s.replace(/[-]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - ESC_BASE));
}

export function toPublishBody(markdown: string): string {
  let text = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  text = stripLeadingH1(text);
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    out.push((inFence ? raw : convertLine(raw)).replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

export const platformTitle = (seq: number, title: string) => `第${seq}章 ${title}`;

export function resolveTitle(markdown: string, fallbackTitle: string): { title: string; h1: H1Info | null } {
  const h1 = parseH1(markdown);
  return { title: h1 ? h1.title : fallbackTitle, h1 };
}

export function buildPublishForm(markdown: string, seq: number, fallbackTitle: string): { title: string; body: string } {
  return { title: platformTitle(seq, resolveTitle(markdown, fallbackTitle).title), body: toPublishBody(markdown) };
}

export function countWords(body: string): number {
  return [...body.replace(/\s/g, '')].length;
}
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/publish.test.ts` → PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/publish.ts src/lib/publish.test.ts
git commit -m "feat(publish): markdown to publish-form conversion core"
```

---

### Task 2: `hash.ts`

**Files:**
- Create: `src/lib/hash.ts`
- Test: `src/lib/hash.test.ts`

**Interfaces:**
- Consumes: `buildPublishForm`（Task 1）。
- Produces: `contentHash(markdown: string, seq: number, fallbackTitle: string): string`（64 位 hex）；`sha256(input: string | Buffer): string`。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/hash.test.ts
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
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/hash.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/hash.ts
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
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/hash.test.ts` → PASS。

- [ ] **Step 5: 提交** —— `git add src/lib/hash.ts src/lib/hash.test.ts && git commit -m "feat(hash): publish-form content hash"`

---

### Task 3: 文件名解析与目录分类（`fs-scan.ts` 第二部分）

**Files:**
- Modify: `src/lib/fs-scan.ts`（文件末尾追加）
- Modify: `src/lib/fs-scan.test.ts`（文件末尾追加）

**Interfaces:**
- Produces:
  - `parseChapterFilename(name: string): { seq: number; title: string } | null`
  - `interface ParsedChapterFile { fileName: string; seq: number; title: string }`
  - `interface DirIssue { fileName: string; kind: 'unrecognized' | 'duplicate'; reason: string }`
  - `classifyChapterEntries(entries: Array<{ name: string; isFile: boolean }>): { chapters: ParsedChapterFile[]; issues: DirIssue[] }`

- [ ] **Step 1: 追加失败测试**

```ts
// 追加到 src/lib/fs-scan.test.ts 末尾（顶部 import 增加 classifyChapterEntries, parseChapterFilename）
describe('parseChapterFilename', () => {
  it.each([
    ['Ch01-重生之初.md', 1, '重生之初'],
    ['ch12-第十二回 夜行.md', 12, '第十二回 夜行'],
    ['Ch003-标题.md', 3, '标题'],
    ['CH7-x.MD', 7, 'x'],
    ['Ch01- 空格标题 .md', 1, '空格标题'],
  ])('%s', (name, seq, title) => {
    expect(parseChapterFilename(name)).toEqual({ seq, title });
  });
  it.each(['Ch01.md', '第一章.md', 'notes.md', 'Ch01-标题.txt', 'Ch-标题.md', 'Ch01－标题.md', 'Ch01-.md', 'Ch01-  .md'])(
    '未识别：%s',
    (name) => expect(parseChapterFilename(name)).toBeNull(),
  );
});

describe('classifyChapterEntries', () => {
  const f = (name: string) => ({ name, isFile: true });
  it('AC2.1 识别 + 未识别提示；非 md 与目录、隐藏文件静默忽略', () => {
    const r = classifyChapterEntries([
      f('Ch01-开端.md'), f('Ch02-发展.md'), f('notes.md'), f('cover.png'), f('._Ch03-x.md'),
      { name: '_v1', isFile: false },
    ]);
    expect(r.chapters.map((c) => c.seq)).toEqual([1, 2]);
    expect(r.issues).toEqual([{ fileName: 'notes.md', kind: 'unrecognized', reason: '文件名不符合 ChNN-标题.md，未入库' }]);
  });
  it('AC2.8 重复序号：字典序第一个生效，其余列冲突', () => {
    const r = classifyChapterEntries([f('Ch1-b.md'), f('Ch01-a.md')]);
    expect(r.chapters).toEqual([{ fileName: 'Ch01-a.md', seq: 1, title: 'a' }]);
    expect(r.issues).toEqual([{ fileName: 'Ch1-b.md', kind: 'duplicate', reason: '序号重复（与 Ch01-a.md 冲突），未入库' }]);
  });
  it('结果按 seq 升序', () => {
    const r = classifyChapterEntries([f('Ch10-j.md'), f('Ch2-b.md')]);
    expect(r.chapters.map((c) => c.seq)).toEqual([2, 10]);
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/fs-scan.test.ts` → FAIL（新函数未导出）。

- [ ] **Step 3: 实现（追加到 `src/lib/fs-scan.ts` 末尾）**

```ts
const CHAPTER_RE = /^ch(\d+)-(.+)\.md$/i;

export function parseChapterFilename(name: string): { seq: number; title: string } | null {
  const m = CHAPTER_RE.exec(name);
  if (!m) return null;
  const title = m[2].trim();
  const seq = parseInt(m[1], 10);
  if (!title || !Number.isSafeInteger(seq)) return null;
  return { seq, title };
}

export interface ParsedChapterFile {
  fileName: string;
  seq: number;
  title: string;
}

export interface DirIssue {
  fileName: string;
  kind: 'unrecognized' | 'duplicate';
  reason: string;
}

export function classifyChapterEntries(entries: Array<{ name: string; isFile: boolean }>): {
  chapters: ParsedChapterFile[];
  issues: DirIssue[];
} {
  const names = entries
    .filter((e) => e.isFile && !e.name.startsWith('.') && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const chapters: ParsedChapterFile[] = [];
  const issues: DirIssue[] = [];
  const bySeq = new Map<number, string>();
  for (const fileName of names) {
    const p = parseChapterFilename(fileName);
    if (!p) {
      issues.push({ fileName, kind: 'unrecognized', reason: '文件名不符合 ChNN-标题.md，未入库' });
      continue;
    }
    const first = bySeq.get(p.seq);
    if (first) {
      issues.push({ fileName, kind: 'duplicate', reason: `序号重复（与 ${first} 冲突），未入库` });
      continue;
    }
    bySeq.set(p.seq, fileName);
    chapters.push({ fileName, ...p });
  }
  chapters.sort((a, b) => a.seq - b.seq);
  return { chapters, issues };
}
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/fs-scan.test.ts` → PASS（含 REQ-01 的用例）。

- [ ] **Step 5: 提交** —— `git add src/lib/fs-scan.* && git commit -m "feat(fs-scan): chapter filename parsing and classification"`

---

### Task 4: 文件读写（`file-io.ts`）

**Files:**
- Create: `src/lib/file-io.ts`
- Test: `src/lib/file-io.test.ts`

**Interfaces:**
- Consumes: `sha256`（Task 2）。
- Produces:
  - `type ReadResult = { ok: true; text: string; hasBom: boolean; eol: '\n' | '\r\n'; rawHash: string } | { ok: false; reason: 'encoding' }`（`text` 已去 BOM，**保留**原换行）；文件无法读取（权限等）时**抛出**原始 fs 错误
  - `readChapterFile(file: string): ReadResult`
  - `writeChapterFileAtomic(file: string, textLF: string, style: { hasBom: boolean; eol: '\n' | '\r\n' }): void` —— `textLF` 为 `\n` 换行文本，函数按 `style` 还原；目标不可写时抛错；成功前不改动原文件

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/file-io.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '@/test/helpers';
import { readChapterFile, writeChapterFileAtomic } from './file-io';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function tmp(files: Record<string, string> = {}) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('readChapterFile', () => {
  it('读取 UTF-8，检测 LF/CRLF', () => {
    const d = tmp({ 'a.md': 'x\ny', 'b.md': 'x\r\ny' });
    expect(readChapterFile(path.join(d, 'a.md'))).toMatchObject({ ok: true, text: 'x\ny', eol: '\n', hasBom: false });
    expect(readChapterFile(path.join(d, 'b.md'))).toMatchObject({ ok: true, eol: '\r\n' });
  });
  it('BOM 被忽略但被记录', () => {
    const d = tmp();
    const f = path.join(d, 'c.md');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好')]));
    expect(readChapterFile(f)).toMatchObject({ ok: true, text: '你好', hasBom: true });
  });
  it('非 UTF-8 → encoding', () => {
    const d = tmp();
    const f = path.join(d, 'd.md');
    fs.writeFileSync(f, Buffer.from([0xff, 0xfe, 0x41]));
    expect(readChapterFile(f)).toEqual({ ok: false, reason: 'encoding' });
  });
  it('文件不存在时抛错', () => {
    expect(() => readChapterFile('/no/such/file.md')).toThrow();
  });
});

describe('writeChapterFileAtomic', () => {
  it('按原风格还原 CRLF 与 BOM，且不遗留临时文件', () => {
    const d = tmp({ 'a.md': 'old' });
    const f = path.join(d, 'a.md');
    writeChapterFileAtomic(f, '第一行\n第二行', { hasBom: true, eol: '\r\n' });
    const raw = fs.readFileSync(f);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.subarray(3).toString('utf8')).toBe('第一行\r\n第二行');
    expect(fs.readdirSync(d)).toEqual(['a.md']);
  });
  it('AC2.7 只读文件 → 抛错且内容不变', () => {
    if (process.getuid?.() === 0) return; // root 无视权限
    const d = tmp({ 'a.md': 'old' });
    const f = path.join(d, 'a.md');
    fs.chmodSync(f, 0o444);
    expect(() => writeChapterFileAtomic(f, 'new', { hasBom: false, eol: '\n' })).toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe('old');
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/file-io.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/file-io.ts
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
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/file-io.test.ts` → PASS。

- [ ] **Step 5: 提交** —— `git add src/lib/file-io.* && git commit -m "feat(io): chapter file read and atomic write"`

---

### Task 5: 同步（`sync.ts`）

**Files:**
- Create: `src/lib/sync.ts`
- Test: `src/lib/sync.test.ts`

**Interfaces:**
- Consumes: `classifyChapterEntries, parseChapterFilename`（Task 3）；`readChapterFile`（Task 4）；`contentHash`、`resolveTitle/toPublishBody/countWords`；`chapterDirOf, scanLibrary`（REQ-01）。
- Produces（**名称固定**）：
  - `interface SyncResult { added: number; updated: number; restored: number; markedMissing: number; issues: number; error?: string }`
  - `syncNovel(db, novelId: number, opts?: { force?: boolean }): SyncResult` —— `force` 忽略 mtime/size 短路
  - `syncChapter(db, chapterId: number): { changed: boolean }` —— 强制重读该章文件；文件不存在则标记丢失
  - `interface FullSyncSummary extends ScanSummary { chapters: { added: number; updated: number; restored: number; markedMissing: number }; issues: number; errors: string[] }`
  - `scanAndSync(db): FullSyncSummary` —— `scanLibrary` + 对所有**未归档**小说 `syncNovel`

行为要点（实现时逐条满足）：
- 章节身份 `(novel_id, seq)`；`file_path`、标题变化 → 更新同一行。
- mtime/size 短路条件：`!force && 已存在 && !file_missing && file_path 相同 && mtime_ms/size_bytes 相同 && content_hash != null` → 跳过读文件。
- 读文件抛 fs 错误（权限等）：该文件不改库，写一条 `kind='unrecognized'` 的 issue（`无法读取文件：{code}`），**不**标记丢失。
- 章节目录读取失败：该小说全部章节标记 `file_missing`，返回 `error`。
- 每次同步整体重写该小说的 `scan_issue`（先删后插）。
- 批量写入包在 `db.$client.transaction(...)()` 内。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/sync.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chapter, publication, scanIssue } from '@/db/schema';
import { makeDb, insertNovel, makeTmpDir } from '@/test/helpers';
import { eq } from 'drizzle-orm';
import { contentHash } from './hash';
import { scanAndSync, syncChapter, syncNovel } from './sync';
import { addRoot } from './library';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(files: Record<string, string>, subdir = '') {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir, { chapterSubdir: subdir });
  return { db, n, dir: t.dir };
}
let tick = 0;
/** 写文件并推进 mtime，避免同毫秒写入导致短路。 */
function put(file: string, content: string | Buffer) {
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() + ++tick * 5000);
  fs.utimesSync(file, t, t);
}
const chapters = (db: ReturnType<typeof makeDb>) => db.select().from(chapter).orderBy(chapter.seq).all();

const CH1 = '# 第1章 开端\n\n你好，世界。\n';
const CH2 = '# 第2章 发展\n\n第二章正文。\n';

describe('syncNovel 基本路径', () => {
  it('AC2.1 入库 2 章，notes.md 进入未识别提示', () => {
    const { db, n } = setup({ 'Ch01-开端.md': CH1, 'Ch02-发展.md': CH2, 'notes.md': 'x' });
    const r = syncNovel(db, n.id);
    expect(r).toMatchObject({ added: 2, issues: 1 });
    const rows = chapters(db);
    expect(rows.map((c) => [c.seq, c.title])).toEqual([[1, '开端'], [2, '发展']]);
    expect(rows[0].wordCount).toBe(6); // "你好，世界。" 共 6 个字符
    expect(rows[0].contentHash).toBe(contentHash(CH1, 1, '开端'));
    expect(db.select().from(scanIssue).all()).toMatchObject([{ fileName: 'notes.md', kind: 'unrecognized' }]);
  });

  it('章节目录：只读 chapter_subdir，且不递归', () => {
    const { db, n } = setup({ 'Ch09-根目录.md': CH1, '改稿/Ch01-开端.md': CH1, '改稿/_v1/Ch02-旧.md': CH2 }, '改稿');
    syncNovel(db, n.id);
    expect(chapters(db).map((c) => c.seq)).toEqual([1]);
  });

  it('AC2.2 外部修改后字数与 hash 更新', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const before = chapters(db)[0];
    put(path.join(dir, 'Ch01-开端.md'), CH1 + '新增一段话。\n');
    expect(syncNovel(db, n.id)).toMatchObject({ updated: 1 });
    const after = chapters(db)[0];
    expect(after.id).toBe(before.id);
    expect(after.wordCount).toBeGreaterThan(before.wordCount);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('AC2.3 仅 LF→CRLF，hash 不变', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const before = chapters(db)[0].contentHash;
    put(path.join(dir, 'Ch01-开端.md'), CH1.replace(/\n/g, '\r\n'));
    syncNovel(db, n.id);
    expect(chapters(db)[0].contentHash).toBe(before);
  });

  it('F2.6 H1 标题变化视为同一章并更新标题与 hash', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const before = chapters(db)[0];
    put(path.join(dir, 'Ch01-开端.md'), CH1.replace('开端', '序幕'));
    syncNovel(db, n.id);
    const after = chapters(db)[0];
    expect([after.id, after.title]).toEqual([before.id, '序幕']);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('文件改名（同 seq）→ 同一章，更新 file_path', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const id = chapters(db)[0].id;
    fs.renameSync(path.join(dir, 'Ch01-开端.md'), path.join(dir, 'Ch1-新名.md'));
    syncNovel(db, n.id);
    expect(chapters(db)).toHaveLength(1);
    expect(chapters(db)[0]).toMatchObject({ id, filePath: path.join(dir, 'Ch1-新名.md') });
  });
});

describe('缺失与恢复（发布记录受保护）', () => {
  it('AC2.4 / AC2.5', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1, 'Ch02-发展.md': CH2 });
    syncNovel(db, n.id);
    const ch2 = chapters(db)[1];
    db.insert(publication).values({ chapterId: ch2.id, platformId: 1, status: 'published', publishedHash: ch2.contentHash }).run();
    fs.rmSync(path.join(dir, 'Ch02-发展.md'));
    expect(syncNovel(db, n.id)).toMatchObject({ markedMissing: 1 });
    expect(chapters(db)[1].fileMissing).toBe(true);
    expect(db.select().from(publication).where(eq(publication.chapterId, ch2.id)).all()).toHaveLength(1);
    put(path.join(dir, 'Ch02-发展.md'), CH2);
    expect(syncNovel(db, n.id)).toMatchObject({ restored: 1 });
    expect(chapters(db)[1].fileMissing).toBe(false);
    expect(db.select().from(publication).all()).toHaveLength(1);
  });

  it('章节目录不可读 → 全部章节标记丢失并返回 error', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    fs.rmSync(dir, { recursive: true });
    const r = syncNovel(db, n.id);
    expect(r.error).toContain('章节目录不可读');
    expect(chapters(db)[0].fileMissing).toBe(true);
  });
});

describe('冲突、警告与编码', () => {
  it('AC2.8 重复序号只入库一个', () => {
    const { db, n } = setup({ 'Ch01-a.md': CH1, 'Ch1-b.md': CH1 });
    syncNovel(db, n.id);
    expect(chapters(db)).toHaveLength(1);
    expect(db.select().from(scanIssue).all()).toMatchObject([{ fileName: 'Ch1-b.md', kind: 'duplicate' }]);
  });

  it('H1 章号与文件名不符 / 缺少 H1 → 入库并带 warning', () => {
    const { db, n } = setup({ 'Ch01-甲.md': '# 第9章 错号\n正文', 'Ch02-乙.md': '正文无标题' });
    syncNovel(db, n.id);
    const [a, b] = chapters(db);
    expect([a.seq, a.warning, a.title]).toEqual([1, 'h1_mismatch', '错号']);
    expect([b.seq, b.warning, b.title]).toEqual([2, 'no_h1', '乙']);
  });

  it('非 UTF-8：新章 hash 为 NULL 且 warning=encoding；旧章保留原字数/hash', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    put(path.join(dir, 'Ch02-坏.md'), Buffer.from([0xff, 0xfe, 0x41]));
    syncNovel(db, n.id);
    const [c1, c2] = chapters(db);
    expect([c2.warning, c2.contentHash, c2.wordCount]).toEqual(['encoding', null, 0]);
    put(path.join(dir, 'Ch01-开端.md'), Buffer.from([0xff, 0xfe, 0x41]));
    syncNovel(db, n.id);
    const c1b = chapters(db)[0];
    expect([c1b.warning, c1b.contentHash, c1b.wordCount]).toEqual(['encoding', c1.contentHash, c1.wordCount]);
  });

  it('空文件合法：字数 0', () => {
    const { db, n } = setup({ 'Ch01-空.md': '' });
    syncNovel(db, n.id);
    expect(chapters(db)[0]).toMatchObject({ wordCount: 0, contentHash: contentHash('', 1, '空') });
  });
});

describe('幂等与单章同步', () => {
  it('AC2.9 磁盘无变化时第二次同步不产生任何变更', () => {
    const { db, n } = setup({ 'Ch01-开端.md': CH1, 'notes.md': 'x' });
    syncNovel(db, n.id);
    const snap = JSON.stringify(chapters(db));
    expect(syncNovel(db, n.id)).toMatchObject({ added: 0, updated: 0, restored: 0, markedMissing: 0 });
    expect(JSON.stringify(chapters(db))).toBe(snap);
    expect(syncNovel(db, n.id, { force: true })).toMatchObject({ added: 0, updated: 0 });
    expect(JSON.stringify(chapters(db))).toBe(snap);
  });

  it('syncChapter 强制重读：mtime 未变但内容变了也能发现', () => {
    const { db, n, dir } = setup({});
    const f = path.join(dir, 'Ch01-开端.md');
    put(f, CH1); // put 使用整毫秒 mtime，便于下面精确还原
    syncNovel(db, n.id);
    const t = new Date(fs.statSync(f).mtimeMs);
    fs.writeFileSync(f, CH1.replace('你好', '您好')); // 等长改动
    fs.utimesSync(f, t, t); // 还原 mtime，使 size 与 mtime 都不变
    const id = chapters(db)[0].id;
    expect(syncNovel(db, n.id).updated).toBe(0); // 短路，看不到
    expect(syncChapter(db, id)).toEqual({ changed: true });
  });

  it('syncChapter：文件消失 → 标记丢失', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    fs.rmSync(path.join(dir, 'Ch01-开端.md'));
    expect(syncChapter(db, chapters(db)[0].id)).toEqual({ changed: true });
    expect(chapters(db)[0].fileMissing).toBe(true);
  });
});

describe('scanAndSync', () => {
  it('发现新书并同步章节；归档的书不同步', () => {
    const t = makeTmpDir({ 'A/Ch01-开端.md': CH1, 'B/Ch01-开端.md': CH1 });
    cleanups.push(t.cleanup);
    const db = makeDb();
    addRoot(db, t.dir);
    const s1 = scanAndSync(db);
    expect([s1.newNovels, s1.chapters.added]).toEqual([2, 2]);
    // 归档 B 后新增章节不会被同步
    db.$client.prepare("update novel set archived = 1 where name = 'B'").run();
    fs.writeFileSync(path.join(t.dir, 'B', 'Ch02-新.md'), CH2);
    fs.writeFileSync(path.join(t.dir, 'A', 'Ch02-新.md'), CH2);
    const s2 = scanAndSync(db);
    expect(s2.chapters.added).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/sync.test.ts` → FAIL（`./sync` 不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/sync.ts
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novel, scanIssue, type Chapter } from '@/db/schema';
import { classifyChapterEntries, parseChapterFilename, type DirIssue } from './fs-scan';
import { readChapterFile } from './file-io';
import { contentHash } from './hash';
import { chapterDirOf, scanLibrary, type ScanSummary } from './library';
import { countWords, resolveTitle, toPublishBody } from './publish';
import { UserError } from './result';
import type { ChapterWarning } from './types';

export interface SyncResult {
  added: number;
  updated: number;
  restored: number;
  markedMissing: number;
  issues: number;
  error?: string;
}

type Outcome = 'added' | 'updated' | 'restored' | 'unchanged' | 'skipped';

interface FileRef {
  fileName: string;
  seq: number;
  title: string;
}

function describeContent(text: string, seq: number, fallbackTitle: string) {
  const { title, h1 } = resolveTitle(text, fallbackTitle);
  const warning: ChapterWarning = !h1 ? 'no_h1' : h1.chapterNo !== seq ? 'h1_mismatch' : null;
  return {
    title,
    warning,
    wordCount: countWords(toPublishBody(text)),
    contentHash: contentHash(text, seq, fallbackTitle),
  };
}

/** 同步单个文件到数据库。issues 用于收集读文件失败。 */
function syncFile(
  db: Db,
  novelId: number,
  dir: string,
  f: FileRef,
  prev: Chapter | undefined,
  force: boolean,
  issues: DirIssue[],
): Outcome {
  const full = path.join(dir, f.fileName);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return 'skipped';
  }
  if (
    prev && !force && !prev.fileMissing && prev.filePath === full &&
    prev.mtimeMs === st.mtimeMs && prev.sizeBytes === st.size && prev.contentHash !== null
  ) {
    return 'unchanged';
  }

  let read;
  try {
    read = readChapterFile(full);
  } catch (e) {
    issues.push({ fileName: f.fileName, kind: 'unrecognized', reason: `无法读取文件：${(e as NodeJS.ErrnoException).code ?? 'ERR'}` });
    return 'skipped';
  }

  const meta = { filePath: full, mtimeMs: st.mtimeMs, sizeBytes: st.size, fileMissing: false };
  const content = read.ok
    ? describeContent(read.text, f.seq, f.title)
    : prev
      ? { title: prev.title, warning: 'encoding' as ChapterWarning, wordCount: prev.wordCount, contentHash: prev.contentHash }
      : { title: f.title, warning: 'encoding' as ChapterWarning, wordCount: 0, contentHash: null };
  const next = { ...meta, ...content };

  if (!prev) {
    db.insert(chapter).values({ novelId, seq: f.seq, ...next }).run();
    return 'added';
  }
  const keys = Object.keys(next) as Array<keyof typeof next>;
  if (keys.every((k) => prev[k] === next[k])) return 'unchanged';
  db.update(chapter).set(next).where(eq(chapter.id, prev.id)).run();
  if (prev.fileMissing) return 'restored';
  const contentChanged = (['title', 'filePath', 'wordCount', 'contentHash'] as const).some((k) => prev[k] !== next[k]);
  return contentChanged ? 'updated' : 'unchanged';
}

export function syncNovel(db: Db, novelId: number, opts: { force?: boolean } = {}): SyncResult {
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n) throw new UserError('小说不存在');
  const res: SyncResult = { added: 0, updated: 0, restored: 0, markedMissing: 0, issues: 0 };
  const dir = chapterDirOf(n);

  let entries: Array<{ name: string; isFile: boolean }>;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() }));
  } catch {
    res.markedMissing = db
      .update(chapter)
      .set({ fileMissing: true })
      .where(and(eq(chapter.novelId, n.id), eq(chapter.fileMissing, false)))
      .run().changes;
    res.error = `章节目录不可读：${dir}`;
    return res;
  }

  const { chapters: files, issues } = classifyChapterEntries(entries);
  const existing = new Map(db.select().from(chapter).where(eq(chapter.novelId, n.id)).all().map((c) => [c.seq, c]));
  const seen = new Set<number>();

  db.$client.transaction(() => {
    for (const f of files) {
      seen.add(f.seq);
      const outcome = syncFile(db, n.id, dir, f, existing.get(f.seq), !!opts.force, issues);
      if (outcome === 'added') res.added++;
      else if (outcome === 'updated') res.updated++;
      else if (outcome === 'restored') res.restored++;
    }
    for (const [seq, c] of existing) {
      if (!seen.has(seq) && !c.fileMissing) {
        db.update(chapter).set({ fileMissing: true }).where(eq(chapter.id, c.id)).run();
        res.markedMissing++;
      }
    }
    db.delete(scanIssue).where(eq(scanIssue.novelId, n.id)).run();
    for (const i of issues) db.insert(scanIssue).values({ novelId: n.id, ...i }).run();
  })();
  res.issues = issues.length;
  return res;
}

/** 平台内保存后调用：强制重读该章文件。 */
export function syncChapter(db: Db, chapterId: number): { changed: boolean } {
  const ch = db.select().from(chapter).where(eq(chapter.id, chapterId)).get();
  if (!ch) throw new UserError('章节不存在');
  const dir = path.dirname(ch.filePath);
  const base = path.basename(ch.filePath);
  if (!fs.existsSync(ch.filePath)) {
    if (ch.fileMissing) return { changed: false };
    db.update(chapter).set({ fileMissing: true }).where(eq(chapter.id, ch.id)).run();
    return { changed: true };
  }
  const f: FileRef = { fileName: base, seq: ch.seq, title: parseChapterFilename(base)?.title ?? ch.title };
  const outcome = syncFile(db, ch.novelId, dir, f, ch, true, []);
  return { changed: outcome === 'updated' || outcome === 'restored' || outcome === 'added' };
}

export interface FullSyncSummary extends ScanSummary {
  chapters: { added: number; updated: number; restored: number; markedMissing: number };
  issues: number;
  errors: string[];
}

export function scanAndSync(db: Db): FullSyncSummary {
  const scan = scanLibrary(db);
  const out: FullSyncSummary = {
    ...scan,
    chapters: { added: 0, updated: 0, restored: 0, markedMissing: 0 },
    issues: 0,
    errors: [],
  };
  for (const n of db.select().from(novel).where(eq(novel.archived, false)).all()) {
    try {
      const r = syncNovel(db, n.id);
      out.chapters.added += r.added;
      out.chapters.updated += r.updated;
      out.chapters.restored += r.restored;
      out.chapters.markedMissing += r.markedMissing;
      out.issues += r.issues;
      if (r.error) out.errors.push(`${n.name}：${r.error}`);
    } catch (e) {
      out.errors.push(`${n.name}：${(e as Error).message}`);
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/sync.test.ts`
Expected: 全部 PASS。若 AC2.9 失败，检查 `syncFile` 的 `unchanged` 判定是否把 `mtimeMs/sizeBytes` 一并比较；若 `put()` 相关用例失败，检查是否忘记推进 mtime。

- [ ] **Step 5: 提交** —— `git add src/lib/sync.* && git commit -m "feat(sync): filesystem to database chapter sync"`

---

### Task 6: 章节查询与编辑（`chapters.ts`）

**Files:**
- Create: `src/lib/chapters.ts`
- Test: `src/lib/chapters.test.ts`

**Interfaces:**
- Consumes: `readChapterFile, writeChapterFileAtomic`；`syncChapter`；`UserError`。
- Produces（**名称固定**）：
  - `listChapters(db, novelId: number): Chapter[]`（按 `seq` 升序）
  - `interface ProblemFile { fileName: string; reason: string; stored: boolean }` 与 `listProblems(db, novelId): ProblemFile[]` —— 合并 `scan_issue`（`stored:false`）与带 `warning` 的章节（`stored:true`）
  - `interface EditorData { chapter: Chapter; content: string; baseHash: string | null; readError: string | null }` 与 `loadChapterForEdit(db, chapterId): EditorData` —— `content` 为 LF 文本；文件缺失时 `content=''`、`baseHash=null`
  - `CONFLICT_MESSAGE = '文件已被外部修改'`
  - `saveChapter(db, chapterId, content: string, opts: { baseHash: string; overwrite?: boolean }): { wordCount: number; baseHash: string }`

警告文案映射：`h1_mismatch` → `H1 章号与文件名不符，已入库`；`no_h1` → `缺少 H1，已入库，标题取自文件名`；`encoding` → `编码不支持，字数与状态未更新`。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/chapters.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chapter } from '@/db/schema';
import { insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { CONFLICT_MESSAGE, listChapters, listProblems, loadChapterForEdit, saveChapter } from './chapters';
import { syncNovel } from './sync';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(files: Record<string, string>) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  syncNovel(db, n.id);
  return { db, dir: t.dir, n, ch: () => listChapters(db, n.id) };
}

describe('listProblems', () => {
  it('合并未识别文件与带警告的章节', () => {
    const { db, n } = setup({ 'Ch01-甲.md': '# 第9章 错号\nx', 'Ch02-乙.md': '无标题', 'notes.md': 'x' });
    const p = listProblems(db, n.id);
    expect(p).toEqual([
      { fileName: 'notes.md', reason: '文件名不符合 ChNN-标题.md，未入库', stored: false },
      { fileName: 'Ch01-甲.md', reason: 'H1 章号与文件名不符，已入库', stored: true },
      { fileName: 'Ch02-乙.md', reason: '缺少 H1，已入库，标题取自文件名', stored: true },
    ]);
  });
});

describe('loadChapterForEdit / saveChapter', () => {
  it('AC2.6 保存写回文件并更新字数/hash', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\n原文。\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    expect(e.content).toBe('# 第1章 开端\n\n原文。\n');
    const r = saveChapter(db, e.chapter.id, '# 第1章 开端\n\n改后的正文内容。\n', { baseHash: e.baseHash! });
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toBe('# 第1章 开端\n\n改后的正文内容。\n');
    expect(r.wordCount).toBe(8); // "改后的正文内容。"
    expect(ch()[0].wordCount).toBe(8);
    expect(ch()[0].contentHash).not.toBe(e.chapter.contentHash);
  });

  it('保持 CRLF 风格', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\r\n\r\n原文。\r\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    expect(e.content).not.toContain('\r');
    saveChapter(db, e.chapter.id, '# 第1章 开端\n\n新。\n', { baseHash: e.baseHash! });
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toBe('# 第1章 开端\r\n\r\n新。\r\n');
  });

  it('AC2.7 只读文件：报错、数据库不变', () => {
    if (process.getuid?.() === 0) return;
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\n原文。\n' });
    const before = ch()[0];
    const e = loadChapterForEdit(db, before.id);
    fs.chmodSync(path.join(dir, 'Ch01-开端.md'), 0o444);
    expect(() => saveChapter(db, before.id, '改', { baseHash: e.baseHash! })).toThrow('保存失败，文件未被修改');
    expect(ch()[0]).toEqual(before);
  });

  it('AC2.10 外部修改 → 冲突；overwrite=true 可覆盖', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\n原文。\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    fs.writeFileSync(path.join(dir, 'Ch01-开端.md'), '# 第1章 开端\n\n别处改了。\n');
    expect(() => saveChapter(db, e.chapter.id, '# 第1章 开端\n\n我的。\n', { baseHash: e.baseHash! })).toThrow(CONFLICT_MESSAGE);
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toContain('别处改了');
    saveChapter(db, e.chapter.id, '# 第1章 开端\n\n我的。\n', { baseHash: e.baseHash!, overwrite: true });
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toContain('我的');
  });

  it('F2.20 文件丢失：不可编辑', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\nx\n' });
    fs.rmSync(path.join(dir, 'Ch01-开端.md'));
    syncNovel(db, ch()[0].novelId);
    const e = loadChapterForEdit(db, ch()[0].id);
    expect([e.content, e.baseHash]).toEqual(['', null]);
    expect(() => saveChapter(db, e.chapter.id, 'x', { baseHash: 'x' })).toThrow('文件丢失，无法编辑');
  });

  it('保存后返回的 baseHash 可用于连续保存', () => {
    const { db, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\na\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    const r1 = saveChapter(db, e.chapter.id, '# 第1章 开端\n\nb\n', { baseHash: e.baseHash! });
    expect(() => saveChapter(db, e.chapter.id, '# 第1章 开端\n\nc\n', { baseHash: r1.baseHash })).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败** —— `npx vitest run src/lib/chapters.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/chapters.ts
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, scanIssue, type Chapter } from '@/db/schema';
import { readChapterFile, writeChapterFileAtomic } from './file-io';
import { UserError } from './result';
import { syncChapter } from './sync';

export const CONFLICT_MESSAGE = '文件已被外部修改';

const WARNING_TEXT = {
  h1_mismatch: 'H1 章号与文件名不符，已入库',
  no_h1: '缺少 H1，已入库，标题取自文件名',
  encoding: '编码不支持，字数与状态未更新',
} as const;

export function listChapters(db: Db, novelId: number): Chapter[] {
  return db.select().from(chapter).where(eq(chapter.novelId, novelId)).orderBy(asc(chapter.seq)).all();
}

export interface ProblemFile {
  fileName: string;
  reason: string;
  stored: boolean;
}

export function listProblems(db: Db, novelId: number): ProblemFile[] {
  const issues = db.select().from(scanIssue).where(eq(scanIssue.novelId, novelId)).orderBy(asc(scanIssue.fileName)).all();
  const warned = listChapters(db, novelId).filter((c) => c.warning);
  return [
    ...issues.map((i) => ({ fileName: i.fileName, reason: i.reason, stored: false })),
    ...warned.map((c) => ({ fileName: path.basename(c.filePath), reason: WARNING_TEXT[c.warning!], stored: true })),
  ];
}

export interface EditorData {
  chapter: Chapter;
  content: string;
  baseHash: string | null;
  readError: string | null;
}

function getChapter(db: Db, id: number): Chapter {
  const ch = db.select().from(chapter).where(eq(chapter.id, id)).get();
  if (!ch) throw new UserError('章节不存在');
  return ch;
}

export function loadChapterForEdit(db: Db, chapterId: number): EditorData {
  const ch = getChapter(db, chapterId);
  if (ch.fileMissing) return { chapter: ch, content: '', baseHash: null, readError: null };
  try {
    const r = readChapterFile(ch.filePath);
    if (!r.ok) return { chapter: ch, content: '', baseHash: null, readError: '编码不支持：文件不是 UTF-8' };
    return { chapter: ch, content: r.text.replace(/\r\n/g, '\n'), baseHash: r.rawHash, readError: null };
  } catch (e) {
    return { chapter: ch, content: '', baseHash: null, readError: `无法读取文件：${(e as Error).message}` };
  }
}

export function saveChapter(
  db: Db,
  chapterId: number,
  content: string,
  opts: { baseHash: string; overwrite?: boolean },
): { wordCount: number; baseHash: string } {
  const ch = getChapter(db, chapterId);
  if (ch.fileMissing) throw new UserError('文件丢失，无法编辑');

  const current = readChapterFile(ch.filePath);
  if (!current.ok) throw new UserError('编码不支持：文件不是 UTF-8，无法保存');
  if (!opts.overwrite && current.rawHash !== opts.baseHash) throw new UserError(CONFLICT_MESSAGE);

  // 先写文件；失败则抛出，数据库保持不变
  try {
    writeChapterFileAtomic(ch.filePath, content.replace(/\r\n/g, '\n'), { hasBom: current.hasBom, eol: current.eol });
  } catch (e) {
    throw new UserError(`保存失败，文件未被修改：${(e as Error).message}`);
  }
  syncChapter(db, chapterId);

  const after = readChapterFile(ch.filePath);
  return { wordCount: getChapter(db, chapterId).wordCount, baseHash: after.ok ? after.rawHash : '' };
}
```

- [ ] **Step 4: 运行确认通过** —— `npx vitest run src/lib/chapters.test.ts` → PASS。

- [ ] **Step 5: 提交** —— `git add src/lib/chapters.* && git commit -m "feat(chapters): listing, problems, editor load/save"`

---

### Task 7: 接线 Server Action（同步入 REQ-01 的 Action）+ 保存 Action

**Files:**
- Modify: `src/app/actions/library.ts`（整体替换为下方内容）
- Create: `src/app/actions/chapters.ts`

**Interfaces:**
- Produces:
  - `rescanAction(): ActionResult<FullSyncSummary>`（执行 `scanAndSync`）
  - `setArchivedAction`：取消归档时立即 `syncNovel`（F1.10）
  - `setChapterSubdirAction`：保存后立即 `syncNovel(…, { force: true })`（F1.11）
  - `rescanNovelAction(novelId: number): ActionResult<SyncResult>`（卡片菜单「重新扫描此书」/ 详情页「重新扫描」，强制重读）
  - `saveChapterAction(chapterId: number, content: string, baseHash: string, overwrite?: boolean): ActionResult<{ wordCount: number; baseHash: string }>`

- [ ] **Step 1: 替换 `src/app/actions/library.ts`**

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { addRoot, removeRoot, setArchived, setChapterSubdir } from '@/lib/library';
import { scanAndSync, syncNovel } from '@/lib/sync';

function refresh() {
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/novels/[id]', 'page');
}

export async function addRootAction(input: string) {
  return wrap(() => {
    const r = addRoot(getDb(), input);
    refresh();
    return r;
  });
}

export async function removeRootAction(id: number) {
  return wrap(() => {
    removeRoot(getDb(), id);
    refresh();
  });
}

export async function rescanAction() {
  return wrap(() => {
    const s = scanAndSync(getDb());
    refresh();
    return s;
  });
}

export async function rescanNovelAction(novelId: number) {
  return wrap(() => {
    const r = syncNovel(getDb(), novelId, { force: true });
    refresh();
    return r;
  });
}

export async function setArchivedAction(novelId: number, archived: boolean) {
  return wrap(() => {
    const db = getDb();
    const n = setArchived(db, novelId, archived);
    if (!archived) syncNovel(db, novelId);
    refresh();
    return { name: n.name };
  });
}

export async function setChapterSubdirAction(novelId: number, subdir: string) {
  return wrap(() => {
    const db = getDb();
    setChapterSubdir(db, novelId, subdir);
    syncNovel(db, novelId, { force: true });
    refresh();
  });
}
```

- [ ] **Step 2: 写 `src/app/actions/chapters.ts`**

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { saveChapter } from '@/lib/chapters';
import { wrap } from '@/lib/result';

export async function saveChapterAction(chapterId: number, content: string, baseHash: string, overwrite = false) {
  return wrap(() => {
    const r = saveChapter(getDb(), chapterId, content, { baseHash, overwrite });
    revalidatePath('/');
    revalidatePath('/novels/[id]', 'page');
    revalidatePath('/novels/[id]/chapters/[cid]', 'page');
    return r;
  });
}
```

- [ ] **Step 3: 类型检查并提交**

Run: `npx tsc --noEmit && npm test` → Expected: 无错误、全部测试通过。

```bash
git add src/app/actions
git commit -m "feat(sync): wire sync into server actions"
```

---

### Task 8: 编辑页与问题文件提示

**Files:**
- Create: `src/components/problem-files.tsx`, `src/components/chapter-editor.tsx`, `src/app/novels/[id]/chapters/[cid]/page.tsx`

**Interfaces:**
- Consumes: `loadChapterForEdit, listProblems, syncChapter`、`saveChapterAction`、`CONFLICT_MESSAGE`、`countWords/toPublishBody`（纯函数可在客户端使用）。
- Produces:
  - `<ProblemFiles problems={ProblemFile[]} />`（服务端组件；`problems` 为空时不渲染）—— REQ-03 的详情页挂载
  - `<ChapterEditor ... aside?: ReactNode />` —— REQ-03 通过 `aside` 传入平台状态卡，REQ-05 在其顶部工具栏加入复制按钮
  - 路由 `/novels/[id]/chapters/[cid]`

- [ ] **Step 1: 问题文件折叠提示**

```tsx
// src/components/problem-files.tsx
import type { ProblemFile } from '@/lib/chapters';

export function ProblemFiles({ problems }: { problems: ProblemFile[] }) {
  if (problems.length === 0) return null;
  return (
    <details className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm">
      <summary className="cursor-pointer">{problems.length} 个文件需要处理，不影响其他章节</summary>
      <ul className="mt-2 space-y-1">
        {problems.map((p) => (
          <li key={`${p.fileName}-${p.reason}`}>
            <span className="font-mono">{p.fileName}</span> —— {p.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
```

- [ ] **Step 2: 编辑器客户端组件**

```tsx
// src/components/chapter-editor.tsx
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { saveChapterAction } from '@/app/actions/chapters';
import { CONFLICT_MESSAGE } from '@/lib/chapters-constants';
import { countWords, toPublishBody } from '@/lib/publish';

interface Props {
  novelId: number;
  novelName: string;
  chapterId: number;
  heading: string; // 例：第3章 开端
  filePath: string;
  initialContent: string;
  initialBaseHash: string | null;
  fileMissing: boolean;
  readError: string | null;
  aside?: React.ReactNode;
}

export function ChapterEditor(p: Props) {
  const router = useRouter();
  const [content, setContent] = useState(p.initialContent);
  const [saved, setSaved] = useState(p.initialContent);
  const [baseHash, setBaseHash] = useState(p.initialBaseHash);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, start] = useTransition();

  const disabled = p.fileMissing || !!p.readError;
  const dirty = content !== saved;
  const words = countWords(toPublishBody(content));

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = (overwrite = false) =>
    start(async () => {
      if (!baseHash) return;
      setError('');
      const r = await saveChapterAction(p.chapterId, content, baseHash, overwrite);
      if (!r.ok) {
        if (r.error === CONFLICT_MESSAGE) setConflict(true);
        else setError(r.error);
        return;
      }
      setConflict(false);
      setSaved(content);
      setBaseHash(r.data.baseHash);
      setJustSaved(true);
      router.refresh(); // 刷新右侧平台状态卡（可能变为「需更新」）
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <Link className="text-sm underline" href={`/novels/${p.novelId}`}>← {p.novelName}</Link>
          <h1 className="font-serif text-xl">{p.heading}</h1>
          <div className="font-mono text-xs text-stone-500">{p.filePath}</div>
        </div>
        {/* REQ-05 在此加入「复制标题+正文」按钮 */}
        <button
          className="rounded bg-stone-900 px-4 text-white disabled:opacity-40"
          disabled={disabled || !dirty || pending}
          onClick={() => save()}
        >
          {pending ? '保存中…' : '保存'}
        </button>
      </div>

      {p.fileMissing && <Banner kind="error">文件丢失，无法编辑</Banner>}
      {p.readError && <Banner kind="error">{p.readError}</Banner>}
      {error && (
        <Banner kind="error">
          保存失败，文件未被修改：{error.replace('保存失败，文件未被修改：', '')}{' '}
          <button className="underline" onClick={() => save()}>重试保存</button>
        </Banner>
      )}
      {conflict && (
        <Banner kind="warn">
          文件已被外部修改{' '}
          <button className="underline" onClick={() => save(true)}>覆盖磁盘文件</button>{' '}
          <button className="underline" onClick={() => router.refresh()}>放弃并重新加载</button>
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <textarea
            className="min-h-[60vh] w-full resize-y rounded border bg-white p-4 font-serif leading-8 disabled:bg-stone-100"
            value={content}
            disabled={disabled}
            onChange={(e) => { setContent(e.target.value); setJustSaved(false); }}
          />
          <div className="flex justify-between font-mono text-xs text-stone-600">
            <span>{words} 字</span>
            <span>{dirty ? '未保存修改' : justSaved ? '已写回文件，字数与状态已更新' : '与文件一致'}</span>
          </div>
        </div>
        <aside className="space-y-3">{p.aside}</aside>
      </div>
    </div>
  );
}

function Banner({ kind, children }: { kind: 'error' | 'warn'; children: React.ReactNode }) {
  const cls = kind === 'error' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900';
  return <div role="alert" className={`rounded border px-4 py-2 text-sm ${cls}`}>{children}</div>;
}
```

> **客户端不能 import 含 `node:` 模块的文件**：`chapters.ts` 依赖 `node:path`/fs，故上面从 `@/lib/chapters-constants` 引用常量。因此要新建 `src/lib/chapters-constants.ts`：`export const CONFLICT_MESSAGE = '文件已被外部修改';`，并把 `chapters.ts` 中的定义改为 `import { CONFLICT_MESSAGE } from './chapters-constants'; export { CONFLICT_MESSAGE };`（`chapters.test.ts` 仍从 `./chapters` 导入，不受影响）。`publish.ts` 无 node 依赖，可以直接在客户端使用。

- [ ] **Step 3: 页面**

```tsx
// src/app/novels/[id]/chapters/[cid]/page.tsx
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { novel } from '@/db/schema';
import { loadChapterForEdit } from '@/lib/chapters';
import { platformTitle } from '@/lib/publish';
import { syncChapter } from '@/lib/sync';
import { ChapterEditor } from '@/components/chapter-editor';

export const dynamic = 'force-dynamic';

export default async function ChapterPage({ params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  const db = getDb();
  const novelId = Number(id);
  const chapterId = Number(cid);
  if (!Number.isInteger(novelId) || !Number.isInteger(chapterId)) notFound();

  try {
    syncChapter(db, chapterId); // F2.8：打开时保证库与磁盘一致
  } catch {
    notFound();
  }
  const data = loadChapterForEdit(db, chapterId);
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n || data.chapter.novelId !== novelId) notFound();

  return (
    <ChapterEditor
      novelId={n.id}
      novelName={n.name}
      chapterId={data.chapter.id}
      heading={platformTitle(data.chapter.seq, data.chapter.title)}
      filePath={data.chapter.filePath}
      initialContent={data.content}
      initialBaseHash={data.baseHash}
      fileMissing={data.chapter.fileMissing}
      readError={data.readError}
      aside={null /* REQ-03 在此传入 <PlatformCards /> */}
    />
  );
}
```

- [ ] **Step 4: 手动验证（AC2.6 / 2.7 / 2.10）**

准备 `/tmp/nh-lib/书A/Ch01-开端.md`（内容 `# 第1章 开端\n\n你好，世界。`），在设置页添加 `/tmp/nh-lib`。通过 `sqlite3 data/novel-hub.db "select id from chapter"` 取章节 id（详情页在 REQ-03 才有，此处直接访问 `/novels/1/chapters/1`）：
1. 页面显示原文；改字后状态栏变「未保存修改」，保存按钮可用，关闭标签页有浏览器确认。
2. 保存 → 磁盘文件内容更新，状态栏「已写回文件，字数与状态已更新」，字数变化。
3. `chmod 444` 该文件后保存 → 红色提示「保存失败，文件未被修改：…」，输入框内容仍在，有「重试保存」。
4. 页面打开后用外部编辑器改该文件，再点保存 → 黄色冲突提示，两个按钮均可用。
5. 删除文件后刷新 → 「文件丢失，无法编辑」，保存不可用。

- [ ] **Step 5: 提交**

```bash
git add src/components src/app/novels src/lib/chapters-constants.ts src/lib/chapters.ts
git commit -m "feat(chapters): editor page and problem files panel"
```

---

## Self-Review

- 覆盖：F2.1–2.9（Task 5）、F2.10–2.12（Task 1–2）、F2.13–2.21（Task 4/6/8）、F2.22（`listChapters`）、F2.24–2.26（Task 3/5/6/8）；AC2.1–2.10 均有对应单测或手动步骤。F2.23（章号缺口提示）为可选项，未实现。
- 对 REQ-01 的移交项已在 Task 7 接线：F1.8、F1.10、F1.11。
- 已知需要执行者注意：`sync.ts` 中 `syncChapter` 的冗余变量已在提示中要求删除；`chapters-constants.ts` 的拆分用于避免客户端打包 node 模块。
- 类型一致性：`Chapter`/`ChapterWarning`/`SyncResult`/`FullSyncSummary`/`ProblemFile`/`EditorData` 在后续方案中按此名称引用。
