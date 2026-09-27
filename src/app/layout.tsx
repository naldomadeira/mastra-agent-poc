import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import { OperatorSwitcher } from './_components/operator-switcher';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Commerce Agent POC',
  description: 'Agent Operating Layer com Mastra: leitura controlada, domain actions e aprovação humana.',
};

const NAV = [
  { href: '/', label: 'Agente' },
  { href: '/orders', label: 'Pedidos (sem IA)' },
  { href: '/audit', label: 'Auditoria' },
];

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="pt-BR"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-full flex-col font-sans">
        <header className="flex items-center gap-6 border-b border-zinc-200 bg-white px-6 py-3">
          <span className="font-semibold">Commerce Agent POC</span>
          <nav className="flex gap-4 text-sm text-zinc-600">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-zinc-900">
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            <OperatorSwitcher />
          </div>
        </header>
        <main className="min-h-0 flex-1">{children}</main>
      </body>
    </html>
  );
}
