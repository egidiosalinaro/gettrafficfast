import type { SupabaseClient } from "@supabase/supabase-js";
import { domainOf } from "@/lib/providers/serp/types";
import { isXApiEnabled } from "@/lib/providers/x/api";
import { parseVoiceSettings } from "@/lib/voice/settings";

/**
 * The X account a site's replies are posted from.
 *
 * Two jobs need it: finding the link of a reply the person marked as posted
 * (search the thread for a reply from this account) and reading the
 * account's followers once a day. Where it comes from, in order:
 *
 *   1. the handle the person gave for the site (`voice_settings.xHandle`,
 *      since 2026-11-24: Today asks for it the first time a reply on X is
 *      marked as posted while it is unknown; Settings → Connections;
 *      `update_voice_settings`);
 *   2. else the one the site's own saved reply links carry most often: a
 *      posted X row stores `published_url`, and an X status link names its
 *      author, `x.com/<handle>/status/<id>`.
 *
 * Nothing is guessed: a site with neither has none (null), both jobs skip
 * it, and the screens ask. It is read per site, never borrowed from another
 * site of the same person, because two sites can be marketed from two
 * accounts.
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
 * The handle the site's own saved reply links name, lowercased, or null when
 * it has no posted X reply with a link yet. Through the caller's client: RLS
 * (or the service role, in a job) is the access control.
 */
export async function inferredXHandle(supabase: SupabaseClient, businessId: string): Promise<string | null> {
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

/** The handle the person saved for the site, from its stored voice settings, or null. */
export function savedXHandle(voiceSettings: unknown): string | null {
  return parseVoiceSettings(voiceSettings).xHandle;
}

/** Where a site's handle came from: the person gave it, or their saved reply links name it. */
export type XHandleSource = "saved" | "links";

/**
 * The X handle a site posts its replies from, with where it came from: the
 * saved one first, else the one its saved reply links name; both null when
 * neither is known.
 */
export async function resolveXHandle(
  supabase: SupabaseClient,
  businessId: string
): Promise<{ handle: string | null; source: XHandleSource | null }> {
  const { data } = await supabase.from("businesses").select("voice_settings").eq("id", businessId).maybeSingle();
  const saved = savedXHandle((data as { voice_settings?: unknown } | null)?.voice_settings);
  if (saved) return { handle: saved, source: "saved" };
  const inferred = await inferredXHandle(supabase, businessId);
  return inferred ? { handle: inferred, source: "links" } : { handle: null, source: null };
}

/** The X handle a site posts its replies from, lowercased, or null when it is not known (`resolveXHandle`). */
export async function ownXHandle(supabase: SupabaseClient, businessId: string): Promise<string | null> {
  return (await resolveXHandle(supabase, businessId)).handle;
}

/** What GTF says when it needs the site's X account: one sentence, for the screens and the tools. */
export const X_HANDLE_NEEDED =
  "GTF does not know this site's X account yet. Ask the person for their X username and save it with update_voice_settings (xHandle); GTF then finds the links of their replies on X by itself.";

/**
 * Whether GTF asks for the site's X account after this reply was marked as
 * posted: a reply on X with no link, while the platform reads X and the
 * handle is not known (neither saved nor named by a saved link). What
 * `mark_reply_posted` answers as `xHandleNeeded`; the Today screen asks the
 * same from the inbox payload (`askXHandle`).
 */
export async function xHandleNeededFor(
  supabase: SupabaseClient,
  businessId: string,
  target: { surface: string; status: string; publishedUrl: string | null }
): Promise<boolean> {
  if (!isXApiEnabled()) return false;
  if (target.surface !== "x" || target.status !== "published_manually" || (target.publishedUrl ?? "").trim()) return false;
  return (await ownXHandle(supabase, businessId)) === null;
}
