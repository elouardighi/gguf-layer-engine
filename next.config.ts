import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // instrumentation.ts is enabled by default in Next.js 15+, so no experimental
  // flag is needed to spawn the inference WebSocket service on startup.
};

export default nextConfig;
// trigger restart Mon Nov  2 18:56:19 UTC 2026
