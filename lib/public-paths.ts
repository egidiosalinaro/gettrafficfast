/**
 * What a stranger may open on gettrafficfa.st.
 *
 * The middleware sends every other path to sign-up. A crawler that is sent
 * there receives an HTML page, which is how Search Console came to reject
 * the sitemap: /sitemap.xml was not on this list, so Google was redirected
 * at the registration form and read that as the sitemap.
 */

/**
 * `/auth/set-password` is where the reviewer account's set-password email
 * lands (lib/password-login.ts): its session may be in the URL fragment,
 * which the server never sees, so it cannot wait behind the sign-in redirect.
 */
const AUTH_PREFIXES = ["/auth/sign-up", "/auth/confirm", "/auth/error", "/auth/set-password"];

/** Indexed, and listed for crawlers. Checkout return pages are reachable but not these. */
export const CRAWLABLE_PREFIXES = [
  "/pricing",
  "/blog",
  "/docs",
  "/privacy-policy",
  "/terms-and-conditions",
] as const;

/**
 * Files a crawler must be allowed to fetch although the rest of the site is
 * closed to it. robots.txt disallows "/", and until 2026-11-10 that covered
 * these too: Google will not show a favicon it may not crawl, X will not
 * show a card image it may not fetch, and a page whose CSS and JS are
 * blocked is rendered without them. The middleware already serves them to
 * anyone; this list is only for robots.txt.
 */
export const CRAWLABLE_ASSETS = [
  "/favicon.ico",
  "/icon.svg",
  "/icon.png",
  "/apple-icon.png",
  "/og/",
  "/_next/static/",
  "/_next/image",
] as const;

/**
 * The plain-text map of the public site for language models
 * (app/llms.txt/route.ts, docs/BLOG.md "llms.txt"). Open to anyone, and
 * allowed in robots.txt although "/" is not.
 */
export const LLMS_TXT_PATH = "/llms.txt";

/**
 * Files a browser fetches without the session cookie. A manifest is fetched
 * with credentials omitted, so behind the sign-up redirect the home-screen
 * app would get an HTML page instead (app/manifest.ts).
 */
const ANONYMOUS_FILES = ["/sitemap.xml", "/robots.txt", "/manifest.webmanifest", LLMS_TXT_PATH];

/**
 * The OAuth authorization server (docs/API.md "Connect from claude.ai").
 * Its metadata, registration, token and revocation endpoints are called by
 * a machine with no cookie; the consent page checks the session itself and
 * sends a person who is not signed in to sign-up with `next` set, so they
 * come back to the same authorization request. The middleware's own
 * redirect would drop it.
 */
const OAUTH_PREFIXES = ["/.well-known/", "/oauth/"];

export function isPublicPath(pathname: string): boolean {
  if (pathname === "/" || ANONYMOUS_FILES.includes(pathname)) return true;
  if (AUTH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (OAUTH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return CRAWLABLE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
