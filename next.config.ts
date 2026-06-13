import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The synthetic tool agents and the Agent SDK are server-only packages.
  // Keep them external so Next does not attempt to bundle them for the client.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "@vercel/sandbox"],

  // The source uses explicit ".js" import specifiers (NodeNext-style) against
  // TypeScript files, which tsc resolves under bundler module resolution. The
  // bundlers need the same mapping so a ".js" specifier resolves to the real
  // ".ts" / ".tsx" source. Turbopack handles the dev server.
  turbopack: {
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
  },

  // webpack handles the production build.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
