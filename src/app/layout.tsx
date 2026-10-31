import type { Metadata } from 'next';
import Link from 'next/link';
import { Noto_Sans_SC, Noto_Serif_SC, JetBrains_Mono } from 'next/font/google';
import { NoticeProvider } from '@/components/notice';
import './globals.css';

const sans = Noto_Sans_SC({ subsets: ['latin'], variable: '--font-sans' });
const serif = Noto_Serif_SC({ subsets: ['latin'], variable: '--font-serif', weight: ['400', '600'] });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = { title: 'Novel Hub' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        <header className="flex items-center gap-6 border-b bg-white px-6">
          <span className="font-semibold">Novel Hub</span>
          <nav className="flex gap-4 text-sm">
            <Link href="/">看板</Link>
            <Link href="/settings">设置</Link>
          </nav>
        </header>
        <NoticeProvider>
          <main className="mx-auto max-w-6xl p-6">{children}</main>
        </NoticeProvider>
      </body>
    </html>
  );
}
