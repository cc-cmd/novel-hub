import { getDb } from '@/db';
import { listPlatforms } from '@/lib/platforms';
import { AddPlatformForm } from './add-platform-form';
import { PlatformRow } from './platform-row';

export function PlatformsSection() {
  const platforms = listPlatforms(getDb());
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">发布平台</h2>
      <ul className="divide-y rounded border bg-white px-4">
        {platforms.map((p) => <PlatformRow key={p.id} id={p.id} name={p.name} builtin={p.builtin} boundNovels={p.boundNovels} />)}
      </ul>
      <AddPlatformForm />
    </section>
  );
}
