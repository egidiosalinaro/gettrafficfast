import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";
import { recordScreenAction } from "@/lib/limits/actions";
import { suggestKeywords } from "@/lib/keywords/manage";
import { selectedBusinessId } from "@/lib/tenancy";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = await requirePaidAccess(user);
    if (denied) return denied;
    // The account's daily AI spend limit and its daily cap on suggestions,
    // counted with the API's (lib/limits/guard.ts).
    const limited = await requireAccountCapacity(createAdminClient, user.id, "suggest_keywords");
    if (limited) return limited;
    const startedAt = new Date();

    const body = await request.json();
    const { keywords, generateFromBusiness } = body;

    // Business context comes from the SELECTED site: suggesting Postwren's
    // keywords while looking at gettrafficfa.st is the exact failure this
    // whole migration exists to prevent.
    const businessId = await selectedBusinessId(supabase, user.id);

    // The same function the suggest_keywords tool calls (lib/keywords/manage.ts).
    // Every model account refusing to pay comes back as a 503 in words,
    // already recorded (pause, one alert), never the provider's error.
    const result = await suggestKeywords({
      supabase,
      admin: createAdminClient,
      userId: user.id,
      businessId,
      seeds: keywords,
      fromBusiness: Boolean(generateFromBusiness),
      source: "api.keywords.suggest",
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    recordScreenAction(createAdminClient, {
      userId: user.id,
      businessId,
      tool: "suggest_keywords",
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
    });
    // Ideas that overlap a topic the site already has are left out of
    // `suggestions` and listed in `duplicates`, each with what it overlaps;
    // a comparison naming a product the site's data never named is left out
    // and listed in `refused` (lib/keywords/named-tools.ts).
    return NextResponse.json({
      suggestions: result.suggestions,
      ...(result.duplicates.length > 0 ? { duplicates: result.duplicates } : {}),
      ...(result.refused.length > 0 ? { refused: result.refused } : {}),
    });
  } catch (error) {
    console.error("Error in suggest endpoint:", error);

    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message || "Failed to generate keywords" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
