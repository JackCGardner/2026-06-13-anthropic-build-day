import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The synthetic tool agents and the Agent SDK are server-only packages.
  // Keep them external so Next does not attempt to bundle them for the client.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "@vercel/sandbox"],
};

export default nextConfig;
