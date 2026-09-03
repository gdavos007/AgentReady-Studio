import type { NextConfig } from 'next';

/**
 * The library half of this package is authored as NodeNext ESM, so its internal
 * imports carry `.js` specifiers that resolve to `.ts` on disk. `extensionAlias`
 * teaches the bundler that mapping; without it `next build` cannot resolve
 * `../scanner/engine.js`.
 *
 * Playwright is marked external: it ships platform binaries and must be
 * required at runtime from `node_modules`, never traced into a bundle.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['playwright', 'playwright-core'],

  // The studio hosts its own audit fixture so a local install can produce a
  // real, verified report with no outbound network access at all.
  async rewrites() {
    return [
      { source: '/.well-known/mcp', destination: '/api/well-known/mcp' },
      { source: '/.well-known/mcp.json', destination: '/api/well-known/mcp' },
      { source: '/.well-known/agent.json', destination: '/api/well-known/agent' },
      { source: '/llms.txt', destination: '/api/llms' },
    ];
  },

  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
  },
};

export default nextConfig;
