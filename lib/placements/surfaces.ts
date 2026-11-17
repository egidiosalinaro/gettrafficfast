/**
 * How a discovery surface is shown to a person.
 *
 * The stored value is the canonicaliser's key ("hackernews", "devto"); what a
 * reviewer should read is the platform's name, next to the platform's icon.
 * The icon is the site's own favicon, the same way the site switcher and the
 * Search Console picker decorate a host, so no brand asset is shipped or
 * maintained here. For the network surfaces the icon follows the community
 * (ai.stackexchange.com has its own), and for a plain web page it is the
 * page's host.
 */

const LABEL: Record<string, string> = {
  reddit: "Reddit",
  github: "GitHub",
  linkedin: "LinkedIn",
  x: "X",
  hackernews: "Hacker News",
  stackexchange: "Stack Exchange",
  quora: "Quora",
  indiehackers: "Indie Hackers",
  devto: "DEV",
  web: "Web",
};

/**
 * The order a person meets the platforms in the inbox filter. X is where
 * replies actually get posted; the long tail (Stack Exchange, a bare web
 * page) stays at the bottom. A surface this list does not name sorts after
 * these, alphabetically.
 */
const SURFACE_ORDER = ["x", "reddit", "linkedin", "github", "hackernews", "devto", "indiehackers", "quora", "stackexchange", "web"];

const SURFACE_RANK = new Map(SURFACE_ORDER.map((surface, index) => [surface, index]));

export function compareSurfaces(a: string, b: string): number {
  const rank = (surface: string) => SURFACE_RANK.get(surface) ?? SURFACE_ORDER.length;
  const delta = rank(a) - rank(b);
  return delta !== 0 ? delta : a.localeCompare(b);
}

const DOMAIN: Record<string, string> = {
  reddit: "reddit.com",
  github: "github.com",
  linkedin: "linkedin.com",
  x: "x.com",
  hackernews: "news.ycombinator.com",
  stackexchange: "stackexchange.com",
  quora: "quora.com",
  indiehackers: "indiehackers.com",
  devto: "dev.to",
};

export function surfaceLabel(surface: string): string {
  return LABEL[surface] ?? surface;
}

/** A hostname-looking community: "ai.stackexchange.com", not "r/SEO" or "Quora". */
function hostLike(value: string | null | undefined): value is string {
  return Boolean(value && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value) && !value.includes("/"));
}

/**
 * The host whose favicon stands for this row, or null when there is nothing
 * honest to show (a web page with no host we recognise).
 */
export function surfaceDomain(surface: string, community: string | null | undefined): string | null {
  if (surface === "stackexchange" || surface === "web") {
    return hostLike(community) ? community : (DOMAIN[surface] ?? null);
  }
  if (surface === "quora" && hostLike(community)) return community;
  return DOMAIN[surface] ?? null;
}
