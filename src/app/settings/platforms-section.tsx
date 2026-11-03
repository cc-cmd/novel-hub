import { getDb } from '@/db';
import { authSummaryOf, hasAuthFailure } from '@/lib/platform-auth';
import { listPlatforms, SYNC_PLATFORM } from '@/lib/platforms';
import { AddPlatformForm } from './add-platform-form';
import { PlatformRow } from './platform-row';

export function PlatformsSection() {
  const db = getDb();
  const platforms = listPlatforms(db);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">发布平台</h2>
      <ul className="divide-y rounded border bg-white px-4">
        {platforms.map((p) => (
          <PlatformRow
            key={p.id} id={p.id} name={p.name} builtin={p.builtin} boundNovels={p.boundNovels}
            syncSupported={p.name === SYNC_PLATFORM} authSummary={authSummaryOf(p)}
            authFailed={p.name === SYNC_PLATFORM && hasAuthFailure(db, p.id)}
            useAi={p.useAi} dailyWordLimit={p.dailyWordLimit}
          />
        ))}
      </ul>
      <AddPlatformForm />
    </section>
  );
}
