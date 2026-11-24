import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDiscoveryProviders } from "@/lib/providers/discovery/registry";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadInbox } from "@/lib/placements/read";
import { ARCHIVE_STATUS } from "@/lib/placements/inbox-view";
import { isTargetStatus } from "@/lib/placements/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { isXApiEnabled } from "@/lib/providers/x/api";
import { readXApiStatus, xSearchNotice } from "@/lib/placements/x-budget";
import { withXSearchOff } from "@/lib/placements/discovery-progress";
import { ownerPaysFor, replyLinkFinderOn } from "@/lib/placements/reply-link-search";
import { loadXPostingAccount, xPostingAvailable } from "@/lib/integrations/x-posting";

/**
 * The Placements inbox, for the selected site, through the user's own session.
 * Filters are query parameters; `business_id` never is.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) return NextResponse.json({ hasBusiness: false });

    const params = request.nextUrl.searchParams;
    const status = params.get("status") ?? "open";
    const inbox = await loadInbox(supabase, businessId, {
      // "archive": skipped, filtered out, expired and removed (Today's Archive tab).
      status: status === "open" || status === "all" || status === ARCHIVE_STATUS || isTargetStatus(status) ? status : "open",
      surface: params.get("surface") || null,
      topic: params.get("topic") || null,
      // "ai_visibility": only rows a sampled AI answer cited.
      source: params.get("source") || null,
      // Cards the person just acted on, kept on screen whatever the filter.
      include: (params.get("include") ?? "").split(",").filter(Boolean),
      // The browser's time zone, for "posted today"; UTC when absent.
      timeZone: params.get("tz"),
    });

    // The platform's X ledger is the service role's to read; only whether
    // the cap stopped this site's search reaches the page, and whether GTF
    // looks for the links of its replies on X.
    const xStatus = isXApiEnabled() ? await readXApiStatus(createAdminClient()) : null;
    const xSearch = xStatus ? xSearchNotice(xStatus) : null;
    const findsReplyLinks = replyLinkFinderOn(xStatus, {
      handleKnown: Boolean(inbox.xHandleKnown),
      ownerPays: xStatus && inbox.xHandleKnown ? await ownerPaysFor(supabase, user.id) : false,
    });

    // The account GTF posts from, when there is one that works: Post on X on the drafts X allows.
    const xAccount = xPostingAvailable() ? await loadXPostingAccount(supabase, user.id, businessId) : null;
    const xPosting = xAccount && xAccount.status === "connected" ? { username: xAccount.username } : null;

    return NextResponse.json({
      hasBusiness: true,
      xPosting,
      ...inbox,
      // The daily X search runs only where the platform has the X API on.
      discovery: withXSearchOff(inbox.discovery, isXApiEnabled()),
      xSearch,
      findsReplyLinks,
      // "Your X account" on a posted reply on X, while GTF does not know it.
      askXHandle: isXApiEnabled() && !inbox.xHandleKnown,
      providers: getDiscoveryProviders().map((p) => p.name),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
