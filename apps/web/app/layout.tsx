import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'MythWeaver',
  description: 'A self-hosted, AI-driven Dungeon Master (D&D 5e SRD).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
