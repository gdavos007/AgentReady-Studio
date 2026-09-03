import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'AgentGrade Studio',
  description:
    'Audit any site for WebMCP and AI-agent readiness: a scored report, a friction-tax benchmark, and drop-in remediation code.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* The studio registers its own WebMCP tools, so it advertises them the
            same way it tells other sites to. */}
        <link rel="mcp-manifest" href="/.well-known/mcp" type="application/json" />
        <link rel="agent-card" href="/.well-known/agent.json" type="application/json" />
      </head>
      <body className="min-h-screen bg-ground text-ink antialiased">{children}</body>
    </html>
  );
}
