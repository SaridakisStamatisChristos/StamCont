/** @type {import('next').NextConfig} */

// Build for a subpath (e.g. /StamCont on project GitHub Pages) when set.
// Local development remains at the root unless the variable is supplied.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath || undefined,
  // Expose the base path to client/runtime code so raw string asset paths
  // (search index fetch, <img> src, etc.) can be prefixed manually — Next only
  // applies basePath automatically to <Link>, next/image and /_next assets.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
