// 仅浏览器端使用
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export async function copyAsync(getText: () => Promise<string>): Promise<{ ok: boolean; text: string }> {
  const textPromise = getText();
  textPromise.catch(() => {}); // 避免第一条路径失败时出现未处理的 rejection；真正的异常在下面 await 时抛出
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': textPromise.then((t) => new Blob([t], { type: 'text/plain' })) }),
      ]);
      return { ok: true, text: await textPromise };
    } catch {
      /* 继续降级 */
    }
  }
  const text = await textPromise;
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, text };
  } catch {
    return { ok: legacyCopy(text), text };
  }
}
