import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // pdf-parse (v2) relies on a pdf.js worker file that Next's Server
  // Components bundler doesn't resolve correctly when bundled in — opt it
  // out to native require() instead.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
