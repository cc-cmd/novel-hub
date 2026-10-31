import { formatForCopy } from '@/lib/publish';

const EXAMPLE = `# 《示例》· 第1章 · 开端

**【林舟】**

他推开门，雨声涌进来。

---

> 有人在身后说了一句话。

- 第一条线索
- 第二条线索

这是**加粗**和\`代码\`。`;

export function CopyFormatSection() {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">复制格式</h2>
      <p className="text-sm text-stone-600">
        内置格式，不可配置。「复制」输出 <code>第N章 标题</code>、空一行、再接去掉 Markdown 标记的正文；另可单独复制「仅标题」「仅正文」。
        规则：去掉首行 H1 与 <code>#</code>、<code>**</code>、<code>`</code>、<code>&gt;</code>；<code>---</code> 变空行；<code>- x</code> 变 <code>· x</code>；
        链接保留文字、图片移除；连续空行压成一个；行首缩进保留。
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-stone-500">本地文件</div>
          <pre className="whitespace-pre-wrap rounded border bg-white p-3 font-mono text-xs">{EXAMPLE}</pre>
        </div>
        <div>
          <div className="mb-1 text-xs text-stone-500">复制结果</div>
          <pre className="whitespace-pre-wrap rounded border bg-white p-3 font-mono text-xs">{formatForCopy(EXAMPLE, 1, '开端')}</pre>
        </div>
      </div>
    </section>
  );
}
