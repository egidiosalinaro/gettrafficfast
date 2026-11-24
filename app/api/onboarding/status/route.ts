import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectedBusinessId } from "@/lib/tenancy";
import { EMPTY_ONBOARDING_STATUS, type OptionalOnboardingStatus } from "@/lib/onboarding";
import { hasClaudeConnected, loadOnboardingStatus } from "@/lib/onboarding-status";
import { isXPostingConfigured } from "@/lib/providers/x/oauth";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let hasClaude = false;
  try {
    hasClaude = await hasClaudeConnected(createAdminClient(), user.id);
  } catch {
    // Optional step: an unreadable answer shows the suggestion, never an error.
  }
  const optional: OptionalOnboardingStatus = { hasClaude };

  // The checklist describes the SELECTED site. An account with a finished
  // site and a brand new one has to see the new one's checklist, or the
  // onboarding says "done" over an empty calendar.
  const businessId = await selectedBusinessId(supabase, user.id);

  if (!businessId) {
    return NextResponse.json({ ...EMPTY_ONBOARDING_STATUS, ...(isXPostingConfigured() ? { xPostingOffered: true } : {}), ...optional });
  }

  // The same counts as the Overview and `get_onboarding_status` (lib/onboarding-status.ts).
  return NextResponse.json({ ...(await loadOnboardingStatus(supabase, businessId)), ...optional });
}
