import { RootsSection } from './roots-section';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <div className="space-y-10">
      <h1 className="font-serif text-2xl">设置</h1>
      <RootsSection />
      {/* REQ-03 在此追加 <PlatformsSection />；REQ-05 在此追加 <CopyFormatSection /> */}
    </div>
  );
}
