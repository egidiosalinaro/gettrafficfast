/**
 * How a business is shown in the UI: the name a person reads, and the host
 * used to fetch the site's favicon.
 *
 * Kept in the domain layer so the switcher, tests and any later surface
 * (MCP, a mobile picker) cannot drift into three slightly different labels
 * for the same row. Hostname parsing lives here rather than in the SERP
 * provider: the UI must not import a vendor boundary to decorate a name.
 */

export interface NamedSite {
  name: string | null;
  website_url: string | null;
}

/** What the switcher (and anything else) prints for a site. */
export function businessLabel(site: NamedSite): string {
  return site.name || site.website_url || "Untitled site";
}

/**
 * Registrable-looking host of a stored website URL, or null when there is
 * nothing to show an icon for. Null, not a guessed domain: a missing URL is
 * "no icon", not "this company lives at {name}.com".
 */
export function businessHostname(websiteUrl: string | null | undefined): string | null {
  if (!websiteUrl) return null;
  try {
    const host = new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}
