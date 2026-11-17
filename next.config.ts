import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { LEGACY_REDIRECTS } from "./lib/legacy-redirects";

const nextConfig: NextConfig = {
  // Pages that moved keep their old links working (lib/legacy-redirects.ts).
  async redirects() {
    return [...LEGACY_REDIRECTS];
  },
  // `next dev` detects a coding agent and appends a managed block of Next.js
  // rules to AGENTS.md. AGENTS.md is this repository's engineering contract,
  // edited by hand: nothing generated belongs in it. With this off, `next dev`
  // only removes such a block if one was written earlier.
  agentRules: false,
  // The OAuth consent screen (app/oauth/authorize) must not be framed by
  // another site, where a click on a hidden Allow would grant access. Its
  // referrer stays on this site, so the decision POST carries an Origin the
  // route can check (a `no-referrer` policy would send `Origin: null`).
  async headers() {
    return [
      {
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  images: {
    // Hero images on this site's own blog are served from the platform's
    // Supabase storage, which is where the pipeline puts every generated
    // image. The host comes from the project URL rather than being typed out,
    // so a project move does not silently break every hero.
    remotePatterns: process.env.NEXT_PUBLIC_SUPABASE_URL
      ? [
          {
            protocol: "https" as const,
            hostname: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname,
            pathname: "/storage/v1/object/public/**",
          },
        ]
      : [],
  },
};

export default withSentryConfig(nextConfig, {
  // The Sentry organization and project receiving source maps, per
  // deployment. Source-map upload only runs when SENTRY_AUTH_TOKEN is set
  // (e.g. on Vercel); without it the build still succeeds, just without
  // readable stack traces.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  // SDK debug logging is stripped from the bundle (was `disableLogger` before v11).
  bundleSizeOptimizations: { excludeDebugStatements: true },
});
