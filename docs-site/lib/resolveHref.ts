/**
 * Convert documentation app routes to the path handled by the standalone docs site.
 * Next.js Link applies the configured basePath automatically for internal routes.
 * Never redirect StamCont's logo or navigation to inherited Continue services.
 */
export function resolveHref(path: string): string {
  if (path === "/docs") return "/";
  if (path.startsWith("/docs/")) return path.slice("/docs".length);
  return path;
}
