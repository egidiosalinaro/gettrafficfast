/**
 * Facts about this deployment that the code has to state out loud.
 *
 * The public origin comes from NEXT_PUBLIC_SITE_URL, never from VERCEL_URL:
 * on Vercel that variable is the DEPLOYMENT url, which sits behind the auth
 * wall (the same trap documented in app/layout.tsx). Unset, it is the
 * hosted product's origin; a self-hosted deployment sets its own.
 */
export const DEFAULT_SITE_URL = "https://gettrafficfa.st";

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");

/** The host part of SITE_URL ("gettrafficfa.st"), for analytics and user agents. */
export const SITE_HOST = new URL(SITE_URL).host;

/**
 * The product's name where a device shows it on its own: the home-screen
 * icon (app/manifest.ts, appleWebApp in app/layout.tsx) and the page title.
 */
export const SITE_NAME = "GetTrafficFast";

/**
 * What GetTrafficFast is, in one paragraph: the opening of the public docs
 * (components/docs/docs-content.tsx) and of /llms.txt. Every clause is
 * something the product does today; no result of its own is quoted (the
 * owner's rule, 2026-11-12).
 */
export const SITE_SUMMARY =
  "GetTrafficFast (GTF) helps people find your business: on Google, in AI answers, and in the threads where your buyers ask questions. You connect one site. GTF finds the conversations worth answering, drafts replies in your voice, writes the articles for your blog, and measures what happened. You post the replies yourself.";

/**
 * The light theme's page colour, `--background: 0 0% 98%` in
 * app/globals.css, as hex. The browser chrome uses it on a light device
 * (lib/theme.ts), and the home-screen app's splash always does: a manifest
 * cannot follow the device's colour scheme.
 */
export const APP_BACKGROUND = "#fafafa";

/**
 * The dark theme's page colour, `--background: 0 0% 10%` in the `.dark`
 * block of app/globals.css, as hex. The browser chrome uses it on a dark
 * device (lib/theme.ts).
 */
export const APP_BACKGROUND_DARK = "#1a1a1a";

/**
 * The public inbox a human actually reads. One address, every surface:
 * NEXT_PUBLIC_CONTACT_EMAIL, set per deployment. The placeholder below only
 * shows on a deployment that has not set it; do not add a second address
 * beside it.
 */
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL || "support@example.com";

/**
 * The first name of the person who runs this deployment and answers the
 * support inbox, where the public pages say who reads it
 * (NEXT_PUBLIC_OPERATOR_NAME). Unset, the pages speak of "the maintainer".
 */
export const OPERATOR_NAME = process.env.NEXT_PUBLIC_OPERATOR_NAME || "";

/**
 * This site's own webhook receiver. Customer sites store the shared secret as
 * GTF_WEBHOOK_SECRET; this repo uses BLOG_WEBHOOK_SECRET because it is both
 * the platform and the receiving site.
 */
export const OWN_WEBHOOK_PATH = "/api/gettrafficfast";

export function ownWebhookUrl(): string {
  return `${SITE_URL}${OWN_WEBHOOK_PATH}`;
}

function canonicalOriginAndPath(url: string): { host: string; path: string } | null {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host.toLowerCase(),
      path: parsed.pathname.replace(/\/+$/, "") || "/",
    };
  } catch {
    return null;
  }
}

/** True when `url` is this deployment's own receiver, not a customer's. */
export function isOwnWebhookReceiver(url: string): boolean {
  const got = canonicalOriginAndPath(url);
  const own = canonicalOriginAndPath(ownWebhookUrl());
  return Boolean(got && own && got.host === own.host && got.path === own.path);
}

/** True when a business website_url is this product's own domain. */
export function isOwnSite(websiteUrl: string | null | undefined): boolean {
  if (!websiteUrl) return false;
  const got = canonicalOriginAndPath(websiteUrl);
  const own = canonicalOriginAndPath(SITE_URL);
  return Boolean(got && own && got.host === own.host);
}
