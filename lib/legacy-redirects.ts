/**
 * Pages that moved, and where they went. Served by `redirects()` in
 * next.config.ts, which runs before the middleware: an old link in an email,
 * a bookmark or a home-screen shortcut lands on the new page even signed
 * out, instead of on the sign-up form. Next.js carries the query string
 * across by itself.
 *
 * Temporary (307) by default: a permanent redirect is cached by the
 * browser for good, and a page that comes back would stay unreachable from
 * that browser. Permanent (308) only for a page removed for good, so search
 * engines drop the old address instead of keeping a 404 in their index.
 *
 * A plain module with no imports, so next.config.ts can read it.
 */

export interface LegacyRedirect {
  source: string;
  destination: string;
  permanent: boolean;
}

export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
  // Images & video is the second half of Autopilot since 2026-11-14.
  { source: "/settings/generation", destination: "/settings/automation#images", permanent: false },
  // The in-app Help and Contact are the public docs since 2026-11-14.
  { source: "/help", destination: "/docs", permanent: false },
  { source: "/dashboard/help", destination: "/docs", permanent: false },
  { source: "/dashboard/contact", destination: "/docs#contact", permanent: false },
  // Results and Prompts (AI Visibility) are Growth since 2026-11-14 (docs/LIFECYCLE.md, "Growth").
  { source: "/results", destination: "/growth", permanent: false },
  { source: "/visibility", destination: "/growth/ai", permanent: false },
  { source: "/visibility/settings", destination: "/growth/ai/settings", permanent: false },
  { source: "/visibility/queries/:id", destination: "/growth/ai/queries/:id", permanent: false },
  // The public Citation Index and its free check were removed on 2026-11-16
  // (docs/ARCHITECTURE.md, "Removed: the public Citation Index"); shared links
  // and search results land on the home page.
  { source: "/citation-index", destination: "/", permanent: true },
  { source: "/citation-index/:path*", destination: "/", permanent: true },
  { source: "/check", destination: "/", permanent: true },
];
