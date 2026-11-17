/**
 * How a Search Console property is shown.
 *
 * Google's siteUrl is the identity we store and send back (`sc-domain:…` or a
 * URL prefix). It is not what a person should have to read. This module is the
 * one place that turns that string into a host, a kind and a label, so the
 * picker, Results, and the tests cannot drift.
 */

import { businessHostname } from "@/lib/domain/business-display";

export type SearchConsolePropertyKind = "domain" | "url_prefix" | "unknown";

export interface SearchConsolePropertyView {
  /** The value Google and our API use. Never rewritten. */
  siteUrl: string;
  kind: SearchConsolePropertyKind;
  /** Host for a favicon, without www. Null when there is nothing to decorate. */
  host: string | null;
  /** What the row leads with: the domain, or the URL-prefix host plus path. */
  label: string;
  /** One line under the label, saying what Google will actually count. */
  detail: string;
}

function stripWww(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

function hostOfWebsite(websiteUrl: string | null | undefined): string | null {
  if (!websiteUrl?.trim()) return null;
  const trimmed = websiteUrl.trim();
  return businessHostname(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  );
}

export function describeSearchConsoleProperty(siteUrl: string): SearchConsolePropertyView {
  const raw = siteUrl.trim();
  const domainMatch = /^sc-domain:(.*)$/i.exec(raw);
  if (domainMatch) {
    const host = stripWww(domainMatch[1].trim());
    if (!host) {
      return {
        siteUrl: raw,
        kind: "unknown",
        host: null,
        label: raw,
        detail: "Search Console property",
      };
    }
    return {
      siteUrl: raw,
      kind: "domain",
      host,
      label: host,
      detail: "Entire domain, including subdomains",
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const hostLabel = url.hostname.toLowerCase();
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
      return {
        siteUrl: raw,
        kind: "url_prefix",
        host: stripWww(hostLabel) || null,
        label: path ? `${hostLabel}${path}` : hostLabel,
        detail: "This URL prefix only",
      };
    } catch {
      /* fall through */
    }
  }

  return {
    siteUrl: raw,
    kind: "unknown",
    host: hostOfWebsite(raw),
    label: raw || "Unknown property",
    detail: "Search Console property",
  };
}

/** The host a person should read, or null when there is no property yet. */
export function searchConsolePropertyLabel(
  siteUrl: string | null | undefined
): string | null {
  if (!siteUrl?.trim()) return null;
  return describeSearchConsoleProperty(siteUrl).label;
}

/**
 * Whether this property would report traffic for the selected business.
 *
 * A domain property covers the host and its subdomains. A URL-prefix property
 * covers that host (www ignored for the comparison, because that is how people
 * store website_url), not a sibling domain.
 */
export function propertyCoversHost(
  siteUrl: string,
  websiteUrl: string | null | undefined
): boolean {
  const businessHost = hostOfWebsite(websiteUrl);
  if (!businessHost) return false;
  const view = describeSearchConsoleProperty(siteUrl);
  if (!view.host) return false;
  if (view.kind === "domain") {
    return businessHost === view.host || businessHost.endsWith(`.${view.host}`);
  }
  if (view.kind === "url_prefix") {
    return businessHost === view.host;
  }
  return false;
}

export function permissionLabel(level: string | null | undefined): string | null {
  switch ((level ?? "").toLowerCase()) {
    case "siteowner":
      return "Owner";
    case "sitefulluser":
      return "Full";
    case "siterestricteduser":
      return "Restricted";
    case "siteunverifieduser":
      return "Unverified";
    default:
      return null;
  }
}

function kindRank(kind: SearchConsolePropertyKind): number {
  if (kind === "domain") return 0;
  if (kind === "url_prefix") return 1;
  return 2;
}

/**
 * Properties that cover the selected business first, domain properties before
 * URL prefixes, then A–Z by the label a person reads. The raw siteUrl is not
 * rewritten; this is display order only.
 */
export function sortSearchConsoleSites<T extends { siteUrl: string }>(
  sites: T[],
  websiteUrl: string | null | undefined
): T[] {
  return [...sites].sort((a, b) => {
    const aCovers = propertyCoversHost(a.siteUrl, websiteUrl) ? 0 : 1;
    const bCovers = propertyCoversHost(b.siteUrl, websiteUrl) ? 0 : 1;
    if (aCovers !== bCovers) return aCovers - bCovers;
    const aView = describeSearchConsoleProperty(a.siteUrl);
    const bView = describeSearchConsoleProperty(b.siteUrl);
    const byKind = kindRank(aView.kind) - kindRank(bView.kind);
    if (byKind !== 0) return byKind;
    return aView.label.localeCompare(bView.label);
  });
}
