import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { findPlacesFromRun } from "@/lib/visibility/places";

/**
 * "Find places from the last run", by hand.
 *
 * The sources the site's latest finished visibility run recorded become
 * candidates in the Replies inbox, the same function the run's own last step
 * calls when the setting is on (the default) and the
 * `find_places_from_last_run` tool calls (lib/visibility/places.ts). The
 * Prompts page has no button for it since the run does it by itself; the
 * route stays for a signed-in session, as the tool does for a key over
 * REST and MCP. Free: stored probes are read, no engine
 * and no model is asked, so there is no paywall and no spend limit here.
 * The site is picked from the person's own; the service role only inserts
 * the rows users have no policy for.
 */
export const maxDuration = 60;

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  try {
    const result = await findPlacesFromRun({
      supabase,
      admin: createAdminClient(),
      userId: user.id,
      businessId,
      // Leave headroom under maxDuration: lookups not started by then are counted as unread.
      deadline: Date.now() + 40_000,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[visibility.places]", err);
    return NextResponse.json({ error: "Could not read the last run's sources. Try again." }, { status: 500 });
  }
}
