import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Register the instrumentation hook (src/instrumentation.ts) which spawns
  // the inference WebSocket service as a child of the Next.js process.
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
// trigger restart Mon Nov  2 18:56:19 UTC 2026
