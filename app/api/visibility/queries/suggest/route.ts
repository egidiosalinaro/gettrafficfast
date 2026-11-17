import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { suggestPrompts } from "@/lib/visibility/manage";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";
import { recordScreenAction } from "@/lib/limits/actions";

/**
 * Propose founder-style prompts. Does not write them.
 *
 * The owner still has to pick which ones enter the set. A query they did not
 * see is a probe they cannot interpret. One model call, bounded, recorded:
 * the function the suggest_prompts tool calls (lib/visibility/manage.ts).
 */

export const maxDuration = 30;

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePaidAccess(user);
  if (denied) return denied;

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  // The account's daily AI spend limit and its daily cap on suggestions,
  // counted with the API's (lib/limits/guard.ts).
  const limited = await requireAccountCapacity(createAdminClient, user.id, "suggest_prompts");
  if (limited) return limited;
  const startedAt = new Date();

  try {
    // Every model account refusing to pay comes back as a 503 in words,
    // already recorded (pause, one alert), never the provider's error.
    const result = await suggestPrompts({
      supabase,
      admin: createAdminClient,
      userId: user.id,
      businessId,
      source: "api.visibility.queries.suggest",
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    recordScreenAction(createAdminClient, {
      userId: user.id,
      businessId,
      tool: "suggest_prompts",
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
    });
    return NextResponse.json({ prompts: result.prompts, discarded: result.discarded });
  } catch (error) {
    console.error("visibility.suggest:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not suggest prompts" },
      { status: 500 }
    );
  }
}
