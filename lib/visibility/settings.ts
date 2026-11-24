import { z } from "zod";
import { domainOf } from "@/lib/providers/citations/types";

/**
 * Per-business AI Visibility preferences, stored in `businesses.aeo_settings`.
 *
 * Three things a probe needs to know before it can be judged: what counts as
 * "us" (domains and brand names), which engines to ask, and how often. None of
 * them can be inferred safely — a business's own domain is on the row, but its
 * blog may live on a subdomain, its brand may have two spellings, and the
 * engines it is willing to pay for are its decision, not the platform's.
 */

export const AEO_CADENCES = ["off", "weekly", "monthly"] as const;
export type AeoCadence = (typeof AEO_CADENCES)[number];

export const AEO_INTENTS = ["informational", "commercial", "comparison", "navigational"] as const;
export type AeoIntent = (typeof AEO_INTENTS)[number];

/**
 * New rows of the Replies inbox one run's cited sources may create
 * (lib/visibility/sources-to-targets.ts). The rest waits for the next run.
 * Here, beside the other per-run ceilings, so a screen can name it without
 * loading the selection.
 */
export const MAX_NEW_TARGETS_PER_RUN = 10;

/** Hard ceiling on queries asked per run, so a bulk import cannot bill a month. */
export const MAX_QUERIES_PER_RUN = 60;

export const AeoSettings = z.object({
  /** Spellings of the brand an engine might use in prose. */
  brandNames: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  /**
   * Domains that count as the business being cited, beside the site itself.
   * Subdomains match automatically; a separate blog domain has to be listed.
   */
  domains: z.array(z.string().trim().min(1).max(253)).max(10).default([]),
  /** Engines to ask. Empty means every engine the platform has configured. */
  engines: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /**
   * Weekly by default since 2026-11-24 (the owner: product features are on).
   * The probes are the platform's: which engines exist is the deployment's
   * own opt-in (an engine is configured only by its env settings,
   * docs/CITATIONS.md), so with none nothing is asked. "off" is the person's
   * opt-out and is kept; "monthly" asks less.
   */
  cadence: z.enum(AEO_CADENCES).default("weekly"),
  maxQueriesPerRun: z.number().int().min(1).max(MAX_QUERIES_PER_RUN).default(30),
  /**
   * After each run, pages the answers cited where the site was not cited
   * become candidates in the Replies inbox (lib/visibility/places.ts). On
   * by default (the owner, 2026-11-13): creating them is free, it reads the
   * stored answers and asks no engine or model, and a row it creates is
   * `qualified` with no angle, which no job drafts or judges by itself. The
   * paid step, a draft, stays on a person's tap. A stored `false` is the
   * owner's choice and is kept. The `find_places_from_last_run` tool does
   * the same once, by hand, whatever this says.
   */
  placesFromSources: z.boolean().default(true),
});

export type AeoSettings = z.infer<typeof AeoSettings>;

export const DEFAULT_AEO_SETTINGS: AeoSettings = AeoSettings.parse({});

/**
 * Tolerant read: a malformed column falls back to the defaults (a weekly
 * run, the places step on).
 */
export function parseAeoSettings(value: unknown): AeoSettings {
  const parsed = AeoSettings.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_AEO_SETTINGS;
}

/** What "us" means for the matcher: the site's own domain plus the extras. */
export interface BusinessIdentity {
  /** Lowercased hosts without "www.", deduplicated, site first. */
  domains: string[];
  /** Brand spellings, deduplicated, business name first. */
  brandNames: string[];
}

/**
 * Builds the identity from the business row and its settings.
 *
 * The site URL is always included: a business that forgot to list its own
 * domain must not measure a flat zero. Extras are normalised through the same
 * `domainOf` as every source URL, so "https://Blog.Example.com/" and
 * "blog.example.com" are the same entry.
 */
export function businessIdentity(
  business: { name: string | null; website_url: string | null },
  settings: AeoSettings
): BusinessIdentity {
  const domains = new Set<string>();
  const site = business.website_url ? domainOf(withScheme(business.website_url)) : "";
  if (site) domains.add(site);
  for (const raw of settings.domains) {
    const domain = domainOf(withScheme(raw));
    if (domain) domains.add(domain);
  }

  const brandNames = new Set<string>();
  const name = business.name?.trim();
  if (name) brandNames.add(name);
  for (const raw of settings.brandNames) {
    const brand = raw.trim();
    if (brand) brandNames.add(brand);
  }

  return { domains: [...domains], brandNames: [...brandNames] };
}

function withScheme(value: string): string {
  const trimmed = value.trim();
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Whether a scheduled run is due.
 *
 * Pure so the cron can be tested against a clock: `off` is never due, and a
 * cadence is due when there is no previous run or the last one started at
 * least the cadence's interval ago. Started, not finished — a run that failed
 * halfway is not a reason to bill again tomorrow.
 */
export function isRunDue(
  cadence: AeoCadence,
  lastStartedAt: string | null,
  now: Date
): boolean {
  if (cadence === "off") return false;
  if (!lastStartedAt) return true;
  const last = new Date(lastStartedAt).getTime();
  if (!Number.isFinite(last)) return true;
  const intervalDays = cadence === "weekly" ? 7 : 30;
  // A day of slack keeps a weekly run weekly when the cron fires a little
  // earlier than it did last time.
  return now.getTime() - last >= (intervalDays - 1) * 86_400_000;
}
