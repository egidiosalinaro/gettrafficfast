import type { SupabaseClient } from "@supabase/supabase-js";
import { domainOf } from "@/lib/providers/serp/types";

/**
 * The X account a site's replies are posted from, read off the links to the
 * person's own replies: a posted X row stores `published_url`, and an X
 * status link names its author, `x.com/<handle>/status/<id>`.
 *
 * Two jobs need it: finding the link of a reply the person marked as posted
 * (search the thread for a reply from this account) and reading the
 * account's followers once a day. Nothing is asked of the person and nothing
 * is guessed: the handle is the one their own saved links carry most often,
 * and a site with no linked X reply has none (null), so both jobs skip it.
 * It is read per site, never borrowed from another site of the same person,
 * because two sites can be marketed from two accounts.
 */

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);

/** X's handle rule: 1 to 15 letters, digits or underscores. */
const HANDLE = /^\w{1,15}$/;

/** Path segments that sit where a handle would and are not one. */
const NOT_A_HANDLE = new Set(["i", "home", "search", "intent", "share", "hashtag", "explore", "settings", "messages", "notifications"]);

/** How many of a site's newest linked X replies are read to find its handle. */
export const HANDLE_SAMPLE_ROWS = 200;

/**
 * The author of an X status link, lowercased (X handles are not case
 * sensitive), or null: not X, not a status, or the anonymous
 * `/i/web/status/<id>` form that names nobody.
 */
export function handleOfStatusUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!X_HOSTS.has(domainOf(url.toString()))) return null;
  const [first, second, third] = url.pathname.split("/").filter(Boolean);
  if (!first || second !== "status" || !/^\d+$/.test(third ?? "")) return null;
  const handle = first.toLowerCase();
  return HANDLE.test(handle) && !NOT_A_HANDLE.has(handle) ? handle : null;
}

/**
 * The handle most of these links carry; on a tie, the one seen first
 * (callers pass the newest link first). Null when no link names a handle.
 */
export function mostFrequentHandle(urls: ReadonlyArray<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const handle = handleOfStatusUrl(url);
    if (handle) counts.set(handle, (counts.get(handle) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  // Map keeps insertion order, so the first handle met wins a tie.
  for (const [handle, count] of counts) {
    if (count > bestCount) {
      best = handle;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The X handle a site posts its replies from, lowercased, or null when it
 * has no posted X reply with a link yet. Through the caller's client: RLS
 * (or the service role, in a job) is the access control.
 */
export async function ownXHandle(supabase: SupabaseClient, businessId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("placement_targets")
    .select("published_url, published_at")
    .eq("business_id", businessId)
    .eq("surface", "x")
    .eq("status", "published_manually")
    .not("published_url", "is", null)
    .order("published_at", { ascending: false })
    .limit(HANDLE_SAMPLE_ROWS);
  if (error || !data) return null;
  return mostFrequentHandle((data as Array<{ published_url: string | null }>).map((row) => row.published_url));
}
