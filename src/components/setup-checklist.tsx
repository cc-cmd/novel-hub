import Link from 'next/link';

/** 番茄已绑定但未配置时显示（F7.23）。 */
export function SetupChecklist({ hasAuth, hasLink }: { hasAuth: boolean; hasLink: boolean }) {
  return (
    <section aria-label="开启番茄同步" className="space-y-1 rounded border bg-white p-4 text-sm">
      <h2 className="text-base font-semibold">还差一步开启番茄同步</h2>
      <p className={hasAuth ? 'text-stone-500' : ''}>{hasAuth ? '✓' : '○'} 番茄认证信息 {!hasAuth && <Link className="underline" href="/settings#fanqie">去设置</Link>}</p>
      <p className={hasLink ? 'text-stone-500' : ''}>{hasLink ? '✓' : '○'} 本书的作品链接 {!hasLink && <a className="underline" href="#manage-platforms">去填写</a>}</p>
    </section>
  );
}
