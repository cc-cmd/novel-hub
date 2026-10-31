import { getDb } from '@/db';
import { listRoots } from '@/lib/library';
import { AddRootForm } from '@/components/add-root-form';
import { RootRow } from './root-row';

export function RootsSection() {
  const roots = listRoots(getDb());
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">小说根目录</h2>
      {roots.length === 0 && <p className="text-sm text-stone-500">还没有根目录。根目录下的每个子目录会被识别为一本小说。</p>}
      <ul className="divide-y rounded border bg-white px-4">
        {roots.map((r) => <RootRow key={r.id} root={r} />)}
      </ul>
      <AddRootForm submitLabel="添加" />
    </section>
  );
}
